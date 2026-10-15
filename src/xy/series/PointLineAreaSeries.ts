import { Color } from '../../core/color'
import { LegendSymbol, ShapeName } from '../../core/Legend'
import { DashedLine, emptyFill, emptyLine, Fill, isEmptyLine, LineStyle, Mutator, PalettedFill, resolve, SolidFill, SolidLine } from '../../core/style'
import { seriesColor } from '../../core/theme'
import { Rect } from '../../core/util'
import { drawArea, drawLineStrip, drawPoints, XYMaps, PointShapeName } from '../../render/draw'
import { GLRenderer } from '../../render/GLRenderer'
import { Bounds, Channel, XYStore } from '../store'
import { CursorHit, nearestByX, nearestByXY, SeriesXY } from './SeriesXY'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export const PointShape = {
  Circle: 'circle',
  Square: 'square',
  Triangle: 'triangle',
  Diamond: 'diamond',
  Cross: 'cross',
  Plus: 'cross',
  X: 'x',
  Star: 'star',
  Arrow: 'arrow',
} as const

export type CurvePreprocessing =
  | { type: 'none' }
  | { type: 'step'; step?: 'before' | 'middle' | 'after' }
  | { type: 'spline'; resolution?: number }

export const StepOptions = { before: 'before', middle: 'middle', after: 'after' } as const

export interface DataPoint {
  x?: number
  y: number
  color?: Color
  size?: number
  value?: number
  lookupValue?: number
  rotation?: number
  /** Range series. */
  low?: number
  high?: number
}

export interface SampleArrays {
  xValues?: ArrayLike<number>
  yValues?: ArrayLike<number>
  /** For x-less input: x = start + i * step. */
  start?: number
  step?: number
  colors?: ArrayLike<Color | number>
  sizes?: ArrayLike<number>
  lookupValues?: ArrayLike<number>
  rotations?: ArrayLike<number>
  lowValues?: ArrayLike<number>
  offset?: number
  count?: number
}

export type SeriesPreset = 'line' | 'point' | 'pointline' | 'area' | 'arearange' | 'step' | 'spline'

export interface PointLineAreaOptions {
  automaticColorIndex?: number
  axisX?: Axis
  xAxis?: Axis
  axisY?: Axis
  yAxis?: Axis
  baseline?: number
  mode?: 'before' | 'middle' | 'after'
  pointShape?: string
  /** Accepted for API compatibility; data patterns are detected automatically. */
  dataPattern?: unknown
  schema?: unknown
  [k: string]: unknown
}

/**
 * The workhorse XY series: line, scatter, area, area-range, step and spline are
 * presets of this class.
 */
export class PointLineAreaSeries extends SeriesXY {
  readonly data = new XYStore()
  /** Derived geometry for step/spline curves (null = draw `data` directly). */
  private geom: XYStore | null = null
  private curve: CurvePreprocessing = { type: 'none' }
  private stroke: LineStyle
  private pointFill: Fill
  private pointSize: number
  private pointShape: PointShapeName = 'circle'
  private pointStroke: LineStyle = emptyLine
  private areaFill: Fill
  private baseline: number
  private color: Color
  private provisional = 0
  private tail: { x: number; y: number }[] = []
  readonly preset: SeriesPreset
  private cleaning: { minDataPointCount?: number } | null = null

  constructor(chart: ChartXY, axisX: Axis, axisY: Axis, colorIndex: number, preset: SeriesPreset, o: PointLineAreaOptions = {}) {
    super(chart, axisX, axisY, colorIndex, presetName(preset, colorIndex))
    this.preset = preset
    const t = chart.getTheme()
    this.color = seriesColor(t, colorIndex)
    const solid = new SolidFill({ color: this.color })
    this.baseline = o.baseline ?? 0
    const showLine = preset !== 'point'
    const showPoints = preset === 'point' || preset === 'pointline'
    const showArea = preset === 'area' || preset === 'arearange'
    this.stroke = showLine ? new SolidLine({ thickness: t.lineThickness, fillStyle: solid }) : emptyLine
    this.pointFill = showPoints ? solid : emptyFill
    this.pointSize = preset === 'pointline' ? t.pointSize + 1 : t.pointSize
    if (o.pointShape) this.pointShape = String(o.pointShape).toLowerCase() as PointShapeName
    this.areaFill = showArea ? new SolidFill({ color: this.color.setA(t.areaFillAlpha) }) : emptyFill
    if (preset === 'step') this.setCurvePreprocessing({ type: 'step', step: o.mode ?? 'after' })
    if (preset === 'spline') this.setCurvePreprocessing({ type: 'spline' })
    if (preset === 'arearange') this.data.enableChannel('lo')
  }

  // ---------------------------------------------------------------- style API

  setStrokeStyle(s: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, s); this.chart.requestRender(); return this }
  getStrokeStyle() { return this.stroke }
  setPointFillStyle(f: Mutator<Fill>) { this.pointFill = resolve(this.pointFill, f); this.chart.requestRender(); return this }
  getPointFillStyle() { return this.pointFill }
  setPointSize(s: number) { this.pointSize = s; this.chart.requestRender(); return this }
  getPointSize() { return this.pointSize }
  setPointShape(s: string) { this.pointShape = String(s).toLowerCase() as PointShapeName; this.chart.requestRender(); return this }
  getPointShape() { return this.pointShape }
  setPointStrokeStyle(s: Mutator<LineStyle>) { this.pointStroke = resolve(this.pointStroke, s); this.chart.requestRender(); return this }
  setPointRotation(_r: number) { return this }
  setAreaFillStyle(f: Mutator<Fill>) { this.areaFill = resolve(this.areaFill, f); this.chart.requestRender(); return this }
  getAreaFillStyle() { return this.areaFill }
  /** Alias of the area fill setter for area presets. */
  setFillStyle(f: Mutator<Fill>) {
    if (this.preset === 'area' || this.preset === 'arearange') return this.setAreaFillStyle(f)
    if (this.preset === 'point') return this.setPointFillStyle(f)
    return this.setStrokeStyle((l) => (l instanceof SolidLine ? l.setFillStyle(f) : l))
  }
  setHighFillStyle(f: Mutator<Fill>) { return this.setAreaFillStyle(f) }
  setHighStrokeStyle(s: Mutator<LineStyle>) { return this.setStrokeStyle(s) }
  setLowStrokeStyle(_s: Mutator<LineStyle>) { return this }
  setAreaBaseline(b: number) { this.baseline = b; this.chart.requestRender(); return this }
  getBaseline() { return this.baseline }
  setCurvePreprocessing(c: CurvePreprocessing) {
    this.curve = c
    if (c.type === 'none') {
      this.geom?.dispose(null)
      this.geom = null
    } else {
      this.geom = new XYStore()
      this.provisional = 0
      this.tail = []
      // rebuild from existing data
      const pts: { x: number; y: number }[] = []
      this.data.forEach((x, y) => pts.push({ x, y }))
      this.feedGeom(pts)
    }
    this.chart.requestRender()
    return this
  }
  setMaxSampleCount(n: number) {
    this.data.setMaxCount(n)
    if (this.geom) this.geom.setMaxCount(n * this.geomFactor())
    this.chart.requestRender()
    return this
  }
  setMaxPointCount(n: number) { return this.setMaxSampleCount(n) }
  getMaxSampleCount() { return this.data.maxCount }
  setDataCleaning(o: { minDataPointCount?: number } | undefined) { this.cleaning = o ?? null; return this }
  getSampleCount() { return this.data.size() }
  getPointAmount() { return this.data.size() }
  getXMin() { return this.data.bounds().xmin }
  getXMax() { return this.data.bounds().xmax }
  getYMin() { return this.data.bounds().ymin }
  getYMax() { return this.data.bounds().ymax }
  getLastPoint() { return this.data.last() }

  private geomFactor() {
    if (this.curve.type === 'step') return this.curve.step === 'middle' ? 3 : 2
    if (this.curve.type === 'spline') return this.curve.resolution ?? 8
    return 1
  }

  // ---------------------------------------------------------------- data API

  appendSample(p: DataPoint) { return this.appendJSON([p]) }

  appendJSON(points: DataPoint[] | DataPoint, mapping?: { x?: string; y?: string; lookupValue?: string }) {
    const pts = Array.isArray(points) ? points : [points]
    const n = pts.length
    if (!n) return this
    const mx = mapping?.x ?? 'x', my = mapping?.y ?? 'y'
    const p0 = pts[0] as any
    let autoX = this.data.last()?.x ?? -1
    const getX = (i: number) => {
      const v = (pts[i] as any)[mx]
      if (v === undefined) return ++autoX
      return v instanceof Date ? v.getTime() : v
    }
    const hasHigh = p0.high !== undefined
    const getY = (i: number) => (hasHigh ? (pts[i] as any).high : (pts[i] as any)[my])
    const extra: Partial<Record<Channel, (i: number) => number>> = {}
    if (p0.color !== undefined) extra.color = (i) => toU32(pts[i].color)
    if (p0.size !== undefined) extra.size = (i) => pts[i].size ?? 0
    const lk = mapping?.lookupValue ?? (p0.value !== undefined ? 'value' : p0.lookupValue !== undefined ? 'lookupValue' : null)
    if (lk) extra.value = (i) => (pts[i] as any)[lk] ?? 0
    if (p0.rotation !== undefined) extra.rot = (i) => ((pts[i].rotation ?? 0) * Math.PI) / 180
    if (p0.low !== undefined) extra.lo = (i) => pts[i].low ?? NaN
    else if (this.data.channels.has('lo')) extra.lo = () => this.baseline
    this.data.append(n, getX, getY, Object.keys(extra).length ? extra : undefined)
    this.afterAppend(n, getX, getY)
    return this
  }

  /** Alias of `appendJSON`. */
  add(points: DataPoint | DataPoint[]) { return this.appendJSON(points) }

  appendSamples(s: SampleArrays) {
    const off = s.offset ?? 0
    const len = s.count ?? (s.yValues?.length ?? s.xValues?.length ?? 0) - off
    if (len <= 0) return this
    const ys = s.yValues
    const xs = s.xValues
    const last = this.data.last()
    const step = s.step ?? 1
    const start = s.start ?? (last ? last.x + step : 0)
    const getX = xs ? (i: number) => xs[off + i] : (i: number) => start + (i * step)
    const getY = ys ? (i: number) => ys[off + i] : () => 0
    const extra: Partial<Record<Channel, (i: number) => number>> = {}
    if (s.colors) { const c = s.colors; extra.color = (i) => toU32(c[off + i]) }
    if (s.sizes) { const z = s.sizes; extra.size = (i) => z[off + i] }
    if (s.lookupValues) { const v = s.lookupValues; extra.value = (i) => v[off + i] }
    if (s.rotations) { const v = s.rotations; extra.rot = (i) => (v[off + i] * Math.PI) / 180 }
    if (s.lowValues) { const v = s.lowValues; extra.lo = (i) => v[off + i] }
    else if (this.data.channels.has('lo')) extra.lo = () => this.baseline
    this.data.append(len, getX, getY, Object.keys(extra).length ? extra : undefined)
    this.afterAppend(len, getX, getY)
    return this
  }

  /** Area range input: [{ position, high, low }]. */
  addArrayHighLow(points: { position: number; high: number; low: number }[]) {
    return this.appendJSON(points.map((p) => ({ x: p.position, y: p.high, low: p.low })))
  }

  setSamples(s: SampleArrays) { this.clear(); return this.appendSamples(s) }
  setData(points: DataPoint[]) { this.clear(); return this.appendJSON(points) }

  clear() {
    this.data.clear()
    this.geom?.clear()
    this.provisional = 0
    this.tail = []
    this.chart.requestRender()
    return this
  }

  private afterAppend(n: number, getX: (i: number) => number, getY: (i: number) => number) {
    if (this.geom) {
      const pts = new Array(n)
      for (let i = 0; i < n; i++) pts[i] = { x: +getX(i), y: +getY(i) }
      this.feedGeom(pts)
    }
    if (this.cleaning) this.cleanOutOfView()
    this.chart.onSeriesData(this)
  }

  private cleanOutOfView() {
    // Keep memory bounded for scrolling charts: drop points left of the view.
    const min = this.cleaning?.minDataPointCount ?? 0
    if (!this.data.monoX) return
    const x0 = this.axisX.lo
    let drop = 0
    for (let ci = 0; ci < this.data.chunks.length; ci++) {
      const ch = this.data.chunks[ci]
      const s = this.data.pointStart(ci)
      const j = this.data.lower(ch, s, ch.n, x0)
      drop += j - s
      if (j < ch.n) break
    }
    drop = Math.min(drop - 1, this.data.size() - min)
    if (drop > 1024) this.data.dropFront(drop)
  }

  /** Incrementally derive step/spline geometry. */
  private feedGeom(pts: { x: number; y: number }[]) {
    const g = this.geom!
    if (this.curve.type === 'step') {
      const mode = this.curve.step ?? 'after'
      const xs: number[] = [], ys: number[] = []
      let prev = this.tail[this.tail.length - 1]
      for (const p of pts) {
        if (prev) {
          if (mode === 'after') { xs.push(p.x); ys.push(prev.y) }
          else if (mode === 'before') { xs.push(prev.x); ys.push(p.y) }
          else { const xm = (prev.x + p.x) / 2; xs.push(xm, xm); ys.push(prev.y, p.y) }
        }
        xs.push(p.x)
        ys.push(p.y)
        prev = p
      }
      if (prev) this.tail = [prev]
      g.append(xs.length, (i) => xs[i], (i) => ys[i])
      return
    }
    if (this.curve.type === 'spline') {
      const res = Math.max(2, this.curve.resolution ?? 8)
      if (this.provisional) g.truncate(this.provisional)
      this.provisional = 0
      const all = [...this.tail, ...pts]
      const xs: number[] = [], ys: number[] = []
      const startSeg = Math.max(1, this.tail.length >= 2 ? this.tail.length - 1 : this.tail.length)
      if (this.tail.length === 0 && all.length) { xs.push(all[0].x); ys.push(all[0].y) }
      const mono = this.data.monoX
      let provisionalPts = 0
      for (let i = startSeg; i < all.length; i++) {
        const p0 = all[i - 2] ?? all[i - 1], p1 = all[i - 1], p2 = all[i], p3 = all[i + 1] ?? p2
        const isLast = i === all.length - 1
        for (let k = 1; k <= res; k++) {
          const t = k / res
          let x: number, y: number
          if (mono && p2.x > p1.x) {
            const h = p2.x - p1.x
            const m1 = (p2.y - p0.y) / (p2.x - p0.x || h)
            const m2 = (p3.y - p1.y) / (p3.x - p1.x || h)
            const t2 = t * t, t3 = t2 * t
            x = p1.x + h * t
            y = (2 * t3 - 3 * t2 + 1) * p1.y + (t3 - 2 * t2 + t) * h * m1 + (-2 * t3 + 3 * t2) * p2.y + (t3 - t2) * h * m2
          } else {
            const t2 = t * t, t3 = t2 * t
            const cr = (a: number, b: number, c: number, d: number) =>
              0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
            x = cr(p0.x, p1.x, p2.x, p3.x)
            y = cr(p0.y, p1.y, p2.y, p3.y)
          }
          xs.push(x)
          ys.push(y)
          if (isLast) provisionalPts++
        }
      }
      g.append(xs.length, (i) => xs[i], (i) => ys[i])
      this.provisional = provisionalPts
      this.tail = all.slice(-3)
    }
  }

  // ---------------------------------------------------------------- rendering

  primaryColor(): Color {
    const f = !isEmptyLine(this.stroke) ? this.stroke.getFillStyle() : this.pointFill.type !== 'empty' ? this.pointFill : this.areaFill
    return f.getPrimaryColor()
  }

  getLegendSymbol(): LegendSymbol {
    const c = this.primaryColor().setA(255)
    if (this.preset === 'point') return { kind: 'point', color: c, shape: this.pointShape as ShapeName }
    if (this.preset === 'area' || this.preset === 'arearange') return { kind: 'rect', color: c }
    return { kind: 'line', color: c }
  }

  bounds(): Bounds | null {
    if (!this.data.size()) return null
    const b = this.data.bounds()
    if (this.areaFill.type !== 'empty' && !this.data.channels.has('lo')) {
      return { ...b, ymin: Math.min(b.ymin, this.baseline), ymax: Math.max(b.ymax, this.baseline) }
    }
    return b
  }
  override yBoundsInX(x0: number, x1: number): Bounds | null {
    if (!this.data.size()) return null
    return this.data.yBoundsInX(x0, x1)
  }

  drawGL(r: GLRenderer, maps: XYMaps, rect: Rect) {
    const g = this.geom ?? this.data
    if (!g.size()) return
    const hl = this.highlight
    if (this.areaFill.type !== 'empty') {
      drawArea(r, g, maps, { fill: this.areaFill, color: this.areaFill.getPrimaryColor(), baseline: this.baseline, rect })
    }
    if (!isEmptyLine(this.stroke)) {
      const f = this.stroke.getFillStyle()
      const th = this.stroke.getThickness()
      drawLineStrip(r, g, maps, {
        thickness: hl ? (th < 0 ? 2 : th + 1.5) : th,
        color: f instanceof PalettedFill ? new Color(255, 255, 255) : f.getPrimaryColor(),
        fill: f,
        dashed: this.stroke instanceof DashedLine ? this.stroke : undefined,
      })
    }
    if (this.pointFill.type !== 'empty' && this.pointSize > 0) {
      const ps = this.pointStroke
      drawPoints(r, this.data, maps, {
        size: this.pointSize + (hl ? 2 : 0),
        shape: this.pointShape,
        color: this.pointFill instanceof PalettedFill ? new Color(255, 255, 255) : this.pointFill.getPrimaryColor(),
        fill: this.pointFill,
        strokeWidth: isEmptyLine(ps) ? 0 : ps.getThickness(),
        strokeColor: isEmptyLine(ps) ? undefined : ps.getFillStyle().getPrimaryColor(),
      })
    }
  }

  nearest(px: number, py: number, byX: boolean): CursorHit | null {
    const d = this.data
    if (!d.size() || !this.visible) return null
    const ax = this.axisX, ay = this.axisY
    let hit: { ch: import('../store').Chunk; j: number } | null
    if (d.monoX && (byX || this.preset !== 'point')) {
      hit = nearestByX(d, ax.pxToValue(px))
    } else {
      hit = nearestByXY(d, px, py, (x) => ax.valueToPx(x), (y) => ay.valueToPx(y))
    }
    if (!hit) return null
    const { ch, j } = hit
    const x = ch.x(j), y = ch.y(j)
    const hpx = ax.valueToPx(x), hpy = ay.valueToPx(y)
    const dx = hpx - px, dy = Number.isFinite(py) ? hpy - py : 0
    let color = this.primaryColor()
    if (ch.color) color = fromU32(ch.color[j])
    const fill = this.pointFill instanceof PalettedFill ? this.pointFill : this.stroke.getFillStyle() instanceof PalettedFill ? (this.stroke.getFillStyle() as PalettedFill) : null
    let extra: Record<string, number | string> | undefined
    if (fill) {
      const v = fill.lookUpProperty === 'x' ? x : fill.lookUpProperty === 'y' ? y : ch.value ? ch.value[j] : y
      color = fill.lut.getColor(v)
      if (fill.lookUpProperty === 'value' && ch.value) extra = { Value: ch.value[j] }
    }
    if (ch.lo) extra = { ...(extra ?? {}), Low: ch.lo[j] + ch.oy }
    if (ch.size && this.preset === 'point') extra = { ...(extra ?? {}), Size: ch.size[j] }
    return { series: this, x, y, px: hpx, py: hpy, color: color.setA(255), dist2: dx * dx + dy * dy, extra }
  }

  override prepareGL(r: GLRenderer) {
    if (!this.visible) return
    this.data.syncAll(r)
    this.geom?.syncAll(r)
  }

  override disposeGL(r: GLRenderer | null) {
    this.data.dispose(r)
    this.geom?.dispose(r)
  }
}

function presetName(p: SeriesPreset, i: number) {
  const base = { line: 'Line', point: 'Point', pointline: 'Point Line', area: 'Area', arearange: 'Area Range', step: 'Step', spline: 'Spline' }[p]
  return `${base} ${i + 1}`
}

export function toU32(c: Color | number | undefined): number {
  if (c === undefined) return 0xffffffff
  if (typeof c === 'number') return c >>> 0
  return c.toUint32()
}
export function fromU32(u: number): Color {
  return new Color(u & 255, (u >>> 8) & 255, (u >>> 16) & 255, (u >>> 24) & 255)
}
