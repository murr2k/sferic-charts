import { Color } from './color'
import { LUT } from './style'
import { Theme, font } from './theme'
import { formatNumber, decimalsForStep, Rect, rectContains, roundRect, textWidth } from './util'

export type ShapeName = 'circle' | 'square' | 'triangle' | 'diamond' | 'cross' | 'x' | 'star' | 'arrow'

export type LegendSymbol =
  | { kind: 'line'; color: Color }
  | { kind: 'point'; color: Color; shape: ShapeName }
  | { kind: 'rect'; color: Color }

export interface LegendTarget {
  getName(): string
  getLegendSymbol(): LegendSymbol
  getVisible(): boolean
  setVisible(v: boolean): unknown
  /** Optional emphasis while the legend entry is hovered. */
  setHighlight?(v: boolean): unknown
}

export type LegendPosition =
  | 'bottom' | 'top' | 'left' | 'right'
  | 'top-right' | 'top-left' | 'bottom-right' | 'bottom-left' | 'right-center'

export interface LegendOptions {
  visible: boolean
  position: LegendPosition
  title: string
  addEntriesAutomatically: boolean
  /** Allow click-to-toggle. */
  toggleVisibilityOnClick: boolean
}

export interface LUTEntryOptions {
  name?: string
  lutLength?: number
  lutThickness?: number
  units?: string
  formatter?: (v: number) => string
}

interface Entry {
  target?: LegendTarget
  lut?: LUT
  lutOpts?: LUTEntryOptions
  rect: Rect
}

interface Host {
  requestRender(): void
  getTheme(): Theme
}

/** Chart legend: series entries (click toggles visibility) and LUT color bars. */
export class Legend {
  private entries: Entry[] = []
  private opts: LegendOptions = {
    visible: true,
    position: 'bottom',
    title: '',
    addEntriesAutomatically: true,
    toggleVisibilityOnClick: true,
  }
  private box: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private hovered: Entry | null = null
  private vertical = false

  constructor(private host: Host, o: Partial<LegendOptions> = {}) {
    Object.assign(this.opts, o)
  }

  setOptions(o: Partial<LegendOptions>) { Object.assign(this.opts, o); this.host.requestRender(); return this }
  getOptions(): LegendOptions { return { ...this.opts } }
  setVisible(v: boolean) { return this.setOptions({ visible: v }) }
  getVisible() { return this.opts.visible }
  setPosition(p: LegendPosition) { return this.setOptions({ position: p }) }
  setTitle(t: string) { return this.setOptions({ title: t }) }
  get autoAdd() { return this.opts.addEntriesAutomatically }

  add(target: LegendTarget | LUT | { getLegendTargets(): LegendTarget[] }, o: LUTEntryOptions & { name?: string } = {}) {
    if (target instanceof LUT) {
      this.entries.push({ lut: target, lutOpts: o, rect: { x: 0, y: 0, w: 0, h: 0 } })
    } else if ('getLegendTargets' in target) {
      for (const t of target.getLegendTargets()) this.add(t)
    } else if (!this.entries.some((e) => e.target === target)) {
      this.entries.push({ target, rect: { x: 0, y: 0, w: 0, h: 0 } })
    }
    this.host.requestRender()
    return this
  }
  remove(target: LegendTarget | LUT) {
    this.entries = this.entries.filter((e) => e.target !== target && e.lut !== target)
    this.host.requestRender()
    return this
  }
  clear() { this.entries = []; this.host.requestRender(); return this }
  /** Replace a LUT entry's LUT (e.g. after the series changes palette). */
  replaceLUT(old: LUT, next: LUT) {
    for (const e of this.entries) if (e.lut === old) e.lut = next
  }
  /** Rename a LUT entry in place (keeps its position). */
  setLUTEntryName(lut: LUT, name: string) {
    for (const e of this.entries) if (e.lut === lut) e.lutOpts = { ...(e.lutOpts ?? {}), name }
    this.host.requestRender()
    return this
  }
  hasEntries() { return this.entries.length > 0 }

  private get fontSize() { return this.host.getTheme().fontSize }

  private entrySize(e: Entry, vertical: boolean): [number, number] {
    const t = this.host.getTheme()
    const fs = this.fontSize
    if (e.target) {
      return [16 + textWidth(e.target.getName(), font(t, fs)) + 8, fs * 1.7]
    }
    const lo = e.lutOpts ?? {}
    const len = lo.lutLength ?? (vertical ? 140 : 180)
    const th = lo.lutThickness ?? 12
    const labels = this.lutLabels(e)
    const maxLabel = Math.max(0, ...labels.map((l) => textWidth(l.text, font(t, fs * 0.9))))
    const nameH = lo.name ? fs * 1.5 : 0
    const unitsH = e.lut!.units || lo.units ? fs * 1.3 : 0
    if (vertical) return [Math.max(th + 8 + maxLabel, lo.name ? textWidth(lo.name, font(t, fs)) : 0) + 8, nameH + len + unitsH + fs]
    return [len + maxLabel + 16, nameH + th + fs * 1.5 + 6]
  }

  private lutLabels(e: Entry): { v: number; text: string }[] {
    const lut = e.lut!
    const steps = lut.steps
    const fmt =
      e.lutOpts?.formatter ??
      ((v: number) => formatNumber(v, Math.min(4, decimalsForStep(Math.abs(lut.max - lut.min) / 4 || 1))))
    const picks = steps.length <= 6 ? steps : [0, 1, 2, 3].map((i) => steps[Math.round((i * (steps.length - 1)) / 3)])
    return picks.map((s) => ({ v: s.value, text: s.label ?? fmt(s.value) }))
  }

  /** Reserve space within `area`; returns the remaining area for the chart content. */
  layout(area: Rect): Rect {
    if (!this.opts.visible || !this.entries.length || this.opts.position === ('none' as LegendPosition)) {
      this.box = { x: 0, y: 0, w: 0, h: 0 }
      return area
    }
    const pos = this.opts.position
    const vertical = pos !== 'bottom' && pos !== 'top'
    this.vertical = vertical
    const fs = this.fontSize
    const titleH = this.opts.title ? fs * 1.6 : 0
    const pad = vertical ? 8 : 4
    if (!vertical) {
      // rows, wrapped, centered
      const maxW = area.w - 20
      const rows: Entry[][] = [[]]
      let rw = 0
      for (const e of this.entries) {
        const [w] = this.entrySize(e, false)
        if (rw + w > maxW && rows[rows.length - 1].length) {
          rows.push([])
          rw = 0
        }
        rows[rows.length - 1].push(e)
        rw += w + 8
      }
      const rowH = rows.map((r) => Math.max(...r.map((e) => this.entrySize(e, false)[1])))
      const h = rowH.reduce((a, b) => a + b, 0) + titleH + pad * 2
      const y0 = pos === 'bottom' ? area.y + area.h - h : area.y
      let y = y0 + pad + titleH
      rows.forEach((row, ri) => {
        const widths = row.map((e) => this.entrySize(e, false)[0])
        const total = widths.reduce((a, b) => a + b, 0) + 8 * (row.length - 1)
        let x = area.x + (area.w - total) / 2
        row.forEach((e, i) => {
          e.rect = { x, y, w: widths[i], h: rowH[ri] }
          x += widths[i] + 8
        })
        y += rowH[ri]
      })
      this.box = { x: area.x, y: y0, w: area.w, h }
      return pos === 'bottom' ? { ...area, h: area.h - h } : { ...area, y: area.y + h, h: area.h - h }
    }
    const sizes = this.entries.map((e) => this.entrySize(e, true))
    const w = Math.max(80, textWidth(this.opts.title, font(this.host.getTheme(), fs, 600)) + 16, ...sizes.map((s) => s[0] + 16))
    const h = sizes.reduce((a, s) => a + s[1], 0) + titleH + pad * 2
    let x0: number, y0: number
    const inside = pos.includes('-')
    if (pos === 'left') { x0 = area.x; y0 = area.y + (area.h - h) / 2 }
    else if (pos === 'right') { x0 = area.x + area.w - w; y0 = area.y + (area.h - h) / 2 }
    else if (pos === 'right-center') { x0 = area.x + area.w - w - 8; y0 = area.y + (area.h - h) / 2 }
    else if (pos === 'top-left') { x0 = area.x + 8; y0 = area.y + 8 }
    else if (pos === 'bottom-left') { x0 = area.x + 8; y0 = area.y + area.h - h - 8 }
    else if (pos === 'bottom-right') { x0 = area.x + area.w - w - 8; y0 = area.y + area.h - h - 8 }
    else { x0 = area.x + area.w - w - 8; y0 = area.y + 8 }
    let y = y0 + pad + titleH
    this.entries.forEach((e, i) => {
      e.rect = { x: x0 + 8, y, w: w - 16, h: sizes[i][1] }
      y += sizes[i][1]
    })
    this.box = { x: x0, y: y0, w, h }
    if (inside) return area
    return pos === 'left' ? { ...area, x: area.x + w + 6, w: area.w - w - 6 } : { ...area, w: area.w - w - 6 }
  }

  draw(ctx: CanvasRenderingContext2D) {
    if (!this.opts.visible || !this.entries.length || !this.box.w) return
    const t = this.host.getTheme()
    const fs = this.fontSize
    const b = this.box
    const panel = this.vertical || this.opts.title
    if (panel) {
      roundRect(ctx, b.x + 0.5, b.y + 0.5, b.w - 1, b.h - 1, 4)
      ctx.fillStyle = t.legend.panelFill.toCSS()
      ctx.fill()
      ctx.strokeStyle = t.legend.panelStroke.toCSS()
      ctx.lineWidth = 1
      ctx.stroke()
    }
    if (this.opts.title) {
      ctx.font = font(t, fs, 600)
      ctx.fillStyle = t.legend.titleColor.toCSS()
      ctx.textAlign = this.vertical ? 'left' : 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(this.opts.title, this.vertical ? b.x + 10 : b.x + b.w / 2, b.y + 6 + fs * 0.7)
    }
    for (const e of this.entries) {
      if (e.target) this.drawSeriesEntry(ctx, e, t, fs)
      else this.drawLUTEntry(ctx, e, t, fs)
    }
  }

  private drawSeriesEntry(ctx: CanvasRenderingContext2D, e: Entry, t: Theme, fs: number) {
    const tg = e.target!
    const vis = tg.getVisible()
    const sym = tg.getLegendSymbol()
    const r = e.rect
    const cy = r.y + r.h / 2
    const cx = r.x + 6
    const col = vis ? sym.color : t.legend.disabledColor
    drawMarker(ctx, sym.kind === 'point' ? sym.shape : sym.kind === 'rect' ? 'square' : 'circle', cx, cy, 5, col, t.isDark)
    ctx.font = font(t, fs)
    ctx.fillStyle = (vis ? t.legend.textColor : t.legend.disabledColor).toCSS()
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(tg.getName(), r.x + 16, cy + 0.5)
    if (this.hovered === e) {
      ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)'
      roundRect(ctx, r.x - 4, r.y + 1, r.w + 2, r.h - 2, 3)
      ctx.fill()
    }
  }

  private drawLUTEntry(ctx: CanvasRenderingContext2D, e: Entry, t: Theme, fs: number) {
    const lut = e.lut!
    const lo = e.lutOpts ?? {}
    const r = e.rect
    const labels = this.lutLabels(e)
    const th = lo.lutThickness ?? 12
    let y = r.y
    ctx.textBaseline = 'middle'
    if (lo.name) {
      ctx.font = font(t, fs)
      ctx.fillStyle = t.legend.textColor.toCSS()
      ctx.textAlign = 'left'
      drawMarker(ctx, 'circle', r.x + 6, y + fs * 0.75, 5, lut.getColor((lut.min + lut.max) / 2), t.isDark)
      ctx.fillText(lo.name, r.x + 16, y + fs * 0.75)
      y += fs * 1.5
    }
    const units = lo.units ?? lut.units
    const span = lut.max - lut.min || 1
    if (this.vertical) {
      const len = lo.lutLength ?? 140
      const x = r.x + 4
      const top = y + fs * 0.5
      const g = ctx.createLinearGradient(0, top + len, 0, top)
      fillLUTGradient(g, lut)
      ctx.fillStyle = g
      ctx.fillRect(x, top, th, len)
      ctx.strokeStyle = t.legend.panelStroke.toCSS()
      ctx.strokeRect(x + 0.5, top + 0.5, th - 1, len - 1)
      ctx.font = font(t, fs * 0.9)
      ctx.fillStyle = t.legend.textColor.toCSS()
      ctx.textAlign = 'left'
      for (const l of labels) ctx.fillText(l.text, x + th + 6, top + len - ((l.v - lut.min) / span) * len)
      if (units) ctx.fillText(units, x, top + len + fs * 0.9)
    } else {
      const len = lo.lutLength ?? 180
      const lw = textWidth(labels[0]?.text ?? '', font(t, fs * 0.9))
      const x = r.x + lw / 2 + 4
      const g = ctx.createLinearGradient(x, 0, x + len, 0)
      fillLUTGradient(g, lut)
      ctx.fillStyle = g
      roundRect(ctx, x, y + 2, len, th, 3)
      ctx.fill()
      ctx.font = font(t, fs * 0.9)
      ctx.fillStyle = t.legend.textColor.toCSS()
      ctx.textAlign = 'center'
      for (const l of labels) ctx.fillText(l.text, x + ((l.v - lut.min) / span) * len, y + th + 4 + fs * 0.6)
      if (units) {
        ctx.textAlign = 'left'
        ctx.fillText(units, x + len + 8, y + 2 + th / 2)
      }
    }
  }

  private setHovered(e: Entry | null) {
    if (e === this.hovered) return
    this.hovered?.target?.setHighlight?.(false)
    this.hovered = e
    e?.target?.setHighlight?.(true)
    this.host.requestRender()
  }

  /** Returns true if consumed. */
  onPointer(type: string, x: number, y: number): boolean {
    if (!this.opts.visible || !rectContains(this.box, x, y)) {
      this.setHovered(null)
      return false
    }
    const e = this.entries.find((en) => en.target && rectContains(en.rect, x, y)) ?? null
    if (type === 'move') {
      this.setHovered(e)
      return !!e
    }
    if (type === 'click' && e && this.opts.toggleVisibilityOnClick) {
      e.target!.setVisible(!e.target!.getVisible())
      this.host.requestRender()
      return true
    }
    return !!e || type === 'down'
  }

  contains(x: number, y: number) { return this.opts.visible && rectContains(this.box, x, y) }
  hoveringEntry() { return !!this.hovered }
}

export function fillLUTGradient(g: CanvasGradient, lut: LUT) {
  const span = lut.max - lut.min || 1
  const s = lut.steps
  if (lut.interpolate) {
    for (const st of s) g.addColorStop((st.value - lut.min) / span, st.color.toCSS())
  } else {
    for (let i = 0; i < s.length; i++) {
      const a = (s[i].value - lut.min) / span
      const b = i + 1 < s.length ? (s[i + 1].value - lut.min) / span : 1
      g.addColorStop(Math.max(0, a), s[i].color.toCSS())
      g.addColorStop(Math.min(1, Math.max(0, b - 1e-6)), s[i].color.toCSS())
    }
  }
}

/** Glossy legend/cursor marker. */
export function drawMarker(ctx: CanvasRenderingContext2D, shape: ShapeName, cx: number, cy: number, r: number, color: Color, glossy = true) {
  ctx.save()
  ctx.beginPath()
  switch (shape) {
    case 'square':
      roundRect(ctx, cx - r, cy - r, r * 2, r * 2, 2)
      break
    case 'triangle':
      ctx.moveTo(cx, cy - r * 1.1)
      ctx.lineTo(cx + r, cy + r * 0.8)
      ctx.lineTo(cx - r, cy + r * 0.8)
      ctx.closePath()
      break
    case 'diamond':
      ctx.moveTo(cx, cy - r * 1.2)
      ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r * 1.2)
      ctx.lineTo(cx - r, cy)
      ctx.closePath()
      break
    case 'cross':
    case 'x': {
      const w = r * 0.35
      ctx.rect(cx - r, cy - w, r * 2, w * 2)
      ctx.rect(cx - w, cy - r, w * 2, r * 2)
      break
    }
    case 'star': {
      for (let i = 0; i < 10; i++) {
        const a = (i * Math.PI) / 5 - Math.PI / 2
        const rr = i % 2 ? r * 0.45 : r * 1.15
        ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr)
      }
      ctx.closePath()
      break
    }
    default:
      ctx.arc(cx, cy, r, 0, Math.PI * 2)
  }
  if (glossy) {
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, 0, cx, cy, r * 1.2)
    g.addColorStop(0, color.mix(new Color(255, 255, 255, color.a), 0.55).toCSS())
    g.addColorStop(0.6, color.toCSS())
    g.addColorStop(1, color.scale(0.6).toCSS())
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = color.toCSS()
  }
  ctx.fill()
  ctx.restore()
}
