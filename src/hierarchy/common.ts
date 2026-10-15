import { Color, ColorRGBA } from '../core/color'
import { LUT, PalettedFill } from '../core/style'
import { Theme, font, seriesColor } from '../core/theme'
import { Rect, roundRect, textWidth } from '../core/util'
import { GLRenderer, makeXform, Xform } from '../render/GLRenderer'

// Shared pieces of the hierarchy charts (TreeMap, Sunburst): data model,
// squarified layout, coloring, tooltip and text helpers. MapChart and DataGrid
// reuse the tooltip / text helpers.

/** Input node format: `{ name, value?, children? }`. */
export interface HierarchyNodeData {
  name: string
  value?: number
  children?: HierarchyNodeData[]
  [k: string]: unknown
}

/** Resolved hierarchy node. Parent values are the sum of their children. */
export class HierarchyNode {
  readonly children: HierarchyNode[] = []
  value = 0
  /** Value looked up by LUT coloring: own property, else value-weighted mean of children. */
  colorValue = NaN
  /** Index of the top-level branch (child of the root) this node belongs to. */
  branch = 0
  /** Index among siblings. */
  index = 0
  constructor(
    readonly key: string,
    readonly name: string,
    readonly parent: HierarchyNode | null,
    readonly depth: number,
    readonly data: HierarchyNodeData | null,
  ) {}
  getName() { return this.name }
  getValue() { return this.value }
  getChildren() { return this.children }
  getParent() { return this.parent }
  getDepth() { return this.depth }
  getData() { return this.data }
  isLeaf() { return this.children.length === 0 }
  /** Path from the root to this node (inclusive). */
  getPath(): HierarchyNode[] {
    const p: HierarchyNode[] = []
    for (let n: HierarchyNode | null = this; n; n = n.parent) p.unshift(n)
    return p
  }
  /** True if `n` is this node or one of its descendants. */
  contains(n: HierarchyNode | null): boolean {
    for (let p = n; p; p = p.parent) if (p === this) return true
    return false
  }
  /** Depth of the deepest descendant relative to this node. */
  height(): number {
    let h = 0
    for (const c of this.children) h = Math.max(h, 1 + c.height())
    return h
  }
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)

/** Build the resolved tree. Node keys are name paths, stable across `setData` calls. */
export function buildHierarchy(
  input: HierarchyNodeData | HierarchyNodeData[],
  rootName: string,
  colorProp = 'value',
): { root: HierarchyNode; byKey: Map<string, HierarchyNode> } {
  const byKey = new Map<string, HierarchyNode>()
  const rootData: HierarchyNodeData = Array.isArray(input) ? { name: rootName, children: input } : input
  const make = (d: HierarchyNodeData, parent: HierarchyNode | null, depth: number, key: string): HierarchyNode => {
    const n = new HierarchyNode(key, String(d.name ?? ''), parent, depth, d)
    byKey.set(key, n)
    const seen = new Map<string, number>()
    const kids = Array.isArray(d.children) ? d.children : []
    kids.forEach((cd, i) => {
      if (!cd || typeof cd !== 'object') return
      const nm = String(cd.name ?? i)
      const k = seen.get(nm) ?? 0
      seen.set(nm, k + 1)
      const c = make(cd, n, depth + 1, `${key}\u0001${nm}${k ? '#' + k : ''}`)
      c.index = n.children.length
      n.children.push(c)
    })
    const own = num(d[colorProp])
    if (n.children.length) {
      let s = 0, ws = 0, vs = 0
      for (const c of n.children) {
        s += c.value
        if (Number.isFinite(c.colorValue) && c.value > 0) {
          vs += c.colorValue * c.value
          ws += c.value
        }
      }
      n.value = s
      n.colorValue = colorProp !== 'value' && Number.isFinite(own) ? own : ws > 0 ? vs / ws : NaN
    } else {
      const v = num(d.value)
      n.value = Number.isFinite(v) && v > 0 ? v : 0
      n.colorValue = Number.isFinite(own) ? own : n.value
    }
    return n
  }
  const root = make(rootData, null, 0, '')
  const setBranch = (n: HierarchyNode, b: number) => {
    n.branch = b
    for (const c of n.children) setBranch(c, b)
  }
  root.children.forEach((c, i) => setBranch(c, i))
  return { root, byKey }
}

/** Accept a node, its input data object, or a name path; return the resolved node. */
export function findNode(
  root: HierarchyNode | null,
  byKey: Map<string, HierarchyNode>,
  q: HierarchyNode | HierarchyNodeData | string[] | string | null | undefined,
): HierarchyNode | null {
  if (!root || q == null) return root
  if (q instanceof HierarchyNode) return byKey.get(q.key) ?? null
  if (typeof q === 'string') q = [q]
  if (Array.isArray(q)) {
    let n: HierarchyNode | null = root
    const names = q[0] === root.name && q.length > 1 ? q.slice(1) : q
    for (const nm of names) {
      n = n?.children.find((c) => c.name === nm) ?? null
      if (!n) break
    }
    if (n) return n
    // Fall back to a depth-first search by the last name.
    const last = q[q.length - 1]
    const stack = [root]
    while (stack.length) {
      const x = stack.pop()!
      if (x.name === last) return x
      stack.push(...x.children)
    }
    return null
  }
  for (const n of byKey.values()) if (n.data === q) return n
  return null
}

// ---------------------------------------------------------------- coloring

/** Node coloring: a LUT over a numeric property, a palette per top-level branch, or a callback. */
export interface NodeColoring {
  lut?: LUT
  /** Input property looked up by the LUT (default 'value'). */
  lookUpProperty?: string
  palette?: Color[]
  /** Custom per-node color. */
  color?: (node: HierarchyNode) => Color | undefined
}

export type NodeColoringInput = NodeColoring | LUT | PalettedFill | ((node: HierarchyNode) => Color | undefined)

export function normalizeColoring(c: NodeColoringInput): NodeColoring {
  if (c instanceof LUT) return { lut: c }
  if (c instanceof PalettedFill) return { lut: c.lut }
  if (typeof c === 'function') return { color: c }
  return { ...c }
}

/** Base color of a node before level/variation tweaks. */
export function nodeBaseColor(t: Theme, c: NodeColoring, n: HierarchyNode): Color {
  const custom = c.color?.(n)
  if (custom) return custom
  if (c.lut) return Number.isFinite(n.colorValue) ? c.lut.getColor(n.colorValue) : t.isDark ? ColorRGBA(70, 70, 70) : ColorRGBA(200, 200, 200)
  const pal = c.palette ?? t.seriesColors
  return pal[((n.branch % pal.length) + pal.length) % pal.length] ?? seriesColor(t, n.branch)
}

export const luminance = (c: Color) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255
/** Readable text color on top of `bg`. */
export const contrastText = (bg: Color) => (luminance(bg) > 0.56 ? ColorRGBA(18, 18, 18) : ColorRGBA(250, 250, 248))

/** Deterministic 0..1 hash of a string (for subtle color variation). */
export function hash01(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 997) / 996
}

export const WHITE = ColorRGBA(255, 255, 255)

// ---------------------------------------------------------------- layout

export interface LRect { x: number; y: number; w: number; h: number }

/**
 * Squarified treemap layout (Bruls et al). Returns one rect per value, in input order.
 * `order` (indices) fixes the placement order instead of sorting by value, which keeps
 * tiles in place when values change (ordered treemap).
 */
export function squarify(values: number[], r: LRect, order?: number[]): LRect[] {
  const out: LRect[] = values.map(() => ({ x: r.x, y: r.y, w: 0, h: 0 }))
  const idx = (order ?? values.map((_, i) => i).sort((a, b) => values[b] - values[a])).filter((i) => values[i] > 0)
  const total = idx.reduce((s, i) => s + values[i], 0)
  if (!idx.length || r.w <= 0 || r.h <= 0 || !(total > 0)) return out
  const k = (r.w * r.h) / total
  const area = (i: number) => values[i] * k
  let { x, y, w, h } = r
  const worst = (sum: number, mn: number, mx: number, side: number) => {
    const s2 = sum * sum, w2 = side * side
    return Math.max((w2 * mx) / s2, s2 / (w2 * mn))
  }
  let i = 0
  while (i < idx.length) {
    const side = Math.min(w, h)
    let sum = area(idx[i]), mn = sum, mx = sum
    let cur = worst(sum, mn, mx, side)
    let j = i + 1
    while (j < idx.length) {
      const a = area(idx[j])
      const nw = worst(sum + a, Math.min(mn, a), Math.max(mx, a), side)
      if (nw > cur) break
      sum += a
      mn = Math.min(mn, a)
      mx = Math.max(mx, a)
      cur = nw
      j++
    }
    const last = j >= idx.length
    if (w >= h) {
      const thick = last ? w : sum / h
      let yy = y
      for (let q = i; q < j; q++) {
        const hh = q === j - 1 ? y + h - yy : area(idx[q]) / thick
        out[idx[q]] = { x, y: yy, w: thick, h: hh }
        yy += hh
      }
      x += thick
      w -= thick
    } else {
      const thick = last ? h : sum / w
      let xx = x
      for (let q = i; q < j; q++) {
        const ww = q === j - 1 ? x + w - xx : area(idx[q]) / thick
        out[idx[q]] = { x: xx, y, w: ww, h: thick }
        xx += ww
      }
      y += thick
      h -= thick
    }
    i = j
  }
  return out
}

// ---------------------------------------------------------------- formatting / text

/** Compact value formatting used by labels and tooltips. */
export function formatValue(v: number): string {
  if (!Number.isFinite(v)) return '-'
  const a = Math.abs(v)
  const trim = (s: string) => s.replace(/\.0+$|(\.\d*?)0+$/, '$1')
  if (a >= 1e12) return trim((v / 1e12).toFixed(2)) + 'T'
  if (a >= 1e9) return trim((v / 1e9).toFixed(2)) + 'B'
  if (a >= 1e6) return trim((v / 1e6).toFixed(2)) + 'M'
  if (a >= 1e5) return trim((v / 1e3).toFixed(1)) + 'k'
  if (Number.isInteger(v)) return v.toLocaleString('en-US')
  return trim(v.toFixed(a < 1 ? 3 : a < 100 ? 2 : 1))
}

const ELL = '…'
/** Truncate text with an ellipsis to fit `maxW`; '' if not even a couple of chars fit. */
export function fitText(text: string, maxW: number, fnt: string): string {
  if (textWidth(text, fnt) <= maxW) return text
  if (maxW < textWidth('W' + ELL, fnt)) return ''
  let lo = 0, hi = text.length
  while (lo < hi) {
    const m = (lo + hi + 1) >> 1
    if (textWidth(text.slice(0, m) + ELL, fnt) <= maxW) lo = m
    else hi = m - 1
  }
  return lo > 0 ? text.slice(0, lo).trimEnd() + ELL : ''
}

// ---------------------------------------------------------------- tooltip

export interface TipRow {
  text: string
  value?: string
  color?: Color
  bold?: boolean
  /** Color swatch drawn before the text. */
  swatch?: Color
}

/** Cursor-style result table near (x, y), kept inside `bounds`. */
export function drawTooltip(ctx: CanvasRenderingContext2D, t: Theme, x: number, y: number, rows: TipRow[], bounds: Rect) {
  if (!rows.length) return
  const fs = t.fontSize
  const fN = font(t, fs), fB = font(t, fs, 600)
  const lh = fs * 1.45, pad = 8
  let w = 0
  for (const r of rows) {
    const lw = textWidth(r.text, r.bold ? fB : fN) + (r.swatch ? fs + 4 : 0)
    const vw = r.value ? textWidth(r.value, fN) + 18 : 0
    w = Math.max(w, lw + vw)
  }
  w += pad * 2
  const h = rows.length * lh + pad * 2 - (lh - fs)
  let bx = x + 16, by = y + 16
  if (bx + w > bounds.x + bounds.w - 4) bx = x - w - 12
  if (bx < bounds.x + 4) bx = bounds.x + 4
  if (by + h > bounds.y + bounds.h - 4) by = y - h - 12
  if (by < bounds.y + 4) by = bounds.y + 4
  ctx.save()
  roundRect(ctx, bx, by, w, h, 5)
  ctx.fillStyle = t.cursor.tableFill.toCSS()
  ctx.fill()
  ctx.strokeStyle = t.cursor.tableStroke.toCSS()
  ctx.lineWidth = 1
  ctx.stroke()
  ctx.textBaseline = 'middle'
  rows.forEach((r, i) => {
    const cy = by + pad + i * lh + fs / 2 + 1
    let cx = bx + pad
    if (r.swatch) {
      roundRect(ctx, cx, cy - fs / 2 + 1, fs - 2, fs - 2, 2)
      ctx.fillStyle = r.swatch.toCSS()
      ctx.fill()
      cx += fs + 4
    }
    ctx.font = r.bold ? fB : fN
    ctx.textAlign = 'left'
    ctx.fillStyle = (r.color ?? t.cursor.textColor).toCSS()
    ctx.fillText(r.text, cx, cy)
    if (r.value) {
      ctx.font = fN
      ctx.textAlign = 'right'
      ctx.fillStyle = t.cursor.textColor.toCSS()
      ctx.fillText(r.value, bx + w - pad, cy)
    }
  })
  ctx.restore()
}

// ---------------------------------------------------------------- GL helpers

/** Transform for drawing in CSS px surface coordinates. */
export function pxXform(r: GLRenderer): Xform {
  const id = { a0: 0, start: 0, k: 1, log: 0 }
  return makeXform(id, id, 0, 0, r.dpr)
}

/** Growable per-instance float + packed color buffers. */
export class Instances {
  n = 0
  f: Float32Array
  c: Uint32Array
  private fbuf: WebGLBuffer | null = null
  private cbuf: WebGLBuffer | null = null
  private cap = 0
  constructor(readonly stride: number) {
    this.f = new Float32Array(64 * stride)
    this.c = new Uint32Array(64)
  }
  clear() { this.n = 0 }
  /** Reserve one instance; returns its float offset. */
  add(color: number): number {
    if (this.n >= this.c.length) {
      const cap = this.c.length * 2
      const f = new Float32Array(cap * this.stride); f.set(this.f); this.f = f
      const c = new Uint32Array(cap); c.set(this.c); this.c = c
    }
    this.c[this.n] = color
    return this.n++ * this.stride
  }
  /** Upload and return the GL buffers. */
  upload(gl: WebGL2RenderingContext): [WebGLBuffer, WebGLBuffer] {
    if (!this.fbuf) {
      this.fbuf = gl.createBuffer()!
      this.cbuf = gl.createBuffer()!
    }
    if (this.cap < this.c.length) {
      this.cap = this.c.length
      gl.bindBuffer(gl.ARRAY_BUFFER, this.fbuf)
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * this.stride * 4, gl.DYNAMIC_DRAW)
      gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
      gl.bufferData(gl.ARRAY_BUFFER, this.cap * 4, gl.DYNAMIC_DRAW)
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fbuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.f, 0, this.n * this.stride)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cbuf)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.c, 0, this.n)
    return [this.fbuf, this.cbuf!]
  }
  dispose(r: GLRenderer | null) {
    if (r && this.fbuf) {
      r.gl.deleteBuffer(this.fbuf)
      r.gl.deleteBuffer(this.cbuf)
    }
    this.fbuf = this.cbuf = null
    this.cap = 0
  }
}

/** Packed RGBA with an alpha multiplier. */
export const packColor = (c: Color, alpha = 1) =>
  ((Math.round(Math.max(0, Math.min(255, c.a * alpha))) << 24) | (Math.round(c.b) << 16) | (Math.round(c.g) << 8) | Math.round(c.r)) >>> 0
