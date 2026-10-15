import { decimalsForStep, formatNumber } from '../core/util'

export interface Tick {
  value: number
  label: string
  /** 0 = major (labeled), 1 = minor, 2 = minor with small label. */
  level: 0 | 1 | 2
}

export interface TickContext {
  /** Interval in axis units (lo < hi). */
  lo: number
  hi: number
  /** Axis length in CSS px. */
  length: number
  horizontal: boolean
  log: number
  /** Text width measure for a label at a level. */
  measure: (text: string, level: 0 | 2) => number
  fontSize: number
}

export type TickFormatter = (value: number, range: { start: number; end: number }) => string

/** Base tick strategy; immutable builder style. */
export abstract class TickStrategy {
  abstract readonly type: 'Numeric' | 'DateTime' | 'Time' | 'Empty'
  formatter: TickFormatter | null = null
  cursorFormatter: TickFormatter | null = null
  majorTicksVisible = true
  minorTicksVisible = true
  majorGridVisible = true
  minorGridVisible = true
  minorLabelsVisible = true
  /** Last generated major step, used for cursor precision. */
  lastStep = 1
  abstract generate(ctx: TickContext): Tick[]
  abstract formatValue(v: number, range: { start: number; end: number }): string
  abstract formatCursor(v: number, range: { start: number; end: number }): string

  protected clone(): this {
    const c = Object.create(Object.getPrototypeOf(this))
    Object.assign(c, this)
    return c
  }
  setFormattingFunction(f: TickFormatter | undefined) { const c = this.clone(); c.formatter = f ?? null; return c }
  setCursorFormattingFunction(f: TickFormatter | undefined) { const c = this.clone(); c.cursorFormatter = f ?? null; return c }
  setMajorTickStyle(f: any) {
    const c = this.clone()
    const api = styleApi((k, v) => {
      if (k === 'grid') c.majorGridVisible = v
      if (k === 'tick') c.majorTicksVisible = v
    })
    if (typeof f === 'function') f(api)
    return c
  }
  setMinorTickStyle(f: any) {
    const c = this.clone()
    const api = styleApi((k, v) => {
      if (k === 'grid') c.minorGridVisible = v
      if (k === 'tick') c.minorTicksVisible = v
      if (k === 'label') c.minorLabelsVisible = v
    })
    if (typeof f === 'function') f(api)
    return c
  }
  setMinorTicksVisible(v: boolean) { const c = this.clone(); c.minorTicksVisible = v; c.minorGridVisible = v; return c }
}

/** Minimal tick style API: supports hiding grid/ticks/labels via empty styles. */
function styleApi(set: (k: 'grid' | 'tick' | 'label', v: boolean) => void): any {
  const api: any = {
    setGridStrokeStyle: (s: any) => { set('grid', !(s && (s.type === 'empty' || s.getFillStyle?.().type === 'empty'))); return api },
    setTickStyle: (s: any) => { set('tick', !(s && (s.type === 'empty' || s.getFillStyle?.().type === 'empty'))); return api },
    setLabelFillStyle: (s: any) => { set('label', !(s && s.type === 'empty')); return api },
    setTickLength: () => api,
    setTickPadding: () => api,
    setLabelFont: () => api,
    setTickLabelPadding: () => api,
    setLabelPadding: () => api,
  }
  return api
}

const NICE = [1, 2, 5]

/** Smallest "nice" step >= raw. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1
  const p = Math.pow(10, Math.floor(Math.log10(raw)))
  for (const m of NICE) if (m * p >= raw * (1 - 1e-9)) return m * p
  return 10 * p
}
function nextNice(step: number): number { return niceStep(step * 1.0001) === step ? niceStep(step * 1.5) : niceStep(step * 1.0001) }
function minorDiv(step: number): number {
  const m = Math.round(step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9)))
  return m === 2 ? 4 : 5
}

export class NumericTickStrategy extends TickStrategy {
  readonly type = 'Numeric' as const
  generate(ctx: TickContext): Tick[] {
    if (ctx.log > 0) return this.generateLog(ctx)
    const { lo, hi, length } = ctx
    const span = hi - lo
    if (!(span > 0) || !(length > 0)) return []
    const minSpacing = ctx.horizontal ? 90 : Math.max(ctx.fontSize * 1.8, Math.min(Math.max(46, ctx.fontSize * 4.2), length / 3))
    let step = niceStep((span * minSpacing) / length)
    // Horizontal: widen until labels fit.
    for (let guard = 0; guard < 20; guard++) {
      const dec = decimalsForStep(step)
      const fmt = (v: number) => (this.formatter ? this.formatter(v, { start: lo, end: hi }) : formatNumber(v, dec))
      const spacing = (step / span) * length
      const need = ctx.horizontal
        ? Math.max(ctx.measure(fmt(lo), 0), ctx.measure(fmt(hi), 0), ctx.measure(fmt((lo + hi) / 2), 0)) + 18
        : ctx.fontSize * 2
      if (spacing >= need) break
      step = nextNice(step)
    }
    this.lastStep = step
    const dec = decimalsForStep(step)
    const out: Tick[] = []
    const k0 = Math.ceil(lo / step - 1e-9)
    const k1 = Math.floor(hi / step + 1e-9)
    if (k1 - k0 > 2000) return out
    for (let k = k0; k <= k1; k++) {
      const v = k * step
      out.push({ value: v, label: this.formatter ? this.formatter(v, { start: lo, end: hi }) : formatNumber(v, dec), level: 0 })
    }
    const div = minorDiv(step)
    const ms = step / div
    if ((ms / span) * length >= 5 && (this.minorTicksVisible || this.minorGridVisible)) {
      const m0 = Math.ceil(lo / ms - 1e-9), m1 = Math.floor(hi / ms + 1e-9)
      if (m1 - m0 < 10000)
        for (let k = m0; k <= m1; k++) {
          if (k % div === 0) continue
          out.push({ value: k * ms, label: '', level: 1 })
        }
    }
    return out
  }

  private generateLog(ctx: TickContext): Tick[] {
    const { lo, hi, length, log } = ctx
    if (!(lo > 0) || !(hi > lo)) return []
    const L = (v: number) => Math.log(v) / Math.log(log)
    const e0 = Math.floor(L(lo)), e1 = Math.ceil(L(hi))
    const decades = L(hi) - L(lo)
    const pxPerDecade = length / decades
    const out: Tick[] = []
    const minSp = ctx.horizontal ? 60 : ctx.fontSize * 2.2
    const every = Math.max(1, Math.ceil(minSp / pxPerDecade))
    const fmt = (v: number, e: number) =>
      this.formatter ? this.formatter(v, { start: lo, end: hi }) : Math.abs(e) <= 5 ? formatNumber(v, Math.max(0, -e)) : `${log === 10 ? '1e' : log + '^'}${e}`
    if (decades < 1.2) {
      // Narrow range: linear nice ticks placed on the log scale.
      const lin = new NumericTickStrategy()
      lin.formatter = this.formatter
      return lin.generate({ ...ctx, log: 0 })
    }
    for (let e = e0; e <= e1; e++) {
      const v = Math.pow(log, e)
      if (v >= lo * (1 - 1e-12) && v <= hi * (1 + 1e-12) && e % every === 0) out.push({ value: v, label: fmt(v, e), level: 0 })
      if (log === 10 && every === 1) {
        for (let m = 2; m <= 9; m++) {
          const mv = m * v
          if (mv < lo || mv > hi) continue
          const labeled = pxPerDecade > 260 || (pxPerDecade > 120 && (m === 2 || m === 5))
          out.push({ value: mv, label: labeled ? fmt(mv, e) : '', level: labeled ? 2 : 1 })
        }
      }
    }
    this.lastStep = 1
    return out
  }

  formatValue(v: number, range: { start: number; end: number }): string {
    if (this.formatter) return this.formatter(v, range)
    return formatNumber(v, decimalsForStep(this.lastStep))
  }
  formatCursor(v: number, range: { start: number; end: number }): string {
    if (this.cursorFormatter) return this.cursorFormatter(v, range)
    if (this.formatter) return this.formatter(v, range)
    const a = Math.abs(v)
    if (a !== 0 && (a < 1e-4 || a >= 1e15)) return v.toExponential(4)
    return formatNumber(v, Math.min(10, decimalsForStep(this.lastStep) + 2))
  }
}

// ------------------------------------------------------------------ DateTime

const SEC = 1000, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR
type Unit = 'ms' | 's' | 'min' | 'h' | 'd' | 'w' | 'mo' | 'y'
interface DTStep { unit: Unit; n: number; approx: number }
const DT_STEPS: DTStep[] = [
  ...[0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500].map((n) => ({ unit: 'ms' as Unit, n, approx: n })),
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ unit: 's' as Unit, n, approx: n * SEC })),
  ...[1, 2, 5, 10, 15, 30].map((n) => ({ unit: 'min' as Unit, n, approx: n * MIN })),
  ...[1, 2, 3, 6, 12].map((n) => ({ unit: 'h' as Unit, n, approx: n * HOUR })),
  ...[1, 2].map((n) => ({ unit: 'd' as Unit, n, approx: n * DAY })),
  { unit: 'w', n: 1, approx: 7 * DAY },
  ...[1, 2, 3, 6].map((n) => ({ unit: 'mo' as Unit, n, approx: n * 30.44 * DAY })),
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((n) => ({ unit: 'y' as Unit, n, approx: n * 365.25 * DAY })),
]

const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MO = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n: number) => String(n).padStart(2, '0')
const p3 = (n: number) => String(n).padStart(3, '0')

interface DParts { y: number; mo: number; d: number; wd: number; h: number; mi: number; s: number; ms: number }

export class DateTimeTickStrategy extends TickStrategy {
  readonly type = 'DateTime' as const
  utc = false
  /** Values are offsets (ms) from this origin. */
  dateOrigin = 0
  setUTC(v: boolean) { const c = this.clone(); c.utc = v; return c }
  setDateOrigin(d: Date | number) { const c = this.clone(); c.dateOrigin = typeof d === 'number' ? d : d.getTime(); return c }
  getDateOrigin() { return new Date(this.dateOrigin) }

  private parts(t: number): DParts {
    const d = new Date(t)
    return this.utc
      ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() }
      : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), wd: d.getDay(), h: d.getHours(), mi: d.getMinutes(), s: d.getSeconds(), ms: d.getMilliseconds() }
  }
  private make(y: number, mo: number, d = 1, h = 0, mi = 0, s = 0, ms = 0): number {
    return this.utc ? Date.UTC(y, mo, d, h, mi, s, ms) : new Date(y, mo, d, h, mi, s, ms).getTime()
  }

  /** Floor t to a step boundary. */
  private floor(t: number, st: DTStep): number {
    const p = this.parts(t)
    switch (st.unit) {
      case 'ms': return Math.floor(t / st.n) * st.n
      case 's': return this.make(p.y, p.mo, p.d, p.h, p.mi, Math.floor(p.s / st.n) * st.n)
      case 'min': return this.make(p.y, p.mo, p.d, p.h, Math.floor(p.mi / st.n) * st.n)
      case 'h': return this.make(p.y, p.mo, p.d, Math.floor(p.h / st.n) * st.n)
      case 'd': return this.make(p.y, p.mo, p.d - (st.n > 1 ? (p.d - 1) % st.n : 0))
      case 'w': return this.make(p.y, p.mo, p.d - ((p.wd + 6) % 7))
      case 'mo': return this.make(p.y, Math.floor(p.mo / st.n) * st.n)
      case 'y': return this.make(Math.floor(p.y / st.n) * st.n, 0)
    }
  }
  private add(t: number, st: DTStep, k = 1): number {
    const p = this.parts(t)
    switch (st.unit) {
      case 'ms': return t + st.n * k
      case 's': return t + st.n * k * SEC
      case 'min': return t + st.n * k * MIN
      case 'h': return this.make(p.y, p.mo, p.d, p.h + st.n * k, p.mi, p.s, p.ms)
      case 'd': {
        const nd = this.make(p.y, p.mo, p.d + st.n * k)
        // restart day-steps at month start
        if (st.n > 1) {
          const q = this.parts(nd)
          if (q.mo !== p.mo && q.d !== 1) return this.make(q.y, q.mo, 1)
        }
        return nd
      }
      case 'w': return this.make(p.y, p.mo, p.d + 7 * k)
      case 'mo': return this.make(p.y, p.mo + st.n * k)
      case 'y': return this.make(p.y + st.n * k, 0)
    }
  }

  private label(t: number, st: DTStep, major: boolean): string {
    const p = this.parts(t)
    switch (st.unit) {
      case 'ms': {
        const us = Math.round((t - Math.floor(t)) * 1000) % 1000
        if (st.n < 1) return us === 0 && p.ms === 0 && major ? `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}` : `${p2(p.s)}.${p3(p.ms)} ${p3(us)}`
        return p.ms === 0 ? `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}` : `${p2(p.s)}.${p3(p.ms)}`
      }
      case 's': return `${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`
      case 'min': return p.h === 0 && p.mi === 0 && major ? `${WD[p.wd]} ${p.d}` : `${p2(p.h)}:${p2(p.mi)}`
      case 'h': return p.h === 0 ? `${WD[p.wd]} ${p.d}` : `${p2(p.h)}:00`
      case 'd':
      case 'w': return p.d === 1 && major ? `${MO[p.mo]} ${p.d}` : `${WD[p.wd]} ${p.d}`
      case 'mo': return p.mo === 0 ? `${p.y}` : MO[p.mo]
      case 'y': return `${p.y}`
    }
  }

  generate(ctx: TickContext): Tick[] {
    const o = this.dateOrigin
    const lo = ctx.lo + o, hi = ctx.hi + o
    const span = hi - lo
    if (!(span > 0) || !(ctx.length > 0)) return []
    const pxPerMs = ctx.length / span
    const sample = this.label(lo, { unit: 'd', n: 1, approx: DAY }, true)
    const majW = ctx.horizontal ? Math.max(70, ctx.measure('00:00:00', 0) + 24, ctx.measure(sample, 0) + 24) : ctx.fontSize * 3
    const minW = ctx.horizontal ? Math.max(48, ctx.measure('00:00:00', 2) + 14) : ctx.fontSize * 2
    // Major: coarsest-fine step whose spacing allows labels (target ~2x label width)
    let mi = DT_STEPS.findIndex((s) => s.approx * pxPerMs >= majW * 1.6)
    if (mi < 0) mi = DT_STEPS.length - 1
    // Prefer naturally "rounder" majors: weeks over 2-4 day steps
    let major = DT_STEPS[mi]
    if (major.unit === 'd' && major.n === 2) major = DT_STEPS.find((s) => s.unit === 'w')!
    const majorIdx = DT_STEPS.indexOf(major)
    // Minor: largest step smaller than major with enough room for small labels
    let minor: DTStep | null = null
    for (let i = majorIdx - 1; i >= 0; i--) {
      const s = DT_STEPS[i]
      if (s.approx * pxPerMs >= minW && s.approx < major.approx) {
        minor = s
        break
      }
    }
    this.lastStep = major.approx
    const out: Tick[] = []
    let t = this.floor(lo, major)
    let guard = 0
    const majors: number[] = []
    const t0 = t
    while (t <= hi && guard++ < 1000) {
      majors.push(t)
      // Fixed-length units step by index to avoid accumulating rounding error.
      t = major.unit === 'ms' ? t0 + guard * major.n : this.add(t, major)
    }
    majors.push(t)
    for (let i = 0; i < majors.length; i++) {
      const m = majors[i]
      if (m >= lo && m <= hi) out.push({ value: m - o, label: this.formatter ? this.formatter(m - o, { start: ctx.lo, end: ctx.hi }) : this.label(m, major, true), level: 0 })
      if (!minor || i + 1 >= majors.length) continue
      const next = majors[i + 1]
      let mt = this.add(m, minor)
      let g2 = 0
      while (mt < next - minor.approx * 0.6 && g2++ < 400) {
        if (mt >= lo && mt <= hi) {
          const labeled = this.minorLabelsVisible && minor.approx * pxPerMs >= minW
          out.push({ value: mt - o, label: labeled ? this.label(mt, minor, false) : '', level: labeled ? 2 : 1 })
        }
        mt = this.add(mt, minor)
      }
    }
    // Unlabeled sub-ticks for texture
    return out
  }

  formatValue(v: number, range: { start: number; end: number }): string {
    if (this.formatter) return this.formatter(v, range)
    return this.full(v + this.dateOrigin, this.lastStep)
  }
  formatCursor(v: number, range: { start: number; end: number }): string {
    if (this.cursorFormatter) return this.cursorFormatter(v, range)
    return this.full(v + this.dateOrigin, this.lastStep / 10)
  }
  private full(t: number, res: number): string {
    const p = this.parts(t)
    const date = `${p.y}-${p2(p.mo + 1)}-${p2(p.d)}`
    if (res >= DAY) return date
    if (res >= MIN) return `${date} ${p2(p.h)}:${p2(p.mi)}`
    if (res >= SEC) return `${date} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}`
    if (res >= 1) return `${date} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${p3(p.ms)}`
    const us = Math.round((t - Math.floor(t)) * 1000) % 1000
    return `${date} ${p2(p.h)}:${p2(p.mi)}:${p2(p.s)}.${p3(p.ms)} ${p3(us)}`
  }
}

// ------------------------------------------------------------------ Time (elapsed ms)

const TIME_STEPS = [
  ...[0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500],
  ...[1, 2, 5, 10, 15, 30].map((n) => n * SEC),
  ...[1, 2, 5, 10, 15, 30].map((n) => n * MIN),
  ...[1, 2, 3, 6, 12, 24, 48, 96, 240].map((n) => n * HOUR),
]

export class TimeTickStrategy extends TickStrategy {
  readonly type = 'Time' as const
  private fmt(v: number, step: number): string {
    const neg = v < 0
    let a = Math.abs(v)
    const h = Math.floor(a / HOUR); a -= h * HOUR
    const m = Math.floor(a / MIN); a -= m * MIN
    const s = Math.floor(a / SEC); a -= s * SEC
    let out = h > 0 || step >= HOUR ? `${p2(h)}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`
    if (step < SEC) {
      const dec = Math.min(6, Math.max(1, decimalsForStep(step / 1000)))
      out += '.' + (a / 1000).toFixed(dec).slice(2)
    }
    return (neg ? '-' : '') + out
  }
  generate(ctx: TickContext): Tick[] {
    const { lo, hi, length } = ctx
    const span = hi - lo
    if (!(span > 0)) return []
    const sampleW = ctx.horizontal ? ctx.measure(this.fmt(hi, 1), 0) + 24 : ctx.fontSize * 2.5
    let step = TIME_STEPS.find((s) => (s / span) * length >= Math.max(sampleW, 60)) ?? TIME_STEPS[TIME_STEPS.length - 1]
    if (ctx.horizontal) {
      const w = ctx.measure(this.fmt(hi, step), 0) + 20
      while ((step / span) * length < w) {
        const nx = TIME_STEPS.find((s) => s > step)
        if (!nx) break
        step = nx
      }
    }
    this.lastStep = step
    const out: Tick[] = []
    const k0 = Math.ceil(lo / step - 1e-9), k1 = Math.floor(hi / step + 1e-9)
    if (k1 - k0 > 2000) return out
    for (let k = k0; k <= k1; k++) {
      const v = k * step
      out.push({ value: v, label: this.formatter ? this.formatter(v, { start: lo, end: hi }) : this.fmt(v, step), level: 0 })
    }
    const ms = step / 5
    if ((ms / span) * length >= 6) {
      for (let k = Math.ceil(lo / ms); k <= Math.floor(hi / ms); k++) if (k % 5 !== 0) out.push({ value: k * ms, label: '', level: 1 })
    }
    return out
  }
  formatValue(v: number, range: { start: number; end: number }): string {
    return this.formatter ? this.formatter(v, range) : this.fmt(v, this.lastStep)
  }
  formatCursor(v: number, range: { start: number; end: number }): string {
    if (this.cursorFormatter) return this.cursorFormatter(v, range)
    return this.fmt(v, this.lastStep / 100)
  }
}

export class EmptyTickStrategy extends TickStrategy {
  readonly type = 'Empty' as const
  generate(): Tick[] { return [] }
  formatValue(v: number, range: { start: number; end: number }): string { return this.formatter ? this.formatter(v, range) : formatNumber(v, 3) }
  formatCursor(v: number, range: { start: number; end: number }): string {
    if (this.cursorFormatter) return this.cursorFormatter(v, range)
    return this.formatter ? this.formatter(v, range) : formatNumber(v, 3)
  }
}

/** Strategy prototypes; `setTickStrategy` clones them. */
export const AxisTickStrategies = {
  Numeric: new NumericTickStrategy(),
  DateTime: new DateTimeTickStrategy(),
  Time: new TimeTickStrategy(),
  Empty: new EmptyTickStrategy(),
}
