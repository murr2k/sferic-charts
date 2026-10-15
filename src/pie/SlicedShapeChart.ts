import { Color } from '../core/color'
import { Legend, LegendOptions } from '../core/Legend'
import { FontSettings, Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, Fill, isEmptyLine, LineStyle, LUT, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { seriesColor } from '../core/theme'
import { Rect } from '../core/util'
import type { PointerInfo, Surface } from '../render/Surface'
import { contrastText, drawResultTable, fillLines, formatValue, measureLines, onBackground } from '../polar/common'
import {
  darken, lighten, Slice, sliceBaseColor, SliceHost, SliceLabelFormatter, SliceLabelFormatters, SliceLabelSide, slicePaint, SliceSorter, SliceSorters,
  stepSlices,
} from './slices'

export const SlicedChartTypes = { LabelsInsideSlices: 'labels-inside', LabelsOnSides: 'labels-on-sides' } as const
export type SlicedChartType = (typeof SlicedChartTypes)[keyof typeof SlicedChartTypes]
export const SliceModes = { VariableHeight: 'variable-height', VariableWidth: 'variable-width' } as const
export type SliceMode = (typeof SliceModes)[keyof typeof SliceModes]

export interface SlicedChartOptions extends PanelOptions {
  surface?: Surface
  type?: SlicedChartType
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

/** Slice trapezoid: top/bottom y and widths (CSS px), centered on the chart axis. */
interface Trap { s: Slice; yt: number; yb: number; wt: number; wb: number }
interface SideLabel { s: Slice; lines: string[]; h: number; ax: number; ay: number; y: number }

/**
 * Shared implementation of funnel and pyramid charts: a stack of trapezoid
 * slices whose heights (or widths) follow the slice values.
 */
export abstract class SlicedShapeChart extends Panel implements SliceHost {
  readonly legend: Legend
  protected slices: Slice[] = []
  protected type: SlicedChartType
  protected mode: SliceMode = SliceModes.VariableHeight
  protected neck: number
  protected head = 100
  protected gap = 4
  protected labelSide: SliceLabelSide = SliceLabelSide.Right
  protected formatter: SliceLabelFormatter = SliceLabelFormatters.NamePlusValue
  protected sorter: SliceSorter = SliceSorters.ValueDescending
  protected lut: LUT | null = null
  protected labelFont: FontSettings
  protected labelFontSet = false
  protected labelColor: Color | null = null
  protected labelsVisible = true
  protected connector: LineStyle | null = null
  protected connectorGap = 6
  protected sliceStroke: LineStyle | null = null
  protected animations = true
  protected cursorEnabled = true
  private traps: Trap[] = []
  private labels: SideLabel[] = []
  private cx = 0
  private shapeW = 1
  private labelX = 0
  private hovered: Slice | null = null
  private pointer: { x: number; y: number } | null = null
  private lastTick = 0
  /** true: stacked bottom-up and narrowing upwards (pyramid). */
  protected abstract readonly upward: boolean

  constructor(o: SlicedChartOptions, defaultNeck: number) {
    super(o)
    this.type = o.type ?? SlicedChartTypes.LabelsOnSides
    this.neck = defaultNeck
    this.legend = new Legend(this, o.legend)
    this.labelFont = new FontSettings(this.theme.fontSize, 'normal', this.theme.fontFamily)
  }

  // ---------------------------------------------------------------- slices

  addSlice(name: string, value: number) {
    const s = new Slice(this, name, value, this.slices.length, seriesColor(this.theme, this.slices.length))
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
  /** @internal */ onSliceExplode(_s: Slice) { this.requestRender() }
  /** @internal */ sliceColor(s: Slice) { return sliceBaseColor(s, this.lut) }

  // ---------------------------------------------------------------- configuration

  setSliceMode(m: SliceMode) { this.mode = m; this.requestRender(); return this }
  getSliceMode() { return this.mode }
  /** Width of the narrow end, % of the chart width. */
  setNeckWidth(percent: number) { this.neck = Math.max(0, Math.min(100, percent)); this.requestRender(); return this }
  getNeckWidth() { return this.neck }
  /** Gap between slices in px. */
  setSliceGap(px: number) { this.gap = Math.max(0, px); this.requestRender(); return this }
  getSliceGap() { return this.gap }
  setLabelSide(side: SliceLabelSide) { this.labelSide = side; this.requestRender(); return this }
  getLabelSide() { return this.labelSide }
  setLabelFormatter(f: SliceLabelFormatter) { this.formatter = f; this.requestRender(); return this }
  setSliceSorter(f: SliceSorter) { this.sorter = f; this.requestRender(); return this }
  setLUT(lut: LUT | undefined) { this.lut = lut ?? null; this.requestRender(); return this }
  setLabelFont(f: Mutator<FontSettings>) { this.labelFont = resolve(this.labelFont, f); this.labelFontSet = true; this.requestRender(); return this }
  setLabelFillStyle(f: Mutator<Fill>) {
    const nf = resolve<Fill>(new SolidFill({ color: this.labelColor ?? this.theme.tickLabelColor }), f)
    this.labelsVisible = nf.type !== 'empty'
    if (nf.type !== 'empty') this.labelColor = nf.getPrimaryColor()
    this.requestRender()
    return this
  }
  setLabelsVisible(v: boolean) { this.labelsVisible = v; this.requestRender(); return this }
  setLabelConnectorStyle(l: Mutator<LineStyle>) { this.connector = resolve<LineStyle>(this.connector ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.tickColor }) }), l); this.requestRender(); return this }
  setLabelConnectorGap(px: number) { this.connectorGap = px; this.requestRender(); return this }
  setSliceStrokeStyle(l: Mutator<LineStyle>) { this.sliceStroke = resolve<LineStyle>(this.sliceStroke ?? this.defaultStroke(), l); this.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animations = v; return this }
  setCursorMode(m: string | undefined) { this.cursorEnabled = m !== 'disabled' && m !== undefined; return this }
  setAutoCursorMode(m: string) { return this.setCursorMode(m) }

  private defaultStroke() {
    return new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.isDark ? new Color(255, 255, 255, 40) : new Color(0, 0, 0, 30) }) })
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

  private total() { return this.slices.reduce((a, s) => a + (s.getVisible() ? Math.max(0, s.getValue()) : 0), 0) }
  private labelText(s: Slice, total: number) { return this.formatter(s, total > 0 ? Math.max(0, s.getValue()) / total : 0) }

  /** Outline width (fraction of full width) at normalized depth u (0 = wide end). */
  private outline(u: number) {
    const wide = this.upward ? 1 : this.head / 100
    return wide + (this.neck / 100 - wide) * u
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    const fs = this.labelFont.size
    const fnt = this.labelFont.toCSS()
    const lh = fs * 1.25
    const sides = this.type === SlicedChartTypes.LabelsOnSides && this.labelsVisible
    const total = this.total()
    let colW = 0
    if (sides) {
      for (const s of this.slices) if (s.getVisible()) colW = Math.max(colW, measureLines(this.labelText(s, total), fnt, lh).w)
      colW = Math.min(area.w * 0.4, colW + 40)
    }
    const pad = 6
    const box: Rect = { x: area.x + pad, y: area.y + pad, w: Math.max(10, area.w - 2 * pad - colW), h: Math.max(10, area.h - 2 * pad) }
    if (sides && this.labelSide === SliceLabelSide.Left) box.x += colW
    // Keep a pleasant aspect: shape no wider than 1.3x its height.
    const W = Math.min(box.w, box.h * 1.3)
    this.shapeW = W
    this.cx = box.x + box.w / 2
    this.labelX = this.labelSide === SliceLabelSide.Right ? this.cx + W / 2 + 28 : this.cx - W / 2 - 28
    const items = [...this.slices].sort(this.sorter).filter((s) => s.shown > 1e-9)
    const shownTotal = items.reduce((a, s) => a + s.shown, 0)
    const maxShown = Math.max(0, ...items.map((s) => s.shown))
    this.traps = []
    const n = items.length
    const H = box.h
    const gapTotal = Math.min(H * 0.5, this.gap * Math.max(0, n - 1))
    const usable = H - gapTotal
    const g = n > 1 ? gapTotal / (n - 1) : 0
    let depth = 0
    items.forEach((s, i) => {
      let u0: number, u1: number, w0: number, w1: number
      if (this.mode === SliceModes.VariableWidth) {
        u0 = i / n
        u1 = (i + 1) / n
        w0 = maxShown > 0 ? s.shown / maxShown : 0
        const next = items[i + 1]
        w1 = next ? next.shown / maxShown : w0 * (this.upward ? this.neck / 100 : Math.max(0.35, this.neck / 100))
        // scale by the outline so the stack keeps the family's shape
        w0 *= this.upward ? 1 : this.head / 100
        w1 *= this.upward ? 1 : this.head / 100
      } else {
        u0 = depth / shownTotal
        u1 = (depth + s.shown) / shownTotal
        w0 = this.outline(u0)
        w1 = this.outline(u1)
      }
      depth += s.shown
      // Map depth to y, inserting the gaps.
      const yA = u0 * usable + i * g, yB = u1 * usable + i * g
      const top = this.upward ? box.y + H - yB : box.y + yA
      const bot = this.upward ? box.y + H - yA : box.y + yB
      this.traps.push({ s, yt: top, yb: bot, wt: (this.upward ? w1 : w0) * W, wb: (this.upward ? w0 : w1) * W })
    })
    this.labels = sides ? this.layoutLabels(area, total, fnt, lh) : []
    this.updateHover()
  }

  private layoutLabels(area: Rect, total: number, fnt: string, lh: number): SideLabel[] {
    const right = this.labelSide === SliceLabelSide.Right ? 1 : -1
    const out: SideLabel[] = this.traps.map((tr) => {
      const ym = (tr.yt + tr.yb) / 2
      const wm = (tr.wt + tr.wb) / 2
      const { lines, h } = measureLines(this.labelText(tr.s, total), fnt, lh)
      return { s: tr.s, lines, h, ax: this.cx + (right * wm) / 2 + right * this.connectorGap, ay: ym, y: ym }
    })
    const col = [...out].sort((p, q) => p.y - q.y)
    const top = area.y + 2, bottom = area.y + area.h - 2
    for (let i = 0; i < col.length; i++) {
      const min = i ? col[i - 1].y + col[i - 1].h / 2 + col[i].h / 2 + 2 : top + col[i].h / 2
      if (col[i].y < min) col[i].y = min
    }
    for (let i = col.length - 1; i >= 0; i--) {
      const max = i < col.length - 1 ? col[i + 1].y - col[i + 1].h / 2 - col[i].h / 2 - 2 : bottom - col[i].h / 2
      if (col[i].y > max) col[i].y = max
    }
    return out
  }

  // ---------------------------------------------------------------- drawing

  private trapPath(ctx: CanvasRenderingContext2D, tr: Trap, grow: number) {
    const { cx } = this
    ctx.beginPath()
    ctx.moveTo(cx - tr.wt / 2 - grow, tr.yt)
    ctx.lineTo(cx + tr.wt / 2 + grow, tr.yt)
    ctx.lineTo(cx + tr.wb / 2 + grow, tr.yb)
    ctx.lineTo(cx - tr.wb / 2 - grow, tr.yb)
    ctx.closePath()
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const dark = t.isDark
    ctx.save()
    if (dark && this.traps.length) {
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.6)'
      ctx.shadowBlur = 22
      ctx.shadowOffsetY = 6
      ctx.fillStyle = '#000'
      for (const tr of this.traps) {
        this.trapPath(ctx, tr, tr.s.hoverT * 3)
        ctx.fill()
      }
      ctx.restore()
    }
    const stroke = this.sliceStroke ?? this.defaultStroke()
    const W = this.shapeW
    for (const tr of this.traps) {
      const s = tr.s
      const base = this.sliceColor(s)
      const grow = s.hoverT * 3
      this.trapPath(ctx, tr, grow)
      const x0 = this.cx - W / 2, y0 = tr.yt
      ctx.fillStyle = slicePaint(ctx, s, base, t, { x: x0, y: y0, w: W, h: tr.yb - tr.yt }, (c) => {
        const wmax = Math.max(tr.wt, tr.wb) + 2 * grow
        const g = ctx.createLinearGradient(this.cx - wmax / 2, 0, this.cx + wmax / 2, 0)
        g.addColorStop(0, darken(c, 0.38).toCSS())
        g.addColorStop(0.38, lighten(c, 0.16).toCSS())
        g.addColorStop(0.5, c.toCSS())
        g.addColorStop(1, darken(c, 0.45).toCSS())
        return g
      })
      if (dark && s.hoverT > 0) {
        ctx.save()
        ctx.shadowColor = base.setA(200 * s.hoverT).toCSS()
        ctx.shadowBlur = 16
        ctx.fill()
        ctx.restore()
      } else ctx.fill()
      const ls = s.getStrokeStyle() ?? stroke
      if (!isEmptyLine(ls) && applyLineToCanvas(ctx, ls)) {
        ctx.lineJoin = 'round'
        ctx.stroke()
      }
    }
    if (this.labelsVisible) {
      if (this.type === SlicedChartTypes.LabelsOnSides) this.drawSideLabels(ctx)
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
    const fs = this.labelFontSet ? this.labelFont.size : Math.min(this.labelFont.size * 1.4, Math.max(this.labelFont.size, this.shapeW * 0.028))
    const lh = fs * 1.25
    const fnt = new FontSettings(fs, 600, this.labelFont.family).toCSS()
    ctx.font = fnt
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const tr of this.traps) {
      const { lines, w, h } = measureLines(this.labelText(tr.s, total), fnt, lh)
      const sh = tr.yb - tr.yt
      if (h > sh - 2) continue
      // Slide from the center towards the wider edge until the text fits (triangular apex slices).
      const wAt = (yy: number) => tr.wt + ((tr.wb - tr.wt) * (yy - tr.yt)) / (sh || 1)
      const dir = tr.wb >= tr.wt ? 1 : -1
      const room = (sh - h) / 2 - 1
      let y: number | null = null
      for (let k = 0; k <= 6; k++) {
        const yy = (tr.yt + tr.yb) / 2 + (dir * room * k) / 6
        if (Math.min(wAt(yy - h / 2), wAt(yy + h / 2)) - 8 >= w) { y = yy; break }
      }
      if (y === null) continue
      ctx.fillStyle = this.labelColor ? this.labelColor.toCSS() : contrastText(this.sliceColor(tr.s))
      fillLines(ctx, lines, this.cx, y, lh)
    }
  }

  private drawSideLabels(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = this.labelFont.size
    const lh = fs * 1.25
    const right = this.labelSide === SliceLabelSide.Right ? 1 : -1
    ctx.font = this.labelFont.toCSS()
    ctx.textBaseline = 'middle'
    for (const l of this.labels) {
      const c = this.sliceColor(l.s)
      ctx.globalAlpha = Math.max(0, Math.min(1, l.s.shown / Math.max(1e-9, l.s.getValue() || 1)))
      if (!(this.connector && isEmptyLine(this.connector))) {
        if (this.connector) applyLineToCanvas(ctx, this.connector)
        else {
          ctx.strokeStyle = onBackground(c, t).setA(t.isDark ? 190 : 230).toCSS()
          ctx.lineWidth = 1.2
          ctx.setLineDash([])
        }
        const ex = this.labelX - right * 14
        ctx.beginPath()
        ctx.moveTo(l.ax, l.ay)
        ctx.lineTo(ex, l.ay)
        ctx.lineTo(this.labelX - right * 5, l.y)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(l.ax, l.ay, 2, 0, Math.PI * 2)
        ctx.fillStyle = ctx.strokeStyle
        ctx.fill()
      }
      ctx.fillStyle = (this.labelColor ?? t.tickLabelColor).toCSS()
      ctx.textAlign = right > 0 ? 'left' : 'right'
      fillLines(ctx, l.lines, this.labelX, l.y, lh)
    }
    ctx.globalAlpha = 1
  }

  private drawTooltip(ctx: CanvasRenderingContext2D) {
    const s = this.hovered
    const p = this.pointer
    if (!s || !p || !this.cursorEnabled) return
    const total = this.total()
    drawResultTable(ctx, this.theme, [
      [{ text: s.getName(), color: onBackground(this.sliceColor(s).setA(255), this.theme) }],
      ['Value:', formatValue(s.getValue())],
      ['Share:', `${total > 0 ? ((100 * Math.max(0, s.getValue())) / total).toFixed(1) : '0.0'} %`],
    ], p.x, p.y, this.rect)
  }

  // ---------------------------------------------------------------- interaction

  private sliceAt(x: number, y: number): Slice | null {
    for (const tr of this.traps) {
      if (y < tr.yt || y > tr.yb) continue
      const k = (y - tr.yt) / (tr.yb - tr.yt || 1)
      const w = tr.wt + (tr.wb - tr.wt) * k
      if (Math.abs(x - this.cx) <= w / 2 + 3) return tr.s
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
