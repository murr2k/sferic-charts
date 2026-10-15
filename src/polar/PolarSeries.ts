import { Color } from '../core/color'
import { LegendSymbol, LegendTarget, ShapeName } from '../core/Legend'
import {
  DashedLine, emptyFill, emptyLine, Fill, isEmptyLine, LineStyle, LUT, Mutator, PalettedFill, regularColorSteps, resolve, SolidFill, SolidLine,
} from '../core/style'
import { seriesColor } from '../core/theme'
import { Emitter, Rect } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { HeatmapTexture, PointShapeName } from '../render/draw'
import { DEG, TableRows } from './common'
import { clipToCircle, drawPolarHeatmap, fillColorAt, PxPoints, PxSegments, PxTriangles, triangulate, WHITE, WHITE_COLOR } from './gl'
import type { PolarChart } from './PolarChart'

export interface PolarPoint { angle: number; amplitude: number }

/** Screen mapping of the polar plot (CSS px, y down). */
export interface PolarGeom {
  cx: number
  cy: number
  R: number
  /** Amplitude axis interval. */
  start: number
  end: number
  /** Data angle shown at the top (degrees). */
  north: number
  /** +1 counter-clockwise, -1 clockwise. */
  dir: number
  dpr: number
}

/** Data (angle, amplitude) to CSS px. Amplitudes below the axis start collapse to the center. */
export function polarToPx(g: PolarGeom, angle: number, amp: number): [number, number] {
  const rn = Math.max(0, (amp - g.start) / (g.end - g.start || 1))
  const phi = (90 + (angle - g.north) * g.dir) * DEG
  return [g.cx + rn * g.R * Math.cos(phi), g.cy - rn * g.R * Math.sin(phi)]
}

/** CSS px to data (angle in [0, 360), amplitude) plus the radius in px. */
export function pxToPolar(g: PolarGeom, x: number, y: number) {
  const dx = x - g.cx, dy = g.cy - y
  const r = Math.hypot(dx, dy)
  const phi = Math.atan2(dy, dx) / DEG
  const angle = (((g.north + (phi - 90) * g.dir) % 360) + 360) % 360
  return { angle, amplitude: g.start + (r / (g.R || 1)) * (g.end - g.start), r }
}

export interface PolarHit {
  series: PolarSeries
  angle: number
  amplitude: number
  /** Heatmap intensity. */
  value?: number
  px: number
  py: number
  color: Color
  dist2: number
}

/** Result table builder. */
export class PolarTableBuilder {
  rows: TableRows = []
  addRow(...cells: (string | number | undefined)[]) {
    this.rows.push(cells.filter((c) => c !== undefined).map((c) => String(c)))
    return this
  }
}
export type PolarCursorFormatter = (builder: PolarTableBuilder, series: PolarSeries, angle: number, amplitude: number, value?: number) => PolarTableBuilder

/** Base of every polar series. */
export abstract class PolarSeries extends Emitter implements LegendTarget {
  protected name: string
  protected visible = true
  cursorEnabled = true
  protected effect: boolean | null = null
  protected disposed = false
  protected highlight = 0
  /** Bumped by every change that affects geometry. */
  protected version = 0
  cursorFormatter: PolarCursorFormatter | null = null

  constructor(readonly chart: PolarChart, readonly colorIndex: number, name: string) {
    super()
    this.name = name
  }

  setName(n: string) { this.name = n; this.chart.requestRender(); return this }
  getName() { return this.name }
  setVisible(v: boolean) {
    if (this.visible === v) return this
    this.visible = v
    this.changed()
    this.emit('visiblechange', { isVisible: v })
    return this
  }
  getVisible() { return this.visible }
  isVisible() { return this.visible }
  setEffect(v: boolean) { this.effect = v; this.chart.requestRender(); return this }
  getEffect() { return this.effect ?? this.chart.getTheme().glow.enabled }
  setCursorEnabled(v: boolean) { this.cursorEnabled = v; return this }
  getCursorEnabled() { return this.cursorEnabled }
  setHighlight(v: boolean | number) { this.highlight = typeof v === 'number' ? v : v ? 1 : 0; this.chart.requestRender(); return this }
  setHighlightOnHover(_v: boolean) { return this }
  setCursorResultTableFormatter(f: PolarCursorFormatter | undefined) { this.cursorFormatter = f ?? null; return this }
  dispose() {
    if (this.disposed) return this
    this.disposed = true
    this.chart.removeSeries(this)
    return this
  }
  isDisposed() { return this.disposed }

  protected changed() { this.version++; this.chart.requestRender() }

  /** Amplitude extent for auto-fitting; null when empty. */
  abstract amplitudeBounds(): { min: number; max: number } | null
  /** Rebuild CPU-side geometry if the mapping or data changed. */
  abstract prepare(g: PolarGeom): void
  abstract drawGL(r: GLRenderer, g: PolarGeom): void
  abstract nearest(px: number, py: number, g: PolarGeom): PolarHit | null
  abstract getLegendSymbol(): LegendSymbol
  /** Whether fills are drawn with GPU triangles (needs MSAA). */
  hasFill(): boolean { return false }
  disposeGL(_r: GLRenderer | null): void {}
}

type Preset = 'line' | 'point' | 'pointline' | 'area' | 'polygon'
const PRESET_NAME: Record<Preset, string> = { line: 'Line', point: 'Point', pointline: 'Point Line', area: 'Area', polygon: 'Polygon' }

export interface PolarSeriesOptions {
  automaticColorIndex?: number
  pointShape?: string
  [k: string]: unknown
}

/** Line, point, point-line, area and polygon series share this class (selected by preset). */
export class PolarDataSeries extends PolarSeries {
  protected ang: number[] = []
  protected amp: number[] = []
  protected stroke: LineStyle
  protected pointFill: Fill
  protected pointSize: number
  protected pointShape: PointShapeName = 'circle'
  protected pointStroke: LineStyle = emptyLine
  protected areaFill: Fill
  protected closed: boolean
  private segs = new PxSegments()
  private pts = new PxPoints()
  private tris = new PxTriangles()
  private sx = new Float32Array(0)
  private sy = new Float32Array(0)
  private key = ''

  constructor(chart: PolarChart, colorIndex: number, readonly preset: Preset, o: PolarSeriesOptions = {}) {
    super(chart, colorIndex, `${PRESET_NAME[preset]} ${colorIndex + 1}`)
    const t = chart.getTheme()
    const c = seriesColor(t, colorIndex)
    const solid = new SolidFill({ color: c })
    this.stroke = preset === 'point' ? emptyLine : new SolidLine({ thickness: t.lineThickness, fillStyle: solid })
    this.pointFill = preset === 'point' || preset === 'pointline' ? solid : emptyFill
    this.pointSize = preset === 'pointline' ? t.pointSize + 1 : t.pointSize
    this.areaFill = preset === 'area' || preset === 'polygon' ? new SolidFill({ color: c.setA(t.areaFillAlpha) }) : emptyFill
    this.closed = preset === 'area' || preset === 'polygon'
    if (o.pointShape) this.pointShape = String(o.pointShape).toLowerCase() as PointShapeName
  }

  // ---------------------------------------------------------------- data

  /** Replace all data. */
  setData(points: readonly PolarPoint[]) {
    this.ang = points.map((p) => +p.angle)
    this.amp = points.map((p) => +p.amplitude)
    this.changed()
    return this
  }
  /** Append points. */
  addData(points: readonly PolarPoint[] | PolarPoint) {
    for (const p of Array.isArray(points) ? points : [points]) {
      this.ang.push(+p.angle)
      this.amp.push(+p.amplitude)
    }
    this.changed()
    return this
  }
  appendData(points: readonly PolarPoint[] | PolarPoint) { return this.addData(points) }
  /** Polygon series API. */
  setGeometry(points: readonly PolarPoint[]) { return this.setData(points) }
  getData(): PolarPoint[] { return this.ang.map((a, i) => ({ angle: a, amplitude: this.amp[i] })) }
  getPointAmount() { return this.ang.length }
  clear() { this.ang = []; this.amp = []; this.changed(); return this }

  // ---------------------------------------------------------------- style

  setStrokeStyle(s: Mutator<LineStyle>) { this.stroke = resolve(this.stroke, s); this.changed(); return this }
  getStrokeStyle() { return this.stroke }
  setPointFillStyle(f: Mutator<Fill>) { this.pointFill = resolve(this.pointFill, f); this.changed(); return this }
  getPointFillStyle() { return this.pointFill }
  setPointSize(s: number) { this.pointSize = s; this.changed(); return this }
  getPointSize() { return this.pointSize }
  setPointShape(s: string) { this.pointShape = String(s).toLowerCase() as PointShapeName; this.changed(); return this }
  setPointStrokeStyle(s: Mutator<LineStyle>) { this.pointStroke = resolve(this.pointStroke, s); this.changed(); return this }
  /** Area / polygon fill; on line series the stroke fill, on point series the point fill. */
  setFillStyle(f: Mutator<Fill>) {
    if (this.preset === 'area' || this.preset === 'polygon') this.areaFill = resolve(this.areaFill, f)
    else if (this.preset === 'point') this.pointFill = resolve(this.pointFill, f)
    else this.stroke = this.stroke instanceof SolidLine ? this.stroke.setFillStyle(f) : this.stroke
    this.changed()
    return this
  }
  getFillStyle() { return this.areaFill }
  setAreaFillStyle(f: Mutator<Fill>) { this.areaFill = resolve(this.areaFill, f); this.changed(); return this }
  /** Connect the last point back to the first. */
  setConnectDataAutomaticallyEnabled(v: boolean) { this.closed = v; this.changed(); return this }
  getConnectDataAutomaticallyEnabled() { return this.closed }

  // ---------------------------------------------------------------- rendering

  primaryColor(): Color {
    const f = !isEmptyLine(this.stroke) ? this.stroke.getFillStyle() : this.pointFill.type !== 'empty' ? this.pointFill : this.areaFill
    return f.getPrimaryColor()
  }
  getLegendSymbol(): LegendSymbol {
    const c = this.primaryColor().setA(255)
    if (this.preset === 'point') return { kind: 'point', color: c, shape: this.pointShape as ShapeName }
    if (this.preset === 'area' || this.preset === 'polygon') return { kind: 'rect', color: c }
    return { kind: 'line', color: c }
  }
  override hasFill() { return this.areaFill.type !== 'empty' && this.visible }

  amplitudeBounds() {
    let min = Infinity, max = -Infinity
    for (const v of this.amp) {
      if (!Number.isFinite(v)) continue
      if (v < min) min = v
      if (v > max) max = v
    }
    return min <= max ? { min, max } : null
  }

  private lookup(f: PalettedFill, i: number) { return f.lookUpProperty === 'x' ? this.ang[i] : this.amp[i] }

  prepare(g: PolarGeom) {
    const key = `${g.cx}|${g.cy}|${g.R}|${g.start}|${g.end}|${g.north}|${g.dir}|${g.dpr}|${this.version}`
    if (key === this.key) return
    this.key = key
    const n = this.ang.length
    if (this.sx.length < n) {
      this.sx = new Float32Array(Math.max(n, 16))
      this.sy = new Float32Array(Math.max(n, 16))
    }
    const { sx, sy } = this
    const span = g.end - g.start || 1
    const R = g.R
    for (let i = 0; i < n; i++) {
      const rn = Math.max(0, (this.amp[i] - g.start) / span)
      const phi = (90 + (this.ang[i] - g.north) * g.dir) * DEG
      sx[i] = g.cx + rn * R * Math.cos(phi)
      sy[i] = g.cy - rn * R * Math.sin(phi)
    }
    const box: Rect = { x: g.cx - R, y: g.cy - R, w: 2 * R, h: 2 * R }
    // Stroke: clipped independent segments.
    this.segs.clear()
    if (!isEmptyLine(this.stroke) && n >= 2) {
      const sf = this.stroke.getFillStyle()
      const pal = sf instanceof PalettedFill ? sf : null
      const colorOf = (i: number) => (pal ? pal.lut.getColor(this.lookup(pal, i)).toUint32() : WHITE)
      let cum = 0
      const m = this.closed && n > 2 ? n : n - 1
      for (let i = 0; i < m; i++) {
        const j = (i + 1) % n
        const ax = sx[i] - g.cx, ay = sy[i] - g.cy, bx = sx[j] - g.cx, by = sy[j] - g.cy
        if (!(Number.isFinite(ax) && Number.isFinite(ay) && Number.isFinite(bx) && Number.isFinite(by))) continue
        const len = Math.hypot(bx - ax, by - ay)
        const cl = clipToCircle(ax, ay, bx, by, R)
        if (cl) {
          const [t0, t1] = cl
          this.segs.push(
            g.cx + ax + (bx - ax) * t0, g.cy + ay + (by - ay) * t0,
            g.cx + ax + (bx - ax) * t1, g.cy + ay + (by - ay) * t1,
            colorOf(i), colorOf(j), (cum + len * t0) * g.dpr,
          )
        }
        cum += len
      }
    }
    // Points inside the disc.
    this.pts.clear()
    if (this.pointFill.type !== 'empty' && this.pointSize > 0) {
      const pal = this.pointFill instanceof PalettedFill ? this.pointFill : null
      const R2 = (R + 0.5) * (R + 0.5)
      for (let i = 0; i < n; i++) {
        const dx = sx[i] - g.cx, dy = sy[i] - g.cy
        if (!(dx * dx + dy * dy <= R2)) continue
        this.pts.push(sx[i], sy[i], pal ? pal.lut.getColor(this.lookup(pal, i)).toUint32() : WHITE)
      }
    }
    // Fill: fan from the center (area) or triangulated polygon.
    this.tris.clear()
    if (this.areaFill.type !== 'empty' && n >= 2) {
      const f = this.areaFill
      const cxs = new Float32Array(n), cys = new Float32Array(n)
      for (let i = 0; i < n; i++) {
        let dx = sx[i] - g.cx, dy = sy[i] - g.cy
        const d = Math.hypot(dx, dy)
        if (d > R) { dx *= R / d; dy *= R / d }
        cxs[i] = g.cx + dx
        cys[i] = g.cy + dy
      }
      // Paletted fills are colored per pixel in the shader (see drawGL).
      const col = (i: number) => (f instanceof PalettedFill ? WHITE : fillColorAt(f, cxs[i], cys[i], box, 0).toUint32())
      if (this.preset === 'polygon' && n >= 3) {
        const ok: number[] = []
        for (let i = 0; i < n; i++) if (Number.isFinite(cxs[i]) && Number.isFinite(cys[i])) ok.push(i)
        const px = ok.map((i) => cxs[i]), py = ok.map((i) => cys[i])
        let idx: number[]
        if (ok.length <= 1500) idx = triangulate(px, py, ok.length)
        else {
          idx = []
          for (let i = 1; i + 1 < ok.length; i++) idx.push(0, i, i + 1)
        }
        for (const k of idx) this.tris.push(px[k], py[k], col(ok[k]))
      } else {
        const cc = f instanceof PalettedFill ? WHITE : fillColorAt(f, g.cx, g.cy, box, 0).toUint32()
        const m = this.closed && n > 2 ? n : n - 1
        for (let i = 0; i < m; i++) {
          const j = (i + 1) % n
          if (!(Number.isFinite(cxs[i]) && Number.isFinite(cxs[j]))) continue
          this.tris.push(g.cx, g.cy, cc)
          this.tris.push(cxs[i], cys[i], col(i))
          this.tris.push(cxs[j], cys[j], col(j))
        }
      }
    }
  }

  drawGL(r: GLRenderer, g: PolarGeom) {
    const glow = this.getEffect() ? 1 : 0
    const hl = this.highlight
    const af = this.areaFill
    if (af.type !== 'empty') {
      r.glow = 0
      const lf = af instanceof PalettedFill
        ? { lut: af.lut, by: af.lookUpProperty === 'x' ? 'angle' as const : 'amplitude' as const, ...g }
        : null
      this.tris.draw(r, WHITE_COLOR, lf)
    }
    r.glow = glow
    if (!isEmptyLine(this.stroke)) {
      const f = this.stroke.getFillStyle()
      const th = this.stroke.getThickness()
      this.segs.draw(
        r,
        f instanceof PalettedFill ? WHITE_COLOR : f.getPrimaryColor(),
        hl ? (th < 0 ? 2 : th + 1.5) : th,
        this.stroke instanceof DashedLine ? this.stroke : null,
      )
    }
    if (this.pointFill.type !== 'empty' && this.pointSize > 0) {
      const ps = this.pointStroke
      const pal = this.pointFill instanceof PalettedFill
      this.pts.draw(r, {
        size: this.pointSize + (hl ? 2 : 0),
        shape: this.pointShape,
        color: pal ? WHITE_COLOR : this.pointFill.getPrimaryColor(),
        colored: pal,
        strokeWidth: isEmptyLine(ps) ? 0 : ps.getThickness(),
        strokeColor: isEmptyLine(ps) ? undefined : ps.getFillStyle().getPrimaryColor(),
      })
    }
    r.glow = 0
  }

  nearest(px: number, py: number, g: PolarGeom): PolarHit | null {
    const n = this.ang.length
    if (!n || !this.visible) return null
    let best = -1, bd = Infinity
    const R2 = (g.R + 1) * (g.R + 1)
    for (let i = 0; i < n; i++) {
      const x = this.sx[i], y = this.sy[i]
      const ex = x - g.cx, ey = y - g.cy
      if (!(ex * ex + ey * ey <= R2)) continue
      const d2 = (x - px) * (x - px) + (y - py) * (y - py)
      if (d2 < bd) { bd = d2; best = i }
    }
    if (best < 0) return null
    let color = this.primaryColor()
    const sf = !isEmptyLine(this.stroke) ? this.stroke.getFillStyle() : this.pointFill
    if (sf instanceof PalettedFill) color = sf.lut.getColor(this.lookup(sf, best))
    return { series: this, angle: this.ang[best], amplitude: this.amp[best], px: this.sx[best], py: this.sy[best], color: color.setA(255), dist2: bd }
  }

  override disposeGL(r: GLRenderer | null) {
    this.segs.dispose(r)
    this.pts.dispose(r)
    this.tris.dispose(r)
  }
}

export class PolarLineSeries extends PolarDataSeries {
  constructor(chart: PolarChart, colorIndex: number, o: PolarSeriesOptions = {}) { super(chart, colorIndex, 'line', o) }
}
export class PolarPointSeries extends PolarDataSeries {
  constructor(chart: PolarChart, colorIndex: number, o: PolarSeriesOptions = {}) { super(chart, colorIndex, 'point', o) }
}
export class PolarPointLineSeries extends PolarDataSeries {
  constructor(chart: PolarChart, colorIndex: number, o: PolarSeriesOptions = {}) { super(chart, colorIndex, 'pointline', o) }
}
/** Filled area between the curve and the polar center. */
export class PolarAreaSeries extends PolarDataSeries {
  constructor(chart: PolarChart, colorIndex: number, o: PolarSeriesOptions = {}) { super(chart, colorIndex, 'area', o) }
}
/** Closed, filled polygon (arbitrary simple polygon). */
export class PolarPolygonSeries extends PolarDataSeries {
  constructor(chart: PolarChart, colorIndex: number, o: PolarSeriesOptions = {}) { super(chart, colorIndex, 'polygon', o) }
}

// ------------------------------------------------------------------ heatmap

export interface PolarHeatmapOptions {
  /** Number of angular divisions (rows of the value grid). */
  sectors: number
  /** Number of radial divisions (columns of the value grid). */
  annuli: number
  amplitudeStart?: number
  amplitudeEnd?: number
  /** Amplitude step per annulus; when given, amplitudeEnd defaults to start + annuli * step. */
  amplitudeStep?: number
  automaticColorIndex?: number
  [k: string]: unknown
}

/**
 * Polar heatmap: a sectors x annuli intensity grid rendered on the GPU. The
 * fragment shader converts each pixel to (angle, amplitude) and samples the grid.
 */
export class PolarHeatmapSeries extends PolarSeries {
  readonly sectors: number
  readonly annuli: number
  readonly amplitudeStart: number
  readonly amplitudeEnd: number
  private tex: HeatmapTexture
  private fill: PalettedFill | null = null
  private autoLUT: LUT
  private interp = false
  private opacity = 1
  private dmin = Infinity
  private dmax = -Infinity

  constructor(chart: PolarChart, colorIndex: number, o: PolarHeatmapOptions) {
    super(chart, colorIndex, `Heatmap ${colorIndex + 1}`)
    this.sectors = Math.max(1, o.sectors | 0)
    this.annuli = Math.max(1, o.annuli | 0)
    this.amplitudeStart = o.amplitudeStart ?? 0
    this.amplitudeEnd = o.amplitudeEnd ?? (o.amplitudeStep !== undefined ? this.amplitudeStart + this.annuli * o.amplitudeStep : this.amplitudeStart + 1)
    this.tex = new HeatmapTexture(this.annuli, this.sectors)
    this.autoLUT = this.makeAutoLUT(0, 1)
  }

  private makeAutoLUT(lo: number, hi: number) {
    return new LUT({ steps: regularColorSteps(lo, hi > lo ? hi : lo + 1, this.chart.getTheme().examples.intensityColorPalette), interpolate: true })
  }

  override setName(n: string) {
    this.name = n
    const lg = this.chart.legend
    // LUT legend entries carry their name; re-add to rename.
    if (this.chart.getSeries().includes(this)) {
      lg.remove(this.getLUT())
      lg.add(this.getLUT(), { name: n })
    }
    this.chart.requestRender()
    return this
  }

  /** Intensity values as `values[sector][annulus]`. */
  invalidateIntensityValues(values: ArrayLike<ArrayLike<number>>) {
    let lo = Infinity, hi = -Infinity
    const W = this.annuli
    const data = this.tex.data
    for (let s = 0; s < this.sectors; s++) {
      const row = values[s]
      for (let a = 0; a < W; a++) {
        const v = row ? +row[a] : NaN
        data[s * W + a] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    this.tex.setRowMajor(data)
    if (lo <= hi && (lo !== this.dmin || hi !== this.dmax)) {
      this.dmin = lo
      this.dmax = hi
      if (!this.fill) {
        const old = this.autoLUT
        this.autoLUT = this.makeAutoLUT(lo, hi)
        this.chart.legend.replaceLUT(old, this.autoLUT)
      }
    }
    this.chart.requestRender()
    return this
  }
  setFillStyle(f: Mutator<Fill>) {
    const prev = this.getLUT()
    const nf = resolve<Fill>(this.fill ?? new PalettedFill({ lut: this.autoLUT }), f)
    this.fill = nf instanceof PalettedFill ? nf : null
    this.chart.legend.replaceLUT(prev, this.getLUT())
    this.chart.requestRender()
    return this
  }
  getFillStyle(): Fill { return this.fill ?? new PalettedFill({ lut: this.autoLUT }) }
  getLUT(): LUT { return this.fill?.lut ?? this.autoLUT }
  /** 'bilinear' (or true) smooths between cells; 'disabled' shows discrete cells. */
  setIntensityInterpolation(m: 'disabled' | 'bilinear' | boolean) { this.interp = m === true || m === 'bilinear'; this.chart.requestRender(); return this }
  setOpacity(o: number) { this.opacity = o; this.chart.requestRender(); return this }

  getLegendSymbol(): LegendSymbol {
    const l = this.getLUT()
    return { kind: 'rect', color: l.getColor((l.min + l.max) / 2) }
  }
  amplitudeBounds() { return { min: Math.min(this.amplitudeStart, this.amplitudeEnd), max: Math.max(this.amplitudeStart, this.amplitudeEnd) } }
  prepare(_g: PolarGeom) {}

  drawGL(r: GLRenderer, g: PolarGeom) {
    r.glow = 0
    drawPolarHeatmap(r, this.tex, this.getLUT(), {
      cx: g.cx, cy: g.cy, R: g.R, start: g.start, end: g.end,
      hStart: this.amplitudeStart, hEnd: this.amplitudeEnd,
      north: g.north, dir: g.dir, interpolate: this.interp, opacity: this.opacity,
    })
  }

  /** Intensity at a data position (nearest cell). */
  valueAt(angle: number, amplitude: number): number {
    const an = (amplitude - this.amplitudeStart) / (this.amplitudeEnd - this.amplitudeStart || 1)
    if (!(an >= 0 && an <= 1)) return NaN
    const a = Math.min(this.annuli - 1, Math.floor(an * this.annuli))
    const s = Math.min(this.sectors - 1, Math.floor((((angle % 360) + 360) % 360) / 360 * this.sectors))
    return this.tex.data[s * this.annuli + a]
  }

  nearest(px: number, py: number, g: PolarGeom): PolarHit | null {
    if (!this.visible) return null
    const p = pxToPolar(g, px, py)
    if (p.r > g.R) return null
    const v = this.valueAt(p.angle, p.amplitude)
    if (!Number.isFinite(v)) return null
    return { series: this, angle: p.angle, amplitude: p.amplitude, value: v, px, py, color: this.getLUT().getColor(v).setA(255), dist2: 400 }
  }

  override disposeGL(r: GLRenderer | null) { this.tex.dispose(r) }
}
