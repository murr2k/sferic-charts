import { Color, ColorRGBA } from './color'

/** A value or a function producing a new value from the previous one (mutator setters). */
export type Mutator<T> = T | ((prev: T) => T)
export function resolve<T>(prev: T, m: Mutator<T>): T {
  return typeof m === 'function' ? (m as (p: T) => T)(prev) : m
}

// ---------------------------------------------------------------- LUT

export interface LUTStep { value: number; color: Color; label?: string }

export interface LUTOptions {
  steps: LUTStep[]
  interpolate?: boolean
  units?: string
  /** If true, step values are 0..1 fractions of the series' value range. */
  percentageValues?: boolean
}

/** Look-up table mapping a scalar to a color. */
export class LUT {
  readonly steps: LUTStep[]
  readonly interpolate: boolean
  readonly units: string
  readonly percentageValues: boolean
  private baked: Uint8Array | null = null
  /** Bumps when content changes; GPU caches key on this. */
  readonly id = ++lutIds

  constructor(o: LUTOptions) {
    this.steps = [...o.steps].sort((a, b) => a.value - b.value)
    this.interpolate = o.interpolate ?? true
    this.units = o.units ?? ''
    this.percentageValues = o.percentageValues ?? false
  }

  get min(): number { return this.steps.length ? this.steps[0].value : 0 }
  get max(): number { return this.steps.length ? this.steps[this.steps.length - 1].value : 1 }

  getColor(value: number): Color {
    const s = this.steps
    if (!s.length) return ColorRGBA(0, 0, 0, 0)
    if (!(value > s[0].value)) return s[0].color
    if (value >= s[s.length - 1].value) return s[s.length - 1].color
    let i = 1
    while (i < s.length && s[i].value <= value) i++
    const a = s[i - 1], b = s[i]
    if (!this.interpolate) return a.color
    return a.color.mix(b.color, (value - a.value) / (b.value - a.value || 1))
  }

  /** RGBA8 samples evenly spaced over [min, max], for GPU upload. */
  bake(n = 1024): Uint8Array {
    if (this.baked && this.baked.length === n * 4) return this.baked
    const out = new Uint8Array(n * 4)
    const lo = this.min, hi = this.max
    for (let i = 0; i < n; i++) {
      const v = lo + ((hi - lo) * i) / (n - 1)
      const c = this.getColor(v)
      out[i * 4] = c.r; out[i * 4 + 1] = c.g; out[i * 4 + 2] = c.b; out[i * 4 + 3] = c.a
    }
    this.baked = out
    return out
  }

  setInterpolated(interpolate: boolean): LUT { return new LUT({ ...this.opts(), interpolate }) }
  setUnits(units: string): LUT { return new LUT({ ...this.opts(), units }) }
  setSteps(steps: LUTStep[]): LUT { return new LUT({ ...this.opts(), steps }) }
  getSteps(): LUTStep[] { return this.steps }
  private opts(): LUTOptions {
    return { steps: this.steps, interpolate: this.interpolate, units: this.units, percentageValues: this.percentageValues }
  }
}
let lutIds = 0

/** Evenly spaced LUT steps from min to max over the given colors. */
export function regularColorSteps(
  min: number,
  max: number,
  colors: Color[],
  opts: { formatLabels?: (v: number) => string } = {},
): LUTStep[] {
  const n = colors.length
  return colors.map((color, i) => {
    const value = n === 1 ? min : min + ((max - min) * i) / (n - 1)
    return { value, color, label: opts.formatLabels ? opts.formatLabels(value) : undefined }
  })
}

// ---------------------------------------------------------------- Fills

export interface GradientStop { offset: number; color: Color }

export abstract class Fill {
  abstract readonly type: 'solid' | 'empty' | 'linear' | 'radial' | 'paletted'
  /** Representative single color (used for legend markers, cursor, fallbacks). */
  abstract getPrimaryColor(): Color
}

export class SolidFill extends Fill {
  readonly type = 'solid' as const
  readonly color: Color
  constructor(o: { color?: Color } = {}) {
    super()
    this.color = o.color ?? ColorRGBA(255, 255, 255)
  }
  getColor(): Color { return this.color }
  setColor(c: Mutator<Color>): SolidFill { return new SolidFill({ color: resolve(this.color, c) }) }
  setA(a: number): SolidFill { return new SolidFill({ color: this.color.setA(a) }) }
  getPrimaryColor(): Color { return this.color }
}

export class EmptyFill extends Fill {
  readonly type = 'empty' as const
  getPrimaryColor(): Color { return ColorRGBA(0, 0, 0, 0) }
}
export const emptyFill = new EmptyFill()

export class LinearGradientFill extends Fill {
  readonly type = 'linear' as const
  /** Degrees; 0 = left->right, 90 = bottom->top. */
  readonly angle: number
  readonly stops: GradientStop[]
  constructor(o: { angle?: number; stops?: GradientStop[] } = {}) {
    super()
    this.angle = o.angle ?? 0
    this.stops = [...(o.stops ?? [{ offset: 0, color: ColorRGBA(0, 0, 0) }, { offset: 1, color: ColorRGBA(255, 255, 255) }])].sort(
      (a, b) => a.offset - b.offset,
    )
  }
  setAngle(angle: number): LinearGradientFill { return new LinearGradientFill({ angle, stops: this.stops }) }
  setStops(stops: Mutator<GradientStop[]>): LinearGradientFill {
    return new LinearGradientFill({ angle: this.angle, stops: resolve(this.stops, stops) })
  }
  getPrimaryColor(): Color { return this.stops[this.stops.length - 1].color }
}

export class RadialGradientFill extends Fill {
  readonly type = 'radial' as const
  /** Center, 0..1 relative to the filled shape. */
  readonly position: { x: number; y: number }
  readonly stops: GradientStop[]
  constructor(o: { position?: { x: number; y: number }; stops?: GradientStop[] } = {}) {
    super()
    this.position = o.position ?? { x: 0.5, y: 0.5 }
    this.stops = [...(o.stops ?? [{ offset: 0, color: ColorRGBA(255, 255, 255) }, { offset: 1, color: ColorRGBA(0, 0, 0) }])].sort(
      (a, b) => a.offset - b.offset,
    )
  }
  setPosition(position: { x: number; y: number }): RadialGradientFill { return new RadialGradientFill({ position, stops: this.stops }) }
  setStops(stops: Mutator<GradientStop[]>): RadialGradientFill {
    return new RadialGradientFill({ position: this.position, stops: resolve(this.stops, stops) })
  }
  getPrimaryColor(): Color { return this.stops[0].color }
}

export type LookUpProperty = 'value' | 'x' | 'y' | 'z'

export class PalettedFill extends Fill {
  readonly type = 'paletted' as const
  readonly lut: LUT
  readonly lookUpProperty: LookUpProperty
  constructor(o: { lut: LUT; lookUpProperty?: LookUpProperty }) {
    super()
    this.lut = o.lut
    this.lookUpProperty = o.lookUpProperty ?? 'value'
  }
  setLUT(lut: LUT): PalettedFill { return new PalettedFill({ lut, lookUpProperty: this.lookUpProperty }) }
  setLookUpProperty(p: LookUpProperty): PalettedFill { return new PalettedFill({ lut: this.lut, lookUpProperty: p }) }
  getPrimaryColor(): Color {
    const s = this.lut.steps
    return s.length ? s[Math.floor(s.length / 2)].color : ColorRGBA(255, 255, 255)
  }
}

const gradCache = new WeakMap<CanvasRenderingContext2D, WeakMap<Fill, Map<string, CanvasGradient>>>()

/** Build a canvas paint for a fill over the given rect (CSS px). Gradients are cached per context, fill and rect. */
export function fillToCanvas(
  ctx: CanvasRenderingContext2D,
  fill: Fill,
  x: number, y: number, w: number, h: number,
): string | CanvasGradient | null {
  if (fill.type === 'linear' || fill.type === 'radial') {
    let byFill = gradCache.get(ctx)
    if (!byFill) gradCache.set(ctx, (byFill = new WeakMap()))
    let m = byFill.get(fill)
    if (!m) byFill.set(fill, (m = new Map()))
    const key = `${x},${y},${w},${h}`
    let g = m.get(key)
    if (!g) {
      g = makeGradient(ctx, fill, x, y, w, h)
      if (m.size > 512) m.clear()
      m.set(key, g)
    }
    return g
  }
  switch (fill.type) {
    case 'empty': return null
    case 'solid': return (fill as SolidFill).color.toCSS()
    default: return fill.getPrimaryColor().toCSS()
  }
}

function makeGradient(ctx: CanvasRenderingContext2D, fill: Fill, x: number, y: number, w: number, h: number): CanvasGradient {
  switch (fill.type) {
    case 'linear': {
      const f = fill as LinearGradientFill
      const a = (f.angle * Math.PI) / 180
      const cx = x + w / 2, cy = y + h / 2
      const dx = Math.cos(a), dy = -Math.sin(a)
      const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2
      const g = ctx.createLinearGradient(cx - dx * half, cy - dy * half, cx + dx * half, cy + dy * half)
      for (const s of f.stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), s.color.toCSS())
      return g
    }
    default: {
      const f = fill as RadialGradientFill
      const cx = x + f.position.x * w, cy = y + f.position.y * h
      const r = Math.hypot(Math.max(f.position.x, 1 - f.position.x) * w, Math.max(f.position.y, 1 - f.position.y) * h)
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      for (const s of f.stops) g.addColorStop(Math.min(1, Math.max(0, s.offset)), s.color.toCSS())
      return g
    }
  }
}

/** Sample a gradient's stops at t in [0,1]. */
export function sampleStops(stops: GradientStop[], t: number): Color {
  if (t <= stops[0].offset) return stops[0].color
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) {
      const a = stops[i - 1], b = stops[i]
      return a.color.mix(b.color, (t - a.offset) / (b.offset - a.offset || 1))
    }
  }
  return stops[stops.length - 1].color
}

// ---------------------------------------------------------------- Lines

/** Dash patterns as on/off lengths in multiples of line thickness (min 1px). */
export const StipplePatterns = {
  Dashed: [6, 4],
  DashedEqual: [4, 4],
  DashedLoose: [8, 8],
  Dotted: [1, 2],
  DottedDense: [1, 1],
  DashDotted: [6, 3, 1, 3],
  DashDottedLoose: [10, 5, 2, 5],
} as const
export type StipplePattern = readonly number[]

export abstract class LineStyle {
  abstract readonly type: 'solid' | 'dashed' | 'empty'
  abstract getThickness(): number
  abstract getFillStyle(): Fill
  abstract setThickness(t: Mutator<number>): LineStyle
  abstract setFillStyle(f: Mutator<Fill>): LineStyle
}

export class SolidLine extends LineStyle {
  readonly type: 'solid' | 'dashed' = 'solid'
  /** Pixels. -1 selects 1px primitive (fastest) rendering. */
  readonly thickness: number
  readonly fillStyle: Fill
  constructor(o: { thickness?: number; fillStyle?: Fill } = {}) {
    super()
    this.thickness = o.thickness ?? 1
    this.fillStyle = o.fillStyle ?? new SolidFill()
  }
  getThickness(): number { return this.thickness }
  getFillStyle(): Fill { return this.fillStyle }
  setThickness(t: Mutator<number>): SolidLine { return new SolidLine({ thickness: resolve(this.thickness, t), fillStyle: this.fillStyle }) }
  setFillStyle(f: Mutator<Fill>): SolidLine { return new SolidLine({ thickness: this.thickness, fillStyle: resolve(this.fillStyle, f) }) }
}

export class DashedLine extends SolidLine {
  override readonly type = 'dashed' as const
  readonly pattern: StipplePattern
  readonly patternScale: number
  constructor(o: { thickness?: number; fillStyle?: Fill; pattern?: StipplePattern; patternScale?: number } = {}) {
    super(o)
    this.pattern = o.pattern ?? StipplePatterns.Dashed
    this.patternScale = o.patternScale ?? 1
  }
  override setThickness(t: Mutator<number>): DashedLine { return new DashedLine({ ...this.o(), thickness: resolve(this.thickness, t) }) }
  override setFillStyle(f: Mutator<Fill>): DashedLine { return new DashedLine({ ...this.o(), fillStyle: resolve(this.fillStyle, f) }) }
  setPattern(p: StipplePattern): DashedLine { return new DashedLine({ ...this.o(), pattern: p }) }
  setPatternScale(s: number): DashedLine { return new DashedLine({ ...this.o(), patternScale: s }) }
  /** Dash array in px for canvas `setLineDash`. */
  dashArray(): number[] {
    const t = Math.max(1, this.thickness)
    return this.pattern.map((v) => v * t * this.patternScale)
  }
  private o() { return { thickness: this.thickness, fillStyle: this.fillStyle, pattern: this.pattern, patternScale: this.patternScale } }
}

export class EmptyLine extends LineStyle {
  readonly type = 'empty' as const
  getThickness(): number { return 0 }
  getFillStyle(): Fill { return emptyFill }
  setThickness(_t: Mutator<number>): LineStyle { return this }
  setFillStyle(_f: Mutator<Fill>): LineStyle { return this }
}
export const emptyLine = new EmptyLine()

export const isEmptyLine = (l: LineStyle) => l.type === 'empty' || l.getFillStyle().type === 'empty'

/** Apply a line style to a 2D context. Returns false if nothing should be stroked. */
export function applyLineToCanvas(ctx: CanvasRenderingContext2D, line: LineStyle, rect?: { x: number; y: number; w: number; h: number }): boolean {
  if (isEmptyLine(line)) return false
  const t = line.getThickness()
  ctx.lineWidth = t < 0 ? 1 : t
  const r = rect ?? { x: 0, y: 0, w: 1, h: 1 }
  ctx.strokeStyle = fillToCanvas(ctx, line.getFillStyle(), r.x, r.y, r.w, r.h) ?? 'transparent'
  ctx.setLineDash(line instanceof DashedLine ? line.dashArray() : [])
  return true
}
