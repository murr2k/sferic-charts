import { Color } from '../core/color'
import { LegendSymbol } from '../core/Legend'
import { Fill, LookUpProperty, Mutator, PalettedFill, resolve, SolidFill } from '../core/style'
import { GLRenderer } from '../render/GLRenderer'
import { ATTR } from '../render/shaders'
import { dataRay, dataToCss, Frame3D, GLBuf, lutOf, setCommon, setFillUniforms, shapeMesh, program3d } from './gl3d'
import { eulerMat3, Point3D } from './math3d'
import { Chart3DHost, Hit3D, inBox, Series3D, Series3DOptions } from './series3d'
import { Bounds3D, emptyBounds } from './store3d'
import { BOX_VS, MESH_FS, MODEL_VS } from './shaders3d'

const xyz = (v: number | Partial<Point3D>, d: number): Point3D =>
  typeof v === 'number' ? { x: v, y: v, z: v } : { x: v.x ?? d, y: v.y ?? d, z: v.z ?? d }

// ------------------------------------------------------------------ mesh model

export interface ModelGeometry {
  /** Flat [x, y, z, ...] in model space. */
  vertices: ArrayLike<number>
  /** Triangle list. */
  indices: ArrayLike<number>
  /** Optional flat per-vertex normals; smooth normals are computed when omitted. */
  normals?: ArrayLike<number>
}

/** Arbitrary triangle mesh placed in axis coordinates. */
export class MeshModel3D extends Series3D {
  private verts: Float32Array = new Float32Array(0)
  private nrms: Float32Array = new Float32Array(0)
  private idx: Uint32Array = new Uint32Array(0)
  private vals: Float32Array | null = null
  private cols: Uint32Array | null = null
  private scale: Point3D = { x: 1, y: 1, z: 1 }
  private loc: Point3D = { x: 0, y: 0, z: 0 }
  private rot: Point3D = { x: 0, y: 0, z: 0 }
  private rotM = eulerMat3({ x: 0, y: 0, z: 0 })
  private fill: Fill
  private b: Bounds3D | null = null
  private ranges: Record<'x' | 'y' | 'z' | 'value', [number, number] | null> = { x: null, y: null, z: null, value: null }
  private gPos = new GLBuf()
  private gNrm = new GLBuf()
  private gVal = new GLBuf()
  private gCol = new GLBuf()
  private gIdx = new GLBuf()
  private dirty = { geom: true, val: true, col: true }

  constructor(chart: Chart3DHost, ci: number, _o: Series3DOptions = {}) {
    super(chart, ci, 'Mesh Model 3D')
    this.fill = new SolidFill({ color: this.defaultColor() })
    this.effect = false
  }

  setModelGeometry(g: ModelGeometry) {
    this.verts = Float32Array.from(g.vertices)
    this.idx = Uint32Array.from(g.indices)
    this.nrms = g.normals && g.normals.length === this.verts.length ? Float32Array.from(g.normals) : smoothNormals(this.verts, this.idx)
    if (this.vals && this.vals.length !== this.verts.length / 3) this.vals = null
    if (this.cols && this.cols.length !== this.verts.length / 3) this.cols = null
    this.dirty = { geom: true, val: true, col: true }
    this.updateBounds()
    return this
  }
  setScale(s: number | Partial<Point3D>) { this.scale = xyz(s, 1); this.updateBounds(); return this }
  getScale() { return { ...this.scale } }
  setModelLocation(p: Partial<Point3D>) { this.loc = xyz(p, 0); this.updateBounds(); return this }
  getModelLocation() { return { ...this.loc } }
  /** Euler angles in degrees, applied X, then Y, then Z. */
  setModelRotation(r: Partial<Point3D>) { this.rot = xyz(r, 0); this.rotM = eulerMat3(this.rot); this.updateBounds(); return this }
  getModelRotation() { return { ...this.rot } }
  setModelAlignment(_a: unknown) { return this }
  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.onSeriesStyle(this); return this }
  getFillStyle() { return this.fill }
  /** Per-vertex values for PalettedFill lookUpProperty 'value'. */
  setVertexValues(v: ArrayLike<number> | ((prev: Float32Array) => ArrayLike<number>)) {
    const n = this.verts.length / 3
    const prev = this.vals ?? new Float32Array(n)
    const nv = typeof v === 'function' ? v(prev) : v
    this.vals = Float32Array.from({ length: n }, (_, i) => (i < nv.length ? nv[i] : 0))
    let lo = Infinity, hi = -Infinity
    for (const x of this.vals) { if (x < lo) lo = x; if (x > hi) hi = x }
    this.ranges.value = lo <= hi ? [lo, hi] : null
    this.dirty.val = true
    this.chart.requestRender()
    return this
  }
  /** Per-vertex colors (used with a non-paletted fill). */
  setVertexColors(c: ArrayLike<Color> | ((prev: Color[]) => ArrayLike<Color>)) {
    const n = this.verts.length / 3
    const nc = typeof c === 'function' ? c([]) : c
    this.cols = Uint32Array.from({ length: n }, (_, i) => (i < nc.length ? nc[i].toUint32() : 0))
    this.dirty.col = true
    this.chart.requestRender()
    return this
  }

  private updateBounds() {
    const v = this.verts, m = this.rotM, s = this.scale, L = this.loc
    const b = emptyBounds()
    for (let i = 0; i < v.length; i += 3) {
      const x = v[i] * s.x, y = v[i + 1] * s.y, z = v[i + 2] * s.z
      const px = m[0] * x + m[3] * y + m[6] * z + L.x
      const py = m[1] * x + m[4] * y + m[7] * z + L.y
      const pz = m[2] * x + m[5] * y + m[8] * z + L.z
      if (px < b.xmin) b.xmin = px
      if (px > b.xmax) b.xmax = px
      if (py < b.ymin) b.ymin = py
      if (py > b.ymax) b.ymax = py
      if (pz < b.zmin) b.zmin = pz
      if (pz > b.zmax) b.zmax = pz
    }
    this.b = b.xmin <= b.xmax ? b : null
    this.chart.onSeriesData(this)
  }
  bounds() { return this.b }
  override propRange(p: LookUpProperty) { return p === 'value' ? this.ranges.value : super.propRange(p) }
  primaryColor() { return this.fill.type !== 'empty' ? this.fill.getPrimaryColor() : this.defaultColor() }
  override isTransparent() { return !(this.fill instanceof PalettedFill) && this.primaryColor().a < 250 }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor() } }
  override legendLUT() { return lutOf(this.fill) }

  drawGL(r: GLRenderer, f: Frame3D) {
    if (!this.idx.length || this.fill.type === 'empty') return
    const gl = r.gl
    if (this.gPos.stale(gl)) this.dirty = { geom: true, val: true, col: true }
    if (this.dirty.geom) {
      this.gPos.ensure(gl, this.verts.byteLength)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.verts)
      this.gNrm.ensure(gl, this.nrms.byteLength)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.nrms)
      this.gIdx.ensure(gl, this.idx.byteLength, gl.ELEMENT_ARRAY_BUFFER)
      gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.idx)
      this.dirty.geom = false
    }
    if (this.vals && this.dirty.val) {
      this.gVal.ensure(gl, this.vals.byteLength)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vals)
      this.dirty.val = false
    }
    if (this.cols && this.dirty.col) {
      this.gCol.ensure(gl, this.cols.byteLength)
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.cols)
      this.dirty.col = false
    }
    const L = this.loc
    const pal = this.fill instanceof PalettedFill
    const useCol = !!this.cols && !pal
    const prog = program3d(r, 'c3d-model', MODEL_VS, MESH_FS)
    setCommon(r, prog, f, L.x, L.y, L.z, { clip: this.clipping, shading: this.shading })
    setFillUniforms(r, prog, this.fill, this.defaultColor(), [L.x, L.y, L.z], (p) => this.propRange(p), useCol)
    gl.uniformMatrix3fv(prog.u.u_rot, false, this.rotM)
    gl.uniform3f(prog.u.u_mscale, this.scale.x, this.scale.y, this.scale.z)
    const keep: number[] = [ATTR.p0, ATTR.p1]
    if (useCol) keep.push(ATTR.c0)
    if (this.vals) keep.push(ATTR.v0)
    r.resetAttribs(keep)
    r.attrib(ATTR.p0, this.gPos.buf!, 3, gl.FLOAT, false, 12, 0, 0)
    r.attrib(ATTR.p1, this.gNrm.buf!, 3, gl.FLOAT, false, 12, 0, 0)
    if (useCol) r.attrib(ATTR.c0, this.gCol.buf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 0)
    if (this.vals) r.attrib(ATTR.v0, this.gVal.buf!, 1, gl.FLOAT, false, 4, 0, 0)
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.gIdx.buf)
    gl.drawElements(gl.TRIANGLES, this.idx.length, gl.UNSIGNED_INT, 0)
  }

  override disposeGL(r: GLRenderer | null) {
    const gl = r ? r.gl : null
    for (const b of [this.gPos, this.gNrm, this.gVal, this.gCol, this.gIdx]) b.dispose(gl)
    this.dirty = { geom: true, val: true, col: true }
  }
}

/** Area-weighted smooth vertex normals. */
function smoothNormals(v: Float32Array, idx: Uint32Array): Float32Array {
  const n = new Float32Array(v.length)
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3
    const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2]
    const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2]
    const x = uy * wz - uz * wy, y = uz * wx - ux * wz, z = ux * wy - uy * wx
    for (const k of [a, b, c]) { n[k] += x; n[k + 1] += y; n[k + 2] += z }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i], n[i + 1], n[i + 2]) || 1
    n[i] /= l; n[i + 1] /= l; n[i + 2] /= l
  }
  return n
}

// ------------------------------------------------------------------ boxes

export interface BoxData3D {
  xCenter: number
  yCenter: number
  zCenter: number
  xSize: number
  ySize: number
  zSize: number
  color?: Color
  value?: number
  /** Records with a known id update in place; others are appended. */
  id?: number | string
}

/** Axis-aligned 3D boxes, e.g. 3D bar charts. */
export class BoxSeries3D extends Series3D {
  private n = 0
  private cap = 0
  private ctr = new Float32Array(0)
  private siz = new Float32Array(0)
  private col: Uint32Array | null = null
  private val: Float32Array | null = null
  private ids = new Map<number | string, number>()
  private ox = 0
  private oy = 0
  private oz = 0
  private hasOrigin = false
  private fill: Fill
  private b: Bounds3D | null = null
  private vrange: [number, number] | null = null
  private gCtr = new GLBuf()
  private gSiz = new GLBuf()
  private gCol = new GLBuf()
  private gVal = new GLBuf()
  private dirty = true

  constructor(chart: Chart3DHost, ci: number, _o: Series3DOptions = {}) {
    super(chart, ci, 'Box Series 3D')
    this.fill = new SolidFill({ color: this.defaultColor() })
    this.effect = false
  }

  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.onSeriesStyle(this); return this }
  getFillStyle() { return this.fill }
  setRoundedEdges(_r: number | undefined) { return this }
  getBoxCount() { return this.n }

  private grow(need: number) {
    if (need <= this.cap) return
    const cap = Math.max(64, this.cap * 2, need)
    const c = new Float32Array(cap * 3); c.set(this.ctr); this.ctr = c
    const s = new Float32Array(cap * 3); s.set(this.siz); this.siz = s
    if (this.col) { const k = new Uint32Array(cap); k.set(this.col); this.col = k }
    if (this.val) { const k = new Float32Array(cap); k.set(this.val); this.val = k }
    this.cap = cap
  }

  /** Add new boxes or update existing ones by `id`. */
  invalidateData(data: BoxData3D[]) {
    for (const d of data) {
      let i = d.id !== undefined ? this.ids.get(d.id) : undefined
      if (i === undefined) {
        this.grow(this.n + 1)
        i = this.n++
        if (d.id !== undefined) this.ids.set(d.id, i)
      }
      if (!this.hasOrigin) {
        this.hasOrigin = true
        this.ox = d.xCenter; this.oy = d.yCenter; this.oz = d.zCenter
      }
      this.ctr[i * 3] = d.xCenter - this.ox
      this.ctr[i * 3 + 1] = d.yCenter - this.oy
      this.ctr[i * 3 + 2] = d.zCenter - this.oz
      this.siz[i * 3] = d.xSize
      this.siz[i * 3 + 1] = d.ySize
      this.siz[i * 3 + 2] = d.zSize
      if (d.color && !this.col) this.col = new Uint32Array(this.cap)
      if (this.col) this.col[i] = d.color ? d.color.toUint32() : 0
      if (d.value !== undefined && !this.val) this.val = new Float32Array(this.cap)
      if (this.val) this.val[i] = d.value ?? 0
    }
    this.recompute()
    this.dirty = true
    this.chart.onSeriesData(this)
    return this
  }
  clear() {
    this.n = 0
    this.ids.clear()
    this.hasOrigin = false
    this.b = null
    this.vrange = null
    this.dirty = true
    this.chart.onSeriesData(this)
    return this
  }

  private recompute() {
    const b = emptyBounds()
    let vlo = Infinity, vhi = -Infinity
    for (let i = 0; i < this.n; i++) {
      for (let k = 0; k < 3; k++) {
        const c = this.ctr[i * 3 + k] + (k === 0 ? this.ox : k === 1 ? this.oy : this.oz)
        const h = Math.abs(this.siz[i * 3 + k]) / 2
        const key = k === 0 ? 'x' : k === 1 ? 'y' : 'z'
        const lo = c - h, hi = c + h
        if (lo < b[`${key}min`]) b[`${key}min`] = lo
        if (hi > b[`${key}max`]) b[`${key}max`] = hi
      }
      if (this.val) {
        const v = this.val[i]
        if (v < vlo) vlo = v
        if (v > vhi) vhi = v
      }
    }
    this.b = this.n ? b : null
    this.vrange = vlo <= vhi ? [vlo, vhi] : null
  }

  bounds() { return this.b }
  override propRange(p: LookUpProperty) { return p === 'value' ? this.vrange : super.propRange(p) }
  primaryColor() { return this.fill.type !== 'empty' ? this.fill.getPrimaryColor() : this.defaultColor() }
  override isTransparent() { return !(this.fill instanceof PalettedFill) && this.primaryColor().a < 250 }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor() } }
  override legendLUT() { return lutOf(this.fill) }

  drawGL(r: GLRenderer, f: Frame3D) {
    if (!this.n || this.fill.type === 'empty') return
    const gl = r.gl
    if (this.gCtr.stale(gl)) this.dirty = true
    if (this.dirty) {
      const up = (g: GLBuf, a: Float32Array | Uint32Array, comps: number) => {
        g.ensure(gl, this.cap * comps * 4)
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, a, 0, this.n * comps)
      }
      up(this.gCtr, this.ctr, 3)
      up(this.gSiz, this.siz, 3)
      if (this.col) up(this.gCol, this.col, 1)
      if (this.val) up(this.gVal, this.val, 1)
      this.dirty = false
    }
    const pal = this.fill instanceof PalettedFill
    const useCol = !!this.col && !pal
    const prog = program3d(r, 'c3d-box', BOX_VS, MESH_FS)
    setCommon(r, prog, f, this.ox, this.oy, this.oz, { clip: this.clipping, shading: this.shading })
    setFillUniforms(r, prog, this.fill, this.defaultColor(), [this.ox, this.oy, this.oz], (p) => this.propRange(p), useCol)
    const mesh = shapeMesh(gl, 'unitbox')
    const keep: number[] = [ATTR.corner, ATTR.lo0, ATTR.p0, ATTR.p1]
    if (useCol) keep.push(ATTR.c0)
    if (this.val) keep.push(ATTR.v0)
    r.resetAttribs(keep)
    r.attrib(ATTR.corner, mesh.buf, 3, gl.FLOAT, false, 24, 0, 0)
    r.attrib(ATTR.lo0, mesh.buf, 3, gl.FLOAT, false, 24, 12, 0)
    r.attrib(ATTR.p0, this.gCtr.buf!, 3, gl.FLOAT, false, 12, 0, 1)
    r.attrib(ATTR.p1, this.gSiz.buf!, 3, gl.FLOAT, false, 12, 0, 1)
    if (useCol) r.attrib(ATTR.c0, this.gCol.buf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
    if (this.val) r.attrib(ATTR.v0, this.gVal.buf!, 1, gl.FLOAT, false, 4, 0, 1)
    gl.drawArraysInstanced(gl.TRIANGLES, 0, mesh.count, this.n)
  }

  override pick(sx: number, sy: number, f: Frame3D): Hit3D | null {
    if (!this.n) return null
    // Ray / box slab test in data space; nearest hit wins.
    const { o, d } = dataRay(f, sx, sy, this.ox, this.oy, this.oz)
    let best = -1, bt = Infinity
    for (let i = 0; i < this.n; i++) {
      let t0 = 0, t1 = Infinity
      for (let k = 0; k < 3; k++) {
        const c = this.ctr[i * 3 + k], h = Math.abs(this.siz[i * 3 + k]) / 2
        if (Math.abs(d[k]) < 1e-15) {
          if (o[k] < c - h || o[k] > c + h) { t0 = Infinity; break }
          continue
        }
        let a = (c - h - o[k]) / d[k], b = (c + h - o[k]) / d[k]
        if (a > b) { const q = a; a = b; b = q }
        if (a > t0) t0 = a
        if (b < t1) t1 = b
        if (t0 > t1) break
      }
      if (t0 <= t1 && t0 < bt) {
        const hx = o[0] + d[0] * t0 + this.ox, hy = o[1] + d[1] * t0 + this.oy, hz = o[2] + d[2] * t0 + this.oz
        if (!inBox(f, hx, hy, hz)) continue
        bt = t0
        best = i
      }
    }
    if (best < 0) return null
    const m = dataToCss(f, this.ox, this.oy, this.oz, tmpM)
    const px = o[0] + d[0] * bt, py = o[1] + d[1] * bt, pz = o[2] + d[2] * bt
    const w = m[3] * px + m[7] * py + m[11] * pz + m[15]
    const x = this.ctr[best * 3] + this.ox, y = this.ctr[best * 3 + 1] + this.oy + this.siz[best * 3 + 1] / 2, z = this.ctr[best * 3 + 2] + this.oz
    const pal = this.fill instanceof PalettedFill ? this.fill : null
    let color = this.primaryColor()
    if (pal) color = pal.lut.getColor(pal.lookUpProperty === 'value' && this.val ? this.val[best] : pal.lookUpProperty === 'x' ? x : pal.lookUpProperty === 'z' ? z : y)
    else if (this.col && this.col[best]) {
      const c = this.col[best]
      color = new Color(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, (c >>> 24) & 255)
    }
    return {
      series: this, x, y, z, value: this.val ? this.val[best] : undefined,
      sx: (m[0] * px + m[4] * py + m[8] * pz + m[12]) / w, sy: (m[1] * px + m[5] * py + m[9] * pz + m[13]) / w,
      w, d2: 0, color,
      extra: [['Size', `${fmt(this.siz[best * 3])} x ${fmt(this.siz[best * 3 + 1])} x ${fmt(this.siz[best * 3 + 2])}`]],
    }
  }

  override disposeGL(r: GLRenderer | null) {
    const gl = r ? r.gl : null
    for (const b of [this.gCtr, this.gSiz, this.gCol, this.gVal]) b.dispose(gl)
    this.dirty = true
  }
}

const tmpM = new Float64Array(16)
const fmt = (v: number) => +v.toPrecision(4) + ''
