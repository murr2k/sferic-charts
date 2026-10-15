import { Color } from '../core/color'
import { DashedLine, Fill, LUT, LookUpProperty, PalettedFill } from '../core/style'
import { XYStore, Chunk } from '../xy/store'
import { AxisMap, FillParams, GLRenderer, makeXform, Rect } from './GLRenderer'
import * as S from './shaders'

const { ATTR } = S

export interface XYMaps { mx: AxisMap; my: AxisMap; x0: number; x1: number }

const lutModeOf = (p: LookUpProperty) => (p === 'x' ? 1 : p === 'y' ? 2 : 3)

function chunkSetup(r: GLRenderer, prog: ReturnType<GLRenderer['program']>, maps: XYMaps, ch: Chunk) {
  r.useXform(prog, makeXform(maps.mx, maps.my, ch.ox, ch.oy, r.dpr))
}

export interface LineDrawStyle {
  thickness: number
  color: Color
  fill?: Fill
  dashed?: DashedLine
}

/** Draw a store's points as a connected strip. */
export function drawLineStrip(r: GLRenderer, store: XYStore, maps: XYMaps, st: LineDrawStyle) {
  if (st.thickness === 0 || st.color.a === 0) return
  const gl = r.gl
  const prim = st.thickness < 0 && !st.dashed
  const prog = prim ? r.program('prim', S.PRIM_VS, S.PRIM_FS) : r.program('line', S.LINE_VS, S.LINE_FS)
  const pal = st.fill instanceof PalettedFill ? st.fill : null
  const usesValue = !!pal && pal.lookUpProperty === 'value' && store.channels.has('value')
  const usesColor = store.channels.has('color') && !pal
  let dashBuf: WebGLBuffer | null = null
  let dashArr: Float32Array | null = null
  let distAcc = 0
  store.forVisible(maps.x0, maps.x1, (ch, ci) => {
    const [s, e] = store.visibleRange(ch, ci, maps.x0, maps.x1, false)
    const n = e - s
    if (n < 2) return
    store.sync(r, ch)
    chunkSetup(r, prog, maps, ch)
    const c = st.color.toFloat()
    r.u4f(prog.u.u_color, c[0], c[1], c[2], c[3])
    r.useLUT(prog, pal ? lutModeOf(pal.lookUpProperty) : 0, pal ? pal.lut : null)
    if (!prim) {
      r.u1f(prog.u.u_halfw, (Math.max(0.5, st.thickness) * r.dpr) / 2)
      r.u1f(prog.u.u_dashPeriod, 0)
    }
    // Dense progressive data: draw min/max envelopes from a LOD level, then the raw tail.
    const plan = !usesColor && !usesValue && !st.dashed && maps.mx.log === 0 ? store.lodPlan(r, ch, s, e, maps.mx.k) : null
    if (plan) {
      plainStrip(r, prim, plan.d.gpu!.buf, plan.b0 * 2, (plan.b1 - plan.b0) * 2)
      for (const p of store.parts(ch, Math.max(s, plan.tail), e, true)) plainStrip(r, prim, p.gpu.xy!.buf, p.start, p.count)
      return
    }
    if (st.dashed) {
      // Cumulative pixel distance per segment start, computed on CPU in double precision.
      const pat = st.dashed.dashArray().map((v) => v * r.dpr)
      while (pat.length < 4) pat.push(...pat)
      r.u4f(prog.u.u_dash, pat[0], pat[1], pat[2], pat[3])
      r.u1f(prog.u.u_dashPeriod, pat[0] + pat[1] + pat[2] + pat[3])
      if (!dashArr || dashArr.length < n) dashArr = new Float32Array(Math.max(n, 1024))
      const toPx = (m: AxisMap, v: number) =>
        m.a0 + ((m.log ? Math.log(v) / Math.log(m.log) : v) - (m.log ? Math.log(m.start) / Math.log(m.log) : m.start)) * m.k
      let px = toPx(maps.mx, ch.x(s)) * r.dpr, py = toPx(maps.my, ch.y(s)) * r.dpr
      for (let i = 0; i < n - 1; i++) {
        dashArr[i] = distAcc
        const qx = toPx(maps.mx, ch.x(s + i + 1)) * r.dpr, qy = toPx(maps.my, ch.y(s + i + 1)) * r.dpr
        const d = Math.hypot(qx - px, qy - py)
        if (Number.isFinite(d)) distAcc = (distAcc + d) % 1e6
        px = qx
        py = qy
      }
      if (!dashBuf) dashBuf = gl.createBuffer()!
    }
    for (const p of store.parts(ch, s, e, true)) {
      const g = p.gpu
      const k = p.start
      if (prim) {
        const keep: number[] = [ATTR.p0]
        if (usesColor) keep.push(ATTR.c0)
        if (usesValue) keep.push(ATTR.v0)
        r.resetAttribs(keep)
        r.attrib(ATTR.p0, g.xy!.buf, 2, gl.FLOAT, false, 8, k * 8, 0)
        if (usesColor) r.attrib(ATTR.c0, g.color!.buf, 4, gl.UNSIGNED_BYTE, true, 4, k * 4, 0)
        if (usesValue) r.attrib(ATTR.v0, g.value!.buf, 1, gl.FLOAT, false, 4, k * 4, 0)
        gl.drawArrays(gl.LINE_STRIP, 0, p.count)
        continue
      }
      const keep: number[] = [ATTR.corner, ATTR.p0, ATTR.p1]
      if (usesColor) keep.push(ATTR.c0, ATTR.c1)
      if (usesValue) keep.push(ATTR.v0, ATTR.v1)
      if (st.dashed) keep.push(ATTR.d0)
      r.resetAttribs(keep)
      r.attrib(ATTR.corner, r.cornerBuffer('line'), 2, gl.FLOAT, false, 0, 0, 0)
      r.attrib(ATTR.p0, g.xy!.buf, 2, gl.FLOAT, false, 8, k * 8, 1)
      r.attrib(ATTR.p1, g.xy!.buf, 2, gl.FLOAT, false, 8, (k + 1) * 8, 1)
      if (usesColor) {
        r.attrib(ATTR.c0, g.color!.buf, 4, gl.UNSIGNED_BYTE, true, 4, k * 4, 1)
        r.attrib(ATTR.c1, g.color!.buf, 4, gl.UNSIGNED_BYTE, true, 4, (k + 1) * 4, 1)
      }
      if (usesValue) {
        r.attrib(ATTR.v0, g.value!.buf, 1, gl.FLOAT, false, 4, k * 4, 1)
        r.attrib(ATTR.v1, g.value!.buf, 1, gl.FLOAT, false, 4, (k + 1) * 4, 1)
      }
      if (st.dashed && dashBuf && dashArr) {
        gl.bindBuffer(gl.ARRAY_BUFFER, dashBuf)
        gl.bufferData(gl.ARRAY_BUFFER, dashArr.subarray(p.at - s, p.at - s + p.count - 1), gl.STREAM_DRAW)
        r.attrib(ATTR.d0, dashBuf, 1, gl.FLOAT, false, 4, 0, 1)
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, p.count - 1)
    }
  })
  if (dashBuf) {
    r.resetAttribs([])
    gl.deleteBuffer(dashBuf)
  }
}

/** Strip of `count` xy vertices starting at vertex `start` of `buf`, no per-vertex channels. */
function plainStrip(r: GLRenderer, prim: boolean, buf: WebGLBuffer, start: number, count: number) {
  const gl = r.gl
  if (count < 2) return
  if (prim) {
    r.resetAttribs([ATTR.p0])
    r.attrib(ATTR.p0, buf, 2, gl.FLOAT, false, 8, start * 8, 0)
    gl.drawArrays(gl.LINE_STRIP, 0, count)
    return
  }
  r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.p1])
  r.attrib(ATTR.corner, r.cornerBuffer('line'), 2, gl.FLOAT, false, 0, 0, 0)
  r.attrib(ATTR.p0, buf, 2, gl.FLOAT, false, 8, start * 8, 1)
  r.attrib(ATTR.p1, buf, 2, gl.FLOAT, false, 8, (start + 1) * 8, 1)
  gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count - 1)
}

export type PointShapeName = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'x' | 'star' | 'arrow'
export const shapeIndex: Record<PointShapeName, number> = {
  circle: 0, square: 1, triangle: 2, diamond: 3, cross: 4, x: 5, star: 6, arrow: 7,
}

export interface PointDrawStyle {
  size: number
  shape: PointShapeName
  color: Color
  fill?: Fill
  strokeWidth?: number
  strokeColor?: Color
}

export function drawPoints(r: GLRenderer, store: XYStore, maps: XYMaps, st: PointDrawStyle) {
  if (st.size <= 0 || st.color.a === 0) return
  const gl = r.gl
  const prog = r.program('point', S.POINT_VS, S.POINT_FS)
  const pal = st.fill instanceof PalettedFill ? st.fill : null
  const usesValue = !!pal && pal.lookUpProperty === 'value' && store.channels.has('value')
  const usesColor = store.channels.has('color') && !pal
  const usesSize = store.channels.has('size')
  const usesRot = store.channels.has('rot')
  store.forVisible(maps.x0, maps.x1, (ch, ci) => {
    const [s, e] = store.visibleRange(ch, ci, maps.x0, maps.x1, true)
    if (e - s < 1) return
    store.sync(r, ch)
    chunkSetup(r, prog, maps, ch)
    const c = st.color.toFloat()
    r.u4f(prog.u.u_color, c[0], c[1], c[2], c[3])
    r.u1f(prog.u.u_size, st.size * r.dpr)
    r.u1f(prog.u.u_sizeScale, r.dpr)
    r.u1i(prog.u.u_shape, shapeIndex[st.shape] ?? 0)
    r.u1f(prog.u.u_strokeW, (st.strokeWidth ?? 0) * r.dpr)
    const sc = (st.strokeColor ?? st.color).toFloat()
    r.u4f(prog.u.u_strokeColor, sc[0], sc[1], sc[2], sc[3])
    r.useLUT(prog, pal ? lutModeOf(pal.lookUpProperty) : 0, pal ? pal.lut : null)
    const keep: number[] = [ATTR.corner, ATTR.p0]
    if (usesColor) keep.push(ATTR.c0)
    if (usesValue) keep.push(ATTR.v0)
    if (usesSize) keep.push(ATTR.size)
    if (usesRot) keep.push(ATTR.rot)
    for (const p of store.parts(ch, s, e, false)) {
      const g = p.gpu
      const k = p.start
      r.resetAttribs(keep)
      r.attrib(ATTR.corner, r.cornerBuffer('point'), 2, gl.FLOAT, false, 0, 0, 0)
      r.attrib(ATTR.p0, g.xy!.buf, 2, gl.FLOAT, false, 8, k * 8, 1)
      if (usesColor) r.attrib(ATTR.c0, g.color!.buf, 4, gl.UNSIGNED_BYTE, true, 4, k * 4, 1)
      if (usesValue) r.attrib(ATTR.v0, g.value!.buf, 1, gl.FLOAT, false, 4, k * 4, 1)
      if (usesSize) r.attrib(ATTR.size, g.size!.buf, 1, gl.FLOAT, false, 4, k * 4, 1)
      if (usesRot) r.attrib(ATTR.rot, g.rot!.buf, 1, gl.FLOAT, false, 4, k * 4, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, p.count)
    }
  })
}

export interface AreaDrawStyle {
  fill: Fill
  color: Color
  baseline: number
  rect: Rect
}

export function drawArea(r: GLRenderer, store: XYStore, maps: XYMaps, st: AreaDrawStyle) {
  if (st.fill.type === 'empty') return
  const gl = r.gl
  const prog = r.program('area', S.AREA_VS, S.AREA_FS)
  const hasLo = store.channels.has('lo')
  store.forVisible(maps.x0, maps.x1, (ch, ci) => {
    const [s, e] = store.visibleRange(ch, ci, maps.x0, maps.x1, false)
    if (e - s < 2) return
    store.sync(r, ch)
    chunkSetup(r, prog, maps, ch)
    r.useFill(prog, { color: st.color, fill: st.fill, rect: st.rect } as FillParams)
    const quads = (xy: WebGLBuffer, lo: WebGLBuffer | null, start: number, count: number) => {
      if (count < 2) return
      r.resetAttribs(lo ? [ATTR.corner, ATTR.p0, ATTR.p1, ATTR.lo0, ATTR.lo1] : [ATTR.corner, ATTR.p0, ATTR.p1])
      r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
      r.attrib(ATTR.p0, xy, 2, gl.FLOAT, false, 8, start * 8, 1)
      r.attrib(ATTR.p1, xy, 2, gl.FLOAT, false, 8, (start + 1) * 8, 1)
      if (lo) {
        r.attrib(ATTR.lo0, lo, 1, gl.FLOAT, false, 4, start * 4, 1)
        r.attrib(ATTR.lo1, lo, 1, gl.FLOAT, false, 4, (start + 1) * 4, 1)
      } else {
        r.generic1f(ATTR.lo0, st.baseline - ch.oy)
        r.generic1f(ATTR.lo1, st.baseline - ch.oy)
      }
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count - 1)
    }
    const plan = !hasLo && maps.mx.log === 0 ? store.lodPlan(r, ch, s, e, maps.mx.k) : null
    if (plan) {
      quads(plan.d.gpu!.buf, null, plan.b0 * 2, (plan.b1 - plan.b0) * 2)
      for (const p of store.parts(ch, Math.max(s, plan.tail), e, true)) quads(p.gpu.xy!.buf, null, p.start, p.count)
      return
    }
    for (const p of store.parts(ch, s, e, true)) quads(p.gpu.xy!.buf, hasLo ? p.gpu.lo!.buf : null, p.start, p.count)
  })
}

/**
 * A growable batch of rectangles in data coordinates (relative to an origin),
 * with per-rect colors. Used by bars, boxes, candlesticks, heat cells.
 */
export class RectBatch {
  n = 0
  ox = 0
  oy = 0
  rects = new Float32Array(64 * 4)
  colors = new Uint32Array(64)
  private buf: WebGLBuffer | null = null
  private cbuf: WebGLBuffer | null = null
  private gpuCap = 0
  private dirty = true

  clear() { this.n = 0; this.dirty = true }
  setOrigin(ox: number, oy: number) { this.ox = ox; this.oy = oy }
  push(x0: number, y0: number, x1: number, y1: number, color: Color | number) {
    if (this.n >= this.colors.length) {
      const cap = this.colors.length * 2
      const r = new Float32Array(cap * 4); r.set(this.rects); this.rects = r
      const c = new Uint32Array(cap); c.set(this.colors); this.colors = c
    }
    const i = this.n++
    this.rects[i * 4] = x0 - this.ox
    this.rects[i * 4 + 1] = y0 - this.oy
    this.rects[i * 4 + 2] = x1 - this.ox
    this.rects[i * 4 + 3] = y1 - this.oy
    this.colors[i] = typeof color === 'number' ? color : color.toUint32()
    this.dirty = true
  }
  draw(
    r: GLRenderer,
    maps: { mx: AxisMap; my: AxisMap },
    o: { fill?: Fill; borderWidth?: number; borderColor?: Color; radius?: number; minPx?: number; rect?: Rect } = {},
  ) {
    if (!this.n) return
    const gl = r.gl
    if (!this.buf) {
      this.buf = gl.createBuffer()!
      this.cbuf = gl.createBuffer()!
    }
    if (this.dirty) {
      if (this.gpuCap < this.colors.length) {
        this.gpuCap = this.colors.length
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
        gl.bufferData(gl.ARRAY_BUFFER, this.gpuCap * 16, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
        gl.bufferData(gl.ARRAY_BUFFER, this.gpuCap * 4, gl.DYNAMIC_DRAW)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.rects, 0, this.n * 4)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colors, 0, this.n)
      this.dirty = false
    }
    const prog = r.program('rect', S.RECT_VS, S.RECT_FS)
    r.useXform(prog, makeXform(maps.mx, maps.my, this.ox, this.oy, r.dpr))
    r.useFill(prog, { color: new Color(255, 255, 255), fill: o.fill, rect: o.rect })
    r.u1f(prog.u.u_minPx, (o.minPx ?? 0) * r.dpr)
    r.u1f(prog.u.u_borderW, (o.borderWidth ?? 0) * r.dpr)
    const bc = (o.borderColor ?? new Color(0, 0, 0, 0)).toFloat()
    r.u4f(prog.u.u_borderColor, bc[0], bc[1], bc[2], bc[3])
    r.u1f(prog.u.u_radius, (o.radius ?? 0) * r.dpr)
    r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.c0])
    r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
    r.attrib(ATTR.p0, this.buf, 4, gl.FLOAT, false, 16, 0, 1)
    r.attrib(ATTR.c0, this.cbuf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n)
  }
  dispose(r: GLRenderer | null) {
    if (r && this.buf) {
      r.gl.deleteBuffer(this.buf)
      r.gl.deleteBuffer(this.cbuf)
    }
    this.buf = this.cbuf = null
    this.gpuCap = 0
    this.dirty = true
  }
}

/** Segments with per-segment color (independent, not a strip). */
export class SegmentBatch {
  n = 0
  ox = 0
  oy = 0
  segs = new Float32Array(64 * 4)
  colors = new Uint32Array(64)
  private buf: WebGLBuffer | null = null
  private cbuf: WebGLBuffer | null = null
  private gpuCap = 0
  private dirty = true
  clear() { this.n = 0; this.dirty = true }
  setOrigin(ox: number, oy: number) { this.ox = ox; this.oy = oy }
  push(x0: number, y0: number, x1: number, y1: number, color: Color | number) {
    if (this.n >= this.colors.length) {
      const cap = this.colors.length * 2
      const s = new Float32Array(cap * 4); s.set(this.segs); this.segs = s
      const c = new Uint32Array(cap); c.set(this.colors); this.colors = c
    }
    const i = this.n++
    this.segs[i * 4] = x0 - this.ox
    this.segs[i * 4 + 1] = y0 - this.oy
    this.segs[i * 4 + 2] = x1 - this.ox
    this.segs[i * 4 + 3] = y1 - this.oy
    this.colors[i] = typeof color === 'number' ? color : color.toUint32()
    this.dirty = true
  }
  draw(r: GLRenderer, maps: { mx: AxisMap; my: AxisMap }, thickness: number) {
    if (!this.n) return
    const gl = r.gl
    if (!this.buf) {
      this.buf = gl.createBuffer()!
      this.cbuf = gl.createBuffer()!
    }
    if (this.dirty) {
      if (this.gpuCap < this.colors.length) {
        this.gpuCap = this.colors.length
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
        gl.bufferData(gl.ARRAY_BUFFER, this.gpuCap * 16, gl.DYNAMIC_DRAW)
        gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
        gl.bufferData(gl.ARRAY_BUFFER, this.gpuCap * 4, gl.DYNAMIC_DRAW)
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.segs, 0, this.n * 4)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.colors, 0, this.n)
      this.dirty = false
    }
    const prog = r.program('line', S.LINE_VS, S.LINE_FS)
    r.useXform(prog, makeXform(maps.mx, maps.my, this.ox, this.oy, r.dpr))
    r.u4f(prog.u.u_color, 1, 1, 1, 1)
    r.u1f(prog.u.u_halfw, (Math.max(0.5, thickness) * r.dpr) / 2)
    r.u1f(prog.u.u_dashPeriod, 0)
    r.useLUT(prog, 0, null)
    r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.p1, ATTR.c0, ATTR.c1])
    r.attrib(ATTR.corner, r.cornerBuffer('line'), 2, gl.FLOAT, false, 0, 0, 0)
    r.attrib(ATTR.p0, this.buf, 2, gl.FLOAT, false, 16, 0, 1)
    r.attrib(ATTR.p1, this.buf, 2, gl.FLOAT, false, 16, 8, 1)
    r.attrib(ATTR.c0, this.cbuf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
    r.attrib(ATTR.c1, this.cbuf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n)
  }
  dispose(r: GLRenderer | null) {
    if (r && this.buf) {
      r.gl.deleteBuffer(this.buf)
      r.gl.deleteBuffer(this.cbuf)
    }
    this.buf = this.cbuf = null
    this.gpuCap = 0
    this.dirty = true
  }
}

/** Heatmap value texture with optional ring-buffer columns (for scrolling heatmaps). */
export class HeatmapTexture {
  cols: number
  rows: number
  /** Ring capacity in columns; 0 = static grid. */
  cap: number
  data: Float32Array
  ringStart = 0
  filled: number
  private tex: WebGLTexture | null = null
  private dirtyAll = true
  private dirtyCols: number[] = []
  constructor(cols: number, rows: number, cap = 0) {
    this.cols = cols
    this.rows = rows
    this.cap = cap
    const w = cap > 0 ? cap : cols
    this.data = new Float32Array(w * rows).fill(NaN)
    this.filled = cap > 0 ? 0 : cols
  }
  get texW(): number { return this.cap > 0 ? this.cap : this.cols }

  /** Write a full static grid (row-major: [row][col]). */
  setRowMajor(values: ArrayLike<number>) {
    this.data.set(values as any)
    this.dirtyAll = true
  }
  invalidateRegion(iCol: number, iRow: number, values: number[][], order: 'columns' | 'rows') {
    const W = this.texW
    if (order === 'columns') {
      for (let c = 0; c < values.length; c++) {
        const col = values[c]
        const cc = iCol + c
        if (cc < 0 || cc >= this.cols) continue
        for (let r = 0; r < col.length; r++) {
          const rr = iRow + r
          if (rr < 0 || rr >= this.rows) continue
          this.data[rr * W + cc] = col[r]
        }
      }
    } else {
      for (let r = 0; r < values.length; r++) {
        const row = values[r]
        const rr = iRow + r
        if (rr < 0 || rr >= this.rows) continue
        for (let c = 0; c < row.length; c++) {
          const cc = iCol + c
          if (cc < 0 || cc >= this.cols) continue
          this.data[rr * W + cc] = row[c]
        }
      }
    }
    this.dirtyAll = true
  }
  /** Append columns to ring (scrolling). Each column has `rows` values. */
  pushColumns(columns: ArrayLike<number>[]) {
    const W = this.texW
    for (const col of columns) {
      let tc: number
      if (this.filled < this.cap) {
        tc = (this.ringStart + this.filled) % this.cap
        this.filled++
      } else {
        tc = this.ringStart
        this.ringStart = (this.ringStart + 1) % this.cap
      }
      for (let r = 0; r < this.rows; r++) this.data[r * W + tc] = r < col.length ? col[r] : NaN
      this.dirtyCols.push(tc)
    }
    if (this.dirtyCols.length > this.cap / 4) this.dirtyAll = true
  }
  bind(r: GLRenderer, unit: number) {
    const gl = r.gl
    gl.activeTexture(gl.TEXTURE0 + unit)
    if (!this.tex) {
      this.tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.texW, this.rows)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      this.dirtyAll = true
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    if (this.dirtyAll) {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.texW, this.rows, gl.RED, gl.FLOAT, this.data)
      this.dirtyAll = false
      this.dirtyCols.length = 0
    } else if (this.dirtyCols.length) {
      const W = this.texW
      const col = new Float32Array(this.rows)
      // Upload contiguous runs of columns.
      const set = [...new Set(this.dirtyCols)].sort((a, b) => a - b)
      let i = 0
      while (i < set.length) {
        let j = i
        while (j + 1 < set.length && set[j + 1] === set[j] + 1) j++
        const c0 = set[i], n = set[j] - c0 + 1
        if (n === 1) {
          for (let rr = 0; rr < this.rows; rr++) col[rr] = this.data[rr * W + c0]
          gl.texSubImage2D(gl.TEXTURE_2D, 0, c0, 0, 1, this.rows, gl.RED, gl.FLOAT, col)
        } else {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, W)
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, c0)
          gl.texSubImage2D(gl.TEXTURE_2D, 0, c0, 0, n, this.rows, gl.RED, gl.FLOAT, this.data)
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
        }
        i = j + 1
      }
      this.dirtyCols.length = 0
    }
  }
  /** Draw over data rect [x0,x1]x[y0,y1]. */
  draw(
    r: GLRenderer,
    maps: { mx: AxisMap; my: AxisMap },
    area: { x0: number; y0: number; x1: number; y1: number },
    lut: LUT,
    o: { interpolate?: boolean; opacity?: number; visibleCols?: number } = {},
  ) {
    const gl = r.gl
    const prog = r.program('heat', S.HEAT_VS, S.HEAT_FS)
    const ox = area.x0, oy = area.y0
    r.useXform(prog, makeXform(maps.mx, maps.my, ox, oy, r.dpr))
    r.u4f(prog.u.u_area, 0, 0, area.x1 - ox, area.y1 - oy)
    this.bind(r, 1)
    r.u1i(prog.u.u_vals, 1)
    const cols = o.visibleCols ?? (this.cap > 0 ? Math.max(1, this.filled) : this.cols)
    gl.uniform2i(prog.u.u_dims, cols, this.rows)
    r.u1i(prog.u.u_cap, this.cap)
    r.u1i(prog.u.u_ringStart, this.ringStart)
    r.u1i(prog.u.u_interp, o.interpolate ? 1 : 0)
    r.u1f(prog.u.u_opacity, o.opacity ?? 1)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, r.lutTexture(lut))
    r.u1i(prog.u.u_lut, 0)
    r.u2f(prog.u.u_lutRange, lut.min, lut.max)
    r.u1i(prog.u.u_lutMode, 0)
    r.resetAttribs([ATTR.corner])
    r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }
  dispose(r: GLRenderer | null) {
    if (r && this.tex) r.gl.deleteTexture(this.tex)
    this.tex = null
  }
}
