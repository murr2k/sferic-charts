import { Color } from '../core/color'
import { drawMarker, Legend, LegendOptions, LegendSymbol, LegendTarget } from '../core/Legend'
import { FontSettings, Panel, PanelOptions } from '../core/Panel'
import { Fill, Mutator, resolve, SolidFill } from '../core/style'
import { font } from '../core/theme'
import { clamp, Easing, Easings, lerp, Rect, rectContains, roundRect, textWidth, Tween } from '../core/util'
import { RectBatch } from '../render/draw'
import { AxisMap, GLRenderer } from '../render/GLRenderer'
import type { PointerInfo, Surface } from '../render/Surface'
import { AxisTickStrategies, Tick, TickStrategy } from '../xy/ticks'

const TICK = 5
const GAP = 4
const SEP = '\u0001'
/** Identity mapping: bars are batched directly in CSS px. */
const ID: AxisMap = { a0: 0, start: 0, k: 1, log: 0 }

export const BarChartTypes = { Vertical: 'vertical', Horizontal: 'horizontal' } as const
export type BarChartType = (typeof BarChartTypes)[keyof typeof BarChartTypes]

export const BarChartSorting = {
  None: 'none',
  Disabled: 'none',
  Ascending: 'ascending',
  Descending: 'descending',
  Alphabetical: 'alphabetical',
} as const
export type BarChartSortingMode = (typeof BarChartSorting)[keyof typeof BarChartSorting]

export interface BarChartOptions extends PanelOptions {
  surface?: Surface
  type?: BarChartType
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

export interface BarDataPoint { category: string; value: number }
export interface BarSubCategoryValues { subCategory: string; values: number[] }

/** Passed to value label formatters and color callbacks. */
export interface BarInfo {
  category: string
  subCategory?: string
  value: number
  /** Sum of the category's visible values (stack total for stacked bars). */
  stackedSum: number
}

export type BarValueLabelPosition = 'inside-bar' | 'after-bar' | 'none'
export interface BarValueLabelOptions {
  position?: BarValueLabelPosition
  formatter?: (info: BarInfo, category: string, value: number) => string
  labelFillStyle?: Fill
  labelFont?: FontSettings
  /** Stacked bars: label the stack total. Defaults to on for 'after-bar'. */
  displayStackedSum?: boolean
}

const cloneStrategy = <T extends TickStrategy>(s: T): T => Object.assign(Object.create(Object.getPrototypeOf(s)), s)

const defaultFormat = (v: number) => {
  const a = Math.abs(v)
  const d = a >= 100 ? 0 : a >= 10 ? 1 : 2
  return v.toLocaleString('en-US', { maximumFractionDigits: d })
}

abstract class BarAxis {
  title = ''
  units = ''
  titleColor: Color | null = null
  visible = true
  labelsVisible = true
  constructor(protected chart: BarChart) {}
  setTitle(t: string) { this.title = t; this.chart.requestRender(); return this }
  getTitle() { return this.title }
  setUnits(u: string) { this.units = u; this.chart.requestRender(); return this }
  getUnits() { return this.units }
  setTitleFillStyle(f: Mutator<Fill>) {
    this.titleColor = resolve<Fill>(new SolidFill({ color: this.titleColor ?? this.chart.getTheme().axisTitleColor }), f).getPrimaryColor()
    this.chart.requestRender()
    return this
  }
  setVisible(v: boolean) { this.visible = v; this.chart.invalidate(); return this }
  getVisible() { return this.visible }
  setTickLabelsVisible(v: boolean) { this.labelsVisible = v; this.chart.invalidate(); return this }
  /** @internal */
  titleText() { return this.title + (this.units ? ` (${this.units})` : '') }
}

/** Category axis of a BarChart (labels only). */
export class BarCategoryAxis extends BarAxis {}

/** Value axis of a BarChart: numeric ticks, auto fitting or a fixed interval. */
export class BarValueAxis extends BarAxis {
  /** @internal */
  strategy: TickStrategy = cloneStrategy(AxisTickStrategies.Numeric)
  /** @internal */
  fixed: { start: number; end: number } | null = null
  /** @internal */
  ticks: Tick[] = []
  setTickStrategy<T extends TickStrategy>(s: T, styler?: (s: T) => T) {
    let st = cloneStrategy(s)
    if (styler) st = styler(st)
    this.strategy = st
    this.chart.invalidate()
    return this
  }
  getTickStrategy() { return this.strategy.type }
  setInterval(a: { start: number; end: number; stopAxisAfter?: boolean; animate?: boolean | number } | number, end?: number) {
    const s = typeof a === 'number' ? a : a.start
    const e = typeof a === 'number' ? end! : a.end
    if (Number.isFinite(s) && Number.isFinite(e) && s !== e) this.fixed = { start: Math.min(s, e), end: Math.max(s, e) }
    this.chart.invalidate()
    return this
  }
  getInterval() { return this.chart.valueInterval() }
  /** Return to automatic fitting. */
  fit() { this.fixed = null; this.chart.invalidate(); return this }
  formatValue(v: number) { return this.strategy.formatValue(v, this.getInterval()) }
}

/** Legend entry for a sub category (grouped / stacked data). */
export class BarSubCategory implements LegendTarget {
  visible = true
  constructor(private chart: BarChart, readonly name: string) {}
  getName() { return this.name }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.chart.subCategoryColor(this.name) } }
  getVisible() { return this.visible }
  setVisible(v: boolean) {
    if (this.visible !== v) {
      this.visible = v
      this.chart.retarget()
    }
    return this
  }
}

interface Geom { slot: number; sub: number; nsub: number; lo: number; hi: number; alpha: number }
const lerpGeom = (a: Geom, b: Geom, t: number): Geom => ({
  slot: lerp(a.slot, b.slot, t),
  sub: lerp(a.sub, b.sub, t),
  nsub: lerp(a.nsub, b.nsub, t),
  lo: lerp(a.lo, b.lo, t),
  hi: lerp(a.hi, b.hi, t),
  alpha: lerp(a.alpha, b.alpha, t),
})

interface BarItem {
  key: string
  category: string
  sub: string
  value: number
  total: number
  cur: Geom
  from: Geom
  to: Geom
  dying: boolean
}

type Mode = 'simple' | 'grouped' | 'stacked'

/**
 * Category bar chart: simple, grouped and stacked
 * bars, vertical or horizontal, sorted, with animated transitions between data
 * sets (racing bars). Bars render on the GPU as one instanced rect batch.
 */
export class BarChart extends Panel {
  readonly valueAxis: BarValueAxis
  readonly categoryAxis: BarCategoryAxis
  readonly legend: Legend
  private type: BarChartType
  private mode: Mode = 'simple'
  private categories: string[] = []
  private subNames: string[] = []
  /** [sub][category] */
  private matrix: number[][] = []
  private subEntries = new Map<string, BarSubCategory>()
  private items: BarItem[] = []
  private sorting: BarChartSortingMode = 'none'
  private labels: BarValueLabelOptions & { position: BarValueLabelPosition } = { position: 'after-bar' }
  private margin = 0.25
  private effect: boolean | null = null
  private radius = 0
  private barsColor: Color | ((info: BarInfo) => Color) | null = null
  private palette: Color[] | null = null
  private catColorIdx = new Map<string, number>()
  private subColorIdx = new Map<string, number>()
  private animationsEnabled = true
  private animValues = true
  private animPositions = true
  private duration = 700
  private easing: Easing = Easings.easeInOut
  private tween: Tween | null = null
  private slots = { cur: 0, from: 0, to: 0 }
  private iv = { cur: { lo: 0, hi: 1 }, from: { lo: 0, hi: 1 }, to: { lo: 0, hi: 1 } }
  private batch = new RectBatch()
  private geomDirty = true
  private geomKey = ''
  private cursorEnabled = true
  private hover: BarItem | null = null
  private pointer: { x: number; y: number } | null = null
  /** Layout results (CSS px). */
  plot: Rect = { x: 0, y: 0, w: 1, h: 1 }
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private lo = 0
  private hi = 1
  private rotateCats = false
  private catMaxW = 0
  private catLabels: { name: string; slot: number; alpha: number }[] = []

  constructor(o: BarChartOptions = {}) {
    super(o)
    this.type = o.type === 'horizontal' ? 'horizontal' : 'vertical'
    this.valueAxis = new BarValueAxis(this)
    this.categoryAxis = new BarCategoryAxis(this)
    this.legend = new Legend(this, o.legend)
  }

  // ---------------------------------------------------------------- data API

  /** One bar per category. */
  setData(data: BarDataPoint[]) {
    this.mode = 'simple'
    this.categories = data.map((d) => String(d.category))
    this.subNames = ['']
    this.matrix = [data.map((d) => +d.value)]
    for (const c of this.categories) this.catColor(c)
    this.syncLegend()
    this.retarget()
    return this
  }

  /** Bars of each category side by side, one per sub category. */
  setDataGrouped(categories: string[], data: BarSubCategoryValues[]) {
    return this.setMulti('grouped', categories, data)
  }

  /** Sub category values stacked on top of each other per category. */
  setDataStacked(categories: string[], data: BarSubCategoryValues[]) {
    return this.setMulti('stacked', categories, data)
  }

  clear() {
    this.categories = []
    this.subNames = []
    this.matrix = []
    this.syncLegend()
    this.retarget()
    return this
  }

  private setMulti(mode: Mode, categories: string[], data: BarSubCategoryValues[]) {
    this.mode = mode
    this.categories = categories.map(String)
    this.subNames = data.map((d) => String(d.subCategory))
    this.matrix = data.map((d) => this.categories.map((_, i) => +(d.values[i] ?? NaN)))
    for (const s of this.subNames) {
      this.subColor(s)
      if (!this.subEntries.has(s)) this.subEntries.set(s, new BarSubCategory(this, s))
    }
    this.syncLegend()
    this.retarget()
    return this
  }

  private syncLegend() {
    this.legend.clear()
    if (this.mode !== 'simple') for (const s of this.subNames) this.legend.add(this.subEntries.get(s)!)
  }

  getCategories() { return [...this.categories] }
  getSubCategories() { return this.subNames.filter(Boolean).map((s) => this.subEntries.get(s)!) }

  // ---------------------------------------------------------------- style / config API

  getType() { return this.type }
  setSorting(s: BarChartSortingMode) { this.sorting = s; this.retarget(); return this }
  getSorting() { return this.sorting }
  setValueLabels(o: BarValueLabelOptions | false) {
    this.labels = o === false ? { ...this.labels, position: 'none' } : { ...this.labels, ...o, position: o.position ?? this.labels.position }
    this.invalidate()
    return this
  }
  getValueLabels() { return { ...this.labels } }
  /** Gap between categories as a fraction of the category slot (0..0.95). */
  setBarsMargin(m: number) { this.margin = clamp(m, 0, 0.95); this.invalidate(); return this }
  getBarsMargin() { return this.margin }
  setBarsEffect(v: boolean) { this.effect = v; this.invalidate(); return this }
  getBarsEffect() { return this.effect ?? this.theme.glow.enabled }
  /** Single color for all bars, a per-bar callback, or undefined for palette colors. */
  setBarsColor(c: Color | ((info: BarInfo) => Color) | undefined) { this.barsColor = c ?? null; this.invalidate(); return this }
  /** Palette for automatic per-category / per-sub-category colors (defaults to the theme's series colors). */
  setPalette(colors: Color[] | undefined) { this.palette = colors?.length ? colors : null; this.invalidate(); return this }
  setCornerRadius(px: number) { this.radius = Math.max(0, px); this.invalidate(); return this }
  getCornerRadius() { return this.radius }
  setAnimationsEnabled(v: boolean) { this.animationsEnabled = v; return this }
  /** Animate value changes. */
  setAnimationValues(v: boolean) { this.animValues = v; return this }
  /** Animate category re-ordering. */
  setAnimationCategoryPosition(v: boolean) { this.animPositions = v; return this }
  setAnimationDuration(ms: number) { this.duration = Math.max(0, ms); return this }
  setAnimationEasing(e: Easing) { this.easing = e; return this }
  setCursorEnabled(v: boolean) { this.cursorEnabled = v; if (!v) this.setHover(null); return this }
  setCursorMode(m: string | undefined) { return this.setCursorEnabled(m !== 'disabled' && m !== undefined) }

  /** @internal */
  invalidate() { this.geomDirty = true; this.requestRender() }
  /** @internal Effective (padded) value interval. */
  valueInterval() { return { start: this.lo, end: this.hi } }

  // ---------------------------------------------------------------- colors

  private paletteAt(i: number) {
    const p = this.palette ?? this.theme.seriesColors
    return p[((i % p.length) + p.length) % p.length]
  }
  private catColor(c: string) {
    let i = this.catColorIdx.get(c)
    if (i === undefined) this.catColorIdx.set(c, (i = this.catColorIdx.size))
    return this.paletteAt(i)
  }
  private subColor(s: string) {
    let i = this.subColorIdx.get(s)
    if (i === undefined) this.subColorIdx.set(s, (i = this.subColorIdx.size))
    return this.paletteAt(i)
  }
  /** @internal */
  subCategoryColor(s: string) {
    const bc = this.barsColor
    if (bc instanceof Color) return bc
    return this.subColor(s)
  }
  private info(it: BarItem, value = it.value): BarInfo {
    return { category: it.category, subCategory: this.mode === 'simple' ? undefined : it.sub, value, stackedSum: it.total }
  }
  private colorOf(it: BarItem): Color {
    const bc = this.barsColor
    if (bc) return typeof bc === 'function' ? bc(this.info(it)) : bc
    return this.mode === 'simple' ? this.catColor(it.category) : this.subColor(it.sub)
  }

  // ---------------------------------------------------------------- transitions

  /** @internal Recompute bar targets from data and start the transition. */
  retarget() {
    const mode = this.mode
    const cats = this.categories
    const subs = this.subNames
    const vis = subs.map((s, si) => ({ s, si })).filter(({ s }) => mode === 'simple' || this.subEntries.get(s)?.visible !== false)
    const totals = cats.map((_, ci) => vis.reduce((acc, { si }) => acc + (Number.isFinite(this.matrix[si][ci]) ? this.matrix[si][ci] : 0), 0))
    const order = cats.map((_, i) => i)
    if (this.sorting === 'ascending') order.sort((a, b) => totals[a] - totals[b] || a - b)
    else if (this.sorting === 'descending') order.sort((a, b) => totals[b] - totals[a] || a - b)
    else if (this.sorting === 'alphabetical') order.sort((a, b) => cats[a].localeCompare(cats[b]) || a - b)
    const slotOf = new Array<number>(cats.length)
    order.forEach((ci, k) => (slotOf[ci] = k))
    const nSlots = cats.length
    const targets = new Map<string, { g: Geom; ci: number; sub: string; value: number }>()
    let dmin = 0, dmax = 0
    cats.forEach((c, ci) => {
      let pos = 0, neg = 0
      vis.forEach(({ s, si }, vi) => {
        const v = this.matrix[si][ci]
        if (!Number.isFinite(v)) return
        let lo = 0, hi = v
        if (mode === 'stacked') {
          if (v >= 0) { lo = pos; hi = pos + v; pos = hi } else { lo = neg; hi = neg + v; neg = hi }
        }
        dmin = Math.min(dmin, lo, hi)
        dmax = Math.max(dmax, lo, hi)
        const g = { slot: slotOf[ci], sub: mode === 'grouped' ? vi : 0, nsub: mode === 'grouped' ? vis.length : 1, lo, hi, alpha: 1 }
        targets.set(c + SEP + s, { g, ci, sub: s, value: v })
      })
    })
    const had = this.items.some((it) => !it.dying)
    const present = new Set(this.items.filter((it) => !it.dying).map((it) => it.category))
    const next: BarItem[] = []
    const seen = new Set<string>()
    for (const it of this.items) {
      const tg = targets.get(it.key)
      it.from = { ...it.cur }
      if (tg) {
        it.to = tg.g
        it.dying = false
        it.value = tg.value
        it.total = totals[tg.ci]
        seen.add(it.key)
      } else {
        const base = mode === 'stacked' ? it.cur.lo : 0
        it.to = { ...it.cur, lo: base, hi: base, alpha: 0, slot: this.sorting !== 'none' ? Math.max(it.cur.slot, nSlots) : it.cur.slot }
        it.dying = true
      }
      next.push(it)
    }
    for (const [key, tg] of targets) {
      if (seen.has(key)) continue
      const category = cats[tg.ci]
      const enter = had && this.sorting !== 'none' && !present.has(category) ? nSlots : tg.g.slot
      const start: Geom = { ...tg.g, slot: enter, hi: tg.g.lo, alpha: had ? 0 : 1 }
      next.push({ key, category, sub: tg.sub, value: tg.value, total: totals[tg.ci], cur: { ...start }, from: start, to: tg.g, dying: false })
    }
    for (const it of next) {
      if (!this.animValues) { it.from.lo = it.to.lo; it.from.hi = it.to.hi }
      if (!this.animPositions) { it.from.slot = it.to.slot; it.from.sub = it.to.sub; it.from.nsub = it.to.nsub }
    }
    if (this.hover && !targets.has(this.hover.key)) this.hover = null
    this.items = next
    this.slots.from = had ? this.slots.cur : nSlots
    this.slots.to = nSlots
    this.iv.to = { lo: dmin, hi: dmax }
    this.iv.from = had ? { ...this.iv.cur } : { ...this.iv.to }
    this.tween?.cancel()
    this.tween = null
    if (this.animationsEnabled && this.duration > 0) this.tween = this.animate(new Tween([0], [1], this.duration, (v) => this.step(v[0]), this.easing))
    else this.step(1)
    this.invalidate()
  }

  private step(k: number) {
    const t = clamp(k, 0, 1)
    for (const it of this.items) it.cur = lerpGeom(it.from, it.to, t)
    this.slots.cur = lerp(this.slots.from, this.slots.to, t)
    this.iv.cur = { lo: lerp(this.iv.from.lo, this.iv.to.lo, t), hi: lerp(this.iv.from.hi, this.iv.to.hi, t) }
    if (k >= 1) this.items = this.items.filter((it) => !it.dying)
    this.geomDirty = true
  }

  // ---------------------------------------------------------------- geometry

  private get vertical() { return this.type === 'vertical' }

  private vpx(v: number) {
    const p = this.plot
    const f = (v - this.lo) / (this.hi - this.lo || 1)
    return this.vertical ? p.y + p.h - f * p.h : p.x + f * p.w
  }
  private pxToV(px: number) {
    const p = this.plot
    const f = this.vertical ? (p.y + p.h - px) / (p.h || 1) : (px - p.x) / (p.w || 1)
    return this.lo + f * (this.hi - this.lo)
  }

  /** Bar rect in CSS px for a geometry state. */
  private barRect(g: Geom): Rect {
    const p = this.plot
    const vert = this.vertical
    const len = vert ? p.w : p.h
    const slot = len / Math.max(1, this.slots.cur)
    const c0 = (vert ? p.x : p.y) + (g.slot + 0.5) * slot
    const group = slot * (1 - this.margin)
    const ns = Math.max(1, g.nsub)
    const bw = group / ns
    const gap = bw * 0.12 * clamp(g.nsub - 1, 0, 1)
    const a = c0 - group / 2 + g.sub * bw + gap / 2
    const th = Math.max(0, bw - gap)
    const p0 = this.vpx(g.lo), p1 = this.vpx(g.hi)
    const v0 = Math.min(p0, p1), v1 = Math.max(p0, p1)
    return vert ? { x: a, y: v0, w: th, h: v1 - v0 } : { x: v0, y: a, w: v1 - v0, h: th }
  }

  private formatLabel(it: BarItem, value: number) {
    const f = this.labels.formatter
    if (!f) return defaultFormat(value)
    const info = this.info(it, value)
    return f(info, info.category, value)
  }
  private labelFont() {
    return this.labels.labelFont ? this.labels.labelFont.toCSS() : font(this.theme, this.theme.fontSize)
  }

  // ---------------------------------------------------------------- layout

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    this.area = area
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs)
    const vert = this.vertical
    const ca = this.categoryAxis, va = this.valueAxis
    const catLabelsOn = ca.visible && ca.labelsVisible
    const valLabelsOn = va.visible && va.labelsVisible
    const catTitle = ca.visible && ca.titleText() ? fs * 1.5 + 2 : 0
    const valTitle = va.visible && va.titleText() ? fs * 1.5 + 2 : 0

    // Category labels follow their bars (max alpha, slot of any bar).
    const cl = new Map<string, { name: string; slot: number; alpha: number }>()
    for (const it of this.items) {
      const e = cl.get(it.category)
      if (!e) cl.set(it.category, { name: it.category, slot: it.cur.slot, alpha: it.cur.alpha })
      else if (it.cur.alpha > e.alpha) e.alpha = it.cur.alpha
    }
    this.catLabels = [...cl.values()]
    this.catMaxW = catLabelsOn ? Math.max(0, ...this.catLabels.map((c) => textWidth(c.name, fnt))) : 0

    // Width of "after-bar" value labels (horizontal padding).
    let labelW = 0
    if (!vert && this.labels.position === 'after-bar') {
      const lf = this.labelFont()
      if (this.mode === 'stacked') {
        const seen = new Set<string>()
        for (const it of this.items) {
          if (it.dying || seen.has(it.category)) continue
          seen.add(it.category)
          labelW = Math.max(labelW, textWidth(this.formatLabel(it, it.total), lf))
        }
      } else {
        for (const it of this.items) if (!it.dying) labelW = Math.max(labelW, textWidth(this.formatLabel(it, it.value), lf))
      }
    }

    const nSlots = Math.max(1, this.slots.cur)
    if (vert) {
      const top = area.y + fs * 0.8
      let catH = catLabelsOn ? TICK + GAP + fs * 1.2 : 4
      let bottom = area.y + area.h - catH - catTitle
      this.computeTicks(Math.max(1, bottom - top), labelW)
      const tickW = valLabelsOn ? Math.max(0, ...va.ticks.filter((k) => k.level === 0).map((k) => textWidth(k.label, fnt))) : 0
      const left = area.x + valTitle + (valLabelsOn ? tickW + GAP * 2 : 4)
      const right = area.x + area.w - fs
      const slotW = Math.max(1, right - left) / nSlots
      this.rotateCats = catLabelsOn && this.catMaxW > slotW * 0.94
      if (this.rotateCats) catH = TICK + GAP + Math.min(this.catMaxW, area.h * 0.3) * 0.72 + fs * 0.8
      bottom = area.y + area.h - catH - catTitle
      this.plot = { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }
      this.computeTicks(this.plot.h, labelW)
    } else {
      this.rotateCats = false
      const catW = catLabelsOn ? Math.min(this.catMaxW, area.w * 0.35) + TICK + GAP : 4
      const valH = valLabelsOn ? TICK + GAP + fs * 1.25 : 4
      const left = area.x + catTitle + catW
      const right = area.x + area.w - fs
      const top = area.y + fs * 0.5
      const bottom = area.y + area.h - valH - valTitle
      this.plot = { x: left, y: top, w: Math.max(1, right - left), h: Math.max(1, bottom - top) }
      this.computeTicks(this.plot.w, labelW)
    }
    const p = this.plot
    const key = `${p.x},${p.y},${p.w},${p.h},${this.lo},${this.hi},${this.slots.cur}`
    if (key !== this.geomKey) {
      this.geomKey = key
      this.geomDirty = true
    }
  }

  private computeTicks(len: number, labelW: number) {
    const va = this.valueAxis
    const t = this.theme
    const fs = t.fontSize
    const vert = this.vertical
    if (va.fixed) {
      this.lo = va.fixed.start
      this.hi = va.fixed.end
    } else {
      let lo = this.iv.cur.lo, hi = this.iv.cur.hi
      if (!(hi > lo)) { lo = 0; hi = 1 }
      const pad = this.labels.position === 'after-bar' ? (vert ? fs * 1.7 : labelW + 12) : fs * 0.4
      const padEnd = hi > 0 ? pad : 0
      const padStart = lo < 0 ? pad : 0
      const usable = Math.max(len * 0.3, len - padEnd - padStart)
      const k = (hi - lo) / usable
      this.lo = lo - padStart * k
      this.hi = hi + padEnd * k
    }
    va.ticks = va.strategy.generate({
      lo: this.lo,
      hi: this.hi,
      length: len,
      horizontal: !vert,
      log: 0,
      measure: (s, level) => textWidth(s, font(t, level === 0 ? fs : fs * 0.85)),
      fontSize: fs,
    })
  }

  // ---------------------------------------------------------------- drawing

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const t = this.theme
    const p = this.plot
    const st = this.valueAxis.strategy
    if (!st.majorGridVisible) return
    ctx.strokeStyle = t.gridMajorColor.toCSS()
    ctx.lineWidth = 1
    ctx.beginPath()
    for (const tk of this.valueAxis.ticks) {
      if (tk.level !== 0) continue
      const q = Math.round(this.vpx(tk.value)) + 0.5
      if (this.vertical) {
        if (q < p.y - 0.5 || q > p.y + p.h + 0.5) continue
        ctx.moveTo(p.x, q)
        ctx.lineTo(p.x + p.w, q)
      } else {
        if (q < p.x - 0.5 || q > p.x + p.w + 0.5) continue
        ctx.moveTo(q, p.y)
        ctx.lineTo(q, p.y + p.h)
      }
    }
    ctx.stroke()
  }

  override hasGL() { return this.items.length > 0 }

  private rebuild() {
    const b = this.batch
    b.clear()
    b.setOrigin(0, 0)
    const dark = this.theme.isDark
    const white = new Color(255, 255, 255)
    const stacked = this.mode === 'stacked'
    for (const it of this.items) {
      const a = it.cur.alpha
      if (a <= 0.003) continue
      const r = this.barRect(it.cur)
      if (stacked) {
        // Hairline gap between stacked segments.
        const vert = this.vertical
        const len = vert ? r.h : r.w
        const g = Math.min(0.75, len / 4)
        if (vert) { r.y += g; r.h -= 2 * g } else { r.x += g; r.w -= 2 * g }
      }
      if (r.w < 0.25 || r.h < 0.25) continue
      let c = this.colorOf(it)
      if (this.hover === it) c = dark ? c.mix(white.setA(c.a), 0.3) : c.scale(0.8)
      b.push(r.x, r.y, r.x + r.w, r.y + r.h, c.setA(c.a * a))
    }
    this.geomDirty = false
  }

  override drawGL(r: GLRenderer) {
    if (this.geomDirty) this.rebuild()
    if (!this.batch.n) return
    const p = this.plot
    r.scissor({ x: p.x, y: p.y - 1, w: p.w, h: p.h + 2 })
    // Large filled areas saturate under full bloom; a low multiplier keeps a soft halo.
    r.glow = this.getBarsEffect() ? 0.22 : 0
    this.batch.draw(r, { mx: ID, my: ID }, { radius: this.radius })
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    this.drawBaseline(ctx)
    this.drawValueAxis(ctx)
    this.drawCategoryLabels(ctx)
    this.drawTitles(ctx)
    this.drawValueLabels(ctx)
    if (this.hover && this.cursorEnabled) this.drawTooltip(ctx, this.hover)
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawBaseline(ctx: CanvasRenderingContext2D) {
    if (!this.items.length || !(this.lo <= 0 && this.hi >= 0)) return
    const p = this.plot
    const q = Math.round(this.vpx(0)) + 0.5
    ctx.strokeStyle = this.theme.axisLineColor.toCSS()
    ctx.lineWidth = 1
    ctx.beginPath()
    if (this.vertical) { ctx.moveTo(p.x, q); ctx.lineTo(p.x + p.w, q) }
    else { ctx.moveTo(q, p.y); ctx.lineTo(q, p.y + p.h) }
    ctx.stroke()
  }

  private drawValueAxis(ctx: CanvasRenderingContext2D) {
    const va = this.valueAxis
    if (!va.visible || !va.labelsVisible) return
    const t = this.theme
    const fs = t.fontSize
    const p = this.plot
    ctx.font = font(t, fs)
    ctx.fillStyle = t.tickLabelColor.toCSS()
    ctx.textBaseline = 'middle'
    for (const tk of va.ticks) {
      if (tk.level !== 0 || !tk.label) continue
      const q = this.vpx(tk.value)
      if (this.vertical) {
        if (q < p.y - 1 || q > p.y + p.h + 1) continue
        ctx.textAlign = 'right'
        ctx.fillText(tk.label, p.x - GAP * 2, q)
      } else {
        if (q < p.x - 1 || q > p.x + p.w + 1) continue
        ctx.textAlign = 'center'
        ctx.fillText(tk.label, q, p.y + p.h + TICK + GAP + fs * 0.55 - 2)
      }
    }
  }

  private drawCategoryLabels(ctx: CanvasRenderingContext2D) {
    const ca = this.categoryAxis
    if (!ca.visible || !ca.labelsVisible || !this.catLabels.length) return
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs)
    const p = this.plot
    const n = Math.max(1, this.slots.cur)
    ctx.save()
    ctx.font = fnt
    ctx.fillStyle = t.tickLabelColor.toCSS()
    if (this.vertical) {
      const slot = p.w / n
      const y = p.y + p.h + TICK + GAP
      const maxW = this.rotateCats ? Math.min(this.catMaxW, this.area.h * 0.3) : slot - 2
      for (const c of this.catLabels) {
        const x = p.x + (c.slot + 0.5) * slot
        if (c.alpha < 0.02 || x < p.x - 1 || x > p.x + p.w + 1) continue
        ctx.globalAlpha = c.alpha
        const text = fitText(c.name, maxW, fnt)
        if (this.rotateCats) {
          ctx.save()
          ctx.translate(x + fs * 0.3, y)
          ctx.rotate(-Math.PI / 4)
          ctx.textAlign = 'right'
          ctx.textBaseline = 'middle'
          ctx.fillText(text, 0, 0)
          ctx.restore()
        } else {
          ctx.textAlign = 'center'
          ctx.textBaseline = 'top'
          ctx.fillText(text, x, y)
        }
      }
    } else {
      ctx.beginPath()
      ctx.rect(this.rect.x, p.y, this.rect.w, p.h)
      ctx.clip()
      const slot = p.h / n
      const x = p.x - TICK - GAP
      const maxW = Math.min(this.catMaxW, this.area.w * 0.35)
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      for (const c of this.catLabels) {
        if (c.alpha < 0.02) continue
        ctx.globalAlpha = c.alpha
        ctx.fillText(fitText(c.name, maxW, fnt), x, p.y + (c.slot + 0.5) * slot)
      }
    }
    ctx.restore()
  }

  private drawTitles(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = t.fontSize
    const p = this.plot
    const a = this.area
    ctx.font = font(t, fs)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const draw = (axis: BarAxis, side: 'left' | 'bottom') => {
      const text = axis.titleText()
      if (!axis.visible || !text) return
      ctx.fillStyle = (axis.titleColor ?? t.axisTitleColor).toCSS()
      if (side === 'bottom') {
        ctx.fillText(text, p.x + p.w / 2, a.y + a.h - fs * 0.7, a.w)
      } else {
        ctx.save()
        ctx.translate(a.x + fs * 0.75, p.y + p.h / 2)
        ctx.rotate(-Math.PI / 2)
        ctx.fillText(text, 0, 0, Math.max(20, p.h))
        ctx.restore()
      }
    }
    draw(this.valueAxis, this.vertical ? 'left' : 'bottom')
    draw(this.categoryAxis, this.vertical ? 'bottom' : 'left')
  }

  private drawValueLabels(ctx: CanvasRenderingContext2D) {
    const pos = this.labels.position
    if (pos === 'none' || !this.items.length) return
    const t = this.theme
    const fnt = this.labelFont()
    const fs = this.labels.labelFont?.size ?? t.fontSize
    const vert = this.vertical
    const stacked = this.mode === 'stacked'
    const outside = (this.labels.labelFillStyle?.getPrimaryColor() ?? t.tickLabelColor).toCSS()
    const p = this.plot
    ctx.save()
    ctx.beginPath()
    if (vert) ctx.rect(p.x, this.rect.y, p.w, this.rect.h)
    else ctx.rect(this.rect.x, p.y, this.rect.w, p.h)
    ctx.clip()
    ctx.font = fnt
    const after = (r: Rect, neg: boolean, text: string) => {
      if (vert) {
        ctx.textAlign = 'center'
        ctx.textBaseline = neg ? 'top' : 'bottom'
        ctx.fillText(text, r.x + r.w / 2, neg ? r.y + r.h + 3 : r.y - 3)
      } else {
        ctx.textAlign = neg ? 'right' : 'left'
        ctx.textBaseline = 'middle'
        ctx.fillText(text, neg ? r.x - 5 : r.x + r.w + 5, r.y + r.h / 2)
      }
    }
    if (!(stacked && pos === 'after-bar')) {
      for (const it of this.items) {
        const a = it.cur.alpha
        if (a < 0.02) continue
        const r = this.barRect(it.cur)
        const v = it.cur.hi - it.cur.lo
        const neg = it.cur.hi < it.cur.lo
        const text = this.formatLabel(it, v)
        const tw = textWidth(text, fnt)
        const along = vert ? r.h : r.w
        const across = vert ? r.w : r.h
        let inside = pos === 'inside-bar'
        if (inside && (along < (vert ? fs + 6 : tw + 10) || across < (vert ? tw + 4 : fs + 1))) {
          if (stacked) continue
          inside = false
        }
        ctx.globalAlpha = a
        if (!inside) {
          ctx.fillStyle = outside
          after(r, neg, text)
          continue
        }
        ctx.fillStyle = (this.labels.labelFillStyle?.getPrimaryColor() ?? contrast(this.colorOf(it))).toCSS()
        if (vert) {
          ctx.textAlign = 'center'
          if (stacked) { ctx.textBaseline = 'middle'; ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2) }
          else { ctx.textBaseline = neg ? 'bottom' : 'top'; ctx.fillText(text, r.x + r.w / 2, neg ? r.y + r.h - 4 : r.y + 4) }
        } else {
          ctx.textBaseline = 'middle'
          if (stacked) { ctx.textAlign = 'center'; ctx.fillText(text, r.x + r.w / 2, r.y + r.h / 2) }
          else { ctx.textAlign = neg ? 'left' : 'right'; ctx.fillText(text, neg ? r.x + 6 : r.x + r.w - 6, r.y + r.h / 2) }
        }
      }
    }
    const sums = stacked && (this.labels.displayStackedSum ?? pos === 'after-bar')
    if (sums) {
      ctx.fillStyle = outside
      const groups = new Map<string, { top: number; bottom: number; sum: number; alpha: number; it: BarItem }>()
      for (const it of this.items) {
        let g = groups.get(it.category)
        if (!g) groups.set(it.category, (g = { top: 0, bottom: 0, sum: 0, alpha: 0, it }))
        g.top = Math.max(g.top, it.cur.lo, it.cur.hi)
        g.bottom = Math.min(g.bottom, it.cur.lo, it.cur.hi)
        g.sum += it.cur.hi - it.cur.lo
        g.alpha = Math.max(g.alpha, it.cur.alpha)
      }
      for (const g of groups.values()) {
        if (g.alpha < 0.02) continue
        const neg = g.sum < 0
        const r = this.barRect({ ...g.it.cur, sub: 0, nsub: 1, lo: 0, hi: neg ? g.bottom : g.top })
        ctx.globalAlpha = g.alpha
        after(r, neg, this.formatLabel(g.it, g.sum))
      }
    }
    ctx.restore()
  }

  private drawTooltip(ctx: CanvasRenderingContext2D, it: BarItem) {
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs)
    const bold = font(t, fs, 600)
    const color = this.colorOf(it).setA(255)
    const fmt = (v: number) => this.formatLabel(it, v)
    const rows: { left: string; right?: string; color?: Color }[] = [{ left: it.category }]
    if (this.mode !== 'simple') rows.push({ left: it.sub, right: fmt(it.value), color })
    else rows.push({ left: this.valueAxis.title || 'Value', right: fmt(it.value) })
    if (this.mode === 'stacked') rows.push({ left: 'Total', right: fmt(it.total) })
    const lh = fs * 1.45
    const pad = 8
    const sw = 14
    let w = textWidth(rows[0].left, bold) + sw
    for (const r of rows.slice(1)) w = Math.max(w, textWidth(r.left, fnt) + (r.right ? textWidth(r.right, fnt) + 16 : 0))
    w += pad * 2
    const h = rows.length * lh + pad * 2 - (lh - fs)
    const br = this.barRect(it.cur)
    const anchor = this.pointer ?? { x: br.x + br.w / 2, y: br.y }
    let x = anchor.x + 14, y = anchor.y - h - 10
    const R = this.rect
    if (x + w > R.x + R.w - 4) x = anchor.x - w - 14
    if (y < R.y + 4) y = anchor.y + 16
    if (y + h > R.y + R.h - 4) y = R.y + R.h - h - 4
    ctx.save()
    roundRect(ctx, x, y, w, h, 5)
    ctx.fillStyle = t.cursor.tableFill.toCSS()
    ctx.fill()
    ctx.strokeStyle = t.cursor.tableStroke.toCSS()
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.textBaseline = 'middle'
    rows.forEach((r, i) => {
      const cy = y + pad + i * lh + fs / 2 + 1
      if (i === 0) {
        drawMarker(ctx, 'square', x + pad + 5, cy, 5, color, false)
        ctx.font = bold
        ctx.fillStyle = t.cursor.textColor.toCSS()
        ctx.textAlign = 'left'
        ctx.fillText(r.left, x + pad + sw, cy)
        return
      }
      ctx.font = fnt
      ctx.textAlign = 'left'
      ctx.fillStyle = (r.color ?? t.cursor.textColor).toCSS()
      ctx.fillText(r.left, x + pad, cy)
      if (r.right) {
        ctx.textAlign = 'right'
        ctx.fillStyle = t.cursor.textColor.toCSS()
        ctx.fillText(r.right, x + w - pad, cy)
      }
    })
    ctx.restore()
  }

  // ---------------------------------------------------------------- interaction

  private hitBar(x: number, y: number): BarItem | null {
    if (!rectContains(this.plot, x, y)) return null
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i]
      if (it.dying || it.cur.alpha < 0.5) continue
      const r = this.barRect(it.cur)
      const grow = this.vertical ? { x: r.x, y: r.y - 2, w: r.w, h: r.h + 4 } : { x: r.x - 2, y: r.y, w: r.w + 4, h: r.h }
      if (rectContains(grow, x, y)) return it
    }
    return null
  }

  private setHover(it: BarItem | null) {
    if (it === this.hover) return
    this.hover = it
    this.invalidate()
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') return this.legend.onPointer('click', x, y)
    if (e.type === 'move' && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      this.setHover(null)
      return true
    }
    if (e.type === 'down') return this.legend.contains(x, y)
    if (e.type === 'move') {
      this.pointer = { x, y }
      const hit = this.cursorEnabled ? this.hitBar(x, y) : null
      this.setHover(hit)
      this.surface.setCursor(hit ? 'pointer' : 'default')
      return !!hit || this.hover !== null
    }
    if (e.type === 'leave') {
      this.pointer = null
      const had = !!this.hover
      this.setHover(null)
      return had
    }
    return false
  }

  /** Value at a pointer position along the value axis (CSS px relative to the surface). */
  translateValue(px: number) { return this.pxToV(px) }

  override disposeGL(r: GLRenderer | null) { this.batch.dispose(r) }
}

function fitText(s: string, maxW: number, fnt: string): string {
  if (textWidth(s, fnt) <= maxW) return s
  let lo = 0, hi = s.length
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (textWidth(s.slice(0, m) + '…', fnt) <= maxW) lo = m
    else hi = m - 1
  }
  return lo > 0 ? s.slice(0, lo) + '…' : ''
}

function contrast(c: Color): Color {
  const lum = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b
  return lum > 150 ? new Color(16, 16, 16, 230) : new Color(255, 255, 255, 240)
}
