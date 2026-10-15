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

export interface BoxSeriesOptions {
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  [k: string]: unknown
}

interface BoxValues { lowerExtreme: number; lowerQuartile: number; median: number; upperQuartile: number; upperExtreme: number }
/** Box bounded by `start` / `end` on X. */
export interface BoxDataBounded extends BoxValues { start: number; end: number }
/** Box centered at `x` with optional `width` (default 1). */
export interface BoxDataCentered extends BoxValues { x: number; width?: number }
export type BoxData = BoxDataBounded | BoxDataCentered

const bounded = (d: BoxData): BoxDataBounded => {
  if ('start' in d) return { ...d }
  const w = d.width ?? 1
  const { x: _x, width: _w, ...v } = d
  return { ...v, start: d.x - w / 2, end: d.x + w / 2 }
}

export class BoxFigure extends Figure {
  private d: BoxDataBounded
  private bodyFill: Fill
  private bodyStroke: LineStyle
  private stroke: LineStyle
  private medianStroke: LineStyle
  private bodyWidth = 0.8
  private tailWidth = 0.5

  constructor(owner: BoxSeries, d: BoxData, s: { bodyFill: Fill; bodyStroke: LineStyle; stroke: LineStyle; median: LineStyle }) {
    super(owner)
    this.d = bounded(d)
    this.bodyFill = s.bodyFill
    this.bodyStroke = s.bodyStroke
    this.stroke = s.stroke
    this.medianStroke = s.median
  }
  setDimensions(d: BoxData) { this.d = bounded(d); this.owner.invalidate(); return this }
  getDimensions(): BoxDataBounded { return { ...this.d } }
  setBodyFillStyle(f: Mutator<Fill>) { this.bodyFill = resolve(this.bodyFill, f); this.owner.invalidate(); return this }
  getBodyFillStyle() { return this.bodyFill }
  setBodyStrokeStyle(l: Mutator<LineStyle>) { this.bodyStroke = resolve(this.bodyStroke, l); this.owner.invalidate(); return this }
  getBodyStrokeStyle() { return this.bodyStroke }
  /** Whiskers and tails. */
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.owner.invalidate(); return this }
  getStrokeStyle() { return this.stroke }
  setMedianStrokeStyle(l: Mutator<LineStyle>) { this.medianStroke = resolve(this.medianStroke, l); this.owner.invalidate(); return this }
  getMedianStrokeStyle() { return this.medianStroke }
  /** Body width as a fraction (0..1) of the box interval. */
  setBodyWidth(w: number) { this.bodyWidth = w; this.owner.invalidate(); return this }
  getBodyWidth() { return this.bodyWidth }
  /** Tail (whisker cap) width as a fraction (0..1) of the box interval. */
  setTailWidth(w: number) { this.tailWidth = w; this.owner.invalidate(); return this }
  getTailWidth() { return this.tailWidth }

  /** @internal */
  extent(b: Bounds) {
    const d = this.d
    b.xmin = Math.min(b.xmin, d.start, d.end)
    b.xmax = Math.max(b.xmax, d.start, d.end)
    b.ymin = Math.min(b.ymin, d.lowerExtreme, d.lowerQuartile, d.median)
    b.ymax = Math.max(b.ymax, d.upperExtreme, d.upperQuartile, d.median)
  }
  /** @internal Inside the box slot horizontally; vertical distance outside the whiskers. */
  hitDist2(px: number, py: number, ax: Axis, ay: Axis) {
    const d = this.d
    const a = ax.valueToPx(d.start), b = ax.valueToPx(d.end)
    if (px < Math.min(a, b) || px > Math.max(a, b)) return Infinity
    const c = ay.valueToPx(Math.min(d.lowerExtreme, d.upperExtreme)), e = ay.valueToPx(Math.max(d.lowerExtreme, d.upperExtreme))
    const dy = Math.max(Math.min(c, e) - py, 0, py - Math.max(c, e))
    return dy * dy
  }
  /** @internal */
  emitTo(batch: ShapeBatch, hot: boolean, dark: boolean) {
    const d = this.d
    const cx = (d.start + d.end) / 2
    const span = d.end - d.start
    const hl = (c: Color) => (hot ? highlightColor(c, dark) : c)
    const sc = isEmptyLine(this.stroke) ? null : hl(this.stroke.getFillStyle().getPrimaryColor()).toUint32()
    const sw = lineW(this.stroke)
    if (sc !== null) {
      // whiskers (fixed px width) and tails (min height = stroke thickness)
      batch.push(cx, d.lowerExtreme, cx, d.lowerQuartile, sc, 0, 0, 4, sw)
      batch.push(cx, d.upperQuartile, cx, d.upperExtreme, sc, 0, 0, 4, sw)
      const tw = (span * this.tailWidth) / 2
      if (tw > 0) {
        batch.push(cx - tw, d.lowerExtreme, cx + tw, d.lowerExtreme, sc, 0, 0, 0, sw)
        batch.push(cx - tw, d.upperExtreme, cx + tw, d.upperExtreme, sc, 0, 0, 0, sw)
      }
    }
    const bw = (span * this.bodyWidth) / 2
    const fc = this.bodyFill.type === 'empty' ? 0 : hl(this.bodyFill.getPrimaryColor()).toUint32()
    const bs = isEmptyLine(this.bodyStroke) ? 0 : hl(this.bodyStroke.getFillStyle().getPrimaryColor()).toUint32()
    batch.push(cx - bw, d.lowerQuartile, cx + bw, d.upperQuartile, fc, bs, bs ? lineW(this.bodyStroke) : 0)
    if (!isEmptyLine(this.medianStroke)) {
      const mc = hl(this.medianStroke.getFillStyle().getPrimaryColor()).toUint32()
      batch.push(cx - bw, d.median, cx + bw, d.median, mc, 0, 0, 0, lineW(this.medianStroke))
    }
  }
}

/** Box-and-whiskers series. Bodies, whiskers, tails and medians render in one GPU draw. */
export class BoxSeries extends FigureSeries<BoxFigure> {
  private batch = new ShapeBatch()
  private color: Color

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, _o: BoxSeriesOptions = {}) {
    super(chart, ax, ay, colorIndex, 'Box Series')
    this.color = seriesColor(chart.getTheme(), colorIndex)
    this.effect = false
  }

  private defaults() {
    const t = this.chart.getTheme()
    const c = this.color
    return {
      bodyFill: new SolidFill({ color: c.setA(t.isDark ? 110 : 90) }),
      bodyStroke: solidLine(c, 1.5),
      stroke: solidLine(t.isDark ? c.mix(new Color(255, 255, 255), 0.15) : c.scale(0.85), 1.5),
      median: solidLine(t.isDark ? new Color(255, 255, 255, 235) : t.titleColor, 2.5),
    }
  }

  /** Add a box: `{ start, end, lowerExtreme, lowerQuartile, median, upperQuartile, upperExtreme }` or with `x` / `width`. */
  add(d: BoxData): BoxFigure
  add(d: BoxData[]): BoxFigure[]
  add(d: BoxData | BoxData[]): BoxFigure | BoxFigure[] {
    if (Array.isArray(d)) return d.map((x) => this.add(x))
    return this.addFigure(new BoxFigure(this, d, this.defaults()))
  }

  primaryColor(): Color { return this.color }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.color } }

  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (this.dirty) {
      this.batch.clear()
      const dark = this.chart.getTheme().isDark
      for (const f of this.figs) if (f.live()) f.emitTo(this.batch, this.isHot(f), dark)
      this.dirty = false
    }
    this.batch.draw(r, maps, { shape: 0, x0: maps.x0, x1: maps.x1, minPx: [1, 1] })
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    const h = this.pick(px, py, 40)
    if (!h) return null
    const d = h.f.getDimensions()
    const x = (d.start + d.end) / 2
    const color = h.f.getBodyStrokeStyle().getFillStyle().getPrimaryColor()
    return {
      series: this, x, y: d.median, px: this.axisX.valueToPx(x), py: this.axisY.valueToPx(d.median),
      color: (color.a ? color : this.color).setA(255), dist2: h.d2, extra: { figure: this.figs.indexOf(h.f) },
    }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) return super.tableRows(hit)
    const f = this.figs[hit.extra?.figure as number]
    if (!f) return []
    const d = f.getDimensions()
    const fy = (v: number) => this.axisY.formatCursor(v)
    return [
      [{ text: this.name, color: hit.color }],
      [(this.axisX.title || 'X') + ':', this.categoryAt(d) ?? this.axisX.formatCursor(hit.x)],
      ['Upper extreme:', fy(d.upperExtreme)],
      ['Upper quartile:', fy(d.upperQuartile)],
      ['Median:', fy(d.median)],
      ['Lower quartile:', fy(d.lowerQuartile)],
      ['Lower extreme:', fy(d.lowerExtreme)],
    ]
  }

  /** Label of the custom X tick nearest to the box (category axes), if any. */
  private categoryAt(d: BoxDataBounded): string | null {
    const cx = (d.start + d.end) / 2, span = Math.abs(d.end - d.start) || 1
    let best: string | null = null, bd = span * 1.5
    for (const t of this.axisX.customTicks) {
      const dist = Math.abs(t.value - cx)
      if (t.visible && dist <= bd) { bd = dist; best = t.label() }
    }
    return best
  }

  override disposeGL(r: GLRenderer | null) {
    this.batch.dispose(r)
    this.dirty = true
  }
}
