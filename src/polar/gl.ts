// Small GL helpers for charts whose geometry is computed on the CPU in CSS px
// (polar and spider series): instanced segments, points, triangles, polar heatmap.
import { Color } from '../core/color'
import { DashedLine, Fill, LinearGradientFill, LUT, PalettedFill, RadialGradientFill, sampleStops, SolidFill } from '../core/style'
import { Rect } from '../core/util'
import { AxisMap, GLRenderer, makeXform, Program } from '../render/GLRenderer'
import { HeatmapTexture, PointShapeName, shapeIndex } from '../render/draw'
import * as S from '../render/shaders'

const { ATTR } = S
const ID: AxisMap = { a0: 0, start: 0, k: 1, log: 0 }
export const WHITE = 0xffffffff
export const WHITE_COLOR = new Color(255, 255, 255, 255)

/** Bind a program with an identity transform: positions are CSS px. Uniforms go through the renderer's cache. */
function usePx(r: GLRenderer, p: Program) { r.useXform(p, makeXform(ID, ID, 0, 0, r.dpr)) }

/** Grow-only dynamic buffer. */
class Buf {
  buf: WebGLBuffer | null = null
  private cap = 0
  upload(gl: WebGL2RenderingContext, data: Float32Array | Uint32Array, count: number) {
    if (!this.buf) this.buf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf)
    const bytes = count * 4
    if (bytes > this.cap) {
      this.cap = Math.max(bytes, this.cap * 2, 4096)
      gl.bufferData(gl.ARRAY_BUFFER, this.cap, gl.DYNAMIC_DRAW)
    }
    if (count > 0) gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count)
  }
  dispose(r: GLRenderer | null) {
    if (r && this.buf) r.gl.deleteBuffer(this.buf)
    this.buf = null
    this.cap = 0
  }
}

const growF = (a: Float32Array, need: number): Float32Array => {
  if (need <= a.length) return a
  const b = new Float32Array(Math.max(need, a.length * 2))
  b.set(a)
  return b
}
const growU = (a: Uint32Array, need: number): Uint32Array => {
  if (need <= a.length) return a
  const b = new Uint32Array(Math.max(need, a.length * 2))
  b.set(a)
  return b
}

/** Independent thick segments (capsules) with per-end colors and dash distances. */
export class PxSegments {
  n = 0
  private pos: Float32Array = new Float32Array(1024)
  private col: Uint32Array = new Uint32Array(512)
  private dist: Float32Array = new Float32Array(256)
  private pb = new Buf()
  private cb = new Buf()
  private db = new Buf()
  private dirty = true
  clear() { this.n = 0; this.dirty = true }
  /** d = cumulative stroke distance at the segment start, in device px (for dashes). */
  push(x0: number, y0: number, x1: number, y1: number, c0 = WHITE, c1 = c0, d = 0) {
    const i = this.n++
    this.pos = growF(this.pos, this.n * 4)
    this.col = growU(this.col, this.n * 2)
    this.dist = growF(this.dist, this.n)
    this.pos[i * 4] = x0
    this.pos[i * 4 + 1] = y0
    this.pos[i * 4 + 2] = x1
    this.pos[i * 4 + 3] = y1
    this.col[i * 2] = c0
    this.col[i * 2 + 1] = c1
    this.dist[i] = d
    this.dirty = true
  }
  draw(r: GLRenderer, color: Color, thickness: number, dashed: DashedLine | null) {
    if (!this.n || color.a === 0 || thickness === 0) return
    const gl = r.gl
    if (this.dirty) {
      this.pb.upload(gl, this.pos, this.n * 4)
      this.cb.upload(gl, this.col, this.n * 2)
      if (dashed) this.db.upload(gl, this.dist, this.n)
      this.dirty = false
    }
    const p = r.program('line', S.LINE_VS, S.LINE_FS)
    usePx(r, p)
    const c = color.toFloat()
    r.u4f(p.u.u_color, c[0], c[1], c[2], c[3])
    r.u1f(p.u.u_halfw, (Math.max(0.5, thickness < 0 ? 1 : thickness) * r.dpr) / 2)
    r.useLUT(p, 0, null)
    const keep: number[] = [ATTR.corner, ATTR.p0, ATTR.p1, ATTR.c0, ATTR.c1]
    if (dashed) {
      keep.push(ATTR.d0)
      const pat = dashed.dashArray().map((v) => v * r.dpr)
      while (pat.length < 4) pat.push(...pat)
      r.u4f(p.u.u_dash, pat[0], pat[1], pat[2], pat[3])
      r.u1f(p.u.u_dashPeriod, pat[0] + pat[1] + pat[2] + pat[3])
    } else {
      r.u1f(p.u.u_dashPeriod, 0)
    }
    r.resetAttribs(keep)
    r.attrib(ATTR.corner, r.cornerBuffer('line'), 2, gl.FLOAT, false, 0, 0, 0)
    r.attrib(ATTR.p0, this.pb.buf!, 2, gl.FLOAT, false, 16, 0, 1)
    r.attrib(ATTR.p1, this.pb.buf!, 2, gl.FLOAT, false, 16, 8, 1)
    r.attrib(ATTR.c0, this.cb.buf!, 4, gl.UNSIGNED_BYTE, true, 8, 0, 1)
    r.attrib(ATTR.c1, this.cb.buf!, 4, gl.UNSIGNED_BYTE, true, 8, 4, 1)
    if (dashed) {
      if (!this.db.buf) this.db.upload(gl, this.dist, this.n)
      r.attrib(ATTR.d0, this.db.buf!, 1, gl.FLOAT, false, 4, 0, 1)
    }
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n)
  }
  dispose(r: GLRenderer | null) {
    this.pb.dispose(r)
    this.cb.dispose(r)
    this.db.dispose(r)
    this.dirty = true
  }
}

export interface PxPointStyle {
  size: number
  shape: PointShapeName
  color: Color
  strokeWidth?: number
  strokeColor?: Color
  /** Use the per-point colors. */
  colored?: boolean
}

/** Instanced point markers at CSS px positions. */
export class PxPoints {
  n = 0
  private pos: Float32Array = new Float32Array(512)
  private col: Uint32Array = new Uint32Array(256)
  private pb = new Buf()
  private cb = new Buf()
  private dirty = true
  clear() { this.n = 0; this.dirty = true }
  push(x: number, y: number, c = WHITE) {
    const i = this.n++
    this.pos = growF(this.pos, this.n * 2)
    this.col = growU(this.col, this.n)
    this.pos[i * 2] = x
    this.pos[i * 2 + 1] = y
    this.col[i] = c
    this.dirty = true
  }
  draw(r: GLRenderer, st: PxPointStyle) {
    if (!this.n || st.size <= 0 || st.color.a === 0) return
    const gl = r.gl
    if (this.dirty) {
      this.pb.upload(gl, this.pos, this.n * 2)
      this.cb.upload(gl, this.col, this.n)
      this.dirty = false
    }
    const p = r.program('point', S.POINT_VS, S.POINT_FS)
    usePx(r, p)
    const c = st.color.toFloat()
    r.u4f(p.u.u_color, c[0], c[1], c[2], c[3])
    r.u1f(p.u.u_size, st.size * r.dpr)
    r.u1f(p.u.u_sizeScale, r.dpr)
    r.u1i(p.u.u_shape, shapeIndex[st.shape] ?? 0)
    r.u1f(p.u.u_strokeW, (st.strokeWidth ?? 0) * r.dpr)
    const sc = (st.strokeColor ?? st.color).toFloat()
    r.u4f(p.u.u_strokeColor, sc[0], sc[1], sc[2], sc[3])
    r.useLUT(p, 0, null)
    const keep: number[] = [ATTR.corner, ATTR.p0]
    if (st.colored) keep.push(ATTR.c0)
    r.resetAttribs(keep)
    r.attrib(ATTR.corner, r.cornerBuffer('point'), 2, gl.FLOAT, false, 0, 0, 0)
    r.attrib(ATTR.p0, this.pb.buf!, 2, gl.FLOAT, false, 8, 0, 1)
    if (st.colored) r.attrib(ATTR.c0, this.cb.buf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.n)
  }
  dispose(r: GLRenderer | null) {
    this.pb.dispose(r)
    this.cb.dispose(r)
    this.dirty = true
  }
}

const TRI_VS = S.VS_HEAD + /* glsl */ `
layout(location = 1) in vec2 a_p0;
layout(location = 3) in vec4 a_c0;
uniform vec4 u_color;
out vec4 v_col;
out vec2 v_px;
void main() {
  v_col = u_color * a_c0;
  v_px = a_p0;
  gl_Position = pxToClip(toPx(a_p0));
}
`
const TRI_FS = S.FS_HEAD + /* glsl */ `
in vec4 v_col;
in vec2 v_px;
uniform int u_mode;           // 0 vertex colors, 1 LUT by amplitude (radius), 2 LUT by angle
uniform vec3 u_disc;          // center x, y, radius (CSS px)
uniform vec2 u_amp;           // amplitude at center, at radius
uniform vec2 u_rot;           // north (deg), direction
uniform sampler2D u_flut;
uniform vec2 u_flutRange;
void main() {
  if (u_mode == 0) { emit(v_col); return; }
  vec2 d = v_px - u_disc.xy;
  d.y = -d.y;
  float v = u_mode == 1
    ? u_amp.x + length(d) / u_disc.z * (u_amp.y - u_amp.x)
    : mod(u_rot.x + (degrees(atan(d.y, d.x)) - 90.0) * u_rot.y, 360.0);
  float t = clamp((v - u_flutRange.x) / max(u_flutRange.y - u_flutRange.x, 1e-30), 0.0, 1.0);
  emit(v_col * texture(u_flut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5)));
}
`

/** Per-pixel LUT coloring of triangles in a polar frame. */
export interface PolarLUTFill {
  lut: LUT
  /** 'amplitude' maps pixel radius, 'angle' maps pixel direction. */
  by: 'amplitude' | 'angle'
  cx: number; cy: number; R: number
  start: number; end: number
  north: number; dir: number
}

/** Plain triangle list with per-vertex colors (fills). Needs MSAA for smooth edges. */
export class PxTriangles {
  n = 0
  private pos: Float32Array = new Float32Array(1536)
  private col: Uint32Array = new Uint32Array(768)
  private pb = new Buf()
  private cb = new Buf()
  private dirty = true
  clear() { this.n = 0; this.dirty = true }
  push(x: number, y: number, c: number) {
    const i = this.n++
    this.pos = growF(this.pos, this.n * 2)
    this.col = growU(this.col, this.n)
    this.pos[i * 2] = x
    this.pos[i * 2 + 1] = y
    this.col[i] = c
    this.dirty = true
  }
  draw(r: GLRenderer, color: Color = WHITE_COLOR, lutFill: PolarLUTFill | null = null) {
    if (this.n < 3) return
    const gl = r.gl
    if (this.dirty) {
      this.pb.upload(gl, this.pos, this.n * 2)
      this.cb.upload(gl, this.col, this.n)
      this.dirty = false
    }
    const p = r.program('sferic-px-tri', TRI_VS, TRI_FS)
    usePx(r, p)
    const c = color.toFloat()
    r.u4f(p.u.u_color, c[0], c[1], c[2], c[3])
    r.u1i(p.u.u_mode, lutFill ? (lutFill.by === 'angle' ? 2 : 1) : 0)
    if (lutFill) {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, r.lutTexture(lutFill.lut))
      r.u1i(p.u.u_flut, 1)
      r.u2f(p.u.u_flutRange, lutFill.lut.min, lutFill.lut.max)
      // vec3 has no cached setter; this location is private to this program and never cached.
      gl.uniform3f(p.u.u_disc, lutFill.cx, lutFill.cy, lutFill.R)
      r.u2f(p.u.u_amp, lutFill.start, lutFill.end)
      r.u2f(p.u.u_rot, lutFill.north, lutFill.dir)
      gl.activeTexture(gl.TEXTURE0)
    }
    r.resetAttribs([ATTR.p0, ATTR.c0])
    r.attrib(ATTR.p0, this.pb.buf!, 2, gl.FLOAT, false, 8, 0, 0)
    r.attrib(ATTR.c0, this.cb.buf!, 4, gl.UNSIGNED_BYTE, true, 4, 0, 0)
    gl.drawArrays(gl.TRIANGLES, 0, this.n)
  }
  dispose(r: GLRenderer | null) {
    this.pb.dispose(r)
    this.cb.dispose(r)
    this.dirty = true
  }
}

/** Color of a fill at CSS px (x, y) within `box` (gradients), or for a LUT `value`. */
export function fillColorAt(f: Fill, x: number, y: number, box: Rect, value: number): Color {
  if (f instanceof SolidFill) return f.color
  if (f instanceof PalettedFill) return f.lut.getColor(value)
  if (f instanceof LinearGradientFill) {
    const a = (f.angle * Math.PI) / 180
    const dx = Math.cos(a), dy = -Math.sin(a)
    const half = (Math.abs(dx) * box.w + Math.abs(dy) * box.h) / 2 || 1
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2
    const t = ((x - (cx - dx * half)) * dx + (y - (cy - dy * half)) * dy) / (2 * half)
    return sampleStops(f.stops, Math.min(1, Math.max(0, t)))
  }
  if (f instanceof RadialGradientFill) {
    const cx = box.x + f.position.x * box.w, cy = box.y + f.position.y * box.h
    const rr = Math.hypot(Math.max(f.position.x, 1 - f.position.x) * box.w, Math.max(f.position.y, 1 - f.position.y) * box.h) || 1
    return sampleStops(f.stops, Math.min(1, Math.hypot(x - cx, y - cy) / rr))
  }
  return f.getPrimaryColor()
}

// ------------------------------------------------------------------ polar heatmap

const PHEAT_VS = S.VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
uniform vec4 u_box;
out vec2 v_px;
void main() {
  vec2 p = mix(u_box.xy, u_box.zw, a_corner);
  v_px = p;
  gl_Position = pxToClip(toPx(p));
}
`
const PHEAT_FS = S.FS_HEAD + /* glsl */ `
in vec2 v_px;
uniform vec3 u_disc;          // center x, y, radius (CSS px)
uniform vec2 u_amp;           // amplitude axis start, end
uniform vec2 u_hamp;          // heatmap amplitude start, end
uniform vec2 u_rot;           // north (deg), direction (+1 ccw, -1 cw)
uniform ivec2 u_dims;         // annuli, sectors
uniform highp sampler2D u_vals;
uniform sampler2D u_lut;
uniform vec2 u_lutRange;
uniform int u_interp;
uniform float u_opacity;
uniform float u_pxw;          // CSS px per device px
float val(int a, int s) {
  a = clamp(a, 0, u_dims.x - 1);
  s = s - u_dims.y * int(floor(float(s) / float(u_dims.y)));
  return texelFetch(u_vals, ivec2(a, s), 0).r;
}
void main() {
  vec2 d = v_px - u_disc.xy;
  d.y = -d.y;
  float rr = length(d);
  float edge = clamp((u_disc.z - rr) / u_pxw + 0.5, 0.0, 1.0);
  if (edge <= 0.0) discard;
  float amp = u_amp.x + rr / u_disc.z * (u_amp.y - u_amp.x);
  float an = (amp - u_hamp.x) / (u_hamp.y - u_hamp.x);
  if (an < 0.0 || an > 1.0) discard;
  float phi = degrees(atan(d.y, d.x));
  float th = mod(u_rot.x + (phi - 90.0) * u_rot.y, 360.0);
  float sc = th / 360.0 * float(u_dims.y);
  float ac = an * float(u_dims.x);
  float v;
  if (u_interp == 1) {
    float fa = ac - 0.5, fsec = sc - 0.5;
    int a0 = int(floor(fa)), s0 = int(floor(fsec));
    float ta = fa - floor(fa), ts = fsec - floor(fsec);
    float v00 = val(a0, s0), v10 = val(a0 + 1, s0), v01 = val(a0, s0 + 1), v11 = val(a0 + 1, s0 + 1);
    v = mix(mix(v00, v10, ta), mix(v01, v11, ta), ts);
  } else {
    v = val(int(ac), int(sc));
  }
  if (!(v == v)) discard;
  float t = clamp((v - u_lutRange.x) / max(u_lutRange.y - u_lutRange.x, 1e-30), 0.0, 1.0);
  vec4 c = texture(u_lut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
  emit(vec4(c.rgb, c.a * u_opacity * edge));
}
`

export interface PolarHeatParams {
  cx: number; cy: number; R: number
  start: number; end: number
  hStart: number; hEnd: number
  north: number; dir: number
  interpolate: boolean
  opacity: number
}

/** Draw a sectors x annuli value texture (cols = annuli, rows = sectors) over the polar disc. */
export function drawPolarHeatmap(r: GLRenderer, tex: HeatmapTexture, lut: LUT, o: PolarHeatParams) {
  const gl = r.gl
  const p = r.program('sferic-polar-heat', PHEAT_VS, PHEAT_FS)
  usePx(r, p)
  const pad = 2
  r.u4f(p.u.u_box, o.cx - o.R - pad, o.cy - o.R - pad, o.cx + o.R + pad, o.cy + o.R + pad)
  // vec3 / ivec2 have no cached setters; these locations are private to this program and never cached.
  gl.uniform3f(p.u.u_disc, o.cx, o.cy, o.R)
  r.u2f(p.u.u_amp, o.start, o.end)
  r.u2f(p.u.u_hamp, o.hStart, o.hEnd === o.hStart ? o.hStart + 1 : o.hEnd)
  r.u2f(p.u.u_rot, o.north, o.dir)
  gl.uniform2i(p.u.u_dims, tex.cols, tex.rows)
  tex.bind(r, 1)
  r.u1i(p.u.u_vals, 1)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindTexture(gl.TEXTURE_2D, r.lutTexture(lut))
  r.u1i(p.u.u_lut, 0)
  r.u2f(p.u.u_lutRange, lut.min, lut.max)
  r.u1i(p.u.u_lutMode, 0)
  r.u1i(p.u.u_interp, o.interpolate ? 1 : 0)
  r.u1f(p.u.u_opacity, o.opacity)
  r.u1f(p.u.u_pxw, 1 / r.dpr)
  r.resetAttribs([ATTR.corner])
  r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
}

// ------------------------------------------------------------------ geometry helpers

/** Parametric range [t0, t1] of segment a->b (relative to circle center) inside radius R, or null. */
export function clipToCircle(ax: number, ay: number, bx: number, by: number, R: number): [number, number] | null {
  const dx = bx - ax, dy = by - ay
  const A = dx * dx + dy * dy
  const C = ax * ax + ay * ay - R * R
  if (A < 1e-12) return C <= 0 ? [0, 1] : null
  const B = 2 * (ax * dx + ay * dy)
  const disc = B * B - 4 * A * C
  if (disc <= 0) return null
  const sq = Math.sqrt(disc)
  const t0 = Math.max(0, (-B - sq) / (2 * A))
  const t1 = Math.min(1, (-B + sq) / (2 * A))
  return t0 < t1 ? [t0, t1] : null
}

/** Ear-clipping triangulation of a simple polygon; returns vertex index triples. */
export function triangulate(xs: ArrayLike<number>, ys: ArrayLike<number>, n: number): number[] {
  const out: number[] = []
  if (n < 3) return out
  let area = 0
  for (let i = 0, j = n - 1; i < n; j = i++) area += xs[j] * ys[i] - xs[i] * ys[j]
  const idx: number[] = []
  for (let i = 0; i < n; i++) idx.push(area >= 0 ? i : n - 1 - i)
  const cross = (a: number, b: number, c: number) => (xs[b] - xs[a]) * (ys[c] - ys[b]) - (ys[b] - ys[a]) * (xs[c] - xs[b])
  const inside = (p: number, a: number, b: number, c: number) => {
    const d1 = (xs[b] - xs[a]) * (ys[p] - ys[a]) - (ys[b] - ys[a]) * (xs[p] - xs[a])
    const d2 = (xs[c] - xs[b]) * (ys[p] - ys[b]) - (ys[c] - ys[b]) * (xs[p] - xs[b])
    const d3 = (xs[a] - xs[c]) * (ys[p] - ys[c]) - (ys[a] - ys[c]) * (xs[p] - xs[c])
    return d1 >= 0 && d2 >= 0 && d3 >= 0
  }
  let guard = 0
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false
    for (let i = 0; i < idx.length; i++) {
      const a = idx[(i + idx.length - 1) % idx.length], b = idx[i], c = idx[(i + 1) % idx.length]
      if (cross(a, b, c) <= 0) continue
      let ok = true
      for (const q of idx) {
        if (q === a || q === b || q === c) continue
        if (inside(q, a, b, c)) { ok = false; break }
      }
      if (!ok) continue
      out.push(a, b, c)
      idx.splice(i, 1)
      clipped = true
      break
    }
    if (!clipped) break
  }
  // Remainder (degenerate input): fan.
  for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1])
  return out
}
