import { Color, ColorRGBA } from '../core/color'
import { Legend, LegendOptions } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import {
  applyLineToCanvas, Fill, fillToCanvas, isEmptyLine, LineStyle, LUT, Mutator, PalettedFill, regularColorSteps, resolve, SolidFill, SolidLine,
} from '../core/style'
import { font } from '../core/theme'
import { Easings, Rect, rectContains, Tween } from '../core/util'
import { AxisMap, GLRenderer, makeXform } from '../render/GLRenderer'
import { SegmentBatch } from '../render/draw'
import { ATTR, FS_HEAD, VS_HEAD } from '../render/shaders'
import type { PointerInfo, Surface } from '../render/Surface'
import { drawTooltip, formatValue, TipRow } from '../hierarchy/common'
import {
  cutPolygonAtAntimeridian, GeoFeature, geojsonToFeatures, isTopology, Position, splitLineAtAntimeridian, topologyMesh, topologyToFeatures,
} from './topojson'
import { triangulate } from './triangulate'
import { MapProjection, projector, sphereOutline } from './projection'
import { isoA3FromNumeric } from './iso'

// Region fills: triangles in projected coordinates with a per-vertex region index
// that looks up the region color in a small RGBA texture (updated on value change).
const MAP_VS = VS_HEAD + /* glsl */ `
layout(location = 1) in vec2 a_p0;
layout(location = 5) in float a_v0;
uniform sampler2D u_colors;
uniform float u_hover;
uniform vec4 u_hoverMix;
out vec4 v_col;
void main() {
  int i = int(a_v0 + 0.5);
  vec4 c = texelFetch(u_colors, ivec2(i % 256, i / 256), 0);
  if (abs(a_v0 - u_hover) < 0.5) c.rgb = mix(c.rgb, u_hoverMix.rgb, u_hoverMix.a);
  v_col = c;
  gl_Position = pxToClip(toPx(a_p0));
}
`
const MAP_FS = FS_HEAD + /* glsl */ `
in vec4 v_col;
void main() { emit(v_col); }
`

/** Map presets. Geometry is supplied by the application; the type sets the initial view. */
export const MapTypes = {
  World: 'World',
  Europe: 'Europe',
  Africa: 'Africa',
  Asia: 'Asia',
  NorthAmerica: 'NorthAmerica',
  SouthAmerica: 'SouthAmerica',
  Australia: 'Australia',
  USA: 'USA',
} as const
export type MapType = (typeof MapTypes)[keyof typeof MapTypes]

/** Initial view per type: lon0, lat0, lon1, lat1. */
const TYPE_VIEW: Record<string, [number, number, number, number]> = {
  Europe: [-25, 34, 45, 71],
  Africa: [-20, -36, 53, 38],
  Asia: [25, -11, 150, 62],
  NorthAmerica: [-170, 7, -50, 75],
  SouthAmerica: [-92, -56, -32, 13],
  Australia: [110, -48, 180, -8],
  USA: [-126, 23, -66, 50],
}

export interface MapChartOptions extends PanelOptions {
  surface?: Surface
  /** `MapTypes` preset (initial view). */
  type?: string
  /** TopoJSON topology or GeoJSON (FeatureCollection / Feature / geometry). */
  geometry?: unknown
  /** TopoJSON object to decode (default 'countries' or the first object). */
  objectName?: string
  projection?: MapProjection
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

/** Public region descriptor. */
export interface MapRegion {
  index: number
  name: string
  id: string | number | undefined
  ISO_A3: string | undefined
  properties: Record<string, unknown>
  value: number | undefined
}

/** Region value assignment, addressed by ISO_A3, name or id. */
export interface RegionValue {
  value: number | undefined
  ISO_A3?: string
  iso_a3?: string
  name?: string
  NAME?: string
  id?: string | number
}

interface Region {
  info: MapRegion
  polys: Position[][][]
  /** Projected rings, flat x/y, per polygon. */
  proj: Float64Array[][]
  bbox: [number, number, number, number]
  from: Color
  to: Color
  color: Color
}

type Bounds = [number, number, number, number]

/**
 * Choropleth map. Regions come from TopoJSON or GeoJSON,
 * are triangulated once and drawn on the GPU; borders are GPU segments. Wheel zooms,
 * drag pans, double-click resets the view.
 */
export class MapChart extends Panel {
  readonly legend: Legend
  private mapType: string
  private projection: MapProjection
  private objectName?: string
  private regions: Region[] = []
  /** Border polylines (TopoJSON arcs, each once) in lon/lat; null = use region rings. */
  private mesh: Position[][] | null = null
  private byIso = new Map<string, Region>()
  private byName = new Map<string, Region>()
  private byId = new Map<string, Region>()
  private fill: Fill
  private autoFill = true
  private legendName = ''
  private noValueColor: Color
  private stroke: LineStyle
  private seriesBg: Fill
  private seriesStroke: LineStyle
  private graticuleVisible = true
  private message: string | null = 'Loading map data…'
  private valueFmt: (v: number) => string = (v) => formatValue(v)
  private cursorFmt: ((r: MapRegion) => string[] | null) | null = null
  private animEnabled = true
  private animDur = 450
  private colorTween: Tween | null = null
  private viewTween: Tween | null = null
  // projected geometry
  private bounds: Bounds = [-Math.PI, -Math.PI / 2, Math.PI, Math.PI / 2]
  private home: Bounds | null = null
  private sphere: [number, number][] = []
  private graticule: [number, number][][] = []
  private fillVerts = new Float32Array(0)
  private fillIdx = new Uint32Array(0)
  private outline = new SegmentBatch()
  private hoverLine = new SegmentBatch()
  private hoverBuilt = -1
  // view
  private plot: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private zoom = 1
  private cx = 0
  private cy = 0
  private viewInit = false
  // GPU
  private geomVer = 0
  private gpuVer = -1
  private vbuf: WebGLBuffer | null = null
  private ibuf: WebGLBuffer | null = null
  private tex: WebGLTexture | null = null
  private texH = 0
  private texData = new Uint8Array(0)
  private colorsDirty = true
  // interaction
  private hover = -1
  private pointer: { x: number; y: number } | null = null
  private drag: { x: number; y: number; moved: boolean } | null = null
  private lastDragMoved = false

  constructor(o: MapChartOptions = {}) {
    super(o)
    const t = this.theme
    this.legend = new Legend(this, { position: 'bottom', ...o.legend })
    this.mapType = o.type ?? MapTypes.World
    this.projection = o.projection ?? (TYPE_VIEW[this.mapType] ? 'mercator' : 'naturalEarth')
    this.objectName = o.objectName
    this.fill = new SolidFill({ color: t.isDark ? ColorRGBA(62, 62, 58) : ColorRGBA(206, 211, 218) })
    this.noValueColor = t.isDark ? ColorRGBA(50, 50, 48) : ColorRGBA(222, 225, 230)
    this.stroke = new SolidLine({ thickness: 0.8, fillStyle: new SolidFill({ color: t.isDark ? ColorRGBA(8, 8, 8, 230) : ColorRGBA(255, 255, 255, 255) }) })
    this.seriesBg = t.seriesBackgroundFill
    this.seriesStroke = t.seriesBackgroundStroke
    if (o.geometry) this.setGeometry(o.geometry, o.objectName)
  }

  override wantsMSAA(): boolean { return true }

  // ---------------------------------------------------------------- geometry

  /** Set region geometry: a TopoJSON topology or GeoJSON. Values are kept for regions with the same name. */
  setGeometry(g: unknown, objectName = this.objectName) {
    let feats: GeoFeature[]
    let mesh: Position[][] | null = null
    if (isTopology(g)) {
      feats = topologyToFeatures(g, objectName)
      mesh = topologyMesh(g, objectName).flatMap(splitLineAtAntimeridian)
    } else feats = geojsonToFeatures(g)
    const prev = new Map(this.regions.map((r) => [r.info.name, r.info.value]))
    const str = (v: unknown) => (typeof v === 'string' && v.trim() && v !== '-99' ? v.trim() : undefined)
    this.regions = feats.map((f, i) => {
      const p = f.properties
      const name = String(p.name ?? p.NAME ?? p.ADMIN ?? p.admin ?? p.NAME_EN ?? f.id ?? `Region ${i + 1}`)
      const iso = str(p.ISO_A3) ?? str(p.iso_a3) ?? str(p.ADM0_A3) ?? str(p.adm0_a3) ?? isoA3FromNumeric(f.id)
      const c = this.noValueColor
      return {
        info: { index: i, name, id: f.id, ISO_A3: iso?.toUpperCase(), properties: p, value: prev.get(name) },
        polys: f.polygons.flatMap(cutPolygonAtAntimeridian),
        proj: [],
        bbox: [0, 0, 0, 0],
        from: c,
        to: c,
        color: c,
      }
    })
    this.byIso.clear()
    this.byName.clear()
    this.byId.clear()
    for (const r of this.regions) {
      if (r.info.ISO_A3) this.byIso.set(r.info.ISO_A3, r)
      this.byName.set(r.info.name.toLowerCase(), r)
      if (r.info.id !== undefined) this.byId.set(String(r.info.id), r)
    }
    this.mesh = mesh
    this.message = null
    this.hover = -1
    this.viewInit = false
    this.project()
    this.recolor(false)
    this.emit('mapdataready', { chart: this })
    this.requestRender()
    return this
  }

  getRegions(): MapRegion[] { return this.regions.map((r) => r.info) }
  /** Look up a region by ISO_A3, name or id. */
  getRegion(key: string | number): MapRegion | undefined { return this.lookup(key)?.info }
  private lookup(key: string | number | undefined): Region | undefined {
    if (key === undefined) return undefined
    const s = String(key)
    return this.byIso.get(s.toUpperCase()) ?? this.byName.get(s.toLowerCase()) ?? this.byId.get(s)
  }

  setProjection(p: MapProjection) {
    this.projection = p
    this.viewInit = false
    this.project()
    this.requestRender()
    return this
  }
  getProjection() { return this.projection }

  private project() {
    const f = projector(this.projection)
    let X0 = Infinity, Y0 = Infinity, X1 = -Infinity, Y1 = -Infinity
    const verts: number[] = []
    const idx: number[] = []
    this.regions.forEach((rg, ri) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      rg.proj = rg.polys.map((poly) =>
        poly.map((ring) => {
          let n = ring.length
          if (n > 1 && ring[0][0] === ring[n - 1][0] && ring[0][1] === ring[n - 1][1]) n--
          const a = new Float64Array(n * 2)
          for (let i = 0; i < n; i++) {
            const [x, y] = f(ring[i][0], ring[i][1])
            a[i * 2] = x
            a[i * 2 + 1] = y
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
          }
          return a
        }),
      )
      rg.bbox = [x0, y0, x1, y1]
      if (x0 < X0) X0 = x0
      if (y0 < Y0) Y0 = y0
      if (x1 > X1) X1 = x1
      if (y1 > Y1) Y1 = y1
      for (const poly of rg.proj) {
        if (!poly.length || poly[0].length < 6) continue
        const total = poly.reduce((s, r) => s + r.length, 0)
        const flat = new Float64Array(total)
        const holes: number[] = []
        let o = 0
        poly.forEach((r, k) => {
          if (k) holes.push(o / 2)
          flat.set(r, o)
          o += r.length
        })
        const tris = triangulate(flat, holes)
        const base = verts.length / 3
        for (let i = 0; i < flat.length; i += 2) verts.push(flat[i], flat[i + 1], ri)
        for (const t of tris) idx.push(base + t)
      }
    })
    if (Number.isFinite(X0)) this.bounds = [X0, Y0, X1, Y1]
    this.fillVerts = new Float32Array(verts)
    this.fillIdx = new Uint32Array(idx)
    // initial view from the map type
    const tv = TYPE_VIEW[this.mapType]
    this.home = null
    if (tv) {
      let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity
      for (let i = 0; i <= 8; i++) {
        for (const [lon, lat] of [[tv[0] + ((tv[2] - tv[0]) * i) / 8, tv[1]], [tv[0] + ((tv[2] - tv[0]) * i) / 8, tv[3]], [tv[0], tv[1] + ((tv[3] - tv[1]) * i) / 8], [tv[2], tv[1] + ((tv[3] - tv[1]) * i) / 8]]) {
          const [x, y] = f(lon, lat)
          a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y)
        }
      }
      this.home = [a, b, c, d]
    }
    // sphere outline + graticule
    this.sphere = sphereOutline(this.projection)
    this.graticule = []
    const top = this.projection === 'mercator' ? 85 : 90
    for (let lon = -180; lon <= 180; lon += 30) {
      const line: [number, number][] = []
      for (let lat = -top; lat <= top + 1e-9; lat += 2.5) line.push(f(lon, lat))
      this.graticule.push(line)
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const line: [number, number][] = []
      for (let lon = -180; lon <= 180; lon += 2.5) line.push(f(lon, lat))
      this.graticule.push(line)
    }
    this.buildOutline()
    this.hoverBuilt = -1
    this.geomVer++
  }

  private buildOutline() {
    const b = this.outline
    b.clear()
    if (isEmptyLine(this.stroke)) return
    const col = this.stroke.getFillStyle().getPrimaryColor().toUint32()
    const f = projector(this.projection)
    if (this.mesh) {
      for (const arc of this.mesh) {
        let p = f(arc[0][0], arc[0][1])
        for (let i = 1; i < arc.length; i++) {
          const q = f(arc[i][0], arc[i][1])
          b.push(p[0], p[1], q[0], q[1], col)
          p = q
        }
      }
    } else {
      for (const rg of this.regions) for (const poly of rg.proj) for (const r of poly) pushRing(b, r, col)
    }
  }

  // ---------------------------------------------------------------- values / styling

  /**
   * Assign region values: an array of `{ ISO_A3 | name | id, value }`, or a callback
   * `(region, previousValue) => value` evaluated for every region. Colors animate.
   */
  invalidateRegionValues(values: RegionValue[] | ((region: MapRegion, prev: number | undefined) => number | undefined)) {
    if (typeof values === 'function') {
      for (const r of this.regions) {
        const v = values(r.info, r.info.value)
        r.info.value = typeof v === 'number' && Number.isFinite(v) ? v : undefined
      }
    } else {
      for (const v of values) {
        const r = this.lookup(v.ISO_A3 ?? v.iso_a3) ?? this.lookup(v.name ?? v.NAME) ?? this.lookup(v.id)
        if (r) r.info.value = typeof v.value === 'number' && Number.isFinite(v.value) ? v.value : undefined
      }
    }
    if (this.autoFill) this.makeAutoFill()
    this.recolor(this.animEnabled)
    this.requestRender()
    return this
  }
  /** Remove all region values. */
  clearRegionValues() { return this.invalidateRegionValues(() => undefined) }

  private makeAutoFill() {
    let lo = Infinity, hi = -Infinity
    for (const r of this.regions) {
      const v = r.info.value
      if (v === undefined) continue
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    if (!Number.isFinite(lo)) return
    if (hi === lo) hi = lo + 1
    const lut = new LUT({ interpolate: true, steps: regularColorSteps(lo, hi, this.theme.examples.coldHotColorPalette) })
    this.setFillStyleInternal(new PalettedFill({ lut, lookUpProperty: 'value' }))
  }

  /** Region fill: a PalettedFill colors regions by value through its LUT; a SolidFill paints all regions. */
  setFillStyle(f: Mutator<Fill>, o: { legendName?: string } = {}) {
    this.autoFill = false
    if (o.legendName !== undefined) this.legendName = o.legendName
    this.setFillStyleInternal(resolve(this.fill, f))
    this.recolor(this.animEnabled)
    this.requestRender()
    return this
  }
  private setFillStyleInternal(f: Fill) {
    this.fill = f
    this.legend.clear()
    if (f instanceof PalettedFill) this.legend.add(f.lut, { name: this.legendName || undefined })
  }
  getFillStyle() { return this.fill }
  /** Fill of regions without a value when a PalettedFill is used. */
  setNoValueFillStyle(f: Fill | Color) {
    this.noValueColor = f instanceof Color ? f : f.getPrimaryColor()
    this.recolor(false)
    this.requestRender()
    return this
  }
  /** Region border style. */
  setStrokeStyle(l: Mutator<LineStyle>) {
    this.stroke = resolve(this.stroke, l)
    this.buildOutline()
    this.requestRender()
    return this
  }
  getStrokeStyle() { return this.stroke }
  /** Fill of the globe / map background behind the regions. */
  setSeriesBackgroundFillStyle(f: Mutator<Fill>) { this.seriesBg = resolve(this.seriesBg, f); this.requestRender(); return this }
  setSeriesBackgroundStrokeStyle(l: Mutator<LineStyle>) { this.seriesStroke = resolve(this.seriesStroke, l); this.requestRender(); return this }
  setGraticuleVisible(v: boolean) { this.graticuleVisible = v; this.requestRender(); return this }
  /** Centered message (e.g. loading or error text); `null` hides it. */
  setMessage(text: string | null) { this.message = text; this.requestRender(); return this }
  setValueFormatter(f: (v: number) => string) { this.valueFmt = f; this.requestRender(); return this }
  /** Tooltip lines for a region (first line bold); return null to hide the tooltip. */
  setCursorFormatter(f: ((region: MapRegion) => string[] | null) | null) { this.cursorFmt = f; return this }
  setAnimationsEnabled(v: boolean) { this.animEnabled = v; return this }
  setAnimationDuration(ms: number) { this.animDur = Math.max(0, ms); return this }

  private targetColor(r: Region): Color {
    const f = this.fill
    if (f instanceof PalettedFill) return r.info.value !== undefined ? f.lut.getColor(r.info.value) : this.noValueColor
    return f.getPrimaryColor()
  }

  private recolor(animate: boolean) {
    for (const r of this.regions) {
      r.from = r.color
      r.to = this.targetColor(r)
    }
    this.colorTween?.cancel()
    const apply = (t: number) => {
      for (const r of this.regions) r.color = t >= 1 ? r.to : r.from.mix(r.to, t)
      this.colorsDirty = true
    }
    if (animate && this.animDur > 0 && this.viewInit) this.colorTween = this.animate(new Tween([0], [1], this.animDur, (v) => apply(v[0]), Easings.easeInOut))
    else apply(1)
  }

  // ---------------------------------------------------------------- view

  private homeBounds(): Bounds { return this.home ?? this.bounds }
  private baseScale(): number {
    const b = this.homeBounds()
    const w = Math.max(1e-9, b[2] - b[0]), h = Math.max(1e-9, b[3] - b[1])
    return Math.min(this.plot.w / w, this.plot.h / h) * 0.96
  }
  private scale() { return this.baseScale() * this.zoom }
  private maps(): { mx: AxisMap; my: AxisMap } {
    const s = this.scale()
    return {
      mx: { a0: this.plot.x + this.plot.w / 2 - this.cx * s, start: 0, k: s, log: 0 },
      my: { a0: this.plot.y + this.plot.h / 2 + this.cy * s, start: 0, k: -s, log: 0 },
    }
  }
  private toPx(x: number, y: number): [number, number] {
    const s = this.scale()
    return [this.plot.x + this.plot.w / 2 + (x - this.cx) * s, this.plot.y + this.plot.h / 2 - (y - this.cy) * s]
  }
  private fromPx(px: number, py: number): [number, number] {
    const s = this.scale()
    return [this.cx + (px - this.plot.x - this.plot.w / 2) / s, this.cy - (py - this.plot.y - this.plot.h / 2) / s]
  }
  private clampView() {
    this.zoom = Math.max(0.6, Math.min(60, this.zoom))
    const b = this.bounds
    this.cx = Math.max(b[0], Math.min(b[2], this.cx))
    this.cy = Math.max(b[1], Math.min(b[3], this.cy))
  }
  /** Show the given lon/lat box. */
  setView(lonMin: number, latMin: number, lonMax: number, latMax: number, animate = true) {
    const f = projector(this.projection)
    const [x0, y0] = f(lonMin, latMin), [x1, y1] = f(lonMax, latMax)
    const s0 = this.baseScale()
    const z = Math.min(this.plot.w / Math.abs(x1 - x0 || 1e-9), this.plot.h / Math.abs(y1 - y0 || 1e-9)) * 0.96 / (s0 || 1)
    this.flyTo((x0 + x1) / 2, (y0 + y1) / 2, z, animate)
    return this
  }
  /** Return to the initial view. */
  resetView(animate = true) {
    const h = this.homeBounds()
    this.flyTo((h[0] + h[2]) / 2, (h[1] + h[3]) / 2, 1, animate)
    return this
  }
  private flyTo(cx: number, cy: number, zoom: number, animate: boolean) {
    this.viewTween?.cancel()
    if (!animate || !this.viewInit) {
      this.cx = cx
      this.cy = cy
      this.zoom = zoom
      this.clampView()
      this.requestRender()
      return
    }
    // Interpolate zoom in log space for a steady fly.
    this.viewTween = this.animate(
      new Tween([this.cx, this.cy, Math.log(this.zoom)], [cx, cy, Math.log(Math.max(1e-6, zoom))], 500, (v) => {
        this.cx = v[0]
        this.cy = v[1]
        this.zoom = Math.exp(v[2])
        this.clampView()
      }, Easings.easeInOut),
    )
  }

  // ---------------------------------------------------------------- layout / drawing

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    this.plot = this.legend.layout(content)
    if (!this.viewInit && this.regions.length && this.plot.w > 0) {
      const h = this.homeBounds()
      this.cx = (h[0] + h[2]) / 2
      this.cy = (h[1] + h[3]) / 2
      this.zoom = 1
      this.viewInit = true
    }
  }

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const P = this.plot
    if (!this.regions.length || P.w <= 0 || P.h <= 0) return
    ctx.save()
    ctx.beginPath()
    ctx.rect(P.x, P.y, P.w, P.h)
    ctx.clip()
    ctx.beginPath()
    this.sphere.forEach(([x, y], i) => {
      const [px, py] = this.toPx(x, y)
      if (i) ctx.lineTo(px, py)
      else ctx.moveTo(px, py)
    })
    ctx.closePath()
    const paint = fillToCanvas(ctx, this.seriesBg, P.x, P.y, P.w, P.h)
    if (paint) {
      ctx.fillStyle = paint
      ctx.fill()
    }
    if (applyLineToCanvas(ctx, this.seriesStroke)) ctx.stroke()
    if (this.graticuleVisible) {
      ctx.save()
      ctx.clip()
      ctx.beginPath()
      for (const line of this.graticule) {
        line.forEach(([x, y], i) => {
          const [px, py] = this.toPx(x, y)
          if (i) ctx.lineTo(px, py)
          else ctx.moveTo(px, py)
        })
      }
      ctx.strokeStyle = this.theme.gridMajorColor.toCSS()
      ctx.lineWidth = 1
      ctx.setLineDash([])
      ctx.stroke()
      ctx.restore()
    }
    ctx.restore()
  }

  override hasGL() { return this.regions.length > 0 }

  override drawGL(r: GLRenderer) {
    const gl = r.gl
    const P = this.plot
    if (P.w <= 0 || P.h <= 0 || !this.fillIdx.length) return
    if (this.gpuVer !== this.geomVer || !this.vbuf) {
      if (!this.vbuf) {
        this.vbuf = gl.createBuffer()!
        this.ibuf = gl.createBuffer()!
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.vbuf)
      gl.bufferData(gl.ARRAY_BUFFER, this.fillVerts, gl.STATIC_DRAW)
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf)
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.fillIdx, gl.STATIC_DRAW)
      this.gpuVer = this.geomVer
    }
    const H = Math.max(1, Math.ceil(this.regions.length / 256))
    if (!this.tex || this.texH !== H) {
      if (this.tex) gl.deleteTexture(this.tex)
      this.tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, this.tex)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, H)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      this.texH = H
      this.texData = new Uint8Array(256 * H * 4)
      this.colorsDirty = true
    }
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, this.tex)
    if (this.colorsDirty) {
      const d = this.texData
      this.regions.forEach((rg, i) => {
        const c = rg.color
        d[i * 4] = c.r
        d[i * 4 + 1] = c.g
        d[i * 4 + 2] = c.b
        d[i * 4 + 3] = c.a
      })
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, H, gl.RGBA, gl.UNSIGNED_BYTE, d)
      this.colorsDirty = false
    }
    const maps = this.maps()
    r.scissor(P)
    r.glow = 0
    const prog = r.program('sferic-mapfill', MAP_VS, MAP_FS)
    r.useXform(prog, makeXform(maps.mx, maps.my, 0, 0, r.dpr))
    r.u1i(prog.u.u_colors, 2)
    r.u1f(prog.u.u_hover, this.hover >= 0 ? this.hover : -10)
    const hc = this.theme.examples.highlightColor.toFloat()
    r.u4f(prog.u.u_hoverMix, hc[0], hc[1], hc[2], 0.3)
    r.resetAttribs([ATTR.p0, ATTR.v0])
    r.attrib(ATTR.p0, this.vbuf, 2, gl.FLOAT, false, 12, 0, 0)
    r.attrib(ATTR.v0, this.vbuf, 1, gl.FLOAT, false, 12, 8, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibuf)
    gl.drawElements(gl.TRIANGLES, this.fillIdx.length, gl.UNSIGNED_INT, 0)
    if (this.outline.n) {
      const th = this.stroke.getThickness()
      this.outline.draw(r, maps, th < 0 ? 0.6 : th)
    }
    if (this.hover >= 0) {
      if (this.hoverBuilt !== this.hover) {
        this.hoverLine.clear()
        const col = this.theme.examples.highlightColor.toUint32()
        for (const poly of this.regions[this.hover].proj) for (const ring of poly) pushRing(this.hoverLine, ring, col)
        this.hoverBuilt = this.hover
      }
      r.glow = 1
      this.hoverLine.draw(r, maps, 1.8)
    }
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    if (this.message || !this.regions.length) {
      const P = this.plot
      ctx.font = font(t, t.fontSize + 2)
      ctx.fillStyle = t.legend.disabledColor.toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(this.message ?? 'No map geometry', P.x + P.w / 2, P.y + P.h / 2)
    }
    this.legend.draw(ctx)
    if (this.pointer && this.hover >= 0 && !this.drag?.moved) {
      const rg = this.regions[this.hover]
      const rows: TipRow[] = this.cursorFmt
        ? (this.cursorFmt(rg.info) ?? []).map((text, i) => ({ text, bold: i === 0, swatch: i === 0 ? rg.color : undefined }))
        : [
            { text: rg.info.name + (rg.info.ISO_A3 ? `  (${rg.info.ISO_A3})` : ''), bold: true, swatch: rg.color },
            { text: 'Value', value: rg.info.value !== undefined ? this.valueFmt(rg.info.value) : 'no data' },
          ]
      drawTooltip(ctx, t, this.pointer.x, this.pointer.y, rows, this.rect)
    }
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  // ---------------------------------------------------------------- interaction

  private regionAt(px: number, py: number): number {
    if (!rectContains(this.plot, px, py)) return -1
    const [x, y] = this.fromPx(px, py)
    for (let i = 0; i < this.regions.length; i++) {
      const rg = this.regions[i]
      const b = rg.bbox
      if (x < b[0] || x > b[2] || y < b[1] || y > b[3]) continue
      let inside = false
      for (const poly of rg.proj) {
        for (const ring of poly) {
          const n = ring.length / 2
          for (let a = 0, c = n - 1; a < n; c = a++) {
            const ya = ring[a * 2 + 1], yc = ring[c * 2 + 1]
            if (ya > y !== yc > y) {
              const xa = ring[a * 2], xc = ring[c * 2]
              if (x < ((xc - xa) * (y - ya)) / (yc - ya) + xa) inside = !inside
            }
          }
        }
      }
      if (inside) return i
    }
    return -1
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    switch (e.type) {
      case 'move': {
        this.pointer = { x, y }
        if (this.drag) {
          const dx = x - this.drag.x, dy = y - this.drag.y
          if (Math.abs(dx) + Math.abs(dy) > 2) this.drag.moved = true
          if (this.drag.moved) {
            this.viewTween?.cancel()
            const s = this.scale()
            this.cx -= dx / s
            this.cy += dy / s
            this.clampView()
            this.drag.x = x
            this.drag.y = y
            this.surface.setCursor('grabbing')
          }
          return true
        }
        const h = this.regionAt(x, y)
        if (h !== this.hover) {
          this.hover = h
          this.emit('regionhover', { region: h >= 0 ? this.regions[h].info : null, chart: this })
        }
        this.surface.setCursor(h >= 0 ? 'pointer' : 'default')
        return true
      }
      case 'leave':
        this.pointer = null
        this.hover = -1
        return true
      case 'down':
        if (!rectContains(this.plot, x, y)) return false
        this.drag = { x, y, moved: false }
        return true
      case 'up': {
        const d = this.drag
        this.drag = null
        this.lastDragMoved = !!d?.moved
        if (d?.moved) this.surface.setCursor('default')
        return !!d
      }
      case 'wheel': {
        if (!rectContains(this.plot, x, y) || !this.regions.length) return false
        const ev = e.native as WheelEvent
        const mult = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1
        const f = Math.exp(-Math.max(-300, Math.min(300, e.deltaY * mult)) * 0.0018)
        this.viewTween?.cancel()
        const [wx, wy] = this.fromPx(x, y)
        this.zoom *= f
        this.clampView()
        const s = this.scale()
        this.cx = wx - (x - this.plot.x - this.plot.w / 2) / s
        this.cy = wy + (y - this.plot.y - this.plot.h / 2) / s
        this.clampView()
        this.pointer = { x, y }
        this.hover = this.regionAt(x, y)
        return true
      }
      case 'dblclick':
        if (!rectContains(this.plot, x, y)) return false
        this.resetView(true)
        return true
      case 'click':
        if (this.lastDragMoved) return false
        if (this.hover >= 0) this.emit('regionclick', { region: this.regions[this.hover].info, chart: this })
        return false
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) {
    if (r) {
      if (this.vbuf) r.gl.deleteBuffer(this.vbuf)
      if (this.ibuf) r.gl.deleteBuffer(this.ibuf)
      if (this.tex) r.gl.deleteTexture(this.tex)
    }
    this.vbuf = this.ibuf = null
    this.tex = null
    this.gpuVer = -1
    this.outline.dispose(r)
    this.hoverLine.dispose(r)
    this.hoverBuilt = -1
  }
}

function pushRing(b: SegmentBatch, ring: Float64Array, col: number) {
  const n = ring.length / 2
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    b.push(ring[i * 2], ring[i * 2 + 1], ring[j * 2], ring[j * 2 + 1], col)
  }
}
