// Shared helpers for the polar, spider, pie, gauge, funnel and pyramid charts.
import { Color } from '../core/color'
import { Theme, font } from '../core/theme'
import { Rect, roundRect, textWidth } from '../core/util'

export const DEG = Math.PI / 180

export type TableCell = string | { text: string; color?: Color }
export type TableRows = TableCell[][]

/** Cursor result table in the ChartXY style, placed next to (ax, ay) and kept inside `bounds`. */
export function drawResultTable(ctx: CanvasRenderingContext2D, t: Theme, rows: TableRows, ax: number, ay: number, bounds: Rect) {
  if (!rows.length) return
  const fs = t.fontSize
  const cell = (c: TableCell) => (typeof c === 'string' ? { text: c, color: undefined } : c)
  const fnt = font(t, fs)
  const cols = Math.max(...rows.map((r) => r.length))
  const colW = new Array(cols).fill(0)
  for (const r of rows) r.forEach((c, i) => (colW[i] = Math.max(colW[i], textWidth(cell(c).text, fnt))))
  const lh = fs * 1.45
  const pad = 8
  const singles = rows.filter((r) => r.length === 1).map((r) => textWidth(cell(r[0]).text, fnt))
  const w = Math.max(colW.reduce((a, b) => a + b, 0) + (cols - 1) * 12, ...singles) + pad * 2
  const h = rows.length * lh + pad * 2 - (lh - fs)
  let x = ax + 14, y = ay - h - 10
  const B = bounds
  if (x + w > B.x + B.w - 4) x = ax - w - 14
  if (x < B.x + 4) x = B.x + 4
  if (y < B.y + 4) y = ay + 14
  if (y + h > B.y + B.h - 4) y = B.y + B.h - h - 4
  ctx.save()
  roundRect(ctx, x, y, w, h, 5)
  ctx.fillStyle = t.cursor.tableFill.toCSS()
  ctx.fill()
  ctx.strokeStyle = t.cursor.tableStroke.toCSS()
  ctx.lineWidth = 1
  ctx.setLineDash([])
  ctx.stroke()
  ctx.font = fnt
  ctx.textBaseline = 'middle'
  rows.forEach((r, ri) => {
    let cx = x + pad
    const cy = y + pad + ri * lh + fs / 2 + 1
    r.forEach((c0, ci) => {
      const c = cell(c0)
      ctx.fillStyle = (c.color ?? t.cursor.textColor).toCSS()
      if (ci === r.length - 1 && r.length > 1 && ci === cols - 1) {
        ctx.textAlign = 'right'
        ctx.fillText(c.text, x + w - pad, cy)
      } else {
        ctx.textAlign = 'left'
        ctx.fillText(c.text, cx, cy)
      }
      cx += colW[ci] + 12
    })
  })
  ctx.restore()
}

/** Cursor value pill (axis cursor tick look). */
export function drawPill(ctx: CanvasRenderingContext2D, t: Theme, text: string, cx: number, cy: number) {
  const fs = t.fontSize
  ctx.font = font(t, fs)
  const w = textWidth(text, ctx.font) + 10
  const h = fs + 8
  roundRect(ctx, cx - w / 2, cy - h / 2, w, h, 3)
  ctx.fillStyle = t.cursor.tickFill.toCSS()
  ctx.fill()
  ctx.fillStyle = t.cursor.tickText.toCSS()
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, cx, cy + 0.5)
}

/** Relative luminance 0..1 (sRGB weights, no gamma). */
export const luminance = (c: Color) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255

/** A series color adjusted to stay visible as text / thin lines on the theme background. */
export function onBackground(c: Color, t: Theme): Color {
  const l = luminance(c)
  if (!t.isDark && l > 0.55) return c.mix(new Color(0, 0, 0, c.a), Math.min(0.55, (l - 0.4) * 1.1))
  if (t.isDark && l < 0.3) return c.mix(new Color(255, 255, 255, c.a), 0.35)
  return c
}

/** Readable text color on top of `bg`. */
export const contrastText = (bg: Color) => (luminance(bg) > 0.58 ? 'rgba(18,18,18,0.92)' : 'rgba(255,255,255,0.96)')

/** Subtle text halo so labels stay readable over data. */
export function textHalo(ctx: CanvasRenderingContext2D, t: Theme, on: boolean) {
  if (on) {
    ctx.shadowColor = t.isDark ? 'rgba(0,0,0,0.95)' : 'rgba(255,255,255,0.95)'
    ctx.shadowBlur = 3
  } else {
    ctx.shadowColor = 'transparent'
    ctx.shadowBlur = 0
  }
}

/** Exponential approach of `cur` to `target`; k = 1 - exp(-dt / tau). */
export function approach(cur: number, target: number, k: number, eps: number): number {
  const d = target - cur
  if (Math.abs(d) <= eps) return target
  return cur + d * k
}

/** Locale-ish compact value formatting for labels. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  const a = Math.abs(v)
  const digits = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 3
  return v.toLocaleString('en-US', { maximumFractionDigits: digits })
}

/** Split label text on newlines and measure the block. */
export function measureLines(text: string, fnt: string, lh: number) {
  const lines = text.split('\n')
  const w = Math.max(0, ...lines.map((l) => textWidth(l, fnt)))
  return { lines, w, h: lines.length * lh }
}

/** Draw multi-line text centered vertically on y. */
export function fillLines(ctx: CanvasRenderingContext2D, lines: string[], x: number, y: number, lh: number) {
  const y0 = y - ((lines.length - 1) * lh) / 2
  lines.forEach((l, i) => ctx.fillText(l, x, y0 + i * lh))
}
