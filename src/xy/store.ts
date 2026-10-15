import { GLRenderer } from '../render/GLRenderer'

/**
 * Chunked point storage shared by XY series.
 *
 * - Each chunk stores coordinates relative to its own origin (first point) as
 *   float32, so large absolute values (epoch-ms timestamps) keep precision on GPU.
 * - Chunks after the first begin with a copy of the previous chunk's last point
 *   ("bridge") so that line strips stay continuous across chunk boundaries.
 * - Per-block (BLOCK points) bounds give cheap range min/max for fitting,
 *   culling and nearest-point search.
 */

export const BLOCK = 1024
const MAX_CHUNK = 32768
const MIN_CHUNK = 256

export type Channel = 'color' | 'value' | 'size' | 'lo' | 'rot'

export interface Bounds { xmin: number; xmax: number; ymin: number; ymax: number }
export const emptyBounds = (): Bounds => ({ xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity })

interface GPUBuf { buf: WebGLBuffer; cap: number }

/**
 * Min/max decimation level of a chunk: each complete bucket of B points emits
 * its minimum and maximum (in index order), so dense progressive lines can be
 * drawn with ~4 vertices per pixel column instead of every sample.
 */
export interface Lod {
  B: number
  nb: number
  xy: Float32Array
  gpu: GPUBuf | null
  uploaded: number
}
/** Smallest LOD bucket is 8 points (level 0). */
export const LOD_MIN = 8
/** Samples drawn from the per-frame tail buffer before they are committed. */
const TAIL_MAX = 2048
/** LOD buckets accumulated before the LOD buffer is re-specified. */
const LOD_COMMIT = 16

export type GpuBufs = Partial<Record<'xy' | Channel, { buf: WebGLBuffer }>>
/** A drawable slice of a chunk: vertex `start` (in that buffer set) and `count`. */
export interface GpuPart { gpu: GpuBufs; start: number; count: number; at: number }

export class Chunk {
  cap: number
  n = 0
  bridged: boolean
  ox = 0
  oy = 0
  xy: Float32Array
  color?: Uint32Array
  value?: Float32Array
  size?: Float32Array
  lo?: Float32Array
  rot?: Float32Array
  /** Per block: xmin, xmax, ymin, ymax (absolute). Bridge point excluded. */
  blocks: Float64Array
  /** GPU state */
  gpu: Partial<Record<'xy' | Channel, GPUBuf>> = {}
  uploaded = 0
  dirtyFrom = Infinity
  lods: (Lod | undefined)[] = []
  /** Tail (uncommitted samples) buffers: storage index tailBase.. tailN. */
  tailGpu: Partial<Record<'xy' | Channel, WebGLBuffer>> = {}
  tailBase = 0
  tailN = 0
  private tailView: GpuBufs = {}
  tailBufs(): GpuBufs {
    for (const k of Object.keys(this.tailGpu) as ('xy' | Channel)[]) {
      const b = this.tailGpu[k]!
      if (this.tailView[k]?.buf !== b) this.tailView[k] = { buf: b }
    }
    return this.tailView
  }
  constructor(cap: number, bridged: boolean, channels: Set<Channel>) {
    this.cap = cap
    this.bridged = bridged
    this.xy = new Float32Array(cap * 2)
    for (const c of channels) this.alloc(c)
    this.blocks = new Float64Array(Math.ceil(cap / BLOCK) * 4).fill(NaN)
  }
  alloc(c: Channel) {
    if (this[c]) return
    const arr = c === 'color' ? new Uint32Array(this.cap) : new Float32Array(this.cap)
    if (c === 'color') arr.fill(0xffffffff)
    ;(this as any)[c] = arr
    this.dirtyFrom = 0
  }
  grow(newCap: number) {
    const g = <T extends Float32Array | Uint32Array>(a: T | undefined, k = 1): T | undefined => {
      if (!a) return a
      const b = new (a.constructor as any)(newCap * k) as T
      b.set(a)
      return b
    }
    this.xy = g(this.xy, 2)!
    this.color = g(this.color)
    if (this.color) this.color.fill(0xffffffff, this.cap)
    this.value = g(this.value)
    this.size = g(this.size)
    this.lo = g(this.lo)
    this.rot = g(this.rot)
    const nb = new Float64Array(Math.ceil(newCap / BLOCK) * 4).fill(NaN)
    nb.set(this.blocks)
    this.blocks = nb
    this.cap = newCap
  }
  /** First storage index that is a real point (skips bridge). */
  get own0(): number { return this.bridged ? 1 : 0 }
  /** Min/max level L (bucket = LOD_MIN << L), extended over newly completed buckets. */
  lod(L: number): Lod {
    const B = LOD_MIN << L
    const need = Math.ceil(this.cap / B) * 4
    let d = this.lods[L]
    if (!d) this.lods[L] = d = { B, nb: 0, xy: new Float32Array(need), gpu: null, uploaded: 0 }
    else if (d.xy.length < need) {
      const g = new Float32Array(need)
      g.set(d.xy)
      d.xy = g
    }
    const out = d.xy
    if (L > 0) {
      // Derive from the finer level: each bucket merges two finer buckets (4 candidate points).
      const src = this.lod(L - 1)
      const total = Math.floor(src.nb / 2)
      const sx = src.xy
      for (let b = d.nb; b < total; b++) {
        const i = b * 8
        let iMin = -1, iMax = -1, yMin = Infinity, yMax = -Infinity
        for (let k = 0; k < 4; k++) {
          const y = sx[i + k * 2 + 1]
          if (y < yMin) { yMin = y; iMin = k }
          if (y > yMax) { yMax = y; iMax = k }
        }
        const o = b * 4
        if (iMin < 0) {
          out[o] = sx[i]; out[o + 1] = NaN; out[o + 2] = sx[i + 6]; out[o + 3] = NaN
        } else {
          let a = Math.min(iMin, iMax), c = Math.max(iMin, iMax)
          const yk = (k: number) => sx[i + k * 2 + 1]
          const far = (ref: number, ks: number[]) => ks.reduce((best, k) => (Math.abs(yk(k) - ref) > Math.abs(yk(best) - ref) ? k : best), ks[0])
          // Keep chunk joins exact: first bucket starts at the bridge, last bucket of a full chunk ends at its last sample.
          if (b === 0 && this.bridged) { a = 0; c = far(yk(0), [1, 2, 3]) }
          if (this.n === this.cap && (b + 1) * B === this.n) { c = 3; if (!(b === 0 && this.bridged)) a = far(yk(3), [0, 1, 2]) }
          out[o] = sx[i + a * 2]; out[o + 1] = sx[i + a * 2 + 1]; out[o + 2] = sx[i + c * 2]; out[o + 3] = sx[i + c * 2 + 1]
        }
      }
      d.nb = total
      return d
    }
    const total = Math.floor(this.n / B)
    const xy = this.xy
    for (let b = d.nb; b < total; b++) {
      let iMin = -1, iMax = -1, yMin = Infinity, yMax = -Infinity
      const j0 = b * B, j1 = j0 + B
      for (let j = j0; j < j1; j++) {
        const y = xy[j * 2 + 1]
        if (y < yMin) { yMin = y; iMin = j }
        if (y > yMax) { yMax = y; iMax = j }
      }
      const o = b * 4
      if (iMin < 0) {
        out[o] = xy[j0 * 2]; out[o + 1] = NaN; out[o + 2] = xy[(j1 - 1) * 2]; out[o + 3] = NaN
      } else {
        let a = Math.min(iMin, iMax), c = Math.max(iMin, iMax)
        const farFrom = (j: number) => (Math.abs(yMax - xy[j * 2 + 1]) > Math.abs(yMin - xy[j * 2 + 1]) ? iMax : iMin)
        if (b === 0 && this.bridged) { a = j0; c = Math.max(j0, farFrom(j0)) }
        if (this.n === this.cap && j1 === this.n) { c = j1 - 1; if (!(b === 0 && this.bridged)) a = Math.min(j1 - 1, farFrom(j1 - 1)) }
        out[o] = xy[a * 2]; out[o + 1] = xy[a * 2 + 1]; out[o + 2] = xy[c * 2]; out[o + 3] = xy[c * 2 + 1]
      }
    }
    d.nb = total
    return d
  }
  x(i: number): number { return this.xy[i * 2] + this.ox }
  y(i: number): number { return this.xy[i * 2 + 1] + this.oy }
}

export class XYStore {
  chunks: Chunk[] = []
  /** Points trimmed from the start of chunks[0] (storage indices beyond own0). */
  trim = 0
  count = 0
  maxCount = Infinity
  monoX = true
  private lastX = -Infinity
  channels = new Set<Channel>()
  private boundsCache: Bounds | null = null
  /** Increments on any mutation (for consumers that cache derived data). */
  version = 0
  /** Chunks released since the last GPU sync; buffers are deleted then. */
  private released: Chunk[] = []
  private deadBuffers: WebGLBuffer[] = []

  enableChannel(c: Channel) {
    if (this.channels.has(c)) return
    this.channels.add(c)
    for (const ch of this.chunks) ch.alloc(c)
  }

  private newChunk(): Chunk {
    const prev = this.chunks[this.chunks.length - 1]
    const cap = prev ? MAX_CHUNK : MIN_CHUNK
    const ch = new Chunk(cap, !!prev, this.channels)
    if (prev) {
      // Bridge: copy previous last point.
      const i = prev.n - 1
      ch.ox = prev.x(i)
      ch.oy = prev.y(i)
      ch.xy[0] = 0
      ch.xy[1] = 0
      for (const c of this.channels) (ch as any)[c][0] = (prev as any)[c][i]
      if (ch.lo) ch.lo[0] = prev.lo![i] + prev.oy - ch.oy
      ch.n = 1
    }
    this.chunks.push(ch)
    return ch
  }

  /**
   * Append n points. Accessors are called for i in [0, n).
   * Extra channels are optional per call; missing ones get defaults.
   */
  append(
    n: number,
    getX: (i: number) => number,
    getY: (i: number) => number,
    extra?: Partial<Record<Channel, (i: number) => number>>,
  ) {
    if (n <= 0) return
    if (extra) for (const k of Object.keys(extra) as Channel[]) if (extra[k]) this.enableChannel(k)
    let ch = this.chunks[this.chunks.length - 1]
    for (let i = 0; i < n; i++) {
      const x = +getX(i)
      const y = +getY(i)
      if (!ch || ch.n >= ch.cap) {
        if (ch && ch.cap < MAX_CHUNK && this.chunks.length === 1) ch.grow(Math.min(MAX_CHUNK, ch.cap * 2))
        else ch = this.newChunk()
      }
      const j = ch.n
      if (j === 0 && !ch.bridged) {
        ch.ox = Number.isFinite(x) ? x : 0
        ch.oy = Number.isFinite(y) ? y : 0
      }
      ch.xy[j * 2] = x - ch.ox
      ch.xy[j * 2 + 1] = y - ch.oy
      if (extra) {
        if (ch.color) ch.color[j] = extra.color ? extra.color(i) >>> 0 : 0xffffffff
        if (ch.value) ch.value[j] = extra.value ? extra.value(i) : 0
        if (ch.size) ch.size[j] = extra.size ? extra.size(i) : 0
        if (ch.lo) ch.lo[j] = extra.lo ? extra.lo(i) - ch.oy : 0
        if (ch.rot) ch.rot[j] = extra.rot ? extra.rot(i) : 0
      } else {
        if (ch.color) ch.color[j] = 0xffffffff
        if (ch.value) ch.value[j] = 0
        if (ch.size) ch.size[j] = 0
        if (ch.lo) ch.lo[j] = 0
        if (ch.rot) ch.rot[j] = 0
      }
      ch.n = j + 1
      // block bounds
      if (j >= ch.own0 && Number.isFinite(x) && Number.isFinite(y)) {
        const b = Math.floor(j / BLOCK) * 4
        const bl = ch.blocks
        if (!(bl[b] <= bl[b + 1])) {
          bl[b] = bl[b + 1] = x
          bl[b + 2] = bl[b + 3] = y
        } else {
          if (x < bl[b]) bl[b] = x
          if (x > bl[b + 1]) bl[b + 1] = x
          if (y < bl[b + 2]) bl[b + 2] = y
          if (y > bl[b + 3]) bl[b + 3] = y
        }
        if (ch.lo) {
          const l = ch.lo[j] + ch.oy
          if (l < bl[b + 2]) bl[b + 2] = l
          if (l > bl[b + 3]) bl[b + 3] = l
        }
      }
      if (x < this.lastX) this.monoX = false
      if (Number.isFinite(x)) this.lastX = x
      this.count++
    }
    this.enforceMax()
    this.boundsCache = null
    this.version++
  }

  /** Remove the last k points (used by spline/step geometry rebuilds). */
  truncate(k: number) {
    while (k > 0 && this.chunks.length) {
      const ch = this.chunks[this.chunks.length - 1]
      const own = ch.n - ch.own0 - (this.chunks.length === 1 ? this.trim : 0)
      const r = Math.min(k, own)
      ch.n -= r
      k -= r
      this.count -= r
      if (ch.uploaded > ch.n) ch.uploaded = ch.n
      for (const d of ch.lods) if (d?.gpu) this.deadBuffers.push(d.gpu.buf)
      ch.lods = []
      this.rebuildBlocks(ch)
      if (ch.n <= ch.own0 + (this.chunks.length === 1 ? this.trim : 0)) {
        this.released.push(this.chunks.pop()!)
        if (!this.chunks.length) this.trim = 0
      }
    }
    const last = this.chunks[this.chunks.length - 1]
    this.lastX = last && last.n ? last.x(last.n - 1) : -Infinity
    this.boundsCache = null
    this.version++
  }

  private rebuildBlocks(ch: Chunk) {
    ch.blocks.fill(NaN)
    const bl = ch.blocks
    for (let j = ch.own0; j < ch.n; j++) {
      const x = ch.x(j), y = ch.y(j)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      const b = Math.floor(j / BLOCK) * 4
      if (!(bl[b] <= bl[b + 1])) {
        bl[b] = bl[b + 1] = x
        bl[b + 2] = bl[b + 3] = y
      } else {
        if (x < bl[b]) bl[b] = x
        if (x > bl[b + 1]) bl[b + 1] = x
        if (y < bl[b + 2]) bl[b + 2] = y
        if (y > bl[b + 3]) bl[b + 3] = y
      }
      if (ch.lo) {
        const l = ch.lo[j] + ch.oy
        if (l < bl[b + 2]) bl[b + 2] = l
        if (l > bl[b + 3]) bl[b + 3] = l
      }
    }
  }

  private enforceMax() {
    while (this.count > this.maxCount && this.chunks.length) {
      const ch = this.chunks[0]
      const avail = ch.n - ch.own0 - this.trim
      const drop = Math.min(avail, this.count - this.maxCount)
      this.trim += drop
      this.count -= drop
      if (this.trim >= ch.n - ch.own0) {
        if (this.chunks.length === 1) {
          // keep a single empty chunk alive; reset it
          ch.n = 0
          ch.bridged = false
          ch.uploaded = 0
          ch.blocks.fill(NaN)
          this.trim = 0
          break
        }
        this.released.push(this.chunks.shift()!)
        this.trim = 0
        // the next chunk's bridge now refers to a dropped point: skip it
        const next = this.chunks[0]
        if (next.bridged) {
          // Treat bridge as trimmed-away: it is storage index 0, own0 = 1 already excludes it.
        }
      }
    }
  }

  /** Remove the k oldest points. */
  dropFront(k: number) {
    if (k <= 0) return
    const prev = this.maxCount
    this.maxCount = Math.max(0, this.count - k)
    this.enforceMax()
    this.maxCount = prev
    this.boundsCache = null
    this.version++
  }

  setMaxCount(n: number) {
    this.maxCount = n > 0 ? n : Infinity
    this.enforceMax()
    this.boundsCache = null
    this.version++
  }

  clear() {
    this.released.push(...this.chunks)
    this.chunks = []
    this.trim = 0
    this.count = 0
    this.monoX = true
    this.lastX = -Infinity
    this.boundsCache = null
    this.version++
  }

  /** First storage index to draw as a line strip in chunk c. */
  lineStart(ci: number): number {
    if (ci === 0) return this.chunks[0].own0 + this.trim
    return 0
  }
  /** First storage index to draw as points in chunk c. */
  pointStart(ci: number): number {
    return this.chunks[ci].own0 + (ci === 0 ? this.trim : 0)
  }

  /** Aggregate bounds of all stored points. */
  bounds(): Bounds {
    if (this.boundsCache) return this.boundsCache
    const b = emptyBounds()
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci]
      const s = this.pointStart(ci)
      this.rangeBounds(ch, s, ch.n, b)
    }
    this.boundsCache = b
    return b
  }

  /** Bounds of storage range [s, e) in chunk, merged into `out`, using block cache. */
  rangeBounds(ch: Chunk, s: number, e: number, out: Bounds) {
    const bl = ch.blocks
    let j = s
    while (j < e) {
      const bi = Math.floor(j / BLOCK)
      const bEnd = Math.min(e, (bi + 1) * BLOCK)
      if (j <= Math.max(bi * BLOCK, ch.own0) && bEnd >= Math.min((bi + 1) * BLOCK, ch.n)) {
        const k = bi * 4
        if (bl[k] <= bl[k + 1]) {
          if (bl[k] < out.xmin) out.xmin = bl[k]
          if (bl[k + 1] > out.xmax) out.xmax = bl[k + 1]
          if (bl[k + 2] < out.ymin) out.ymin = bl[k + 2]
          if (bl[k + 3] > out.ymax) out.ymax = bl[k + 3]
        }
      } else {
        for (let t = j; t < bEnd; t++) {
          const x = ch.x(t), y = ch.y(t)
          if (!Number.isFinite(x) || !Number.isFinite(y)) continue
          if (x < out.xmin) out.xmin = x
          if (x > out.xmax) out.xmax = x
          if (y < out.ymin) out.ymin = y
          if (y > out.ymax) out.ymax = y
          if (ch.lo) {
            const l = ch.lo[t] + ch.oy
            if (l < out.ymin) out.ymin = l
            if (l > out.ymax) out.ymax = l
          }
        }
      }
      j = bEnd
    }
  }

  /** Y bounds of points with x in [x0, x1] (fast for monotonic X). */
  yBoundsInX(x0: number, x1: number): Bounds {
    const b = emptyBounds()
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci]
      const s = this.pointStart(ci)
      if (ch.n <= s) continue
      if (this.monoX) {
        if (ch.x(ch.n - 1) < x0 || ch.x(s) > x1) continue
        const a = this.lower(ch, s, ch.n, x0)
        const e = this.upper(ch, a, ch.n, x1)
        this.rangeBounds(ch, a, e, b)
      } else {
        for (let j = s; j < ch.n; j++) {
          const x = ch.x(j)
          if (x < x0 || x > x1) continue
          const y = ch.y(j)
          if (!Number.isFinite(y)) continue
          if (x < b.xmin) b.xmin = x
          if (x > b.xmax) b.xmax = x
          if (y < b.ymin) b.ymin = y
          if (y > b.ymax) b.ymax = y
        }
      }
    }
    return b
  }

  /** First storage index in [lo, hi) with x >= v (monotonic X only). */
  lower(ch: Chunk, lo: number, hi: number, v: number): number {
    const rel = v - ch.ox
    const xy = ch.xy
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (xy[m * 2] < rel) lo = m + 1
      else hi = m
    }
    return lo
  }

  /** First storage index in [lo, hi) with x > v (monotonic X only). */
  upper(ch: Chunk, lo: number, hi: number, v: number): number {
    const rel = v - ch.ox
    const xy = ch.xy
    while (lo < hi) {
      const m = (lo + hi) >>> 1
      if (xy[m * 2] <= rel) lo = m + 1
      else hi = m
    }
    return lo
  }

  /** Iterate chunks whose X range may intersect [x0, x1]. Yields storage ranges for lines. */
  forVisible(x0: number, x1: number, cb: (ch: Chunk, ci: number) => void) {
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci]
      if (ch.n === 0) continue
      if (this.monoX && x0 <= x1) {
        const s = this.lineStart(ci)
        if (s >= ch.n) continue
        // Segments crossing a chunk boundary live in the later chunk (bridge point),
        // so a chunk entirely outside [x0, x1] contributes nothing.
        if (ch.x(ch.n - 1) < x0 || ch.x(s) > x1) continue
      }
      cb(ch, ci)
    }
  }

  /** Visible storage sub-range of a chunk for monotonic data: [s, e) inclusive of one neighbour each side. */
  visibleRange(ch: Chunk, ci: number, x0: number, x1: number, forPoints: boolean): [number, number] {
    const s0 = forPoints ? this.pointStart(ci) : this.lineStart(ci)
    if (!this.monoX || !(x0 <= x1)) return [s0, ch.n]
    let s = this.lower(ch, s0, ch.n, x0)
    let e = this.upper(ch, s, ch.n, x1)
    s = Math.max(s0, s - 1)
    e = Math.min(ch.n, e + 1)
    return [s, e]
  }

  /** Logical point count. */
  size(): number { return this.count }

  /** Last point (absolute), or undefined. */
  last(): { x: number; y: number } | undefined {
    for (let ci = this.chunks.length - 1; ci >= 0; ci--) {
      const ch = this.chunks[ci]
      if (ch.n > this.pointStart(ci)) return { x: ch.x(ch.n - 1), y: ch.y(ch.n - 1) }
    }
    return undefined
  }

  /** Iterate all real points (absolute coords). */
  forEach(cb: (x: number, y: number, ch: Chunk, j: number) => void) {
    for (let ci = 0; ci < this.chunks.length; ci++) {
      const ch = this.chunks[ci]
      for (let j = this.pointStart(ci); j < ch.n; j++) cb(ch.x(j), ch.y(j), ch, j)
    }
  }

  // ---------------------------------------------------------------- GPU
  //
  // Partial bufferSubData into a buffer the GPU is still reading (previous frame)
  // stalls ANGLE/D3D11 badly. So buffers are only ever (re)specified whole with
  // bufferData (orphaning): the chunk buffer is committed rarely, and samples
  // appended since the last commit are drawn from a small per-chunk tail buffer
  // that is re-specified each frame.

  private gc(r: GLRenderer) {
    const gl = r.gl
    for (const c of this.released) this.free(r, c)
    this.released.length = 0
    for (const b of this.deadBuffers) gl.deleteBuffer(b)
    this.deadBuffers.length = 0
  }

  /** Make chunk data drawable: commit to the main buffers or refresh the tail buffers. */
  sync(r: GLRenderer, ch: Chunk) {
    this.gc(r)
    const gl = r.gl
    const last = ch === this.chunks[this.chunks.length - 1]
    const pending = ch.n - ch.uploaded
    const commit = !ch.gpu.xy || ch.dirtyFrom < ch.n || (pending > 0 && (!last || pending > TAIL_MAX || ch.n === ch.cap))
    const chans: ['xy' | Channel, Float32Array | Uint32Array | undefined, number][] = [
      ['xy', ch.xy, 2], ['color', ch.color, 1], ['value', ch.value, 1], ['size', ch.size, 1], ['lo', ch.lo, 1], ['rot', ch.rot, 1],
    ]
    if (commit) {
      for (const [key, arr, comps] of chans) {
        if (!arr) continue
        let g = ch.gpu[key]
        if (!g) ch.gpu[key] = g = { buf: gl.createBuffer()!, cap: 0 }
        gl.bindBuffer(gl.ARRAY_BUFFER, g.buf)
        gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(0, ch.n * comps), gl.DYNAMIC_DRAW)
        g.cap = ch.n
      }
      ch.uploaded = ch.n
      ch.dirtyFrom = Infinity
      ch.tailN = 0
      return
    }
    if (pending > 0 && ch.tailN !== ch.n) {
      const base = Math.max(0, ch.uploaded - 1)
      for (const [key, arr, comps] of chans) {
        if (!arr) continue
        let b = ch.tailGpu[key]
        if (!b) ch.tailGpu[key] = b = gl.createBuffer()!
        gl.bindBuffer(gl.ARRAY_BUFFER, b)
        gl.bufferData(gl.ARRAY_BUFFER, arr.subarray(base * comps, ch.n * comps), gl.STREAM_DRAW)
      }
      ch.tailBase = base
      ch.tailN = ch.n
    }
  }

  /** Make every chunk drawable (called once per frame before any draw). */
  syncAll(r: GLRenderer) {
    for (const ch of this.chunks) if (ch.uploaded < ch.n || ch.dirtyFrom < ch.n || !ch.gpu.xy) this.sync(r, ch)
  }

  /**
   * Split storage range [s, e) of a synced chunk into GPU-resident parts.
   * strip: consecutive parts overlap by one vertex so connected lines stay joined.
   */
  parts(ch: Chunk, s: number, e: number, strip: boolean): GpuPart[] {
    const out: GpuPart[] = []
    const c = ch.uploaded
    const mEnd = Math.min(e, c)
    if (mEnd - s >= (strip ? 2 : 1)) out.push({ gpu: ch.gpu as GpuBufs, start: s, count: mEnd - s, at: s })
    if (e > c && ch.tailN === ch.n) {
      const t0 = strip ? Math.max(s, c - 1, ch.tailBase) : Math.max(s, c)
      if (e - t0 >= (strip ? 2 : 1)) out.push({ gpu: ch.tailBufs(), start: t0 - ch.tailBase, count: e - t0, at: t0 })
    }
    return out
  }

  /** Upload LOD buckets: whole-buffer respecification, at most every LOD_COMMIT buckets. */
  syncLod(r: GLRenderer, d: Lod) {
    const gl = r.gl
    if (d.gpu && d.nb - d.uploaded < LOD_COMMIT) return
    if (d.uploaded === d.nb && d.gpu) return
    if (!d.gpu) d.gpu = { buf: gl.createBuffer()!, cap: 0 }
    gl.bindBuffer(gl.ARRAY_BUFFER, d.gpu.buf)
    gl.bufferData(gl.ARRAY_BUFFER, d.xy.subarray(0, d.nb * 4), gl.DYNAMIC_DRAW)
    d.gpu.cap = d.nb * 4
    d.uploaded = d.nb
  }

  /**
   * Decide whether a visible range [s, e) of a monotonic chunk should be drawn
   * from a LOD level. Returns the level and the uploaded bucket range; samples
   * after `tail` are drawn raw.
   */
  lodPlan(r: GLRenderer, ch: Chunk, s: number, e: number, pxPerUnit: number): { d: Lod; b0: number; b1: number; tail: number } | null {
    const n = e - s
    if (!this.monoX || n < 4096) return null
    const span = ch.xy[(e - 1) * 2] - ch.xy[s * 2]
    const pxw = Math.abs(span * pxPerUnit)
    const ppp = n / Math.max(1, pxw)
    if (!(ppp > 6)) return null
    const L = Math.floor(Math.log2(ppp / 2 / LOD_MIN))
    if (L < 0) return null
    const d = ch.lod(Math.min(L, 12))
    this.syncLod(r, d)
    const b0 = Math.floor(s / d.B)
    const b1 = Math.min(d.uploaded, Math.ceil(e / d.B))
    if (b1 - b0 < 2) return null
    return { d, b0, b1, tail: b1 * d.B - 1 }
  }

  free(r: GLRenderer, ch: Chunk) {
    for (const k of Object.keys(ch.gpu) as ('xy' | Channel)[]) {
      const g = ch.gpu[k]
      if (g) r.gl.deleteBuffer(g.buf)
    }
    for (const d of ch.lods) if (d?.gpu) r.gl.deleteBuffer(d.gpu.buf)
    for (const k of Object.keys(ch.tailGpu) as ('xy' | Channel)[]) r.gl.deleteBuffer(ch.tailGpu[k]!)
    ch.tailGpu = {}
    ch.tailN = 0
    ch.lods = []
    ch.gpu = {}
    ch.uploaded = 0
  }

  dispose(r: GLRenderer | null) {
    if (r) {
      for (const c of this.chunks) this.free(r, c)
      for (const c of this.released) this.free(r, c)
    }
    this.chunks = []
    this.released = []
  }
}
