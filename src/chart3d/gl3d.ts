import { Fill, LookUpProperty, LUT, PalettedFill, SolidFill } from '../core/style'
import { Color } from '../core/color'
import { GLRenderer, Program } from '../render/GLRenderer'
import { Rect } from '../core/util'
import { Mat4 } from './math3d'
import type { Axis3D } from './Axis3D'
import { ColorShadingStyle, shadeParams } from './styles3d'

/** Per-frame camera and mapping state shared by all series of a Chart3D. */
export interface Frame3D {
  view: Float32Array
  proj: Float32Array
  /** Float64 projection of world to CSS px (homogeneous; divide by w). */
  worldToCss: Mat4
  dims: [number, number, number]
  axes: [Axis3D, Axis3D, Axis3D]
  /** World size of one CSS px at the default camera distance (point sizes). */
  worldPerPx: number
  /** Device px per world unit at view distance 1 (impostor anti-aliasing). */
  pxScale: number
  dpr: number
  rect: Rect
  /** Light direction in view space (unit). */
  light: [number, number, number]
  /** Device px size of the whole surface. */
  res: [number, number]
  /** Camera position and basis (world), plus half-FOV tangents, for picking rays. */
  eye: [number, number, number]
  right: [number, number, number]
  up: [number, number, number]
  fwd: [number, number, number]
  tanH: number
  tanV: number
}

/** World-space ray through a CSS px position: [origin, direction]. */
export function worldRay(f: Frame3D, sx: number, sy: number): [[number, number, number], [number, number, number]] {
  const nx = ((sx - f.rect.x) / f.rect.w) * 2 - 1
  const ny = 1 - ((sy - f.rect.y) / f.rect.h) * 2
  const a = nx * f.tanH, b = ny * f.tanV
  return [f.eye, [f.right[0] * a + f.up[0] * b + f.fwd[0], f.right[1] * a + f.up[1] * b + f.fwd[1], f.right[2] * a + f.up[2] * b + f.fwd[2]]]
}

/** Ray in data space (relative to origin): origin and direction. */
export function dataRay(f: Frame3D, sx: number, sy: number, ox: number, oy: number, oz: number) {
  const [o, d] = worldRay(f, sx, sy)
  const { scale, bias } = dataMap(f, ox, oy, oz)
  return {
    o: [(o[0] - bias[0]) / scale[0], (o[1] - bias[1]) / scale[1], (o[2] - bias[2]) / scale[2]] as [number, number, number],
    d: [d[0] / scale[0], d[1] / scale[1], d[2] / scale[2]] as [number, number, number],
  }
}

/** Data (relative to origin) -> world affine: world = p * scale + bias, computed in float64. */
export function dataMap(f: Frame3D, ox: number, oy: number, oz: number): { scale: [number, number, number]; bias: [number, number, number] } {
  const [ax, ay, az] = f.axes
  const [dx, dy, dz] = f.dims
  const kx = dx / (ax.end - ax.start || 1)
  const ky = dy / (ay.end - ay.start || 1)
  const kz = -dz / (az.end - az.start || 1)
  return {
    scale: [kx, ky, kz],
    bias: [(ox - ax.start) * kx - dx / 2, (oy - ay.start) * ky - dy / 2, (oz - az.start) * kz + dz / 2],
  }
}

/** Data (relative to origin) -> CSS px homogeneous matrix (for CPU picking). */
export function dataToCss(f: Frame3D, ox: number, oy: number, oz: number, out: Float64Array): Float64Array {
  const { scale, bias } = dataMap(f, ox, oy, oz)
  const m = f.worldToCss
  // out = m * D where D = [diag(scale) | bias]
  for (let r = 0; r < 4; r++) {
    out[r] = m[r] * scale[0]
    out[4 + r] = m[4 + r] * scale[1]
    out[8 + r] = m[8 + r] * scale[2]
    out[12 + r] = m[r] * bias[0] + m[4 + r] * bias[1] + m[8 + r] * bias[2] + m[12 + r]
  }
  return out
}

export interface CommonOpts {
  clip?: boolean
  shading?: ColorShadingStyle
}

/** Bind camera, data mapping, lighting and glow uniforms. */
export function setCommon(r: GLRenderer, p: Program, f: Frame3D, ox: number, oy: number, oz: number, o: CommonOpts = {}) {
  const gl = r.gl
  gl.useProgram(p.prog)
  const { scale, bias } = dataMap(f, ox, oy, oz)
  gl.uniformMatrix4fv(p.u.u_view, false, f.view)
  gl.uniformMatrix4fv(p.u.u_proj, false, f.proj)
  gl.uniform3f(p.u.u_scale, scale[0], scale[1], scale[2])
  gl.uniform3f(p.u.u_bias, bias[0], bias[1], bias[2])
  gl.uniform3f(p.u.u_dims, f.dims[0], f.dims[1], f.dims[2])
  gl.uniform1f(p.u.u_clip, o.clip === false ? 0 : 1)
  gl.uniform3f(p.u.u_light, f.light[0], f.light[1], f.light[2])
  const sh = o.shading ? shadeParams(o.shading) : [1, 0, 0, 1]
  gl.uniform4f(p.u.u_shade, sh[0], sh[1], sh[2], sh[3])
  if (p.u.u_res) gl.uniform2f(p.u.u_res, f.res[0], f.res[1])
  if (p.u.u_glow) gl.uniform1f(p.u.u_glow, r.glow)
}

const progKeys = new Map<string, { vs: string; fs: string; key: string }>()
/** Program lookup keyed by a hash of the sources, so edited shaders (HMR) never hit a stale cache entry. */
export function program3d(r: GLRenderer, name: string, vs: string, fs: string): Program {
  let k = progKeys.get(name)
  if (!k || k.vs !== vs || k.fs !== fs) {
    let h = 2166136261
    const src = vs + fs
    for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 16777619)
    k = { vs, fs, key: `${name}-${(h >>> 0).toString(36)}` }
    progKeys.set(name, k)
  }
  return r.program(k.key, vs, fs)
}

const lutModeOf = (p: LookUpProperty) => (p === 'x' ? 1 : p === 'y' ? 2 : p === 'z' ? 3 : 4)

/**
 * Bind color: returns the uniform color (white when paletted) and binds the LUT on unit 0.
 * `range` gives the data range of the looked-up property for percentage LUTs.
 */
export function setFillUniforms(
  r: GLRenderer,
  p: Program,
  fill: Fill | null,
  fallback: Color,
  origin: [number, number, number],
  range?: (prop: LookUpProperty) => [number, number] | null,
  useCol = false,
) {
  const gl = r.gl
  gl.uniform1i(p.u.u_useCol, useCol && !(fill instanceof PalettedFill) ? 1 : 0)
  if (fill instanceof PalettedFill) {
    const lut = fill.lut
    const prop = fill.lookUpProperty
    let lo = lut.min, hi = lut.max
    if (lut.percentageValues) {
      const rr = range?.(prop)
      if (rr) {
        lo = rr[0] + (rr[1] - rr[0]) * lut.min
        hi = rr[0] + (rr[1] - rr[0]) * lut.max
      }
    }
    const o = prop === 'x' ? origin[0] : prop === 'y' ? origin[1] : prop === 'z' ? origin[2] : 0
    r.useLUT(p, lutModeOf(prop), lut, [lo - o, hi - o])
    gl.uniform4f(p.u.u_color, 1, 1, 1, 1)
    return
  }
  r.useLUT(p, 0, null)
  const c = (fill instanceof SolidFill ? fill.color : fill && fill.type !== 'empty' ? fill.getPrimaryColor() : fallback).toFloat()
  gl.uniform4f(p.u.u_color, c[0], c[1], c[2], c[3])
}

export const isPaletted = (f: Fill | null): f is PalettedFill => f instanceof PalettedFill
export const lutOf = (f: Fill | null): LUT | null => (f instanceof PalettedFill ? f.lut : null)

// ------------------------------------------------------------------ growable GPU buffer

export class GLBuf {
  buf: WebGLBuffer | null = null
  bytes = 0
  private ctx: WebGL2RenderingContext | null = null
  /** True when the handle belongs to a different (lost) context and data must be re-uploaded. */
  stale(gl: WebGL2RenderingContext) { return this.buf !== null && this.ctx !== gl }
  /** Ensure capacity in bytes (contents are lost on growth). Returns true when (re)allocated. */
  ensure(gl: WebGL2RenderingContext, bytes: number, target: number = gl.ARRAY_BUFFER): boolean {
    if (this.ctx !== gl) {
      this.buf = null
      this.bytes = 0
      this.ctx = gl
    }
    if (!this.buf) this.buf = gl.createBuffer()!
    gl.bindBuffer(target, this.buf)
    if (bytes <= this.bytes) return false
    this.bytes = Math.max(bytes, 64)
    gl.bufferData(target, this.bytes, gl.DYNAMIC_DRAW)
    return true
  }
  dispose(gl: WebGL2RenderingContext | null) {
    if (gl && this.buf && gl === this.ctx) gl.deleteBuffer(this.buf)
    this.buf = null
    this.bytes = 0
  }
}

// ------------------------------------------------------------------ unit meshes (non-indexed, pos + normal)

export interface ShapeMesh { buf: WebGLBuffer; count: number }

function pushTri(out: number[], a: number[], b: number[], c: number[], n?: number[]) {
  let nn = n
  if (!nn) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2]
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2]
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx
    const l = Math.hypot(x, y, z) || 1
    nn = [x / l, y / l, z / l]
  }
  out.push(...a, ...nn, ...b, ...nn, ...c, ...nn)
}

function cubeMesh(h = 1): number[] {
  const o: number[] = []
  const f = (n: number[], u: number[], v: number[]) => {
    const c = n.map((x) => x * h)
    const p = (su: number, sv: number) => [c[0] + (u[0] * su + v[0] * sv) * h, c[1] + (u[1] * su + v[1] * sv) * h, c[2] + (u[2] * su + v[2] * sv) * h]
    pushTri(o, p(-1, -1), p(1, -1), p(1, 1), n)
    pushTri(o, p(-1, -1), p(1, 1), p(-1, 1), n)
  }
  f([1, 0, 0], [0, 1, 0], [0, 0, 1]); f([-1, 0, 0], [0, 0, 1], [0, 1, 0])
  f([0, 1, 0], [0, 0, 1], [1, 0, 0]); f([0, -1, 0], [1, 0, 0], [0, 0, 1])
  f([0, 0, 1], [1, 0, 0], [0, 1, 0]); f([0, 0, -1], [0, 1, 0], [1, 0, 0])
  return o
}

function sphereMesh(seg = 16, rings = 12): number[] {
  const o: number[] = []
  const pt = (i: number, j: number) => {
    const th = (j / rings) * Math.PI, ph = (i / seg) * Math.PI * 2
    return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)]
  }
  for (let j = 0; j < rings; j++)
    for (let i = 0; i < seg; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1)
      o.push(...a, ...a, ...c, ...c, ...b, ...b)
      o.push(...a, ...a, ...d, ...d, ...c, ...c)
    }
  return o
}

/** Cylinder / cone along Y in [-1, 1]; `top` = top radius. */
function lathe(top: number, seg = 18): number[] {
  const o: number[] = []
  const slope = (1 - top) / 2
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2
    const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1)
    const n0 = norm3([c0, slope, s0]), n1 = norm3([c1, slope, s1])
    const b0 = [c0, -1, s0], b1 = [c1, -1, s1], t0 = [c0 * top, 1, s0 * top], t1 = [c1 * top, 1, s1 * top]
    o.push(...b0, ...n0, ...t1, ...n1, ...b1, ...n1)
    if (top > 0) o.push(...b0, ...n0, ...t0, ...n0, ...t1, ...n1)
    pushTri(o, [0, -1, 0], b0, b1, [0, -1, 0])
    if (top > 0) pushTri(o, [0, 1, 0], t1, t0, [0, 1, 0])
  }
  return o
}

function pyramidMesh(): number[] {
  const o: number[] = []
  const apex = [0, 1, 0]
  const b = [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]
  for (let i = 0; i < 4; i++) pushTri(o, b[i], apex, b[(i + 1) % 4])
  pushTri(o, b[0], b[1], b[2], [0, -1, 0])
  pushTri(o, b[0], b[2], b[3], [0, -1, 0])
  return o
}

function octaMesh(): number[] {
  const o: number[] = []
  const v = [[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]
  for (let i = 0; i < 4; i++) {
    const a = v[i], b = v[(i + 1) % 4]
    pushTri(o, a, [0, 1.25, 0], b)
    pushTri(o, b, [0, -1.25, 0], a)
  }
  return o
}

const norm3 = (v: number[]) => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

const meshCache = new WeakMap<WebGL2RenderingContext, Map<string, ShapeMesh>>()

/** Cached unit mesh for a point shape; interleaved [pos3, normal3]. */
export function shapeMesh(gl: WebGL2RenderingContext, shape: string): ShapeMesh {
  let m = meshCache.get(gl)
  if (!m) meshCache.set(gl, (m = new Map()))
  const key = shape === 'box' ? 'cube' : shape
  let s = m.get(key)
  if (s) return s
  const data =
    key === 'cube' ? cubeMesh(0.82)
      : key === 'cylinder' ? lathe(1)
      : key === 'cone' ? lathe(0)
      : key === 'pyramid' ? pyramidMesh()
      : key === 'diamond' ? octaMesh()
      : key === 'unitbox' ? cubeMesh(0.5)
      : sphereMesh()
  const buf = gl.createBuffer()!
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW)
  s = { buf, count: data.length / 6 }
  m.set(key, s)
  return s
}
