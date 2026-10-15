import { Color } from '../../core/color'
import { LegendSymbol } from '../../core/Legend'
import { Fill, isEmptyLine, LineStyle, Mutator, resolve, SolidFill } from '../../core/style'
import { Rect } from '../../core/util'
import { XYMaps } from '../../render/draw'
import { GLRenderer } from '../../render/GLRenderer'
import { Bounds, XYStore } from '../store'
import { CursorHit, ResultTableRows, SeriesXY } from './SeriesXY'
import { lineW, ShapeBatch, solidLine } from './RectangleSeries'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export const OHLCFigures = { Candlestick: 'candlestick', Bar: 'bar' } as const
export type OHLCFigure = (typeof OHLCFigures)[keyof typeof OHLCFigures]

/** `[x, open, high, low, close]`. */
export type XOHLC = [number, number, number, number, number]
export interface OHLCDataPoint { x?: number; timestamp?: number; open: number; high: number; low: number; close: number }

export interface OHLCSeriesOptions {
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  positiveFigure?: OHLCFigure
  negativeFigure?: OHLCFigure
  /** Shorthand for both figures. */
  figure?: OHLCFigure
  [k: string]: unknown
}

/** Style of positive or negative figures (passed to `setPositiveStyle` / `setNegativeStyle` stylers). */
export class OHLCFigureStyle {
  constructor(public bodyFill: Fill, public bodyStroke: LineStyle, public stroke: LineStyle) {}
  setBodyFillStyle(f: Mutator<Fill>) { this.bodyFill = resolve(this.bodyFill, f); return this }
  getBodyFillStyle() { return this.bodyFill }
  setBodyStrokeStyle(l: Mutator<LineStyle>) { this.bodyStroke = resolve(this.bodyStroke, l); return this }
  getBodyStrokeStyle() { return this.bodyStroke }
  /** Wick of candlesticks, all lines of bar figures. */
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); return this }
  getStrokeStyle() { return this.stroke }
  /** Alias of setBodyFillStyle. */
  setFillStyle(f: Mutator<Fill>) { return this.setBodyFillStyle(f) }
  clone() { return new OHLCFigureStyle(this.bodyFill, this.bodyStroke, this.stroke) }
}

const grow = (a: Float64Array, n: number) => {
  const b = new Float64Array(Math.max(n, a.length * 2))
  b.set(a)
  return b
}

/**
 * OHLC / candlestick series. Data is kept sorted by X in
 * float64 arrays; GPU instances are appended incrementally (chunked, with
 * per-chunk origins and culling), so 100k+ candles stay cheap.
 */
export class OHLCSeries extends SeriesXY {
  private xs = new Float64Array(256)
  private os = new Float64Array(256)
  private hs = new Float64Array(256)
  private ls = new Float64Array(256)
  private cs = new Float64Array(256)
  private n = 0
  private minDx = Infinity
  private ymin = Infinity
  private ymax = -Infinity
  private pos: OHLCFigureStyle
  private neg: OHLCFigureStyle
  private posFig: OHLCFigure
  private negFig: OHLCFigure
  private batch = new ShapeBatch(16384)
  private built = 0
  private rebuild = true
  private fixedPx: number | null = null
  private autoRatio = 0.72
  private closes: XYStore | null = null

  constructor(chart: ChartXY, ax: Axis, ay: Axis, colorIndex: number, o: OHLCSeriesOptions = {}) {
    super(chart, ax, ay, colorIndex, 'OHLC Series')
    const t = chart.getTheme()
    const pal = t.examples.badGoodColorPalette
    const up = pal[pal.length - 1], down = pal[0]
    const mk = (c: Color) => new OHLCFigureStyle(new SolidFill({ color: c }), solidLine(c, 1), solidLine(c, 1))
    this.pos = mk(up)
    this.neg = mk(down)
    this.posFig = o.positiveFigure ?? o.figure ?? OHLCFigures.Candlestick
    this.negFig = o.negativeFigure ?? o.figure ?? OHLCFigures.Candlestick
  }

  // ---------------------------------------------------------------- style API

  setPositiveStyle(f: Mutator<OHLCFigureStyle>) { this.pos = resolve(this.pos, f); this.restyle(); return this }
  getPositiveStyle() { return this.pos }
  setNegativeStyle(f: Mutator<OHLCFigureStyle>) { this.neg = resolve(this.neg, f); this.restyle(); return this }
  getNegativeStyle() { return this.neg }
  setPositiveFigure(f: OHLCFigure) { this.posFig = f; this.restyle(); return this }
  setNegativeFigure(f: OHLCFigure) { this.negFig = f; this.restyle(); return this }
  setFigure(f: OHLCFigure) { this.posFig = this.negFig = f; this.restyle(); return this }
  /** Fixed figure width in CSS px (disables automatic fitting). */
  setFigureWidth(px: number) { this.fixedPx = px; this.chart.requestRender(); return this }
  getFigureWidth() { return this.fixedPx ?? this.autoRatio }
  /** Automatic width from data spacing (default). `ratio` is the fraction of the spacing. */
  setFigureAutoFitting(enabled: boolean, ratio = this.autoRatio) {
    if (enabled) this.fixedPx = null
    else if (this.fixedPx === null) this.fixedPx = 8
    this.autoRatio = ratio
    this.chart.requestRender()
    return this
  }
  setMouseInteractions(v: boolean) { this.cursorEnabled = v; return this }
  private restyle() { this.rebuild = true; this.chart.requestRender() }

  // ---------------------------------------------------------------- data API

  /** Append `[x, o, h, l, c]` tuples or `{ x, open, high, low, close }` objects. */
  add(data: XOHLC | XOHLC[] | OHLCDataPoint | OHLCDataPoint[]) {
    const arr: (XOHLC | OHLCDataPoint)[] = Array.isArray(data) && (data.length === 0 || typeof data[0] !== 'number')
      ? (data as (XOHLC | OHLCDataPoint)[])
      : [data as XOHLC | OHLCDataPoint]
    const m = arr.length
    if (!m) return this
    if (this.n + m > this.xs.length) {
      const cap = this.n + m
      this.xs = grow(this.xs, cap); this.os = grow(this.os, cap); this.hs = grow(this.hs, cap)
      this.ls = grow(this.ls, cap); this.cs = grow(this.cs, cap)
    }
    let sorted = true
    let prev = this.n ? this.xs[this.n - 1] : -Infinity
    const start = this.n
    for (const p of arr) {
      let x: number, o: number, h: number, l: number, c: number
      if (Array.isArray(p)) [x, o, h, l, c] = p
      else {
        const t: any = p.x ?? p.timestamp ?? (this.n ? this.xs[this.n - 1] + 1 : 0)
        x = t instanceof Date ? t.getTime() : t
        o = p.open; h = p.high; l = p.low; c = p.close
      }
      const i = this.n++
      this.xs[i] = x; this.os[i] = o; this.hs[i] = h; this.ls[i] = l; this.cs[i] = c
      if (x < prev) sorted = false
      else if (x > prev && Number.isFinite(prev)) this.minDx = Math.min(this.minDx, x - prev)
      prev = x
      const lo = Math.min(l, o, c, h), hi = Math.max(h, o, c, l)
      if (lo < this.ymin) this.ymin = lo
      if (hi > this.ymax) this.ymax = hi
    }
    if (!sorted) this.sort()
    else if (this.closes) this.closes.append(this.n - start, (i) => this.xs[start + i], (i) => this.cs[start + i])
    this.chart.onSeriesData(this)
    return this
  }
  /** Replace all data. */
  setData(data: XOHLC[] | OHLCDataPoint[]) { this.clear(); return this.add(data) }
  clear() {
    this.n = 0
    this.minDx = Infinity
    this.ymin = Infinity
    this.ymax = -Infinity
    this.closes?.clear()
    this.rebuild = true
    this.chart.requestRender()
    return this
  }
  getSampleCount() { return this.n }
  getXMin() { return this.n ? this.xs[0] : undefined }
  getXMax() { return this.n ? this.xs[this.n - 1] : undefined }
  getYMin() { return this.ymin }
  getYMax() { return this.ymax }
  /** Candle at storage index i. */
  getCandle(i: number): XOHLC | undefined {
    if (i < 0 || i >= this.n) return undefined
    return [this.xs[i], this.os[i], this.hs[i], this.ls[i], this.cs[i]]
  }
  getLastCandle() { return this.getCandle(this.n - 1) }

  private sort() {
    const n = this.n
    const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => this.xs[a] - this.xs[b])
    const re = (a: Float64Array) => { const b = new Float64Array(a.length); for (let i = 0; i < n; i++) b[i] = a[idx[i]]; return b }
    this.xs = re(this.xs); this.os = re(this.os); this.hs = re(this.hs); this.ls = re(this.ls); this.cs = re(this.cs)
    this.minDx = Infinity
    for (let i = 1; i < n; i++) {
      const d = this.xs[i] - this.xs[i - 1]
      if (d > 0 && d < this.minDx) this.minDx = d
    }
    this.rebuild = true
    if (this.closes) {
      this.closes.clear()
      this.closes.append(n, (i) => this.xs[i], (i) => this.cs[i])
    }
  }

  /** @internal Close-price line store (used by ZoomBandChart overviews). */
  getCloseStore(): XYStore {
    if (!this.closes) {
      this.closes = new XYStore()
      this.closes.append(this.n, (i) => this.xs[i], (i) => this.cs[i])
    }
    return this.closes
  }

  // ---------------------------------------------------------------- rendering

  private dataWidth() { return Number.isFinite(this.minDx) ? this.minDx * this.autoRatio : 0 }

  bounds(): Bounds | null {
    if (!this.n) return null
    const hw = Number.isFinite(this.minDx) ? this.minDx / 2 : 0.5
    return { xmin: this.xs[0] - hw, xmax: this.xs[this.n - 1] + hw, ymin: this.ymin, ymax: this.ymax }
  }
  override yBoundsInX(x0: number, x1: number): Bounds | null {
    if (!this.n) return null
    let i = this.lower(x0)
    let lo = Infinity, hi = -Infinity
    for (; i < this.n && this.xs[i] <= x1; i++) {
      if (this.ls[i] < lo) lo = this.ls[i]
      if (this.hs[i] > hi) hi = this.hs[i]
    }
    return lo <= hi ? { xmin: x0, xmax: x1, ymin: lo, ymax: hi } : null
  }
  private lower(v: number) {
    let a = 0, b = this.n
    while (a < b) {
      const m = (a + b) >>> 1
      if (this.xs[m] < v) a = m + 1
      else b = m
    }
    return a
  }

  private emitCandles(from: number) {
    const st = [this.pos, this.neg]
    const u = st.map((s) => ({
      fill: s.bodyFill.type === 'empty' ? 0 : s.bodyFill.getPrimaryColor().toUint32(),
      bs: isEmptyLine(s.bodyStroke) ? 0 : s.bodyStroke.getFillStyle().getPrimaryColor().toUint32(),
      bw: isEmptyLine(s.bodyStroke) ? 0 : lineW(s.bodyStroke),
      line: isEmptyLine(s.stroke) ? 0 : s.stroke.getFillStyle().getPrimaryColor().toUint32(),
      lw: lineW(s.stroke),
    }))
    const b = this.batch
    for (let i = from; i < this.n; i++) {
      const x = this.xs[i], o = this.os[i], h = this.hs[i], l = this.ls[i], c = this.cs[i]
      const up = c >= o
      const s = u[up ? 0 : 1]
      const fig = up ? this.posFig : this.negFig
      if (fig === OHLCFigures.Bar) {
        const col = s.line || s.fill
        const w = Math.max(1, s.lw)
        b.push(x, l, x, h, col, 0, 0, 4, w)
        b.push(x, o, x, o, col, 0, 0, 2, w)
        b.push(x, c, x, c, col, 0, 0, 3, w)
      } else {
        if (s.line) b.push(x, l, x, h, s.line, 0, 0, 4, s.lw)
        b.push(x, Math.min(o, c), x, Math.max(o, c), s.fill, s.bs, s.bw, 1, 0)
      }
    }
  }

  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (this.rebuild) {
      this.batch.clear()
      this.built = 0
      this.rebuild = false
    }
    if (this.built < this.n) {
      this.emitCandles(this.built)
      this.built = this.n
    }
    if (!this.n) return
    const dw = this.fixedPx === null ? this.dataWidth() : 0
    const px = this.fixedPx ?? 8
    const k = Math.abs(maps.mx.k) || 1
    const margin = dw > 0 ? dw : (px / 2 + 2) / k
    this.batch.draw(r, maps, { shape: 0, x0: maps.x0, x1: maps.x1, margin, figWidth: dw, figWidthPx: px, minPx: [1, 1] })
  }

  nearest(px: number, py: number, _byX: boolean): CursorHit | null {
    if (!this.n || !this.visible) return null
    const xv = this.axisX.pxToValue(px)
    let i = this.lower(xv)
    if (i >= this.n || (i > 0 && Math.abs(this.xs[i - 1] - xv) < Math.abs(this.xs[i] - xv))) i = Math.max(0, i - 1)
    const x = this.xs[i], c = this.cs[i]
    const hpx = this.axisX.valueToPx(x), hpy = this.axisY.valueToPx(c)
    const dx = hpx - px
    let dy = 0
    if (Number.isFinite(py)) {
      const a = this.axisY.valueToPx(this.hs[i]), b = this.axisY.valueToPx(this.ls[i])
      dy = Math.max(Math.min(a, b) - py, 0, py - Math.max(a, b))
    }
    const st = c >= this.os[i] ? this.pos : this.neg
    const col = st.bodyFill.type !== 'empty' ? st.bodyFill.getPrimaryColor() : st.stroke.getFillStyle().getPrimaryColor()
    return { series: this, x, y: c, px: hpx, py: hpy, color: col.setA(255), dist2: dx * dx + dy * dy, extra: { index: i } }
  }

  override tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) return super.tableRows(hit)
    const i = hit.extra?.index as number
    if (!(i >= 0 && i < this.n)) return []
    const fy = (v: number) => this.axisY.formatCursor(v)
    const o = this.os[i], c = this.cs[i]
    const ch = o !== 0 ? ((c - o) / Math.abs(o)) * 100 : 0
    return [
      [{ text: this.name, color: hit.color }],
      [this.axisX.formatCursor(this.xs[i])],
      ['Open:', fy(o)],
      ['High:', fy(this.hs[i])],
      ['Low:', fy(this.ls[i])],
      ['Close:', fy(c)],
      ['Change:', { text: `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} %`, color: hit.color }],
    ]
  }

  primaryColor(): Color { return this.pos.bodyFill.getPrimaryColor() }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor().setA(255) } }

  override disposeGL(r: GLRenderer | null) {
    this.batch.dispose(r)
    this.closes?.dispose(r)
    this.rebuild = true
  }
}
