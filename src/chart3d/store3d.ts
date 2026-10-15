import { Color } from '../core/color'
import { GLBuf } from './gl3d'

export interface Bounds3D { xmin: number; xmax: number; ymin: number; ymax: number; zmin: number; zmax: number }

export interface Point3DData {
  x: number
  y: number
  z: number
  color?: Color
  size?: number
  value?: number
}

export const emptyBounds = (): Bounds3D => ({ xmin: Infinity, xmax: -Infinity, ymin: Infinity, ymax: -Infinity, zmin: Infinity, zmax: -Infinity })

/**
 * Ring buffer of 3D samples in float32, relative to a float64 origin. Slot `cap`
 * mirrors slot 0 so that consecutive-pair (segment) instancing works across the wrap.
 */
export class Store3D {
  cap: number
  n = 0
  head = 0
  maxCount = Infinity
  ox = 0
  oy = 0
  oz = 0
  private hasOrigin = false
  pos: Float32Array
  col: Uint32Array | null = null
  size: Float32Array | null = null
  val: Float32Array | null = null
  /** Bumps on every change (picking caches key on it). */
  version = 0
  private lo = Infinity
  private hi = -1
  private b: Bounds3D = emptyBounds()
  private vmin = Infinity
  private vmax = -Infinity
  private boundsStale = false
  // GPU
  readonly gPos = new GLBuf()
  readonly gCol = new GLBuf()
  readonly gSize = new GLBuf()
  readonly gVal = new GLBuf()
  private gpuCap = -1

  constructor(cap = 1024) {
    this.cap = cap
    this.pos = new Float32Array((cap + 1) * 3)
  }

  setMaxCount(n: number) {
    this.maxCount = Math.max(2, Math.floor(n) || Infinity)
    if (this.n > this.maxCount) {
      // keep the newest maxCount samples
      const drop = this.n - this.maxCount
      this.head = (this.head + drop) % this.cap
      this.n = this.maxCount
      this.boundsStale = true
    }
    if (this.cap > this.maxCount && this.maxCount !== Infinity) this.relayout(this.maxCount)
    this.version++
  }

  clear() {
    this.n = 0
    this.head = 0
    this.hasOrigin = false
    this.b = emptyBounds()
    this.vmin = Infinity
    this.vmax = -Infinity
    this.boundsStale = false
    this.version++
  }

  /** Physical slot of logical sample i. */
  phys(i: number) { const p = this.head + i; return p >= this.cap ? p - this.cap : p }
  x(i: number) { return this.pos[this.phys(i) * 3] + this.ox }
  y(i: number) { return this.pos[this.phys(i) * 3 + 1] + this.oy }
  z(i: number) { return this.pos[this.phys(i) * 3 + 2] + this.oz }

  private relayout(ncap: number) {
    const keep = Math.min(this.n, ncap)
    const skip = this.n - keep
    const np = new Float32Array((ncap + 1) * 3)
    const nc = this.col ? new Uint32Array(ncap + 1) : null
    const ns = this.size ? new Float32Array(ncap + 1) : null
    const nv = this.val ? new Float32Array(ncap + 1) : null
    for (let i = 0; i < keep; i++) {
      const p = this.phys(i + skip)
      np[i * 3] = this.pos[p * 3]; np[i * 3 + 1] = this.pos[p * 3 + 1]; np[i * 3 + 2] = this.pos[p * 3 + 2]
      if (nc) nc[i] = this.col![p]
      if (ns) ns[i] = this.size![p]
      if (nv) nv[i] = this.val![p]
    }
    np[ncap * 3] = np[0]; np[ncap * 3 + 1] = np[1]; np[ncap * 3 + 2] = np[2]
    if (nc) nc[ncap] = nc[0]
    if (ns) ns[ncap] = ns[0]
    if (nv) nv[ncap] = nv[0]
    this.pos = np
    this.col = nc
    this.size = ns
    this.val = nv
    this.cap = ncap
    this.head = 0
    this.n = keep
    if (skip) this.boundsStale = true
    this.lo = 0
    this.hi = ncap + 1
  }

  private ensureChannel(kind: 'col' | 'size' | 'val') {
    if (this[kind]) return
    const a = kind === 'col' ? new Uint32Array(this.cap + 1) : new Float32Array(this.cap + 1)
    ;(this as any)[kind] = a
    this.lo = 0
    this.hi = this.cap + 1
  }

  /** Reserve a slot for one new sample and return its physical index. */
  private slot(): number {
    if (this.n === this.cap) {
      if (this.cap < this.maxCount) this.relayout(Math.min(this.maxCount, this.cap * 2))
      else {
        this.head = this.head + 1 === this.cap ? 0 : this.head + 1
        this.n--
        this.boundsStale = true
      }
    }
    const p = this.phys(this.n)
    this.n++
    if (p < this.lo) this.lo = p
    if (p + 1 > this.hi) this.hi = p + 1
    if (p === 0) this.hi = Math.max(this.hi, this.cap + 1)
    return p
  }

  private write(p: number, x: number, y: number, z: number) {
    if (!this.hasOrigin && Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      this.hasOrigin = true
      this.ox = x
      this.oy = y
      this.oz = z
    }
    const rx = x - this.ox, ry = y - this.oy, rz = z - this.oz
    this.pos[p * 3] = rx; this.pos[p * 3 + 1] = ry; this.pos[p * 3 + 2] = rz
    if (p === 0) { this.pos[this.cap * 3] = rx; this.pos[this.cap * 3 + 1] = ry; this.pos[this.cap * 3 + 2] = rz }
    if (!this.boundsStale && Number.isFinite(x + y + z)) {
      const b = this.b
      if (x < b.xmin) b.xmin = x
      if (x > b.xmax) b.xmax = x
      if (y < b.ymin) b.ymin = y
      if (y > b.ymax) b.ymax = y
      if (z < b.zmin) b.zmin = z
      if (z > b.zmax) b.zmax = z
    }
  }

  private setCh(arr: Uint32Array | Float32Array, p: number, v: number) {
    arr[p] = v
    if (p === 0) arr[this.cap] = v
  }

  append(pts: Point3DData | Point3DData[]) {
    const list = Array.isArray(pts) ? pts : [pts]
    for (const q of list) {
      if (q.color && !this.col) this.ensureChannel('col')
      if (q.size !== undefined && !this.size) this.ensureChannel('size')
      if (q.value !== undefined && !this.val) this.ensureChannel('val')
      const p = this.slot()
      this.write(p, +q.x, +q.y, +q.z)
      if (this.col) this.setCh(this.col, p, q.color ? q.color.toUint32() : 0)
      if (this.size) this.setCh(this.size, p, q.size ?? 0)
      if (this.val) {
        const v = q.value ?? 0
        this.setCh(this.val, p, v)
        if (v < this.vmin) this.vmin = v
        if (v > this.vmax) this.vmax = v
      }
    }
    this.version++
  }

  /** Columnar append (fastest). */
  appendSamples(o: { xValues: ArrayLike<number>; yValues: ArrayLike<number>; zValues: ArrayLike<number>; colors?: ArrayLike<Color>; sizes?: ArrayLike<number>; values?: ArrayLike<number> }) {
    const n = Math.min(o.xValues.length, o.yValues.length, o.zValues.length)
    if (o.colors && !this.col) this.ensureChannel('col')
    if (o.sizes && !this.size) this.ensureChannel('size')
    if (o.values && !this.val) this.ensureChannel('val')
    for (let i = 0; i < n; i++) {
      const p = this.slot()
      this.write(p, o.xValues[i], o.yValues[i], o.zValues[i])
      if (this.col) this.setCh(this.col, p, o.colors ? o.colors[i].toUint32() : 0)
      if (this.size) this.setCh(this.size, p, o.sizes ? o.sizes[i] : 0)
      if (this.val) {
        const v = o.values ? o.values[i] : 0
        this.setCh(this.val, p, v)
        if (v < this.vmin) this.vmin = v
        if (v > this.vmax) this.vmax = v
      }
    }
    this.version++
  }

  bounds(): Bounds3D | null {
    if (this.boundsStale) {
      const b = emptyBounds()
      let vmin = Infinity, vmax = -Infinity
      for (let i = 0; i < this.n; i++) {
        const p = this.phys(i) * 3
        const x = this.pos[p] + this.ox, y = this.pos[p + 1] + this.oy, z = this.pos[p + 2] + this.oz
        if (!Number.isFinite(x + y + z)) continue
        if (x < b.xmin) b.xmin = x
        if (x > b.xmax) b.xmax = x
        if (y < b.ymin) b.ymin = y
        if (y > b.ymax) b.ymax = y
        if (z < b.zmin) b.zmin = z
        if (z > b.zmax) b.zmax = z
        if (this.val) {
          const v = this.val[this.phys(i)]
          if (v < vmin) vmin = v
          if (v > vmax) vmax = v
        }
      }
      this.b = b
      this.vmin = vmin
      this.vmax = vmax
      this.boundsStale = false
    }
    return this.n && this.b.xmin <= this.b.xmax ? this.b : null
  }

  valueRange(): [number, number] | null {
    this.bounds()
    return this.vmin <= this.vmax ? [this.vmin, this.vmax] : null
  }

  /** Upload changed slots. */
  sync(gl: WebGL2RenderingContext) {
    const n1 = this.cap + 1
    if (this.gPos.stale(gl)) this.gpuCap = -1 // context replaced: re-upload everything
    const full = this.gpuCap !== this.cap
    if (full) {
      this.gpuCap = this.cap
      this.lo = 0
      this.hi = n1
    }
    if (this.hi <= this.lo) return
    const lo = this.lo, hi = Math.min(this.hi, n1)
    const up = (g: GLBuf, arr: Float32Array | Uint32Array, comps: number) => {
      const realloc = g.ensure(gl, n1 * comps * 4)
      if (realloc) gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr, 0, n1 * comps)
      else gl.bufferSubData(gl.ARRAY_BUFFER, lo * comps * 4, arr, lo * comps, (hi - lo) * comps)
    }
    up(this.gPos, this.pos, 3)
    if (this.col) up(this.gCol, this.col, 1)
    if (this.size) up(this.gSize, this.size, 1)
    if (this.val) up(this.gVal, this.val, 1)
    this.lo = Infinity
    this.hi = -1
  }

  /** Physical [start, count] runs covering logical samples [0, count). */
  runs(count: number): [number, number][] {
    const c = Math.min(count, this.n)
    if (c <= 0) return []
    const first = Math.min(c, this.cap - this.head)
    return first < c ? [[this.head, first], [0, c - first]] : [[this.head, c]]
  }

  disposeGL(gl: WebGL2RenderingContext | null) {
    this.gPos.dispose(gl)
    this.gCol.dispose(gl)
    this.gSize.dispose(gl)
    this.gVal.dispose(gl)
    this.gpuCap = -1
  }
}
