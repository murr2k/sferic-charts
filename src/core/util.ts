// Small shared helpers: events, easing, formatting, text metrics.

export type Listener<T = any> = (event: T, ...rest: any[]) => void

/** Minimal typed event emitter with addEventListener / removeEventListener. */
export class Emitter {
  private _listeners = new Map<string, Set<Listener>>()
  addEventListener(type: string, fn: Listener): this {
    let s = this._listeners.get(type)
    if (!s) this._listeners.set(type, (s = new Set()))
    s.add(fn)
    return this
  }
  removeEventListener(type: string, fn: Listener): this {
    this._listeners.get(type)?.delete(fn)
    return this
  }
  protected emit(type: string, event: any, ...rest: any[]): void {
    const s = this._listeners.get(type)
    if (s) for (const fn of [...s]) fn(event, ...rest)
  }
  protected hasListeners(type: string): boolean {
    return (this._listeners.get(type)?.size ?? 0) > 0
  }
}

// ---------------------------------------------------------------- easing / animation

export const Easings = {
  linear: (t: number) => t,
  easeOut: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInOut: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  ease: (t: number) => 1 - Math.pow(1 - t, 2),
}
export type Easing = (t: number) => number

/** A running numeric tween; tick() returns true while active. */
export class Tween {
  private t0 = performance.now()
  done = false
  constructor(
    private from: number[],
    private to: number[],
    private duration: number,
    private apply: (v: number[]) => void,
    private easing: Easing = Easings.easeOut,
  ) {}
  tick(now = performance.now()): boolean {
    if (this.done) return false
    const t = this.duration <= 0 ? 1 : Math.min(1, (now - this.t0) / this.duration)
    const k = this.easing(t)
    this.apply(this.from.map((f, i) => f + (this.to[i] - f) * k))
    if (t >= 1) this.done = true
    return !this.done
  }
  cancel() { this.done = true }
}

// ---------------------------------------------------------------- numbers

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t
export const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Decimal places needed to distinguish values separated by `step`. */
export function decimalsForStep(step: number): number {
  if (!(step > 0) || !Number.isFinite(step)) return 0
  const d = -Math.floor(Math.log10(step) + 1e-9)
  // 2.5 / 0.25 steps need one more digit
  const mant = step / Math.pow(10, Math.floor(Math.log10(step) + 1e-9))
  const extra = Math.abs(mant - 2.5) < 1e-6 ? 1 : 0
  return Math.max(0, d + extra)
}

/** Format a number for axis labels / cursor readouts. */
export function formatNumber(v: number, decimals: number): string {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  if ((a >= 1e15 || (a > 0 && a < 1e-6 && decimals > 8)) && a !== 0) {
    return v.toExponential(Math.min(6, Math.max(1, decimals > 8 ? 3 : 2)))
  }
  const d = Math.min(Math.max(0, decimals), 12)
  const s = v.toFixed(d)
  return s === '-0' || /^-0\.0*$/.test(s) ? s.slice(1) : s
}

/** Compact formatter with SI-ish suffixes (k, M, G), used by gauges and labels. */
export function formatCompact(v: number, digits = 2): string {
  const a = Math.abs(v)
  if (a >= 1e9) return (v / 1e9).toFixed(digits).replace(/\.?0+$/, '') + 'G'
  if (a >= 1e6) return (v / 1e6).toFixed(digits).replace(/\.?0+$/, '') + 'M'
  if (a >= 1e4) return (v / 1e3).toFixed(digits).replace(/\.?0+$/, '') + 'k'
  return Number(v.toFixed(digits)).toString()
}

// ---------------------------------------------------------------- text

let measureCtx: CanvasRenderingContext2D | null = null
const widthCache = new Map<string, number>()
/** Cached text width in CSS px for a given font string. */
export function textWidth(text: string, font: string): number {
  const key = font + '\u0000' + text
  let w = widthCache.get(key)
  if (w !== undefined) return w
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d')!
  measureCtx.font = font
  w = measureCtx.measureText(text).width
  if (widthCache.size > 20000) widthCache.clear()
  widthCache.set(key, w)
  return w
}

export interface Rect { x: number; y: number; w: number; h: number }
export const rectContains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h

/** Rounded rect path. */
export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  r = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

/** Binary search: first index i in [lo, hi) with arr(i) >= v. */
export function lowerBound(get: (i: number) => number, lo: number, hi: number, v: number): number {
  while (lo < hi) {
    const m = (lo + hi) >>> 1
    if (get(m) < v) lo = m + 1
    else hi = m
  }
  return lo
}

export function containerOf(c: HTMLElement | string | undefined): HTMLElement {
  if (c instanceof HTMLElement) return c
  if (typeof c === 'string') {
    const el = document.getElementById(c)
    if (!el) throw new Error(`sferic: container #${c} not found`)
    return el
  }
  const div = document.createElement('div')
  div.style.cssText = 'position:fixed;inset:0;'
  document.body.appendChild(div)
  return div
}
