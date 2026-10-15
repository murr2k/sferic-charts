/**
 * Immutable RGBA color, channels 0..255.
 */
export class Color {
  constructor(
    readonly r: number,
    readonly g: number,
    readonly b: number,
    readonly a: number = 255,
  ) {}

  getR(): number { return this.r }
  getG(): number { return this.g }
  getB(): number { return this.b }
  getA(): number { return this.a }
  setR(r: number): Color { return new Color(r, this.g, this.b, this.a) }
  setG(g: number): Color { return new Color(this.r, g, this.b, this.a) }
  setB(b: number): Color { return new Color(this.r, this.g, b, this.a) }
  setA(a: number): Color { return new Color(this.r, this.g, this.b, a) }

  /** Multiply RGB channels; >1 lightens, <1 darkens. */
  scale(k: number): Color {
    return new Color(clamp255(this.r * k), clamp255(this.g * k), clamp255(this.b * k), this.a)
  }

  /** Linear blend towards `other` by t in [0,1]. */
  mix(other: Color, t: number): Color {
    return new Color(
      this.r + (other.r - this.r) * t,
      this.g + (other.g - this.g) * t,
      this.b + (other.b - this.b) * t,
      this.a + (other.a - this.a) * t,
    )
  }

  equals(o: Color): boolean {
    return this.r === o.r && this.g === o.g && this.b === o.b && this.a === o.a
  }

  private css?: string
  toCSS(): string {
    return (this.css ??= `rgba(${Math.round(this.r)},${Math.round(this.g)},${Math.round(this.b)},${+(this.a / 255).toFixed(4)})`)
  }

  toHex(): string {
    const h = (v: number) => Math.round(v).toString(16).padStart(2, '0')
    return `#${h(this.r)}${h(this.g)}${h(this.b)}${this.a === 255 ? '' : h(this.a)}`
  }

  /** Straight (non-premultiplied) floats 0..1. */
  toFloat(): [number, number, number, number] {
    return [this.r / 255, this.g / 255, this.b / 255, this.a / 255]
  }

  /** Packed little-endian RGBA uint32, for Uint8 vertex attributes. */
  toUint32(): number {
    return ((Math.round(this.a) << 24) | (Math.round(this.b) << 16) | (Math.round(this.g) << 8) | Math.round(this.r)) >>> 0
  }

  toString(): string { return this.toCSS() }
}

const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v)

export const ColorRGBA = (r: number, g: number, b: number, a = 255): Color => new Color(r, g, b, a)

export function ColorHEX(hex: string): Color {
  let s = hex.trim().replace(/^#/, '')
  if (s.length === 3 || s.length === 4) s = [...s].map((c) => c + c).join('')
  const n = parseInt(s, 16)
  if (s.length === 8) return new Color((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255)
  return new Color((n >>> 16) & 255, (n >>> 8) & 255, n & 255, 255)
}

/** Hue in degrees, saturation and value 0..1. */
export function ColorHSV(h: number, s = 1, v = 1, a = 255): Color {
  h = ((h % 360) + 360) % 360
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  let r = 0, g = 0, b = 0
  if (h < 60) [r, g, b] = [c, x, 0]
  else if (h < 120) [r, g, b] = [x, c, 0]
  else if (h < 180) [r, g, b] = [0, c, x]
  else if (h < 240) [r, g, b] = [0, x, c]
  else if (h < 300) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  return new Color((r + m) * 255, (g + m) * 255, (b + m) * 255, a)
}

let cssCtx: CanvasRenderingContext2D | null = null
/** Parse any CSS color string. */
export function ColorCSS(css: string): Color {
  if (/^#/.test(css.trim())) return ColorHEX(css)
  const m = css.match(/rgba?\(([^)]+)\)/i)
  if (m) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat)
    return new Color(p[0], p[1], p[2], p.length > 3 ? (p[3] <= 1 ? p[3] * 255 : p[3]) : 255)
  }
  if (!cssCtx) cssCtx = document.createElement('canvas').getContext('2d')
  if (!cssCtx) return new Color(0, 0, 0)
  cssCtx.fillStyle = '#000'
  cssCtx.fillStyle = css
  return ColorCSS(String(cssCtx.fillStyle))
}

export const isColor = (v: unknown): v is Color => v instanceof Color
