import { Panel } from '../core/Panel'
import { Theme, Themes } from '../core/theme'
import { containerOf, Rect } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { Drawable, PointerInfo, Surface } from '../render/Surface'
import type { GlowSettings } from '../core/theme'
import { ChartXY, ChartXYOptions } from '../xy/ChartXY'
import { UIPanel, UIPanelOptions } from './UIPanel'
import { Chart3D, Chart3DOptions } from '../chart3d/Chart3D'
import { PolarChart, PolarChartOptions } from '../polar/PolarChart'
import { SpiderChart, SpiderChartOptions } from '../polar/SpiderChart'
import { PieChart, PieChartOptions } from '../pie/PieChart'
import { GaugeChart, GaugeChartOptions } from '../pie/GaugeChart'
import { FunnelChart, FunnelChartOptions } from '../pie/FunnelChart'
import { PyramidChart, PyramidChartOptions } from '../pie/PyramidChart'
import { BarChart, BarChartOptions } from '../bar/BarChart'
import { ZoomBandChart, ZoomBandChartOptions } from '../zoomband/ZoomBandChart'
import { ParallelCoordinateChart, ParallelCoordinateChartOptions } from '../parallel/ParallelCoordinateChart'
import { TreeMapChart, TreeMapChartOptions } from '../hierarchy/TreeMapChart'
import { SunburstChart, SunburstChartOptions } from '../hierarchy/SunburstChart'
import { DataGrid, DataGridOptions } from '../datagrid/DataGrid'
import { MapChart, MapChartOptions } from '../map/MapChart'

export interface DashboardOptions {
  container?: HTMLElement | string
  theme?: Theme
  numberOfColumns: number
  numberOfRows: number
  /** Gap between cells in CSS px. */
  splitterThickness?: number
  [k: string]: unknown
}

export interface CellOptions {
  columnIndex: number
  rowIndex: number
  columnSpan?: number
  rowSpan?: number
  [k: string]: unknown
}

interface Cell { panel: Panel; c: number; r: number; cs: number; rs: number }

type PanelCtor<T extends Panel, O> = new (o: O & { surface: Surface; theme: Theme }) => T

/**
 * Grid of charts sharing one canvas (and one GL pass + glow pass per frame).
 * Cells are resizable by dragging the splitters.
 */
export class Dashboard implements Drawable {
  readonly surface: Surface
  readonly theme: Theme
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  z = 0
  private cols: number
  private rows: number
  private colW: number[]
  private rowH: number[]
  private cells: Cell[] = []
  private gap: number
  private dragging: { kind: 'col' | 'row'; i: number; last: number } | null = null
  private colEdges: number[] = []
  private rowEdges: number[] = []

  constructor(o: DashboardOptions) {
    this.theme = o.theme ?? Themes.storm
    this.cols = Math.max(1, o.numberOfColumns | 0)
    this.rows = Math.max(1, o.numberOfRows | 0)
    this.colW = new Array(this.cols).fill(1)
    this.rowH = new Array(this.rows).fill(1)
    this.gap = o.splitterThickness ?? 2
    this.surface = new Surface(containerOf(o.container))
    this.surface.add(this)
  }

  /** Generic cell creation used by all createX methods. */
  createPanel<T extends Panel, O extends object>(Ctor: PanelCtor<T, O>, o: CellOptions & O): T {
    const p = new Ctor({ ...o, surface: this.surface, theme: (o as { theme?: Theme }).theme ?? this.theme })
    this.cells.push({ panel: p, c: o.columnIndex, r: o.rowIndex, cs: o.columnSpan ?? 1, rs: o.rowSpan ?? 1 })
    p.addEventListener('dispose', () => {
      this.cells = this.cells.filter((c) => c.panel !== p)
      this.surface.requestRender()
    })
    this.surface.requestRender()
    return p
  }

  createChartXY(o: CellOptions & ChartXYOptions) { return this.createPanel(ChartXY, o) }
  createUIPanel(o: CellOptions & UIPanelOptions) { return this.createPanel(UIPanel, o) }
  createChart3D(o: CellOptions & Chart3DOptions) { return this.createPanel(Chart3D, o) }
  createPolarChart(o: CellOptions & PolarChartOptions) { return this.createPanel(PolarChart, o) }
  createSpiderChart(o: CellOptions & SpiderChartOptions) { return this.createPanel(SpiderChart, o) }
  createPieChart(o: CellOptions & PieChartOptions) { return this.createPanel(PieChart, o) }
  createGaugeChart(o: CellOptions & GaugeChartOptions) { return this.createPanel(GaugeChart, o) }
  createFunnelChart(o: CellOptions & FunnelChartOptions) { return this.createPanel(FunnelChart, o) }
  createPyramidChart(o: CellOptions & PyramidChartOptions) { return this.createPanel(PyramidChart, o) }
  createBarChart(o: CellOptions & BarChartOptions) { return this.createPanel(BarChart, o) }
  createZoomBandChart(o: CellOptions & ZoomBandChartOptions) { return this.createPanel(ZoomBandChart, o) }
  createParallelCoordinateChart(o: CellOptions & ParallelCoordinateChartOptions) { return this.createPanel(ParallelCoordinateChart, o) }
  createTreeMapChart(o: CellOptions & TreeMapChartOptions) { return this.createPanel(TreeMapChart, o) }
  createSunburstChart(o: CellOptions & SunburstChartOptions) { return this.createPanel(SunburstChart, o) }
  createDataGrid(o: CellOptions & DataGridOptions) { return this.createPanel(DataGrid, o) }
  createMapChart(o: CellOptions & MapChartOptions) { return this.createPanel(MapChart, o) }

  setColumnWidth(i: number, w: number) { if (i >= 0 && i < this.cols) this.colW[i] = w; this.surface.requestRender(); return this }
  setRowHeight(i: number, h: number) { if (i >= 0 && i < this.rows) this.rowH[i] = h; this.surface.requestRender(); return this }
  setSplitterStyle(_s: unknown) { return this }
  setSplitterStyleHighlight(_s: unknown) { return this }
  getTheme() { return this.theme }

  layout(_ctx: CanvasRenderingContext2D) {
    const W = this.surface.cssW, H = this.surface.cssH
    this.rect = { x: 0, y: 0, w: W, h: H }
    const g = this.gap
    const cw = this.colW.reduce((a, b) => a + b, 0) || 1
    const rh = this.rowH.reduce((a, b) => a + b, 0) || 1
    const availW = W - g * (this.cols - 1), availH = H - g * (this.rows - 1)
    this.colEdges = [0]
    for (let i = 0; i < this.cols; i++) this.colEdges.push(this.colEdges[i] + (availW * this.colW[i]) / cw + (i < this.cols - 1 ? g : 0))
    this.rowEdges = [0]
    for (let i = 0; i < this.rows; i++) this.rowEdges.push(this.rowEdges[i] + (availH * this.rowH[i]) / rh + (i < this.rows - 1 ? g : 0))
    for (const c of this.cells) {
      const x0 = this.colEdges[c.c], x1 = this.colEdges[Math.min(this.cols, c.c + c.cs)] - (c.c + c.cs < this.cols ? g : 0)
      const y0 = this.rowEdges[c.r], y1 = this.rowEdges[Math.min(this.rows, c.r + c.rs)] - (c.r + c.rs < this.rows ? g : 0)
      c.panel.rect = { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) }
    }
  }
  drawBackground(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = this.theme.dashboardSplitterColor.toCSS()
    ctx.fillRect(0, 0, this.rect.w, this.rect.h)
  }
  hasGL() { return false }
  drawGL(_r: GLRenderer) {}
  drawOverlay(_ctx: CanvasRenderingContext2D) {}
  glow(): GlowSettings | null { return null }
  tick() { return false }
  hitTest(x: number, y: number) {
    return this.splitterAt(x, y) !== null || this.dragging !== null
  }
  private splitterAt(x: number, y: number): { kind: 'col' | 'row'; i: number } | null {
    const g = Math.max(this.gap, 2)
    for (let i = 1; i < this.cols; i++) {
      const e = this.colEdges[i] - this.gap / 2
      if (Math.abs(x - e) <= g / 2 + 2) return { kind: 'col', i }
    }
    for (let i = 1; i < this.rows; i++) {
      const e = this.rowEdges[i] - this.gap / 2
      if (Math.abs(y - e) <= g / 2 + 2) return { kind: 'row', i }
    }
    return null
  }
  onPointer(e: PointerInfo): boolean {
    if (e.type === 'down') {
      const s = this.splitterAt(e.x, e.y)
      if (s) this.dragging = { ...s, last: s.kind === 'col' ? e.x : e.y }
      return !!s
    }
    if (e.type === 'move') {
      const s = this.dragging ?? this.splitterAt(e.x, e.y)
      this.surface.setCursor(s ? (s.kind === 'col' ? 'col-resize' : 'row-resize') : 'default')
      if (!this.dragging) return false
      const d = this.dragging
      const p = d.kind === 'col' ? e.x : e.y
      const delta = p - d.last
      const sizes = d.kind === 'col' ? this.colW : this.rowH
      const total = d.kind === 'col' ? this.rect.w : this.rect.h
      const sum = sizes.reduce((a, b) => a + b, 0)
      const k = (delta / total) * sum
      const a = sizes[d.i - 1], b = sizes[d.i]
      const min = sum * 0.03
      const nk = Math.max(min - a, Math.min(b - min, k))
      sizes[d.i - 1] = a + nk
      sizes[d.i] = b - nk
      d.last = p
      return true
    }
    if (e.type === 'up') {
      const was = !!this.dragging
      this.dragging = null
      return was
    }
    return false
  }
  disposeGL(_r: GLRenderer | null) {}
  dispose() {
    for (const c of [...this.cells]) c.panel.dispose()
    this.surface.dispose()
  }
}
