import { Color } from '../core/color'
import { drawMarker, Legend, LegendOptions, LegendSymbol, LegendTarget, ShapeName } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, emptyFill, Fill, fillToCanvas, isEmptyLine, LineStyle, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { font, seriesColor } from '../core/theme'
import { decimalsForStep, Emitter, formatNumber, Rect, textWidth } from '../core/util'
import { GLRenderer, getRenderer } from '../render/GLRenderer'
import { PointShapeName } from '../render/draw'
import type { PointerInfo, Surface } from '../render/Surface'
import { approach, DEG, drawResultTable, TableRows, textHalo } from './common'
import { fillColorAt, PxPoints, PxSegments, PxTriangles, WHITE, WHITE_COLOR } from './gl'

export interface SpiderChartOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

export const SpiderWebMode = { Normal: 'normal', Circle: 'circle' } as const
export type SpiderWebMode = (typeof SpiderWebMode)[keyof typeof SpiderWebMode]

export interface SpiderPoint { axis: string; value: number }

/** Formats the scale labels along the first axis. */
export type SpiderScaleFormatter = (value: number) => string

/** One polygon of values over the chart's category axes. */
export class SpiderSeries extends Emitter implements LegendTarget {
  /** Target and displayed (animated) value per axis tag. */
  readonly values = new Map<string, { value: number; shown: number }>()
  private name: string
  private visible = true
  private fill: Fill
  private stroke: LineStyle
  private pointFill: Fill
  private pointSize: number
  private pointShape: PointShapeName
  private effect: boolean | null = null
  cursorEnabled = true
  private disposed = false
  /** Fade in/out for visibility toggles (0..1). */
  alpha = 1
  /** @internal */ segs = new PxSegments()
  /** @internal */ pts = new PxPoints()
  /** @internal */ tris = new PxTriangles()
  /** @internal screen positions per axis index */ sx: number[] = []
  /** @internal */ sy: number[] = []

  constructor(private chart: SpiderChart, readonly colorIndex: number, shape: string = 'circle') {
    super()
    const t = chart.getTheme()
    const c = seriesColor(t, colorIndex)
    this.name = `Series ${colorIndex + 1}`
    this.fill = new SolidFill({ color: c.setA(t.isDark ? 42 : 46) })
    this.stroke = new SolidLine({ thickness: t.lineThickness, fillStyle: new SolidFill({ color: c }) })
    this.pointFill = new SolidFill({ color: c })
    this.pointSize = t.pointSize + 1
    this.pointShape = String(shape).toLowerCase() as PointShapeName
  }

  setName(n: string) { this.name = n; this.chart.requestRender(); return this }
  getName() { return this.name }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.chart.onSeriesChange()
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  /**
   * Set values; points on existing axes animate to their new value and new
   * axis tags are added to the chart.
   */
  addPoints(...points: (SpiderPoint | SpiderPoint[])[]) {
    for (const p of points.flat()) {
      this.chart.addAxis(p.axis)
      const cur = this.values.get(p.axis)
      if (cur) cur.value = +p.value
      else this.values.set(p.axis, { value: +p.value, shown: this.chart.isAnimated() ? this.chart.getInterval().start : +p.value })
    }
    this.chart.onSeriesChange()
    return this
  }
  /** Replace all points. */
  setPoints(points: SpiderPoint[]) {
    const keep = new Set(points.map((p) => p.axis))
    for (const k of [...this.values.keys()]) if (!keep.has(k)) this.values.delete(k)
    return this.addPoints(points)
  }
  getPoints(): SpiderPoint[] { return [...this.values].map(([axis, v]) => ({ axis, value: v.value })) }
  clear() { this.values.clear(); this.chart.onSeriesChange(); return this }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.onSeriesChange(); return this }
  getFillStyle() { return this.fill }
  setStrokeStyle(s: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, s); this.chart.onSeriesChange(); return this }
  getStrokeStyle() { return this.stroke }
  setPointFillStyle(f: Mutator<Fill>) { this.pointFill = resolve(this.pointFill, f); this.chart.onSeriesChange(); return this }
  setPointSize(s: number) { this.pointSize = s; this.chart.onSeriesChange(); return this }
  getPointSize() { return this.pointSize }
  setPointShape(s: string) { this.pointShape = String(s).toLowerCase() as PointShapeName; this.chart.onSeriesChange(); return this }
  setEffect(v: boolean) { this.effect = v; this.chart.requestRender(); return this }
  getEffect() { return this.effect ?? this.chart.getTheme().glow.enabled }
  setCursorEnabled(v: boolean) { this.cursorEnabled = v; return this }
  setHighlightOnHover(_v: boolean) { return this }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.chart.removeSeries(this)
    return this
  }
  isDisposed() { return this.disposed }

  primaryColor(): Color {
    if (!isEmptyLine(this.stroke)) return this.stroke.getFillStyle().getPrimaryColor()
    if (this.pointFill.type !== 'empty') return this.pointFill.getPrimaryColor()
    return this.fill.getPrimaryColor()
  }
  getLegendSymbol(): LegendSymbol {
    return { kind: 'point', color: this.primaryColor().setA(255), shape: this.pointShape as ShapeName }
  }

  /** @internal Rebuild GPU geometry for the given axis layout. */
  build(axes: string[], cx: number, cy: number, R: number, start: number, end: number, dpr: number) {
    this.segs.clear()
    this.pts.clear()
    this.tris.clear()
    const n = axes.length
    const sx: number[] = [], sy: number[] = []
    const span = end - start || 1
    for (let i = 0; i < n; i++) {
      const v = this.values.get(axes[i])
      const rn = v ? Math.min(1.08, Math.max(0, (v.shown - start) / span)) : 0
      const a = (-90 + (i * 360) / n) * DEG
      sx.push(cx + Math.cos(a) * rn * R)
      sy.push(cy + Math.sin(a) * rn * R)
    }
    this.sx = sx
    this.sy = sy
    if (n < 2 || this.alpha <= 0) return
    const fade = (c: Color) => (this.alpha >= 1 ? c : c.setA(c.a * this.alpha))
    const box: Rect = { x: cx - R, y: cy - R, w: 2 * R, h: 2 * R }
    if (this.fill.type !== 'empty' && n >= 3) {
      const cc = fade(fillColorAt(this.fill, cx, cy, box, start)).toUint32()
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n
        this.tris.push(cx, cy, cc)
        this.tris.push(sx[i], sy[i], fade(fillColorAt(this.fill, sx[i], sy[i], box, this.values.get(axes[i])?.shown ?? start)).toUint32())
        this.tris.push(sx[j], sy[j], fade(fillColorAt(this.fill, sx[j], sy[j], box, this.values.get(axes[j])?.shown ?? start)).toUint32())
      }
    }
    if (!isEmptyLine(this.stroke)) {
      let cum = 0
      const m = n > 2 ? n : n - 1
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % n
        const len = Math.hypot(sx[j] - sx[i], sy[j] - sy[i])
        this.segs.push(sx[i], sy[i], sx[j], sy[j], WHITE, WHITE, cum * dpr)
        cum += len
      }
    }
    if (this.pointFill.type !== 'empty' && this.pointSize > 0) {
      for (let i = 0; i < n; i++) if (this.values.has(axes[i])) this.pts.push(sx[i], sy[i])
    }
  }

  /** @internal */
  drawGL(r: GLRenderer) {
    if (this.alpha <= 0) return
    r.glow = 0
    this.tris.draw(r, WHITE_COLOR)
    r.glow = this.getEffect() ? 1 : 0
    if (!isEmptyLine(this.stroke)) {
      const c = this.stroke.getFillStyle().getPrimaryColor()
      this.segs.draw(r, c.setA(c.a * this.alpha), this.stroke.getThickness(), null)
    }
    if (this.pointFill.type !== 'empty') {
      const c = this.pointFill.getPrimaryColor()
      const bg = this.chart.getTheme().isDark ? new Color(10, 10, 10, 255 * this.alpha) : new Color(255, 255, 255, 255 * this.alpha)
      this.pts.draw(r, { size: this.pointSize, shape: this.pointShape, color: c.setA(c.a * this.alpha), strokeWidth: 1.5, strokeColor: bg })
    }
    r.glow = 0
  }

  /** @internal */
  disposeGL(r: GLRenderer | null) {
    this.segs.dispose(r)
    this.pts.dispose(r)
    this.tris.dispose(r)
  }
}

/**
 * Spider (radar) chart: one category axis per tag, series drawn as filled
 * polygons on the GPU with glow. Value changes animate.
 */
export class SpiderChart extends Panel {
  readonly legend: Legend
  private readonly series: SpiderSeries[] = []
  private axes: string[] = []
  private fixedInterval: { start: number; end: number } | null = null
  private interval = { start: 0, end: 1 }
  private webMode: SpiderWebMode = SpiderWebMode.Normal
  private webCount = 5
  private webStroke: LineStyle | null = null
  private axisStroke: LineStyle | null = null
  private webFill: Fill | null = null
  private scaleFormatter: SpiderScaleFormatter | null = null
  private axisLabelColor: Color | null = null
  private axisLabelSize: number | null = null
  private scaleLabelsVisible = true
  private animations = true
  private colorCounter = 0
  private cx = 0
  private cy = 0
  private R = 1
  private key = ''
  private version = 0
  private lastTick = 0
  private pointer: { x: number; y: number } | null = null
  private hit: { series: SpiderSeries; axis: string; value: number; x: number; y: number } | null = null
  private cursorEnabled = true

  constructor(o: SpiderChartOptions = {}) {
    super(o)
    this.legend = new Legend(this, o.legend)
  }

  // ---------------------------------------------------------------- API

  /** Add a category axis (no-op if it exists). */
  addAxis(tag: string) {
    if (!this.axes.includes(tag)) {
      this.axes.push(tag)
      this.onSeriesChange()
    }
    return this
  }
  getAxes() { return [...this.axes] }
  removeAxis(tag: string) {
    this.axes = this.axes.filter((a) => a !== tag)
    for (const s of this.series) s.values.delete(tag)
    this.onSeriesChange()
    return this
  }
  addSeries(shape?: string) {
    const s = new SpiderSeries(this, this.colorCounter++, shape)
    this.series.push(s)
    if (this.legend.autoAdd) this.legend.add(s)
    this.onSeriesChange()
    return s
  }
  getSeries() { return [...this.series] }
  removeSeries(s: SpiderSeries) {
    const i = this.series.indexOf(s)
    if (i < 0) return
    this.series.splice(i, 1)
    this.legend.remove(s)
    let r: GLRenderer | null = null
    try { r = getRenderer() } catch { r = null }
    s.disposeGL(r)
    this.onSeriesChange()
  }
  /** Scale maximum (number) or full interval; `undefined` returns to automatic fitting. */
  setAxisInterval(i: number | { start: number; end: number } | undefined) {
    this.fixedInterval = i === undefined ? null : typeof i === 'number' ? { start: 0, end: i } : { ...i }
    this.onSeriesChange()
    return this
  }
  getInterval() { return { ...this.interval } }
  setAxisScrollStrategy(_s: unknown) { return this }
  setWebMode(m: SpiderWebMode) { this.webMode = m; this.requestRender(); return this }
  getWebMode() { return this.webMode }
  setWebCount(n: number) { this.webCount = Math.max(1, Math.round(n)); this.requestRender(); return this }
  getWebCount() { return this.webCount }
  setWebStyle(l: Mutator<LineStyle>) { this.webStroke = resolve<LineStyle>(this.webStroke ?? this.defaultWeb(), l); this.requestRender(); return this }
  setWebFillStyle(f: Mutator<Fill>) { this.webFill = resolve<Fill>(this.webFill ?? emptyFill, f); this.requestRender(); return this }
  setAxisStyle(l: Mutator<LineStyle>) { this.axisStroke = resolve<LineStyle>(this.axisStroke ?? this.defaultAxis(), l); this.requestRender(); return this }
  setNibStyle(_l: unknown) { return this }
  setNibLength(_n: number) { return this }
  /** Formatter for the scale labels (a function, or an object with `formatValue`). */
  setScaleLabelStrategy(f: SpiderScaleFormatter | { formatValue(v: number, r?: unknown): string } | undefined) {
    this.scaleFormatter = !f ? null : typeof f === 'function' ? f : (v: number) => f.formatValue(v, this.interval)
    this.requestRender()
    return this
  }
  setScaleLabelsVisible(v: boolean) { this.scaleLabelsVisible = v; this.requestRender(); return this }
  setScaleLabelFont(_f: unknown) { return this }
  setAxisLabelFont(f: { size?: number } | ((f: any) => any)) {
    const r = typeof f === 'function' ? f({ size: this.theme.fontSize, setSize: (size: number) => ({ size }) }) : f
    if (r && typeof r.size === 'number') this.axisLabelSize = r.size
    this.requestRender()
    return this
  }
  setAxisLabelFillStyle(f: Mutator<Fill>) {
    this.axisLabelColor = resolve<Fill>(new SolidFill({ color: this.axisLabelColor ?? this.theme.axisTitleColor }), f).getPrimaryColor()
    this.requestRender()
    return this
  }
  setAxisLabelEffect(_v: boolean) { return this }
  setAxisLabelStrategy(_s: unknown) { return this }
  setAnimationsEnabled(v: boolean) { this.animations = v; return this }
  isAnimated() { return this.animations }
  setCursorMode(m: string | undefined) { this.cursorEnabled = m !== 'disabled' && m !== undefined; this.requestRender(); return this }
  setAutoCursorMode(m: string) { return this.setCursorMode(m) }
  setSeriesBackgroundFillStyle(f: Mutator<Fill>) { return this.setWebFillStyle(f) }

  /** @internal */
  onSeriesChange() { this.version++; this.requestRender() }

  private defaultWeb() { return new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.axisLineColor.setA(this.theme.isDark ? 70 : 90) }) }) }
  private defaultAxis() { return new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.axisLineColor.setA(this.theme.isDark ? 120 : 140) }) }) }

  private targetInterval(): { start: number; end: number } {
    if (this.fixedInterval) return this.fixedInterval
    let max = -Infinity
    for (const s of this.series) {
      if (!s.getVisible()) continue
      for (const v of s.values.values()) if (v.value > max) max = v.value
    }
    if (!(max > 0)) return { start: 0, end: 1 }
    // One web per nice step (1, 2, 2.5, 5 x 10^k) so every scale label is round.
    const raw = max / this.webCount
    const p = Math.pow(10, Math.floor(Math.log10(raw)))
    const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= raw * (1 - 1e-9)) ?? 10 * p
    return { start: 0, end: step * this.webCount }
  }

  // ---------------------------------------------------------------- animation

  override tick(now: number): boolean {
    const a = super.tick(now)
    const dt = Math.min(64, Math.max(0, now - (this.lastTick || now)))
    this.lastTick = now
    const k = this.animations ? 1 - Math.exp(-dt / 120) : 1
    let busy = false
    const tgt = this.targetInterval()
    const span = Math.abs(tgt.end - tgt.start) || 1
    const ni = {
      start: approach(this.interval.start, tgt.start, k, span * 1e-4),
      end: approach(this.interval.end, tgt.end, k, span * 1e-4),
    }
    if (ni.start !== this.interval.start || ni.end !== this.interval.end) {
      this.interval = ni
      this.version++
    }
    if (ni.start !== tgt.start || ni.end !== tgt.end) busy = true
    for (const s of this.series) {
      for (const v of s.values.values()) {
        const nv = approach(v.shown, v.value, k, span * 1e-4)
        if (nv !== v.shown) {
          v.shown = nv
          this.version++
        }
        if (nv !== v.value) busy = true
      }
      const ta = s.getVisible() ? 1 : 0
      const na = approach(s.alpha, ta, k, 0.01)
      if (na !== s.alpha) {
        s.alpha = na
        this.version++
      }
      if (na !== ta) busy = true
    }
    if (!busy) this.lastTick = 0
    return a || busy
  }

  // ---------------------------------------------------------------- layout

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    const t = this.theme
    const fs = this.axisLabelSize ?? t.fontSize
    const fnt = font(t, fs)
    const maxW = Math.max(0, ...this.axes.map((a) => textWidth(a, fnt)))
    const mx = Math.min(area.w * 0.3, maxW + 16)
    const my = fs * 1.5 + 10
    this.R = Math.max(10, Math.min(area.w - 2 * mx, area.h - 2 * my) / 2)
    this.cx = area.x + area.w / 2
    this.cy = area.y + area.h / 2
    const dpr = this.surface.dpr || 1
    const key = `${this.cx}|${this.cy}|${this.R}|${dpr}|${this.version}`
    if (key !== this.key) {
      this.key = key
      for (const s of this.series) s.build(this.axes, this.cx, this.cy, this.R, this.interval.start, this.interval.end, dpr)
    }
    this.updateCursor()
  }

  private axisAngle(i: number) { return (-90 + (i * 360) / Math.max(1, this.axes.length)) * DEG }

  private updateCursor() {
    this.hit = null
    const p = this.pointer
    if (!p || !this.cursorEnabled || Math.hypot(p.x - this.cx, p.y - this.cy) > this.R * 1.15) return
    let bd = Infinity
    for (const s of this.series) {
      if (!s.getVisible() || !s.cursorEnabled) continue
      this.axes.forEach((tag, i) => {
        const v = s.values.get(tag)
        if (!v) return
        const d = (s.sx[i] - p.x) ** 2 + (s.sy[i] - p.y) ** 2
        if (d < bd) {
          bd = d
          this.hit = { series: s, axis: tag, value: v.value, x: s.sx[i], y: s.sy[i] }
        }
      })
    }
    if (bd > 40 * 40) this.hit = null
  }

  // ---------------------------------------------------------------- drawing

  private webPath(ctx: CanvasRenderingContext2D, r: number) {
    const n = this.axes.length
    if (this.webMode === SpiderWebMode.Circle || n < 3) {
      ctx.moveTo(this.cx + r, this.cy)
      ctx.arc(this.cx, this.cy, r, 0, Math.PI * 2)
      return
    }
    for (let i = 0; i < n; i++) {
      const a = this.axisAngle(i)
      const x = this.cx + Math.cos(a) * r, y = this.cy + Math.sin(a) * r
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.closePath()
  }

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const t = this.theme
    const { cx, cy, R } = this
    const n = this.webCount
    ctx.save()
    // Alternating web bands for depth.
    const bg = this.webFill ?? null
    if (bg && bg.type !== 'empty') {
      ctx.beginPath()
      this.webPath(ctx, R)
      const paint = fillToCanvas(ctx, bg, cx - R, cy - R, 2 * R, 2 * R)
      if (paint) { ctx.fillStyle = paint; ctx.fill() }
    } else {
      for (let k = n; k >= 1; k--) {
        ctx.beginPath()
        this.webPath(ctx, (R * k) / n)
        ctx.fillStyle = t.isDark
          ? k % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.25)'
          : k % 2 ? 'rgba(0,0,0,0.035)' : 'rgba(255,255,255,1)'
        ctx.fill()
      }
    }
    // Web lines.
    if (applyLineToCanvas(ctx, this.webStroke ?? this.defaultWeb())) {
      ctx.beginPath()
      for (let k = 1; k <= n; k++) this.webPath(ctx, (R * k) / n)
      ctx.stroke()
    }
    // Axis lines.
    if (applyLineToCanvas(ctx, this.axisStroke ?? this.defaultAxis())) {
      ctx.beginPath()
      this.axes.forEach((_, i) => {
        const a = this.axisAngle(i)
        ctx.moveTo(cx, cy)
        ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R)
      })
      ctx.stroke()
    }
    ctx.restore()
  }

  override hasGL() { return this.series.length > 0 }
  override wantsMSAA() { return this.series.some((s) => s.getFillStyle().type !== 'empty' && s.alpha > 0) }

  override drawGL(r: GLRenderer) {
    r.scissor(this.rect)
    for (const s of this.series) s.drawGL(r)
    r.scissor(null)
    r.glow = 0
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const { cx, cy, R } = this
    const fs = t.fontSize
    // Axis labels.
    const lfs = this.axisLabelSize ?? fs
    ctx.font = font(t, lfs, 600)
    ctx.fillStyle = (this.axisLabelColor ?? t.axisTitleColor).toCSS()
    this.axes.forEach((tag, i) => {
      const a = this.axisAngle(i)
      const c = Math.cos(a), s = Math.sin(a)
      const rr = R + 10
      ctx.textAlign = c > 0.25 ? 'left' : c < -0.25 ? 'right' : 'center'
      ctx.textBaseline = s > 0.25 ? 'top' : s < -0.25 ? 'bottom' : 'middle'
      ctx.fillText(tag, cx + c * rr, cy + s * rr)
    })
    // Scale labels along the first axis.
    if (this.scaleLabelsVisible && this.axes.length) {
      const { start, end } = this.interval
      const step = (end - start) / this.webCount
      const fmt = this.scaleFormatter ?? ((v: number) => formatNumber(v, decimalsForStep(Math.abs(step))))
      ctx.save()
      ctx.font = font(t, fs * 0.85)
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      textHalo(ctx, t, true)
      const a = this.axisAngle(0)
      for (let k = 1; k <= this.webCount; k++) {
        const r = (R * k) / this.webCount
        ctx.fillText(fmt(start + step * k), cx + Math.cos(a) * r + 5, cy + Math.sin(a) * r + 3)
      }
      ctx.restore()
    }
    // Cursor.
    const h = this.hit
    if (h) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(h.x, h.y, 7, 0, Math.PI * 2)
      ctx.strokeStyle = t.isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      drawMarker(ctx, 'circle', h.x, h.y, 3.5, h.series.primaryColor().setA(255), false)
      const rows: TableRows = [[{ text: h.series.getName(), color: h.series.primaryColor().setA(255) }], [h.axis + ':', formatNumber(h.value, decimalsForStep(Math.abs(this.interval.end - this.interval.start) / 1000))]]
      drawResultTable(ctx, t, rows, h.x, h.y, this.rect)
      ctx.restore()
    }
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  // ---------------------------------------------------------------- interaction

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') return this.legend.onPointer('click', x, y)
    if (e.type === 'move' && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      return true
    }
    if (e.type === 'down' && this.legend.contains(x, y)) return true
    if (e.type === 'move') {
      this.pointer = { x, y }
      this.surface.setCursor('default')
      return true
    }
    if (e.type === 'leave') {
      this.pointer = null
      return true
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) {
    for (const s of this.series) s.disposeGL(r)
  }
  override dispose() {
    this.series.forEach((s) => this.legend.remove(s))
    super.dispose()
  }
}
