import { LegendSymbol } from '../core/Legend'
import { ColorRGBA } from '../core/color'
import { emptyLine, Fill, isEmptyLine, LineStyle, LookUpProperty, Mutator, PalettedFill, resolve, SolidFill, SolidLine } from '../core/style'
import { GLRenderer } from '../render/GLRenderer'
import { dataToCss, Frame3D, lutOf, setCommon, setFillUniforms, program3d } from './gl3d'
import { Hit3D, Chart3DHost, Series3D, Series3DOptions, inBox } from './series3d'
import { Bounds3D } from './store3d'
import { SURF_FS, SURF_VS } from './shaders3d'

type XZ = { x: number; z: number }
type Region = { iColumn?: number; iRow?: number; values: ArrayLike<number>[] }

// Strip index buffers over column pairs, cached per context and grid size.
const indexCache = new WeakMap<WebGL2RenderingContext, Map<string, WebGLBuffer>>()
function gridIndex(gl: WebGL2RenderingContext, cols: number, rows: number): WebGLBuffer {
  let m = indexCache.get(gl)
  if (!m) indexCache.set(gl, (m = new Map()))
  const key = `${cols}x${rows}`
  let b = m.get(key)
  if (b) return b
  const per = 2 * rows + 1
  const idx = new Uint32Array(Math.max(1, (cols - 1) * per))
  let k = 0
  for (let c = 0; c < cols - 1; c++) {
    const a = c * rows, n = (c + 1) * rows
    for (let r = 0; r < rows; r++) {
      idx[k++] = a + r
      idx[k++] = n + r
    }
    idx[k++] = 0xffffffff
  }
  b = gl.createBuffer()!
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b)
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW)
  m.set(key, b)
  return b
}

/** Shared height-texture surface: texture width = rows, height = columns (one texture row per column). */
abstract class SurfaceBase extends Series3D {
  protected fill: Fill
  protected wire: LineStyle = emptyLine
  protected contour: { interval: number; line: LineStyle } | null = null
  readonly rows: number
  /** Texture columns (grid columns or ring capacity). */
  protected texCols: number
  protected hgt: Float32Array
  protected intens: Float32Array | null = null
  private texH: WebGLTexture | null = null
  private texCtx: WebGL2RenderingContext | null = null
  private texI: WebGLTexture | null = null
  protected dirtyH = new Uint8Array(0)
  protected dirtyI = new Uint8Array(0)
  protected anyDirtyH = true
  protected anyDirtyI = true

  constructor(chart: Chart3DHost, ci: number, name: string, texCols: number, rows: number) {
    super(chart, ci, name)
    this.rows = Math.max(2, rows | 0)
    this.texCols = Math.max(2, texCols | 0)
    this.hgt = new Float32Array(this.texCols * this.rows).fill(NaN)
    this.dirtyH = new Uint8Array(this.texCols).fill(1)
    this.dirtyI = new Uint8Array(this.texCols).fill(1)
    this.fill = new SolidFill({ color: this.defaultColor() })
    this.effect = false
  }

  setFillStyle(f: Mutator<Fill>) { this.fill = resolve(this.fill, f); this.chart.onSeriesStyle(this); return this }
  getFillStyle() { return this.fill }
  setWireframeStyle(l: Mutator<LineStyle>) { this.wire = resolve(this.wire, l); this.chart.requestRender(); return this }
  getWireframeStyle() { return this.wire }
  /** Iso-height contour lines every `interval` (Y units); undefined disables. */
  setContours(o: { interval: number; lineStyle?: LineStyle } | undefined) {
    this.contour = o && o.interval > 0
      ? { interval: o.interval, line: o.lineStyle ?? new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: this.theme.isDark ? ColorRGBA(255, 255, 255, 110) : ColorRGBA(0, 0, 0, 90) }) }) }
      : null
    this.chart.requestRender()
    return this
  }
  setIntensityInterpolation(_v: unknown) { return this }
  setCullMode(_v: unknown) { return this }

  primaryColor() { return this.fill.type !== 'empty' ? this.fill.getPrimaryColor() : this.defaultColor() }
  override isTransparent() { return !(this.fill instanceof PalettedFill) && this.fill.type !== 'empty' && this.primaryColor().a < 250 }
  getLegendSymbol(): LegendSymbol { return { kind: 'rect', color: this.primaryColor() } }
  override legendLUT() { return lutOf(this.fill) }

  protected markCols(which: 'h' | 'i', c0: number, c1: number) {
    const d = which === 'h' ? this.dirtyH : this.dirtyI
    for (let c = Math.max(0, c0); c < Math.min(this.texCols, c1); c++) d[c] = 1
    if (which === 'h') this.anyDirtyH = true
    else this.anyDirtyI = true
  }

  private uploadTex(gl: WebGL2RenderingContext, tex: WebGLTexture | null, data: Float32Array, dirty: Uint8Array): WebGLTexture {
    let t = tex
    if (!t) {
      t = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R32F, this.rows, this.texCols)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      dirty.fill(1)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, t)
    }
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
    const R = this.rows
    let c = 0
    while (c < this.texCols) {
      if (!dirty[c]) { c++; continue }
      let e = c
      while (e < this.texCols && dirty[e]) dirty[e++] = 0
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, c, R, e - c, gl.RED, gl.FLOAT, data, c * R)
      c = e
    }
    return t
  }

  /** Bind textures and draw `logicalCols` columns starting at texture column `ring`. */
  protected drawSurface(r: GLRenderer, f: Frame3D, o: { ox: number; oz: number; dx: number; dz: number; logicalCols: number; ring: number }) {
    if (o.logicalCols < 2) return
    const fillOn = this.fill.type !== 'empty'
    const wireOn = !isEmptyLine(this.wire)
    const ct = this.contour && !isEmptyLine(this.contour.line) ? this.contour : null
    if (!fillOn && !wireOn && !ct) return
    const gl = r.gl
    if (this.texCtx !== gl) {
      // New (or replacement) context: recreate textures and upload everything.
      this.texH = null
      this.texI = null
      this.texCtx = gl
    }
    if (this.anyDirtyH || !this.texH) {
      this.texH = this.uploadTex(gl, this.texH, this.hgt, this.dirtyH)
      this.anyDirtyH = false
    }
    const pal = this.fill instanceof PalettedFill ? this.fill : null
    const useInt = !!this.intens && !!pal && pal.lookUpProperty === 'value'
    if (useInt && (this.anyDirtyI || !this.texI)) {
      this.texI = this.uploadTex(gl, this.texI, this.intens!, this.dirtyI)
      this.anyDirtyI = false
    }
    const prog = program3d(r, 'c3d-surf', SURF_VS, SURF_FS)
    setCommon(r, prog, f, o.ox, 0, o.oz, { clip: this.clipping, shading: this.shading })
    setFillUniforms(r, prog, fillOn ? this.fill : null, this.defaultColor(), [o.ox, 0, o.oz], (p) => this.propRange(p))
    gl.uniform1i(prog.u.u_fill, fillOn ? 1 : 0)
    if (wireOn) {
      const wc = this.wire.getFillStyle().getPrimaryColor().toFloat()
      gl.uniform1f(prog.u.u_wireW, Math.max(0.5, this.wire.getThickness()) * r.dpr)
      gl.uniform4f(prog.u.u_wireColor, wc[0], wc[1], wc[2], wc[3])
    } else {
      gl.uniform1f(prog.u.u_wireW, 0)
    }
    if (ct) {
      const cc = ct.line.getFillStyle().getPrimaryColor().toFloat()
      gl.uniform2f(prog.u.u_contour, ct.interval, Math.max(0.5, ct.line.getThickness()) * r.dpr)
      gl.uniform4f(prog.u.u_contourColor, cc[0], cc[1], cc[2], cc[3])
    } else {
      gl.uniform2f(prog.u.u_contour, 0, 0)
    }
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.texH)
    gl.uniform1i(prog.u.u_hgt, 1)
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_2D, useInt ? this.texI : this.texH)
    gl.uniform1i(prog.u.u_int, 2)
    gl.uniform1i(prog.u.u_hasInt, useInt ? 1 : 0)
    gl.uniform2i(prog.u.u_grid, o.logicalCols, this.rows)
    gl.uniform1i(prog.u.u_cap, this.texCols)
    gl.uniform1i(prog.u.u_ring, o.ring)
    gl.uniform4f(prog.u.u_xz, 0, o.dx, 0, o.dz)
    r.resetAttribs([])
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gridIndex(gl, this.texCols, this.rows))
    gl.drawElements(gl.TRIANGLE_STRIP, (o.logicalCols - 1) * (2 * this.rows + 1), gl.UNSIGNED_INT, 0)
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Coarse-to-fine screen-space pick over the grid. */
  protected pickGrid(
    f: Frame3D, sx: number, sy: number,
    o: { ox: number; oz: number; dx: number; dz: number; logicalCols: number; ring: number },
  ): Hit3D | null {
    const C = o.logicalCols, R = this.rows
    if (C < 1) return null
    const m = dataToCss(f, o.ox, 0, o.oz, tmpM)
    const H = (c: number, rr: number) => this.hgt[((c + o.ring) % this.texCols) * R + rr]
    const proj = (c: number, rr: number) => {
      const x = c * o.dx, y = H(c, rr), z = rr * o.dz
      if (!Number.isFinite(y)) return null
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]
      if (!(w > 1e-6)) return null
      return { px: (m[0] * x + m[4] * y + m[8] * z + m[12]) / w, py: (m[1] * x + m[5] * y + m[9] * z + m[13]) / w, w }
    }
    const search = (c0: number, c1: number, r0: number, r1: number, step: number, cover: number) => {
      let best: { c: number; r: number; d2: number; w: number } | null = null
      let covered = false
      for (let c = c0; c <= c1; c += step)
        for (let rr = r0; rr <= r1; rr += step) {
          const p = proj(c, rr)
          if (!p) continue
          const d2 = (p.px - sx) ** 2 + (p.py - sy) ** 2
          if (d2 <= cover * cover) {
            if (!covered || p.w < best!.w) { covered = true; best = { c, r: rr, d2, w: p.w } }
          } else if (!covered && (!best || d2 < best.d2)) best = { c, r: rr, d2, w: p.w }
        }
      return best
    }
    const step = Math.max(1, Math.ceil(Math.sqrt((C * R) / 40000)))
    const coarse = search(0, C - 1, 0, R - 1, step, 14)
    if (!coarse) return null
    const fine = step > 1
      ? search(Math.max(0, coarse.c - step), Math.min(C - 1, coarse.c + step), Math.max(0, coarse.r - step), Math.min(R - 1, coarse.r + step), 1, 3)
      : coarse
    if (!fine || fine.d2 > 40 * 40) return null
    const p = proj(fine.c, fine.r)!
    const x = o.ox + fine.c * o.dx, y = H(fine.c, fine.r), z = o.oz + fine.r * o.dz
    if (!inBox(f, x, y, z)) return null
    const tc = ((fine.c + o.ring) % this.texCols) * R + fine.r
    const iv = this.intens ? this.intens[tc] : undefined
    const pal = this.fill instanceof PalettedFill ? this.fill : null
    const lv = pal ? (pal.lookUpProperty === 'value' ? iv ?? y : pal.lookUpProperty === 'x' ? x : pal.lookUpProperty === 'z' ? z : y) : 0
    return {
      series: this, x, y, z, value: iv,
      sx: p.px, sy: p.py, w: p.w, d2: fine.d2,
      color: pal ? pal.lut.getColor(lv) : this.primaryColor(),
    }
  }

  override disposeGL(r: GLRenderer | null) {
    if (r && r.gl === this.texCtx) {
      if (this.texH) r.gl.deleteTexture(this.texH)
      if (this.texI) r.gl.deleteTexture(this.texI)
    }
    this.texH = this.texI = null
    this.anyDirtyH = this.anyDirtyI = true
  }
}

const tmpM = new Float64Array(16)

/** Write a column-major (texture layout) region from nested arrays in the given data order. */
function writeRegion(dst: Float32Array, cols: number, rows: number, order: 'columns' | 'rows', c0: number, r0: number, values: ArrayLike<number>[]) {
  let cmin = Infinity, cmax = -1
  if (order === 'columns') {
    for (let i = 0; i < values.length; i++) {
      const c = c0 + i
      if (c < 0 || c >= cols) continue
      const col = values[i]
      const n = Math.min(col.length, rows - r0)
      for (let j = Math.max(0, -r0); j < n; j++) dst[c * rows + r0 + j] = col[j]
      cmin = Math.min(cmin, c)
      cmax = Math.max(cmax, c)
    }
  } else {
    for (let j = 0; j < values.length; j++) {
      const rr = r0 + j
      if (rr < 0 || rr >= rows) continue
      const row = values[j]
      const n = Math.min(row.length, cols - c0)
      for (let i = Math.max(0, -c0); i < n; i++) dst[(c0 + i) * rows + rr] = row[i]
      if (n > 0) {
        cmin = Math.min(cmin, Math.max(0, c0))
        cmax = Math.max(cmax, c0 + n - 1)
      }
    }
  }
  return [cmin, cmax + 1] as const
}

function minMax(a: Float32Array, from = 0, to = a.length): [number, number] {
  let lo = Infinity, hi = -Infinity
  for (let i = from; i < to; i++) {
    const v = a[i]
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  return [lo, hi]
}

// ------------------------------------------------------------------ static grid

export interface SurfaceGridSeries3DOptions extends Series3DOptions {
  columns: number
  rows: number
  /** 'columns': values[column][row]; 'rows': values[row][column]. Columns run along X, rows along Z. */
  dataOrder?: 'columns' | 'rows'
  start?: XZ
  end?: XZ
  step?: XZ
}

/** Height-map surface on the XZ plane. Handles 1024x1024+ grids. */
export class SurfaceGridSeries3D extends SurfaceBase {
  readonly columns: number
  readonly dataOrder: 'columns' | 'rows'
  private start: XZ
  private end: XZ
  private hRange: [number, number] = [Infinity, -Infinity]
  private iRange: [number, number] = [Infinity, -Infinity]

  constructor(chart: Chart3DHost, ci: number, o: SurfaceGridSeries3DOptions) {
    super(chart, ci, 'Surface Grid Series 3D', o.columns, o.rows)
    this.columns = this.texCols
    this.dataOrder = o.dataOrder ?? 'columns'
    this.start = o.start ?? { x: 0, z: 0 }
    if (o.end) this.end = o.end
    else if (o.step) this.end = { x: this.start.x + o.step.x * (this.columns - 1), z: this.start.z + o.step.z * (this.rows - 1) }
    else this.end = { x: this.start.x + this.columns - 1, z: this.start.z + this.rows - 1 }
  }

  setStart(p: XZ) {
    const w = this.end.x - this.start.x, d = this.end.z - this.start.z
    this.start = { x: p.x, z: p.z }
    this.end = { x: p.x + w, z: p.z + d }
    this.chart.onSeriesData(this)
    return this
  }
  setEnd(p: XZ) { this.end = { x: p.x, z: p.z }; this.chart.onSeriesData(this); return this }
  setStep(s: XZ) {
    this.end = { x: this.start.x + s.x * (this.columns - 1), z: this.start.z + s.z * (this.rows - 1) }
    this.chart.onSeriesData(this)
    return this
  }
  getStart() { return { ...this.start } }
  getEnd() { return { ...this.end } }

  private invalidate(which: 'h' | 'i', v: ArrayLike<number>[] | Region | ArrayLike<number>) {
    let arr = which === 'h' ? this.hgt : this.intens
    if (!arr) arr = this.intens = new Float32Array(this.columns * this.rows).fill(NaN)
    const C = this.columns, R = this.rows
    let full = false
    let written: ArrayLike<number>[] = []
    if (isFlat(v)) {
      // Flat array in data order.
      const a = v as ArrayLike<number>
      if (this.dataOrder === 'columns') {
        if (ArrayBuffer.isView(a) && a.length <= arr.length) arr.set(a)
        else for (let i = 0, n = Math.min(a.length, arr.length); i < n; i++) arr[i] = a[i]
      } else {
        for (let rr = 0; rr < R; rr++) for (let c = 0; c < C; c++) arr[c * R + rr] = a[rr * C + c]
      }
      this.markCols(which, 0, C)
      full = true
    } else {
      const reg: Region = Array.isArray(v) ? { values: v as ArrayLike<number>[] } : (v as Region)
      const [a, b] = writeRegion(arr, C, R, this.dataOrder, reg.iColumn ?? 0, reg.iRow ?? 0, reg.values)
      this.markCols(which, a, b)
      full = !reg.iColumn && !reg.iRow && reg.values.length >= (this.dataOrder === 'columns' ? C : R)
      written = reg.values
    }
    if (full) {
      const mm = minMax(arr)
      if (which === 'h') this.hRange = mm
      else this.iRange = mm
    } else {
      const rng = which === 'h' ? this.hRange : this.iRange
      for (const col of written) for (let k = 0; k < col.length; k++) {
        const x = col[k]
        if (x < rng[0]) rng[0] = x
        if (x > rng[1]) rng[1] = x
      }
    }
    this.chart.onSeriesData(this)
    return this
  }

  /** Heights: number[][] in `dataOrder`, a region {iColumn, iRow, values}, or a flat array in data order. */
  invalidateHeightMap(v: ArrayLike<number>[] | Region | ArrayLike<number>) { return this.invalidate('h', v) }
  /** Values for PalettedFill lookUpProperty 'value'. Same shapes as invalidateHeightMap. */
  invalidateIntensityValues(v: ArrayLike<number>[] | Region | ArrayLike<number>) { return this.invalidate('i', v) }

  bounds(): Bounds3D | null {
    if (!(this.hRange[0] <= this.hRange[1])) return null
    return {
      xmin: Math.min(this.start.x, this.end.x), xmax: Math.max(this.start.x, this.end.x),
      ymin: this.hRange[0], ymax: this.hRange[1],
      zmin: Math.min(this.start.z, this.end.z), zmax: Math.max(this.start.z, this.end.z),
    }
  }
  override propRange(p: LookUpProperty) {
    if (p === 'value') return this.iRange[0] <= this.iRange[1] ? [...this.iRange] as [number, number] : null
    return super.propRange(p)
  }
  private geom() {
    return {
      ox: this.start.x, oz: this.start.z,
      dx: (this.end.x - this.start.x) / (this.columns - 1), dz: (this.end.z - this.start.z) / (this.rows - 1),
      logicalCols: this.columns, ring: 0,
    }
  }
  drawGL(r: GLRenderer, f: Frame3D) { this.drawSurface(r, f, this.geom()) }
  override pick(sx: number, sy: number, f: Frame3D) { return this.pickGrid(f, sx, sy, this.geom()) }
}

const isFlat = (v: unknown): boolean =>
  ArrayBuffer.isView(v) || (Array.isArray(v) && (v.length === 0 || typeof v[0] === 'number'))

// ------------------------------------------------------------------ scrolling grid

export interface SurfaceScrollingGridSeries3DOptions extends Series3DOptions {
  /** Ring capacity in columns (X). */
  columns: number
  rows: number
  scrollDimension?: 'columns' | 'rows'
  start?: XZ
  step?: XZ
}

/** Surface that scrolls along X as columns are appended. */
export class SurfaceScrollingGridSeries3D extends SurfaceBase {
  readonly columns: number
  private start: XZ
  private step: XZ
  private head = 0
  private filled = 0
  private pushed = 0
  private colMin: Float32Array
  private colMax: Float32Array
  private icolMin: Float32Array
  private icolMax: Float32Array

  constructor(chart: Chart3DHost, ci: number, o: SurfaceScrollingGridSeries3DOptions) {
    super(chart, ci, 'Surface Scrolling Grid Series 3D', o.columns, o.rows)
    if ((o.scrollDimension ?? 'columns') !== 'columns') console.warn('sferic: Chart3D scrolling surfaces support scrollDimension "columns" only')
    this.columns = this.texCols
    this.start = o.start ?? { x: 0, z: 0 }
    this.step = o.step ?? { x: 1, z: 1 }
    this.colMin = new Float32Array(this.columns).fill(Infinity)
    this.colMax = new Float32Array(this.columns).fill(-Infinity)
    this.icolMin = new Float32Array(this.columns).fill(Infinity)
    this.icolMax = new Float32Array(this.columns).fill(-Infinity)
  }

  setStart(p: XZ) { this.start = { x: p.x, z: p.z }; this.chart.onSeriesData(this); return this }
  setStep(s: XZ) { this.step = { x: s.x, z: s.z }; this.chart.onSeriesData(this); return this }
  getStart() { return { ...this.start } }
  getStep() { return { ...this.step } }

  /** Append columns: each inner array holds `rows` values. */
  addValues(o: { yValues?: ArrayLike<number>[]; intensityValues?: ArrayLike<number>[] }) {
    const ys = o.yValues ?? [], is = o.intensityValues
    const n = Math.max(ys.length, is?.length ?? 0)
    if (is && !this.intens) this.intens = new Float32Array(this.columns * this.rows).fill(NaN)
    const R = this.rows
    for (let k = 0; k < n; k++) {
      let tc: number
      if (this.filled < this.columns) {
        tc = (this.head + this.filled) % this.columns
        this.filled++
      } else {
        tc = this.head
        this.head = (this.head + 1) % this.columns
      }
      this.pushed++
      const col = ys[k]
      let lo = Infinity, hi = -Infinity
      for (let r = 0; r < R; r++) {
        const v = col && r < col.length ? col[r] : NaN
        this.hgt[tc * R + r] = v
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      this.colMin[tc] = lo
      this.colMax[tc] = hi
      this.dirtyH[tc] = 1
      if (this.intens) {
        const ic = is?.[k]
        let ilo = Infinity, ihi = -Infinity
        for (let r = 0; r < R; r++) {
          const v = ic && r < ic.length ? ic[r] : NaN
          this.intens[tc * R + r] = v
          if (v < ilo) ilo = v
          if (v > ihi) ihi = v
        }
        this.icolMin[tc] = ilo
        this.icolMax[tc] = ihi
        this.dirtyI[tc] = 1
      }
    }
    this.anyDirtyH = true
    this.anyDirtyI = true
    this.chart.onSeriesData(this)
    return this
  }
  clear() {
    this.head = this.filled = this.pushed = 0
    this.hgt.fill(NaN)
    this.intens?.fill(NaN)
    this.colMin.fill(Infinity)
    this.colMax.fill(-Infinity)
    this.icolMin.fill(Infinity)
    this.icolMax.fill(-Infinity)
    this.markCols('h', 0, this.columns)
    this.markCols('i', 0, this.columns)
    this.chart.onSeriesData(this)
    return this
  }
  getSampleCount() { return this.filled }

  private range(a: Float32Array, b: Float32Array): [number, number] | null {
    let lo = Infinity, hi = -Infinity
    for (let i = 0; i < this.filled; i++) {
      const c = (this.head + i) % this.columns
      if (a[c] < lo) lo = a[c]
      if (b[c] > hi) hi = b[c]
    }
    return lo <= hi ? [lo, hi] : null
  }
  private geom() {
    return {
      ox: this.start.x + (this.pushed - this.filled) * this.step.x, oz: this.start.z,
      dx: this.step.x, dz: this.step.z, logicalCols: this.filled, ring: this.head,
    }
  }
  bounds(): Bounds3D | null {
    const y = this.range(this.colMin, this.colMax)
    if (!y || this.filled < 1) return null
    const g = this.geom()
    const x1 = g.ox + (this.filled - 1) * g.dx, z1 = g.oz + (this.rows - 1) * g.dz
    return {
      xmin: Math.min(g.ox, x1), xmax: Math.max(g.ox, x1),
      ymin: y[0], ymax: y[1],
      zmin: Math.min(g.oz, z1), zmax: Math.max(g.oz, z1),
    }
  }
  override propRange(p: LookUpProperty) {
    if (p === 'value') return this.intens ? this.range(this.icolMin, this.icolMax) : this.range(this.colMin, this.colMax)
    return super.propRange(p)
  }
  drawGL(r: GLRenderer, f: Frame3D) { this.drawSurface(r, f, this.geom()) }
  override pick(sx: number, sy: number, f: Frame3D) { return this.pickGrid(f, sx, sy, this.geom()) }
}

