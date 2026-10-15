import { Color } from '../core/color'
import { LegendSymbol } from '../core/Legend'
import { PanelOptions } from '../core/Panel'
import { emptyLine, Fill, fillToCanvas, applyLineToCanvas, isEmptyLine, LineStyle, Mutator, resolve, SolidFill, SolidLine, PalettedFill } from '../core/style'
import { clamp, Rect, roundRect } from '../core/util'
import { drawArea, drawLineStrip, drawPoints, XYMaps } from '../render/draw'
import { GLRenderer } from '../render/GLRenderer'
import type { PointerInfo, Surface } from '../render/Surface'
import { Axis } from '../xy/Axis'
import { ChartXY, ChartXYOptions } from '../xy/ChartXY'
import { AxisTickStrategies } from '../xy/ticks'
import { Bounds, XYStore } from '../xy/store'
import { CursorHit, SeriesXY } from '../xy/series/SeriesXY'
import { PointLineAreaSeries } from '../xy/series/PointLineAreaSeries'
import { OHLCSeries } from '../xy/series/OHLCSeries'

export interface ZoomBandChartOptions extends PanelOptions {
  surface?: Surface
  /** Axis whose interval the band shows and controls. Its chart's series are mirrored unless `add()` is used. */
  axis?: Axis
  [k: string]: unknown
}

/** Compact, non-interactive rendering of another chart's series. */
class OverviewSeries extends SeriesXY {
  constructor(chart: ChartXY, readonly src: SeriesXY, private zb: ZoomBandChart) {
    super(chart, chart.axisX, chart.axisY, src.colorIndex, src.getName())
    this.cursorEnabled = false
  }
  override getVisible() { return this.visible && this.src.getVisible() && !this.src.isDisposed() }
  override getEffect() { return this.effect ?? this.src.getEffect() }
  bounds(): Bounds | null { return this.getVisible() ? this.src.bounds() : null }

  private store(): XYStore | null {
    const s = this.src
    if (s instanceof PointLineAreaSeries) return s.data
    if (s instanceof OHLCSeries) return s.getCloseStore()
    return null
  }

  drawGL(r: GLRenderer, maps: XYMaps, rect: Rect) {
    const s = this.src
    const st = this.store()
    if (!st) {
      // Generic fallback: let the series draw itself through our axis maps.
      s.drawGL(r, maps, rect)
      return
    }
    if (!st.size()) return
    const color = this.zb.overviewColor(s)
    if (s instanceof PointLineAreaSeries && s.preset === 'point') {
      drawPoints(r, st, maps, { size: 2, shape: 'circle', color })
      return
    }
    if (this.zb.proxyCount() === 1) {
      // A single overview series gets a soft area; several would muddy each other.
      const base = Math.min(this.axisY.start, this.axisY.end)
      drawArea(r, st, maps, { fill: new SolidFill({ color: color.setA(this.chart.getTheme().isDark ? 46 : 40) }), color, baseline: base, rect })
    }
    drawLineStrip(r, st, maps, { thickness: 1.25, color })
  }
  nearest(_px: number, _py: number, _byX: boolean): CursorHit | null { return null }
  getLegendSymbol(): LegendSymbol { return this.src.getLegendSymbol() }
  primaryColor(): Color { return this.src.primaryColor() }
}

type BandDrag =
  | { kind: 'none' }
  | { kind: 'body'; v0: number; s0: number; e0: number }
  | { kind: 'start' | 'end' }
  | { kind: 'new'; a: number; x0: number }

const EDGE = 7

/**
 * Overview chart that shows (and drives) the X interval of another chart's axis.
 * Drag the band to pan, drag its edges to resize, drag in
 * empty space to select a new range, wheel to zoom, double-click to reset.
 */
export class ZoomBandChart extends ChartXY {
  private attached: Axis | null = null
  private offAxis: (() => void) | null = null
  private explicit = false
  private proxies = new Map<SeriesXY, OverviewSeries>()
  private bandDrag: BandDrag = { kind: 'none' }
  private bandFill: Fill
  private bandStroke: LineStyle
  private copiedStrategy: unknown = null

  constructor(o: ZoomBandChartOptions = {}) {
    super({ ...(o as ChartXYOptions), legend: { visible: false } })
    const t = this.theme
    this.bandFill = new SolidFill({ color: t.zoomRectFill })
    this.bandStroke = new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: t.zoomRectStroke }) })
    this.setPadding({ top: 6, bottom: 4 })
    this.setCursorMode('disabled')
    this.axisY.setTickStrategy(AxisTickStrategies.Empty).setStrokeStyle(emptyLine).setTickLabelsVisible(false)
    this.axisY.fitMargin = 0.08
    if (o.axis) this.attachAxis(o.axis)
  }

  // ---------------------------------------------------------------- API

  /** Attach to the axis the band controls. */
  attachAxis(axis: Axis) {
    this.offAxis?.()
    this.attached = axis
    const h = () => this.requestRender()
    axis.addEventListener('intervalchange', h)
    const other = axis.chart
    const ho = () => this.requestRender()
    other.addEventListener('dispose', ho)
    this.offAxis = () => {
      axis.removeEventListener('intervalchange', h)
      other.removeEventListener('dispose', ho)
    }
    this.copiedStrategy = null
    this.requestRender()
    return this
  }
  getAttachedAxis() { return this.attached }

  /** Show a series in the overview (switches off automatic mirroring). */
  add(series: SeriesXY) {
    if (!this.explicit) {
      this.explicit = true
      for (const s of [...this.proxies.keys()]) this.dropProxy(s)
    }
    if (!this.attached) this.attachAxis(series.axisX)
    this.makeProxy(series)
    return this
  }
  remove(series: SeriesXY) { this.dropProxy(series); return this }

  setBandFillStyle(f: Mutator<Fill>) { this.bandFill = resolve(this.bandFill, f); this.requestRender(); return this }
  getBandFillStyle() { return this.bandFill }
  setBandStrokeStyle(l: Mutator<LineStyle>) { this.bandStroke = resolve(this.bandStroke, l); this.requestRender(); return this }
  getBandStrokeStyle() { return this.bandStroke }

  /** @internal */
  overviewColor(s: SeriesXY): Color {
    const c = s.primaryColor()
    if (s instanceof PointLineAreaSeries) {
      const f = s.getStrokeStyle().getFillStyle()
      if (f instanceof PalettedFill) return f.getPrimaryColor().setA(255)
    }
    return c.a < 40 ? c.setA(255) : c
  }

  /** @internal */
  proxyCount() {
    let n = 0
    for (const p of this.proxies.values()) if (p.getVisible()) n++
    return n
  }

  private makeProxy(s: SeriesXY) {
    if (this.proxies.has(s) || s.chart === this) return
    const p = new OverviewSeries(this, s, this)
    this.proxies.set(s, p)
    this.attachSeries(p)
  }
  private dropProxy(s: SeriesXY) {
    const p = this.proxies.get(s)
    if (!p) return
    this.proxies.delete(s)
    this.removeSeries(p)
  }

  // ---------------------------------------------------------------- layout

  override layout(ctx: CanvasRenderingContext2D) {
    const ax = this.attached
    if (ax) {
      if (!this.explicit) {
        const live = new Set(ax.chart.getSeries().filter((s) => s.axisX === ax))
        for (const s of live) this.makeProxy(s)
        for (const s of [...this.proxies.keys()]) if (!live.has(s)) this.dropProxy(s)
      } else {
        for (const s of [...this.proxies.keys()]) if (s.isDisposed()) this.dropProxy(s)
      }
      if (this.copiedStrategy !== ax.strategy) {
        this.copiedStrategy = ax.strategy
        this.axisX.setTickStrategy(ax.strategy)
      }
      // Align the plot with the attached chart when both share a column.
      const main = ax.chart
      const sameColumn = Math.abs(main.rect.x - this.rect.x) < 1 && Math.abs(main.rect.w - this.rect.w) < 1 && main.plot.w > 1
      if (sameColumn && !main.isDisposed()) {
        const mp = main.getPadding()
        if (this.padding.left !== mp.left || this.padding.right !== mp.right) this.padding = { ...this.padding, left: mp.left, right: mp.right }
        this.axisY.fixedThickness = Math.max(4, main.plot.x - main.rect.x - mp.left)
      } else {
        this.axisY.fixedThickness = null
      }
    }
    super.layout(ctx)
  }

  /** Band edges in px, clamped into the plot so both grips stay reachable. */
  private bandPx(): [number, number] | null {
    const ax = this.attached
    if (!ax) return null
    const p = this.plot
    const a = this.axisX.valueToPx(ax.lo), b = this.axisX.valueToPx(ax.hi)
    return [clamp(Math.min(a, b), p.x, p.x + p.w), clamp(Math.max(a, b), p.x, p.x + p.w)]
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    super.drawOverlay(ctx)
    const band = this.bandPx()
    if (!band) return
    const p = this.plot
    const t = this.theme
    const [l, r] = band
    ctx.save()
    ctx.beginPath()
    ctx.rect(p.x, p.y, p.w, p.h)
    ctx.clip()
    // Dim what lies outside the band.
    ctx.fillStyle = t.isDark ? 'rgba(0,0,0,0.5)' : 'rgba(255,255,255,0.6)'
    if (l > p.x) ctx.fillRect(p.x, p.y, l - p.x, p.h)
    if (r < p.x + p.w) ctx.fillRect(r, p.y, p.x + p.w - r, p.h)
    const paint = fillToCanvas(ctx, this.bandFill, l, p.y, r - l, p.h)
    if (paint && r > l) {
      ctx.fillStyle = paint
      ctx.fillRect(l, p.y, r - l, p.h)
    }
    if (!isEmptyLine(this.bandStroke) && applyLineToCanvas(ctx, this.bandStroke)) {
      ctx.beginPath()
      for (const e of band) {
        const x = Math.round(clamp(e, p.x + 1, p.x + p.w - 1))
        ctx.moveTo(x, p.y)
        ctx.lineTo(x, p.y + p.h)
      }
      ctx.stroke()
      // Grips on the edges.
      const gh = Math.min(26, p.h * 0.5), gw = 8
      const col = this.bandStroke.getFillStyle().getPrimaryColor()
      for (const e0 of band) {
        const e = clamp(e0, p.x + gw / 2, p.x + p.w - gw / 2)
        const gx = Math.round(e) - gw / 2, gy = p.y + (p.h - gh) / 2
        roundRect(ctx, gx, gy, gw, gh, 3)
        ctx.fillStyle = t.isDark ? col.scale(0.45).setA(255).toCSS() : new Color(255, 255, 255).toCSS()
        ctx.fill()
        ctx.lineWidth = 1
        ctx.strokeStyle = col.toCSS()
        ctx.setLineDash([])
        ctx.stroke()
        ctx.beginPath()
        for (const dx of [-1.5, 1.5]) {
          ctx.moveTo(Math.round(e) + dx, gy + 6)
          ctx.lineTo(Math.round(e) + dx, gy + gh - 6)
        }
        ctx.stroke()
      }
    }
    ctx.restore()
  }

  // ---------------------------------------------------------------- interaction

  private setBand(s: number, e: number) {
    const ax = this.attached
    if (!ax || !(e > s)) return
    const inv = ax.start > ax.end
    ax.setInterval({ start: inv ? e : s, end: inv ? s : e, stopAxisAfter: true })
  }

  private hitBand(x: number): 'start' | 'end' | 'body' | null {
    const b = this.bandPx()
    if (!b) return null
    if (Math.abs(x - b[0]) <= EDGE) return 'start'
    if (Math.abs(x - b[1]) <= EDGE) return 'end'
    if (x > b[0] && x < b[1]) return 'body'
    return null
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const ax = this.attached
    if (!ax) return false
    const p = this.plot
    const { x, y } = e
    const inPlot = x >= p.x - EDGE && x <= p.x + p.w + EDGE && y >= p.y && y <= p.y + p.h
    const v = this.axisX.pxToValue(clamp(x, p.x, p.x + p.w))
    const d = this.bandDrag
    switch (e.type) {
      case 'down': {
        if (!inPlot || e.button !== 0) return false
        const h = this.hitBand(x)
        if (h === 'body') this.bandDrag = { kind: 'body', v0: v, s0: ax.lo, e0: ax.hi }
        else if (h) this.bandDrag = { kind: h }
        else this.bandDrag = { kind: 'new', a: v, x0: x }
        return true
      }
      case 'move': {
        if (d.kind === 'none') {
          const h = inPlot ? this.hitBand(x) : null
          this.surface.setCursor(h === 'body' ? 'grab' : h ? 'ew-resize' : inPlot ? 'crosshair' : 'default')
          return false
        }
        const lo = this.axisX.lo, hi = this.axisX.hi
        if (d.kind === 'body') {
          const w = d.e0 - d.s0
          let s = d.s0 + (v - d.v0)
          s = clamp(s, Math.min(lo, d.s0), Math.max(hi, d.e0) - w)
          this.setBand(s, s + w)
          this.surface.setCursor('grabbing')
        } else if (d.kind === 'start' || d.kind === 'end') {
          const other = d.kind === 'start' ? ax.hi : ax.lo
          const minW = Math.abs(this.axisX.pxToValue(p.x + 4) - this.axisX.pxToValue(p.x))
          if (d.kind === 'start') this.setBand(Math.min(v, other - minW), other)
          else this.setBand(other, Math.max(v, other + minW))
          this.surface.setCursor('ew-resize')
        } else if (d.kind === 'new' && Math.abs(x - d.x0) > 3) {
          this.setBand(Math.min(d.a, v), Math.max(d.a, v))
        }
        return true
      }
      case 'up': {
        const was = d.kind !== 'none'
        this.bandDrag = { kind: 'none' }
        return was
      }
      case 'wheel': {
        if (!inPlot) return false
        const ev = e.native as WheelEvent
        const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
        const f = Math.exp(clamp(e.deltaY * mult, -300, 300) * 0.0015)
        const s = ax.lo, en = ax.hi
        const c = v >= s && v <= en ? v : (s + en) / 2
        this.setBand(c + (s - c) * f, c + (en - c) * f)
        return true
      }
      case 'dblclick': {
        if (!inPlot) return false
        ax.fit(true)
        return true
      }
      case 'leave':
        if (d.kind === 'none') this.surface.setCursor('default')
        return false
    }
    return false
  }

  override dispose() {
    this.offAxis?.()
    this.offAxis = null
    super.dispose()
  }
}
