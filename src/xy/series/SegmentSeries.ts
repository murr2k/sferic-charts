import { Color } from '../../core/color'
import { LegendSymbol } from '../../core/Legend'
import { isEmptyLine, LineStyle, Mutator, resolve } from '../../core/style'
import { seriesColor } from '../../core/theme'
import { Rect } from '../../core/util'
import { SegmentBatch, XYMaps } from '../../render/draw'
import { GLRenderer } from '../../render/GLRenderer'
import { Bounds } from '../store'
import { CursorHit, ResultTableRows } from './SeriesXY'
import { Figure, FigureSeries, highlightColor, solidLine } from './RectangleSeries'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export interface SegmentSeriesOptions {
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  [k: string]: unknown
}

export interface SegmentDimensions { startX: number; startY: number; endX: number; endY: number }

export class SegmentFigure extends Figure {
  private d: SegmentDimensions
  private stroke: LineStyle
  constructor(owner: SegmentSeries, d: SegmentDimensions, stroke: LineStyle) {
    super(owner)
    this.d = { ...d }
    this.stroke = stroke
  }
  setDimensions(d: SegmentDimensions) { this.d = { ...d }; this.owner.invalidate(); return this }
  getDimensions(): SegmentDimensions { return { ...this.d } }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.owner.invalidate(); return this }
  getStrokeStyle() { return this.stroke }
  /** @internal */
  extent(b: Bounds) {
    const d = this.d
    b.xmin = Math.min(b.xmin, d.startX, d.endX)
    b.xmax = Math.max(b.xmax, d.startX, d.endX)
    b.ymin = Math.min(b.ymin, d.startY, d.endY)
    b.ymax = Math.max(b.ymax, d.startY, d.endY)
  }
  /** @internal Distance to the stroked capsule. */
  hitDist2(px: number, py: number, ax: Axis, ay: Axis) {
    const d = this.d
    const x0 = ax.valueToPx(d.startX), y0 = ay.valueToPx(d.startY)
    const x1 = ax.valueToPx(d.endX), y1 = ay.valueToPx(d.endY)
    const vx = x1 - x0, vy = y1 - y0
    const ll = vx * vx + vy * vy
    const t = ll > 1e-9 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / ll)) : 0
    const dx = x0 + vx * t - px, dy = y0 + vy * t - py
    const out = Math.max(0, Math.hypot(dx, dy) - this.thickness() / 2)
    return out * out
  }
  /** @internal */
  thickness() { return isEmptyLine(this.stroke) ? 0 : Math.max(1, this.stroke.getThickness()) }
  /** @internal Point on the segment closest to (px, py), in axis values. */
  closest(px: number, py: number, ax: Axis, ay: Axis) {
    const d = this.d
    const x0 = ax.valueToPx(d.startX), y0 = ay.valueToPx(d.startY)
    const x1 = ax.valueToPx(d.endX), y1 = ay.valueToPx(d.endY)
    const vx = x1 - x0, vy = y1 - y0
    const ll = vx * vx + vy * vy
    const t = ll > 1e-9 ? Math.max(0, Math.min(1, ((px - x0) * vx + (py - y0) * vy) / ll)) : 0
    return { x: d.startX + (d.endX - d.startX) * t, y: d.startY + (d.endY - d.startY) * t, px: x0 + vx * t, py: y0 + vy * t }
  }
}

/** Independent line segments in axis coordinates. */
export class SegmentSeries extends FigureSeries<SegmentFigure> {
  /** One GPU batch per distinct stroke thickness. */
  private batches = new Map<number, SegmentBatch>()
  private defStroke: LineStyle

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, _o: SegmentSeriesOptions = {}) {
    super(chart, ax, ay, colorIndex, 'Segment Series')
    this.defStroke = solidLine(seriesColor(chart.getTheme(), colorIndex), chart.getTheme().lineThickness)
  }

  /** Add a segment `{ startX, startY, endX, endY }` (or an array of them). */
  add(d: SegmentDimensions): SegmentFigure
  add(d: SegmentDimensions[]): SegmentFigure[]
  add(d: SegmentDimensions | SegmentDimensions[]): SegmentFigure | SegmentFigure[] {
    if (Array.isArray(d)) return d.map((x) => this.add(x))
    return this.addFigure(new SegmentFigure(this, d, this.defStroke))
  }
  setStrokeStyle(l: Mutator<LineStyle>) {
    this.defStroke = resolve(this.defStroke, l)
    for (const s of this.figs) s.setStrokeStyle(this.defStroke)
    return this
  }
  getStrokeStyle() { return this.defStroke }

  primaryColor(): Color { return this.defStroke.getFillStyle().getPrimaryColor() }
  getLegendSymbol(): LegendSymbol { return { kind: 'line', color: this.primaryColor().setA(255) } }
  protected override pickTolerance() { return 4 }

  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (this.dirty) {
      for (const b of this.batches.values()) b.clear()
      const dark = this.chart.getTheme().isDark
      for (const f of this.figs) {
        if (!f.live()) continue
        const st = f.getStrokeStyle()
        if (isEmptyLine(st)) continue
        const th = f.thickness()
        let b = this.batches.get(th)
        if (!b) this.batches.set(th, (b = new SegmentBatch()))
        const d = f.getDimensions()
        if (!b.n) b.setOrigin(d.startX, d.startY)
        let c = st.getFillStyle().getPrimaryColor()
        if (this.isHot(f)) c = highlightColor(c, dark)
        b.push(d.startX, d.startY, d.endX, d.endY, c)
      }
      this.dirty = false
    }
    for (const [th, b] of this.batches) b.draw(r, maps, th)
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    const h = this.pick(px, py, this.pickTolerance())
    if (!h) return null
    const c = h.f.closest(px, py, this.axisX, this.axisY)
    const color = h.f.getStrokeStyle().getFillStyle().getPrimaryColor()
    return { series: this, x: c.x, y: c.y, px: c.px, py: c.py, color: color.setA(255), dist2: h.d2, extra: { figure: this.figs.indexOf(h.f) } }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) return super.tableRows(hit)
    const f = this.figs[hit.extra?.figure as number]
    if (!f) return []
    const d = f.getDimensions()
    const fx = (v: number) => this.axisX.formatCursor(v)
    const fy = (v: number) => this.axisY.formatCursor(v)
    return [
      [{ text: this.name, color: hit.color }],
      ['Start:', `${fx(d.startX)}, ${fy(d.startY)}`],
      ['End:', `${fx(d.endX)}, ${fy(d.endY)}`],
    ]
  }

  override disposeGL(r: GLRenderer | null) {
    for (const b of this.batches.values()) b.dispose(r)
    this.dirty = true
  }
}
