import { Color } from '../core/color'
import { Fill, Mutator, resolve, SolidFill } from '../core/style'
import { Theme, font } from '../core/theme'
import { Easings, Emitter, textWidth, Tween } from '../core/util'
import { AxisTickStrategies, Tick, TickStrategy } from '../xy/ticks'
import { cloneStrategy } from '../xy/Axis'
import type { DataState, IntervalArgs, ScrollStrategy } from '../xy/Axis'

/** What an Axis3D needs from its chart. */
export interface Axis3DHost {
  requestRender(): void
  getTheme(): Theme
  addTween(t: Tween): void
  dataExtent(a: Axis3D): { min: number; max: number }
  onAxisIntervalChanged(a: Axis3D): void
}

/** One of the three Chart3D axes. */
export class Axis3D extends Emitter {
  readonly dim: 'x' | 'y' | 'z'
  start = 0
  end = 1
  /** Automatic fitting halted by an explicit interval. */
  stopped = false
  private initialized = false
  scroll: ScrollStrategy = 'fitting'
  defaultInterval: ((s: DataState) => { start?: number; end?: number; stopAxisAfter?: boolean }) | null = null
  strategy: TickStrategy
  title = ''
  units = ''
  titleColor: Color | null = null
  labelColor: Color | null = null
  visible = true
  labelsVisible = true
  animationsEnabled = true
  /** Fraction of the data range added on both sides when fitting. */
  fitMargin = 0
  ticks: Tick[] = []
  private tween: Tween | null = null

  constructor(private host: Axis3DHost, dim: 'x' | 'y' | 'z') {
    super()
    this.dim = dim
    this.strategy = cloneStrategy(AxisTickStrategies.Numeric)
  }

  // ---------------------------------------------------------------- configuration API

  setTitle(t: string) { this.title = t; this.host.requestRender(); return this }
  getTitle() { return this.title }
  setUnits(u: string) { this.units = u; this.host.requestRender(); return this }
  getUnits() { return this.units }
  setTitleFillStyle(f: Mutator<Fill>) {
    this.titleColor = resolve<Fill>(new SolidFill({ color: this.titleColor ?? this.host.getTheme().axisTitleColor }), f).getPrimaryColor()
    this.host.requestRender()
    return this
  }
  setTickLabelFillStyle(f: Mutator<Fill>) {
    this.labelColor = resolve<Fill>(new SolidFill({ color: this.labelColor ?? this.host.getTheme().tickLabelColor }), f).getPrimaryColor()
    this.host.requestRender()
    return this
  }
  setTitleFont(_f: unknown) { return this }
  setTickStrategy<T extends TickStrategy>(s: T, styler?: (s: T) => T) {
    let st = cloneStrategy(s)
    if (styler) st = styler(st)
    this.strategy = st
    this.host.requestRender()
    return this
  }
  getTickStrategy() { return this.strategy.type }
  setScrollStrategy(s: ScrollStrategy) {
    this.scroll = s
    this.stopped = false
    this.host.requestRender()
    return this
  }
  getScrollStrategy() { return this.scroll }
  setDefaultInterval(f: ((s: DataState) => { start?: number; end?: number; stopAxisAfter?: boolean }) | { start: number; end: number }) {
    this.defaultInterval = typeof f === 'function' ? f : () => f
    this.stopped = false
    this.host.requestRender()
    return this
  }
  setVisible(v: boolean) { this.visible = v; this.host.requestRender(); return this }
  getVisible() { return this.visible }
  setTickLabelsVisible(v: boolean) { this.labelsVisible = v; this.host.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animationsEnabled = v; return this }
  setAnimationScroll(_v: boolean) { return this }
  setMouseInteractions(_v: boolean) { return this }
  setPointerEvents(_v: boolean) { return this }
  setStrokeStyle(_l: unknown) { return this }
  /** Extra room around fitted data, as a fraction of the data range. */
  setFitMargin(m: number) { this.fitMargin = Math.max(0, m); this.host.requestRender(); return this }

  // ---------------------------------------------------------------- interval

  getInterval() { return { start: this.start, end: this.end } }
  get lo() { return Math.min(this.start, this.end) }
  get hi() { return Math.max(this.start, this.end) }

  setInterval(a: IntervalArgs | number, end?: number, animate?: boolean | number) {
    const args: IntervalArgs = typeof a === 'number' ? { start: a, end: end!, animate } : a
    if (!(Number.isFinite(args.start) && Number.isFinite(args.end))) return this
    this.initialized = true
    this.stopped = args.stopAxisAfter ?? true
    this.applyInterval(args.start, args.end, args.animate)
    return this
  }

  /** @internal */
  applyInterval(s: number, e: number, animate?: boolean | number) {
    if (s === e) {
      const d = Math.abs(s) * 0.05 || 1
      s -= d
      e += d
    }
    const dur = animate === true ? 600 : typeof animate === 'number' ? animate : 0
    this.tween?.cancel()
    this.tween = null
    if (dur > 0 && this.animationsEnabled) {
      this.tween = new Tween([this.start, this.end], [s, e], dur, (v) => this.set(v[0], v[1]), Easings.easeInOut)
      this.host.addTween(this.tween)
    } else {
      this.set(s, e)
    }
  }

  private set(s: number, e: number) {
    if (s === this.start && e === this.end) return
    this.start = s
    this.end = e
    this.host.requestRender()
    this.emit('intervalchange', { start: s, end: e })
    this.host.onAxisIntervalChanged(this)
  }

  onIntervalChange(fn: (axis: Axis3D, start: number, end: number) => void) {
    const l = (ev: { start: number; end: number }) => fn(this, ev.start, ev.end)
    this.addEventListener('intervalchange', l)
    return () => this.removeEventListener('intervalchange', l)
  }

  /** @internal Run the scroll strategy against current data extents. */
  updateScroll(dmin: number, dmax: number) {
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
    const margin = (lo: number, hi: number): [number, number] => {
      const m = (hi - lo) * this.fitMargin
      return [lo - m, hi + m]
    }
    if (!this.initialized) {
      this.initialized = true
      const [a, b] = margin(dmin, dmax)
      this.applyInterval(a, b)
      return
    }
    const lo = this.lo, hi = this.hi
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
      case 'progressive':
        if (dmax > hi) put(dmax - (hi - lo), dmax)
        break
      case 'regressive':
        if (dmin < lo) put(dmin, dmin + (hi - lo))
        break
      case 'scrolling':
        put(dmax - (hi - lo), dmax)
        break
      default:
        break
    }
  }

  /** Fit the interval to the data. */
  fit(animate: boolean | number = true, stopAxisAfter = false) {
    const b = this.host.dataExtent(this)
    this.stopped = false
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
      const m = (b.max - b.min) * this.fitMargin
      if (this.start > this.end) this.applyInterval(b.max + m, b.min - m, animate)
      else this.applyInterval(b.min - m, b.max + m, animate)
    }
    this.stopped = !!stopAxisAfter
    return this
  }

  // ---------------------------------------------------------------- mapping / ticks

  /** Value to 0..1 along the axis. */
  norm(v: number) { return (v - this.start) / (this.end - this.start || 1) }
  formatValue(v: number): string { return this.strategy.formatValue(v, this.getInterval()) }
  formatCursor(v: number): string { return this.strategy.formatCursor(v, this.getInterval()) }
  titleText() { return this.title + (this.units ? ` (${this.units})` : '') }

  /** @internal Generate ticks for an on-screen axis length. */
  computeTicks(length: number, horizontal: boolean) {
    const t = this.host.getTheme()
    const fs = t.fontSize
    this.ticks = this.strategy.generate({
      lo: this.lo,
      hi: this.hi,
      length: Math.max(1, length),
      horizontal,
      log: 0,
      measure: (s, level) => textWidth(s, font(t, level === 0 ? fs : fs * 0.85)),
      fontSize: fs,
    })
  }
}
