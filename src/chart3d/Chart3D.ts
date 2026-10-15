import { Color } from '../core/color'
import { drawMarker, Legend, LegendOptions } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { applyLineToCanvas, LineStyle, LUT, Mutator, resolve, SolidFill, SolidLine } from '../core/style'
import { font } from '../core/theme'
import { Rect, rectContains, roundRect, textWidth, Tween } from '../core/util'
import { GLRenderer, getRenderer } from '../render/GLRenderer'
import type { PointerInfo, Surface } from '../render/Surface'
import { Axis3D, Axis3DHost } from './Axis3D'
import { Frame3D } from './gl3d'
import { lookAt, mat4, multiply, perspective, Point3D, toF32 } from './math3d'
import { Hit3D, LineSeries3D, PointLineSeries3D, PointSeries3D, PointSeries3DOptions, Series3D, Series3DOptions } from './series3d'
import {
  SurfaceGridSeries3D, SurfaceGridSeries3DOptions, SurfaceScrollingGridSeries3D, SurfaceScrollingGridSeries3DOptions,
} from './surface3d'
import { BoxSeries3D, MeshModel3D } from './mesh3d'

export interface Chart3DOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  animationsEnabled?: boolean
  [k: string]: unknown
}

export type Cursor3DMode = 'show-nearest' | 'disabled' | undefined
export type Cursor3DRows = (string | { text: string; color?: Color })[][]

type V3 = [number, number, number]
type Drag =
  | { kind: 'none' }
  | { kind: 'rotate'; x: number; y: number }
  | { kind: 'pan'; x: number; y: number }
  | { kind: 'pinch'; d: number }

/** Placement of one axis on a box edge, in world and screen space. */
interface AxisEdge {
  /** World points at axis start / end. */
  a: V3
  b: V3
  /** Outward screen direction for ticks and labels (unit). */
  out: [number, number]
  len: number
}

const DEG = Math.PI / 180
const DEFAULT_YAW = 30 * DEG
const DEFAULT_PITCH = 22 * DEG
const FOV = 28 * DEG
const TICK = 6
const GAP = 5

/**
 * 3D chart: orbit camera, axis box with grid walls, and
 * point, line, surface, mesh and box series. Y is up; Z increases away from the default camera.
 */
export class Chart3D extends Panel implements Axis3DHost {
  readonly axes: [Axis3D, Axis3D, Axis3D]
  readonly series: Series3D[] = []
  readonly legend: Legend
  /** Area holding the 3D view (CSS px). */
  plot: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private dims: V3 = [1, 1, 1]
  private yaw = DEFAULT_YAW
  private pitch = DEFAULT_PITCH
  private zoom = 1
  private pan: V3 = [0, 0, 0]
  private camDistance: number | null = null
  private autoFit = true
  private frame: Frame3D | null = null
  private eye: V3 = [0, 0, 1]
  private basis = { right: [1, 0, 0] as V3, up: [0, 1, 0] as V3 }
  private dist = 1
  private edges: (AxisEdge | null)[] = [null, null, null]
  private colorCounter = 0
  private cursorMode: Cursor3DMode = 'show-nearest'
  private cursorFormatter: ((chart: Chart3D, hit: Hit3D) => Cursor3DRows) | null = null
  private pointer: { x: number; y: number } | null = null
  private drag: Drag = { kind: 'none' }
  private hit: Hit3D | null = null
  private interactionsEnabled = true
  private boxStroke: LineStyle | null = null
  private lutEntries = new Map<Series3D, LUT>()
  // reusable matrices
  private mView = mat4()
  private mProj = mat4()
  private mTmp = mat4()
  private mRect = mat4()
  private fView = new Float32Array(16)
  private fProj = new Float32Array(16)
  private mCss = mat4()

  constructor(o: Chart3DOptions = {}) {
    super(o)
    this.legend = new Legend(this, o.legend)
    this.axes = [new Axis3D(this, 'x'), new Axis3D(this, 'y'), new Axis3D(this, 'z')]
    if (o.animationsEnabled === false) this.setAnimationsEnabled(false)
  }

  override wantsMSAA() { return true }

  // ---------------------------------------------------------------- axes

  get axisX() { return this.axes[0] }
  get axisY() { return this.axes[1] }
  get axisZ() { return this.axes[2] }
  getDefaultAxisX() { return this.axes[0] }
  getDefaultAxisY() { return this.axes[1] }
  getDefaultAxisZ() { return this.axes[2] }
  getDefaultAxes() { return [...this.axes] }
  forEachAxis(cb: (a: Axis3D) => void) { this.axes.forEach(cb) }
  /** @internal */
  addTween(t: Tween) { this.animate(t) }
  /** @internal */
  onAxisIntervalChanged(_a: Axis3D) { this.requestRender() }
  /** Fit all axes to the data. */
  fit(animate: boolean | number = true) { this.axes.forEach((a) => a.fit(animate)); return this }
  setAnimationsEnabled(v: boolean) { this.axes.forEach((a) => a.setAnimationsEnabled(v)); return this }

  dataExtent(axis: Axis3D): { min: number; max: number } {
    let min = Infinity, max = -Infinity
    const k = axis.dim
    for (const s of this.series) {
      if (!s.getVisible() || !s.autoScroll) continue
      const b = s.bounds()
      if (!b) continue
      const lo = k === 'x' ? b.xmin : k === 'y' ? b.ymin : b.zmin
      const hi = k === 'x' ? b.xmax : k === 'y' ? b.ymax : b.zmax
      if (lo < min) min = lo
      if (hi > max) max = hi
    }
    return { min, max }
  }

  // ---------------------------------------------------------------- camera / box

  /** Relative proportions of the axis box (world units, default 1 x 1 x 1). */
  setBoundingBox(d: Partial<Point3D>) {
    const x = d.x ?? this.dims[0], y = d.y ?? this.dims[1], z = d.z ?? this.dims[2]
    if (x > 0 && y > 0 && z > 0) this.dims = [x, y, z]
    this.requestRender()
    return this
  }
  getBoundingBox(): Point3D { return { x: this.dims[0], y: this.dims[1], z: this.dims[2] } }
  setBoundingBoxStrokeStyle(l: Mutator<LineStyle>) {
    const base = this.boxStroke ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.chart3D.boundingBoxColor }) })
    this.boxStroke = resolve(base, l)
    this.requestRender()
    return this
  }

  /**
   * Camera position in world space (the axis box is centered at the origin, +Y up,
   * +Z towards the default viewer). The camera always looks at the box center.
   */
  setCameraLocation(p: Point3D) {
    const d = Math.hypot(p.x, p.y, p.z)
    if (!(d > 0)) return this
    this.yaw = Math.atan2(p.x, p.z)
    this.pitch = clampPitch(Math.asin(p.y / d))
    this.camDistance = d
    this.zoom = 1
    this.requestRender()
    return this
  }
  getCameraLocation(): Point3D { return { x: this.eye[0], y: this.eye[1], z: this.eye[2] } }
  /** When enabled (default), camera distance adapts so the axis box fills the view. */
  setCameraAutomaticFittingEnabled(v: boolean) {
    this.autoFit = v
    if (!v && this.camDistance === null) this.camDistance = this.dist * this.zoom
    this.requestRender()
    return this
  }
  getCameraAutomaticFittingEnabled() { return this.autoFit }
  /** Reset rotation, zoom and pan to the defaults. */
  resetCamera() {
    this.yaw = DEFAULT_YAW
    this.pitch = DEFAULT_PITCH
    this.zoom = 1
    this.pan = [0, 0, 0]
    this.requestRender()
    return this
  }

  // ---------------------------------------------------------------- series

  private nextColor(o: { automaticColorIndex?: number }) { return o.automaticColorIndex ?? this.colorCounter++ }
  private attach<T extends Series3D>(s: T): T {
    this.series.push(s)
    if (this.legend.autoAdd) {
      this.legend.add(s)
      const lut = s.legendLUT()
      if (lut) {
        this.legend.add(lut)
        this.lutEntries.set(s, lut)
      }
    }
    this.requestRender()
    return s
  }
  addPointSeries(o: PointSeries3DOptions = {}) { return this.attach(new PointSeries3D(this, this.nextColor(o), o)) }
  addLineSeries(o: Series3DOptions = {}) { return this.attach(new LineSeries3D(this, this.nextColor(o), o)) }
  addPointLineSeries(o: Series3DOptions = {}) { return this.attach(new PointLineSeries3D(this, this.nextColor(o), o)) }
  addSurfaceGridSeries(o: SurfaceGridSeries3DOptions) {
    this.checkTexture(Math.max(o.columns, o.rows))
    return this.attach(new SurfaceGridSeries3D(this, this.nextColor(o), o))
  }
  addSurfaceScrollingGridSeries(o: SurfaceScrollingGridSeries3DOptions) {
    this.checkTexture(Math.max(o.columns, o.rows))
    return this.attach(new SurfaceScrollingGridSeries3D(this, this.nextColor(o), o))
  }
  addMeshModel(o: Series3DOptions = {}) { return this.attach(new MeshModel3D(this, this.nextColor(o), o)) }
  addBoxSeries(o: Series3DOptions = {}) { return this.attach(new BoxSeries3D(this, this.nextColor(o), o)) }
  private checkTexture(n: number) {
    const max = getRenderer().maxTextureSize
    if (n > max) throw new Error(`sferic: 3D surface dimension ${n} exceeds max texture size ${max}`)
  }

  getSeries() { return [...this.series] }
  removeSeries(s: Series3D) {
    const i = this.series.indexOf(s)
    if (i < 0) return
    this.series.splice(i, 1)
    this.legend.remove(s)
    const lut = this.lutEntries.get(s)
    if (lut) this.legend.remove(lut)
    this.lutEntries.delete(s)
    let r: GLRenderer | null = null
    try { r = getRenderer() } catch { r = null }
    s.disposeGL(r)
    if (this.hit?.series === s) this.hit = null
    this.requestRender()
  }
  /** @internal */
  onSeriesData(_s: Series3D) { this.requestRender() }
  /** @internal Keep the legend color bar in sync with a series' palette. */
  onSeriesStyle(s: Series3D) {
    const old = this.lutEntries.get(s) ?? null
    const next = s.legendLUT()
    if (old !== next && this.legend.autoAdd && this.series.includes(s)) {
      if (old && next) this.legend.replaceLUT(old, next)
      else if (old) this.legend.remove(old)
      else if (next) this.legend.add(next)
      if (next) this.lutEntries.set(s, next)
      else this.lutEntries.delete(s)
    }
    this.requestRender()
  }

  // ---------------------------------------------------------------- cursor / interaction config

  setCursorMode(m: Cursor3DMode) { this.cursorMode = m ?? 'disabled'; this.requestRender(); return this }
  getCursorMode() { return this.cursorMode }
  /** Custom result table rows for the hovered sample. */
  setCursorFormatting(f: ((chart: Chart3D, hit: Hit3D) => Cursor3DRows) | undefined) { this.cursorFormatter = f ?? null; return this }
  setMouseInteractions(v: boolean) { this.interactionsEnabled = v; return this }
  setUserInteractions(v: boolean | Record<string, unknown> | undefined) { this.interactionsEnabled = v !== false && v !== undefined; return this }

  // ---------------------------------------------------------------- layout

  override layout(_ctx: CanvasRenderingContext2D) {
    for (const a of this.axes) {
      const e = this.dataExtent(a)
      a.updateScroll(e.min, e.max)
    }
    const content = this.layoutBase()
    this.plot = this.legend.layout(content)
    this.frame = this.computeFrame()
    if (this.frame) this.placeAxes()
    this.updateCursor()
  }

  /** World dims normalized so the largest side is 1. */
  private worldDims(): V3 {
    const m = Math.max(...this.dims)
    return [this.dims[0] / m, this.dims[1] / m, this.dims[2] / m]
  }

  private computeFrame(): Frame3D | null {
    const rect = this.plot
    if (rect.w < 20 || rect.h < 20) return null
    const D = this.worldDims()
    const fs = this.theme.fontSize
    const tanV = Math.tan(FOV / 2)
    const aspect = rect.w / rect.h
    const tanH = tanV * aspect
    // Leave room around the box for tick labels and titles.
    const mx = Math.min(rect.w * 0.14, fs * 4.8), my = Math.min(rect.h * 0.13, fs * 3.6)
    const fh = tanH * (rect.w - 2 * mx) / rect.w, fv = tanV * (rect.h - 2 * my) / rect.h
    const dir = dirOf(this.yaw, this.pitch)
    const dFit = fitDistance(dir, D, fh, fv)
    const dRef = fitDistance(dirOf(DEFAULT_YAW, DEFAULT_PITCH), D, fh, fv)
    const dist = (this.autoFit || this.camDistance === null ? dFit : this.camDistance) / this.zoom
    this.dist = dist
    const t = this.pan
    const eye: V3 = [t[0] + dir[0] * dist, t[1] + dir[1] * dist, t[2] + dir[2] * dist]
    this.eye = eye
    lookAt(this.mView, eye, t, [0, 1, 0])
    const v = this.mView
    this.basis = { right: [v[0], v[4], v[8]], up: [v[1], v[5], v[9]] }
    const R = 0.5 * Math.hypot(D[0], D[1], D[2])
    const ec = Math.hypot(eye[0], eye[1], eye[2])
    const near = Math.max(ec - R * 2.2, ec * 0.002, 1e-4)
    const far = ec + R * 2.2
    perspective(this.mProj, FOV, aspect, near, far)
    // Fold the plot rect into the projection so GL keeps the full-surface viewport.
    const W = this.surface.cssW || rect.w, H = this.surface.cssH || rect.h
    const m = this.mRect
    m.fill(0)
    m[0] = rect.w / W
    m[5] = rect.h / H
    m[10] = 1
    m[15] = 1
    m[12] = (2 * rect.x + rect.w) / W - 1
    m[13] = 1 - (2 * rect.y + rect.h) / H
    multiply(this.mTmp, m, this.mProj)
    toF32(this.mTmp, this.fProj)
    toF32(this.mView, this.fView)
    // World -> CSS px.
    const s = this.mRect
    s.fill(0)
    s[0] = rect.w / 2
    s[5] = -rect.h / 2
    s[10] = 1
    s[15] = 1
    s[12] = rect.x + rect.w / 2
    s[13] = rect.y + rect.h / 2
    multiply(this.mTmp, s, this.mProj)
    multiply(this.mCss, this.mTmp, this.mView)
    const dpr = this.surface.dpr || 1
    const L = norm([-0.35, 0.62, 0.7])
    return {
      view: this.fView,
      proj: this.fProj,
      worldToCss: this.mCss,
      dims: D,
      axes: this.axes,
      worldPerPx: (2 * dRef * tanV) / rect.h,
      pxScale: (rect.h * dpr) / (2 * tanV),
      dpr,
      rect,
      light: L,
      res: [Math.round(W * dpr), Math.round(H * dpr)],
      eye,
      right: this.basis.right,
      up: this.basis.up,
      fwd: [-dir[0], -dir[1], -dir[2]],
      tanH,
      tanV,
    }
  }

  /** Homogeneous CSS projection of a world point: [x*w, y*w, w]. */
  private hp(p: ArrayLike<number>): V3 {
    const m = this.mCss
    return [
      m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
      m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
      m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15],
    ]
  }
  private project(p: ArrayLike<number>): [number, number, number] | null {
    const h = this.hp(p)
    return h[2] > 1e-6 ? [h[0] / h[2], h[1] / h[2], h[2]] : null
  }
  /** Segment projected with near-plane clipping. */
  private segment(a: ArrayLike<number>, b: ArrayLike<number>): [number, number, number, number] | null {
    let A = this.hp(a), B = this.hp(b)
    const e = 1e-5
    if (A[2] < e && B[2] < e) return null
    if (A[2] < e) A = lerp3(A, B, (e - A[2]) / (B[2] - A[2]))
    if (B[2] < e) B = lerp3(B, A, (e - B[2]) / (A[2] - B[2]))
    return [A[0] / A[2], A[1] / A[2], B[0] / B[2], B[1] / B[2]]
  }
  /** Polygon projected with near-plane clipping. */
  private polygon(pts: V3[]): [number, number][] {
    const hs = pts.map((p) => this.hp(p))
    const out: [number, number][] = []
    const e = 1e-5
    for (let i = 0; i < hs.length; i++) {
      const A = hs[i], B = hs[(i + 1) % hs.length]
      const ain = A[2] >= e, bin = B[2] >= e
      if (ain) out.push([A[0] / A[2], A[1] / A[2]])
      if (ain !== bin) {
        const q = lerp3(A, B, (e - A[2]) / (B[2] - A[2]))
        out.push([q[0] / q[2], q[1] / q[2]])
      }
    }
    return out
  }

  /** Face (axis k, side s) faces the camera. */
  private faceFront(k: number, s: number) {
    const D = this.frame!.dims
    return s * this.eye[k] > D[k] / 2
  }

  /** World coordinate of normalized axis position t on axis k. */
  private axisWorld(k: number, t: number) {
    const D = this.frame!.dims
    return k === 2 ? (0.5 - t) * D[2] : (t - 0.5) * D[k]
  }

  /** Point on an edge parallel to axis k with the other axes at world sides si, sj. */
  private edgePoint(k: number, si: number, sj: number, t: number): V3 {
    const D = this.frame!.dims
    const [i, j] = others(k)
    const p: V3 = [0, 0, 0]
    p[k] = this.axisWorld(k, t)
    p[i] = (si * D[i]) / 2
    p[j] = (sj * D[j]) / 2
    return p
  }

  private placeAxes() {
    const center = this.project([0, 0, 0])
    for (let k = 0; k < 3; k++) {
      const [i, j] = others(k)
      let best: { si: number; sj: number; score: number; sil: boolean } | null = null
      for (const si of [-1, 1])
        for (const sj of [-1, 1]) {
          const sil = this.faceFront(i, si) !== this.faceFront(j, sj)
          const a = this.project(this.edgePoint(k, si, sj, 0)), b = this.project(this.edgePoint(k, si, sj, 1))
          if (!a || !b) continue
          // X/Z: lowest edge on screen; Y: leftmost.
          const score = k === 1 ? -(a[0] + b[0]) / 2 : (a[1] + b[1]) / 2
          if (!best || (sil && !best.sil) || (sil === best.sil && score > best.score)) best = { si, sj, score, sil }
        }
      if (!best) { this.edges[k] = null; continue }
      const A = this.edgePoint(k, best.si, best.sj, 0), B = this.edgePoint(k, best.si, best.sj, 1)
      const a = this.project(A)!, b = this.project(B)!
      const dx = b[0] - a[0], dy = b[1] - a[1]
      const len = Math.hypot(dx, dy)
      let out: [number, number] = len > 1e-6 ? [-dy / len, dx / len] : [0, 1]
      if (center) {
        const mx = (a[0] + b[0]) / 2 - center[0], my = (a[1] + b[1]) / 2 - center[1]
        if (out[0] * mx + out[1] * my < 0) out = [-out[0], -out[1]]
      }
      this.edges[k] = { a: A, b: B, out, len }
      // Oblique edges fit labels more densely than the 2D spacing rules assume.
      const horiz = Math.abs(dx) >= Math.abs(dy)
      this.axes[k].computeTicks(horiz ? len * 1.6 : len, horiz)
    }
  }

  // ---------------------------------------------------------------- drawing

  private boxLine(): LineStyle {
    return this.boxStroke ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.chart3D.boundingBoxColor }) })
  }

  /** The 12 box edges, split into back (both faces away) and the rest. */
  private boxEdges(back: boolean): [V3, V3][] {
    const out: [V3, V3][] = []
    for (let k = 0; k < 3; k++) {
      const [i, j] = others(k)
      for (const si of [-1, 1])
        for (const sj of [-1, 1]) {
          const isBack = !this.faceFront(i, si) && !this.faceFront(j, sj)
          if (isBack === back) out.push([this.edgePoint(k, si, sj, 0), this.edgePoint(k, si, sj, 1)])
        }
    }
    return out
  }

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const f = this.frame
    if (!f) return
    const t = this.theme
    const D = f.dims
    ctx.save()
    ctx.beginPath()
    ctx.rect(this.plot.x, this.plot.y, this.plot.w, this.plot.h)
    ctx.clip()
    ctx.lineWidth = 1
    for (let k = 0; k < 3; k++) {
      for (const s of [-1, 1]) {
        if (this.faceFront(k, s)) continue
        const [i, j] = others(k)
        const corner = (a: number, b: number): V3 => {
          const p: V3 = [0, 0, 0]
          p[k] = (s * D[k]) / 2
          p[i] = (a * D[i]) / 2
          p[j] = (b * D[j]) / 2
          return p
        }
        const poly = this.polygon([corner(-1, -1), corner(1, -1), corner(1, 1), corner(-1, 1)])
        if (poly.length >= 3) {
          ctx.beginPath()
          poly.forEach(([x, y], n) => (n ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
          ctx.closePath()
          ctx.fillStyle = t.chart3D.wallFill.toCSS()
          ctx.fill()
        }
        // Grid lines of the two in-plane axes.
        ctx.strokeStyle = t.gridMajorColor.toCSS()
        ctx.beginPath()
        for (const [g, h] of [[i, j], [j, i]]) {
          const ax = this.axes[g]
          if (!ax.strategy.majorGridVisible) continue
          for (const tk of ax.ticks) {
            if (tk.level !== 0) continue
            const tn = ax.norm(tk.value)
            if (tn < -1e-6 || tn > 1 + 1e-6) continue
            const p0: V3 = [0, 0, 0], p1: V3 = [0, 0, 0]
            p0[k] = p1[k] = (s * D[k]) / 2
            p0[g] = p1[g] = this.axisWorld(g, tn)
            p0[h] = -D[h] / 2
            p1[h] = D[h] / 2
            const sg = this.segment(p0, p1)
            if (!sg) continue
            ctx.moveTo(sg[0], sg[1])
            ctx.lineTo(sg[2], sg[3])
          }
        }
        ctx.stroke()
      }
    }
    if (applyLineToCanvas(ctx, this.boxLine())) this.strokeEdges(ctx, this.boxEdges(true))
    ctx.restore()
  }

  private strokeEdges(ctx: CanvasRenderingContext2D, edges: [V3, V3][]) {
    ctx.beginPath()
    for (const [a, b] of edges) {
      const s = this.segment(a, b)
      if (!s) continue
      ctx.moveTo(s[0], s[1])
      ctx.lineTo(s[2], s[3])
    }
    ctx.stroke()
  }

  override hasGL() { return this.series.length > 0 }

  override drawGL(r: GLRenderer) {
    const f = this.frame
    if (!f) return
    const gl = r.gl
    f.res = [r.w, r.h]
    f.dpr = r.dpr
    r.scissor(this.plot)
    gl.enable(gl.DEPTH_TEST)
    gl.depthFunc(gl.LEQUAL)
    gl.depthMask(true)
    const vis = this.series.filter((s) => s.getVisible())
    for (const pass of [false, true]) {
      gl.depthMask(!pass)
      for (const s of vis) {
        if (s.isTransparent() !== pass) continue
        r.glow = s.getEffect() ? 1 : 0
        s.drawGL(r, f)
      }
    }
    gl.depthMask(true)
    gl.disable(gl.DEPTH_TEST)
    r.scissor(null)
    r.glow = 0
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const f = this.frame
    if (f) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(this.plot.x, this.plot.y, this.plot.w, this.plot.h)
      ctx.clip()
      if (applyLineToCanvas(ctx, this.boxLine())) this.strokeEdges(ctx, this.boxEdges(false))
      ctx.restore()
      this.drawAxes(ctx)
      this.drawCursor(ctx)
    }
    this.legend.draw(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawAxes(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = t.fontSize
    const placed: Rect[] = []
    const overlaps = (r: Rect) => placed.some((q) => r.x < q.x + q.w && q.x < r.x + r.w && r.y < q.y + q.h && q.y < r.y + r.h)
    ctx.save()
    ctx.beginPath()
    ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h)
    ctx.clip()
    ctx.lineWidth = 1
    ctx.setLineDash([])
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let k = 0; k < 3; k++) {
      const ax = this.axes[k]
      const e = this.edges[k]
      if (!ax.visible || !e || e.len < 8) continue
      const [ox, oy] = e.out
      let extent = 0
      // ticks
      ctx.strokeStyle = t.tickColor.toCSS()
      ctx.beginPath()
      const labels: { x: number; y: number; text: string }[] = []
      for (const tk of ax.ticks) {
        if (tk.level !== 0 && !ax.strategy.minorTicksVisible) continue
        const tn = ax.norm(tk.value)
        if (tn < -1e-6 || tn > 1 + 1e-6) continue
        const p = this.project(lerpV(e.a, e.b, tn))
        if (!p) continue
        const len = tk.level === 0 ? TICK : TICK / 2
        if (tk.level === 0 ? ax.strategy.majorTicksVisible : ax.strategy.minorTicksVisible) {
          ctx.moveTo(p[0], p[1])
          ctx.lineTo(p[0] + ox * len, p[1] + oy * len)
        }
        if (tk.label && tk.level === 0 && ax.labelsVisible) labels.push({ x: p[0], y: p[1], text: tk.label })
      }
      ctx.stroke()
      // labels, centered just beyond the tick along the outward direction
      ctx.font = font(t, fs)
      ctx.fillStyle = (ax.labelColor ?? t.tickLabelColor).toCSS()
      for (const l of labels) {
        const w = textWidth(l.text, ctx.font), h = fs
        const ext = Math.abs(ox) * w / 2 + Math.abs(oy) * h / 2
        const cx = l.x + ox * (TICK + GAP + ext), cy = l.y + oy * (TICK + GAP + ext)
        const box = { x: cx - w / 2 - 2, y: cy - h / 2 - 1, w: w + 4, h: h + 2 }
        if (overlaps(box)) continue
        placed.push(box)
        ctx.fillText(l.text, cx, cy + 0.5)
        extent = Math.max(extent, 2 * ext)
      }
      // title, rotated along the edge
      const title = ax.titleText()
      if (title) {
        const a = this.project(e.a), b = this.project(e.b)
        if (!a || !b) continue
        let ang = Math.atan2(b[1] - a[1], b[0] - a[0])
        if (ang > Math.PI / 2 + 1e-3) ang -= Math.PI
        else if (ang < -Math.PI / 2 - 1e-3) ang += Math.PI
        if (Math.abs(Math.abs(ang) - Math.PI / 2) < 0.02) ang = -Math.PI / 2
        // Extent of the rotated title box along the outward direction.
        ctx.font = font(t, fs)
        const tw = textWidth(title, ctx.font)
        const ca = Math.cos(ang), sa = Math.sin(ang)
        const text = Math.abs(ox * ca + oy * sa) * tw / 2 + Math.abs(-ox * sa + oy * ca) * fs / 2
        const off = TICK + GAP + extent + 6 + text
        const mx = (a[0] + b[0]) / 2 + ox * off, my = (a[1] + b[1]) / 2 + oy * off
        ctx.save()
        ctx.translate(mx, my)
        ctx.rotate(ang)
        ctx.fillStyle = (ax.titleColor ?? t.axisTitleColor).toCSS()
        ctx.fillText(title, 0, 0.5)
        ctx.restore()
      }
    }
    ctx.restore()
  }

  // ---------------------------------------------------------------- cursor

  private updateCursor() {
    this.hit = null
    const f = this.frame
    if (!f || !this.pointer || this.cursorMode === 'disabled' || this.cursorMode === undefined || this.drag.kind !== 'none') return
    const { x, y } = this.pointer
    if (!rectContains(this.plot, x, y)) return
    let best: Hit3D | null = null
    for (const s of this.series) {
      if (!s.getVisible() || !s.cursorEnabled) continue
      const h = s.pick(x, y, f)
      if (!h) continue
      if (!best || h.d2 + 4 < best.d2 || (Math.abs(h.d2 - best.d2) <= 4 && h.w < best.w)) best = h
    }
    this.hit = best
  }

  private drawCursor(ctx: CanvasRenderingContext2D) {
    const h = this.hit
    if (!h) return
    const t = this.theme
    ctx.save()
    // Drop line to the floor of the box for depth reference.
    const ay = this.axes[1]
    const fy = this.project(this.dataWorld(h.x, ay.start, h.z))
    if (fy) {
      ctx.strokeStyle = t.cursor.lineColor.toCSS()
      ctx.setLineDash([4, 4])
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(h.sx, h.sy)
      ctx.lineTo(fy[0], fy[1])
      ctx.stroke()
      ctx.setLineDash([])
      ctx.beginPath()
      ctx.arc(fy[0], fy[1], 2.5, 0, Math.PI * 2)
      ctx.fillStyle = t.cursor.lineColor.toCSS()
      ctx.fill()
    }
    ctx.beginPath()
    ctx.arc(h.sx, h.sy, 7, 0, Math.PI * 2)
    ctx.strokeStyle = t.isDark ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.65)'
    ctx.lineWidth = 1.5
    ctx.stroke()
    drawMarker(ctx, 'circle', h.sx, h.sy, 3.5, h.color, false)
    this.drawResultTable(ctx, h)
    ctx.restore()
  }

  private dataWorld(x: number, y: number, z: number): V3 {
    const [ax, ay, az] = this.axes
    return [this.axisWorld(0, ax.norm(x)), this.axisWorld(1, ay.norm(y)), this.axisWorld(2, az.norm(z))]
  }

  private drawResultTable(ctx: CanvasRenderingContext2D, h: Hit3D) {
    const t = this.theme
    const fs = t.fontSize
    const [ax, ay, az] = this.axes
    let rows: Cursor3DRows
    if (this.cursorFormatter) rows = this.cursorFormatter(this, h)
    else {
      rows = [[{ text: h.series.getName(), color: h.color }]]
      rows.push([(ax.title || 'X') + ':', ax.formatCursor(h.x)])
      rows.push([(ay.title || 'Y') + ':', ay.formatCursor(h.y)])
      rows.push([(az.title || 'Z') + ':', az.formatCursor(h.z)])
      if (h.value !== undefined && Number.isFinite(h.value)) rows.push(['Value:', String(+h.value.toPrecision(5))])
      if (h.extra) for (const [k, v] of h.extra) rows.push([k + ':', v])
    }
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
    const ht = rows.length * lh + pad * 2 - (lh - fs)
    let x = h.sx + 16, y = h.sy - ht - 12
    const R = this.rect
    if (x + w > R.x + R.w - 4) x = h.sx - w - 16
    if (y < R.y + 4) y = h.sy + 16
    if (y + ht > R.y + R.h - 4) y = R.y + R.h - ht - 4
    roundRect(ctx, x, y, w, ht, 5)
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

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    if (e.type === 'click') return this.legend.onPointer('click', x, y)
    if (e.type === 'move' && this.drag.kind === 'none' && this.legend.onPointer('move', x, y)) {
      this.surface.setCursor('pointer')
      this.pointer = null
      return true
    }
    if (e.type === 'down' && this.legend.contains(x, y)) return true
    const inPlot = rectContains(this.plot, x, y)
    switch (e.type) {
      case 'down': {
        if (!inPlot || !this.interactionsEnabled) return false
        if (e.pointers.size >= 2) {
          const p = [...e.pointers.values()]
          this.drag = { kind: 'pinch', d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) }
        } else if (e.button === 0 && !e.shiftKey) this.drag = { kind: 'rotate', x, y }
        else this.drag = { kind: 'pan', x, y }
        this.surface.setCursor(this.drag.kind === 'pan' ? 'move' : 'grabbing')
        this.hit = null
        return true
      }
      case 'move': {
        const d = this.drag
        if (d.kind === 'rotate') {
          this.yaw -= (x - d.x) * 0.0075
          this.pitch = clampPitch(this.pitch + (y - d.y) * 0.0075)
          d.x = x
          d.y = y
          return true
        }
        if (d.kind === 'pan') {
          const k = (2 * this.dist * Math.tan(FOV / 2)) / Math.max(1, this.plot.h)
          const { right, up } = this.basis
          const dx = (x - d.x) * k, dy = (y - d.y) * k
          for (let i = 0; i < 3; i++) this.pan[i] += -right[i] * dx + up[i] * dy
          d.x = x
          d.y = y
          return true
        }
        if (d.kind === 'pinch') {
          const p = [...e.pointers.values()]
          if (p.length >= 2) {
            const nd = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y)
            this.zoom = clampZoom(this.zoom * (nd / (d.d || 1)))
            d.d = nd
          }
          return true
        }
        const had = !!this.pointer
        this.pointer = inPlot ? { x, y } : null
        this.surface.setCursor(inPlot && this.interactionsEnabled ? 'grab' : 'default')
        return (had || inPlot) && this.cursorMode !== 'disabled'
      }
      case 'up': {
        const was = this.drag.kind !== 'none'
        this.drag = { kind: 'none' }
        if (was) this.surface.setCursor(inPlot ? 'grab' : 'default')
        return was
      }
      case 'wheel': {
        if (!inPlot || !this.interactionsEnabled) return false
        const ev = e.native as WheelEvent
        const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
        this.zoom = clampZoom(this.zoom * Math.exp(-Math.max(-300, Math.min(300, e.deltaY * mult)) * 0.0015))
        return true
      }
      case 'dblclick': {
        if (!inPlot || !this.interactionsEnabled) return false
        this.resetCamera()
        this.fit(true)
        return true
      }
      case 'leave':
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

// ------------------------------------------------------------------ helpers

const others = (k: number): [number, number] => (k === 0 ? [1, 2] : k === 1 ? [0, 2] : [0, 1])
const clampPitch = (p: number) => Math.max(-89 * DEG, Math.min(89 * DEG, p))
const clampZoom = (z: number) => Math.max(0.15, Math.min(25, z))
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const lerpV = (a: V3, b: V3, t: number): V3 => lerp3(a, b, t)
const norm = (v: V3): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

/** Unit vector from the target towards the camera. */
function dirOf(yaw: number, pitch: number): V3 {
  return [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)]
}

/** Smallest camera distance along `dir` at which all 8 box corners fit the given half-FOV tangents. */
function fitDistance(dir: V3, D: V3, tanH: number, tanV: number): number {
  const up: V3 = [0, 1, 0]
  let rx = up[1] * dir[2] - up[2] * dir[1], ry = up[2] * dir[0] - up[0] * dir[2], rz = up[0] * dir[1] - up[1] * dir[0]
  const rl = Math.hypot(rx, ry, rz) || 1
  rx /= rl; ry /= rl; rz /= rl
  const ux = dir[1] * rz - dir[2] * ry, uy = dir[2] * rx - dir[0] * rz, uz = dir[0] * ry - dir[1] * rx
  let d = 0
  for (const sx of [-1, 1])
    for (const sy of [-1, 1])
      for (const sz of [-1, 1]) {
        const cx = (sx * D[0]) / 2, cy = (sy * D[1]) / 2, cz = (sz * D[2]) / 2
        const px = cx * rx + cy * ry + cz * rz
        const py = cx * ux + cy * uy + cz * uz
        const pf = cx * dir[0] + cy * dir[1] + cz * dir[2]
        d = Math.max(d, Math.abs(px) / tanH + pf, Math.abs(py) / tanV + pf)
      }
  return Math.max(d, 1e-3)
}

