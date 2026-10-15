import { Color } from '../core/color'
import { drawMarker, Legend, LegendOptions } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { Fill, fillToCanvas, LineStyle, Mutator, resolve, applyLineToCanvas } from '../core/style'
import { font } from '../core/theme'
import { Emitter, Rect, rectContains, roundRect, textWidth, Tween } from '../core/util'
import { GLRenderer, getRenderer, existingRenderer } from '../render/GLRenderer'
import { PointerInfo, Surface } from '../render/Surface'
import { Axis, AxisOptions, Band, ConstantLine } from './Axis'
import { PointLineAreaOptions, PointLineAreaSeries, SeriesPreset } from './series/PointLineAreaSeries'
import { CursorHit, ResultTableRows, SeriesXY } from './series/SeriesXY'
import { BoxSeries, BoxSeriesOptions } from './series/BoxSeries'
import { OHLCSeries, OHLCSeriesOptions } from './series/OHLCSeries'
import { RectangleSeries, RectangleSeriesOptions } from './series/RectangleSeries'
import { SegmentSeries, SegmentSeriesOptions } from './series/SegmentSeries'
import { EllipseSeries, EllipseSeriesOptions } from './series/EllipseSeries'
import { HeatmapGridOptions, HeatmapGridSeries, HeatmapScrollingGridSeries, HeatmapScrollingOptions } from './series/HeatmapSeries'

export type CursorMode =
  | 'show-nearest'
  | 'show-nearest-interpolated'
  | 'show-all'
  | 'show-all-interpolated'
  | 'show-pointed'
  | 'show-pointed-interpolated'
  | 'disabled'
  | undefined

export interface ChartXYOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  defaultAxisX?: AxisOptions
  defaultAxisY?: AxisOptions
  animationsEnabled?: boolean
  /** Accepted for API compatibility. */
  textRenderer?: unknown
  [k: string]: unknown
}

type Drag =
  | { kind: 'none' }
  | { kind: 'zoomrect'; x0: number; y0: number; x1: number; y1: number }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'axispan'; axis: Axis; last: number }
  | { kind: 'marker'; axis: Axis; marker: ConstantLine | Band; edge?: 'start' | 'end' | 'body'; last: number }
  | { kind: 'pinch'; d: number; cx: number; cy: number }

/** Cursor configuration (`chart.setCursor(c => ...)`). */
export class CursorSettings {
  tickX = true
  tickY = true
  gridX = true
  gridY = true
  table = true
  marker = true
  constructor(private chart: ChartXY) {}
  setTickMarkerXVisible(v: boolean) { this.tickX = v; return this }
  setTickMarkerYVisible(v: boolean) { this.tickY = v; return this }
  setGridStrokeXStyle(s: LineStyle) { this.gridX = s.type !== 'empty'; return this }
  setGridStrokeYStyle(s: LineStyle) { this.gridY = s.type !== 'empty'; return this }
  setGridXVisible(v: boolean) { this.gridX = v; return this }
  setGridYVisible(v: boolean) { this.gridY = v; return this }
  setResultTableVisible(v: boolean) { this.table = v; return this }
  setResultTableAutoTextStyle(_v: boolean) { return this }
  setPointMarkerVisible(v: boolean) { this.marker = v; return this }
  setTickMarkerX(_f: unknown) { return this }
  setTickMarkerY(_f: unknown) { return this }
  setResultTable(_f: unknown) { return this }
  setAutoFit(_v: boolean) { return this }
  setEnabled(v: boolean) { this.chart.setCursorMode(v ? 'show-nearest' : 'disabled'); return this }
}

/** Plot-area event target. */
export class SeriesBackground extends Emitter {
  fill: Fill
  stroke: LineStyle
  constructor(private chart: ChartXY) {
    super()
    const t = chart.getTheme()
    this.fill = t.seriesBackgroundFill
    this.stroke = t.seriesBackgroundStroke
  }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.requestRender(); return this }
  getFillStyle() { return this.fill }
  setStrokeStyle(l: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, l); this.chart.requestRender(); return this }
  /** @internal */
  fire(type: string, e: any) { this.emit(type, e) }
}

export class ChartXY extends Panel {
  axesX: Axis[] = []
  axesY: Axis[] = []
  readonly series: SeriesXY[] = []
  readonly legend: Legend
  readonly seriesBackground: SeriesBackground
  readonly cursor: CursorSettings
  plot: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private cursorMode: CursorMode = 'show-nearest'
  private cursorFormatter: ((chart: ChartXY, hit: CursorHit, hits: CursorHit[]) => ResultTableRows) | null = null
  private pointer: { x: number; y: number } | null = null
  private drag: Drag = { kind: 'none' }
  private colorCounter = 0
  private interactionsEnabled = true
  private hits: CursorHit[] = []
  private hoverInPlot = false
  /** Cursor X driven by another chart (synchronizeCursors). */
  private externalX: number | null = null
  private hoveredSeries: SeriesXY | null = null
  private externalActive = false
  private lastEmittedX: number | null = null
  /** `coordsAxis` / `coordsClient` / `coordsRelative` tokens for translateCoordinate. */
  readonly coordsAxis = { kind: 'axis' as const }
  readonly coordsClient = { kind: 'client' as const }
  readonly coordsRelative = { kind: 'relative' as const }

  constructor(o: ChartXYOptions = {}) {
    super(o)
    this.legend = new Legend(this, o.legend)
    this.seriesBackground = new SeriesBackground(this)
    this.cursor = new CursorSettings(this)
    this.axesX.push(new Axis(this, 'x', o.defaultAxisX))
    this.axesY.push(new Axis(this, 'y', o.defaultAxisY))
  }

  // ---------------------------------------------------------------- axes

  get axisX(): Axis { return this.axesX[0] }
  get axisY(): Axis { return this.axesY[0] }
  getDefaultAxisX() { return this.axesX[0] }
  getDefaultAxisY() { return this.axesY[0] }
  getDefaultAxes() { return [this.axesX[0], this.axesY[0]] }
  getAxes(dim?: 'x' | 'y') { return dim === 'x' ? [...this.axesX] : dim === 'y' ? [...this.axesY] : [...this.axesX, ...this.axesY] }
  forEachAxis(cb: (a: Axis) => void) { [...this.axesX, ...this.axesY].forEach(cb) }
  addAxisX(o: AxisOptions = {}) {
    const a = new Axis(this, 'x', o)
    this.axesX.push(a)
    this.requestRender()
    return a
  }
  addAxisY(o: AxisOptions = {}) {
    const a = new Axis(this, 'y', o)
    this.axesY.push(a)
    this.requestRender()
    return a
  }
  removeAxis(a: Axis) {
    this.axesX = this.axesX.filter((x) => x !== a)
    this.axesY = this.axesY.filter((x) => x !== a)
    this.requestRender()
  }
  /** @internal */
  gridFor(_a: Axis) { return true }
  /** @internal */
  addTween(t: Tween) { this.animate(t) }
  /** @internal */
  onAxisIntervalChanged(_a: Axis) { this.requestRender() }

  // ---------------------------------------------------------------- series

  private pickAxes(o: { axisX?: Axis; xAxis?: Axis; axisY?: Axis; yAxis?: Axis }) {
    const ax = (o.axisX ?? o.xAxis ?? this.axesX[0]) as Axis
    const ay = (o.axisY ?? o.yAxis ?? this.axesY[0]) as Axis
    if (!ax || !ay) throw new Error('sferic: series needs an X and a Y axis')
    return [ax, ay] as const
  }
  private nextColor(o: { automaticColorIndex?: number }) {
    return o.automaticColorIndex ?? this.colorCounter++
  }
  /** @internal Register a series created by an external module. */
  attachSeries<T extends SeriesXY>(s: T): T {
    this.series.push(s)
    if (this.legend.autoAdd) this.legend.add(s)
    this.requestRender()
    return s
  }
  /** @internal */
  allocColorIndex(o: { automaticColorIndex?: number } = {}) { return this.nextColor(o) }
  /** @internal */
  resolveAxes(o: { axisX?: Axis; xAxis?: Axis; axisY?: Axis; yAxis?: Axis } = {}) { return this.pickAxes(o) }

  private addPLA(preset: SeriesPreset, o: PointLineAreaOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new PointLineAreaSeries(this, ax, ay, this.nextColor(o), preset, o))
  }
  addLineSeries(o: PointLineAreaOptions = {}) { return this.addPLA('line', o) }
  addPointSeries(o: PointLineAreaOptions = {}) { return this.addPLA('point', o) }
  addPointLineSeries(o: PointLineAreaOptions = {}) { return this.addPLA('pointline', o) }
  addPointLineAreaSeries(o: PointLineAreaOptions = {}) { return this.addPLA('line', o) }
  addAreaSeries(o: PointLineAreaOptions = {}) { return this.addPLA('area', o) }
  addAreaRangeSeries(o: PointLineAreaOptions = {}) { return this.addPLA('arearange', o) }
  addStepSeries(o: PointLineAreaOptions = {}) { return this.addPLA('step', o) }
  addSplineSeries(o: PointLineAreaOptions = {}) { return this.addPLA('spline', o) }

  addHeatmapGridSeries(o: HeatmapGridOptions) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new HeatmapGridSeries(this, ax, ay, this.nextColor(o), o))
  }
  addHeatmapScrollingGridSeries(o: HeatmapScrollingOptions) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new HeatmapScrollingGridSeries(this, ax, ay, this.nextColor(o), o))
  }
  addBoxSeries(o: BoxSeriesOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new BoxSeries(this, ax, ay, this.nextColor(o), o))
  }
  addOHLCSeries(o: OHLCSeriesOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new OHLCSeries(this, ax, ay, this.nextColor(o), o))
  }
  addRectangleSeries(o: RectangleSeriesOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new RectangleSeries(this, ax, ay, this.nextColor(o), o))
  }
  addSegmentSeries(o: SegmentSeriesOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new SegmentSeries(this, ax, ay, this.nextColor(o), o))
  }
  addEllipseSeries(o: EllipseSeriesOptions = {}) {
    const [ax, ay] = this.pickAxes(o)
    return this.attachSeries(new EllipseSeries(this, ax, ay, this.nextColor(o), o))
  }
  /** Alias. */
  addCandlestickSeries(o: OHLCSeriesOptions = {}) { return this.addOHLCSeries(o) }
  /** @internal */
  maxTextureSize() { return getRenderer().maxTextureSize }
  /** @internal */
  renderer() { return getRenderer() }

  getSeries() { return [...this.series] }
  removeSeries(s: SeriesXY) {
    const i = this.series.indexOf(s)
    if (i < 0) return
    this.series.splice(i, 1)
    this.legend.remove(s)
    s.disposeGL(existingRenderer())
    this.requestRender()
  }
  /** @internal */
  onSeriesData(_s: SeriesXY) { this.requestRender() }

  // ---------------------------------------------------------------- cursor / interaction config

  setCursorMode(m: CursorMode) { this.cursorMode = m ?? 'disabled'; this.requestRender(); return this }
  getCursorMode() { return this.cursorMode }
  setCursorFormatting(f: ((chart: ChartXY, hit: CursorHit, hits: CursorHit[]) => ResultTableRows) | undefined) {
    this.cursorFormatter = f ?? null
    return this
  }
  setCursor(f: (c: CursorSettings) => unknown) { f(this.cursor); this.requestRender(); return this }
  setAutoCursorMode(m: string) { return this.setCursorMode(m === 'disabled' ? 'disabled' : 'show-nearest') }
  setAutoCursor(f: (c: CursorSettings) => unknown) { return this.setCursor(f) }
  setMouseInteractions(v: boolean) { this.interactionsEnabled = v; return this }
  setUserInteractions(v: boolean | Record<string, unknown> | undefined) { this.interactionsEnabled = v !== false && v !== undefined; return this }
  setSeriesBackgroundFillStyle(f: Mutator<Fill>) { this.seriesBackground.setFillStyle(f); return this }
  setSeriesBackgroundStrokeStyle(l: Mutator<LineStyle>) { this.seriesBackground.setStrokeStyle(l); return this }
  setAnimationsEnabled(v: boolean) { this.forEachAxis((a) => a.setAnimationsEnabled(v)); return this }
  /** Legacy legend-box API: returns the chart legend. */
  addLegendBox(..._args: unknown[]) {
    this.legend.setOptions({ position: 'right-center' })
    const lg = this.legend as any
    const add0 = lg.add.bind(lg)
    return Object.assign(lg, {
      add: (t: any) => {
        if (t instanceof ChartXY) {
          for (const s of t.series) add0(s)
          return lg
        }
        return add0(t)
      },
      setAutoDispose: () => lg,
      setPosition: () => lg,
      setOrigin: () => lg,
      setMargin: () => lg,
    })
  }
  zoom(factor: number, center?: { x: number; y: number }) {
    const cx = center?.x ?? this.plot.x + this.plot.w / 2
    const cy = center?.y ?? this.plot.y + this.plot.h / 2
    for (const a of this.axesX) a.zoomAround(cx, factor)
    for (const a of this.axesY) a.zoomAround(cy, factor)
    return this
  }
  /** Fit all axes to data. */
  fit(animate: boolean | number = true) { this.forEachAxis((a) => a.fit(animate)); return this }

  /** Convert between client (page) coordinates and axis values. */
  translateCoordinate(
    p: { clientX: number; clientY: number } | { x: number; y: number },
    a?: { kind: string } | Axis,
    b?: { kind: string } | Axis,
  ): { x: number; y: number } {
    const rect = this.surface.canvas.getBoundingClientRect()
    if ('clientX' in p) {
      const lx = p.clientX - rect.left, ly = p.clientY - rect.top
      if (a instanceof Axis && b instanceof Axis) return { x: a.pxToValue(lx), y: b.pxToValue(ly) }
      if (a && (a as { kind: string }).kind === 'relative') return { x: lx - this.rect.x, y: this.rect.y + this.rect.h - ly }
      return { x: this.axisX.pxToValue(lx), y: this.axisY.pxToValue(ly) }
    }
    // axis -> client
    const ax = a instanceof Axis ? a : this.axisX
    const ay = b instanceof Axis ? b : this.axisY
    if (b && (b as { kind: string }).kind === 'client' || !b) {
      return { x: rect.left + ax.valueToPx(p.x), y: rect.top + ay.valueToPx(p.y) }
    }
    return { x: ax.valueToPx(p.x), y: ay.valueToPx(p.y) }
  }

  // ---------------------------------------------------------------- data extents

  dataExtent(axis: Axis): { min: number; max: number; tight: boolean } {
    let min = Infinity, max = -Infinity
    let tight = true
    for (const s of this.series) {
      if (!s.getVisible() || !s.autoScroll) continue
      if (s.axisX !== axis && s.axisY !== axis) continue
      const b = axis.fitVisible && s.axisY === axis ? s.yBoundsInX(s.axisX.lo, s.axisX.hi) : s.bounds()
      if (!b || !(b.ymin <= b.ymax)) continue
      if (!s.fitTight) tight = false
      if (s.axisX === axis) {
        if (b.xmin < min) min = b.xmin
        if (b.xmax > max) max = b.xmax
      } else {
        if (b.ymin < min) min = b.ymin
        if (b.ymax > max) max = b.ymax
      }
    }
    return { min, max, tight }
  }

  // ---------------------------------------------------------------- layout

  override layout(_ctx: CanvasRenderingContext2D) {
    // Scroll strategies first (X before Y so Y can react to X changes).
    for (const a of [...this.axesX, ...this.axesY]) {
      const e = this.dataExtent(a)
      a.updateScroll(e.min, e.max, e.tight)
    }
    const content = this.layoutBase()
    const t = this.theme
    const area = this.legend.layout(content)
    const fs = t.fontSize

    const stackSum = (axes: Axis[], f: (a: Axis) => number) => {
      const m = new Map<number, number>()
      for (const a of axes) m.set(a.iStack, (m.get(a.iStack) ?? 0) + f(a))
      return Math.max(0, ...m.values())
    }
    const xb = this.axesX.filter((a) => !a.opposite), xt = this.axesX.filter((a) => a.opposite)
    const yl = this.axesY.filter((a) => !a.opposite), yr = this.axesY.filter((a) => a.opposite)
    for (const a of this.axesX) a.thickness = a.measureThicknessX()
    const bottomH = stackSum(xb, (a) => a.thickness)
    const topH = stackSum(xt, (a) => a.thickness)
    const plotTop = area.y + Math.max(topH, fs * 0.6)
    const plotBottom = area.y + area.h - Math.max(bottomH, 4)

    // Distribute Y stacks vertically (iStack 0 at the bottom).
    this.distribute(this.axesY, plotBottom, plotTop)
    for (const a of this.axesY) {
      a.computeTicks()
      a.thickness = a.measureThicknessY()
    }
    const leftW = stackSum(yl, (a) => a.thickness)
    const rightW = stackSum(yr, (a) => a.thickness)
    const plotLeft = area.x + Math.max(leftW, 4)
    const plotRight = area.x + area.w - Math.max(rightW, fs * 1.2)
    this.distribute(this.axesX, plotLeft, plotRight)
    for (const a of this.axesX) a.computeTicks()

    // Axis line positions, stacked outward.
    const place = (axes: Axis[], base: number, dir: number) => {
      const off = new Map<number, number>()
      for (const a of axes) {
        const o = off.get(a.iStack) ?? 0
        a.pos = base + o * dir
        off.set(a.iStack, o + a.thickness)
      }
    }
    place(xb, plotBottom, 1)
    place(xt, plotTop, -1)
    place(yl, plotLeft, -1)
    place(yr, plotRight, 1)
    this.plot = { x: plotLeft, y: plotTop, w: Math.max(1, plotRight - plotLeft), h: Math.max(1, plotBottom - plotTop) }
    this.updateCursor()
  }

  /** Split [from, to] among axis stacks (weights, fixed px, margins). */
  private distribute(axes: Axis[], from: number, to: number) {
    const stacks = [...new Set(axes.map((a) => a.iStack))].sort((a, b) => a - b)
    const total = Math.abs(to - from)
    const dir = Math.sign(to - from) || 1
    const info = stacks.map((s) => {
      const as = axes.filter((a) => a.iStack === s)
      const px = as.find((a) => a.lengthPx !== null)?.lengthPx ?? null
      return { s, as, px, w: Math.max(...as.map((a) => a.lengthWeight)) }
    })
    const fixed = info.reduce((acc, i) => acc + (i.px ?? 0), 0)
    const wsum = info.reduce((acc, i) => acc + (i.px === null ? i.w : 0), 0) || 1
    let cur = from
    for (const i of info) {
      const len = i.px !== null ? i.px : ((total - fixed) * i.w) / wsum
      const a0 = cur, a1 = cur + len * dir
      for (const a of i.as) {
        a.px0 = a0 + a.margins[0] * dir
        a.px1 = a1 - a.margins[1] * dir
        if (a.dim === 'y') {
          // Y: start maps to bottom (px0 larger)
        }
      }
      cur = a1
    }
  }

  seriesRect(s: SeriesXY): Rect {
    const ax = s.axisX, ay = s.axisY
    const x0 = Math.min(ax.px0, ax.px1), x1 = Math.max(ax.px0, ax.px1)
    const y0 = Math.min(ay.px0, ay.px1), y1 = Math.max(ay.px0, ay.px1)
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  }

  // ---------------------------------------------------------------- drawing

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const p = this.plot
    const paint = fillToCanvas(ctx, this.seriesBackground.fill, p.x, p.y, p.w, p.h)
    if (paint) {
      ctx.fillStyle = paint
      ctx.fillRect(p.x, p.y, p.w, p.h)
    }
    for (const a of this.axesX) a.drawGrid(ctx, { x: Math.min(a.px0, a.px1), w: Math.abs(a.px1 - a.px0), y: p.y, h: p.h })
    for (const a of this.axesY) a.drawGrid(ctx, { x: p.x, w: p.w, y: Math.min(a.px0, a.px1), h: Math.abs(a.px1 - a.px0) })
    for (const a of [...this.axesX, ...this.axesY]) a.drawMarkers(ctx, p, false)
  }

  override hasGL() { return this.series.length > 0 }
  override prepareGL(r: GLRenderer) {
    for (const s of this.series) s.prepareGL(r)
  }

  /** Series draw through GLRenderer helpers only; raw uniform writes are confined to their own programs. */
  override usesRawGL() { return false }

  override drawGL(r: GLRenderer) {
    for (const s of this.series) {
      if (!s.getVisible()) continue
      const rect = this.seriesRect(s)
      if (rect.w <= 0 || rect.h <= 0) continue
      r.scissor(rect)
      r.glow = s.getEffect() ? 1 : 0
      s.drawGL(r, { mx: s.axisX.map(), my: s.axisY.map(), x0: s.axisX.lo, x1: s.axisX.hi }, rect)
    }
    // Scissor is left as-is; the next drawable sets its own (Surface resets it before raw-GL drawables).
    r.glow = 0
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const p = this.plot
    for (const a of [...this.axesX, ...this.axesY]) a.drawMarkers(ctx, p, true)
    for (const s of this.series) if (s.getVisible()) s.drawOverlay(ctx, this.seriesRect(s))
    if (applyLineToCanvas(ctx, this.seriesBackground.stroke)) {
      ctx.strokeRect(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5, Math.round(p.w) - 1, Math.round(p.h) - 1)
    }
    for (const a of [...this.axesX, ...this.axesY]) a.drawAxis(ctx)
    if (this.drag.kind === 'zoomrect') {
      const d = this.drag
      const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1)
      const w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0)
      ctx.fillStyle = t.zoomRectFill.toCSS()
      ctx.fillRect(x, y, w, h)
      ctx.strokeStyle = t.zoomRectStroke.toCSS()
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.strokeRect(x + 0.5, y + 0.5, w, h)
    }
    this.drawCursor(ctx)
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  // ---------------------------------------------------------------- cursor

  /** Show a cursor at an X value of the default X axis (null hides it). */
  showCursorAtX(x: number | null) {
    if (x === this.externalX) return this
    this.externalX = x
    this.requestRender()
    return this
  }

  private emitCursor(x: number | null) {
    if (x === this.lastEmittedX) return
    this.lastEmittedX = x
    this.emit('cursorchange', { x })
  }

  private updateCursor() {
    this.hits = []
    this.externalActive = false
    const mode = this.cursorMode
    if (mode === 'disabled' || mode === undefined || this.drag.kind !== 'none') return this.emitCursor(null)
    if (!this.pointer || !rectContains(this.plot, this.pointer.x, this.pointer.y)) {
      this.emitCursor(null)
      if (this.externalX === null) return
      const xv = this.externalX
      for (const s of this.series) {
        if (!s.getVisible() || !s.cursorEnabled || s.axisX !== this.axisX) continue
        const h = s.valueAtX(xv)
        if (h && Math.abs(h.px - this.axisX.valueToPx(xv)) < 40) this.hits.push(h)
      }
      this.externalActive = this.hits.length > 0
      return
    }
    const { x, y } = this.pointer
    const cands: CursorHit[] = []
    for (const s of this.series) {
      if (!s.getVisible() || !s.cursorEnabled) continue
      const r = this.seriesRect(s)
      if (!rectContains(r, x, y)) continue
      const h = s.nearest(x, y, false)
      if (h && rectContains({ x: r.x - 1, y: r.y - 1, w: r.w + 2, h: r.h + 2 }, h.px, h.py)) cands.push(h)
    }
    if (!cands.length) return
    cands.sort((a, b) => a.dist2 - b.dist2)
    const best = cands[0]
    if (mode.startsWith('show-pointed') && best.dist2 > 24 * 24) return
    this.emitCursor(best.x)
    if (mode.startsWith('show-all')) {
      const hits: CursorHit[] = []
      for (const s of this.series) {
        if (!s.getVisible() || !s.cursorEnabled || s.axisX !== best.series.axisX) continue
        const h = s === best.series ? best : s.valueAtX(best.x)
        if (h) hits.push(h)
      }
      this.hits = hits
    } else {
      this.hits = [best]
    }
  }

  private drawCursor(ctx: CanvasRenderingContext2D) {
    if (!this.hits.length) return
    const t = this.theme
    const c = this.cursor
    const best = this.hits[0]
    const all = this.hits.length > 1 || this.cursorMode?.startsWith('show-all') || this.externalActive
    const r = this.seriesRect(best.series)
    ctx.save()
    ctx.strokeStyle = t.cursor.lineColor.toCSS()
    ctx.lineWidth = 1
    ctx.setLineDash([4, 4])
    ctx.beginPath()
    if (c.gridX) {
      const px = Math.round(best.px) + 0.5
      ctx.moveTo(px, this.plot.y)
      ctx.lineTo(px, this.plot.y + this.plot.h)
    }
    if (c.gridY && !all) {
      const py = Math.round(best.py) + 0.5
      ctx.moveTo(r.x, py)
      ctx.lineTo(r.x + r.w, py)
    }
    ctx.stroke()
    ctx.setLineDash([])
    if (c.marker) {
      for (const h of this.hits) {
        if (!rectContains(this.plot, h.px, h.py)) continue
        ctx.beginPath()
        ctx.arc(h.px, h.py, 6, 0, Math.PI * 2)
        ctx.strokeStyle = t.isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.6)'
        ctx.lineWidth = 1.5
        ctx.stroke()
        drawMarker(ctx, 'circle', h.px, h.py, 3.5, h.color, false)
      }
    }
    if (c.tickX) best.series.axisX.drawCursorTick(ctx, best.x)
    if (c.tickY) for (const h of all ? this.hits : [best]) h.series.axisY.drawCursorTick(ctx, h.y)
    if (c.table && !this.externalActive) this.drawResultTable(ctx, best, all)
    ctx.restore()
  }

  private drawResultTable(ctx: CanvasRenderingContext2D, best: CursorHit, all: boolean | undefined) {
    const t = this.theme
    const fs = t.fontSize
    let rows: ResultTableRows
    if (this.cursorFormatter) rows = this.cursorFormatter(this, best, this.hits)
    else if (all) {
      rows = [[best.series.axisX.formatCursor(best.x)]]
      for (const h of this.hits) rows.push([{ text: h.series.getName(), color: h.color }, h.series.axisY.formatCursor(h.y)])
    } else rows = best.series.tableRows(best)
    if (!rows.length) return
    const cell = (c: string | { text: string; color?: Color }) => (typeof c === 'string' ? { text: c } : c)
    const fnt = font(t, fs)
    const cols = Math.max(...rows.map((r) => r.length))
    const colW = new Array(cols).fill(0)
    for (const r of rows) r.forEach((c, i) => (colW[i] = Math.max(colW[i], textWidth(cell(c).text, fnt))))
    const lh = fs * 1.45
    const pad = 8
    const singles = rows.filter((r) => r.length === 1).map((r) => textWidth(cell(r[0]).text, fnt))
    const w = Math.max(colW.reduce((a, b) => a + b, 0) + (cols - 1) * 12, ...singles) + pad * 2
    const h = rows.length * lh + pad * 2 - (lh - fs)
    let x = best.px + 14, y = best.py - h - 10
    const R = this.rect
    if (x + w > R.x + R.w - 4) x = best.px - w - 14
    if (y < R.y + 4) y = best.py + 14
    if (y + h > R.y + R.h - 4) y = R.y + R.h - h - 4
    roundRect(ctx, x, y, w, h, 5)
    ctx.fillStyle = t.cursor.tableFill.toCSS()
    ctx.fill()
    ctx.strokeStyle = t.cursor.tableStroke.toCSS()
    ctx.lineWidth = 1
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
  }

  // ---------------------------------------------------------------- interaction

  private axisAt(x: number, y: number): Axis | null {
    for (const a of [...this.axesX, ...this.axesY]) if (a.visible && rectContains(a.hitRect(), x, y)) return a
    return null
  }

  private markerAt(x: number, y: number) {
    if (!rectContains(this.plot, x, y)) return null
    for (const a of [...this.axesX, ...this.axesY]) {
      const m = a.markerAt(a.dim === 'x' ? x : y)
      if (m) return { axis: a, ...m }
    }
    return null
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') {
      if (this.legend.onPointer('click', x, y)) return true
      const hit = this.pointedSeries(x, y)
      if (hit) hit.series.dispatch('click', { event: e.native, hit })
      return !!hit
    }
    if (e.type === 'move' && this.drag.kind === 'none' && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      return true
    }
    if (e.type === 'down' && this.legend.contains(x, y)) return true
    const inPlot = rectContains(this.plot, x, y)
    this.firePlotEvent(e, inPlot)
    if (!this.interactionsEnabled) {
      if (e.type === 'move' || e.type === 'leave') {
        this.pointer = e.type === 'move' ? { x, y } : null
        return true
      }
      return false
    }
    switch (e.type) {
      case 'move': return this.onMove(e, inPlot)
      case 'down': return this.onDown(e, inPlot)
      case 'up': return this.onUp(e)
      case 'wheel': return this.onWheel(e, inPlot)
      case 'dblclick': {
        const a = this.axisAt(x, y)
        if (a) a.fit(true)
        else if (inPlot) this.fit(true)
        return true
      }
      case 'leave':
        this.pointer = null
        this.hoverInPlot = false
        this.legend.onPointer('leave', -1e9, -1e9)
        return true
    }
    return false
  }

  /** Series whose nearest data point is within a few pixels of (x, y). */
  private pointedSeries(x: number, y: number): CursorHit | null {
    if (!rectContains(this.plot, x, y)) return null
    let best: CursorHit | null = null
    for (const s of this.series) {
      if (!s.getVisible()) continue
      const h = s.nearest(x, y, false)
      if (!h) continue
      const d2 = (h.px - x) ** 2 + (h.py - y) ** 2
      const lim = h.dist2 === 0 ? Infinity : 12 * 12
      if (d2 <= lim && (!best || d2 < (best.px - x) ** 2 + (best.py - y) ** 2)) best = h
    }
    return best
  }

  private fireSeriesHover(x: number, y: number, inPlot: boolean) {
    if (!this.series.some((s) => s.hasListener('pointerenter') || s.hasListener('pointerleave') || s.hasListener('pointermove'))) return
    const hit = inPlot ? this.pointedSeries(x, y) : null
    const s = hit?.series ?? null
    if (s !== this.hoveredSeries) {
      this.hoveredSeries?.dispatch('pointerleave', { hit: null })
      this.hoveredSeries = s
      s?.dispatch('pointerenter', { hit })
    }
    if (s && hit) s.dispatch('pointermove', { hit })
  }

  private firePlotEvent(e: PointerInfo, inPlot: boolean) {
    if (e.type === 'move' || e.type === 'leave') this.fireSeriesHover(e.x, e.y, inPlot && e.type === 'move')
    const sb = this.seriesBackground
    const native = e.native
    if (inPlot !== this.hoverInPlot && (e.type === 'move' || e.type === 'leave')) {
      this.hoverInPlot = inPlot && e.type === 'move'
      sb.fire(this.hoverInPlot ? 'pointerenter' : 'pointerleave', native)
    }
    if (!inPlot) return
    if (e.type === 'move') sb.fire('pointermove', native)
    else if (e.type === 'down') sb.fire('pointerdown', native)
    else if (e.type === 'up') sb.fire('pointerup', native)
    else if (e.type === 'click') sb.fire('click', native)
    else if (e.type === 'dblclick') sb.fire('dblclick', native)
  }

  private onMove(e: PointerInfo, inPlot: boolean): boolean {
    const d = this.drag
    const { x, y } = e
    if (d.kind === 'zoomrect') {
      d.x1 = Math.min(Math.max(x, this.plot.x), this.plot.x + this.plot.w)
      d.y1 = Math.min(Math.max(y, this.plot.y), this.plot.y + this.plot.h)
      return true
    }
    if (d.kind === 'pan') {
      const dx = x - d.x, dy = y - d.y
      for (const a of this.axesX) if (a.interactions) a.panPx(dx)
      for (const a of this.axesY) if (a.interactions) a.panPx(dy)
      d.x = x
      d.y = y
      return true
    }
    if (d.kind === 'axispan') {
      const p = d.axis.dim === 'x' ? x : y
      d.axis.panPx(p - d.last)
      d.last = p
      return true
    }
    if (d.kind === 'marker') {
      const p = d.axis.dim === 'x' ? x : y
      const v = d.axis.pxToValue(p)
      const m = d.marker
      if (m instanceof ConstantLine) m.setValue(v)
      else if (d.edge === 'start') m.setValueStart(v)
      else if (d.edge === 'end') m.setValueEnd(v)
      else {
        const dv = v - d.axis.pxToValue(d.last)
        m.setValueStart(m.start + dv).setValueEnd(m.end + dv)
      }
      d.last = p
      return true
    }
    if (d.kind === 'pinch') {
      const pts = [...e.pointers.values()]
      if (pts.length >= 2) {
        const nd = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y)
        const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2
        const f = d.d / (nd || 1)
        for (const a of this.axesX) if (a.interactions) { a.panPx(cx - d.cx); a.zoomAround(cx, f) }
        for (const a of this.axesY) if (a.interactions) { a.panPx(cy - d.cy); a.zoomAround(cy, f) }
        d.d = nd
        d.cx = cx
        d.cy = cy
      }
      return true
    }
    this.pointer = { x, y }
    const m = this.markerAt(x, y)
    const a = inPlot ? null : this.axisAt(x, y)
    if (m) this.surface.setCursor(m.axis.dim === 'x' ? 'ew-resize' : 'ns-resize')
    else if (a) this.surface.setCursor(a.dim === 'x' ? 'ew-resize' : 'ns-resize')
    else if (inPlot) this.surface.setCursor(this.cursorMode === 'disabled' ? 'default' : 'crosshair')
    else this.surface.setCursor('default')
    return true
  }

  private onDown(e: PointerInfo, inPlot: boolean): boolean {
    const { x, y } = e
    if (e.pointers.size >= 2) {
      const pts = [...e.pointers.values()]
      this.drag = {
        kind: 'pinch',
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        cx: (pts[0].x + pts[1].x) / 2,
        cy: (pts[0].y + pts[1].y) / 2,
      }
      return true
    }
    const a = this.axisAt(x, y)
    if (!inPlot && a && a.interactions) {
      this.drag = { kind: 'axispan', axis: a, last: a.dim === 'x' ? x : y }
      return true
    }
    if (!inPlot) return false
    const m = this.markerAt(x, y)
    if (m && e.button === 0) {
      this.drag = { kind: 'marker', axis: m.axis, marker: m.marker, edge: m.edge, last: m.axis.dim === 'x' ? x : y }
      return true
    }
    const touch = e.pointerType === 'touch'
    if ((e.button === 0 && !touch && !e.shiftKey)) {
      this.drag = { kind: 'zoomrect', x0: x, y0: y, x1: x, y1: y }
    } else {
      this.drag = { kind: 'pan', x, y }
    }
    this.hits = []
    return true
  }

  private onUp(_e: PointerInfo): boolean {
    const d = this.drag
    this.drag = { kind: 'none' }
    if (d.kind === 'zoomrect') {
      const dx = d.x1 - d.x0, dy = d.y1 - d.y0
      if (Math.abs(dx) < 6 && Math.abs(dy) < 6) return true
      if (dx < 0 || dy < 0) {
        // Drag towards top-left resets the view.
        this.fit(true)
        return true
      }
      const xs = Math.abs(dx) >= 6, ys = Math.abs(dy) >= 6
      if (xs) for (const a of this.axesX) if (a.interactions) {
        const v0 = a.pxToValue(d.x0), v1 = a.pxToValue(d.x1)
        const inv = a.start > a.end
        a.applyInterval(inv ? Math.max(v0, v1) : Math.min(v0, v1), inv ? Math.min(v0, v1) : Math.max(v0, v1), 300)
        a.stopped = true
      }
      if (ys) for (const a of this.axesY) if (a.interactions) {
        const v0 = a.pxToValue(d.y0), v1 = a.pxToValue(d.y1)
        const inv = a.start > a.end
        a.applyInterval(inv ? Math.max(v0, v1) : Math.min(v0, v1), inv ? Math.min(v0, v1) : Math.max(v0, v1), 300)
        a.stopped = true
      }
      return true
    }
    return d.kind !== 'none'
  }

  private onWheel(e: PointerInfo, inPlot: boolean): boolean {
    const ev = e.native as WheelEvent
    const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
    const f = Math.exp(Math.max(-300, Math.min(300, e.deltaY * mult)) * 0.0015)
    const a = inPlot ? null : this.axisAt(e.x, e.y)
    if (a) {
      if (!a.interactions) return false
      a.zoomAround(a.dim === 'x' ? e.x : e.y, f)
      return true
    }
    if (!inPlot) return false
    for (const ax of this.axesX) if (ax.interactions && (!e.shiftKey || true)) ax.zoomAround(e.x, f)
    if (!e.ctrlKey) for (const ay of this.axesY) if (ay.interactions) ay.zoomAround(e.y, f)
    return true
  }

  override tick(now: number): boolean {
    return super.tick(now)
  }

  override disposeGL(r: GLRenderer | null) {
    for (const s of this.series) s.disposeGL(r)
  }

  override dispose() {
    this.series.forEach((s) => this.legend.remove(s))
    super.dispose()
  }
}
