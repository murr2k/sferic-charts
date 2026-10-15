import { Color } from '../core/color'
import { LegendSymbol, LegendTarget } from '../core/Legend'
import { Fill, isEmptyLine, LineStyle, LookUpProperty, LUT, Mutator, PalettedFill, resolve, SolidFill, SolidLine } from '../core/style'
import { Theme, seriesColor } from '../core/theme'
import { Emitter } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { ATTR } from '../render/shaders'
import { dataToCss, Frame3D, lutOf, setCommon, setFillUniforms, shapeMesh, program3d } from './gl3d'
import { Bounds3D, Point3DData, Store3D } from './store3d'
import { ColorShadingStyle, PhongShading, PixelatedShape3D, PointStyle3DType, TriangulatedPoints3D } from './styles3d'
import { LINE3_FS, LINE3_VS, MESHPT_FS, MESHPT_VS, PIXPT_FS, PIXPT_VS, SPHERE_FS, SPHERE_VS } from './shaders3d'

/** What a series needs from its Chart3D. */
export interface Chart3DHost {
  requestRender(): void
  getTheme(): Theme
  onSeriesData(s: Series3D): void
  onSeriesStyle(s: Series3D): void
  removeSeries(s: Series3D): void
}

/** Cursor pick result. */
export interface Hit3D {
  series: Series3D
  x: number
  y: number
  z: number
  value?: number
  /** CSS px on the surface. */
  sx: number
  sy: number
  /** Clip-space w (distance), smaller is nearer. */
  w: number
  d2: number
  color: Color
  extra?: [string, string][]
}

export interface Series3DOptions {
  automaticColorIndex?: number
  [k: string]: unknown
}

/** Base of every Chart3D series. */
export abstract class Series3D extends Emitter implements LegendTarget {
  readonly chart: Chart3DHost
  protected name: string
  protected visible = true
  effect: boolean | null = null
  cursorEnabled = true
  autoScroll = true
  readonly colorIndex: number
  protected shading: ColorShadingStyle = new PhongShading()
  protected clipping = true
  protected disposed = false

  constructor(chart: Chart3DHost, colorIndex: number, name: string) {
    super()
    this.chart = chart
    this.colorIndex = colorIndex
    this.name = name
  }

  setName(n: string) { this.name = n; this.chart.requestRender(); return this }
  getName() { return this.name }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.chart.requestRender()
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  setEffect(v: boolean) { this.effect = v; this.chart.requestRender(); return this }
  getEffect() { return this.effect ?? this.chart.getTheme().glow.enabled }
  setCursorEnabled(v: boolean) { this.cursorEnabled = v; return this }
  getCursorEnabled() { return this.cursorEnabled }
  setAutoScrollingEnabled(v: boolean) { this.autoScroll = v; this.chart.requestRender(); return this }
  setHighlightOnHover(_v: boolean) { return this }
  setColorShadingStyle(s: ColorShadingStyle) { this.shading = s; this.chart.requestRender(); return this }
  getColorShadingStyle() { return this.shading }
  /** Hide geometry outside the axis box (default true). */
  setClipping(v: boolean) { this.clipping = v; this.chart.requestRender(); return this }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.chart.removeSeries(this)
    return this
  }
  isDisposed() { return this.disposed }

  protected get theme() { return this.chart.getTheme() }
  protected defaultColor() { return seriesColor(this.theme, this.colorIndex) }

  /** Data extent for axis fitting; null when empty. */
  abstract bounds(): Bounds3D | null
  /** Range of a looked-up property (for percentage LUTs). */
  propRange(p: LookUpProperty): [number, number] | null {
    const b = this.bounds()
    if (!b) return null
    return p === 'x' ? [b.xmin, b.xmax] : p === 'y' ? [b.ymin, b.ymax] : p === 'z' ? [b.zmin, b.zmax] : null
  }
  abstract drawGL(r: GLRenderer, f: Frame3D): void
  /** Drawn after opaque series, without depth writes. */
  isTransparent() { return this.primaryColor().a < 250 }
  pick(_sx: number, _sy: number, _f: Frame3D): Hit3D | null { return null }
  abstract getLegendSymbol(): LegendSymbol
  abstract primaryColor(): Color
  /** LUT shown as a color bar in the legend. */
  legendLUT(): LUT | null { return null }
  disposeGL(_r: GLRenderer | null): void {}
}

// ------------------------------------------------------------------ shared draw helpers

const tmpM = new Float64Array(16)

/** Instanced draw of a store's samples with a point style. */
export function drawStorePoints(
  r: GLRenderer, f: Frame3D, st: Store3D, style: PointStyle3DType, fallback: Color,
  shading: ColorShadingStyle, clip: boolean, range: (p: LookUpProperty) => [number, number] | null,
) {
  const n = st.n
  if (!n || style.size <= 0) return
  const gl = r.gl
  st.sync(gl)
  const fill = style.fillStyle
  if (fill && fill.type === 'empty') return
  const pal = fill instanceof PalettedFill
  const useCol = !!st.col && !pal
  const useVal = !!st.val
  const useSize = !!st.size
  const pix = style.type === 'pixelated'
  const sphere = !pix && style.shape === 'sphere'
  const prog = pix
    ? program3d(r, 'c3d-pix', PIXPT_VS, PIXPT_FS)
    : sphere ? program3d(r, 'c3d-sphere', SPHERE_VS, SPHERE_FS) : program3d(r, 'c3d-meshpt', MESHPT_VS, MESHPT_FS)
  setCommon(r, prog, f, st.ox, st.oy, st.oz, { clip, shading })
  setFillUniforms(r, prog, fill, fallback, [st.ox, st.oy, st.oz], range, useCol)
  gl.uniform1f(prog.u.u_worldPerPx, f.worldPerPx)
  gl.uniform1f(prog.u.u_sizePx, style.size)
  gl.uniform1f(prog.u.u_pxScale, f.pxScale)
  gl.uniform1f(prog.u.u_dpr, f.dpr)
  if (pix) gl.uniform1i(prog.u.u_shape, pixShapeIndex[style.shape as PixelatedShape3D] ?? 1)
  const mesh = !pix && !sphere ? shapeMesh(gl, style.shape) : null
  const keep: number[] = [ATTR.corner, ATTR.p0]
  if (mesh) keep.push(ATTR.p1)
  if (useCol) keep.push(ATTR.c0)
  if (useVal) keep.push(ATTR.v0)
  if (useSize) keep.push(ATTR.size)
  r.resetAttribs(keep)
  if (mesh) {
    r.attrib(ATTR.corner, mesh.buf, 3, gl.FLOAT, false, 24, 0, 0)
    r.attrib(ATTR.p1, mesh.buf, 3, gl.FLOAT, false, 24, 12, 0)
  } else {
    r.attrib(ATTR.corner, r.cornerBuffer('point'), 2, gl.FLOAT, false, 0, 0, 0)
  }
  for (const [s, c] of st.runs(n)) {
    r.attrib(ATTR.p0, st.gPos.buf!, 3, gl.FLOAT, false, 12, s * 12, 1)
    if (useCol) r.attrib(ATTR.c0, st.gCol.buf!, 4, gl.UNSIGNED_BYTE, true, 4, s * 4, 1)
    if (useVal) r.attrib(ATTR.v0, st.gVal.buf!, 1, gl.FLOAT, false, 4, s * 4, 1)
    if (useSize) r.attrib(ATTR.size, st.gSize.buf!, 1, gl.FLOAT, false, 4, s * 4, 1)
    if (mesh) gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, c)
    else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c)
  }
}

const pixShapeIndex: Record<PixelatedShape3D, number> = { circle: 0, square: 1, triangle: 2, diamond: 3, cross: 4, x: 5, star: 6 }

/** Instanced capsule segments between consecutive samples. */
export function drawStoreLine(
  r: GLRenderer, f: Frame3D, st: Store3D, line: LineStyle, fallback: Color,
  clip: boolean, range: (p: LookUpProperty) => [number, number] | null,
) {
  const n = st.n
  if (n < 2 || isEmptyLine(line)) return
  const gl = r.gl
  st.sync(gl)
  const fill = line.getFillStyle()
  const pal = fill instanceof PalettedFill
  const useCol = !!st.col && !pal
  const useVal = !!st.val
  const prog = program3d(r, 'c3d-line', LINE3_VS, LINE3_FS)
  setCommon(r, prog, f, st.ox, st.oy, st.oz, { clip })
  setFillUniforms(r, prog, fill, fallback, [st.ox, st.oy, st.oz], range, useCol)
  const th = line.getThickness()
  gl.uniform1f(prog.u.u_halfw, (Math.max(0.5, th < 0 ? 1 : th) * r.dpr) / 2)
  const keep: number[] = [ATTR.corner, ATTR.p0, ATTR.p1]
  if (useCol) keep.push(ATTR.c0, ATTR.c1)
  if (useVal) keep.push(ATTR.v0, ATTR.v1)
  r.resetAttribs(keep)
  r.attrib(ATTR.corner, r.cornerBuffer('line'), 2, gl.FLOAT, false, 0, 0, 0)
  for (const [s, c] of st.runs(n - 1)) {
    r.attrib(ATTR.p0, st.gPos.buf!, 3, gl.FLOAT, false, 12, s * 12, 1)
    r.attrib(ATTR.p1, st.gPos.buf!, 3, gl.FLOAT, false, 12, (s + 1) * 12, 1)
    if (useCol) {
      r.attrib(ATTR.c0, st.gCol.buf!, 4, gl.UNSIGNED_BYTE, true, 4, s * 4, 1)
      r.attrib(ATTR.c1, st.gCol.buf!, 4, gl.UNSIGNED_BYTE, true, 4, (s + 1) * 4, 1)
    }
    if (useVal) {
      r.attrib(ATTR.v0, st.gVal.buf!, 1, gl.FLOAT, false, 4, s * 4, 1)
      r.attrib(ATTR.v1, st.gVal.buf!, 1, gl.FLOAT, false, 4, (s + 1) * 4, 1)
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, c)
  }
}

/**
 * Nearest sample to a screen position. Samples within `coverPx` of the pointer
 * compete on depth (front-most wins), otherwise the closest within `maxPx`.
 */
export function pickStore(st: Store3D, sx: number, sy: number, f: Frame3D, coverPx: number, maxPx = 40): { i: number; px: number; py: number; w: number; d2: number } | null {
  const n = st.n
  if (!n) return null
  const m = dataToCss(f, st.ox, st.oy, st.oz, tmpM)
  const pos = st.pos
  const cover2 = coverPx * coverPx
  let best = -1, bd = maxPx * maxPx, bw = Infinity, bx = 0, by = 0, covered = false
  const box = f.rect
  for (let i = 0; i < n; i++) {
    const p = st.phys(i) * 3
    const x = pos[p], y = pos[p + 1], z = pos[p + 2]
    const w = m[3] * x + m[7] * y + m[11] * z + m[15]
    if (!(w > 1e-6)) continue
    const cx = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w
    const cy = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w
    if (cx < box.x || cx > box.x + box.w || cy < box.y || cy > box.y + box.h) continue
    const dx = cx - sx, dy = cy - sy
    const d2 = dx * dx + dy * dy
    if (d2 <= cover2) {
      if (!covered || w < bw) {
        covered = true
        best = i; bd = d2; bw = w; bx = cx; by = cy
      }
    } else if (!covered && d2 < bd) {
      best = i; bd = d2; bw = w; bx = cx; by = cy
    }
  }
  return best < 0 ? null : { i: best, px: bx, py: by, w: bw, d2: bd }
}

/** Visible-in-box test for picking (data inside axis intervals). */
export function inBox(f: Frame3D, x: number, y: number, z: number) {
  const [ax, ay, az] = f.axes
  const e = 1e-9
  const nx = ax.norm(x), ny = ay.norm(y), nz = az.norm(z)
  return nx >= -e && nx <= 1 + e && ny >= -e && ny <= 1 + e && nz >= -e && nz <= 1 + e
}

function storeHit(s: Series3D, st: Store3D, f: Frame3D, sx: number, sy: number, coverPx: number, color: (i: number) => Color): Hit3D | null {
  const h = pickStore(st, sx, sy, f, coverPx)
  if (!h) return null
  const x = st.x(h.i), y = st.y(h.i), z = st.z(h.i)
  if (!inBox(f, x, y, z)) return null
  const p = st.phys(h.i)
  return {
    series: s, x, y, z,
    value: st.val ? st.val[p] : undefined,
    sx: h.px, sy: h.py, w: h.w, d2: h.d2,
    color: color(p),
  }
}

/** Color of sample at physical slot p for cursor display. */
function sampleColor(st: Store3D, p: number, fill: Fill | null, fallback: Color): Color {
  if (fill instanceof PalettedFill) {
    const prop = fill.lookUpProperty
    const v = prop === 'x' ? st.pos[p * 3] + st.ox : prop === 'y' ? st.pos[p * 3 + 1] + st.oy : prop === 'z' ? st.pos[p * 3 + 2] + st.oz : st.val ? st.val[p] : 0
    return fill.lut.getColor(v)
  }
  if (st.col && st.col[p]) {
    const c = st.col[p]
    return new Color(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255)
  }
  return fill && fill.type !== 'empty' ? fill.getPrimaryColor() : fallback
}

// ------------------------------------------------------------------ point series

export interface PointSeries3DOptions extends Series3DOptions {
  individualPointColorEnabled?: boolean
  individualPointSizeEnabled?: boolean
  individualLookupValuesEnabled?: boolean
}

/** Scatter points in 3D. */
export class PointSeries3D extends Series3D {
  readonly store = new Store3D()
  protected pointStyle: PointStyle3DType

  constructor(chart: Chart3DHost, colorIndex: number, _o: PointSeries3DOptions = {}) {
    super(chart, colorIndex, 'Point Series 3D')
    this.pointStyle = new TriangulatedPoints3D({ shape: 'sphere', size: 8, fillStyle: new SolidFill({ color: this.defaultColor() }) })
  }

  setPointStyle(s: Mutator<PointStyle3DType>) {
    this.pointStyle = resolve(this.pointStyle, s)
    this.chart.onSeriesStyle(this)
    return this
  }
  getPointStyle() { return this.pointStyle }
  /** Append one or more samples {x, y, z, color?, size?, value?}. */
  add(data: Point3DData | Point3DData[]) { this.store.append(data); this.chart.onSeriesData(this); return this }
  appendJSON(data: Point3DData | Point3DData[]) { return this.add(data) }
  appendSample(p: Point3DData) { return this.add(p) }
  appendSamples(o: Parameters<Store3D['appendSamples']>[0]) { this.store.appendSamples(o); this.chart.onSeriesData(this); return this }
  clear() { this.store.clear(); this.chart.onSeriesData(this); return this }
  setMaxSampleCount(n: number) { this.store.setMaxCount(n); this.chart.onSeriesData(this); return this }
  getMaxSampleCount() { return this.store.maxCount }
  getPointCount() { return this.store.n }
  getSampleCount() { return this.store.n }

  bounds() { return this.store.bounds() }
  override propRange(p: LookUpProperty) { return p === 'value' ? this.store.valueRange() : super.propRange(p) }
  primaryColor() {
    const f = this.pointStyle.fillStyle
    return f && f.type !== 'empty' ? f.getPrimaryColor() : this.defaultColor()
  }
  override isTransparent() { return !(this.pointStyle.fillStyle instanceof PalettedFill) && this.primaryColor().a < 250 }
  getLegendSymbol(): LegendSymbol {
    const st = this.pointStyle
    const shape = st.type === 'pixelated'
      ? (st.shape === 'circle' ? 'circle' : st.shape === 'x' ? 'x' : st.shape)
      : st.shape === 'cube' || st.shape === 'box' ? 'square' : st.shape === 'pyramid' || st.shape === 'cone' ? 'triangle' : st.shape === 'diamond' ? 'diamond' : 'circle'
    return { kind: 'point', color: this.primaryColor(), shape }
  }
  override legendLUT() { return lutOf(this.pointStyle.fillStyle) }

  drawGL(r: GLRenderer, f: Frame3D) {
    drawStorePoints(r, f, this.store, this.pointStyle, this.defaultColor(), this.shading, this.clipping, (p) => this.propRange(p))
  }
  override pick(sx: number, sy: number, f: Frame3D): Hit3D | null {
    const cover = Math.max(4, this.pointStyle.size / 2)
    return storeHit(this, this.store, f, sx, sy, cover, (p) => sampleColor(this.store, p, this.pointStyle.fillStyle, this.defaultColor()))
  }
  override disposeGL(r: GLRenderer | null) { this.store.disposeGL(r ? r.gl : null) }
}

// ------------------------------------------------------------------ line series

/** Thick 3D polyline. NaN samples break the line. */
export class LineSeries3D extends Series3D {
  readonly store = new Store3D()
  protected lineStyle: LineStyle

  constructor(chart: Chart3DHost, colorIndex: number, _o: Series3DOptions = {}) {
    super(chart, colorIndex, 'Line Series 3D')
    this.lineStyle = new SolidLine({ thickness: this.theme.lineThickness, fillStyle: new SolidFill({ color: this.defaultColor() }) })
  }

  setLineStyle(l: Mutator<LineStyle>) {
    this.lineStyle = resolve(this.lineStyle, l)
    this.chart.onSeriesStyle(this)
    return this
  }
  getLineStyle() { return this.lineStyle }
  setStrokeStyle(l: Mutator<LineStyle>) { return this.setLineStyle(l) }
  add(data: Point3DData | Point3DData[]) { this.store.append(data); this.chart.onSeriesData(this); return this }
  appendJSON(data: Point3DData | Point3DData[]) { return this.add(data) }
  appendSample(p: Point3DData) { return this.add(p) }
  appendSamples(o: Parameters<Store3D['appendSamples']>[0]) { this.store.appendSamples(o); this.chart.onSeriesData(this); return this }
  clear() { this.store.clear(); this.chart.onSeriesData(this); return this }
  setMaxSampleCount(n: number) { this.store.setMaxCount(n); this.chart.onSeriesData(this); return this }
  getMaxSampleCount() { return this.store.maxCount }
  getPointCount() { return this.store.n }
  getSampleCount() { return this.store.n }

  bounds() { return this.store.bounds() }
  override propRange(p: LookUpProperty) { return p === 'value' ? this.store.valueRange() : super.propRange(p) }
  primaryColor() {
    const f = this.lineStyle.getFillStyle()
    return f.type !== 'empty' ? f.getPrimaryColor() : this.defaultColor()
  }
  override isTransparent() { return !(this.lineStyle.getFillStyle() instanceof PalettedFill) && this.primaryColor().a < 250 }
  getLegendSymbol(): LegendSymbol { return { kind: 'line', color: this.primaryColor() } }
  override legendLUT() { return lutOf(this.lineStyle.getFillStyle()) }

  drawGL(r: GLRenderer, f: Frame3D) {
    drawStoreLine(r, f, this.store, this.lineStyle, this.defaultColor(), this.clipping, (p) => this.propRange(p))
  }
  override pick(sx: number, sy: number, f: Frame3D): Hit3D | null {
    const cover = Math.max(4, this.lineStyle.getThickness())
    return storeHit(this, this.store, f, sx, sy, cover, (p) => sampleColor(this.store, p, this.lineStyle.getFillStyle(), this.defaultColor()))
  }
  override disposeGL(r: GLRenderer | null) { this.store.disposeGL(r ? r.gl : null) }
}

/** Line with point markers at every sample. */
export class PointLineSeries3D extends LineSeries3D {
  protected pointStyle: PointStyle3DType

  constructor(chart: Chart3DHost, colorIndex: number, o: Series3DOptions = {}) {
    super(chart, colorIndex, o)
    this.name = 'Point Line Series 3D'
    this.pointStyle = new TriangulatedPoints3D({ shape: 'sphere', size: 6, fillStyle: new SolidFill({ color: this.defaultColor() }) })
  }
  setPointStyle(s: Mutator<PointStyle3DType>) {
    this.pointStyle = resolve(this.pointStyle, s)
    this.chart.onSeriesStyle(this)
    return this
  }
  getPointStyle() { return this.pointStyle }
  override drawGL(r: GLRenderer, f: Frame3D) {
    super.drawGL(r, f)
    drawStorePoints(r, f, this.store, this.pointStyle, this.defaultColor(), this.shading, this.clipping, (p) => this.propRange(p))
  }
  override pick(sx: number, sy: number, f: Frame3D): Hit3D | null {
    const cover = Math.max(4, this.pointStyle.size / 2, this.lineStyle.getThickness())
    return storeHit(this, this.store, f, sx, sy, cover, (p) => sampleColor(this.store, p, this.pointStyle.fillStyle ?? this.lineStyle.getFillStyle(), this.defaultColor()))
  }
}

