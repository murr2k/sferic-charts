import { Color } from '../../core/color'
import { LegendSymbol } from '../../core/Legend'
import { emptyLine, Fill, LineStyle, LUT, Mutator, PalettedFill, regularColorSteps, resolve } from '../../core/style'
import { Rect } from '../../core/util'
import { HeatmapTexture, XYMaps } from '../../render/draw'
import { GLRenderer } from '../../render/GLRenderer'
import { Bounds } from '../store'
import { CursorHit, SeriesXY } from './SeriesXY'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export interface HeatmapGridOptions {
  columns: number
  rows: number
  start?: { x: number; y: number }
  end?: { x: number; y: number }
  step?: { x: number; y: number }
  dataOrder?: 'columns' | 'rows'
  heatmapDataType?: 'intensity'
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
}

export interface HeatmapScrollingOptions {
  scrollDimension?: 'columns' | 'rows'
  resolution: number
  start?: { x: number; y: number }
  step?: { x: number; y: number }
  axisX?: Axis
  axisY?: Axis
  xAxis?: Axis
  yAxis?: Axis
  automaticColorIndex?: number
  /** Initial ring capacity (columns); grows up to `maxColumns`. */
  capacity?: number
  maxColumns?: number
}

abstract class HeatmapBase extends SeriesXY {
  protected fill: Fill
  protected interpolate = false
  protected opacity = 1
  protected tex!: HeatmapTexture

  constructor(chart: ChartXY, ax: Axis, ay: Axis, ci: number, name: string) {
    super(chart, ax, ay, ci, name)
    const t = chart.getTheme()
    this.fill = new PalettedFill({ lut: new LUT({ steps: regularColorSteps(0, 1, t.examples.intensityColorPalette), interpolate: true }) })
    this.effect = false
    this.fitTight = true
  }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.requestRender(); return this }
  getFillStyle() { return this.fill }
  setWireframeStyle(_l: Mutator<LineStyle>) { return this }
  /** 'disabled' | 'bilinear'. */
  setIntensityInterpolation(m: 'disabled' | 'bilinear' | boolean) { this.interpolate = m === 'bilinear' || m === true; this.chart.requestRender(); return this }
  setPixelInterpolationMode(m: 'disabled' | 'bilinear') { return this.setIntensityInterpolation(m) }
  setOpacity(o: number) { this.opacity = o; this.chart.requestRender(); return this }
  protected lut(): LUT {
    if (this.fill instanceof PalettedFill) return this.fill.lut
    const c = this.fill.getPrimaryColor()
    return new LUT({ steps: [{ value: 0, color: c.setA(0) }, { value: 1, color: c }] })
  }
  primaryColor(): Color { return this.fill.getPrimaryColor() }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor() } }
  override disposeGL(r: GLRenderer | null) { this.tex?.dispose(r) }
}

/** Static grid of intensity values. */
export class HeatmapGridSeries extends HeatmapBase {
  readonly columns: number
  readonly rows: number
  private start: { x: number; y: number }
  private end: { x: number; y: number }
  private order: 'columns' | 'rows'

  constructor(chart: ChartXY, ax: Axis, ay: Axis, ci: number, o: HeatmapGridOptions) {
    super(chart, ax, ay, ci, 'Heatmap Grid Series')
    this.columns = Math.max(1, o.columns | 0)
    this.rows = Math.max(1, o.rows | 0)
    this.order = o.dataOrder ?? 'columns'
    this.start = o.start ?? { x: 0, y: 0 }
    if (o.end) this.end = o.end
    else if (o.step) this.end = { x: this.start.x + o.step.x * this.columns, y: this.start.y + o.step.y * this.rows }
    else this.end = { x: this.start.x + this.columns, y: this.start.y + this.rows }
    const max = chart.maxTextureSize()
    if (this.columns > max || this.rows > max) throw new Error(`sferic: heatmap ${this.columns}x${this.rows} exceeds max texture size ${max}`)
    this.tex = new HeatmapTexture(this.columns, this.rows)
  }
  setStart(p: { x: number; y: number }) {
    const w = this.end.x - this.start.x, h = this.end.y - this.start.y
    this.start = { ...p }
    this.end = { x: p.x + w, y: p.y + h }
    this.chart.requestRender()
    return this
  }
  setEnd(p: { x: number; y: number }) { this.end = { ...p }; this.chart.requestRender(); return this }
  setStep(s: { x: number; y: number }) {
    this.end = { x: this.start.x + s.x * this.columns, y: this.start.y + s.y * this.rows }
    this.chart.requestRender()
    return this
  }
  getStart() { return this.start }
  getEnd() { return this.end }

  /** Replace all values, or a sub-region with {iRow, iColumn, values}. */
  invalidateIntensityValues(v: number[][] | { iRow?: number; iColumn?: number; values: number[][] } | Float32Array) {
    if (v instanceof Float32Array) this.tex.setRowMajor(v)
    else if (Array.isArray(v)) this.tex.invalidateRegion(0, 0, v, this.order)
    else this.tex.invalidateRegion(v.iColumn ?? 0, v.iRow ?? 0, v.values, this.order)
    this.chart.onSeriesData(this)
    return this
  }
  /** Raw row-major Float32Array of size columns*rows (fastest path). */
  setRowMajorValues(v: Float32Array) { this.tex.setRowMajor(v); this.chart.onSeriesData(this); return this }

  bounds(): Bounds {
    return {
      xmin: Math.min(this.start.x, this.end.x), xmax: Math.max(this.start.x, this.end.x),
      ymin: Math.min(this.start.y, this.end.y), ymax: Math.max(this.start.y, this.end.y),
    }
  }
  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    this.tex.draw(r, maps, { x0: this.start.x, y0: this.start.y, x1: this.end.x, y1: this.end.y }, this.lut(), { interpolate: this.interpolate, opacity: this.opacity })
  }
  nearest(px: number, py: number): CursorHit | null {
    const x = this.axisX.pxToValue(px), y = this.axisY.pxToValue(py)
    const fx = (x - this.start.x) / (this.end.x - this.start.x), fy = (y - this.start.y) / (this.end.y - this.start.y)
    if (!(fx >= 0 && fx < 1 && fy >= 0 && fy < 1)) return null
    const c = Math.floor(fx * this.columns), rr = Math.floor(fy * this.rows)
    const v = this.tex.data[rr * this.tex.texW + c]
    const cx = this.start.x + ((c + 0.5) / this.columns) * (this.end.x - this.start.x)
    const cy = this.start.y + ((rr + 0.5) / this.rows) * (this.end.y - this.start.y)
    return {
      series: this, x: cx, y: cy, px, py, color: this.lut().getColor(v), dist2: 0,
      extra: { [this.lut().units ? `Value (${this.lut().units})` : 'Value']: Number.isFinite(v) ? +v.toPrecision(5) : 'NaN' },
    }
  }
}

/** Heatmap that grows by appending columns (e.g. real-time spectrogram). */
export class HeatmapScrollingGridSeries extends HeatmapBase {
  readonly resolution: number
  private start: { x: number; y: number }
  private step: { x: number; y: number }
  private pushed = 0
  private maxColumns: number

  constructor(chart: ChartXY, ax: Axis, ay: Axis, ci: number, o: HeatmapScrollingOptions) {
    super(chart, ax, ay, ci, 'Heatmap Scrolling Grid Series')
    if ((o.scrollDimension ?? 'columns') !== 'columns') console.warn('sferic: only scrollDimension "columns" is supported')
    this.resolution = Math.max(1, o.resolution | 0)
    this.start = o.start ?? { x: 0, y: 0 }
    this.step = o.step ?? { x: 1, y: 1 }
    const max = chart.maxTextureSize()
    this.maxColumns = Math.min(max, o.maxColumns ?? max)
    this.tex = new HeatmapTexture(0, this.resolution, Math.min(this.maxColumns, o.capacity ?? 1024))
  }
  setStart(p: { x: number; y: number }) { this.start = { ...p }; this.chart.requestRender(); return this }
  setStep(s: { x: number; y: number }) { this.step = { ...s }; this.chart.requestRender(); return this }
  /** Keep at most n columns. */
  setMaxColumns(n: number) { this.maxColumns = Math.max(1, n); return this }
  setDataCleaning(o: { minDataPointCount?: number } | undefined) {
    if (o?.minDataPointCount) this.maxColumns = Math.min(this.maxColumns, Math.max(this.tex.cap, o.minDataPointCount))
    return this
  }

  /** Append columns; each inner array has `resolution` values. */
  addIntensityValues(columns: ArrayLike<number>[]) {
    let t = this.tex
    if (t.filled + columns.length > t.cap && t.cap < this.maxColumns) {
      // Grow ring (preserving logical order).
      const ncap = Math.min(this.maxColumns, Math.max(t.cap * 2, t.filled + columns.length))
      const nt = new HeatmapTexture(0, this.resolution, ncap)
      const W = t.texW
      const cols: Float32Array[] = []
      for (let i = 0; i < t.filled; i++) {
        const tc = (t.ringStart + i) % t.cap
        const col = new Float32Array(this.resolution)
        for (let rr = 0; rr < this.resolution; rr++) col[rr] = t.data[rr * W + tc]
        cols.push(col)
      }
      nt.pushColumns(cols)
      let r: GLRenderer | null = null
      try { r = this.chart.renderer() } catch { r = null }
      t.dispose(r)
      this.tex = t = nt
    }
    t.pushColumns(columns)
    this.pushed += columns.length
    this.chart.onSeriesData(this)
    return this
  }
  clear() {
    this.tex = new HeatmapTexture(0, this.resolution, this.tex.cap)
    this.pushed = 0
    this.chart.requestRender()
    return this
  }
  private firstColumn() { return this.pushed - this.tex.filled }
  bounds(): Bounds | null {
    if (!this.tex.filled) return null
    const x0 = this.start.x + this.firstColumn() * this.step.x
    const x1 = x0 + this.tex.filled * this.step.x
    const y1 = this.start.y + this.resolution * this.step.y
    return { xmin: Math.min(x0, x1), xmax: Math.max(x0, x1), ymin: Math.min(this.start.y, y1), ymax: Math.max(this.start.y, y1) }
  }
  drawGL(r: GLRenderer, maps: XYMaps, _rect: Rect) {
    if (!this.tex.filled) return
    const x0 = this.start.x + this.firstColumn() * this.step.x
    this.tex.draw(
      r,
      maps,
      { x0, y0: this.start.y, x1: x0 + this.tex.filled * this.step.x, y1: this.start.y + this.resolution * this.step.y },
      this.lut(),
      { interpolate: this.interpolate, opacity: this.opacity },
    )
  }
  nearest(px: number, py: number): CursorHit | null {
    const t = this.tex
    if (!t.filled) return null
    const x = this.axisX.pxToValue(px), y = this.axisY.pxToValue(py)
    const c = Math.floor((x - this.start.x) / this.step.x) - this.firstColumn()
    const rr = Math.floor((y - this.start.y) / this.step.y)
    if (c < 0 || c >= t.filled || rr < 0 || rr >= this.resolution) return null
    const tc = (t.ringStart + c) % t.cap
    const v = t.data[rr * t.texW + tc]
    return {
      series: this,
      x: this.start.x + (this.firstColumn() + c + 0.5) * this.step.x,
      y: this.start.y + (rr + 0.5) * this.step.y,
      px, py, color: this.lut().getColor(v), dist2: 0,
      extra: { Value: Number.isFinite(v) ? +v.toPrecision(5) : 'NaN' },
    }
  }
}

export { emptyLine }
