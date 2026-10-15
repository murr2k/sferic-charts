// GLSL ES 3.00 sources. Attribute locations are fixed across programs (see ATTR).

export const ATTR = {
  corner: 0,
  p0: 1,
  p1: 2,
  c0: 3,
  c1: 4,
  v0: 5,
  v1: 6,
  d0: 7,
  size: 8,
  lo0: 9,
  lo1: 10,
  rot: 11,
} as const

/** Shared vertex header: u_res, xform uniforms, toPx(), pxToClip(), bad(), LUT helpers. */
export const VS_HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform vec2 u_res;
uniform vec2 u_scale;
uniform vec2 u_bias;
uniform vec2 u_origin;
uniform vec2 u_logb;
vec2 toPx(vec2 p) {
  vec2 q = p;
  if (u_logb.x > 0.0) q.x = log(max(p.x + u_origin.x, 1e-37)) / log(u_logb.x);
  if (u_logb.y > 0.0) q.y = log(max(p.y + u_origin.y, 1e-37)) / log(u_logb.y);
  return q * u_scale + u_bias;
}
vec4 pxToClip(vec2 px) { return vec4(px.x / u_res.x * 2.0 - 1.0, 1.0 - px.y / u_res.y * 2.0, 0.0, 1.0); }
bool bad(float v) { return !(v == v) || abs(v) > 1e30; }
// Color lookup: mode 0 = none, 1 = by x, 2 = by y, 3 = by value attribute.
uniform int u_lutMode;
uniform vec2 u_lutRange;
uniform sampler2D u_lut;
vec4 lutColor(float v) {
  float t = clamp((v - u_lutRange.x) / max(u_lutRange.y - u_lutRange.x, 1e-30), 0.0, 1.0);
  return texture(u_lut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
}
vec4 pointColor(vec2 p, float value) {
  if (u_lutMode == 1) return lutColor(p.x + u_origin.x);
  if (u_lutMode == 2) return lutColor(p.y + u_origin.y);
  if (u_lutMode == 3) return lutColor(value);
  return vec4(1.0);
}
`

/** Shared fragment header: MRT outputs and emit(color) which also feeds the glow buffer. */
export const FS_HEAD = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
layout(location = 0) out vec4 o_color;
layout(location = 1) out vec4 o_glow;
uniform float u_glow;
void emit(vec4 c) {
  o_color = c;
  o_glow = vec4(c.rgb * u_glow, c.a);
}
`

// ------------------------------------------------------------------ thick lines (capsules)

export const LINE_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_p0;
layout(location = 2) in vec2 a_p1;
layout(location = 3) in vec4 a_c0;
layout(location = 4) in vec4 a_c1;
layout(location = 5) in float a_v0;
layout(location = 6) in float a_v1;
layout(location = 7) in float a_d0;
uniform float u_halfw;
uniform vec4 u_color;
out vec2 v_px;
flat out vec2 v_a;
flat out vec2 v_b;
flat out float v_d0;
flat out float v_t0;
out vec4 v_col;

bool clipT(float p, float q, inout float t0, inout float t1) {
  if (abs(p) < 1e-12) return q >= 0.0;
  float r = q / p;
  if (p < 0.0) { if (r > t1) return false; if (r > t0) t0 = r; }
  else { if (r < t0) return false; if (r < t1) t1 = r; }
  return true;
}

void main() {
  vec2 s0 = toPx(a_p0);
  vec2 s1 = toPx(a_p1);
  if (bad(s0.x) || bad(s0.y) || bad(s1.x) || bad(s1.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 d = s1 - s0;
  float m = u_halfw + 64.0;
  vec2 lo = vec2(-m);
  vec2 hi = u_res + m;
  float t0 = 0.0, t1 = 1.0;
  bool ok = clipT(-d.x, s0.x - lo.x, t0, t1) && clipT(d.x, hi.x - s0.x, t0, t1)
         && clipT(-d.y, s0.y - lo.y, t0, t1) && clipT(d.y, hi.y - s0.y, t0, t1);
  if (!ok) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 c0 = s0 + d * t0;
  vec2 c1 = s0 + d * t1;
  vec2 dd = c1 - c0;
  float len = length(dd);
  vec2 dir = len > 1e-6 ? dd / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  float r = u_halfw + 1.0;
  vec2 base = a_corner.x < 0.5 ? c0 - dir * r : c1 + dir * r;
  vec2 px = base + nrm * a_corner.y * r;
  v_px = px;
  v_a = c0;
  v_b = c1;
  v_d0 = a_d0 + length(d) * t0;
  v_t0 = 0.0;
  vec4 lc = a_corner.x < 0.5 ? pointColor(a_p0, a_v0) : pointColor(a_p1, a_v1);
  vec4 vc = a_corner.x < 0.5 ? a_c0 : a_c1;
  v_col = u_color * vc * lc;
  gl_Position = pxToClip(px);
}
`

export const LINE_FS = FS_HEAD + /* glsl */ `
in vec2 v_px;
flat in vec2 v_a;
flat in vec2 v_b;
flat in float v_d0;
flat in float v_t0;
in vec4 v_col;
uniform float u_halfw;
uniform vec4 u_dash;      // on, off, on, off (px)
uniform float u_dashPeriod;
void main() {
  vec2 pa = v_px - v_a, ba = v_b - v_a;
  float bb = dot(ba, ba);
  float h = bb > 1e-9 ? clamp(dot(pa, ba) / bb, 0.0, 1.0) : 0.0;
  float dist = length(pa - ba * h);
  float alpha = clamp(u_halfw + 0.5 - dist, 0.0, 1.0);
  if (u_dashPeriod > 0.0) {
    float s = mod(v_d0 + h * sqrt(bb), u_dashPeriod);
    float e1 = u_dash.x, e2 = e1 + u_dash.y, e3 = e2 + u_dash.z;
    bool on = s < e1 || (s >= e2 && s < e3);
    if (!on) discard;
  }
  if (alpha <= 0.003) discard;
  emit(vec4(v_col.rgb, v_col.a * alpha));
}
`

// ------------------------------------------------------------------ primitive 1px lines

export const PRIM_VS = VS_HEAD + /* glsl */ `
layout(location = 1) in vec2 a_p0;
layout(location = 3) in vec4 a_c0;
layout(location = 5) in float a_v0;
uniform vec4 u_color;
out vec4 v_col;
void main() {
  vec2 s = toPx(a_p0);
  v_col = u_color * a_c0 * pointColor(a_p0, a_v0);
  if (bad(s.x) || bad(s.y)) { v_col.a = 0.0; s = vec2(0.0); }
  gl_Position = pxToClip(clamp(s, vec2(-1e6), vec2(1e6)));
}
`
export const PRIM_FS = FS_HEAD + /* glsl */ `
in vec4 v_col;
void main() { emit(v_col); }
`

// ------------------------------------------------------------------ points

export const POINT_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec2 a_p0;
layout(location = 3) in vec4 a_c0;
layout(location = 5) in float a_v0;
layout(location = 8) in float a_size;
layout(location = 11) in float a_rot;
uniform float u_size;
uniform float u_sizeScale;
uniform vec4 u_color;
out vec2 v_uv;
flat out float v_r;
out vec4 v_col;
void main() {
  vec2 s = toPx(a_p0);
  float size = a_size > 0.0 ? a_size * u_sizeScale : u_size;
  if (bad(s.x) || bad(s.y) || size <= 0.0) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float r = size * 0.5 + 1.0;
  float c = cos(a_rot), sn = sin(a_rot);
  vec2 off = vec2(a_corner.x * c - a_corner.y * sn, a_corner.x * sn + a_corner.y * c) * r;
  v_uv = a_corner * r;
  v_r = size * 0.5;
  v_col = u_color * a_c0 * pointColor(a_p0, a_v0);
  gl_Position = pxToClip(s + off);
}
`

export const POINT_FS = FS_HEAD + /* glsl */ `
in vec2 v_uv;
flat in float v_r;
in vec4 v_col;
uniform int u_shape;
uniform float u_strokeW;
uniform vec4 u_strokeColor;
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
  else if (u_shape == 6) d = sdStar(p, r * 1.15);
  else { vec2 q = abs(p) - vec2(r * 0.55, r); d = max(q.x, q.y); }
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.003) discard;
  vec4 c = v_col;
  if (u_strokeW > 0.0) {
    float s = clamp(d + u_strokeW + 0.5, 0.0, 1.0);
    c = mix(c, u_strokeColor, s);
  }
  emit(vec4(c.rgb, c.a * a));
}
`

// ------------------------------------------------------------------ areas (instanced trapezoids)

export const FILL_FS_COMMON = /* glsl */ `
uniform int u_fillMode;     // 0 solid, 1 lut by value (y), 2 linear gradient by px
uniform vec4 u_color;
uniform sampler2D u_ftex;
uniform vec2 u_ftexRange;
uniform vec4 u_grad;        // origin.xy, dir.xy / len
vec4 fillColor(vec2 px, float value) {
  if (u_fillMode == 1) {
    float t = clamp((value - u_ftexRange.x) / max(u_ftexRange.y - u_ftexRange.x, 1e-30), 0.0, 1.0);
    return u_color * texture(u_ftex, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
  }
  if (u_fillMode == 2) {
    float t = clamp(dot(px - u_grad.xy, u_grad.zw), 0.0, 1.0);
    return u_color * texture(u_ftex, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
  }
  return u_color;
}
`

export const AREA_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;   // x: 0 start, 1 end; y: 0 low, 1 high
layout(location = 1) in vec2 a_p0;
layout(location = 2) in vec2 a_p1;
layout(location = 9) in float a_lo0;
layout(location = 10) in float a_lo1;
out vec2 v_px;
out float v_val;
void main() {
  vec2 p = a_corner.x < 0.5 ? a_p0 : a_p1;
  float lo = a_corner.x < 0.5 ? a_lo0 : a_lo1;
  vec2 q = a_corner.y < 0.5 ? vec2(p.x, lo) : p;
  vec2 s = toPx(q);
  vec2 s0 = toPx(a_p0), s1 = toPx(a_p1);
  if (bad(s0.x) || bad(s0.y) || bad(s1.x) || bad(s1.y) || bad(lo)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  s = clamp(s, vec2(-1e6), vec2(1e6));
  v_px = s;
  v_val = q.y + u_origin.y;
  gl_Position = pxToClip(s);
}
`
export const AREA_FS = FS_HEAD + FILL_FS_COMMON + /* glsl */ `
in vec2 v_px;
in float v_val;
void main() { emit(fillColor(v_px, v_val)); }
`

// ------------------------------------------------------------------ rects (instanced)

export const RECT_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;    // 0..1
layout(location = 1) in vec4 a_rect;      // x0, y0, x1, y1 (data, chunk-relative)
layout(location = 3) in vec4 a_c0;
uniform float u_minPx;                    // minimum rendered size in px
out vec2 v_px;
flat out vec4 v_box;                      // px: xmin, ymin, xmax, ymax
out vec4 v_col;
void main() {
  vec2 a = toPx(a_rect.xy), b = toPx(a_rect.zw);
  if (bad(a.x) || bad(a.y) || bad(b.x) || bad(b.y)) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  vec2 mn = min(a, b), mx = max(a, b);
  vec2 c = (mn + mx) * 0.5;
  vec2 hs = max((mx - mn) * 0.5, vec2(u_minPx * 0.5));
  mn = clamp(c - hs, vec2(-1e6), vec2(1e6));
  mx = clamp(c + hs, vec2(-1e6), vec2(1e6));
  vec2 px = mix(mn - 1.0, mx + 1.0, a_corner);
  v_px = px;
  v_box = vec4(mn, mx);
  v_col = a_c0;
  gl_Position = pxToClip(px);
}
`
export const RECT_FS = FS_HEAD + FILL_FS_COMMON + /* glsl */ `
in vec2 v_px;
flat in vec4 v_box;
in vec4 v_col;
uniform float u_borderW;
uniform vec4 u_borderColor;
uniform float u_radius;
void main() {
  vec2 c = (v_box.xy + v_box.zw) * 0.5;
  vec2 hs = (v_box.zw - v_box.xy) * 0.5;
  float r = min(u_radius, min(hs.x, hs.y));
  vec2 q = abs(v_px - c) - hs + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.003) discard;
  vec4 col = fillColor(v_px, 0.0) * v_col;
  if (u_borderW > 0.0) col = mix(col, u_borderColor, clamp(d + u_borderW + 0.5, 0.0, 1.0));
  emit(vec4(col.rgb, col.a * a));
}
`

// ------------------------------------------------------------------ heatmap grid

export const HEAT_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;   // 0..1
uniform vec4 u_area;                      // data rect x0, y0, x1, y1 (relative to origin)
out vec2 v_uv;
void main() {
  vec2 p = mix(u_area.xy, u_area.zw, a_corner);
  vec2 s = clamp(toPx(p), vec2(-1e7), vec2(1e7));
  v_uv = a_corner;
  gl_Position = pxToClip(s);
}
`
export const HEAT_FS = FS_HEAD + /* glsl */ `
in vec2 v_uv;
uniform highp sampler2D u_vals;           // R32F, x = column, y = row
uniform ivec2 u_dims;                     // visible columns, rows
uniform int u_cap;                        // ring capacity in columns (0 = no ring)
uniform int u_ringStart;                  // texture column of logical column 0
uniform int u_interp;
uniform sampler2D u_lut;
uniform vec2 u_lutRange;
uniform float u_opacity;
float val(int c, int r) {
  c = clamp(c, 0, u_dims.x - 1);
  r = clamp(r, 0, u_dims.y - 1);
  if (u_cap > 0) c = (c + u_ringStart) % u_cap;
  return texelFetch(u_vals, ivec2(c, r), 0).r;
}
void main() {
  vec2 g = v_uv * vec2(u_dims);
  float v;
  if (u_interp == 1) {
    vec2 f = g - 0.5;
    ivec2 i0 = ivec2(floor(f));
    vec2 t = fract(f);
    float a = val(i0.x, i0.y), b = val(i0.x + 1, i0.y), c = val(i0.x, i0.y + 1), d = val(i0.x + 1, i0.y + 1);
    v = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  } else {
    v = val(int(g.x), int(g.y));
  }
  if (!(v == v)) discard;
  float t = clamp((v - u_lutRange.x) / max(u_lutRange.y - u_lutRange.x, 1e-30), 0.0, 1.0);
  vec4 c = texture(u_lut, vec2(t * (1023.0 / 1024.0) + 0.5 / 1024.0, 0.5));
  emit(vec4(c.rgb, c.a * u_opacity));
}
`

// ------------------------------------------------------------------ post-processing

export const FS_QUAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 a_corner;
uniform vec2 u_uvScale;
out vec2 v_uv;
void main() {
  v_uv = a_corner * u_uvScale;
  gl_Position = vec4(a_corner * 2.0 - 1.0, 0.0, 1.0);
}
`

export const BLUR_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_dir;      // texel step * direction
out vec4 o;
void main() {
  // 9-tap gaussian using linear sampling (covers 17 texels)
  vec4 s = texture(u_tex, v_uv) * 0.1964825501511404;
  s += texture(u_tex, v_uv + u_dir * 1.411764705882353) * 0.2969069646728344;
  s += texture(u_tex, v_uv - u_dir * 1.411764705882353) * 0.2969069646728344;
  s += texture(u_tex, v_uv + u_dir * 3.2941176470588234) * 0.09447039785044732;
  s += texture(u_tex, v_uv - u_dir * 3.2941176470588234) * 0.09447039785044732;
  s += texture(u_tex, v_uv + u_dir * 5.176470588235294) * 0.010381362401148057;
  s += texture(u_tex, v_uv - u_dir * 5.176470588235294) * 0.010381362401148057;
  o = s;
}
`

export const DOWN_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform vec2 u_texel;
out vec4 o;
void main() {
  o = 0.25 * (texture(u_tex, v_uv + u_texel * vec2(-0.5, -0.5)) + texture(u_tex, v_uv + u_texel * vec2(0.5, -0.5))
      + texture(u_tex, v_uv + u_texel * vec2(-0.5, 0.5)) + texture(u_tex, v_uv + u_texel * vec2(0.5, 0.5)));
}
`

export const COMPOSITE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_scene;
uniform sampler2D u_glow1;
uniform sampler2D u_glow2;
uniform vec2 u_glowUv;     // scale scene uv -> blur uv
uniform vec2 u_glowUv2;
uniform float u_intensity;
out vec4 o;
void main() {
  vec4 s = texture(u_scene, v_uv);
  vec3 g = vec3(0.0);
  if (u_intensity > 0.0) {
    g = texture(u_glow1, v_uv * u_glowUv).rgb * 0.65 + texture(u_glow2, v_uv * u_glowUv2).rgb * 0.55;
    g *= u_intensity;
  }
  vec3 rgb = min(s.rgb + g, vec3(1.0));
  float a = clamp(max(s.a, max(rgb.r, max(rgb.g, rgb.b))), 0.0, 1.0);
  o = vec4(rgb, a);
}
`
