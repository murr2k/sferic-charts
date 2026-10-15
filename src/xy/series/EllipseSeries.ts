import { Color } from '../../core/color'
import { LegendSymbol } from '../../core/Legend'
import { Fill, isEmptyLine, LineStyle, Mutator, resolve, SolidFill } from '../../core/style'
import { seriesColor } from '../../core/theme'
import { Rect } from '../../core/util'
import { XYMaps } from '../../render/draw'
import { GLRenderer } from '../../render/GLRenderer'
import { Bounds } from '../store'
import { CursorHit, ResultTableRows } from './SeriesXY'
import { Figure, FigureSeries, highlightColor, lineW, ShapeBatch, solidLine } from './RectangleSeries'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export interface EllipseSeriesOptions {
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  [k: string]: unknown
}

export interface EllipseDimensions { x: number; y: number; radiusX: number; radiusY: number }

export class EllipseFigure extends Figure {
  private d: EllipseDimensions
  private fill: Fill
  private stroke: LineStyle
  constructor(owner: EllipseSeries, d: EllipseDimensions, fill: Fill, stroke: LineStyle) {
    super(owner)
    this.d = { ...d }
    this.fill = fill
    this.stroke = stroke
  }
  setDimensions(d: EllipseDimensions) { this.d = { ...d }; this.owner.invalidate(); return this }
  getDimensions(): EllipseDimensions { return { ...this.d } }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.owner.invalidate(); return this }
  getFillStyle() { return this.fill }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.owner.invalidate(); return this }
  getStrokeStyle() { return this.stroke }
  /** @internal */
  extent(b: Bounds) {
    const d = this.d
    const rx = Math.abs(d.radiusX), ry = Math.abs(d.radiusY)
    b.xmin = Math.min(b.xmin, d.x - rx)
    b.xmax = Math.max(b.xmax, d.x + rx)
    b.ymin = Math.min(b.ymin, d.y - ry)
    b.ymax = Math.max(b.ymax, d.y + ry)
  }
  /** @internal */
  hitDist2(px: number, py: number, ax: Axis, ay: Axis) {
    const d = this.d
    const cx = ax.valueToPx(d.x), cy = ay.valueToPx(d.y)
    const rx = Math.abs(ax.valueToPx(d.x + d.radiusX) - cx), ry = Math.abs(ay.valueToPx(d.y + d.radiusY) - cy)
    if (!(rx > 0) || !(ry > 0)) return Infinity
    const u = (px - cx) / rx, v = (py - cy) / ry
    const k = Math.hypot(u, v)
    if (k <= 1) return 0
    const out = (k - 1) * Math.min(rx, ry)
    return out * out
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
    const rx = Math.abs(d.radiusX), ry = Math.abs(d.radiusY)
    batch.push(d.x - rx, d.y - ry, d.x + rx, d.y + ry, fc ? fc.toUint32() : 0, sc ? sc.toUint32() : 0, sc ? lineW(this.stroke) : 0)
  }
}

/** Ellipses in axis coordinates, rendered as SDF quads on the GPU. */
export class EllipseSeries extends FigureSeries<EllipseFigure> {
  private batch = new ShapeBatch()
  private defFill: Fill
  private defStroke: LineStyle

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, _o: EllipseSeriesOptions = {}) {
    super(chart, ax, ay, colorIndex, 'Ellipse Series')
    const c = seriesColor(chart.getTheme(), colorIndex)
    this.defFill = new SolidFill({ color: c.setA(70) })
    this.defStroke = solidLine(c, 2)
  }

  /** Add an ellipse `{ x, y, radiusX, radiusY }` (or an array of them). */
  add(d: EllipseDimensions): EllipseFigure
  add(d: EllipseDimensions[]): EllipseFigure[]
  add(d: EllipseDimensions | EllipseDimensions[]): EllipseFigure | EllipseFigure[] {
    if (Array.isArray(d)) return d.map((x) => this.add(x))
    return this.addFigure(new EllipseFigure(this, d, this.defFill, this.defStroke))
  }
  setFillStyle(f: Mutator<Fill>) {
    this.defFill = resolve(this.defFill, f)
    for (const e of this.figs) e.setFillStyle(this.defFill)
    return this
  }
  setStrokeStyle(l: Mutator<LineStyle>) {
    this.defStroke = resolve(this.defStroke, l)
    for (const e of this.figs) e.setStrokeStyle(this.defStroke)
    return this
  }

  primaryColor(): Color {
    return isEmptyLine(this.defStroke) ? this.defFill.getPrimaryColor() : this.defStroke.getFillStyle().getPrimaryColor()
  }
  getLegendSymbol(): LegendSymbol { return { kind: 'point', shape: 'circle', color: this.primaryColor().setA(255) } }

  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (this.dirty) {
      this.batch.clear()
      const dark = this.chart.getTheme().isDark
      for (const f of this.figs) if (f.live()) f.emitTo(this.batch, this.isHot(f), dark)
      this.dirty = false
    }
    this.batch.draw(r, maps, { shape: 1, x0: maps.x0, x1: maps.x1 })
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    const h = this.pick(px, py)
    if (!h) return null
    const d = h.f.getDimensions()
    const color = isEmptyLine(h.f.getStrokeStyle()) ? h.f.getFillStyle().getPrimaryColor() : h.f.getStrokeStyle().getFillStyle().getPrimaryColor()
    return {
      series: this, x: d.x, y: d.y, px: this.axisX.valueToPx(d.x), py: this.axisY.valueToPx(d.y),
      color: color.setA(255), dist2: 0, extra: { figure: this.figs.indexOf(h.f) },
    }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) return super.tableRows(hit)
    const f = this.figs[hit.extra?.figure as number]
    if (!f) return []
    const d = f.getDimensions()
    return [
      [{ text: this.name, color: hit.color }],
      [(this.axisX.title || 'X') + ':', this.axisX.formatCursor(d.x)],
      [(this.axisY.title || 'Y') + ':', this.axisY.formatCursor(d.y)],
      ['Radius X:', this.axisX.formatCursor(Math.abs(d.radiusX))],
      ['Radius Y:', this.axisY.formatCursor(Math.abs(d.radiusY))],
    ]
  }

  override disposeGL(r: GLRenderer | null) {
    this.batch.dispose(r)
    this.dirty = true
  }
}
