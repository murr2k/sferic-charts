import { Legend, LegendOptions, drawMarker } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, Fill, fillToCanvas, isEmptyLine, LineStyle, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { font } from '../core/theme'
import { Easings, Emitter, Rect, textWidth, Tween } from '../core/util'
import { GLRenderer, getRenderer } from '../render/GLRenderer'
import type { PointerInfo, Surface } from '../render/Surface'
import { cloneStrategy } from '../xy/Axis'
import { niceStep, NumericTickStrategy, Tick, TickFormatter, TickStrategy } from '../xy/ticks'
import { DEG, drawPill, drawResultTable, TableRows, textHalo } from './common'
import {
  PolarAreaSeries, PolarGeom, PolarHeatmapOptions, PolarHeatmapSeries, PolarHit, PolarLineSeries, PolarPointLineSeries,
  PolarPointSeries, PolarPolygonSeries, PolarSeries, PolarSeriesOptions, PolarTableBuilder, polarToPx, pxToPolar,
} from './PolarSeries'

export interface PolarChartOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

/** Angular axis around the rim. */
export class PolarAxisRadial {
  north = 90
  clockwise = false
  division = 12
  formatter: (angle: number) => string = (a) => `${Math.round(a * 100) / 100}°`
  stroke: LineStyle
  gridStroke: LineStyle | null = null
  labelsVisible = true
  constructor(private chart: PolarChart) {
    this.stroke = new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: chart.getTheme().axisLineColor }) })
  }
  /** Data angle (degrees) displayed at the top. */
  setNorth(deg: number) { this.north = deg; this.chart.requestRender(); return this }
  getNorth() { return this.north }
  setClockwise(v: boolean) { this.clockwise = v; this.chart.requestRender(); return this }
  getClockwise() { return this.clockwise }
  /** Number of radial spokes / angle labels. */
  setDivision(n: number) { this.division = Math.max(1, Math.round(n)); this.chart.requestRender(); return this }
  getDivision() { return this.division }
  setTickFormattingFunction(f: (angle: number) => string) { this.formatter = f; this.chart.requestRender(); return this }
  setTickLabelsVisible(v: boolean) { this.labelsVisible = v; this.chart.requestRender(); return this }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.chart.requestRender(); return this }
  setGridStrokeStyle(l: Mutator<LineStyle>) {
    this.gridStroke = resolve<LineStyle>(this.gridStroke ?? gridLine(this.chart), l)
    this.chart.requestRender()
    return this
  }
  setTickStyle(_f: unknown) { return this }
  setTitle(_t: string) { return this }
  setAnimationsEnabled(_v: boolean) { return this }
}

const gridLine = (c: PolarChart) => new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: c.getTheme().gridMajorColor }) })

export interface PolarIntervalArgs { start: number; end: number; stopAxisAfter?: boolean; animate?: boolean | number }

/** Radial value axis (center = start, rim = end). */
export class PolarAxisAmplitude extends Emitter {
  start = 0
  end = 1
  stopped = false
  private initialized = false
  private tween: Tween | null = null
  title = ''
  units = ''
  strategy: TickStrategy = new NumericTickStrategy()
  labelsVisible = true
  gridStroke: LineStyle | null = null
  animationsEnabled = true
  constructor(private chart: PolarChart) { super() }

  setInterval(a: PolarIntervalArgs | number, end?: number, animate?: boolean | number) {
    const args: PolarIntervalArgs = typeof a === 'number' ? { start: a, end: end!, animate } : a
    if (!(Number.isFinite(args.start) && Number.isFinite(args.end))) return this
    this.initialized = true
    this.stopped = args.stopAxisAfter ?? true
    this.apply(args.start, args.end, args.animate)
    return this
  }
  getInterval() { return { start: this.start, end: this.end } }
  setTitle(t: string) { this.title = t; this.chart.requestRender(); return this }
  getTitle() { return this.title }
  setUnits(u: string) { this.units = u; this.chart.requestRender(); return this }
  setTickStrategy<T extends TickStrategy>(s: T, styler?: (s: T) => T) {
    let st = cloneStrategy(s)
    if (styler) st = styler(st)
    this.strategy = st
    this.chart.requestRender()
    return this
  }
  setTickFormattingFunction(f: TickFormatter | undefined) { this.strategy = this.strategy.setFormattingFunction(f); this.chart.requestRender(); return this }
  setTickLabelsVisible(v: boolean) { this.labelsVisible = v; this.chart.requestRender(); return this }
  setGridStrokeStyle(l: Mutator<LineStyle>) {
    this.gridStroke = resolve<LineStyle>(this.gridStroke ?? gridLine(this.chart), l)
    this.chart.requestRender()
    return this
  }
  setStrokeStyle(_l: unknown) { return this }
  setAnimationsEnabled(v: boolean) { this.animationsEnabled = v; return this }
  /** `undefined` disables automatic fitting; anything else re-enables it. */
  setScrollStrategy(s: unknown) { this.stopped = s === undefined; this.chart.requestRender(); return this }
  onIntervalChange(fn: (axis: PolarAxisAmplitude, start: number, end: number) => void) {
    const l = (ev: { start: number; end: number }) => fn(this, ev.start, ev.end)
    this.addEventListener('intervalchange', l)
    return () => this.removeEventListener('intervalchange', l)
  }
  /** Fit to data; resumes automatic fitting unless stopAxisAfter. */
  fit(animate: boolean | number = true, stopAxisAfter = false) {
    const b = this.chart.amplitudeBounds()
    this.stopped = false
    if (b) {
      const [s, e] = niceRange(b.min, b.max)
      this.apply(s, e, animate)
    }
    this.stopped = stopAxisAfter
    return this
  }
  formatValue(v: number) { return this.strategy.formatValue(v, this.getInterval()) }
  formatCursor(v: number) { return this.strategy.formatCursor(v, this.getInterval()) }

  /** @internal Automatic fitting against data bounds. */
  update(b: { min: number; max: number } | null) {
    if (this.stopped || !b || (this.tween && !this.tween.done)) return
    const [s, e] = niceRange(b.min, b.max)
    if (!this.initialized) {
      this.initialized = true
      this.apply(s, e)
    } else if (s !== this.start || e !== this.end) {
      this.apply(s, e)
    }
  }
  /** @internal Wheel zoom: scale the span, keeping the center value. */
  zoom(f: number) {
    this.stopped = true
    this.tween?.cancel()
    const e = this.start + (this.end - this.start) * f
    if (Number.isFinite(e) && e !== this.start) this.set(this.start, e)
  }
  private apply(s: number, e: number, animate?: boolean | number) {
    if (s === e) e = s + 1
    const dur = animate === true ? 500 : typeof animate === 'number' ? animate : 0
    this.tween?.cancel()
    this.tween = null
    if (dur > 0 && this.animationsEnabled) {
      this.tween = new Tween([this.start, this.end], [s, e], dur, (v) => this.set(v[0], v[1]), Easings.easeInOut)
      this.chart.addTween(this.tween)
    } else this.set(s, e)
  }
  private set(s: number, e: number) {
    if (s === this.start && e === this.end) return
    this.start = s
    this.end = e
    this.chart.requestRender()
    this.emit('intervalchange', { start: s, end: e })
  }
}

/** Interval from 0 (or the negative minimum) to a nice maximum. */
function niceRange(min: number, max: number): [number, number] {
  let lo = Math.min(0, min), hi = max
  if (!(hi > lo)) hi = lo + 1
  const step = niceStep((hi - lo) / 5)
  lo = Math.floor(lo / step + 1e-9) * step
  hi = Math.ceil(hi / step - 1e-9) * step
  return [lo, hi]
}

/**
 * Polar chart: data in (angle, amplitude), rendered on the GPU into a disc with
 * concentric amplitude circles and radial spokes. Wheel zooms the amplitude
 * axis, double-click fits it back to the data.
 */
export class PolarChart extends Panel {
  readonly legend: Legend
  private readonly series: PolarSeries[] = []
  private readonly radial: PolarAxisRadial
  private readonly amplitude: PolarAxisAmplitude
  private geom: PolarGeom = { cx: 0, cy: 0, R: 1, start: 0, end: 1, north: 90, dir: 1, dpr: 1 }
  private ampTicks: Tick[] = []
  private pointer: { x: number; y: number } | null = null
  private hit: PolarHit | null = null
  private cursorMode: 'show-nearest' | 'disabled' = 'show-nearest'
  private colorCounter = 0
  private seriesBgFill: Fill
  private interactions = true

  constructor(o: PolarChartOptions = {}) {
    super(o)
    this.legend = new Legend(this, o.legend)
    this.radial = new PolarAxisRadial(this)
    this.amplitude = new PolarAxisAmplitude(this)
    this.seriesBgFill = this.theme.seriesBackgroundFill
  }

  getRadialAxis() { return this.radial }
  getAmplitudeAxis() { return this.amplitude }

  // ---------------------------------------------------------------- series

  private attach<T extends PolarSeries>(s: T): T {
    this.series.push(s)
    if (this.legend.autoAdd) {
      if (s instanceof PolarHeatmapSeries) this.legend.add(s.getLUT(), { name: s.getName() })
      else this.legend.add(s)
    }
    this.requestRender()
    return s
  }
  private color(o: { automaticColorIndex?: number }) { return o.automaticColorIndex ?? this.colorCounter++ }
  addLineSeries(o: PolarSeriesOptions = {}) { return this.attach(new PolarLineSeries(this, this.color(o), o)) }
  addPointSeries(o: PolarSeriesOptions = {}) { return this.attach(new PolarPointSeries(this, this.color(o), o)) }
  addPointLineSeries(o: PolarSeriesOptions = {}) { return this.attach(new PolarPointLineSeries(this, this.color(o), o)) }
  addAreaSeries(o: PolarSeriesOptions = {}) { return this.attach(new PolarAreaSeries(this, this.color(o), o)) }
  addPolygonSeries(o: PolarSeriesOptions = {}) { return this.attach(new PolarPolygonSeries(this, this.color(o), o)) }
  addHeatmapSeries(o: PolarHeatmapOptions) { return this.attach(new PolarHeatmapSeries(this, this.color(o), o)) }
  getSeries() { return [...this.series] }
  removeSeries(s: PolarSeries) {
    const i = this.series.indexOf(s)
    if (i < 0) return
    this.series.splice(i, 1)
    if (s instanceof PolarHeatmapSeries) this.legend.remove(s.getLUT())
    else this.legend.remove(s)
    let r: GLRenderer | null = null
    try { r = getRenderer() } catch { r = null }
    s.disposeGL(r)
    if (this.hit?.series === s) this.hit = null
    this.requestRender()
  }

  // ---------------------------------------------------------------- configuration

  setSeriesBackgroundFillStyle(f: Mutator<Fill>) { this.seriesBgFill = resolve(this.seriesBgFill, f); this.requestRender(); return this }
  getSeriesBackgroundFillStyle() { return this.seriesBgFill }
  setSeriesBackgroundStrokeStyle(l: Mutator<LineStyle>) { this.radial.setStrokeStyle(l); return this }
  setCursorMode(m: string | undefined) { this.cursorMode = m === 'disabled' || m === undefined ? 'disabled' : 'show-nearest'; this.requestRender(); return this }
  getCursorMode() { return this.cursorMode }
  setAutoCursorMode(m: string) { return this.setCursorMode(m) }
  setCursor(f: (c: { setEnabled(v: boolean): unknown }) => unknown) {
    f({ setEnabled: (v: boolean) => this.setCursorMode(v ? 'show-nearest' : 'disabled') })
    return this
  }
  setMouseInteractions(v: boolean) { this.interactions = v; return this }
  setUserInteractions(v: boolean | Record<string, unknown> | undefined) { this.interactions = v !== false && v !== undefined; return this }
  setAnimationsEnabled(v: boolean) { this.amplitude.setAnimationsEnabled(v); return this }
  /** Convert client coordinates to (angle, amplitude). */
  translateCoordinate(p: { clientX: number; clientY: number }) {
    const b = this.surface.canvas.getBoundingClientRect()
    const q = pxToPolar(this.geom, p.clientX - b.left, p.clientY - b.top)
    return { angle: q.angle, amplitude: q.amplitude }
  }

  /** @internal */
  addTween(t: Tween) { this.animate(t) }
  /** @internal */
  amplitudeBounds(): { min: number; max: number } | null {
    let min = Infinity, max = -Infinity
    for (const s of this.series) {
      if (!s.getVisible()) continue
      const b = s.amplitudeBounds()
      if (!b) continue
      min = Math.min(min, b.min)
      max = Math.max(max, b.max)
    }
    return min <= max ? { min, max } : null
  }

  // ---------------------------------------------------------------- layout

  private angleLabels(): { angle: number; text: string }[] {
    const n = this.radial.division
    const out: { angle: number; text: string }[] = []
    for (let k = 0; k < n; k++) {
      const a = (k * 360) / n
      out.push({ angle: a, text: this.radial.formatter(a) })
    }
    return out
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    this.amplitude.update(this.amplitudeBounds())
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs)
    let mx = 8, my = 8
    if (this.radial.labelsVisible) {
      const maxW = Math.max(0, ...this.angleLabels().map((l) => textWidth(l.text, fnt)))
      mx = maxW + 14
      my = fs + 12
    }
    const R = Math.max(10, Math.min(area.w - 2 * mx, area.h - 2 * my) / 2)
    const a = this.amplitude
    this.geom = {
      cx: area.x + area.w / 2,
      cy: area.y + area.h / 2,
      R,
      start: a.start,
      end: a.end,
      north: this.radial.north,
      dir: this.radial.clockwise ? -1 : 1,
      dpr: this.surface.dpr || 1,
    }
    this.ampTicks = a.strategy
      .generate({
        lo: Math.min(a.start, a.end),
        hi: Math.max(a.start, a.end),
        length: R,
        horizontal: false,
        log: 0,
        measure: (s, level) => textWidth(s, font(t, level === 0 ? fs : fs * 0.85)),
        fontSize: fs,
      })
      .filter((tk) => tk.level === 0)
    for (const s of this.series) if (s.getVisible()) s.prepare(this.geom)
    this.updateCursor()
  }

  private updateCursor() {
    this.hit = null
    const p = this.pointer
    if (!p || this.cursorMode === 'disabled') return
    const g = this.geom
    if (Math.hypot(p.x - g.cx, p.y - g.cy) > g.R + 12) return
    let best: PolarHit | null = null
    for (const s of this.series) {
      if (!s.getVisible() || !s.cursorEnabled) continue
      const h = s.nearest(p.x, p.y, g)
      if (h && (!best || h.dist2 < best.dist2)) best = h
    }
    this.hit = best
  }

  // ---------------------------------------------------------------- drawing

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const g = this.geom
    const box: Rect = { x: g.cx - g.R, y: g.cy - g.R, w: 2 * g.R, h: 2 * g.R }
    ctx.save()
    ctx.beginPath()
    ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2)
    const paint = fillToCanvas(ctx, this.seriesBgFill, box.x, box.y, box.w, box.h)
    if (paint) {
      ctx.fillStyle = paint
      ctx.fill()
    }
    ctx.restore()
    if (!this.gridOnTop()) this.drawGrid(ctx)
  }

  /** Heatmaps cover the disc, so the grid moves above them. */
  private gridOnTop() { return this.series.some((s) => s instanceof PolarHeatmapSeries && s.getVisible()) }

  private drawGrid(ctx: CanvasRenderingContext2D) {
    const g = this.geom
    const t = this.theme
    ctx.save()
    // Amplitude circles.
    const ag = this.amplitude.gridStroke ?? gridLine(this)
    if (applyLineToCanvas(ctx, ag)) {
      ctx.beginPath()
      for (const tk of this.ampTicks) {
        const r = ((tk.value - g.start) / (g.end - g.start || 1)) * g.R
        if (r <= 0.5 || r >= g.R - 0.5) continue
        ctx.moveTo(g.cx + r, g.cy)
        ctx.arc(g.cx, g.cy, r, 0, Math.PI * 2)
      }
      ctx.stroke()
    }
    // Spokes.
    const sg = this.radial.gridStroke ?? gridLine(this)
    if (applyLineToCanvas(ctx, sg)) {
      ctx.beginPath()
      for (const l of this.angleLabels()) {
        const [x, y] = polarToPx(g, l.angle, g.end)
        ctx.moveTo(g.cx, g.cy)
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.setLineDash([])
    // Faint minor spokes between the labeled ones.
    if (this.radial.division <= 36 && !isEmptyLine(sg)) {
      ctx.strokeStyle = t.gridMinorColor.toCSS()
      ctx.lineWidth = 1
      ctx.beginPath()
      const n = this.radial.division * 2
      for (let k = 1; k < n; k += 2) {
        const [x, y] = polarToPx(g, (k * 360) / n, g.end)
        const [x0, y0] = polarToPx(g, (k * 360) / n, g.start + (g.end - g.start) * 0.15)
        ctx.moveTo(x0, y0)
        ctx.lineTo(x, y)
      }
      ctx.stroke()
    }
    ctx.restore()
  }

  override hasGL() { return this.series.length > 0 }
  override wantsMSAA() { return this.series.some((s) => s.hasFill()) }

  override drawGL(r: GLRenderer) {
    r.scissor(this.rect)
    for (const s of this.series) {
      if (!s.getVisible()) continue
      s.drawGL(r, this.geom)
    }
    r.scissor(null)
    r.glow = 0
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const g = this.geom
    const fs = t.fontSize
    if (this.gridOnTop()) this.drawGrid(ctx)
    // Rim.
    if (applyLineToCanvas(ctx, this.radial.stroke)) {
      ctx.beginPath()
      ctx.arc(g.cx, g.cy, g.R, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.setLineDash([])
    // Angle labels with small rim ticks.
    if (this.radial.labelsVisible) {
      ctx.font = font(t, fs)
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.strokeStyle = t.tickColor.toCSS()
      ctx.lineWidth = 1
      for (const l of this.angleLabels()) {
        const phi = (90 + (l.angle - g.north) * g.dir) * DEG
        const c = Math.cos(phi), s = Math.sin(phi)
        ctx.beginPath()
        ctx.moveTo(g.cx + c * g.R, g.cy - s * g.R)
        ctx.lineTo(g.cx + c * (g.R + 5), g.cy - s * (g.R + 5))
        ctx.stroke()
        const rr = g.R + 9
        ctx.textAlign = c > 0.3 ? 'left' : c < -0.3 ? 'right' : 'center'
        ctx.textBaseline = s > 0.3 ? 'bottom' : s < -0.3 ? 'top' : 'middle'
        ctx.fillText(l.text, g.cx + c * rr, g.cy - s * rr)
      }
    }
    // Amplitude labels along the top spoke, title rotated along it.
    const a = this.amplitude
    if (a.labelsVisible) {
      ctx.save()
      ctx.font = font(t, fs * 0.9)
      ctx.fillStyle = t.tickLabelColor.toCSS()
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      textHalo(ctx, t, true)
      for (const tk of this.ampTicks) {
        const r = ((tk.value - g.start) / (g.end - g.start || 1)) * g.R
        if (r < fs * 1.6 || r > g.R + 0.5) continue
        ctx.fillText(tk.label, g.cx + 4, g.cy - r + 3)
      }
      ctx.restore()
    }
    const title = a.title + (a.units ? ` (${a.units})` : '')
    if (title) {
      ctx.save()
      ctx.font = font(t, fs)
      ctx.fillStyle = t.axisTitleColor.toCSS()
      textHalo(ctx, t, true)
      ctx.translate(g.cx - 6, g.cy - g.R / 2)
      ctx.rotate(-Math.PI / 2)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'bottom'
      ctx.fillText(title, 0, 0, g.R)
      ctx.restore()
    }
    this.drawCursor(ctx)
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawCursor(ctx: CanvasRenderingContext2D) {
    const h = this.hit
    if (!h) return
    const t = this.theme
    const g = this.geom
    ctx.save()
    ctx.strokeStyle = t.cursor.lineColor.toCSS()
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    const rr = Math.hypot(h.px - g.cx, h.py - g.cy)
    const phi = Math.atan2(g.cy - h.py, h.px - g.cx)
    ctx.beginPath()
    ctx.moveTo(g.cx, g.cy)
    ctx.lineTo(g.cx + Math.cos(phi) * g.R, g.cy - Math.sin(phi) * g.R)
    if (rr > 2) {
      ctx.moveTo(g.cx + rr, g.cy)
      ctx.arc(g.cx, g.cy, rr, 0, Math.PI * 2)
    }
    ctx.stroke()
    ctx.setLineDash([])
    if (h.value === undefined) {
      ctx.beginPath()
      ctx.arc(h.px, h.py, 6, 0, Math.PI * 2)
      ctx.strokeStyle = t.isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      drawMarker(ctx, 'circle', h.px, h.py, 3.5, h.color, false)
    }
    // Angle pill on the rim.
    const pr = g.R + 4
    drawPill(ctx, t, formatAngle(h.angle), g.cx + Math.cos(phi) * pr, g.cy - Math.sin(phi) * pr)
    let rows: TableRows
    if (h.series.cursorFormatter) rows = h.series.cursorFormatter(new PolarTableBuilder(), h.series, h.angle, h.amplitude, h.value).rows
    else {
      rows = [[{ text: h.series.getName(), color: h.color }], ['Angle:', formatAngle(h.angle)], [(this.amplitude.title || 'Amplitude') + ':', this.amplitude.formatCursor(h.amplitude)]]
      if (h.value !== undefined) {
        const u = h.series instanceof PolarHeatmapSeries ? h.series.getLUT().units : ''
        rows.push(['Value:', fmtValue(h.value) + (u ? ` ${u}` : '')])
      }
    }
    drawResultTable(ctx, t, rows, h.px, h.py, this.rect)
    ctx.restore()
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
    const g = this.geom
    const inDisc = Math.hypot(x - g.cx, y - g.cy) <= g.R + 2
    switch (e.type) {
      case 'move':
        this.pointer = { x, y }
        this.surface.setCursor(inDisc && this.cursorMode !== 'disabled' ? 'crosshair' : 'default')
        return true
      case 'leave':
        this.pointer = null
        return true
      case 'wheel': {
        if (!inDisc || !this.interactions) return false
        const ev = e.native as WheelEvent
        const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
        this.amplitude.zoom(Math.exp(Math.max(-300, Math.min(300, e.deltaY * mult)) * 0.0015))
        return true
      }
      case 'dblclick':
        if (!inDisc || !this.interactions) return false
        this.amplitude.fit(true)
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

const formatAngle = (a: number) => `${Math.round(a * 10) / 10}°`
const fmtValue = (v: number) => {
  const a = Math.abs(v)
  return a !== 0 && (a < 1e-3 || a >= 1e7) ? v.toExponential(3) : String(Math.round(v * 1000) / 1000)
}
