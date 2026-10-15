import { Color } from '../core/color'
import { FontSettings, Panel, PanelOptions } from '../core/Panel'
import { Fill, fillToCanvas, Mutator, resolve, SolidFill } from '../core/style'
import { font } from '../core/theme'
import { decimalsForStep, Easings, formatNumber, textWidth, Tween } from '../core/util'
import type { Surface } from '../render/Surface'
import { NumericTickStrategy } from '../xy/ticks'
import { DEG } from '../polar/common'
import { darken, lighten } from './slices'

export interface GaugeChartOptions extends PanelOptions {
  surface?: Surface
  [k: string]: unknown
}

/** Colored range drawn along the gauge arc; the bar takes the color of the range holding the value. */
export interface GaugeValueIndicator { start: number; end: number; color: Color }

/**
 * Radial gauge: a thick value bar along an arc, colored value
 * indicator ranges, tick labels, animated needle and a large value readout.
 */
export class GaugeChart extends Panel {
  private value = 0
  private shown = 0
  private tween: Tween | null = null
  private start = 0
  private end = 100
  private angleStart = 225
  private angleEnd = -45
  private unit = ''
  private indicators: GaugeValueIndicator[] = []
  private valueFormatter: ((v: number) => string) | null = null
  private tickFormatter: ((v: number) => string) | null = null
  private barThickness: number | null = null
  private indicatorThickness: number | null = null
  private needleLength: number | null = null
  private needleThickness: number | null = null
  private needleVisible = true
  private needleFill: Fill | null = null
  private barFill: Fill | null = null
  private barBgFill: Fill | null = null
  private tickLabelsVisible = true
  private indicatorsVisible = true
  private valueLabelVisible = true
  private roundedEdges = true
  private gap: number | null = null
  private animations = true
  private valueFont: FontSettings | null = null
  private valueColor: Color | null = null
  private unitFont: FontSettings | null = null
  private tickFont: FontSettings | null = null
  // layout
  private cx = 0
  private cy = 0
  private R = 1

  constructor(o: GaugeChartOptions = {}) {
    super(o)
  }

  // ---------------------------------------------------------------- API

  /** Animated value change. */
  setValue(v: number) {
    if (!Number.isFinite(v)) return this
    this.value = v
    this.tween?.cancel()
    if (this.animations) {
      this.tween = new Tween([this.shown], [v], 650, (x) => { this.shown = x[0] }, Easings.easeInOut)
      this.animate(this.tween)
    } else {
      this.shown = v
      this.requestRender()
    }
    return this
  }
  getValue() { return this.value }
  /** Value range of the gauge. */
  setInterval(start: number | { start: number; end: number }, end?: number) {
    if (typeof start === 'object') { end = start.end; start = start.start }
    this.start = start
    this.end = end ?? this.end
    this.requestRender()
    return this
  }
  getInterval() { return { start: this.start, end: this.end } }
  /** Arc angles in degrees (0 = right, counter-clockwise positive); default 225 to -45. */
  setAngleInterval(startDeg: number, endDeg: number) { this.angleStart = startDeg; this.angleEnd = endDeg; this.requestRender(); return this }
  getAngleInterval() { return { start: this.angleStart, end: this.angleEnd } }
  setUnitLabel(u: string) { this.unit = u; this.requestRender(); return this }
  getUnitLabel() { return this.unit }
  setValueIndicators(ind: GaugeValueIndicator[]) { this.indicators = ind.map((i) => ({ ...i })); this.requestRender(); return this }
  getValueIndicators() { return this.indicators.map((i) => ({ ...i })) }
  setValueIndicatorsVisible(v: boolean) { this.indicatorsVisible = v; this.requestRender(); return this }
  setValueIndicatorThickness(px: number) { this.indicatorThickness = px; this.requestRender(); return this }
  setValueLabelFormatter(f: ((v: number) => string) | undefined) { this.valueFormatter = f ?? null; this.requestRender(); return this }
  /** Alias. */
  setValueFormatter(f: ((v: number) => string) | undefined) { return this.setValueLabelFormatter(f) }
  setValueLabelVisible(v: boolean) { this.valueLabelVisible = v; this.requestRender(); return this }
  setValueLabelFont(f: Mutator<FontSettings>) { this.valueFont = resolve(this.valueFont ?? new FontSettings(32, 600, this.theme.fontFamily), f); this.requestRender(); return this }
  setValueLabelFillStyle(f: Mutator<Fill>) { this.valueColor = resolve<Fill>(new SolidFill({ color: this.valueColor ?? this.theme.titleColor }), f).getPrimaryColor(); this.requestRender(); return this }
  setUnitLabelFont(f: Mutator<FontSettings>) { this.unitFont = resolve(this.unitFont ?? new FontSettings(this.theme.fontSize, 'normal', this.theme.fontFamily), f); this.requestRender(); return this }
  setTickFormatter(f: ((v: number) => string) | undefined) { this.tickFormatter = f ?? null; this.requestRender(); return this }
  setTickLabelsVisible(v: boolean) { this.tickLabelsVisible = v; this.requestRender(); return this }
  setTickFont(f: Mutator<FontSettings>) { this.tickFont = resolve(this.tickFont ?? new FontSettings(this.theme.fontSize, 'normal', this.theme.fontFamily), f); this.requestRender(); return this }
  setBarThickness(px: number) { this.barThickness = px; this.requestRender(); return this }
  setBarFillStyle(f: Mutator<Fill>) { this.barFill = resolve<Fill>(this.barFill ?? new SolidFill({ color: this.barColor() }), f); this.requestRender(); return this }
  setBarBackgroundFillStyle(f: Mutator<Fill>) { this.barBgFill = resolve<Fill>(this.barBgFill ?? new SolidFill({ color: this.trackColor() }), f); this.requestRender(); return this }
  setRoundedEdges(v: boolean) { this.roundedEdges = v; this.requestRender(); return this }
  setGapBetweenBarAndValueIndicators(px: number) { this.gap = px; this.requestRender(); return this }
  setNeedleLength(px: number) { this.needleLength = px; this.requestRender(); return this }
  setNeedleThickness(px: number) { this.needleThickness = px; this.requestRender(); return this }
  setNeedleVisible(v: boolean) { this.needleVisible = v; this.requestRender(); return this }
  setNeedleFillStyle(f: Mutator<Fill>) { this.needleFill = resolve<Fill>(this.needleFill ?? new SolidFill({ color: this.theme.titleColor }), f); this.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animations = v; return this }

  // ---------------------------------------------------------------- geometry

  private frac(v: number) {
    const f = (v - this.start) / (this.end - this.start || 1)
    return Math.max(0, Math.min(1, f))
  }
  /** Canvas angle (radians, clockwise from +x) of a value. */
  private ang(v: number) { return -(this.angleStart + (this.angleEnd - this.angleStart) * this.frac(v)) * DEG }
  private ccw() { return this.angleEnd > this.angleStart }

  private barColor(): Color {
    if (this.barFill) return this.barFill.getPrimaryColor()
    const v = this.shown
    const hit = this.indicators.find((i) => v >= Math.min(i.start, i.end) && v <= Math.max(i.start, i.end))
    return hit?.color ?? this.theme.seriesColors[0]
  }
  private trackColor() { return this.theme.isDark ? new Color(255, 255, 255, 20) : new Color(0, 0, 0, 16) }

  override layout(_ctx: CanvasRenderingContext2D) {
    const area = this.layoutBase()
    // Bounding box of the unit arc plus room for the readout under the center.
    const a0 = this.angleStart, a1 = this.angleEnd
    // Readout below the hub (needle) or around the center, in units of R.
    const readout = !this.valueLabelVisible ? 0.12 : this.needleVisible ? (this.unit ? 0.62 : 0.5) : this.unit ? 0.38 : 0.2
    let xmin = 0, xmax = 0, ymin = 0, ymax = readout
    const n = 64
    for (let i = 0; i <= n; i++) {
      const a = (a0 + ((a1 - a0) * i) / n) * DEG
      const x = Math.cos(a), y = -Math.sin(a)
      xmin = Math.min(xmin, x); xmax = Math.max(xmax, x)
      ymin = Math.min(ymin, y); ymax = Math.max(ymax, y)
    }
    const pad = 8
    const R = Math.max(12, Math.min((area.w - 2 * pad) / (xmax - xmin), (area.h - 2 * pad) / (ymax - ymin)))
    this.R = R
    this.cx = area.x + area.w / 2 - ((xmin + xmax) / 2) * R
    this.cy = area.y + area.h / 2 - ((ymin + ymax) / 2) * R
  }

  // ---------------------------------------------------------------- drawing

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const dark = t.isDark
    const { cx, cy, R } = this
    const indT = this.indicatorsVisible && this.indicators.length ? (this.indicatorThickness ?? Math.max(3, R * 0.035)) : 0
    const gap = indT ? (this.gap ?? Math.max(3, R * 0.03)) : 0
    const barT = this.barThickness ?? Math.max(6, R * 0.15)
    const rInd = R - indT / 2
    const rBar = R - indT - gap - barT / 2
    const ccw = this.ccw()
    const aS = this.ang(this.start), aE = this.ang(this.end)
    ctx.save()
    ctx.lineCap = this.roundedEdges ? 'round' : 'butt'
    // Value indicator ranges.
    if (indT) {
      ctx.lineWidth = indT
      for (const ind of this.indicators) {
        ctx.beginPath()
        ctx.arc(cx, cy, rInd, this.ang(ind.start), this.ang(ind.end), ccw !== ind.end < ind.start)
        ctx.strokeStyle = ind.color.toCSS()
        ctx.stroke()
      }
    }
    // Track.
    ctx.lineWidth = barT
    ctx.beginPath()
    ctx.arc(cx, cy, rBar, aS, aE, ccw)
    ctx.strokeStyle = this.barBgFill ? (fillToCanvas(ctx, this.barBgFill, cx - R, cy - R, 2 * R, 2 * R) ?? 'transparent') : this.trackColor().toCSS()
    ctx.stroke()
    if (dark && !this.barBgFill) {
      // inner bevel
      ctx.lineWidth = 1
      ctx.strokeStyle = 'rgba(0,0,0,0.45)'
      ctx.beginPath()
      ctx.arc(cx, cy, rBar - barT / 2 + 0.5, aS, aE, ccw)
      ctx.stroke()
      ctx.lineWidth = barT
    }
    // Value bar.
    const aV = this.ang(this.shown)
    const c = this.barColor()
    if (this.frac(this.shown) > 0.001) {
      ctx.beginPath()
      ctx.arc(cx, cy, rBar, aS, aV, ccw)
      if (this.barFill && !(this.barFill instanceof SolidFill)) {
        ctx.strokeStyle = fillToCanvas(ctx, this.barFill, cx - R, cy - R, 2 * R, 2 * R) ?? c.toCSS()
      } else if (typeof ctx.createConicGradient === 'function') {
        // Gradient along the arc, brightest at the value end; starts a cap-width early so round caps match.
        const TAU = Math.PI * 2
        const capA = this.roundedEdges ? barT / 2 / rBar : 0
        const span = Math.abs(aV - aS)
        const lo = (dark ? darken(c, 0.45) : lighten(c, 0.35)).toCSS()
        const hi = (dark ? lighten(c, 0.15) : c).toCSS()
        const g = ctx.createConicGradient((ccw ? aV : aS) - capA, cx, cy)
        const o1 = Math.min(1, capA / TAU), o2 = Math.min(1, (capA + span) / TAU)
        g.addColorStop(0, ccw ? hi : lo)
        g.addColorStop(o1, ccw ? hi : lo)
        g.addColorStop(o2, ccw ? lo : hi)
        g.addColorStop(1, ccw ? lo : hi)
        ctx.strokeStyle = g
      } else ctx.strokeStyle = c.toCSS()
      if (dark) {
        ctx.shadowColor = c.setA(170).toCSS()
        ctx.shadowBlur = Math.max(8, barT * 0.9)
      }
      ctx.stroke()
      ctx.shadowColor = 'transparent'
      ctx.shadowBlur = 0
    }
    // Ticks and labels inside the bar.
    const fs = this.tickFont ? this.tickFont.size : Math.max(9, Math.min(t.fontSize * 1.35, R * 0.055))
    const rTick = rBar - barT / 2 - 4
    if (this.tickLabelsVisible) {
      const tf = this.tickFont ? new FontSettings(fs, this.tickFont.weight, this.tickFont.family).toCSS() : font(t, fs)
      const sweep = Math.abs(this.angleEnd - this.angleStart) * DEG * rTick
      const ticks = new NumericTickStrategy().generate({
        lo: Math.min(this.start, this.end),
        hi: Math.max(this.start, this.end),
        length: sweep,
        horizontal: true,
        log: 0,
        measure: (s) => textWidth(s, tf) * 1.6 + fs,
        fontSize: fs,
      })
      const step = ticks.length > 1 ? Math.abs(ticks[1].value - ticks[0].value) : 1
      ctx.lineCap = 'butt'
      for (const tk of ticks) {
        const a = this.ang(tk.value)
        const major = tk.level === 0
        const len = major ? Math.max(4, R * 0.04) : Math.max(2, R * 0.02)
        ctx.strokeStyle = (major ? t.tickColor : t.tickColor.setA(110)).toCSS()
        ctx.lineWidth = major ? 1.5 : 1
        ctx.beginPath()
        ctx.moveTo(cx + Math.cos(a) * rTick, cy + Math.sin(a) * rTick)
        ctx.lineTo(cx + Math.cos(a) * (rTick - len), cy + Math.sin(a) * (rTick - len))
        ctx.stroke()
        if (!major) continue
        const label = this.tickFormatter ? this.tickFormatter(tk.value) : formatNumber(tk.value, decimalsForStep(step))
        ctx.font = tf
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        const rl = rTick - len - 4 - fs * 0.9
        ctx.fillText(label, cx + Math.cos(a) * rl, cy + Math.sin(a) * rl)
      }
    }
    // Readout.
    const needle = this.needleVisible
    if (this.valueLabelVisible) {
      const vf = this.valueFont ?? new FontSettings(Math.max(14, R * 0.26), 600, t.fontFamily)
      const vfs = this.valueFont ? vf.size : Math.max(14, R * 0.26)
      const text = this.valueFormatter ? this.valueFormatter(this.shown) : formatNumber(this.shown, Math.min(3, decimalsForStep(Math.abs(this.end - this.start) / 100)))
      const vy = needle ? cy + R * 0.34 : cy + (this.unit ? -vfs * 0.1 : vfs * 0.1)
      ctx.font = new FontSettings(vfs, vf.weight, vf.family).toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = (this.valueColor ?? t.titleColor).toCSS()
      if (dark) {
        ctx.shadowColor = c.setA(120).toCSS()
        ctx.shadowBlur = 14
      }
      ctx.fillText(text, cx, vy)
      ctx.shadowBlur = 0
      ctx.shadowColor = 'transparent'
      if (this.unit) {
        const uf = this.unitFont ?? new FontSettings(Math.max(10, R * 0.09), 'normal', t.fontFamily)
        ctx.font = new FontSettings(this.unitFont ? uf.size : Math.max(10, R * 0.09), uf.weight, uf.family).toCSS()
        ctx.fillStyle = t.tickLabelColor.toCSS()
        ctx.fillText(this.unit, cx, vy + vfs * 0.62 + R * 0.04)
      }
    }
    if (needle) this.drawNeedle(ctx, aV, rBar + barT / 2)
    ctx.restore()
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawNeedle(ctx: CanvasRenderingContext2D, a: number, tipMax: number) {
    const t = this.theme
    const { cx, cy, R } = this
    const L = this.needleLength ?? tipMax - 2
    const w = (this.needleThickness ?? Math.max(4, R * 0.045)) / 2
    const tail = R * 0.1
    const ux = Math.cos(a), uy = Math.sin(a)
    const nx = -uy, ny = ux
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(cx + ux * L, cy + uy * L)
    ctx.lineTo(cx + nx * w, cy + ny * w)
    ctx.lineTo(cx - ux * tail + nx * w * 0.6, cy - uy * tail + ny * w * 0.6)
    ctx.lineTo(cx - ux * tail - nx * w * 0.6, cy - uy * tail - ny * w * 0.6)
    ctx.lineTo(cx - nx * w, cy - ny * w)
    ctx.closePath()
    const base = this.needleFill ? this.needleFill.getPrimaryColor() : t.isDark ? new Color(236, 236, 230) : new Color(40, 44, 52)
    if (this.needleFill && !(this.needleFill instanceof SolidFill)) {
      ctx.fillStyle = fillToCanvas(ctx, this.needleFill, cx - L, cy - L, 2 * L, 2 * L) ?? base.toCSS()
    } else {
      const g = ctx.createLinearGradient(cx + nx * w, cy + ny * w, cx - nx * w, cy - ny * w)
      g.addColorStop(0, lighten(base, 0.2).toCSS())
      g.addColorStop(1, darken(base, 0.25).toCSS())
      ctx.fillStyle = g
    }
    ctx.shadowColor = t.isDark ? 'rgba(0,0,0,0.7)' : 'rgba(0,0,0,0.25)'
    ctx.shadowBlur = 8
    ctx.shadowOffsetY = 2
    ctx.fill()
    ctx.shadowColor = 'transparent'
    // Hub.
    const hr = Math.max(5, R * 0.06)
    const hg = ctx.createRadialGradient(cx - hr * 0.3, cy - hr * 0.3, 0, cx, cy, hr)
    hg.addColorStop(0, lighten(base, 0.35).toCSS())
    hg.addColorStop(1, darken(base, 0.35).toCSS())
    ctx.beginPath()
    ctx.arc(cx, cy, hr, 0, Math.PI * 2)
    ctx.fillStyle = hg
    ctx.fill()
    ctx.beginPath()
    ctx.arc(cx, cy, hr * 0.38, 0, Math.PI * 2)
    ctx.fillStyle = this.barColor().toCSS()
    ctx.fill()
    ctx.restore()
  }
}
