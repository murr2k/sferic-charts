import { Color } from '../../core/color'
import { LegendSymbol, LegendTarget } from '../../core/Legend'
import { Emitter, Rect } from '../../core/util'
import { GLRenderer } from '../../render/GLRenderer'
import { XYMaps } from '../../render/draw'
import { Bounds, XYStore, Chunk, BLOCK } from '../store'
import type { Axis } from '../Axis'
import type { ChartXY } from '../ChartXY'

export interface CursorHit {
  series: SeriesXY
  x: number
  y: number
  /** CSS px of the snapped point. */
  px: number
  py: number
  color: Color
  /** Squared screen distance from the pointer. */
  dist2: number
  /** Extra values for result tables. */
  extra?: Record<string, number | string>
}

export type ResultTableRows = (string | { text: string; color?: Color })[][]

/** Base class of all ChartXY series. */
export abstract class SeriesXY extends Emitter implements LegendTarget {
  readonly chart: ChartXY
  readonly axisX: Axis
  readonly axisY: Axis
  protected name: string
  protected visible = true
  cursorEnabled = true
  effect: boolean | null = null
  readonly colorIndex: number
  autoScroll = true
  /** Fit axes exactly to this series' extent (no fit margin), e.g. heatmaps. */
  fitTight = false
  highlight = 0
  resultTableFormatter: ((builder: TableBuilder, series: SeriesXY, x: number, y: number, hit: CursorHit) => TableBuilder) | null = null
  protected disposed = false

  constructor(chart: ChartXY, axisX: Axis, axisY: Axis, colorIndex: number, name: string) {
    super()
    this.chart = chart
    this.axisX = axisX
    this.axisY = axisY
    this.colorIndex = colorIndex
    this.name = name
  }

  setName(n: string) { this.name = n; this.chart.requestRender(); return this }
  getName() { return this.name }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.chart.requestRender()
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  setEffect(v: boolean) { this.effect = v; this.chart.requestRender(); return this }
  getEffect() { return this.effect ?? this.chart.getTheme().glow.enabled }
  setCursorEnabled(v: boolean) { this.cursorEnabled = v; return this }
  getCursorEnabled() { return this.cursorEnabled }
  setAutoScrollingEnabled(v: boolean) { this.autoScroll = v; return this }
  setHighlight(v: boolean | number) { this.highlight = typeof v === 'number' ? v : v ? 1 : 0; this.chart.requestRender(); return this }
  setHighlightOnHover(_v: boolean) { return this }
  setCursorInterpolationEnabled(_v: boolean) { return this }
  setCursorResultTableFormatter(f: (builder: TableBuilder, series: any, x: number, y: number, hit: any) => TableBuilder) {
    this.resultTableFormatter = f
    return this
  }
  /** @internal Fire a pointer event on this series (from the chart's hit testing). */
  dispatch(type: string, ev: unknown) { this.emit(type, ev) }
  /** @internal */
  hasListener(type: string) { return this.hasListeners(type) }

  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.chart.removeSeries(this)
    return this
  }
  isDisposed() { return this.disposed }

  /** Data extent for axis fitting; null when empty. */
  abstract bounds(): Bounds | null
  /** Y-extent of data within [x0, x1] (for fitting Y to visible X). */
  yBoundsInX(_x0: number, _x1: number): Bounds | null { return this.bounds() }
  abstract drawGL(r: GLRenderer, maps: XYMaps, rect: Rect): void
  /** Optional 2D overlay (labels). */
  drawOverlay(_ctx: CanvasRenderingContext2D, _rect: Rect): void {}
  /** Nearest data point to pointer. byX: only X distance matters (progressive data). */
  abstract nearest(px: number, py: number, byX: boolean): CursorHit | null
  /** Value(s) at an X coordinate for 'show-all' cursors. */
  valueAtX(x: number): CursorHit | null { return this.nearest(this.axisX.valueToPx(x), NaN, true) }
  abstract getLegendSymbol(): LegendSymbol
  abstract primaryColor(): Color
  disposeGL(_r: GLRenderer | null): void {}
  /** Upload pending data before the frame's draws (see Drawable.prepareGL). */
  prepareGL(_r: GLRenderer): void {}

  /** Default result table rows. */
  tableRows(hit: CursorHit): ResultTableRows {
    if (this.resultTableFormatter) {
      const b = this.resultTableFormatter(new TableBuilder(), this, hit.x, hit.y, hit)
      return b.rows
    }
    const rows: ResultTableRows = [[{ text: this.name, color: hit.color }]]
    rows.push([(this.axisX.title || 'X') + ':', this.axisX.formatCursor(hit.x)])
    rows.push([(this.axisY.title || 'Y') + ':', this.axisY.formatCursor(hit.y)])
    if (hit.extra) for (const [k, v] of Object.entries(hit.extra)) rows.push([k + ':', typeof v === 'number' ? this.axisY.formatCursor(v) : v])
    return rows
  }
}

/** Result table builder. */
export class TableBuilder {
  rows: ResultTableRows = []
  addRow(...cells: (string | number | undefined)[]) {
    this.rows.push(cells.filter((c) => c !== undefined).map((c) => String(c)))
    return this
  }
}

// ------------------------------------------------------------------ nearest-point helpers over XYStore

/** Nearest real point by X for monotonic stores. */
export function nearestByX(store: XYStore, xv: number): { ch: Chunk; j: number } | null {
  let best: { ch: Chunk; j: number } | null = null
  let bd = Infinity
  for (let ci = 0; ci < store.chunks.length; ci++) {
    const ch = store.chunks[ci]
    const s = store.pointStart(ci)
    if (ch.n <= s) continue
    const lo = ch.x(s), hi = ch.x(ch.n - 1)
    if (xv < lo - bd || xv > hi + bd) continue
    const i = store.lower(ch, s, ch.n, xv)
    for (const j of [i - 1, i]) {
      if (j < s || j >= ch.n) continue
      const d = Math.abs(ch.x(j) - xv)
      if (d < bd && Number.isFinite(ch.y(j))) {
        bd = d
        best = { ch, j }
      }
    }
  }
  return best
}

/** Nearest real point in screen space, pruning blocks by their bounds. */
export function nearestByXY(
  store: XYStore,
  px: number,
  py: number,
  toPx: (x: number) => number,
  toPy: (y: number) => number,
  maxDist = Infinity,
): { ch: Chunk; j: number; d2: number } | null {
  let best: { ch: Chunk; j: number; d2: number } | null = null
  let bd = maxDist * maxDist
  for (let ci = 0; ci < store.chunks.length; ci++) {
    const ch = store.chunks[ci]
    const s = store.pointStart(ci)
    const nb = Math.ceil(ch.n / BLOCK)
    for (let b = 0; b < nb; b++) {
      const k = b * 4
      const bl = ch.blocks
      if (!(bl[k] <= bl[k + 1])) continue
      const ax = toPx(bl[k]), bx = toPx(bl[k + 1])
      const ay = toPy(bl[k + 2]), by = toPy(bl[k + 3])
      const dx = Math.max(Math.min(ax, bx) - px, 0, px - Math.max(ax, bx))
      const dy = Math.max(Math.min(ay, by) - py, 0, py - Math.max(ay, by))
      if (dx * dx + dy * dy > bd) continue
      const j0 = Math.max(s, b * BLOCK), j1 = Math.min(ch.n, (b + 1) * BLOCK)
      for (let j = j0; j < j1; j++) {
        const qx = toPx(ch.x(j)) - px
        const qy = toPy(ch.y(j)) - py
        const d2 = qx * qx + qy * qy
        if (d2 < bd) {
          bd = d2
          best = { ch, j, d2 }
        }
      }
    }
  }
  return best
}
