import { Color } from '../core/color'
import { Legend, LegendOptions, LegendSymbol, LegendTarget } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { isEmptyLine, LineStyle, LUT, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { font, seriesColor } from '../core/theme'
import { clamp, Emitter, Rect, rectContains, roundRect, textWidth } from '../core/util'
import { SegmentBatch } from '../render/draw'
import { AxisMap, GLRenderer } from '../render/GLRenderer'
import { PointerInfo, Surface } from '../render/Surface'
import { AxisTickStrategies, Tick, TickStrategy } from '../xy/ticks'

export interface ParallelCoordinateChartOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

export type ParallelCoordinateValue = number | string
export type ParallelCoordinateRecord = Record<string, ParallelCoordinateValue | null | undefined>

export interface ParallelCoordinateAxisOptions {
  title?: string
  units?: string
  /** Fixed interval; omitted = fit to data. */
  interval?: { start: number; end: number }
  /** Category labels in axis order (string values map to their index). */
  categories?: string[]
}

/** Spline subdivisions per gap between two axes. */
const SPLINE_STEPS = 12
/** Pointer distance (px) for line hover and axis grabbing. */
const HOVER_TOL = 8
const AXIS_GRAB = 12
const EDGE_GRAB = 5

const cloneStrategy = <T extends TickStrategy>(s: T): T => Object.assign(Object.create(Object.getPrototypeOf(s)), s)
const smooth = (t: number) => t * t * (3 - 2 * t)

/** Brush on a parallel axis; lines outside every active brush are dimmed. */
export class ParallelCoordinateRangeSelector extends Emitter {
  start = 0
  end = 0
  /** @internal True while being created and not yet dragged. */
  pending = false
  private disposed = false
  constructor(readonly axis: ParallelCoordinateAxis) { super() }

  setInterval(a: number | { start: number; end: number }, b?: number) {
    const s = typeof a === 'number' ? a : a.start
    const e = typeof a === 'number' ? (b ?? a) : a.end
    if (!Number.isFinite(s) || !Number.isFinite(e)) return this
    const lo = Math.min(s, e), hi = Math.max(s, e)
    if (lo === this.start && hi === this.end) return this
    this.start = lo
    this.end = hi
    this.emit('intervalchange', { start: lo, end: hi })
    this.axis.chart.onSelectorChange()
    return this
  }
  getInterval() { return { start: this.start, end: this.end } }
  getAxis() { return this.axis }
  isDisposed() { return this.disposed }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.axis.removeSelector(this)
    this.emit('dispose', {})
    return this
  }
}

/** One vertical axis of a parallel coordinate chart. */
export class ParallelCoordinateAxis extends Emitter {
  title: string
  units: string
  strategy: TickStrategy
  /** Resolved interval (fixed or fitted). */
  start = 0
  end = 1
  /** @internal Layout results. */
  px = 0
  /** @internal */
  ticks: Tick[] = []
  /** @internal Effective categories (null for numeric axes). */
  cats: string[] | null = null
  /** @internal */
  fixed: { start: number; end: number } | null
  /** @internal */
  userCats: string[] | null
  /** @internal */
  catIndex = new Map<string, number>()
  readonly selectors: ParallelCoordinateRangeSelector[] = []

  constructor(readonly chart: ParallelCoordinateChart, readonly key: string, o: ParallelCoordinateAxisOptions = {}) {
    super()
    this.title = o.title ?? key
    this.units = o.units ?? ''
    this.strategy = cloneStrategy(AxisTickStrategies.Numeric)
    this.fixed = o.interval ? { ...o.interval } : null
    this.userCats = o.categories ? [...o.categories] : null
  }

  getKey() { return this.key }
  setTitle(t: string) { this.title = t; this.chart.requestRender(); return this }
  getTitle() { return this.title }
  setUnits(u: string) { this.units = u; this.chart.requestRender(); return this }
  getUnits() { return this.units }
  setTickStrategy<T extends TickStrategy>(s: T, styler?: (s: T) => T) {
    let st = cloneStrategy(s)
    if (styler) st = styler(st)
    this.strategy = st
    this.chart.requestRender()
    return this
  }
  /** Fix the interval; `stopAxisAfter` is accepted for API compatibility. */
  setInterval(a: number | { start: number; end: number; stopAxisAfter?: boolean }, end?: number) {
    const s = typeof a === 'number' ? a : a.start
    const e = typeof a === 'number' ? end! : a.end
    if (!Number.isFinite(s) || !Number.isFinite(e) || s === e) return this
    this.fixed = { start: s, end: e }
    this.chart.invalidateData()
    return this
  }
  getInterval() { return { start: this.start, end: this.end } }
  /** Return to fitting the interval to data. */
  fit() { this.fixed = null; this.chart.invalidateData(); return this }
  setCategories(c: string[] | undefined) { this.userCats = c ? [...c] : null; this.chart.invalidateData(); return this }
  getCategories() { return this.cats ? [...this.cats] : undefined }

  addRangeSelector() {
    const sel = new ParallelCoordinateRangeSelector(this)
    const lo = Math.min(this.start, this.end), hi = Math.max(this.start, this.end)
    sel.start = lo + (hi - lo) / 3
    sel.end = lo + ((hi - lo) * 2) / 3
    this.selectors.push(sel)
    this.chart.onSelectorChange()
    return sel
  }
  getRangeSelectors() { return [...this.selectors] }
  clearRangeSelectors() {
    for (const s of [...this.selectors]) s.dispose()
    return this
  }
  /** @internal */
  removeSelector(s: ParallelCoordinateRangeSelector) {
    const i = this.selectors.indexOf(s)
    if (i >= 0) this.selectors.splice(i, 1)
    this.chart.onSelectorChange()
  }

  titleText() { return this.title + (this.units ? ` (${this.units})` : '') }

  /** Numeric position of a raw value (category index for string values). */
  toNumber(v: ParallelCoordinateValue | null | undefined): number {
    if (typeof v === 'number') return Number.isFinite(v) ? v : NaN
    if (typeof v === 'string') {
      const i = this.catIndex.get(v)
      return i === undefined ? NaN : i
    }
    return NaN
  }
  formatValue(v: ParallelCoordinateValue | null | undefined): string {
    if (v === null || v === undefined) return '-'
    if (typeof v === 'string') return v
    return this.strategy.formatCursor(v, { start: this.start, end: this.end })
  }
  valueToPx(v: number): number {
    const p = this.chart.plot
    return p.y + p.h - ((v - this.start) / (this.end - this.start || 1)) * p.h
  }
  pxToValue(py: number): number {
    const p = this.chart.plot
    return this.start + ((p.y + p.h - py) / (p.h || 1)) * (this.end - this.start)
  }
  /** @internal */
  clampValue(v: number) { return clamp(v, Math.min(this.start, this.end), Math.max(this.start, this.end)) }

  /** @internal Resolve categories and the automatic interval from data. */
  fitTo(list: ParallelCoordinateSeries[]) {
    let cats = this.userCats
    if (!cats) {
      const seen = new Set<string>()
      for (const s of list) {
        const v = s.data[this.key]
        if (typeof v === 'string' && !seen.has(v)) seen.add(v)
      }
      cats = seen.size ? [...seen] : null
    }
    this.cats = cats
    this.catIndex.clear()
    if (cats) cats.forEach((c, i) => this.catIndex.set(c, i))
    if (this.fixed) {
      this.start = this.fixed.start
      this.end = this.fixed.end
      return
    }
    if (cats) {
      this.start = -0.5
      this.end = Math.max(0.5, cats.length - 0.5)
      return
    }
    let lo = Infinity, hi = -Infinity
    for (const s of list) {
      const v = this.toNumber(s.data[this.key])
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!(lo <= hi)) { lo = 0; hi = 1 }
    if (lo === hi) {
      const d = Math.abs(lo) * 0.05 || 1
      lo -= d
      hi += d
    }
    this.start = lo
    this.end = hi
  }

  /** @internal */
  computeTicks(len: number) {
    const t = this.chart.getTheme()
    const fs = t.fontSize
    if (this.cats) {
      const n = this.cats.length
      const every = Math.max(1, Math.ceil((fs * 1.4) / (len / Math.max(1, n))))
      this.ticks = this.cats.map((c, i) => ({ value: i, label: i % every === 0 ? c : '', level: 0 as const }))
      return
    }
    this.ticks = this.strategy.generate({
      lo: Math.min(this.start, this.end),
      hi: Math.max(this.start, this.end),
      length: len,
      horizontal: false,
      log: 0,
      measure: (s, level) => textWidth(s, font(t, level === 0 ? fs : fs * 0.85)),
      fontSize: fs,
    })
  }

  /** @internal Selector part under a pointer y (CSS px). */
  selectorAt(y: number): { sel: ParallelCoordinateRangeSelector; edge: 'start' | 'end' | 'body' } | null {
    for (let i = this.selectors.length - 1; i >= 0; i--) {
      const sel = this.selectors[i]
      if (sel.pending) continue
      const a = this.valueToPx(sel.start), b = this.valueToPx(sel.end)
      if (Math.abs(y - a) <= EDGE_GRAB) return { sel, edge: 'start' }
      if (Math.abs(y - b) <= EDGE_GRAB) return { sel, edge: 'end' }
      if (y > Math.min(a, b) && y < Math.max(a, b)) return { sel, edge: 'body' }
    }
    return null
  }
}

/** One record (polyline across all axes). */
export class ParallelCoordinateSeries extends Emitter implements LegendTarget {
  /** @internal */
  data: ParallelCoordinateRecord = {}
  /** @internal */
  color: Color
  /** @internal Null = chart default thickness. */
  thickness: number | null = null
  /** @internal */
  empty = false
  /** @internal */
  visible = true
  /** @internal */
  selected = true
  /** @internal Row in the chart's normalized value cache (-1 when hidden). */
  liveIndex = -1
  private name: string
  private disposed = false

  constructor(private chart: ParallelCoordinateChart, colorIndex: number) {
    super()
    this.color = seriesColor(chart.getTheme(), colorIndex)
    this.name = `Series ${colorIndex + 1}`
  }

  setData(d: ParallelCoordinateRecord) { this.data = { ...d }; this.chart.invalidateData(); return this }
  getData(): ParallelCoordinateRecord { return { ...this.data } }
  setName(n: string) { this.name = n; this.chart.requestRender(); return this }
  getName() { return this.name }
  setColor(c: Mutator<Color>) { this.color = resolve(this.color, c); this.chart.invalidateStyle(); return this }
  getColor() { return this.color }
  setStrokeStyle(l: Mutator<LineStyle>) {
    const next = resolve<LineStyle>(this.getStrokeStyle(), l)
    this.empty = isEmptyLine(next)
    if (!this.empty) {
      this.color = next.getFillStyle().getPrimaryColor()
      this.thickness = next.getThickness()
    }
    this.chart.invalidateStyle()
    return this
  }
  getStrokeStyle(): LineStyle {
    return new SolidLine({ thickness: this.thickness ?? this.chart.getSeriesStrokeThickness(), fillStyle: new SolidFill({ color: this.color }) })
  }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.chart.invalidateData()
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  /** True when the line passes every active range selector. */
  isSelected() { return this.selected }
  getLegendSymbol(): LegendSymbol { return { kind: 'line', color: this.color.setA(255) } }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.chart.removeSeries(this)
    return this
  }
  isDisposed() { return this.disposed }
}

type Drag =
  | { kind: 'create'; axis: ParallelCoordinateAxis; sel: ParallelCoordinateRangeSelector; v0: number; y0: number }
  | { kind: 'resize'; axis: ParallelCoordinateAxis; sel: ParallelCoordinateRangeSelector; fixed: number }
  | { kind: 'move'; axis: ParallelCoordinateAxis; sel: ParallelCoordinateRangeSelector; last: number }

interface BatchPair { dim: SegmentBatch; sel: SegmentBatch }

/**
 * Parallel coordinates. Every record is a
 * polyline across vertical axes; drag along an axis to brush (filter) records.
 * Lines are GPU segments in normalized space (x = axis index, y = 0..1), so
 * geometry only rebuilds on data, interval, selection or style changes.
 */
export class ParallelCoordinateChart extends Panel {
  readonly legend: Legend
  plot: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private axes: ParallelCoordinateAxis[] = []
  private series: ParallelCoordinateSeries[] = []
  private lutCfg: { key: string; lut: LUT } | null = null
  private spline = false
  private thickness: number
  private unselected: Color | null = null
  private opacity = 1
  private dataDirty = true
  private selDirty = true
  private batches = new Map<number, BatchPair>()
  private hoverBatch = new SegmentBatch()
  private hoverBuilt: ParallelCoordinateSeries | null = null
  private hovered: ParallelCoordinateSeries | null = null
  private hoverAxis: ParallelCoordinateAxis | null = null
  private pointer: { x: number; y: number } | null = null
  private drag: Drag | null = null
  private colorCounter = 0
  private live: ParallelCoordinateSeries[] = []
  private norm = new Float32Array(0)
  private anyActive = false

  constructor(o: ParallelCoordinateChartOptions = {}) {
    super(o)
    this.legend = new Legend(this, { position: 'right', ...o.legend })
    this.thickness = this.theme.lineThickness
  }

  // ---------------------------------------------------------------- axes

  setAxes(axes: string[] | Record<string, ParallelCoordinateAxisOptions | undefined>) {
    const entries: [string, ParallelCoordinateAxisOptions][] = Array.isArray(axes)
      ? axes.map((k) => [k, {}])
      : Object.entries(axes).map(([k, v]) => [k, v ?? {}])
    const old = new Map(this.axes.map((a) => [a.key, a]))
    this.axes = entries.map(([k, o]) => {
      const prev = old.get(k)
      if (!prev) return new ParallelCoordinateAxis(this, k, o)
      if (o.title !== undefined) prev.title = o.title
      if (o.units !== undefined) prev.units = o.units
      if (o.interval) prev.fixed = { ...o.interval }
      if (o.categories) prev.userCats = [...o.categories]
      return prev
    })
    if (this.lutCfg) this.syncLUTLegend(this.lutCfg, this.lutCfg)
    this.invalidateData()
    return this
  }
  getAxis(key: string): ParallelCoordinateAxis {
    const a = this.axes.find((x) => x.key === key)
    if (!a) throw new Error(`sferic: parallel coordinate axis "${key}" not found; call setAxes first`)
    return a
  }
  getAxes() { return [...this.axes] }
  clearRangeSelectors() { for (const a of this.axes) a.clearRangeSelectors(); return this }

  // ---------------------------------------------------------------- series

  addSeries(o: { automaticColorIndex?: number; name?: string; data?: ParallelCoordinateRecord } = {}) {
    const s = new ParallelCoordinateSeries(this, o.automaticColorIndex ?? this.colorCounter++)
    if (o.name) s.setName(o.name)
    if (o.data) s.data = { ...o.data }
    this.series.push(s)
    this.invalidateData()
    return s
  }
  getSeries() { return [...this.series] }
  /** Replace all series with one per record. */
  setData(records: ParallelCoordinateRecord[]) {
    this.removeAllSeries()
    for (const r of records) {
      const s = new ParallelCoordinateSeries(this, this.colorCounter++)
      s.data = { ...r }
      this.series.push(s)
    }
    this.invalidateData()
    return this
  }
  removeAllSeries() {
    for (const s of this.series) this.legend.remove(s)
    this.series = []
    this.hovered = null
    this.colorCounter = 0
    this.invalidateData()
    return this
  }
  /** @internal */
  removeSeries(s: ParallelCoordinateSeries) {
    const i = this.series.indexOf(s)
    if (i < 0) return
    this.series.splice(i, 1)
    this.legend.remove(s)
    if (this.hovered === s) this.hovered = null
    this.invalidateData()
  }
  getSelectedSeries() { return this.live.filter((s) => s.selected) }

  // ---------------------------------------------------------------- style

  /** Color every line by the value of `key` (`undefined` restores series colors). */
  setLUT(o: { key: string; lut: LUT } | undefined) {
    const prev = this.lutCfg
    this.lutCfg = o ? { key: o.key, lut: o.lut } : null
    this.syncLUTLegend(prev, this.lutCfg)
    this.invalidateStyle()
    return this
  }
  getLUT() { return this.lutCfg ? { ...this.lutCfg } : undefined }
  private syncLUTLegend(prev: { key: string; lut: LUT } | null, next: { key: string; lut: LUT } | null) {
    if (prev) this.legend.remove(prev.lut)
    if (next) {
      const a = this.axes.find((x) => x.key === next.key)
      this.legend.add(next.lut, { name: a ? a.titleText() : next.key })
    }
  }
  setSpline(v: boolean) { this.spline = v; this.invalidateStyle(); return this }
  getSpline() { return this.spline }
  setSeriesStrokeThickness(t: number) { this.thickness = t; this.invalidateStyle(); return this }
  getSeriesStrokeThickness() { return this.thickness }
  /** Color of lines outside the active range selectors (`undefined` = automatic). */
  setUnselectedSeriesColor(c: Color | undefined) { this.unselected = c ?? null; this.invalidateStyle(); return this }
  /** Sferic extension: alpha multiplier for selected lines (helps dense data). */
  setSeriesOpacity(a: number) { this.opacity = clamp(a, 0, 1); this.invalidateStyle(); return this }

  /** @internal */
  invalidateData() { this.dataDirty = true; this.requestRender() }
  /** @internal */
  invalidateStyle() { this.selDirty = true; this.requestRender() }
  /** @internal */
  onSelectorChange() { this.selDirty = true; this.requestRender() }

  // ---------------------------------------------------------------- data processing

  private update() {
    const N = this.axes.length
    if (this.dataDirty) {
      for (const s of this.series) s.liveIndex = -1
      this.live = this.series.filter((s) => s.visible)
      // Fit to all series so axes stay put while groups are toggled.
      for (const a of this.axes) a.fitTo(this.series)
      const L = this.live.length
      if (this.norm.length < L * N) this.norm = new Float32Array(L * N)
      const norm = this.norm
      for (let i = 0; i < L; i++) {
        const s = this.live[i]
        s.liveIndex = i
        for (let j = 0; j < N; j++) {
          const a = this.axes[j]
          const v = a.toNumber(s.data[a.key])
          norm[i * N + j] = Number.isFinite(v) ? (v - a.start) / (a.end - a.start || 1) : NaN
        }
      }
      this.dataDirty = false
      this.selDirty = true
    }
    if (!this.selDirty) return
    this.selDirty = false
    this.hoverBuilt = null
    // Active brushes in normalized space.
    const active: { j: number; ranges: [number, number][] }[] = []
    this.axes.forEach((a, j) => {
      const ranges: [number, number][] = []
      const k = 1 / (a.end - a.start || 1)
      for (const r of a.selectors) {
        if (r.pending) continue
        const u = (r.start - a.start) * k, w = (r.end - a.start) * k
        ranges.push([Math.min(u, w) - 1e-6, Math.max(u, w) + 1e-6])
      }
      if (ranges.length) active.push({ j, ranges })
    })
    this.anyActive = active.length > 0
    const norm = this.norm
    for (const s of this.live) {
      let ok = true
      const base = s.liveIndex * N
      for (const { j, ranges } of active) {
        const v = norm[base + j]
        let hit = false
        for (const [lo, hi] of ranges) if (v >= lo && v <= hi) { hit = true; break }
        if (!hit) { ok = false; break }
      }
      s.selected = ok
    }
    for (const s of this.series) if (!s.visible) s.selected = false
    // Geometry.
    for (const b of this.batches.values()) { b.dim.clear(); b.sel.clear() }
    if (N >= 2) {
      const dimCol = this.dimColor().toUint32()
      for (const s of this.live) {
        if (s.empty) continue
        const th = this.lineThickness(s)
        let b = this.batches.get(th)
        if (!b) this.batches.set(th, (b = { dim: new SegmentBatch(), sel: new SegmentBatch() }))
        const dim = this.anyActive && !s.selected
        this.pushLine(dim ? b.dim : b.sel, s.liveIndex, dim ? dimCol : this.lineColor(s).toUint32())
      }
    }
    if (this.hasListeners('selectionchange')) this.emit('selectionchange', { selectedSeries: this.getSelectedSeries() })
  }

  private lineThickness(s: ParallelCoordinateSeries) {
    const t = s.thickness ?? this.thickness
    return t < 0 ? 1 : t
  }

  private lineColor(s: ParallelCoordinateSeries): Color {
    let c = s.color
    const cfg = this.lutCfg
    if (cfg) {
      const a = this.axes.find((x) => x.key === cfg.key)
      const raw = s.data[cfg.key]
      const v = a ? a.toNumber(raw) : typeof raw === 'number' ? raw : NaN
      if (Number.isFinite(v)) c = cfg.lut.getColor(v)
    }
    return this.opacity < 1 ? c.setA(c.a * this.opacity) : c
  }

  private dimColor(): Color {
    if (this.unselected) return this.unselected
    const n = Math.max(1, this.live.length)
    const dark = this.theme.isDark
    // Opaque for few lines or splines (translucent capsule joints would show as beads).
    if (this.spline || n <= 1000) return dark ? new Color(74, 74, 78) : new Color(204, 207, 212)
    const a = clamp(70 * Math.sqrt(60 / n), 7, 70)
    return dark ? new Color(200, 200, 200, a) : new Color(40, 40, 40, a)
  }

  private pushLine(b: SegmentBatch, row: number, color: number) {
    const N = this.axes.length
    const norm = this.norm
    const base = row * N
    for (let j = 0; j < N - 1; j++) {
      const a = norm[base + j], c = norm[base + j + 1]
      if (!(a === a) || !(c === c)) continue
      if (!this.spline) {
        b.push(j, a, j + 1, c, color)
        continue
      }
      let px = j, py = a
      for (let k = 1; k <= SPLINE_STEPS; k++) {
        const t = k / SPLINE_STEPS
        const x = j + t, y = a + (c - a) * smooth(t)
        b.push(px, py, x, y, color)
        px = x
        py = y
      }
    }
  }

  // ---------------------------------------------------------------- layout

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    if (this.dataDirty || this.selDirty) this.update()
    const area = this.legend.layout(content)
    const t = this.theme
    const fs = t.fontSize
    const N = this.axes.length
    const top = area.y + fs * 1.5 + 10
    const bottom = area.y + area.h - fs * 0.8
    const h = Math.max(10, bottom - top)
    for (const a of this.axes) a.computeTicks(h)
    const tf = font(t, fs, 600)
    let left = area.x + 20, right = area.x + area.w - 20
    if (N) {
      const first = this.axes[0], last = this.axes[N - 1]
      let lw = 0
      for (const tk of first.ticks) if (tk.label) lw = Math.max(lw, textWidth(tk.label, font(t, tk.level === 0 ? fs : fs * 0.85)))
      left = area.x + Math.max(lw + 14, textWidth(first.titleText(), tf) / 2 + 4, 20)
      right = area.x + area.w - Math.max(N > 1 ? textWidth(last.titleText(), tf) / 2 + 4 : 20, 20)
    }
    this.plot = { x: left, y: top, w: Math.max(1, right - left), h }
    const sp = N > 1 ? this.plot.w / (N - 1) : 0
    this.axes.forEach((a, i) => (a.px = N > 1 ? left + i * sp : left + this.plot.w / 2))
  }

  private maps(): { mx: AxisMap; my: AxisMap } {
    const p = this.plot
    const N = this.axes.length
    return {
      mx: { a0: p.x, start: 0, k: N > 1 ? p.w / (N - 1) : 0, log: 0 },
      my: { a0: p.y + p.h, start: 0, k: -p.h, log: 0 },
    }
  }

  // ---------------------------------------------------------------- drawing

  override hasGL() { return this.series.length > 0 && this.axes.length >= 2 }

  override drawGL(r: GLRenderer) {
    if (this.axes.length < 2 || !this.live.length) return
    const p = this.plot
    const maps = this.maps()
    r.scissor({ x: p.x - 3, y: p.y - 4, w: p.w + 6, h: p.h + 8 })
    r.glow = 0
    for (const [th, b] of this.batches) b.dim.draw(r, maps, th)
    const glowOn = this.theme.glow.enabled
    r.glow = glowOn ? (this.live.length > 1500 ? 0.3 : 0.8) : 0
    for (const [th, b] of this.batches) b.sel.draw(r, maps, th)
    const hs = this.hovered
    if (hs && hs.liveIndex >= 0 && !hs.empty) {
      if (this.hoverBuilt !== hs) {
        this.hoverBatch.clear()
        this.pushLine(this.hoverBatch, hs.liveIndex, this.hoverColor(hs).toUint32())
        this.hoverBuilt = hs
      }
      r.glow = glowOn ? 1 : 0
      this.hoverBatch.draw(r, maps, Math.max(2.5, this.lineThickness(hs) + 1.5))
    }
    r.scissor(null)
    r.glow = 0
  }

  private hoverColor(s: ParallelCoordinateSeries): Color {
    const c = this.lineColor(s).setA(255)
    return this.theme.isDark ? c.mix(new Color(255, 255, 255), 0.3) : c.scale(0.85)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = t.fontSize
    const p = this.plot
    const halo = t.isDark ? 'rgba(0,0,0,0.75)' : 'rgba(255,255,255,0.85)'
    const N = this.axes.length
    const sp = N > 1 ? p.w / (N - 1) : p.w
    ctx.lineJoin = 'round'
    for (const a of this.axes) {
      const x = Math.round(a.px) + 0.5
      // range selectors
      for (const sel of a.selectors) {
        if (sel.pending) continue
        const y0 = clamp(a.valueToPx(sel.start), p.y, p.y + p.h)
        const y1 = clamp(a.valueToPx(sel.end), p.y, p.y + p.h)
        const top = Math.min(y0, y1), bot = Math.max(y0, y1)
        roundRect(ctx, x - 8, top, 16, Math.max(2, bot - top), 3)
        ctx.fillStyle = t.zoomRectFill.setA(Math.max(t.zoomRectFill.a, 90)).toCSS()
        ctx.fill()
        ctx.strokeStyle = halo
        ctx.lineWidth = 3
        ctx.stroke()
        ctx.strokeStyle = t.zoomRectStroke.setA(255).toCSS()
        ctx.lineWidth = 1.5
        ctx.stroke()
        for (const hy of [top, bot]) {
          roundRect(ctx, x - 12, hy - 2.5, 24, 5, 2)
          ctx.fillStyle = t.zoomRectStroke.setA(255).toCSS()
          ctx.fill()
          ctx.strokeStyle = halo
          ctx.lineWidth = 1
          ctx.stroke()
        }
      }
      // axis line
      const hot = this.hoverAxis === a || (this.drag && this.drag.axis === a)
      ctx.strokeStyle = (hot ? t.examples.highlightColor : t.axisLineColor).toCSS()
      ctx.lineWidth = hot ? 2 : 1
      ctx.beginPath()
      ctx.moveTo(x, p.y)
      ctx.lineTo(x, p.y + p.h)
      ctx.stroke()
      // ticks
      ctx.strokeStyle = t.tickColor.toCSS()
      ctx.lineWidth = 1
      ctx.beginPath()
      for (const tk of a.ticks) {
        const py = Math.round(a.valueToPx(tk.value)) + 0.5
        if (py < p.y - 0.5 || py > p.y + p.h + 0.5) continue
        const len = tk.level === 0 ? 5 : 3
        ctx.moveTo(x - len, py)
        ctx.lineTo(x, py)
      }
      ctx.stroke()
      // labels with a halo so they stay readable over dense lines
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      ctx.lineWidth = 3
      ctx.strokeStyle = halo
      for (const tk of a.ticks) {
        if (!tk.label) continue
        const py = a.valueToPx(tk.value)
        if (py < p.y - 1 || py > p.y + p.h + 1) continue
        ctx.font = font(t, tk.level === 0 ? fs : fs * 0.85)
        ctx.fillStyle = (tk.level === 0 ? t.tickLabelColor : t.minorTickLabelColor).toCSS()
        const ly = clamp(py, p.y + fs * 0.5 - 2, p.y + p.h - fs * 0.5 + 2)
        ctx.strokeText(tk.label, x - 8, ly)
        ctx.fillText(tk.label, x - 8, ly)
      }
      // title
      ctx.font = font(t, fs, 600)
      ctx.fillStyle = t.axisTitleColor.toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(a.titleText(), x, p.y - 8, Math.max(30, sp - 8))
    }
    this.drawHover(ctx)
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawHover(ctx: CanvasRenderingContext2D) {
    const s = this.hovered
    if (!s || s.liveIndex < 0 || this.drag) return
    const t = this.theme
    const p = this.plot
    const N = this.axes.length
    const col = this.hoverColor(s)
    for (let j = 0; j < N; j++) {
      const v = this.norm[s.liveIndex * N + j]
      if (!(v === v)) continue
      const x = this.axes[j].px, y = p.y + p.h - v * p.h
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = col.toCSS()
      ctx.fill()
      ctx.strokeStyle = t.isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
    if (!this.pointer) return
    const rows: { k: string; v: string; color?: Color }[] = [{ k: s.getName(), v: '', color: col }]
    for (const a of this.axes) rows.push({ k: a.titleText(), v: a.formatValue(s.data[a.key]) })
    this.drawTable(ctx, rows, this.pointer.x, this.pointer.y)
  }

  private drawTable(ctx: CanvasRenderingContext2D, rows: { k: string; v: string; color?: Color }[], px: number, py: number) {
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs)
    const bold = font(t, fs, 600)
    let kw = 0, vw = 0, single = 0
    for (const r of rows) {
      if (!r.v) single = Math.max(single, textWidth(r.k, bold))
      else {
        kw = Math.max(kw, textWidth(r.k, fnt))
        vw = Math.max(vw, textWidth(r.v, fnt))
      }
    }
    const pad = 8
    const lh = fs * 1.45
    const w = Math.max(kw + vw + 16, single) + pad * 2
    const h = rows.length * lh + pad * 2 - (lh - fs)
    const R = this.rect
    let x = px + 16, y = py - h - 12
    if (x + w > R.x + R.w - 4) x = px - w - 16
    if (y < R.y + 4) y = py + 16
    if (y + h > R.y + R.h - 4) y = R.y + R.h - h - 4
    x = Math.max(R.x + 4, x)
    roundRect(ctx, x, y, w, h, 5)
    ctx.fillStyle = t.cursor.tableFill.toCSS()
    ctx.fill()
    ctx.strokeStyle = t.cursor.tableStroke.toCSS()
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textBaseline = 'middle'
    rows.forEach((r, i) => {
      const cy = y + pad + i * lh + fs / 2 + 1
      ctx.font = r.v ? fnt : bold
      ctx.fillStyle = (r.color ?? t.cursor.textColor).toCSS()
      ctx.textAlign = 'left'
      ctx.fillText(r.k, x + pad, cy)
      if (r.v) {
        ctx.textAlign = 'right'
        ctx.fillText(r.v, x + w - pad, cy)
      }
    })
  }

  // ---------------------------------------------------------------- interaction

  private axisAt(x: number, y: number): ParallelCoordinateAxis | null {
    const p = this.plot
    if (y < p.y - 6 || y > p.y + p.h + 6) return null
    let best: ParallelCoordinateAxis | null = null
    let bd = AXIS_GRAB
    for (const a of this.axes) {
      const d = Math.abs(x - a.px)
      if (d <= bd) { bd = d; best = a }
    }
    return best
  }

  private nearestSeries(x: number, y: number): ParallelCoordinateSeries | null {
    const N = this.axes.length, L = this.live.length
    if (N < 2 || !L) return null
    const p = this.plot
    const sp = p.w / (N - 1)
    const fx = clamp((x - p.x) / sp, 0, N - 1)
    const j = Math.min(N - 2, Math.floor(fx))
    const t = fx - j
    const s = this.spline ? smooth(t) : t
    const ds = this.spline ? 6 * t * (1 - t) : 1
    const ny = (p.y + p.h - y) / p.h
    const norm = this.norm
    let best: ParallelCoordinateSeries | null = null
    let bd = HOVER_TOL
    for (let i = 0; i < L; i++) {
      const sr = this.live[i]
      if (sr.empty || (this.anyActive && !sr.selected)) continue
      const a = norm[i * N + j], c = norm[i * N + j + 1]
      if (!(a === a) || !(c === c)) continue
      const dy = Math.abs(a + (c - a) * s - ny) * p.h
      const slope = ((c - a) * p.h * ds) / sp
      const d = dy / Math.sqrt(1 + slope * slope)
      if (d <= bd) { bd = d; best = sr }
    }
    return best
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') return this.legend.onPointer('click', x, y)
    if (e.type === 'move' && !this.drag && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      this.hovered = null
      this.hoverAxis = null
      return true
    }
    if (e.type === 'down' && this.legend.contains(x, y)) return true
    switch (e.type) {
      case 'down': return this.onDown(e)
      case 'move': return this.onMove(e)
      case 'up': return this.onUp()
      case 'dblclick': {
        const h = this.axisAt(x, y)?.selectorAt(y)
        if (!h) return false
        h.sel.dispose()
        return true
      }
      case 'leave': {
        const had = !!this.hovered || !!this.hoverAxis
        this.pointer = null
        this.hovered = null
        this.hoverAxis = null
        return had
      }
    }
    return false
  }

  private onDown(e: PointerInfo): boolean {
    if (e.button !== 0) return false
    const a = this.axisAt(e.x, e.y)
    if (!a) return false
    const h = a.selectorAt(e.y)
    if (h && h.edge !== 'body') {
      this.drag = { kind: 'resize', axis: a, sel: h.sel, fixed: h.edge === 'start' ? h.sel.end : h.sel.start }
    } else if (h) {
      this.drag = { kind: 'move', axis: a, sel: h.sel, last: a.pxToValue(e.y) }
    } else {
      const v = a.clampValue(a.pxToValue(e.y))
      const sel = new ParallelCoordinateRangeSelector(a)
      sel.start = sel.end = v
      sel.pending = true
      a.selectors.push(sel)
      this.drag = { kind: 'create', axis: a, sel, v0: v, y0: e.y }
    }
    this.hovered = null
    return true
  }

  private onMove(e: PointerInfo): boolean {
    const { x, y } = e
    const d = this.drag
    if (d) {
      const v = d.axis.clampValue(d.axis.pxToValue(y))
      if (d.kind === 'create') {
        if (d.sel.pending && Math.abs(y - d.y0) < 3) return false
        d.sel.pending = false
        d.sel.setInterval(d.v0, v)
      } else if (d.kind === 'resize') {
        d.sel.setInterval(d.fixed, v)
      } else {
        const a = d.axis
        const lo = Math.min(a.start, a.end), hi = Math.max(a.start, a.end)
        const raw = a.pxToValue(y)
        let dv = raw - d.last
        dv = clamp(dv, lo - d.sel.start, hi - d.sel.end)
        d.last += dv
        d.sel.setInterval(d.sel.start + dv, d.sel.end + dv)
      }
      return true
    }
    this.pointer = { x, y }
    const a = this.axisAt(x, y)
    let cursor = 'default'
    if (a) {
      const h = a.selectorAt(y)
      cursor = h ? (h.edge === 'body' ? 'move' : 'ns-resize') : 'crosshair'
    }
    const p = this.plot
    const inPlot = rectContains({ x: p.x - AXIS_GRAB, y: p.y - 6, w: p.w + AXIS_GRAB * 2, h: p.h + 12 }, x, y)
    const hit = inPlot ? this.nearestSeries(x, y) : null
    this.surface.setCursor(cursor)
    const changed = hit !== this.hovered || a !== this.hoverAxis
    this.hovered = hit
    this.hoverAxis = a
    return changed || !!hit
  }

  private onUp(): boolean {
    const d = this.drag
    this.drag = null
    if (!d) return false
    if (d.kind === 'create' && d.sel.pending) {
      // A click on an axis outside any selector clears that axis' selectors.
      d.sel.dispose()
      d.axis.clearRangeSelectors()
    }
    return true
  }

  override disposeGL(r: GLRenderer | null) {
    for (const b of this.batches.values()) {
      b.dim.dispose(r)
      b.sel.dispose(r)
    }
    this.hoverBatch.dispose(r)
    this.hoverBuilt = null
  }
}
