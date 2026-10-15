// GLSL ES 3.00 programs for Chart3D. Fragment shaders build on FS_HEAD and output via emit().
import { FS_HEAD } from '../render/shaders'

/** Shared 3D vertex header: camera matrices, data->world mapping, LUT and clip helpers. */
export const VS3_HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform mat4 u_view;
uniform mat4 u_proj;
uniform vec3 u_scale;
uniform vec3 u_bias;
uniform vec3 u_dims;
uniform float u_clip;
uniform int u_lutMode;     // 0 none, 1 x, 2 y, 3 z, 4 value
uniform vec2 u_lutRange;
uniform sampler2D u_lut;
vec3 toWorld(vec3 p) { return p * u_scale + u_bias; }
vec3 toNorm(vec3 w) { return vec3(w.x / u_dims.x + 0.5, w.y / u_dims.y + 0.5, 0.5 - w.z / u_dims.z); }
bool outside(vec3 w) {
  vec3 n = toNorm(w);
  return u_clip > 0.5 && (any(lessThan(n, vec3(-1e-4))) || any(greaterThan(n, vec3(1.0001))));
}
bool bad3(vec3 v) {
  return isnan(v.x) || isnan(v.y) || isnan(v.z) || !(v.x == v.x && v.y == v.y && v.z == v.z) || any(greaterThan(abs(v), vec3(1e30)));
}
float lutValue(vec3 p, float value) {
  return u_lutMode == 1 ? p.x : u_lutMode == 2 ? p.y : u_lutMode == 3 ? p.z : value;
}
vec4 lutAt(float v) {
  float t = clamp((v - u_lutRange.x) / max(u_lutRange.y - u_lutRange.x, 1e-30), 0.0, 1.0);
  return texture(u_lut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
}
vec4 lutColor(vec3 p, float value) { return u_lutMode > 0 ? lutAt(lutValue(p, value)) : vec4(1.0); }
uniform vec4 u_color;
uniform int u_useCol;
// Per-sample color (all-zero = unset) or the uniform series color.
vec4 baseColor(vec4 c) { return (u_useCol == 1 && c != vec4(0.0)) ? c : u_color; }
const vec4 OFF = vec4(2.0, 2.0, 2.0, 1.0);
`

/** Shared 3D fragment header: lighting and box clipping. */
export const FS3_HEAD = FS_HEAD + /* glsl */ `
uniform vec3 u_light;      // view space, towards the light
uniform vec4 u_shade;      // ambient, diffuse, specular, shininess
uniform vec3 u_dims;
uniform float u_clip;
vec3 shade(vec3 base, vec3 n, vec3 viewPos) {
  vec3 v = normalize(-viewPos);
  if (dot(n, v) < 0.0) n = -n;
  float d = max(dot(n, u_light), 0.0);
  vec3 c = base * (u_shade.x + u_shade.y * d);
  if (u_shade.z > 0.0) {
    vec3 h = normalize(u_light + v);
    c += vec3(pow(max(dot(n, h), 0.0), u_shade.w) * u_shade.z);
  }
  return min(c, vec3(1.0));
}
void clipWorld(vec3 w) {
  if (u_clip < 0.5) return;
  vec3 n = vec3(w.x / u_dims.x + 0.5, w.y / u_dims.y + 0.5, 0.5 - w.z / u_dims.z);
  if (any(lessThan(n, vec3(-1e-3))) || any(greaterThan(n, vec3(1.001)))) discard;
}
`

// ------------------------------------------------------------------ instanced mesh points (cube, cylinder, ...)

export const MESHPT_VS = VS3_HEAD + /* glsl */ `
layout(location = 0) in vec3 a_vert;
layout(location = 2) in vec3 a_nrm;
layout(location = 1) in vec3 a_pos;
layout(location = 3) in vec4 a_col;
layout(location = 5) in float a_val;
layout(location = 8) in float a_size;
uniform float u_worldPerPx;
uniform float u_sizePx;
out vec3 v_vpos;
out vec3 v_nrm;
out vec4 v_col;
void main() {
  vec3 c = toWorld(a_pos);
  float s = (a_size > 0.0 ? a_size : u_sizePx) * 0.5 * u_worldPerPx;
  if (bad3(a_pos) || s <= 0.0 || outside(c)) { gl_Position = OFF; return; }
  vec4 vp = u_view * vec4(c + a_vert * s, 1.0);
  v_vpos = vp.xyz;
  v_nrm = mat3(u_view) * a_nrm;
  v_col = baseColor(a_col) * lutColor(a_pos, a_val);
  gl_Position = u_proj * vp;
}
`
export const MESHPT_FS = FS3_HEAD + /* glsl */ `
in vec3 v_vpos;
in vec3 v_nrm;
in vec4 v_col;
void main() { emit(vec4(shade(v_col.rgb, normalize(v_nrm), v_vpos), v_col.a)); }
`

// ------------------------------------------------------------------ sphere impostors

export const SPHERE_VS = VS3_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_pos;
layout(location = 3) in vec4 a_col;
layout(location = 5) in float a_val;
layout(location = 8) in float a_size;
uniform float u_worldPerPx;
uniform float u_sizePx;
out vec3 v_q;
flat out vec3 v_c;
flat out float v_r;
flat out vec4 v_col;
void main() {
  vec3 c = toWorld(a_pos);
  float r = (a_size > 0.0 ? a_size : u_sizePx) * 0.5 * u_worldPerPx;
  if (bad3(a_pos) || r <= 0.0 || outside(c)) { gl_Position = OFF; return; }
  vec3 cv = (u_view * vec4(c, 1.0)).xyz;
  float d = length(cv);
  if (d <= r * 1.01) { gl_Position = OFF; return; }
  // Billboard through the center, perpendicular to the eye ray, sized to the tangent cone.
  vec3 f = cv / d;
  vec3 up0 = abs(f.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 rt = normalize(cross(up0, f));
  vec3 up = cross(f, rt);
  float k = d / sqrt(d * d - r * r) * 1.04;
  vec3 q = cv + (rt * a_corner.x + up * a_corner.y) * r * k;
  v_q = q;
  v_c = cv;
  v_r = r;
  v_col = baseColor(a_col) * lutColor(a_pos, a_val);
  gl_Position = u_proj * vec4(q, 1.0);
}
`
export const SPHERE_FS = FS3_HEAD + /* glsl */ `
in vec3 v_q;
flat in vec3 v_c;
flat in float v_r;
flat in vec4 v_col;
uniform mat4 u_proj;
uniform float u_pxScale;   // device px per world unit at view distance 1
void main() {
  vec3 d = normalize(v_q);
  float b = dot(d, v_c);
  float c2 = max(dot(v_c, v_c) - b * b, 0.0);
  float dist = sqrt(c2);
  float pxw = max(b, 1e-6) / u_pxScale;
  float a = clamp((v_r - dist) / pxw + 0.5, 0.0, 1.0);
  float h = sqrt(max(v_r * v_r - c2, 0.0));
  vec3 hit = d * (b - h);
  vec4 clip = u_proj * vec4(hit, 1.0);
  gl_FragDepth = clamp(clip.z / clip.w * 0.5 + 0.5, 0.0, 1.0);
  if (a <= 0.02) discard;
  vec3 n = normalize(hit - v_c);
  emit(vec4(shade(v_col.rgb, n, hit), v_col.a * a));
}
`

// ------------------------------------------------------------------ pixelated points

export const PIXPT_VS = VS3_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_pos;
layout(location = 3) in vec4 a_col;
layout(location = 5) in float a_val;
layout(location = 8) in float a_size;
uniform vec2 u_res;
uniform float u_dpr;
uniform float u_sizePx;
out vec2 v_uv;
flat out float v_r;
flat out vec4 v_col;
void main() {
  vec3 c = toWorld(a_pos);
  float r = (a_size > 0.0 ? a_size : u_sizePx) * 0.5 * u_dpr;
  if (bad3(a_pos) || r <= 0.0 || outside(c)) { gl_Position = OFF; return; }
  vec4 cl = u_proj * (u_view * vec4(c, 1.0));
  if (cl.w <= 1e-6) { gl_Position = OFF; return; }
  vec2 off = a_corner * (r + 1.0);
  v_uv = off;
  v_r = r;
  v_col = baseColor(a_col) * lutColor(a_pos, a_val);
  gl_Position = vec4(cl.xy + off / u_res * 2.0 * cl.w, cl.z, cl.w);
}
`
export const PIXPT_FS = FS_HEAD + /* glsl */ `
in vec2 v_uv;
flat in float v_r;
flat in vec4 v_col;
uniform int u_shape;
float sdTri(vec2 p, float r) {
  const float k = 1.7320508;
  p.y = -p.y + r * 0.25;
  p.x = abs(p.x) - r;
  p.y = p.y + r / k;
  if (p.x + k * p.y > 0.0) p = vec2(p.x - k * p.y, -k * p.x - p.y) / 2.0;
  p.x -= clamp(p.x, -2.0 * r, 0.0);
  return -length(p) * sign(p.y);
}
float sdStar(vec2 p, float r) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p.y = -p.y;
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = 0.45 * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
void main() {
  vec2 p = v_uv;
  float r = v_r;
  float d;
  if (u_shape == 0) d = length(p) - r;
  else if (u_shape == 1) { vec2 q = abs(p) - vec2(r); d = max(q.x, q.y); }
  else if (u_shape == 2) d = sdTri(p, r * 1.05);
  else if (u_shape == 3) d = (abs(p.x) + abs(p.y) - r * 1.2) * 0.7071;
  else if (u_shape == 4) { vec2 q = abs(p); float w = r * 0.32; d = min(max(q.x - r, q.y - w), max(q.x - w, q.y - r)); }
  else if (u_shape == 5) { vec2 q = abs(vec2(p.x + p.y, p.x - p.y) * 0.7071); float w = r * 0.28; d = min(max(q.x - r, q.y - w), max(q.x - w, q.y - r)); }
  else d = sdStar(p, r * 1.15);
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.02) discard;
  emit(vec4(v_col.rgb, v_col.a * a));
}
`

// ------------------------------------------------------------------ thick 3D polylines (screen-space capsules)

export const LINE3_VS = VS3_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec3 a_p0;
layout(location = 2) in vec3 a_p1;
layout(location = 3) in vec4 a_c0;
layout(location = 4) in vec4 a_c1;
layout(location = 5) in float a_v0;
layout(location = 6) in float a_v1;
uniform vec2 u_res;
uniform float u_halfw;
out vec2 v_px;
flat out vec2 v_a;
flat out vec2 v_b;
flat out vec3 v_w0;
flat out vec3 v_w1;
out vec4 v_col;
void main() {
  if (bad3(a_p0) || bad3(a_p1)) { gl_Position = OFF; return; }
  vec3 w0 = toWorld(a_p0), w1 = toWorld(a_p1);
  vec4 A = u_proj * (u_view * vec4(w0, 1.0));
  vec4 B = u_proj * (u_view * vec4(w1, 1.0));
  const float eps = 1e-5;
  if (A.w < eps && B.w < eps) { gl_Position = OFF; return; }
  if (A.w < eps) A = mix(A, B, (eps - A.w) / (B.w - A.w));
  if (B.w < eps) B = mix(B, A, (eps - B.w) / (A.w - B.w));
  vec2 sa = (A.xy / A.w * 0.5 + 0.5) * u_res;
  vec2 sb = (B.xy / B.w * 0.5 + 0.5) * u_res;
  vec2 dd = sb - sa;
  float len = length(dd);
  vec2 dir = len > 1e-6 ? dd / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u_halfw + 1.0;
  bool first = a_corner.x < 0.5;
  vec2 px = (first ? sa - dir * r : sb + dir * r) + nrm * a_corner.y * r;
  float z = first ? A.z / A.w : B.z / B.w;
  v_px = px;
  v_a = sa;
  v_b = sb;
  v_w0 = w0;
  v_w1 = w1;
  vec4 lc = first ? lutColor(a_p0, a_v0) : lutColor(a_p1, a_v1);
  v_col = baseColor(first ? a_c0 : a_c1) * lc;
  gl_Position = vec4(px / u_res * 2.0 - 1.0, z, 1.0);
}
`
export const LINE3_FS = FS3_HEAD + /* glsl */ `
in vec2 v_px;
flat in vec2 v_a;
flat in vec2 v_b;
flat in vec3 v_w0;
flat in vec3 v_w1;
in vec4 v_col;
uniform float u_halfw;
void main() {
  vec2 pa = v_px - v_a, ba = v_b - v_a;
  float bb = dot(ba, ba);
  float h = bb > 1e-9 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
  float dist = length(pa - ba * h);
  float alpha = clamp(u_halfw + 0.5 - dist, 0.0, 1.0);
  if (alpha <= 0.02) discard;
  clipWorld(mix(v_w0, v_w1, h));
  emit(vec4(v_col.rgb, v_col.a * alpha));
}
`

// ------------------------------------------------------------------ surface grid (height texture)

export const SURF_VS = VS3_HEAD + /* glsl */ `
uniform highp sampler2D u_hgt;   // R32F: x = row index, y = (ring) column index
uniform highp sampler2D u_int;   // R32F intensity, same layout
uniform ivec2 u_grid;            // columns (logical), rows
uniform int u_cap;               // texture columns (ring capacity)
uniform int u_ring;              // texture column of logical column 0
uniform vec4 u_xz;               // x0, dx, z0, dz (data, relative to origin)
uniform int u_hasInt;
out vec3 v_vpos;
out vec3 v_nrm;
out vec3 v_w;
out float v_val;
out vec2 v_grid;
out float v_bad;
out float v_h;
float H(int c, int r) {
  c = clamp(c, 0, u_grid.x - 1);
  r = clamp(r, 0, u_grid.y - 1);
  return texelFetch(u_hgt, ivec2(r, (c + u_ring) % u_cap), 0).r;
}
void main() {
  int id = gl_VertexID;
  int c = id / u_grid.y;
  int r = id - c * u_grid.y;
  float h = H(c, r);
  vec3 p = vec3(u_xz.x + float(c) * u_xz.y, h, u_xz.z + float(r) * u_xz.w);
  vec3 w = toWorld(p);
  v_bad = (isnan(h) || !(h == h) || abs(h) > 1e30) ? 1.0 : 0.0;
  if (v_bad > 0.5) w = vec3(0.0);
  float hl = H(c - 1, r), hr = H(c + 1, r), hd = H(c, r - 1), hu = H(c, r + 1);
  if (!(hl == hl)) hl = h;
  if (!(hr == hr)) hr = h;
  if (!(hd == hd)) hd = h;
  if (!(hu == hu)) hu = h;
  float sc = float(min(c + 1, u_grid.x - 1) - max(c - 1, 0));
  float sr = float(min(r + 1, u_grid.y - 1) - max(r - 1, 0));
  vec3 tc = vec3(u_xz.y * u_scale.x * max(sc, 1.0), (hr - hl) * u_scale.y, 0.0);
  vec3 tr = vec3(0.0, (hu - hd) * u_scale.y, u_xz.w * u_scale.z * max(sr, 1.0));
  vec3 n = normalize(cross(tr, tc));
  vec4 vp = u_view * vec4(w, 1.0);
  v_vpos = vp.xyz;
  v_nrm = mat3(u_view) * n;
  v_w = w;
  float iv = u_hasInt == 1 ? texelFetch(u_int, ivec2(r, (c + u_ring) % u_cap), 0).r : h;
  v_val = lutValue(p, iv);
  v_grid = vec2(float(c), float(r));
  v_h = h;
  gl_Position = u_proj * vp;
}
`
export const SURF_FS = FS3_HEAD + /* glsl */ `
in vec3 v_vpos;
in vec3 v_nrm;
in vec3 v_w;
in float v_val;
in vec2 v_grid;
in float v_bad;
in float v_h;
uniform vec2 u_contour;      // height interval, line width px (interval 0 = off)
uniform vec4 u_contourColor;
uniform int u_lutMode;
uniform vec2 u_lutRange;
uniform sampler2D u_lut;
uniform vec4 u_color;
uniform int u_fill;          // 0 none, 1 fill
uniform float u_wireW;       // px, 0 = off
uniform vec4 u_wireColor;
void main() {
  if (v_bad > 0.001) discard;
  clipWorld(v_w);
  vec4 base = u_color;
  if (u_lutMode > 0) {
    float t = clamp((v_val - u_lutRange.x) / max(u_lutRange.y - u_lutRange.x, 1e-30), 0.0, 1.0);
    base *= texture(u_lut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
  }
  vec4 col = u_fill == 1 ? vec4(shade(base.rgb, normalize(v_nrm), v_vpos), base.a) : vec4(0.0);
  if (u_wireW > 0.0) {
    vec2 fw = max(fwidth(v_grid), vec2(1e-6));
    vec2 g = abs(fract(v_grid + 0.5) - 0.5) / fw;
    // Fade out once cells get smaller than a few pixels.
    float on = clamp(u_wireW * 0.5 + 0.5 - min(g.x, g.y), 0.0, 1.0) * clamp((0.5 - max(fw.x, fw.y)) * 4.0, 0.0, 1.0);
    col = mix(col, u_wireColor, on * u_wireColor.a);
    if (u_fill == 0) col.a = on * u_wireColor.a;
  }
  if (u_contour.x > 0.0) {
    float q = v_h / u_contour.x;
    float d = abs(fract(q + 0.5) - 0.5) / max(fwidth(q), 1e-6);
    float on = clamp(u_contour.y * 0.5 + 0.5 - d, 0.0, 1.0);
    col = vec4(mix(col.rgb, u_contourColor.rgb, on * u_contourColor.a), max(col.a, on * u_contourColor.a));
  }
  if (col.a <= 0.003) discard;
  emit(col);
}
`

// ------------------------------------------------------------------ boxes (instanced cube)

export const BOX_VS = VS3_HEAD + /* glsl */ `
layout(location = 0) in vec3 a_vert;     // -0.5..0.5
layout(location = 9) in vec3 a_nrm;
layout(location = 1) in vec3 a_center;
layout(location = 2) in vec3 a_size;
layout(location = 3) in vec4 a_col;
layout(location = 5) in float a_val;
out vec3 v_vpos;
out vec3 v_nrm;
out vec3 v_w;
out vec4 v_col;
void main() {
  if (bad3(a_center) || bad3(a_size)) { gl_Position = OFF; return; }
  vec3 p = a_center + a_vert * a_size;
  vec3 w = toWorld(p);
  vec4 vp = u_view * vec4(w, 1.0);
  v_vpos = vp.xyz;
  v_nrm = mat3(u_view) * normalize(a_nrm / u_scale);
  v_w = w;
  v_col = baseColor(a_col) * lutColor(p, a_val);
  gl_Position = u_proj * vp;
}
`
export const MESH_FS = FS3_HEAD + /* glsl */ `
in vec3 v_vpos;
in vec3 v_nrm;
in vec3 v_w;
in vec4 v_col;
void main() {
  clipWorld(v_w);
  emit(vec4(shade(v_col.rgb, normalize(v_nrm), v_vpos), v_col.a));
}
`

// ------------------------------------------------------------------ mesh models

export const MODEL_VS = VS3_HEAD + /* glsl */ `
layout(location = 1) in vec3 a_pos;
layout(location = 2) in vec3 a_nrm;
layout(location = 3) in vec4 a_col;
layout(location = 5) in float a_val;
uniform mat3 u_rot;
uniform vec3 u_mscale;
out vec3 v_vpos;
out vec3 v_nrm;
out vec3 v_w;
out vec4 v_col;
void main() {
  vec3 p = u_rot * (a_pos * u_mscale);
  vec3 w = toWorld(p);
  vec4 vp = u_view * vec4(w, 1.0);
  vec3 n = (u_rot * (a_nrm / u_mscale)) / u_scale;
  v_vpos = vp.xyz;
  v_nrm = mat3(u_view) * normalize(n);
  v_w = w;
  v_col = baseColor(a_col) * lutColor(p, a_val);
  gl_Position = u_proj * vp;
}
`
