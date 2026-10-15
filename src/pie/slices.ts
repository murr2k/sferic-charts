// Shared slice model for pie, funnel and pyramid charts.
import { Color } from '../core/color'
import { LegendSymbol, LegendTarget } from '../core/Legend'
import { Fill, fillToCanvas, LineStyle, LUT, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { Theme } from '../core/theme'
import { Emitter } from '../core/util'
import { approach, formatValue } from '../polar/common'

/** Label text for a slice; relativeValue is the slice's share of the visible total (0..1). */
export type SliceLabelFormatter = (slice: Slice, relativeValue: number) => string

export const SliceLabelFormatters = {
  Name: ((s) => s.getName()) as SliceLabelFormatter,
  NamePlusValue: ((s) => `${s.getName()}: ${formatValue(s.getValue())}`) as SliceLabelFormatter,
  NamePlusRelativeValue: ((s, rel) => `${s.getName()}: ${(rel * 100).toFixed(1)} %`) as SliceLabelFormatter,
}

export type SliceSorter = (a: Slice, b: Slice) => number

export const SliceSorters = {
  None: ((a, b) => a.index - b.index) as SliceSorter,
  NameAscending: ((a, b) => a.getName().localeCompare(b.getName())) as SliceSorter,
  NameDescending: ((a, b) => b.getName().localeCompare(a.getName())) as SliceSorter,
  ValueAscending: ((a, b) => a.getValue() - b.getValue() || a.index - b.index) as SliceSorter,
  ValueDescending: ((a, b) => b.getValue() - a.getValue() || a.index - b.index) as SliceSorter,
}

export const SliceLabelSide = { Left: 'left', Right: 'right' } as const
export type SliceLabelSide = (typeof SliceLabelSide)[keyof typeof SliceLabelSide]

/** What a chart provides to its slices. */
export interface SliceHost {
  requestRender(): void
  getTheme(): Theme
  /** @internal */ onSliceChange(s: Slice): void
  /** @internal */ onSliceDispose(s: Slice): void
  /** @internal */ onSliceExplode(s: Slice): void
  /** @internal */ sliceColor(s: Slice): Color
}

/** One slice of a pie, funnel or pyramid. */
export class Slice extends Emitter implements LegendTarget {
  /** Value used for geometry; animates towards the target value (0 when hidden). */
  shown = 0
  /** Explosion progress 0..1. */
  explodeT = 0
  /** Hover highlight progress 0..1. */
  hoverT = 0
  fill: Fill | null = null
  stroke: LineStyle | null = null
  protected visible = true
  protected exploded = false
  private disposed = false

  constructor(protected host: SliceHost, protected name: string, protected value: number, readonly index: number, readonly autoColor: Color) {
    super()
  }

  setName(n: string) { this.name = n; this.host.onSliceChange(this); return this }
  getName() { return this.name }
  /** Animated value change. */
  setValue(v: number) { this.value = +v; this.host.onSliceChange(this); return this }
  getValue() { return this.value }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve<Fill>(this.fill ?? new SolidFill({ color: this.host.sliceColor(this) }), f); this.host.requestRender(); return this }
  getFillStyle(): Fill { return this.fill ?? new SolidFill({ color: this.host.sliceColor(this) }) }
  setStrokeStyle(l: Mutator<LineStyle>) {
    const prev = this.stroke ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.host.getTheme().isDark ? new Color(0, 0, 0, 150) : new Color(255, 255, 255) }) })
    this.stroke = resolve<LineStyle>(prev, l)
    this.host.requestRender()
    return this
  }
  getStrokeStyle() { return this.stroke }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.host.onSliceChange(this)
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  setExploded(v: boolean) {
    if (this.exploded === v) return this
    this.exploded = v
    this.host.onSliceExplode(this)
    return this
  }
  getExploded() { return this.exploded }
  /** Alias. */
  setHighlighted(_v: boolean) { return this }
  onMouseClick(fn: (s: this, e: unknown) => void) { this.addEventListener('click', (e) => fn(this, e)); return this }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.host.onSliceDispose(this)
    return this
  }
  isDisposed() { return this.disposed }
  /** Effective base color (fill, LUT or theme). */
  getColor(): Color { return this.host.sliceColor(this) }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.getColor().setA(255) } }
  /** @internal */ fire(type: string, e: unknown) { this.emit(type, e) }
  /** @internal */ setExplodedSilently(v: boolean) { this.exploded = v }
}

/** Base color of a slice: explicit fill, else LUT by value, else theme color. */
export function sliceBaseColor(s: Slice, lut: LUT | null): Color {
  if (s.fill) return s.fill.getPrimaryColor()
  if (lut) return lut.getColor(s.getValue())
  return s.autoColor
}

/**
 * Advance slice animations by dt ms. Returns true while anything is moving.
 * Values ease towards their targets (0 when hidden), explosion and hover
 * towards their flags.
 */
export function stepSlices(slices: readonly Slice[], dt: number, hovered: Slice | null, animate: boolean): boolean {
  const k = animate ? 1 - Math.exp(-dt / 110) : 1
  const kh = animate ? 1 - Math.exp(-dt / 70) : 1
  let total = 0
  for (const s of slices) total += Math.abs(s.getValue())
  const eps = (total || 1) * 1e-5
  let busy = false
  for (const s of slices) {
    const tv = s.getVisible() ? Math.max(0, s.getValue()) : 0
    s.shown = approach(s.shown, tv, k, eps)
    if (s.shown !== tv) busy = true
    const te = s.getExploded() ? 1 : 0
    s.explodeT = approach(s.explodeT, te, k, 0.002)
    if (s.explodeT !== te) busy = true
    const th = s === hovered ? 1 : 0
    s.hoverT = approach(s.hoverT, th, kh, 0.01)
    if (s.hoverT !== th) busy = true
  }
  return busy
}

/** Canvas paint for a slice: user gradients pass through; solid colors get the theme treatment. */
export function slicePaint(
  ctx: CanvasRenderingContext2D,
  s: Slice,
  base: Color,
  t: Theme,
  box: { x: number; y: number; w: number; h: number },
  shade: (c: Color) => string | CanvasGradient,
): string | CanvasGradient {
  if (s.fill && !(s.fill instanceof SolidFill)) return fillToCanvas(ctx, s.fill, box.x, box.y, box.w, box.h) ?? 'transparent'
  const c = s.hoverT > 0 ? base.mix(new Color(255, 255, 255, base.a), 0.18 * s.hoverT) : base
  return t.isDark ? shade(c) : c.toCSS()
}

export const lighten = (c: Color, k: number) => c.mix(new Color(255, 255, 255, c.a), k)
export const darken = (c: Color, k: number) => c.mix(new Color(0, 0, 0, c.a), k)
