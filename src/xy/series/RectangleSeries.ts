import { Color } from '../../core/color'
import { LegendSymbol } from '../../core/Legend'
import { emptyLine, Fill, isEmptyLine, LineStyle, Mutator, resolve, SolidFill, SolidLine } from '../../core/style'
import { seriesColor } from '../../core/theme'
import { Emitter, Rect } from '../../core/util'
import { XYMaps } from '../../render/draw'
import { AxisMap, GLRenderer, makeXform } from '../../render/GLRenderer'
import { ATTR, FS_HEAD, VS_HEAD } from '../../render/shaders'
import { Bounds, emptyBounds } from '../store'
import { CursorHit, ResultTableRows, SeriesXY } from './SeriesXY'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

// ------------------------------------------------------------------ GPU shape batch

/**
 * Instanced rect / ellipse renderer with per-instance fill, stroke color and
 * stroke width. Instances can also be anchored at a center X with a width that
 * comes from a uniform (data units or px), so OHLC figures and box whiskers
 * re-scale without rebuilding.
 *
 * Per-instance modes (`mode`):
 *  0  data rect [x0, y0, x1, y1]; `param` = minimum height in px
 *  1  centered on x0, full figure width, y0..y1; `param` = minimum height in px
 *  2  left half of the figure width (OHLC open tick)
 *  3  right half of the figure width (OHLC close tick)
 *  4  centered on x0 with a fixed width of `param` px (wicks, whiskers)
 */
const SHAPE_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_rect;
layout(location = 3) in vec4 a_fill;
layout(location = 4) in vec4 a_stroke;
layout(location = 5) in float a_mode;
layout(location = 6) in float a_param;
layout(location = 8) in float a_sw;
uniform vec2 u_figW;
uniform vec2 u_minPx;
uniform float u_dpr;
out vec2 v_px;
flat out vec4 v_box;
flat out vec4 v_fill;
flat out vec4 v_stroke;
flat out float v_sw;
void main() {
  int mode = int(a_mode + 0.5);
  vec2 a, b;
  float minH = max(u_minPx.y, a_param * u_dpr);
  if (mode == 0) {
    a = toPx(a_rect.xy);
    b = toPx(a_rect.zw);
  } else {
    vec2 c0 = toPx(a_rect.xy);
    vec2 c1 = toPx(a_rect.xw);
    float hw;
    if (mode == 4) {
      float w = max(1.0, floor(a_param * u_dpr + 0.5));
      hw = w * 0.5;
      c0.x = floor(c0.x) + (mod(w, 2.0) > 0.5 ? 0.5 : 0.0);
      minH = u_minPx.y;
    } else if (u_figW.x > 0.0) {
      hw = abs(toPx(vec2(a_rect.x + u_figW.x * 0.5, a_rect.y)).x - c0.x);
    } else {
      hw = u_figW.y * 0.5;
    }
    a = vec2(c0.x + (mode == 3 ? 0.0 : -hw), c0.y);
    b = vec2(c0.x + (mode == 2 ? 0.0 : hw), c1.y);
  }
  if (bad(a.x) || bad(a.y) || bad(b.x) || bad(b.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 mn = min(a, b), mx = max(a, b);
  vec2 c = (mn + mx) * 0.5;
  vec2 hs = max((mx - mn) * 0.5, vec2(u_minPx.x, minH) * 0.5);
  mn = clamp(c - hs, vec2(-1e6), vec2(1e6));
  mx = clamp(c + hs, vec2(-1e6), vec2(1e6));
  vec2 px = mix(mn - 1.0, mx + 1.0, a_corner);
  v_px = px;
  v_box = vec4(mn, mx);
  v_fill = a_fill;
  v_stroke = a_stroke;
  v_sw = a_sw * u_dpr;
  gl_Position = pxToClip(px);
}
`

const SHAPE_FS = FS_HEAD + /* glsl */ `
in vec2 v_px;
flat in vec4 v_box;
flat in vec4 v_fill;
flat in vec4 v_stroke;
flat in float v_sw;
uniform int u_shape;
uniform float u_radius;
void main() {
  vec2 c = (v_box.xy + v_box.zw) * 0.5;
  vec2 hs = (v_box.zw - v_box.xy) * 0.5;
  vec2 p = v_px - c;
  float d;
  if (u_shape == 1) {
    vec2 r = max(hs, vec2(0.5));
    float k0 = length(p / r);
    float k1 = length(p / (r * r));
    d = k1 > 1e-6 ? k0 * (k0 - 1.0) / k1 : -min(r.x, r.y);
  } else {
    float rr = min(u_radius, min(hs.x, hs.y));
    vec2 q = abs(p) - hs + rr;
    d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - rr;
  }
  float cov = clamp(0.5 - d, 0.0, 1.0);
  if (cov <= 0.003) discard;
  vec4 f = vec4(v_fill.rgb * v_fill.a, v_fill.a);
  if (v_sw > 0.0) {
    vec4 s = vec4(v_stroke.rgb * v_stroke.a, v_stroke.a);
    f = mix(f, s, clamp(d + v_sw + 0.5, 0.0, 1.0));
  }
  f *= cov;
  if (f.a <= 0.002) discard;
  emit(vec4(f.rgb / f.a, f.a));
}
`

const STRIDE = 9 // floats per instance
const BYTES = STRIDE * 4

interface ShapeChunk {
  n: number
  ox: number
  oy: number
  f32: Float32Array
  u32: Uint32Array
  xmin: number
  xmax: number
  buf: WebGLBuffer | null
  gpuCap: number
  dirtyFrom: number
}

export interface ShapeDrawOptions {
  /** 0 rect, 1 ellipse. */
  shape?: 0 | 1
  /** Visible X range for chunk culling (absolute data units) and extra margin. */
  x0?: number
  x1?: number
  margin?: number
  /** Figure width for modes 1-3: data units (preferred when > 0) or CSS px. */
  figWidth?: number
  figWidthPx?: number
  /** Minimum rendered size in CSS px. */
  minPx?: [number, number]
  /** Corner radius in CSS px (rects). */
  radius?: number
}

/** Chunked instance batch; each chunk has its own float64 origin so epoch-ms X stays precise. */
export class ShapeBatch {
  private chunks: ShapeChunk[] = []
  private used = 0
  constructor(readonly chunkSize = 16384) {}

  get count() {
    let n = 0
    for (let i = 0; i < this.used; i++) n += this.chunks[i].n
    return n
  }
  clear() {
    for (const c of this.chunks) {
      c.n = 0
      c.xmin = Infinity
      c.xmax = -Infinity
      c.dirtyFrom = 0
    }
    this.used = 0
  }

  push(x0: number, y0: number, x1: number, y1: number, fill: number, stroke = 0, sw = 0, mode = 0, param = 0) {
    let ch = this.used ? this.chunks[this.used - 1] : null
    if (!ch || ch.n >= this.chunkSize) {
      ch = this.chunks[this.used]
      if (!ch) {
        ch = { n: 0, ox: 0, oy: 0, f32: new Float32Array(0), u32: new Uint32Array(0), xmin: Infinity, xmax: -Infinity, buf: null, gpuCap: 0, dirtyFrom: 0 }
        this.chunks.push(ch)
      }
      ch.n = 0
      ch.xmin = Infinity
      ch.xmax = -Infinity
      ch.dirtyFrom = 0
      this.used++
    }
    if (ch.n === 0) {
      ch.ox = Number.isFinite(x0) ? x0 : 0
      ch.oy = Number.isFinite(y0) ? y0 : 0
    }
    if ((ch.n + 1) * STRIDE > ch.f32.length) {
      const cap = Math.min(this.chunkSize, Math.max(64, ch.f32.length / STRIDE * 2))
      const ab = new ArrayBuffer(cap * BYTES)
      const f = new Float32Array(ab)
      f.set(ch.f32.subarray(0, ch.n * STRIDE))
      ch.f32 = f
      ch.u32 = new Uint32Array(ab)
    }
    const k = ch.n * STRIDE
    const f = ch.f32
    f[k] = x0 - ch.ox
    f[k + 1] = y0 - ch.oy
    f[k + 2] = x1 - ch.ox
    f[k + 3] = y1 - ch.oy
    ch.u32[k + 4] = fill >>> 0
    ch.u32[k + 5] = stroke >>> 0
    f[k + 6] = sw
    f[k + 7] = mode
    f[k + 8] = param
    if (ch.dirtyFrom > ch.n) ch.dirtyFrom = ch.n
    ch.n++
    const lo = x0 < x1 ? x0 : x1, hi = x0 < x1 ? x1 : x0
    if (lo < ch.xmin) ch.xmin = lo
    if (hi > ch.xmax) ch.xmax = hi
  }

  draw(r: GLRenderer, maps: { mx: AxisMap; my: AxisMap }, o: ShapeDrawOptions = {}) {
    if (!this.used) return
    const gl = r.gl
    const prog = r.program('sferic-shape', SHAPE_VS, SHAPE_FS)
    const m = o.margin ?? 0
    const vx0 = (o.x0 ?? -Infinity) - m, vx1 = (o.x1 ?? Infinity) + m
    let first = true
    for (let i = 0; i < this.used; i++) {
      const ch = this.chunks[i]
      if (!ch.n || ch.xmax < vx0 || ch.xmin > vx1) continue
      if (!ch.buf) ch.buf = gl.createBuffer()!
      if (ch.dirtyFrom < ch.n) {
        gl.bindBuffer(gl.ARRAY_BUFFER, ch.buf)
        const cap = ch.f32.length / STRIDE
        if (ch.gpuCap < cap) {
          ch.gpuCap = cap
          gl.bufferData(gl.ARRAY_BUFFER, cap * BYTES, gl.DYNAMIC_DRAW)
          ch.dirtyFrom = 0
        }
        gl.bufferSubData(gl.ARRAY_BUFFER, ch.dirtyFrom * BYTES, ch.f32, ch.dirtyFrom * STRIDE, (ch.n - ch.dirtyFrom) * STRIDE)
        ch.dirtyFrom = ch.n
      }
      r.useXform(prog, makeXform(maps.mx, maps.my, ch.ox, ch.oy, r.dpr))
      if (first) {
        first = false
        gl.uniform2f(prog.u.u_figW, o.figWidth ?? 0, (o.figWidthPx ?? 0) * r.dpr)
        const mp = o.minPx ?? [0, 0]
        gl.uniform2f(prog.u.u_minPx, mp[0] * r.dpr, mp[1] * r.dpr)
        gl.uniform1f(prog.u.u_dpr, r.dpr)
        gl.uniform1i(prog.u.u_shape, o.shape ?? 0)
        gl.uniform1f(prog.u.u_radius, (o.radius ?? 0) * r.dpr)
        r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.c0, ATTR.c1, ATTR.v0, ATTR.v1, ATTR.size])
        r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
      }
      r.attrib(ATTR.p0, ch.buf, 4, gl.FLOAT, false, BYTES, 0, 1)
      r.attrib(ATTR.c0, ch.buf, 4, gl.UNSIGNED_BYTE, true, BYTES, 16, 1)
      r.attrib(ATTR.c1, ch.buf, 4, gl.UNSIGNED_BYTE, true, BYTES, 20, 1)
      r.attrib(ATTR.size, ch.buf, 1, gl.FLOAT, false, BYTES, 24, 1)
      r.attrib(ATTR.v0, ch.buf, 1, gl.FLOAT, false, BYTES, 28, 1)
      r.attrib(ATTR.v1, ch.buf, 1, gl.FLOAT, false, BYTES, 32, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, ch.n)
    }
  }

  dispose(r: GLRenderer | null) {
    for (const c of this.chunks) {
      if (r && c.buf) r.gl.deleteBuffer(c.buf)
      c.buf = null
      c.gpuCap = 0
      c.dirtyFrom = 0
    }
  }
}

// ------------------------------------------------------------------ helpers

/** Packed RGBA of a fill (primary color), 0 when empty. */
export const fillU32 = (f: Fill) => (f.type === 'empty' ? 0 : f.getPrimaryColor().toUint32())
/** Packed RGBA of a line style, 0 when empty. */
export const lineU32 = (l: LineStyle) => (isEmptyLine(l) ? 0 : l.getFillStyle().getPrimaryColor().toUint32())
export const lineW = (l: LineStyle) => (isEmptyLine(l) ? 0 : Math.max(1, l.getThickness()))
/** Lighten for hover highlight (darken on light themes is not needed: alpha up + lift). */
export const highlightColor = (c: Color, dark: boolean) =>
  dark ? c.mix(new Color(255, 255, 255, Math.max(c.a, 230)), 0.3) : c.mix(new Color(255, 255, 255, Math.max(c.a, 230)), 0.25)
export const solidLine = (c: Color, thickness = 1) => new SolidLine({ thickness, fillStyle: new SolidFill({ color: c }) })

/** Map a native pointer event to surface CSS px. */
export function localPoint(chart: ChartXY, e: { clientX: number; clientY: number }) {
  const b = chart.surface.canvas.getBoundingClientRect()
  return { x: e.clientX - b.left, y: e.clientY - b.top }
}

// ------------------------------------------------------------------ figures

/** Shared figure behaviour: visibility, interactions, highlight, events, disposal. */
export abstract class Figure extends Emitter {
  protected visible = true
  protected interactive = true
  protected disposed = false
  protected highlight = 0
  constructor(protected readonly owner: FigureSeries<any>) { super() }
  setVisible(v: boolean) { this.visible = v; this.owner.invalidate(); return this }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  setMouseInteractions(v: boolean) { this.interactive = v; return this }
  getMouseInteractions() { return this.interactive }
  setPointerEvents(v: boolean) { return this.setMouseInteractions(v) }
  setHighlight(v: boolean | number) { this.highlight = typeof v === 'number' ? v : v ? 1 : 0; this.owner.invalidate(); return this }
  getHighlight() { return this.highlight }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.owner.removeFigure(this)
    return this
  }
  isDisposed() { return this.disposed }
  restore() {
    if (!this.disposed) return this
    this.disposed = false
    this.owner.restoreFigure(this)
    return this
  }
  getSeries() { return this.owner }
  onMouseEnter(fn: (f: this, e: PointerEvent) => void) { return this.addEventListener('pointerenter', (e) => fn(this, e)) }
  onMouseLeave(fn: (f: this, e: PointerEvent) => void) { return this.addEventListener('pointerleave', (e) => fn(this, e)) }
  onMouseClick(fn: (f: this, e: PointerEvent) => void) { return this.addEventListener('click', (e) => fn(this, e)) }
  onMouseDown(fn: (f: this, e: PointerEvent) => void) { return this.addEventListener('pointerdown', (e) => fn(this, e)) }
  /** @internal */
  fire(type: string, e: unknown) { this.emit(type, e, this) }
  /** @internal */
  live() { return this.visible && !this.disposed }
  /** @internal */
  pickable() { return this.live() && this.interactive }
  /** @internal Data extent. */
  abstract extent(b: Bounds): void
  /** @internal Squared px distance from (px, py); 0 inside; Infinity when not near. */
  abstract hitDist2(px: number, py: number, ax: Axis, ay: Axis): number
}

/** Base for series made of independent figures (rectangles, ellipses, boxes, segments). */
export abstract class FigureSeries<F extends Figure> extends SeriesXY {
  protected figs: F[] = []
  protected dirty = true
  private bcache: Bounds | null = null
  protected styler: ((f: F) => unknown) | null = null
  protected hover: F | null = null
  protected highlightOnHover = true
  private offs: (() => void)[] = []

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, name: string) {
    super(chart, ax, ay, colorIndex, name)
    const sb = chart.seriesBackground
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'click', 'dblclick', 'pointerleave']) {
      const h = (e: PointerEvent) => this.onPlotPointer(type, e)
      sb.addEventListener(type, h)
      this.offs.push(() => sb.removeEventListener(type, h))
    }
  }

  /** @internal Geometry or style changed. */
  invalidate() {
    this.dirty = true
    this.bcache = null
    this.chart.onSeriesData(this)
  }
  /** @internal */
  removeFigure(f: F) {
    const i = this.figs.indexOf(f)
    if (i >= 0) this.figs.splice(i, 1)
    if (this.hover === f) this.hover = null
    this.invalidate()
  }
  /** @internal */
  restoreFigure(f: F) {
    if (!this.figs.includes(f)) this.figs.push(f)
    this.invalidate()
  }
  protected addFigure(f: F): F {
    this.figs.push(f)
    if (this.styler) this.styler(f)
    this.invalidate()
    return f
  }

  /** Style applied to every figure, existing and future. */
  setDefaultStyle(styler: (figure: F) => unknown) {
    this.styler = styler
    for (const f of this.figs) styler(f)
    this.invalidate()
    return this
  }
  override setHighlightOnHover(v: boolean) { this.highlightOnHover = v; this.invalidate(); return this }
  setMouseInteractions(v: boolean) { this.cursorEnabled = v; return this }
  getFigures(): F[] { return [...this.figs] }
  getFigureCount() { return this.figs.length }
  clear() {
    this.figs = []
    this.hover = null
    this.invalidate()
    return this
  }

  bounds(): Bounds | null {
    if (!this.bcache) {
      const b = emptyBounds()
      for (const f of this.figs) if (f.live()) f.extent(b)
      this.bcache = b
    }
    const b = this.bcache
    return b.xmin <= b.xmax && b.ymin <= b.ymax ? b : null
  }

  /** Topmost pickable figure under / near the pointer. */
  protected pick(px: number, py: number, tol = 0): { f: F; d2: number } | null {
    let best: F | null = null
    let bd = tol * tol
    for (let i = this.figs.length - 1; i >= 0; i--) {
      const f = this.figs[i]
      if (!f.pickable()) continue
      const d = f.hitDist2(px, py, this.axisX, this.axisY)
      if (d === 0) return { f, d2: 0 }
      if (d <= bd) {
        bd = d
        best = f
      }
    }
    return best ? { f: best, d2: bd } : null
  }

  private onPlotPointer(type: string, e: PointerEvent) {
    if (!this.visible || this.disposed || !this.cursorEnabled) return
    const p = localPoint(this.chart, e)
    const hit = type === 'pointerleave' ? null : this.pick(p.x, p.y, this.pickTolerance())
    const f = hit?.f ?? null
    if (f !== this.hover) {
      const prev = this.hover
      this.hover = f
      if (prev) { prev.fire('pointerleave', e); this.emit('pointerleave', e, prev) }
      if (f) { f.fire('pointerenter', e); this.emit('pointerenter', e, f) }
      if (this.highlightOnHover) this.invalidate()
    }
    if (f && type !== 'pointerleave') {
      f.fire(type, e)
      this.emit(type, e, f)
    }
  }
  /** Pointer tolerance (px) for picking. */
  protected pickTolerance() { return 0 }
  /** True when a figure should render highlighted. */
  protected isHot(f: F) { return f.getHighlight() > 0 || (this.highlightOnHover && this.hover === f) }

  override dispose() {
    this.offs.forEach((o) => o())
    this.offs = []
    return super.dispose()
  }
}

// ------------------------------------------------------------------ rectangles

export interface RectanglePosition { x1: number; y1: number; x2: number; y2: number }
export interface RectangleSize { x: number; y: number; width: number; height: number }
export type RectangleDimensions = RectanglePosition | RectangleSize

const twoPoints = (d: RectangleDimensions): RectanglePosition =>
  'x1' in d ? { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 } : { x1: d.x, y1: d.y, x2: d.x + d.width, y2: d.y + d.height }

export interface RectangleSeriesOptions {
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  [k: string]: unknown
}

export class RectangleFigure extends Figure {
  private d: RectanglePosition
  private fill: Fill
  private stroke: LineStyle
  constructor(owner: RectangleSeries, d: RectangleDimensions, fill: Fill, stroke: LineStyle) {
    super(owner)
    this.d = twoPoints(d)
    this.fill = fill
    this.stroke = stroke
  }
  setDimensions(d: RectangleDimensions) { this.d = twoPoints(d); this.owner.invalidate(); return this }
  getDimensionsTwoPoints(): RectanglePosition { return { ...this.d } }
  getDimensionsPositionAndSize(): RectangleSize {
    const d = this.d
    return { x: Math.min(d.x1, d.x2), y: Math.min(d.y1, d.y2), width: Math.abs(d.x2 - d.x1), height: Math.abs(d.y2 - d.y1) }
  }
  getDimensions() { return this.getDimensionsTwoPoints() }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.owner.invalidate(); return this }
  getFillStyle() { return this.fill }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.owner.invalidate(); return this }
  getStrokeStyle() { return this.stroke }
  /** @internal */
  extent(b: Bounds) {
    const d = this.d
    b.xmin = Math.min(b.xmin, d.x1, d.x2)
    b.xmax = Math.max(b.xmax, d.x1, d.x2)
    b.ymin = Math.min(b.ymin, d.y1, d.y2)
    b.ymax = Math.max(b.ymax, d.y1, d.y2)
  }
  /** @internal */
  hitDist2(px: number, py: number, ax: Axis, ay: Axis) {
    const d = this.d
    const a = ax.valueToPx(d.x1), b = ax.valueToPx(d.x2)
    const c = ay.valueToPx(d.y1), e = ay.valueToPx(d.y2)
    const dx = Math.max(Math.min(a, b) - px, 0, px - Math.max(a, b))
    const dy = Math.max(Math.min(c, e) - py, 0, py - Math.max(c, e))
    return dx * dx + dy * dy
  }
  /** @internal */
  emitTo(batch: ShapeBatch, hot: boolean, dark: boolean) {
    const d = this.d
    let fc = this.fill.type === 'empty' ? null : this.fill.getPrimaryColor()
    let sc = isEmptyLine(this.stroke) ? null : this.stroke.getFillStyle().getPrimaryColor()
    if (hot) {
      if (fc) fc = highlightColor(fc, dark)
      if (sc) sc = highlightColor(sc, dark)
    }
    batch.push(d.x1, d.y1, d.x2, d.y2, fc ? fc.toUint32() : 0, sc ? sc.toUint32() : 0, sc ? lineW(this.stroke) : 0)
  }
}

/** Free-form rectangles in axis coordinates. */
export class RectangleSeries extends FigureSeries<RectangleFigure> {
  private batch = new ShapeBatch()
  private defFill: Fill
  private defStroke: LineStyle = emptyLine
  private radius = 0

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, _o: RectangleSeriesOptions = {}) {
    super(chart, ax, ay, colorIndex, 'Rectangle Series')
    this.defFill = new SolidFill({ color: seriesColor(chart.getTheme(), colorIndex) })
    this.effect = false
  }

  /** Add one rectangle: `{x1, y1, x2, y2}` or `{x, y, width, height}`. */
  add(d: RectangleDimensions): RectangleFigure
  add(d: RectangleDimensions[]): RectangleFigure[]
  add(d: RectangleDimensions | RectangleDimensions[]): RectangleFigure | RectangleFigure[] {
    if (Array.isArray(d)) return d.map((x) => this.add(x))
    return this.addFigure(new RectangleFigure(this, d, this.defFill, this.defStroke))
  }
  /** Series-wide default fill for new figures (also restyles existing ones). */
  setFillStyle(f: Mutator<Fill>) {
    this.defFill = resolve(this.defFill, f)
    for (const r of this.figs) r.setFillStyle(this.defFill)
    return this
  }
  setStrokeStyle(l: Mutator<LineStyle>) {
    this.defStroke = resolve(this.defStroke, l)
    for (const r of this.figs) r.setStrokeStyle(this.defStroke)
    return this
  }
  setCornerRadius(px: number) { this.radius = px; this.chart.requestRender(); return this }

  /** First figure's fill (figures are often styled individually), else the series default. */
  primaryColor(): Color {
    const f = this.figs.find((x) => x.live() && x.getFillStyle().type !== 'empty')
    return (f ? f.getFillStyle() : this.defFill).getPrimaryColor()
  }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor().setA(255) } }

  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (this.dirty) {
      this.batch.clear()
      const dark = this.chart.getTheme().isDark
      for (const f of this.figs) if (f.live()) f.emitTo(this.batch, this.isHot(f), dark)
      this.dirty = false
    }
    this.batch.draw(r, maps, { shape: 0, x0: maps.x0, x1: maps.x1, radius: this.radius })
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    const h = this.pick(px, py)
    if (!h) return null
    const d = h.f.getDimensionsTwoPoints()
    const x = (d.x1 + d.x2) / 2
    const y = Math.max(d.y1, d.y2)
    const r = this.chart.seriesRect(this)
    const hpx = this.axisX.valueToPx(x)
    const hpy = Math.min(Math.max(this.axisY.valueToPx(y), r.y), r.y + r.h)
    const color = h.f.getFillStyle().type !== 'empty' ? h.f.getFillStyle().getPrimaryColor() : this.primaryColor()
    return { series: this, x, y, px: hpx, py: hpy, color: color.setA(255), dist2: 0, extra: { figure: this.figs.indexOf(h.f) } }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) return super.tableRows(hit)
    const f = this.figs[hit.extra?.figure as number]
    if (!f) return []
    const d = f.getDimensionsTwoPoints()
    const fx = (v: number) => this.axisX.formatCursor(v)
    const fy = (v: number) => this.axisY.formatCursor(v)
    return [
      [{ text: this.name, color: hit.color }],
      [(this.axisX.title || 'X') + ':', `${fx(Math.min(d.x1, d.x2))} .. ${fx(Math.max(d.x1, d.x2))}`],
      [(this.axisY.title || 'Y') + ':', `${fy(Math.min(d.y1, d.y2))} .. ${fy(Math.max(d.y1, d.y2))}`],
    ]
  }

  override disposeGL(r: GLRenderer | null) {
    this.batch.dispose(r)
    this.dirty = true
  }
}
