import { Color } from '../core/color'
import { Fill, LineStyle, Mutator, resolve, SolidFill, SolidLine, fillToCanvas, applyLineToCanvas, DashedLine, StipplePatterns, emptyLine, isEmptyLine } from '../core/style'
import { font } from '../core/theme'
import { Emitter, Easings, Rect, roundRect, textWidth, Tween } from '../core/util'
import { AxisMap } from '../render/GLRenderer'
import { AxisTickStrategies, Tick, TickStrategy } from './ticks'
import type { ChartXY } from './ChartXY'

export type ScrollStrategy = 'fitting' | 'expansion' | 'progressive' | 'regressive' | 'scrolling' | undefined
export const AxisScrollStrategies = {
  fitting: 'fitting',
  expansion: 'expansion',
  progressive: 'progressive',
  regressive: 'regressive',
  scrolling: 'scrolling',
} as const

export interface IntervalArgs {
  start: number
  end: number
  stopAxisAfter?: boolean
  animate?: boolean | number
}
export interface DataState { dataMin: number | undefined; dataMax: number | undefined; dataRange: number | undefined }

export interface AxisOptions {
  opposite?: boolean
  iStack?: number
  type?: 'linear' | 'logarithmic' | 'linear-highPrecision'
  base?: number | 'e'
}

const TICK_MAJOR = 6
const TICK_MINOR = 3
const LABEL_GAP = 4

/** Value marker on an axis: band, constant line or custom tick share drag behaviour. */
abstract class AxisMarker extends Emitter {
  visible = true
  draggable = true
  name = ''
  constructor(protected axis: Axis, readonly onTop: boolean) { super() }
  setName(n: string) { this.name = n; this.axis.chart.requestRender(); return this }
  getName() { return this.name }
  setVisible(v: boolean) { this.visible = v; this.axis.chart.requestRender(); return this }
  getVisible() { return this.visible }
  setMouseInteractions(v: boolean) { this.draggable = v; return this }
  setPointerEvents(v: boolean) { this.draggable = v; return this }
  dispose() { this.axis.removeMarker(this); return this }
}

export class Band extends AxisMarker {
  start = 0
  end = 0
  fill: Fill
  stroke: LineStyle
  constructor(axis: Axis, onTop: boolean) {
    super(axis, onTop)
    const t = axis.chart.getTheme()
    this.fill = new SolidFill({ color: t.bandFill })
    this.stroke = new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: t.bandFill.setA(140) }) })
  }
  setValueStart(v: number) { this.start = v; this.axis.chart.requestRender(); this.emit('valuechange', { start: this.start, end: this.end }); return this }
  setValueEnd(v: number) { this.end = v; this.axis.chart.requestRender(); this.emit('valuechange', { start: this.start, end: this.end }); return this }
  getValueStart() { return this.start }
  getValueEnd() { return this.end }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.axis.chart.requestRender(); return this }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.axis.chart.requestRender(); return this }
  getFillStyle() { return this.fill }
}

export class ConstantLine extends AxisMarker {
  value = 0
  stroke: LineStyle
  constructor(axis: Axis, onTop: boolean) {
    super(axis, onTop)
    this.stroke = new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: axis.chart.getTheme().constantLineColor }) })
  }
  setValue(v: number) { this.value = v; this.axis.chart.requestRender(); this.emit('valuechange', { value: v }); return this }
  getValue() { return this.value }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.axis.chart.requestRender(); return this }
  getStrokeStyle() { return this.stroke }
}

export class CustomTick extends AxisMarker {
  value = 0
  text: string | null = null
  formatter: ((v: number, t: CustomTick) => string) | null = null
  gridStroke: LineStyle | null = null
  labelColor: Color | null = null
  tickLength = TICK_MAJOR
  constructor(axis: Axis) { super(axis, true) }
  setValue(v: number) { this.value = v; this.axis.chart.requestRender(); return this }
  getValue() { return this.value }
  setTextFormatter(f: (v: number, t: CustomTick) => string) { this.formatter = f; this.axis.chart.requestRender(); return this }
  setText(t: string) { this.text = t; this.axis.chart.requestRender(); return this }
  setGridStrokeStyle(l: LineStyle) { this.gridStroke = l; return this }
  setGridStrokeLength(_n: number) { return this }
  setTickLength(n: number) { this.tickLength = n; return this }
  setLabelFillStyle(f: Fill) { this.labelColor = f.getPrimaryColor(); return this }
  setMarker(f: (m: any) => any) {
    const self = this
    const api: any = {
      setTextFillStyle: (fill: Fill) => { self.labelColor = fill.getPrimaryColor(); return api },
      setTextFont: () => api,
      setBackground: () => api,
      setVisible: (v: boolean) => { self.visible = v; return api },
      setTickLength: (n: number) => { self.tickLength = n; return api },
    }
    f(api)
    return this
  }
  label(): string {
    if (this.text !== null) return this.text
    if (this.formatter) return this.formatter(this.value, this)
    return this.axis.formatValue(this.value)
  }
}

export class Axis extends Emitter {
  readonly dim: 'x' | 'y'
  opposite: boolean
  iStack: number
  log = 0
  start = 0
  end = 1
  private initialized = false
  /** Scrolling/fitting halted by user interaction or explicit interval. */
  stopped = false
  scroll: ScrollStrategy = 'fitting'
  defaultInterval: ((s: DataState) => { start?: number; end?: number; stopAxisAfter?: boolean }) | null = null
  strategy: TickStrategy
  title = ''
  units = ''
  titleColor: Color | null = null
  visible = true
  labelsVisible = true
  margins: [number, number] = [0, 0]
  lengthWeight = 1
  lengthPx: number | null = null
  fixedThickness: number | null = null
  interactions = true
  animationsEnabled = true
  strokeStyle: LineStyle
  fitMargin: number
  /** Y axes: fit to the data inside the current X interval instead of all data. */
  fitVisible = false
  /** Layout results (CSS px). px0 corresponds to start, px1 to end. */
  px0 = 0
  px1 = 1
  /** Perpendicular position of the axis line. */
  pos = 0
  thickness = 0
  ticks: Tick[] = []
  bands: Band[] = []
  lines: ConstantLine[] = []
  customTicks: CustomTick[] = []
  private tween: Tween | null = null
  private intervalFromUser = false
  readonly chart: ChartXY

  constructor(chart: ChartXY, dim: 'x' | 'y', o: AxisOptions = {}) {
    super()
    this.chart = chart
    this.dim = dim
    this.opposite = !!o.opposite
    this.iStack = o.iStack ?? 0
    if (o.type === 'logarithmic') {
      this.log = o.base === 'e' ? Math.E : (o.base as number) || 10
      this.start = 1
      this.end = 10
    }
    this.strategy = cloneStrategy(AxisTickStrategies.Numeric)
    const t = chart.getTheme()
    this.strokeStyle = new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: t.axisLineColor }) })
    this.fitMargin = dim === 'y' ? 0.04 : 0
  }

  // ---------------------------------------------------------------- configuration API

  setTitle(t: string) { this.title = t; this.chart.requestRender(); return this }
  getTitle() { return this.title }
  setUnits(u: string) { this.units = u; this.chart.requestRender(); return this }
  getUnits() { return this.units }
  setTitleFillStyle(f: Fill | ((prev: SolidFill) => Fill)) {
    const prev = new SolidFill({ color: this.titleColor ?? this.chart.getTheme().axisTitleColor })
    this.titleColor = (typeof f === 'function' ? f(prev) : f).getPrimaryColor()
    this.chart.requestRender()
    return this
  }
  setTitleFont(_f: any) { return this }
  setTitleRotation(_r: number) { return this }
  setTickStrategy<T extends TickStrategy>(s: T, styler?: (s: T) => T) {
    let st = cloneStrategy(s)
    if (styler) st = styler(st)
    this.strategy = st
    this.chart.requestRender()
    return this
  }
  getTickStrategy() { return this.strategy.type }
  setScrollStrategy(s: ScrollStrategy) {
    this.scroll = s
    this.stopped = false
    this.chart.requestRender()
    return this
  }
  getScrollStrategy() { return this.scroll }
  setDefaultInterval(f: ((s: DataState) => { start?: number; end?: number; stopAxisAfter?: boolean }) | { start: number; end: number }) {
    this.defaultInterval = typeof f === 'function' ? f : () => f
    this.stopped = false
    this.chart.requestRender()
    return this
  }
  setMargins(start: number, end: number) { this.margins = [start, end]; this.chart.requestRender(); return this }
  setLength(l: { relative?: number; pixels?: number }) {
    if (l.pixels !== undefined) this.lengthPx = l.pixels
    if (l.relative !== undefined) { this.lengthWeight = l.relative; this.lengthPx = null }
    this.chart.requestRender()
    return this
  }
  setThickness(t: number | { min?: number; max?: number }) {
    this.fixedThickness = typeof t === 'number' ? t : t.min ?? null
    this.chart.requestRender()
    return this
  }
  setVisible(v: boolean) { this.visible = v; this.chart.requestRender(); return this }
  getVisible() { return this.visible }
  setTickLabelsVisible(v: boolean) { this.labelsVisible = v; this.chart.requestRender(); return this }
  setStrokeStyle(l: Mutator<LineStyle>) { this.strokeStyle = resolve(this.strokeStyle, l); this.chart.requestRender(); return this }
  setMouseInteractions(v: boolean) { this.interactions = v; return this }
  setPointerEvents(v: boolean) { this.interactions = v; return this }
  setAnimationsEnabled(v: boolean) { this.animationsEnabled = v; return this }
  setAnimationScroll(_v: boolean) { return this }
  setAnimationZoom(_v: boolean) { return this }
  setChartInteractionZoomByWheel(v: boolean) { this.interactions = v; return this }
  setNibInteractionScaleByDragging(_v: boolean) { return this }
  isLogarithmic() { return this.log > 0 }
  /** Fit this (Y) axis to data within the visible X range of each series. */
  setFitToVisibleData(v: boolean) { this.fitVisible = v; this.chart.requestRender(); return this }
  /** Relative margin added around data when fitting (default 0.04 for Y, 0 for X). */
  setFitMargin(m: number) { this.fitMargin = m; this.chart.requestRender(); return this }
  dispose() { this.chart.removeAxis(this); return this }

  addBand(onTop = false) {
    const b = new Band(this, onTop)
    const { start, end } = this.getInterval()
    b.start = start + (end - start) * 0.4
    b.end = start + (end - start) * 0.6
    this.bands.push(b)
    this.chart.requestRender()
    return b
  }
  addConstantLine(onTop = false) {
    const l = new ConstantLine(this, onTop)
    const { start, end } = this.getInterval()
    l.value = (start + end) / 2
    this.lines.push(l)
    this.chart.requestRender()
    return l
  }
  addCustomTick(_kind?: unknown) {
    const t = new CustomTick(this)
    this.customTicks.push(t)
    this.chart.requestRender()
    return t
  }
  removeMarker(m: AxisMarker) {
    this.bands = this.bands.filter((b) => b !== m)
    this.lines = this.lines.filter((b) => b !== m)
    this.customTicks = this.customTicks.filter((b) => b !== m)
    this.chart.requestRender()
  }

  // ---------------------------------------------------------------- interval

  getInterval() { return { start: this.start, end: this.end } }
  private fwd(v: number) { return this.log ? Math.log(v) / Math.log(this.log) : v }
  private inv(v: number) { return this.log ? Math.pow(this.log, v) : v }

  setInterval(a: IntervalArgs | number, end?: number, animate?: boolean | number) {
    const args: IntervalArgs = typeof a === 'number' ? { start: a, end: end!, animate } : a
    if (!(Number.isFinite(args.start) && Number.isFinite(args.end))) return this
    this.initialized = true
    this.stopped = args.stopAxisAfter ?? true
    this.intervalFromUser = true
    this.applyInterval(args.start, args.end, args.animate)
    return this
  }

  /** Internal interval change (from scroll strategy or interaction). */
  applyInterval(s: number, e: number, animate?: boolean | number) {
    if (this.log) {
      if (!(s > 0)) s = this.start > 0 ? this.start : 1e-3
      if (!(e > 0)) e = Math.max(s * 10, 1)
    }
    if (s === e) {
      const d = Math.abs(s) * 0.05 || 1
      s -= d
      e += d
    }
    const dur = animate === true ? 600 : typeof animate === 'number' ? animate : 0
    this.tween?.cancel()
    this.tween = null
    if (dur > 0 && this.animationsEnabled) {
      const from = [this.fwd(this.start), this.fwd(this.end)]
      const to = [this.fwd(s), this.fwd(e)]
      this.tween = new Tween(from, to, dur, (v) => this.set(this.inv(v[0]), this.inv(v[1])), Easings.easeInOut)
      this.chart.addTween(this.tween)
    } else {
      this.set(s, e)
    }
  }

  private set(s: number, e: number) {
    if (s === this.start && e === this.end) return
    this.start = s
    this.end = e
    this.chart.requestRender()
    this.emit('intervalchange', { start: s, end: e })
    this.chart.onAxisIntervalChanged(this)
  }

  /** Callback-style interval listener. */
  onIntervalChange(fn: (axis: Axis, start: number, end: number) => void) {
    const l = (ev: { start: number; end: number }) => fn(this, ev.start, ev.end)
    this.addEventListener('intervalchange', l)
    return () => this.removeEventListener('intervalchange', l)
  }

  /** Run scroll strategy against current data extents. */
  updateScroll(dmin: number, dmax: number, tight = false) {
    if (this.tween && !this.tween.done) return
    const have = Number.isFinite(dmin) && Number.isFinite(dmax)
    if (this.defaultInterval && !this.stopped) {
      const r = this.defaultInterval({ dataMin: have ? dmin : undefined, dataMax: have ? dmax : undefined, dataRange: have ? dmax - dmin : undefined })
      if (r && Number.isFinite(r.start) && Number.isFinite(r.end)) {
        this.applyInterval(r.start!, r.end!)
        this.initialized = true
        if (r.stopAxisAfter) this.stopped = true
        if (this.scroll === 'scrolling' || this.scroll === undefined || !r.stopAxisAfter) return
      }
    }
    if (!have || this.stopped) return
    if (this.log) {
      if (dmin <= 0) dmin = Math.max(dmin, Math.min(dmax / 1e3, 1e-3))
    }
    const margin = (lo: number, hi: number): [number, number] => {
      if (this.fitMargin <= 0 || this.log || tight) return [lo, hi]
      const m = (hi - lo) * this.fitMargin
      return [lo - m, hi + m]
    }
    if (!this.initialized) {
      this.initialized = true
      const [a, b] = margin(dmin, dmax)
      this.applyInterval(a, b)
      return
    }
    const lo = Math.min(this.start, this.end), hi = Math.max(this.start, this.end)
    const inv = this.start > this.end
    const put = (a: number, b: number) => (inv ? this.applyInterval(b, a) : this.applyInterval(a, b))
    switch (this.scroll) {
      case 'fitting': {
        const [a, b] = margin(dmin, dmax)
        put(a, b)
        break
      }
      case 'expansion': {
        const [a, b] = margin(dmin, dmax)
        put(Math.min(lo, a), Math.max(hi, b))
        break
      }
      case 'progressive': {
        if (dmax > hi) put(dmax - (hi - lo), dmax)
        break
      }
      case 'regressive': {
        if (dmin < lo) put(dmin, dmin + (hi - lo))
        break
      }
      case 'scrolling': {
        put(dmax - (hi - lo), dmax)
        break
      }
      default:
        break
    }
  }

  /** Fit interval to data (user "reset"). */
  fit(animate: boolean | number = true, stopAxisAfter = false) {
    const b = this.chart.dataExtent(this)
    this.stopped = false
    this.intervalFromUser = false
    if (this.defaultInterval) {
      const have = Number.isFinite(b.min)
      const r = this.defaultInterval({ dataMin: have ? b.min : undefined, dataMax: have ? b.max : undefined, dataRange: have ? b.max - b.min : undefined })
      if (r && Number.isFinite(r.start) && Number.isFinite(r.end)) {
        this.applyInterval(r.start!, r.end!, animate)
        this.stopped = !!stopAxisAfter
        return this
      }
    }
    if (Number.isFinite(b.min) && Number.isFinite(b.max)) {
      let lo = b.min, hi = b.max
      if (this.fitMargin > 0 && !this.log && !b.tight) {
        const m = (hi - lo) * this.fitMargin
        lo -= m
        hi += m
      }
      if (this.start > this.end) this.applyInterval(hi, lo, animate)
      else this.applyInterval(lo, hi, animate)
    }
    this.stopped = !!stopAxisAfter
    return this
  }

  /** User-driven zoom; stops automatic scrolling. */
  zoomAround(px: number, factor: number) {
    const c = this.fwd(this.pxToValue(px))
    const s = this.fwd(this.start), e = this.fwd(this.end)
    // Stop zooming in before the interval approaches float64 resolution.
    if (factor < 1 && Math.abs(e - s) * factor < Math.max(Math.abs(c), Math.abs(s), Math.abs(e)) * 1e-12) return
    this.stopped = true
    this.tween?.cancel()
    this.set(this.inv(c + (s - c) * factor), this.inv(c + (e - c) * factor))
  }
  panPx(dpx: number) {
    const k = (this.fwd(this.end) - this.fwd(this.start)) / (this.px1 - this.px0 || 1)
    const d = -dpx * k
    this.stopped = true
    this.tween?.cancel()
    this.set(this.inv(this.fwd(this.start) + d), this.inv(this.fwd(this.end) + d))
  }

  // ---------------------------------------------------------------- mapping

  map(): AxisMap {
    const fs = this.fwd(this.start), fe = this.fwd(this.end)
    return { a0: this.px0, start: this.start, k: (this.px1 - this.px0) / (fe - fs || 1), log: this.log }
  }
  valueToPx(v: number): number {
    const fs = this.fwd(this.start), fe = this.fwd(this.end)
    return this.px0 + ((this.fwd(v) - fs) / (fe - fs || 1)) * (this.px1 - this.px0)
  }
  pxToValue(px: number): number {
    const fs = this.fwd(this.start), fe = this.fwd(this.end)
    return this.inv(fs + ((px - this.px0) / (this.px1 - this.px0 || 1)) * (fe - fs))
  }
  formatValue(v: number): string { return this.strategy.formatValue(v, this.getInterval()) }
  formatCursor(v: number): string { return this.strategy.formatCursor(v, this.getInterval()) }

  get lo() { return Math.min(this.start, this.end) }
  get hi() { return Math.max(this.start, this.end) }
  get length() { return Math.abs(this.px1 - this.px0) }

  // ---------------------------------------------------------------- layout

  titleText() { return this.title + (this.units ? ` (${this.units})` : '') }

  /** Fixed part of thickness for X axes (labels height + title). */
  measureThicknessX(): number {
    if (!this.visible) return 0
    if (this.fixedThickness !== null) return this.fixedThickness
    const fs = this.chart.getTheme().fontSize
    const labels = this.labelsVisible && (this.strategy.type !== 'Empty' || this.customTicks.some((c) => c.visible))
    let t = TICK_MAJOR + LABEL_GAP + (labels ? fs * 1.25 : 0)
    if (this.title || this.units) t += fs * 1.5 + 2
    return t + 2
  }

  /** Generate ticks for the current length; Y thickness depends on label widths. */
  computeTicks() {
    const t = this.chart.getTheme()
    const fs = t.fontSize
    this.ticks = this.visible || this.chart.gridFor(this)
      ? this.strategy.generate({
          lo: this.lo,
          hi: this.hi,
          length: this.length,
          horizontal: this.dim === 'x',
          log: this.log,
          measure: (s, level) => textWidth(s, font(t, level === 0 ? fs : fs * 0.85)),
          fontSize: fs,
        })
      : []
  }

  measureThicknessY(): number {
    if (!this.visible) return 0
    if (this.fixedThickness !== null) return this.fixedThickness
    const t = this.chart.getTheme()
    const fs = t.fontSize
    let w = 0
    if (this.labelsVisible) {
      for (const tk of this.ticks) if (tk.label) w = Math.max(w, textWidth(tk.label, font(t, tk.level === 0 ? fs : fs * 0.85)))
      for (const ct of this.customTicks) w = Math.max(w, textWidth(ct.label(), font(t, fs)))
    }
    let th = TICK_MAJOR + LABEL_GAP + w
    if (this.title || this.units) th += fs * 1.5 + 2
    return Math.max(th + 2, 24)
  }

  // ---------------------------------------------------------------- drawing

  drawGrid(ctx: CanvasRenderingContext2D, plot: Rect) {
    const t = this.chart.getTheme()
    const st = this.strategy
    ctx.lineWidth = 1
    for (const level of [1, 0] as const) {
      const show = level === 0 ? st.majorGridVisible : st.minorGridVisible
      if (!show) continue
      ctx.strokeStyle = (level === 0 ? t.gridMajorColor : t.gridMinorColor).toCSS()
      ctx.beginPath()
      for (const tk of this.ticks) {
        if ((tk.level === 0 ? 0 : 1) !== level) continue
        const p = Math.round(this.valueToPx(tk.value)) + 0.5
        if (this.dim === 'x') {
          if (p < plot.x - 0.5 || p > plot.x + plot.w + 0.5) continue
          ctx.moveTo(p, plot.y)
          ctx.lineTo(p, plot.y + plot.h)
        } else {
          if (p < plot.y - 0.5 || p > plot.y + plot.h + 0.5) continue
          ctx.moveTo(plot.x, p)
          ctx.lineTo(plot.x + plot.w, p)
        }
      }
      ctx.stroke()
    }
    for (const ct of this.customTicks) {
      if (!ct.visible || !ct.gridStroke || isEmptyLine(ct.gridStroke)) continue
      const p = Math.round(this.valueToPx(ct.value)) + 0.5
      if (applyLineToCanvas(ctx, ct.gridStroke)) {
        ctx.beginPath()
        if (this.dim === 'x') { ctx.moveTo(p, plot.y); ctx.lineTo(p, plot.y + plot.h) }
        else { ctx.moveTo(plot.x, p); ctx.lineTo(plot.x + plot.w, p) }
        ctx.stroke()
      }
    }
  }

  /** Bands and constant lines (either below or above series). */
  drawMarkers(ctx: CanvasRenderingContext2D, plot: Rect, onTop: boolean) {
    ctx.save()
    ctx.beginPath()
    ctx.rect(plot.x, plot.y, plot.w, plot.h)
    ctx.clip()
    for (const b of this.bands) {
      if (!b.visible || b.onTop !== onTop) continue
      const a = this.valueToPx(b.start), c = this.valueToPx(b.end)
      const lo = Math.min(a, c), hi = Math.max(a, c)
      const r = this.dim === 'x' ? { x: lo, y: plot.y, w: hi - lo, h: plot.h } : { x: plot.x, y: lo, w: plot.w, h: hi - lo }
      const paint = fillToCanvas(ctx, b.fill, r.x, r.y, r.w, r.h)
      if (paint) {
        ctx.fillStyle = paint
        ctx.fillRect(r.x, r.y, r.w, r.h)
      }
      if (applyLineToCanvas(ctx, b.stroke)) {
        ctx.beginPath()
        if (this.dim === 'x') {
          ctx.moveTo(lo, plot.y); ctx.lineTo(lo, plot.y + plot.h)
          ctx.moveTo(hi, plot.y); ctx.lineTo(hi, plot.y + plot.h)
        } else {
          ctx.moveTo(plot.x, lo); ctx.lineTo(plot.x + plot.w, lo)
          ctx.moveTo(plot.x, hi); ctx.lineTo(plot.x + plot.w, hi)
        }
        ctx.stroke()
      }
    }
    for (const l of this.lines) {
      if (!l.visible || l.onTop !== onTop) continue
      const p = this.valueToPx(l.value)
      if (applyLineToCanvas(ctx, l.stroke)) {
        ctx.beginPath()
        if (this.dim === 'x') { ctx.moveTo(p, plot.y); ctx.lineTo(p, plot.y + plot.h) }
        else { ctx.moveTo(plot.x, p); ctx.lineTo(plot.x + plot.w, p) }
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  drawAxis(ctx: CanvasRenderingContext2D) {
    if (!this.visible) return
    const t = this.chart.getTheme()
    const fs = t.fontSize
    const st = this.strategy
    const lo = Math.min(this.px0, this.px1), hi = Math.max(this.px0, this.px1)
    const dir = this.opposite ? -1 : 1 // ticks extend outward: +down/left for default sides
    ctx.lineWidth = 1
    // axis line
    if (applyLineToCanvas(ctx, this.strokeStyle)) {
      ctx.beginPath()
      if (this.dim === 'x') {
        const y = Math.round(this.pos) + 0.5
        ctx.moveTo(lo, y)
        ctx.lineTo(hi, y)
      } else {
        const x = Math.round(this.pos) + 0.5
        ctx.moveTo(x, lo)
        ctx.lineTo(x, hi)
      }
      ctx.stroke()
    }
    ctx.strokeStyle = t.tickColor.toCSS()
    ctx.setLineDash([])
    ctx.beginPath()
    for (const tk of this.ticks) {
      const vis = tk.level === 0 ? st.majorTicksVisible : st.minorTicksVisible
      if (!vis) continue
      const p = Math.round(this.valueToPx(tk.value)) + 0.5
      if (p < lo - 0.5 || p > hi + 0.5) continue
      const len = tk.level === 0 ? TICK_MAJOR : TICK_MINOR
      if (this.dim === 'x') {
        ctx.moveTo(p, this.pos)
        ctx.lineTo(p, this.pos + len * dir)
      } else {
        ctx.moveTo(this.pos, p)
        ctx.lineTo(this.pos - len * dir, p)
      }
    }
    ctx.stroke()
    if (this.labelsVisible) {
      ctx.textBaseline = 'middle'
      for (const tk of this.ticks) {
        if (!tk.label) continue
        const p = this.valueToPx(tk.value)
        if (p < lo - 1 || p > hi + 1) continue
        ctx.font = font(t, tk.level === 0 ? fs : fs * 0.85)
        ctx.fillStyle = (tk.level === 0 ? t.tickLabelColor : t.minorTickLabelColor).toCSS()
        if (this.dim === 'x') {
          ctx.textAlign = 'center'
          const y = this.pos + (TICK_MAJOR + LABEL_GAP + fs * 0.55) * dir
          ctx.fillText(tk.label, clampLabel(p, lo, hi, textWidth(tk.label, ctx.font)), y)
        } else {
          ctx.textAlign = this.opposite ? 'left' : 'right'
          ctx.fillText(tk.label, this.pos - (TICK_MAJOR + LABEL_GAP) * dir, clampLabel(p, lo, hi, fs))
        }
      }
      for (const ct of this.customTicks) {
        if (!ct.visible) continue
        const p = this.valueToPx(ct.value)
        if (p < lo - 1 || p > hi + 1) continue
        ctx.font = font(t, fs)
        ctx.fillStyle = (ct.labelColor ?? t.tickLabelColor).toCSS()
        ctx.strokeStyle = t.tickColor.toCSS()
        ctx.beginPath()
        if (this.dim === 'x') {
          ctx.moveTo(p, this.pos); ctx.lineTo(p, this.pos + ct.tickLength * dir); ctx.stroke()
          ctx.textAlign = 'center'
          ctx.fillText(ct.label(), p, this.pos + (ct.tickLength + LABEL_GAP + fs * 0.55) * dir)
        } else {
          ctx.moveTo(this.pos, p); ctx.lineTo(this.pos - ct.tickLength * dir, p); ctx.stroke()
          ctx.textAlign = this.opposite ? 'left' : 'right'
          ctx.fillText(ct.label(), this.pos - (ct.tickLength + LABEL_GAP) * dir, p)
        }
      }
    }
    const title = this.titleText()
    if (title) {
      ctx.font = font(t, fs)
      ctx.fillStyle = (this.titleColor ?? t.axisTitleColor).toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const mid = (lo + hi) / 2
      const off = this.thickness - fs * 0.75 - 1
      if (this.dim === 'x') {
        ctx.fillText(title, mid, this.pos + off * dir)
      } else {
        ctx.save()
        ctx.translate(this.pos - off * dir, mid)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(title, 0, 0, Math.max(20, hi - lo))
        ctx.restore()
      }
    }
  }

  /** Cursor value pill on the axis. */
  drawCursorTick(ctx: CanvasRenderingContext2D, value: number) {
    if (!this.visible) return
    const t = this.chart.getTheme()
    const fs = t.fontSize
    const p = this.valueToPx(value)
    const lo = Math.min(this.px0, this.px1), hi = Math.max(this.px0, this.px1)
    if (p < lo - 1 || p > hi + 1) return
    const text = this.formatCursor(value)
    ctx.font = font(t, fs)
    const w = textWidth(text, ctx.font) + 10
    const h = fs + 8
    const dir = this.opposite ? -1 : 1
    let x: number, y: number
    if (this.dim === 'x') {
      x = Math.min(Math.max(p - w / 2, lo - 20), hi - w + 20)
      y = this.opposite ? this.pos - h - 2 : this.pos + 2
    } else {
      x = this.opposite ? this.pos + 2 : this.pos - w - 2
      y = p - h / 2
    }
    roundRect(ctx, x, y, w, h, 3)
    ctx.fillStyle = t.cursor.tickFill.toCSS()
    ctx.fill()
    ctx.fillStyle = t.cursor.tickText.toCSS()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, x + w / 2, y + h / 2 + 0.5)
    void dir
  }

  /** Hit region for axis interactions (CSS px). */
  hitRect(): Rect {
    const lo = Math.min(this.px0, this.px1), hi = Math.max(this.px0, this.px1)
    const th = Math.max(this.thickness, 12)
    if (this.dim === 'x') return { x: lo, y: this.opposite ? this.pos - th : this.pos, w: hi - lo, h: th }
    return { x: this.opposite ? this.pos : this.pos - th, y: lo, w: th, h: hi - lo }
  }

  /** Marker near px (for dragging constant lines / band edges). */
  markerAt(px: number, tol = 5): { marker: ConstantLine | Band; edge?: 'start' | 'end' | 'body' } | null {
    for (const l of [...this.lines].reverse()) {
      if (l.visible && l.draggable && Math.abs(this.valueToPx(l.value) - px) <= tol) return { marker: l }
    }
    for (const b of [...this.bands].reverse()) {
      if (!b.visible || !b.draggable) continue
      const a = this.valueToPx(b.start), c = this.valueToPx(b.end)
      if (Math.abs(a - px) <= tol) return { marker: b, edge: 'start' }
      if (Math.abs(c - px) <= tol) return { marker: b, edge: 'end' }
      if (px > Math.min(a, c) && px < Math.max(a, c)) return { marker: b, edge: 'body' }
    }
    return null
  }
}

function clampLabel(p: number, lo: number, hi: number, w: number) {
  const half = w / 2
  if (hi - lo < w) return p
  return Math.min(Math.max(p, lo + half - 12), hi - half + 12)
}

export function cloneStrategy<T extends TickStrategy>(s: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(s)), s)
}

export { emptyLine, DashedLine, StipplePatterns }
