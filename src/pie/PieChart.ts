import { Color } from '../core/color'
import { Legend, LegendOptions } from '../core/Legend'
import { FontSettings, Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, Fill, isEmptyLine, LineStyle, LUT, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { seriesColor } from '../core/theme'
import { Rect } from '../core/util'
import type { PointerInfo, Surface } from '../render/Surface'
import { contrastText, drawResultTable, fillLines, formatValue, measureLines, onBackground } from '../polar/common'
import {
  darken, lighten, Slice, sliceBaseColor, SliceHost, SliceLabelFormatter, SliceLabelFormatters, slicePaint, SliceSorter, SliceSorters, stepSlices,
} from './slices'

export const PieChartTypes = { LabelsInsideSlices: 'labels-inside', LabelsOnSides: 'labels-on-sides' } as const
export type PieChartType = (typeof PieChartTypes)[keyof typeof PieChartTypes]

export interface PieChartOptions extends PanelOptions {
  surface?: Surface
  type?: PieChartType
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

export class PieSlice extends Slice {}

interface Geo { s: Slice; a0: number; a1: number; ox: number; oy: number }
interface SideLabel { s: Slice; lines: string[]; w: number; h: number; side: 1 | -1; ax: number; ay: number; ex: number; ey: number; x: number; y: number }

const TAU = Math.PI * 2

/**
 * Pie and donut chart (Canvas2D). Slices animate value changes, explode on
 * click and highlight on hover; labels sit inside the slices or in side columns.
 */
export class PieChart extends Panel implements SliceHost {
  readonly legend: Legend
  private slices: PieSlice[] = []
  private type: PieChartType
  private innerRadius = 0
  private formatter: SliceLabelFormatter = SliceLabelFormatters.NamePlusRelativeValue
  private sorter: SliceSorter = SliceSorters.None
  private multiExplode = true
  private explodeOffset: number | null = null
  private lut: LUT | null = null
  private labelFont: FontSettings
  private labelFontSet = false
  private labelColor: Color | null = null
  private labelsVisible = true
  private connector: LineStyle | null = null
  private connectorGap = 4
  private sliceStroke: LineStyle | null = null
  private animations = true
  private cursorEnabled = true
  private cx = 0
  private cy = 0
  private R = 1
  private Ri = 0
  private geo: Geo[] = []
  private sideLabels: SideLabel[] = []
  private hovered: Slice | null = null
  private pointer: { x: number; y: number } | null = null
  private lastTick = 0

  constructor(o: PieChartOptions = {}) {
    super(o)
    this.type = o.type ?? PieChartTypes.LabelsOnSides
    this.legend = new Legend(this, o.legend)
    this.labelFont = new FontSettings(this.theme.fontSize, 'normal', this.theme.fontFamily)
  }

  // ---------------------------------------------------------------- slices

  addSlice(name: string, value: number) {
    const s = new PieSlice(this, name, value, this.slices.length, seriesColor(this.theme, this.slices.length))
    s.shown = this.animations ? 0 : Math.max(0, value)
    this.slices.push(s)
    if (this.legend.autoAdd) this.legend.add(s)
    this.requestRender()
    return s
  }
  addSlices(items: { name: string; value: number }[]) { return items.map((i) => this.addSlice(i.name, i.value)) }
  getSlices() { return [...this.slices] }
  /** @internal */ onSliceChange(_s: Slice) { this.requestRender() }
  /** @internal */ onSliceDispose(s: Slice) {
    this.slices = this.slices.filter((x) => x !== s)
    this.legend.remove(s)
    if (this.hovered === s) this.hovered = null
    this.requestRender()
  }
  /** @internal */ onSliceExplode(s: Slice) {
    if (s.getExploded() && !this.multiExplode) for (const o of this.slices) if (o !== s) o.setExplodedSilently(false)
    this.requestRender()
  }
  /** @internal */ sliceColor(s: Slice) { return sliceBaseColor(s, this.lut) }

  // ---------------------------------------------------------------- configuration

  /** Donut hole as a percentage of the radius (0 = pie). */
  setInnerRadius(percent: number) { this.innerRadius = Math.max(0, Math.min(95, percent)); this.requestRender(); return this }
  getInnerRadius() { return this.innerRadius }
  setLabelFormatter(f: SliceLabelFormatter) { this.formatter = f; this.requestRender(); return this }
  getLabelFormatter() { return this.formatter }
  setSliceSorter(f: SliceSorter) { this.sorter = f; this.requestRender(); return this }
  getSliceSorter() { return this.sorter }
  setMultipleSliceExplosion(v: boolean) {
    this.multiExplode = v
    if (!v) {
      const ex = this.slices.filter((s) => s.getExploded())
      ex.slice(1).forEach((s) => s.setExplodedSilently(false))
    }
    this.requestRender()
    return this
  }
  getMultipleSliceExplosion() { return this.multiExplode }
  /** Explosion distance in px (default scales with the radius). */
  setSliceExplosionOffset(px: number) { this.explodeOffset = px; this.requestRender(); return this }
  /** Color slices by value through a LUT (slices with explicit fills keep them). */
  setLUT(lut: LUT | undefined) { this.lut = lut ?? null; this.requestRender(); return this }
  getLUT() { return this.lut }
  setLabelFont(f: Mutator<FontSettings>) { this.labelFont = resolve(this.labelFont, f); this.labelFontSet = true; this.requestRender(); return this }
  setLabelFillStyle(f: Mutator<Fill>) {
    const nf = resolve<Fill>(new SolidFill({ color: this.labelColor ?? this.theme.tickLabelColor }), f)
    this.labelsVisible = nf.type !== 'empty'
    this.labelColor = nf.type === 'empty' ? this.labelColor : nf.getPrimaryColor()
    this.requestRender()
    return this
  }
  setLabelsVisible(v: boolean) { this.labelsVisible = v; this.requestRender(); return this }
  setLabelConnectorStyle(l: Mutator<LineStyle>) { this.connector = resolve<LineStyle>(this.connector ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.tickColor }) }), l); this.requestRender(); return this }
  setLabelConnectorGap(px: number) { this.connectorGap = px; this.requestRender(); return this }
  /** Separator stroke between slices. */
  setSliceStrokeStyle(l: Mutator<LineStyle>) { this.sliceStroke = resolve<LineStyle>(this.sliceStroke ?? this.defaultStroke(), l); this.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animations = v; return this }
  setCursorMode(m: string | undefined) { this.cursorEnabled = m !== 'disabled' && m !== undefined; return this }
  setAutoCursorMode(m: string) { return this.setCursorMode(m) }

  private defaultStroke() {
    return new SolidLine({ thickness: this.theme.isDark ? 1.2 : 2, fillStyle: new SolidFill({ color: this.theme.isDark ? new Color(0, 0, 0, 150) : new Color(255, 255, 255, 255) }) })
  }

  // ---------------------------------------------------------------- animation

  override tick(now: number): boolean {
    const a = super.tick(now)
    const dt = Math.min(64, Math.max(0, now - (this.lastTick || now)))
    this.lastTick = now
    const busy = stepSlices(this.slices, dt, this.hovered, this.animations)
    if (!busy) this.lastTick = 0
    return a || busy
  }

  // ---------------------------------------------------------------- layout

  private ordered() { return [...this.slices].sort(this.sorter) }
  private total() { return this.slices.reduce((a, s) => a + (s.getVisible() ? Math.max(0, s.getValue()) : 0), 0) }
  private labelText(s: Slice, total: number) { return this.formatter(s, total > 0 ? Math.max(0, s.getValue()) / total : 0) }

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    const fs = this.labelFont.size
    const fnt = this.labelFont.toCSS()
    const lh = fs * 1.25
    const sides = this.type === PieChartTypes.LabelsOnSides && this.labelsVisible
    const total = this.total()
    let colW = 0
    if (sides) {
      for (const s of this.slices) if (s.getVisible()) colW = Math.max(colW, measureLines(this.labelText(s, total), fnt, lh).w)
      colW = Math.min(area.w * 0.3, colW + 36)
    }
    const avail = Math.min((area.w - 2 * colW) / 2, area.h / 2 - (sides ? fs : 4))
    const off0 = this.explodeOffset ?? Math.max(6, avail * 0.07)
    this.R = Math.max(10, avail - off0 - 4)
    const off = this.explodeOffset ?? Math.max(6, this.R * 0.075)
    this.Ri = (this.R * this.innerRadius) / 100
    this.cx = area.x + area.w / 2
    this.cy = area.y + area.h / 2
    // Angles: clockwise from 12 o'clock.
    const shownTotal = this.slices.reduce((a, s) => a + s.shown, 0)
    this.geo = []
    let a = -Math.PI / 2
    for (const s of this.ordered()) {
      if (!(s.shown > 0) || !(shownTotal > 0)) continue
      const sweep = (s.shown / shownTotal) * TAU
      const m = a + sweep / 2
      const d = s.explodeT * off
      this.geo.push({ s, a0: a, a1: a + sweep, ox: Math.cos(m) * d, oy: Math.sin(m) * d })
      a += sweep
    }
    this.sideLabels = sides ? this.layoutSideLabels(area, total, fnt, lh, off) : []
    this.updateHover()
  }

  private layoutSideLabels(area: Rect, total: number, fnt: string, lh: number, off: number): SideLabel[] {
    const out: SideLabel[] = []
    const R = this.R
    for (const g of this.geo) {
      if (!g.s.getVisible() || g.a1 - g.a0 < 1e-3) continue
      const m = (g.a0 + g.a1) / 2
      const c = Math.cos(m), sn = Math.sin(m)
      const side: 1 | -1 = c >= 0 ? 1 : -1
      const { lines, w, h } = measureLines(this.labelText(g.s, total), fnt, lh)
      const bx = this.cx + g.ox, by = this.cy + g.oy
      const ax = bx + c * (R + this.connectorGap), ay = by + sn * (R + this.connectorGap)
      const ex = bx + c * (R + 16), ey = by + sn * (R + 16)
      out.push({ s: g.s, lines, w, h, side, ax, ay, ex, ey, x: this.cx + side * (R + off + 30), y: ey })
    }
    // Resolve vertical overlaps per side.
    for (const side of [1, -1] as const) {
      const col = out.filter((l) => l.side === side).sort((p, q) => p.y - q.y)
      const top = area.y + 2, bottom = area.y + area.h - 2
      for (let i = 0; i < col.length; i++) {
        const min = i ? col[i - 1].y + col[i - 1].h / 2 + col[i].h / 2 + 2 : top + col[i].h / 2
        if (col[i].y < min) col[i].y = min
      }
      for (let i = col.length - 1; i >= 0; i--) {
        const max = i < col.length - 1 ? col[i + 1].y - col[i + 1].h / 2 - col[i].h / 2 - 2 : bottom - col[i].h / 2
        if (col[i].y > max) col[i].y = max
      }
    }
    return out
  }

  // ---------------------------------------------------------------- drawing

  private slicePath(ctx: CanvasRenderingContext2D, g: Geo, grow = 0) {
    const cx = this.cx + g.ox, cy = this.cy + g.oy
    const R = this.R + grow, Ri = this.Ri
    ctx.beginPath()
    if (g.a1 - g.a0 >= TAU - 1e-6) {
      ctx.arc(cx, cy, R, 0, TAU)
      if (Ri > 0) {
        ctx.moveTo(cx + Ri, cy)
        ctx.arc(cx, cy, Ri, TAU, 0, true)
      }
      return
    }
    ctx.arc(cx, cy, R, g.a0, g.a1)
    if (Ri > 0) ctx.arc(cx, cy, Ri, g.a1, g.a0, true)
    else ctx.lineTo(cx, cy)
    ctx.closePath()
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const dark = t.isDark
    ctx.save()
    // Soft drop shadow under the whole pie.
    if (dark) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.65)'
      ctx.shadowBlur = 26
      ctx.shadowOffsetY = 8
      ctx.fillStyle = 'rgba(0,0,0,1)'
      for (const g of this.geo) {
        this.slicePath(ctx, g, g.s.hoverT * 4)
        ctx.fill()
      }
      ctx.restore()
    }
    const stroke = this.sliceStroke ?? this.defaultStroke()
    for (const g of this.geo) {
      const s = g.s
      const base = this.sliceColor(s)
      const grow = s.hoverT * 4
      const cx = this.cx + g.ox, cy = this.cy + g.oy
      const R = this.R + grow, Ri = this.Ri
      this.slicePath(ctx, g, grow)
      ctx.fillStyle = slicePaint(ctx, s, base, t, { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }, (c) => {
        const gr = ctx.createRadialGradient(cx, cy, Ri, cx, cy, R)
        gr.addColorStop(0, darken(c, Ri > 0 ? 0.28 : 0.42).toCSS())
        gr.addColorStop(0.6, c.toCSS())
        gr.addColorStop(0.92, lighten(c, 0.14).toCSS())
        gr.addColorStop(1, darken(c, 0.12).toCSS())
        return gr
      })
      if (dark && s.hoverT > 0) {
        ctx.save()
        ctx.shadowColor = base.setA(200 * s.hoverT).toCSS()
        ctx.shadowBlur = 18
        ctx.fill()
        ctx.restore()
      } else ctx.fill()
      // Glossy sheen from the top-left.
      if (dark && (!s.fill || s.fill instanceof SolidFill)) {
        const sh = ctx.createLinearGradient(this.cx - this.R, this.cy - this.R, this.cx + this.R * 0.2, this.cy + this.R * 0.4)
        sh.addColorStop(0, 'rgba(255,255,255,0.22)')
        sh.addColorStop(0.55, 'rgba(255,255,255,0.04)')
        sh.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = sh
        ctx.fill()
      }
      const ls = s.getStrokeStyle() ?? stroke
      if (!isEmptyLine(ls) && applyLineToCanvas(ctx, ls)) {
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
    }
    if (this.labelsVisible) {
      if (this.type === PieChartTypes.LabelsOnSides) this.drawSideLabels(ctx)
      else this.drawInsideLabels(ctx)
    }
    this.drawTooltip(ctx)
    ctx.restore()
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawInsideLabels(ctx: CanvasRenderingContext2D) {
    const total = this.total()
    // Scale with the pie unless the user chose a font.
    const fs = this.labelFontSet ? this.labelFont.size : Math.min(this.labelFont.size * 1.5, Math.max(this.labelFont.size, this.R * 0.045))
    const lh = fs * 1.25
    const fnt = new FontSettings(fs, 600, this.labelFont.family).toCSS()
    ctx.font = fnt
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const g of this.geo) {
      const sweep = g.a1 - g.a0
      if (sweep < 0.08) continue
      const { lines, w, h } = measureLines(this.labelText(g.s, total), fnt, lh)
      const rl = this.Ri > 0 ? (this.Ri + this.R) / 2 : this.R * 0.62
      const chord = 2 * rl * Math.sin(Math.min(sweep / 2, Math.PI / 2))
      const thick = this.Ri > 0 ? this.R - this.Ri : this.R
      if (w > Math.max(chord * 0.95, sweep > Math.PI ? Infinity : 0) || h > thick * 0.9) continue
      const m = (g.a0 + g.a1) / 2
      const x = this.cx + g.ox + Math.cos(m) * rl, y = this.cy + g.oy + Math.sin(m) * rl
      ctx.fillStyle = this.labelColor ? this.labelColor.toCSS() : contrastText(this.sliceColor(g.s))
      fillLines(ctx, lines, x, y, lh)
    }
  }

  private drawSideLabels(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = this.labelFont.size
    const lh = fs * 1.25
    ctx.font = this.labelFont.toCSS()
    ctx.textBaseline = 'middle'
    for (const l of this.sideLabels) {
      const a = Math.min(1, l.s.shown / Math.max(1e-9, l.s.getValue() || 1))
      ctx.globalAlpha = Math.max(0, Math.min(1, a))
      const c = this.sliceColor(l.s)
      if (!(this.connector && isEmptyLine(this.connector))) {
        if (this.connector) applyLineToCanvas(ctx, this.connector)
        else {
          ctx.strokeStyle = onBackground(c, t).setA(t.isDark ? 190 : 230).toCSS()
          ctx.lineWidth = 1.2
          ctx.setLineDash([])
        }
        ctx.beginPath()
        ctx.moveTo(l.ax, l.ay)
        ctx.lineTo(l.ex, l.ey)
        ctx.lineTo(l.x - l.side * 5, l.y)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(l.ax, l.ay, 2, 0, Math.PI * 2)
        ctx.fillStyle = ctx.strokeStyle
        ctx.fill()
      }
      ctx.fillStyle = (this.labelColor ?? t.tickLabelColor).toCSS()
      ctx.textAlign = l.side > 0 ? 'left' : 'right'
      fillLines(ctx, l.lines, l.x, l.y, lh)
    }
    ctx.globalAlpha = 1
  }

  private drawTooltip(ctx: CanvasRenderingContext2D) {
    const s = this.hovered
    const p = this.pointer
    if (!s || !p || !this.cursorEnabled) return
    const total = this.total()
    const c = onBackground(this.sliceColor(s).setA(255), this.theme)
    drawResultTable(ctx, this.theme, [
      [{ text: s.getName(), color: c }],
      ['Value:', formatValue(s.getValue())],
      ['Share:', `${total > 0 ? ((100 * Math.max(0, s.getValue())) / total).toFixed(1) : '0.0'} %`],
    ], p.x, p.y, this.rect)
  }

  // ---------------------------------------------------------------- interaction

  private sliceAt(x: number, y: number): Slice | null {
    for (let i = this.geo.length - 1; i >= 0; i--) {
      const g = this.geo[i]
      const dx = x - (this.cx + g.ox), dy = y - (this.cy + g.oy)
      const d = Math.hypot(dx, dy)
      if (d > this.R + g.s.hoverT * 4 + 1 || d < this.Ri) continue
      let a = Math.atan2(dy, dx) - g.a0
      a = ((a % TAU) + TAU) % TAU
      if (a <= g.a1 - g.a0) return g.s
    }
    return null
  }

  private updateHover() {
    const p = this.pointer
    const h = p ? this.sliceAt(p.x, p.y) : null
    if (h !== this.hovered) {
      this.hovered = h
      this.requestRender()
    }
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') {
      if (this.legend.onPointer('click', x, y)) return true
      const s = this.sliceAt(x, y)
      if (s) {
        s.setExploded(!s.getExploded())
        s.fire('click', e.native)
        return true
      }
      return false
    }
    if (e.type === 'move' && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      this.updateHover()
      return true
    }
    if (e.type === 'down' && this.legend.contains(x, y)) return true
    if (e.type === 'move') {
      this.pointer = { x, y }
      this.updateHover()
      this.surface.setCursor(this.hovered ? 'pointer' : 'default')
      return true
    }
    if (e.type === 'leave') {
      this.pointer = null
      this.updateHover()
      return true
    }
    return false
  }

  override dispose() {
    this.slices.forEach((s) => this.legend.remove(s))
    super.dispose()
  }
}
