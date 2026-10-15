import { FS_HEAD, VS_HEAD } from '../render/shaders'

// Instanced primitives for hierarchy charts. Geometry is in CSS px; toPx()
// (identity xform scaled by dpr) converts to device px.

/** Rounded tile: a_p0 = x0, y0, x1, y1; a_c0 = color; a_v0 = highlight. */
export const TILE_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_p0;
layout(location = 3) in vec4 a_c0;
layout(location = 5) in float a_v0;
out vec2 v_px;
flat out vec4 v_box;
out vec4 v_col;
flat out float v_hl;
void main() {
  vec2 a = toPx(a_p0.xy), b = toPx(a_p0.zw);
  vec2 mn = min(a, b), mx = max(a, b);
  vec2 px = mix(mn - 1.0, mx + 1.0, a_corner);
  v_px = px;
  v_box = vec4(mn, mx);
  v_col = a_c0;
  v_hl = a_v0;
  gl_Position = pxToClip(px);
}
`

export const TILE_FS = FS_HEAD + /* glsl */ `
in vec2 v_px;
flat in vec4 v_box;
in vec4 v_col;
flat in float v_hl;
uniform float u_radius;
uniform float u_effect;
uniform float u_borderW;
uniform vec4 u_hlColor;
uniform float u_outline;
void main() {
  vec2 c = (v_box.xy + v_box.zw) * 0.5;
  vec2 hs = (v_box.zw - v_box.xy) * 0.5;
  float r = min(u_radius, min(hs.x, hs.y));
  vec2 q = abs(v_px - c) - hs + r;
  float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.003) discard;
  if (u_outline > 0.5) {
    float ring = clamp(d + u_borderW + 0.5, 0.0, 1.0) * a;
    if (ring <= 0.003) discard;
    emit(vec4(u_hlColor.rgb, u_hlColor.a * ring));
    return;
  }
  vec4 col = v_col;
  if (u_effect > 0.0) {
    float ty = clamp((v_px.y - v_box.y) / max(v_box.w - v_box.y, 1.0), 0.0, 1.0);
    col.rgb *= mix(1.0 + 0.10 * u_effect, 1.0 - 0.16 * u_effect, ty);
    // faint bevel: lighter rim along the top edge
    float rim = clamp(1.0 - (v_px.y - v_box.y) / 2.5, 0.0, 1.0);
    col.rgb = mix(col.rgb, vec3(1.0), 0.10 * rim * u_effect);
  }
  col.rgb = mix(col.rgb, vec3(1.0), 0.16 * v_hl);
  emit(vec4(col.rgb, col.a * a));
}
`

/**
 * Annular sector: a_p0 = r0, r1, a0, a1 (CSS px, radians, screen angles with y down);
 * a_p1 = bounding box x0, y0, x1, y1; a_c0 = color; a_v0 = highlight.
 */
export const SECTOR_VS = VS_HEAD + /* glsl */ `
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_p0;
layout(location = 2) in vec4 a_p1;
layout(location = 3) in vec4 a_c0;
layout(location = 5) in float a_v0;
uniform vec2 u_center;
out vec2 v_px;
flat out vec4 v_geo;
flat out vec2 v_c;
out vec4 v_col;
flat out float v_hl;
void main() {
  vec2 mn = toPx(a_p1.xy), mx = toPx(a_p1.zw);
  vec2 px = mix(mn - 2.0, mx + 2.0, a_corner);
  v_px = px;
  v_c = toPx(u_center);
  v_geo = vec4(a_p0.xy * u_scale.x, a_p0.zw);
  v_col = a_c0;
  v_hl = a_v0;
  gl_Position = pxToClip(px);
}
`

export const SECTOR_FS = FS_HEAD + /* glsl */ `
in vec2 v_px;
flat in vec4 v_geo;
flat in vec2 v_c;
in vec4 v_col;
flat in float v_hl;
uniform float u_gap;
uniform float u_effect;
uniform float u_borderW;
uniform vec4 u_hlColor;
uniform float u_outline;
void main() {
  vec2 p = v_px - v_c;
  float r = length(p);
  float r0 = v_geo.x, r1 = v_geo.y, a0 = v_geo.z, a1 = v_geo.w;
  float dr = max(r0 - r, r - r1);
  float span = a1 - a0;
  float da = -1e9;
  if (span < 6.2830) {
    vec2 n0 = vec2(-sin(a0), cos(a0));
    vec2 n1 = vec2(sin(a1), -cos(a1));
    float d0 = dot(p, n0), d1 = dot(p, n1);
    da = span <= 3.14159265 ? -min(d0, d1) : -max(d0, d1);
  }
  float d = max(dr + (r0 > 0.5 ? u_gap * 0.5 : 0.0), da + u_gap * 0.5);
  d = max(d, r - r1 + u_gap * 0.5);
  float a = clamp(0.5 - d, 0.0, 1.0);
  if (a <= 0.003) discard;
  if (u_outline > 0.5) {
    float ring = clamp(d + u_borderW + 0.5, 0.0, 1.0) * a;
    if (ring <= 0.003) discard;
    emit(vec4(u_hlColor.rgb, u_hlColor.a * ring));
    return;
  }
  vec4 col = v_col;
  if (u_effect > 0.0 && r1 > r0 + 1.0) {
    float t = clamp((r - r0) / (r1 - r0), 0.0, 1.0);
    col.rgb *= mix(1.0 - 0.14 * u_effect, 1.0 + 0.06 * u_effect, t);
  }
  col.rgb = mix(col.rgb, vec3(1.0), 0.18 * v_hl);
  emit(vec4(col.rgb, col.a * a));
}
`
