import { Color, ColorRGBA, isColor } from '../core/color'
import { FontSettings, Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, Fill, fillToCanvas, LineStyle, Mutator, PalettedFill, resolve, SolidFill, SolidLine } from '../core/style'
import { Rect, rectContains, roundRect, textWidth } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { SegmentBatch } from '../render/draw'
import type { PointerInfo, Surface } from '../render/Surface'
import { fitText } from '../hierarchy/common'

export interface DataGridOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

export type CellAlignment = 'left' | 'center' | 'right'

/** Rich cell content. */
export interface CellObject {
  text?: string
  /** Numeric value: formatted when `text` is absent, drives PalettedFill backgrounds and change flashes. */
  value?: number
  fill?: Fill | Color
  textColor?: Fill | Color
  font?: FontSettings
  align?: CellAlignment
  /** Tiny line chart drawn in the cell (GPU, with glow). */
  sparkline?: number[]
  sparklineColor?: Color
  /** Bar-in-cell value in [barMin, barMax] (default 0..100). */
  bar?: number
  barMin?: number
  barMax?: number
  barColor?: Color
}

export type CellContent = string | number | null | undefined | CellObject

interface Cell {
  content: CellContent
  obj: CellObject | null
  num: number
  bg?: Fill
  fg?: Color
  font?: FontSettings
  align?: CellAlignment
  flash0: number
  flashUp: boolean
}

interface Style { bg?: Fill; fg?: Color; font?: FontSettings; align?: CellAlignment }

type Drag = { axis: 'x' | 'y'; start: number; scroll0: number } | null

const toFill = (f: Fill | Color | undefined): Fill | undefined => (f === undefined ? undefined : isColor(f) ? new SolidFill({ color: f }) : f)
const fillColor = (f: Fill | Color | undefined): Color | undefined => (f === undefined ? undefined : isColor(f) ? f : f.getPrimaryColor())

const numFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const numFmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
/** Default number formatting: thousands separators, 2 decimals for fractional values, 4 significant digits below 1. */
export function formatCellNumber(v: number): string {
  if (!Number.isFinite(v)) return String(v)
  if (Number.isInteger(v)) return numFmt.format(v)
  const a = Math.abs(v)
  if (a >= 1) return numFmt2.format(v)
  return Number(v.toPrecision(4)).toString()
}

/**
 * Canvas-rendered data grid. Only visible rows are drawn, so
 * tables with many thousands of rows scroll smoothly. Sparkline cells are GPU line segments
 * with glow; numeric changes flash green (up) or red (down).
 */
export class DataGrid extends Panel {
  private cells: (Cell | undefined)[][] = []
  private nCols = 0
  private headerRows = 1
  private defRowH: number
  private rowH = new Map<number, number>()
  private colWOverride = new Map<number, number | { min?: number; max?: number }>()
  private autoW: number[] = []
  private widthsDirty = true
  private stretch = true
  private rowStyle = new Map<number, Style>()
  private colStyle = new Map<number, Style>()
  private allStyle: Style = {}
  private colFmt = new Map<number, (v: number) => string>()
  private allFmt: (v: number) => string = formatCellNumber
  private border: LineStyle
  private cellPad = 8
  private flashEnabled = true
  private flashDur = 900
  private flashUntil = 0
  private sparkCount = 0
  private alternate = true
  // layout
  private grid: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private head: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private body: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private colX: number[] = [0]
  private prefix = new Float64Array(1)
  private prefixDirty = true
  private scrollX = 0
  private scrollY = 0
  private maxScrollX = 0
  private maxScrollY = 0
  private contentH = 0
  private contentW = 0
  // interaction
  private hoverRow = -1
  private hoverBar: 'x' | 'y' | null = null
  private drag: Drag = null
  // GPU sparklines
  private sparkBody = new SegmentBatch()
  private sparkHead = new SegmentBatch()

  constructor(o: DataGridOptions = {}) {
    super(o)
    this.defRowH = Math.round(this.theme.fontSize * 2.1)
    this.border = new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.gridMajorColor }) })
  }

  // ---------------------------------------------------------------- content

  private makeCell(c: CellContent, prev?: Cell): Cell {
    const obj = c !== null && typeof c === 'object' ? c : null
    const num = typeof c === 'number' ? c : obj && typeof obj.value === 'number' ? obj.value : typeof c === 'string' && c.trim() !== '' && !isNaN(Number(c)) ? Number(c) : NaN
    if (obj?.sparkline) this.sparkCount++
    const cell: Cell = { content: c, obj, num, flash0: 0, flashUp: false }
    if (prev) {
      cell.bg = prev.bg
      cell.fg = prev.fg
      cell.font = prev.font
      cell.align = prev.align
      cell.flash0 = prev.flash0
      cell.flashUp = prev.flashUp
      if (prev.obj?.sparkline) this.sparkCount--
    }
    return cell
  }

  /** Replace all content: an array of rows, each an array of cells (strings, numbers or cell objects). */
  setTableContent(rows: CellContent[][]) {
    this.cells = []
    this.sparkCount = 0
    this.nCols = 0
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] ?? []
      this.cells.push(row.map((c) => this.makeCell(c)))
      if (row.length > this.nCols) this.nCols = row.length
    }
    this.autoW = []
    this.widthsDirty = true
    this.prefixDirty = true
    this.requestRender()
    return this
  }
  getTableContent(): CellContent[][] { return this.cells.map((r) => r.map((c) => c?.content)) }

  /** Set one cell; numeric changes flash green (up) or red (down). */
  setCellContent(column: number, row: number, content: CellContent) {
    if (column < 0 || row < 0) return this
    while (this.cells.length <= row) {
      this.cells.push([])
      this.prefixDirty = true
    }
    const r = this.cells[row]
    const prev = r[column]
    const cell = this.makeCell(content, prev)
    r[column] = cell
    if (column + 1 > this.nCols) this.nCols = column + 1
    if (this.flashEnabled && prev && Number.isFinite(prev.num) && Number.isFinite(cell.num) && prev.num !== cell.num && row >= this.headerRows) {
      cell.flash0 = performance.now()
      cell.flashUp = cell.num > prev.num
      this.flashUntil = cell.flash0 + this.flashDur
    }
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  getCellContent(column: number, row: number): CellContent { return this.cells[row]?.[column]?.content }
  setRowContent(row: number, content: CellContent[]) {
    content.forEach((c, i) => this.setCellContent(i, row, c))
    return this
  }
  setColumnContent(column: number, content: CellContent[]) {
    content.forEach((c, i) => this.setCellContent(column, i, c))
    return this
  }
  /** Remove `count` rows starting at `row`. */
  removeRows(row: number, count = 1) {
    this.cells.splice(row, count)
    this.prefixDirty = true
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  /** Remove all content. */
  removeCells() { return this.setTableContent([]) }
  getRowCount() { return this.cells.length }
  getColumnCount() { return this.nCols }

  // ---------------------------------------------------------------- sizing

  /** Fixed width in px, or `{ min, max }` limits for the automatic width. */
  setColumnWidth(column: number, width: number | { min?: number; max?: number }) {
    this.colWOverride.set(column, width)
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  setRowHeight(row: number, height: number) {
    this.rowH.set(row, Math.max(4, height))
    this.prefixDirty = true
    this.requestRender()
    return this
  }
  /** Default row height in px. */
  setDefaultRowHeight(height: number) {
    this.defRowH = Math.max(4, height)
    this.prefixDirty = true
    this.requestRender()
    return this
  }
  /** Number of leading rows styled as sticky headers (default 1). */
  setHeaderRowCount(n: number) {
    this.headerRows = Math.max(0, Math.floor(n))
    this.prefixDirty = true
    this.requestRender()
    return this
  }
  /** Stretch columns to fill the width when the table is narrower (default true). */
  setStretchColumns(v: boolean) { this.stretch = v; this.requestRender(); return this }
  setCellPadding(px: number) { this.cellPad = Math.max(0, px); this.widthsDirty = true; this.requestRender(); return this }

  // ---------------------------------------------------------------- styling

  private cellAt(column: number, row: number): Cell {
    while (this.cells.length <= row) {
      this.cells.push([])
      this.prefixDirty = true
    }
    let c = this.cells[row][column]
    if (!c) {
      c = this.makeCell(undefined)
      this.cells[row][column] = c
      if (column + 1 > this.nCols) this.nCols = column + 1
    }
    return c
  }
  private styleOf(map: Map<number, Style>, i: number) {
    let s = map.get(i)
    if (!s) map.set(i, (s = {}))
    return s
  }

  /** Background of every cell (default: theme, alternating rows). A PalettedFill colors cells by their numeric value. */
  setCellsBackgroundFillStyle(fill: Fill | Color) { this.allStyle.bg = toFill(fill); this.requestRender(); return this }
  setCellBackgroundFillStyle(column: number, row: number, fill: Fill | Color | undefined) {
    this.cellAt(column, row).bg = toFill(fill)
    this.requestRender()
    return this
  }
  setRowBackgroundFillStyle(row: number, fill: Fill | Color | undefined) { this.styleOf(this.rowStyle, row).bg = toFill(fill); this.requestRender(); return this }
  setColumnBackgroundFillStyle(column: number, fill: Fill | Color | undefined) { this.styleOf(this.colStyle, column).bg = toFill(fill); this.requestRender(); return this }

  setCellsTextFillStyle(fill: Fill | Color) { this.allStyle.fg = fillColor(fill); this.requestRender(); return this }
  setCellTextFillStyle(column: number, row: number, fill: Fill | Color | undefined) {
    this.cellAt(column, row).fg = fillColor(fill)
    this.requestRender()
    return this
  }
  setRowTextFillStyle(row: number, fill: Fill | Color | undefined) { this.styleOf(this.rowStyle, row).fg = fillColor(fill); this.requestRender(); return this }
  setColumnTextFillStyle(column: number, fill: Fill | Color | undefined) { this.styleOf(this.colStyle, column).fg = fillColor(fill); this.requestRender(); return this }

  private baseFont() { return new FontSettings(this.theme.fontSize, 'normal', this.theme.fontFamily) }
  setCellsTextFont(f: Mutator<FontSettings>) { this.allStyle.font = resolve(this.allStyle.font ?? this.baseFont(), f); this.widthsDirty = true; this.requestRender(); return this }
  setCellTextFont(column: number, row: number, f: Mutator<FontSettings>) {
    const c = this.cellAt(column, row)
    c.font = resolve(c.font ?? this.allStyle.font ?? this.baseFont(), f)
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  setRowTextFont(row: number, f: Mutator<FontSettings>) {
    const s = this.styleOf(this.rowStyle, row)
    s.font = resolve(s.font ?? this.baseFont(), f)
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  setColumnTextFont(column: number, f: Mutator<FontSettings>) {
    const s = this.styleOf(this.colStyle, column)
    s.font = resolve(s.font ?? this.baseFont(), f)
    this.widthsDirty = true
    this.requestRender()
    return this
  }

  setCellContentAlignment(column: number, row: number, align: CellAlignment) { this.cellAt(column, row).align = align; this.requestRender(); return this }
  setColumnContentAlignment(column: number, align: CellAlignment) { this.styleOf(this.colStyle, column).align = align; this.requestRender(); return this }
  setRowContentAlignment(row: number, align: CellAlignment) { this.styleOf(this.rowStyle, row).align = align; this.requestRender(); return this }

  /** Number formatting for a column. */
  setColumnFormatter(column: number, fmt: ((v: number) => string) | null) {
    if (fmt) this.colFmt.set(column, fmt)
    else this.colFmt.delete(column)
    this.widthsDirty = true
    this.requestRender()
    return this
  }
  /** Number formatting for all cells (default: thousands separators, 2 decimals). */
  setCellsFormatter(fmt: (v: number) => string) { this.allFmt = fmt; this.widthsDirty = true; this.requestRender(); return this }
  /** Grid line style between cells (`emptyLine` hides them). */
  setCellBorderStrokeStyle(l: Mutator<LineStyle>) { this.border = resolve(this.border, l); this.requestRender(); return this }
  /** Alternating row shading from the theme (default true). */
  setAlternatingRowFill(v: boolean) { this.alternate = v; this.requestRender(); return this }
  /** Flash highlight when a numeric cell value changes (default true). */
  setCellChangeHighlight(enabled: boolean, durationMs = this.flashDur) { this.flashEnabled = enabled; this.flashDur = durationMs; return this }

  /** Scroll so that `row` is visible. */
  scrollToRow(row: number) {
    this.ensurePrefix()
    const b = Math.max(0, row - this.headerRows)
    this.scrollY = Math.min(this.prefix[Math.min(b, this.prefix.length - 1)], this.maxScrollY || Infinity)
    this.requestRender()
    return this
  }

  // ---------------------------------------------------------------- resolution helpers

  private textOf(cell: Cell | undefined, col: number): string {
    if (!cell) return ''
    const c = cell.content
    if (c === null || c === undefined) return ''
    if (typeof c === 'string') return c
    if (typeof c === 'number') return (this.colFmt.get(col) ?? this.allFmt)(c)
    if (c.text !== undefined) return c.text
    if (c.sparkline) return ''
    if (typeof c.value === 'number') return (this.colFmt.get(col) ?? this.allFmt)(c.value)
    if (typeof c.bar === 'number') return (this.colFmt.get(col) ?? this.allFmt)(c.bar)
    return ''
  }
  private fontOf(cell: Cell | undefined, col: number, row: number): FontSettings {
    const f = cell?.font ?? cell?.obj?.font ?? this.rowStyle.get(row)?.font ?? this.colStyle.get(col)?.font ?? this.allStyle.font
    if (f) return f
    return row < this.headerRows ? this.baseFont().setWeight(600) : this.baseFont()
  }
  private alignOf(cell: Cell | undefined, col: number, row: number): CellAlignment {
    const a = cell?.align ?? cell?.obj?.align ?? this.rowStyle.get(row)?.align ?? this.colStyle.get(col)?.align
    if (a) return a
    if (row < this.headerRows) {
      const first = this.cells[this.headerRows]?.[col]
      return first && Number.isFinite(first.num) && !first.obj?.sparkline ? 'right' : first?.obj?.sparkline || first?.obj?.bar !== undefined ? 'center' : 'left'
    }
    return cell && Number.isFinite(cell.num) ? 'right' : 'left'
  }
  private bgOf(cell: Cell | undefined, col: number, row: number): Color | null {
    const f = cell?.bg ?? toFill(cell?.obj?.fill) ?? this.rowStyle.get(row)?.bg ?? this.colStyle.get(col)?.bg ?? (row >= this.headerRows ? this.allStyle.bg : undefined)
    if (!f) return null
    if (f instanceof PalettedFill) return cell && Number.isFinite(cell.num) ? f.lut.getColor(cell.num) : null
    if (f.type === 'empty') return null
    return f.getPrimaryColor()
  }
  private fgOf(cell: Cell | undefined, col: number, row: number, bg: Color | null): Color {
    const c = cell?.fg ?? fillColor(cell?.obj?.textColor) ?? this.rowStyle.get(row)?.fg ?? this.colStyle.get(col)?.fg ?? (row >= this.headerRows ? this.allStyle.fg : undefined)
    if (c) return c
    if (row < this.headerRows) return this.theme.axisTitleColor
    if (bg && bg.a > 140) {
      const l = (0.2126 * bg.r + 0.7152 * bg.g + 0.0722 * bg.b) / 255
      return l > 0.56 ? ColorRGBA(20, 20, 20) : ColorRGBA(248, 248, 246)
    }
    return this.theme.tickLabelColor
  }

  // ---------------------------------------------------------------- layout

  private ensurePrefix() {
    if (!this.prefixDirty) return
    const nb = Math.max(0, this.cells.length - this.headerRows)
    const p = new Float64Array(nb + 1)
    for (let i = 0; i < nb; i++) p[i + 1] = p[i] + (this.rowH.get(i + this.headerRows) ?? this.defRowH)
    this.prefix = p
    this.prefixDirty = false
  }

  private computeWidths() {
    const pad = this.cellPad
    const n = this.nCols
    const sample: number[] = []
    const nr = this.cells.length
    for (let r = 0; r < Math.min(nr, 400); r++) sample.push(r)
    for (let r = Math.max(400, nr - 50); r < nr; r++) sample.push(r)
    const w = new Array(n).fill(40)
    for (const r of sample) {
      const row = this.cells[r]
      for (let c = 0; c < row.length; c++) {
        const cell = row[c]
        if (!cell) continue
        let cw = 0
        if (cell.obj?.sparkline) cw = 110
        else {
          const t = this.textOf(cell, c)
          if (t) cw = textWidth(t, this.fontOf(cell, c, r).toCSS())
          if (cell.obj?.bar !== undefined) cw = Math.max(cw, 90)
        }
        if (cw + pad * 2 > w[c]) w[c] = cw + pad * 2
      }
    }
    for (let c = 0; c < n; c++) {
      const o = this.colWOverride.get(c)
      const prev = this.autoW[c] ?? 0
      let v = Math.ceil(Math.max(w[c], prev))
      if (typeof o === 'number') v = o
      else if (o) v = Math.min(o.max ?? Infinity, Math.max(o.min ?? 0, v))
      else v = Math.min(v, 480)
      w[c] = v
    }
    this.autoW = w
    this.widthsDirty = false
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const g = this.layoutBase()
    this.grid = g
    this.ensurePrefix()
    if (this.widthsDirty) this.computeWidths()
    let headH = 0
    for (let r = 0; r < Math.min(this.headerRows, this.cells.length); r++) headH += this.rowH.get(r) ?? this.defRowH
    headH = Math.min(headH, g.h)
    this.head = { x: g.x, y: g.y, w: g.w, h: headH }
    this.body = { x: g.x, y: g.y + headH, w: g.w, h: Math.max(0, g.h - headH) }
    this.contentH = this.prefix[this.prefix.length - 1]
    const needV = this.contentH > this.body.h + 0.5
    const avail = g.w - (needV ? 12 : 0)
    const ws = this.autoW.slice(0, this.nCols)
    let total = ws.reduce((a, b) => a + b, 0)
    if (this.stretch && total > 0 && total < avail) {
      const k = avail / total
      for (let i = 0; i < ws.length; i++) ws[i] *= k
      total = avail
    }
    this.colX = [0]
    for (const w of ws) this.colX.push(this.colX[this.colX.length - 1] + w)
    this.contentW = total
    this.maxScrollY = Math.max(0, this.contentH - this.body.h)
    this.maxScrollX = Math.max(0, total - avail)
    this.scrollY = Math.min(Math.max(0, this.scrollY), this.maxScrollY)
    this.scrollX = Math.min(Math.max(0, this.scrollX), this.maxScrollX)
  }

  /** Visible body row range [r0, r1) as body indices. */
  private visibleBody(): [number, number] {
    const p = this.prefix
    const nb = p.length - 1
    let lo = 0, hi = nb
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (p[m + 1] <= this.scrollY) lo = m + 1
      else hi = m
    }
    let r1 = lo
    while (r1 < nb && p[r1] < this.scrollY + this.body.h) r1++
    return [lo, r1]
  }

  private visibleCols(): [number, number] {
    let c0 = 0
    while (c0 < this.nCols && this.colX[c0 + 1] <= this.scrollX) c0++
    let c1 = c0
    while (c1 < this.nCols && this.colX[c1] < this.scrollX + this.grid.w) c1++
    return [c0, c1]
  }

  // ---------------------------------------------------------------- drawing

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const t = this.theme
    const now = performance.now()
    this.sparkBody.clear()
    this.sparkHead.clear()
    const [c0, c1] = this.visibleCols()
    const gx = this.grid.x - this.scrollX
    // body
    if (this.body.h > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(this.body.x, this.body.y, this.body.w, this.body.h)
      ctx.clip()
      const [r0, r1] = this.visibleBody()
      const altFill = t.isDark ? 'rgba(255,255,255,0.028)' : 'rgba(0,0,0,0.028)'
      for (let b = r0; b < r1; b++) {
        const row = b + this.headerRows
        const y = this.body.y + this.prefix[b] - this.scrollY
        const h = this.prefix[b + 1] - this.prefix[b]
        if (this.alternate && b % 2 === 1) {
          ctx.fillStyle = altFill
          ctx.fillRect(this.grid.x, y, this.grid.w, h)
        }
        this.drawRow(ctx, row, y, h, c0, c1, gx, now, this.sparkBody)
        if (row === this.hoverRow) {
          ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.045)'
          ctx.fillRect(this.grid.x, y, this.grid.w, h)
        }
      }
      this.drawLines(ctx, r0, r1, c0, c1, gx)
      ctx.restore()
    }
    // header rows (sticky)
    if (this.head.h > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(this.head.x, this.head.y, this.head.w, this.head.h)
      ctx.clip()
      ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.075)' : 'rgba(0,0,0,0.055)'
      ctx.fillRect(this.head.x, this.head.y, this.head.w, this.head.h)
      let y = this.head.y
      for (let r = 0; r < this.headerRows && r < this.cells.length; r++) {
        const h = this.rowH.get(r) ?? this.defRowH
        this.drawRow(ctx, r, y, h, c0, c1, gx, now, this.sparkHead)
        y += h
      }
      // vertical separators in the header
      if (applyLineToCanvas(ctx, this.border)) {
        ctx.beginPath()
        for (let c = c0 + 1; c < c1; c++) {
          const x = Math.round(gx + this.colX[c]) + 0.5
          ctx.moveTo(x, this.head.y + 4)
          ctx.lineTo(x, this.head.y + this.head.h - 4)
        }
        ctx.stroke()
      }
      ctx.restore()
      ctx.fillStyle = t.axisTitleColor.setA(t.isDark ? 150 : 110).toCSS()
      ctx.fillRect(this.grid.x, this.head.y + this.head.h - 1, Math.min(this.grid.w, this.contentW - this.scrollX), 1)
    }
  }

  private drawRow(ctx: CanvasRenderingContext2D, row: number, y: number, h: number, c0: number, c1: number, gx: number, now: number, sparks: SegmentBatch) {
    const cells = this.cells[row]
    if (!cells) return
    const pad = this.cellPad
    const t = this.theme
    for (let c = c0; c < c1; c++) {
      const cell = cells[c]
      const x = gx + this.colX[c]
      const w = this.colX[c + 1] - this.colX[c]
      const bg = this.bgOf(cell, c, row)
      if (bg) {
        ctx.fillStyle = bg.toCSS()
        ctx.fillRect(x, y, w, h)
      }
      if (!cell) continue
      if (cell.flash0 > 0) {
        const age = (now - cell.flash0) / this.flashDur
        if (age < 1) {
          const a = (this.theme.isDark ? 0.55 : 0.4) * Math.pow(1 - age, 1.6)
          ctx.fillStyle = cell.flashUp ? `rgba(40,200,95,${a})` : `rgba(235,55,55,${a})`
          ctx.fillRect(x, y, w, h)
        } else cell.flash0 = 0
      }
      const obj = cell.obj
      if (obj?.bar !== undefined && Number.isFinite(obj.bar)) {
        const lo = obj.barMin ?? 0, hi = obj.barMax ?? 100
        const f = Math.max(0, Math.min(1, (obj.bar - lo) / (hi - lo || 1)))
        const bh = Math.max(4, h * 0.56)
        const bw = (w - pad * 2) * f
        if (bw > 0.5) {
          const col = obj.barColor ?? t.seriesColors[0]
          roundRect(ctx, x + pad, y + (h - bh) / 2, bw, bh, 2)
          ctx.fillStyle = col.setA(t.isDark ? 150 : 120).toCSS()
          ctx.fill()
        }
      }
      if (obj?.sparkline && obj.sparkline.length > 1) {
        this.drawSparkArea(ctx, obj.sparkline, x + pad, y + 4, w - pad * 2, h - 8, obj.sparklineColor ?? t.seriesColors[0], sparks)
      }
      const text = this.textOf(cell, c)
      if (!text) continue
      const fs = this.fontOf(cell, c, row)
      const fnt = fs.toCSS()
      const fitted = fitText(text, w - pad * 2, fnt)
      if (!fitted) continue
      ctx.font = fnt
      ctx.fillStyle = this.fgOf(cell, c, row, bg).toCSS()
      ctx.textBaseline = 'middle'
      const al = this.alignOf(cell, c, row)
      ctx.textAlign = al
      const tx = al === 'left' ? x + pad : al === 'right' ? x + w - pad : x + w / 2
      ctx.fillText(fitted, tx, y + h / 2 + 0.5)
    }
  }

  private drawSparkArea(ctx: CanvasRenderingContext2D, d: number[], x: number, y: number, w: number, h: number, color: Color, sparks: SegmentBatch) {
    let lo = Infinity, hi = -Infinity
    for (const v of d) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!(hi > lo)) {
      lo -= 1
      hi += 1
    }
    const n = d.length
    const px = (i: number) => x + (i / (n - 1)) * w
    const py = (v: number) => y + h - ((v - lo) / (hi - lo)) * h
    const grad = ctx.createLinearGradient(0, y, 0, y + h)
    grad.addColorStop(0, color.setA(this.theme.isDark ? 90 : 70).toCSS())
    grad.addColorStop(1, color.setA(0).toCSS())
    ctx.beginPath()
    ctx.moveTo(px(0), y + h)
    for (let i = 0; i < n; i++) ctx.lineTo(px(i), py(d[i]))
    ctx.lineTo(px(n - 1), y + h)
    ctx.closePath()
    ctx.fillStyle = grad
    ctx.fill()
    const cu = color.toUint32()
    for (let i = 1; i < n; i++) sparks.push(px(i - 1), py(d[i - 1]), px(i), py(d[i]), cu)
    // end-point marker
    ctx.beginPath()
    ctx.arc(px(n - 1), py(d[n - 1]), 2, 0, Math.PI * 2)
    ctx.fillStyle = color.toCSS()
    ctx.fill()
  }

  private drawLines(ctx: CanvasRenderingContext2D, r0: number, r1: number, c0: number, c1: number, gx: number) {
    if (!applyLineToCanvas(ctx, this.border)) return
    const right = Math.min(this.grid.x + this.grid.w, gx + this.contentW)
    ctx.beginPath()
    for (let b = r0; b < r1; b++) {
      const y = Math.round(this.body.y + this.prefix[b + 1] - this.scrollY) - 0.5
      ctx.moveTo(this.grid.x, y)
      ctx.lineTo(right, y)
    }
    const bottom = Math.min(this.body.y + this.body.h, this.body.y + this.contentH - this.scrollY)
    for (let c = c0 + 1; c < c1; c++) {
      const x = Math.round(gx + this.colX[c]) + 0.5
      ctx.moveTo(x, this.body.y)
      ctx.lineTo(x, bottom)
    }
    ctx.stroke()
  }

  override hasGL() { return this.sparkCount > 0 }

  override drawGL(r: GLRenderer) {
    const id = { a0: 0, start: 0, k: 1, log: 0 }
    r.glow = 1
    if (this.sparkBody.n && this.body.h > 0) {
      r.scissor(this.body)
      this.sparkBody.draw(r, { mx: id, my: id }, 1.5)
    }
    if (this.sparkHead.n && this.head.h > 0) {
      r.scissor(this.head)
      this.sparkHead.draw(r, { mx: id, my: id }, 1.5)
    }
    r.scissor(null)
    r.glow = 0
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const sb = this.scrollbars()
    for (const k of ['y', 'x'] as const) {
      const s = sb[k]
      if (!s) continue
      const active = this.hoverBar === k || this.drag?.axis === k
      roundRect(ctx, s.track.x, s.track.y, s.track.w, s.track.h, 4)
      ctx.fillStyle = t.isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)'
      ctx.fill()
      roundRect(ctx, s.thumb.x, s.thumb.y, s.thumb.w, s.thumb.h, 4)
      ctx.fillStyle = active ? t.axisTitleColor.setA(200).toCSS() : t.isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)'
      ctx.fill()
    }
    if (!this.cells.length) {
      ctx.font = this.baseFont().toCSS()
      ctx.fillStyle = t.legend.disabledColor.toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('No data', this.grid.x + this.grid.w / 2, this.grid.y + this.grid.h / 2)
    }
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private scrollbars(): { x: { track: Rect; thumb: Rect } | null; y: { track: Rect; thumb: Rect } | null } {
    let y: { track: Rect; thumb: Rect } | null = null
    let x: { track: Rect; thumb: Rect } | null = null
    const B = this.body
    if (this.maxScrollY > 0 && B.h > 20) {
      const track = { x: B.x + B.w - 9, y: B.y + 2, w: 7, h: B.h - 4 - (this.maxScrollX > 0 ? 10 : 0) }
      const th = Math.max(24, (track.h * B.h) / this.contentH)
      const ty = track.y + ((track.h - th) * this.scrollY) / this.maxScrollY
      y = { track, thumb: { x: track.x, y: ty, w: track.w, h: th } }
    }
    if (this.maxScrollX > 0 && B.w > 20) {
      const track = { x: B.x + 2, y: B.y + B.h - 9, w: B.w - 4 - (y ? 10 : 0), h: 7 }
      const viewW = B.w - (y ? 12 : 0)
      const tw = Math.max(24, (track.w * viewW) / this.contentW)
      const tx = track.x + ((track.w - tw) * this.scrollX) / this.maxScrollX
      x = { track, thumb: { x: tx, y: track.y, w: tw, h: track.h } }
    }
    return { x, y }
  }

  // ---------------------------------------------------------------- interaction

  private rowAt(px: number, py: number): number {
    if (!rectContains(this.grid, px, py)) return -1
    if (py < this.body.y) {
      let y = this.head.y
      for (let r = 0; r < this.headerRows; r++) {
        y += this.rowH.get(r) ?? this.defRowH
        if (py < y) return r
      }
      return -1
    }
    const v = py - this.body.y + this.scrollY
    const p = this.prefix
    let lo = 0, hi = p.length - 1
    while (lo < hi) {
      const m = (lo + hi) >> 1
      if (p[m + 1] <= v) lo = m + 1
      else hi = m
    }
    return lo < p.length - 1 ? lo + this.headerRows : -1
  }
  private colAt(px: number): number {
    const v = px - this.grid.x + this.scrollX
    for (let c = 0; c < this.nCols; c++) if (v >= this.colX[c] && v < this.colX[c + 1]) return c
    return -1
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    const sb = this.scrollbars()
    switch (e.type) {
      case 'wheel': {
        if (!rectContains(this.grid, x, y)) return false
        const ev = e.native as WheelEvent
        const mult = ev.deltaMode === 1 ? this.defRowH : ev.deltaMode === 2 ? this.body.h : 1
        const horiz = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)
        const d = (horiz && e.shiftKey ? e.deltaY : horiz ? e.deltaX : e.deltaY) * mult
        if (horiz) {
          if (!this.maxScrollX) return false
          this.scrollX = Math.min(this.maxScrollX, Math.max(0, this.scrollX + d))
        } else {
          if (!this.maxScrollY) return false
          this.scrollY = Math.min(this.maxScrollY, Math.max(0, this.scrollY + d))
        }
        this.hoverRow = this.rowAt(x, y)
        return true
      }
      case 'down': {
        for (const k of ['y', 'x'] as const) {
          const s = sb[k]
          if (!s || !rectContains({ x: s.track.x - 3, y: s.track.y - 3, w: s.track.w + 6, h: s.track.h + 6 }, x, y)) continue
          const pos = k === 'y' ? y : x
          const onThumb = rectContains({ x: s.thumb.x - 3, y: s.thumb.y - 3, w: s.thumb.w + 6, h: s.thumb.h + 6 }, x, y)
          if (!onThumb) {
            // page towards the click
            const before = k === 'y' ? pos < s.thumb.y : pos < s.thumb.x
            const page = k === 'y' ? this.body.h * 0.9 : this.body.w * 0.9
            if (k === 'y') this.scrollY = Math.min(this.maxScrollY, Math.max(0, this.scrollY + (before ? -page : page)))
            else this.scrollX = Math.min(this.maxScrollX, Math.max(0, this.scrollX + (before ? -page : page)))
          }
          this.drag = { axis: k, start: pos, scroll0: k === 'y' ? this.scrollY : this.scrollX }
          return true
        }
        return false
      }
      case 'move': {
        if (this.drag) {
          const s = sb[this.drag.axis]
          if (!s) return false
          if (this.drag.axis === 'y') {
            const k = this.maxScrollY / Math.max(1, s.track.h - s.thumb.h)
            this.scrollY = Math.min(this.maxScrollY, Math.max(0, this.drag.scroll0 + (y - this.drag.start) * k))
          } else {
            const k = this.maxScrollX / Math.max(1, s.track.w - s.thumb.w)
            this.scrollX = Math.min(this.maxScrollX, Math.max(0, this.drag.scroll0 + (x - this.drag.start) * k))
          }
          return true
        }
        const onBar = sb.y && rectContains({ x: sb.y.track.x - 3, y: sb.y.track.y, w: sb.y.track.w + 6, h: sb.y.track.h }, x, y) ? 'y'
          : sb.x && rectContains({ x: sb.x.track.x, y: sb.x.track.y - 3, w: sb.x.track.w, h: sb.x.track.h + 6 }, x, y) ? 'x' : null
        const row = onBar ? -1 : this.rowAt(x, y)
        const hr = row >= this.headerRows ? row : -1
        if (hr !== this.hoverRow || onBar !== this.hoverBar) {
          this.hoverRow = hr
          this.hoverBar = onBar
          this.surface.setCursor(onBar ? 'pointer' : 'default')
          return true
        }
        return false
      }
      case 'up': {
        const was = !!this.drag
        this.drag = null
        return was
      }
      case 'leave':
        if (this.hoverRow < 0 && !this.hoverBar) return false
        this.hoverRow = -1
        this.hoverBar = null
        return true
      case 'click': {
        const row = this.rowAt(x, y), col = this.colAt(x)
        if (row < 0 || col < 0) return false
        this.emit('cellclick', { column: col, row, content: this.getCellContent(col, row), chart: this })
        return false
      }
    }
    return false
  }

  override tick(now: number): boolean {
    const a = super.tick(now)
    return a || now < this.flashUntil
  }

  override disposeGL(r: GLRenderer | null) {
    this.sparkBody.dispose(r)
    this.sparkHead.dispose(r)
  }
}
