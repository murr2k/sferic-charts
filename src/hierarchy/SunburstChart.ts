import { Color, ColorRGBA } from '../core/color'
import { Legend, LegendOptions } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { font } from '../core/theme'
import { Easings, Rect, textWidth, Tween } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { ATTR } from '../render/shaders'
import type { PointerInfo, Surface } from '../render/Surface'
import {
  buildHierarchy, contrastText, drawTooltip, findNode, fitText, formatValue, HierarchyNode, HierarchyNodeData, Instances,
  NodeColoring, NodeColoringInput, nodeBaseColor, normalizeColoring, packColor, pxXform, TipRow, WHITE,
} from './common'
import { SECTOR_FS, SECTOR_VS } from './shaders'

export interface SunburstChartOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

/** A sector in layout space: angles in radians (screen, y down), depth 0..1 = center disc, k..k+1 = ring k. */
interface Arc {
  key: string
  node: HierarchyNode | null
  name: string
  value: number
  a0: number
  a1: number
  d0: number
  d1: number
  color: Color
  alpha: number
  depth: number
}

type Pending = { kind: 'data' } | { kind: 'down'; node: HierarchyNode } | { kind: 'up'; from: HierarchyNode }

const TAU = Math.PI * 2
const BASE = -Math.PI / 2
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

/** CSS px bounding box of an annular sector. */
function sectorBox(cx: number, cy: number, r0: number, r1: number, a0: number, a1: number): [number, number, number, number] {
  if (a1 - a0 >= TAU - 1e-6) return [cx - r1, cy - r1, cx + r1, cy + r1]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const add = (r: number, a: number) => {
    const x = cx + r * Math.cos(a), y = cy + r * Math.sin(a)
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  add(r0, a0); add(r0, a1); add(r1, a0); add(r1, a1)
  for (let k = Math.ceil(a0 / (Math.PI / 2)); k * (Math.PI / 2) <= a1; k++) add(r1, k * (Math.PI / 2))
  return [x0, y0, x1, y1]
}

/**
 * Sunburst chart: concentric rings of a hierarchy.
 * Click a sector to zoom into it, click the center to go up. Sectors are GPU-drawn
 * analytic annular sectors; labels are 2D overlay, curved along arcs when they fit.
 */
export class SunburstChart extends Panel {
  readonly legend: Legend
  private root: HierarchyNode | null = null
  private byKey = new Map<string, HierarchyNode>()
  private input: HierarchyNodeData | HierarchyNodeData[] | null = null
  private view: HierarchyNode | null = null
  private levels = 4
  private coloring: NodeColoring = {}
  private lutName = ''
  private effect = true
  private animEnabled = true
  private animDur = 750
  private initialText = 'All'
  private labelsVisible = true
  private valueFmt: (v: number, node: HierarchyNode | null) => string = (v) => formatValue(v)
  private gap = 1.5
  // layout + transition
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private cx = 0
  private cy = 0
  private R = 0
  private pending: Pending | null = null
  private pairs: { a: Arc; b: Arc }[] = []
  private t = 1
  private tween: Tween | null = null
  private cur: Arc[] = []
  private Lfrom = 1
  private Lto = 1
  private L = 1
  // interaction
  private pointer: { x: number; y: number } | null = null
  private hoverKey: string | null = null
  private inst = new Instances(9)
  private hlInst = new Instances(9)

  constructor(o: SunburstChartOptions = {}) {
    super(o)
    this.legend = new Legend(this, { position: 'bottom', ...o.legend })
  }

  // ---------------------------------------------------------------- data / config

  /** Set the hierarchy (root node or array of top-level nodes). Animates from previous data. */
  setData(data: HierarchyNodeData | HierarchyNodeData[]) {
    this.input = data
    this.rebuild()
    return this
  }
  getData() { return this.input }
  getRootNode() { return this.root }

  private rebuild() {
    if (!this.input) return
    const prevView = this.view?.key
    const { root, byKey } = buildHierarchy(this.input, this.initialText, this.coloring.lookUpProperty ?? 'value')
    this.root = root
    this.byKey = byKey
    this.view = (prevView !== undefined ? byKey.get(prevView) : undefined) ?? root
    this.pending = { kind: 'data' }
    this.requestRender()
  }

  /** Maximum number of rings shown around the current center node (default 4). */
  setDisplayLevelCount(n: number) {
    this.levels = Math.max(1, Math.floor(n))
    this.pending = { kind: 'data' }
    this.requestRender()
    return this
  }
  getDisplayLevelCount() { return this.levels }
  setDisplayLevel(n: number) { return this.setDisplayLevelCount(n) }

  /** `{ lut, lookUpProperty? }`, `{ palette }` or `(node) => Color`. Default: palette per branch, lighter children. */
  setNodeColoring(c: NodeColoringInput, o: { legendName?: string } = {}) {
    const prevProp = this.coloring.lookUpProperty ?? 'value'
    this.coloring = normalizeColoring(c)
    this.lutName = o.legendName ?? (this.coloring.lookUpProperty && this.coloring.lookUpProperty !== 'value' ? this.coloring.lookUpProperty : '')
    this.legend.clear()
    if (this.coloring.lut) this.legend.add(this.coloring.lut, { name: this.lutName || undefined })
    if ((this.coloring.lookUpProperty ?? 'value') !== prevProp) this.rebuild()
    else this.pending = { kind: 'data' }
    this.requestRender()
    return this
  }
  getNodeColoring() { return this.coloring }

  setInitialPathButtonText(text: string) { this.initialText = text; if (this.input) this.rebuild(); return this }
  setNodeEffect(enabled: boolean) { this.effect = enabled; this.requestRender(); return this }
  setLabelsVisible(v: boolean) { this.labelsVisible = v; this.requestRender(); return this }
  setValueFormatter(f: (value: number, node: HierarchyNode | null) => string) { this.valueFmt = f; this.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animEnabled = v; return this }
  setAnimationDuration(ms: number) { this.animDur = Math.max(0, ms); return this }
  /** Gap between sectors in px. */
  setNodeGap(px: number) { this.gap = Math.max(0, px); this.requestRender(); return this }

  /** Zoom into a node (node object, input data or name path); `null` returns to the root. */
  setDrillDownNode(node: HierarchyNode | HierarchyNodeData | string[] | string | null) {
    const n = node === null ? this.root : findNode(this.root, this.byKey, node)
    if (n) this.drillTo(n.children.length ? n : n.parent ?? n)
    return this
  }
  getDrillDownNode() { return this.view }
  drillUp() {
    if (this.view?.parent) this.drillTo(this.view.parent)
    return this
  }

  private drillTo(n: HierarchyNode) {
    const old = this.view
    if (!old || n === old) return
    this.view = n
    this.pending = old.contains(n) ? { kind: 'down', node: n } : n.contains(old) ? { kind: 'up', from: old } : { kind: 'data' }
    this.hoverKey = null
    this.emit('drilldown', { node: n, chart: this })
    this.requestRender()
  }

  // ---------------------------------------------------------------- layout

  private levelCount() { return Math.max(1, Math.min(this.levels, this.view ? this.view.height() : 1)) }

  private arcColor(n: HierarchyNode): Color {
    const t = this.theme
    const base = nodeBaseColor(t, this.coloring, n)
    if (this.coloring.lut || this.coloring.color) return base
    const lv = Math.max(0, n.depth - 1)
    return t.isDark ? base.scale(0.78).mix(WHITE, Math.min(0.4, lv * 0.13)) : base.mix(WHITE, Math.min(0.6, lv * 0.18))
  }

  private centerColor(n: HierarchyNode): Color {
    const t = this.theme
    if (n === this.root || !n.parent) return t.isDark ? ColorRGBA(34, 34, 32) : ColorRGBA(236, 238, 241)
    const c = this.arcColor(n)
    return t.isDark ? c.scale(0.4) : c.mix(WHITE, 0.55)
  }

  private computeTargets(): Map<string, Arc> {
    const out = new Map<string, Arc>()
    const v = this.view
    if (!v) return out
    const L = this.levelCount()
    out.set(v.key, { key: v.key, node: v, name: v.name, value: v.value, a0: BASE, a1: BASE + TAU, d0: 0, d1: 1, color: this.centerColor(v), alpha: 1, depth: v.depth })
    const rec = (node: HierarchyNode, a0: number, a1: number, lvl: number) => {
      if (lvl > L || !(node.value > 0)) return
      const kids = [...node.children].sort((p, q) => q.value - p.value)
      let a = a0
      for (const c of kids) {
        const span = ((a1 - a0) * c.value) / node.value
        if (!(span > 0)) continue
        out.set(c.key, { key: c.key, node: c, name: c.name, value: c.value, a0: a, a1: a + span, d0: lvl, d1: lvl + 1, color: this.arcColor(c), alpha: 1, depth: c.depth })
        rec(c, a, a + span, lvl + 1)
        a += span
      }
    }
    rec(v, BASE, BASE + TAU, 1)
    return out
  }

  private setStatic(tgt: Map<string, Arc>) {
    this.tween?.cancel()
    this.tween = null
    this.t = 1
    this.Lfrom = this.Lto = this.L = this.levelCount()
    this.pairs = [...tgt.values()].map((b) => ({ a: b, b }))
  }

  private startTransition(tgt: Map<string, Arc>, p: Pending) {
    const old = new Map(this.cur.map((x) => [x.key, x]))
    type Map1 = (x: Arc) => Partial<Arc>
    let n2o: Map1 | null = null
    let o2n: Map1 | null = null
    if (p.kind === 'down') {
      let b: Arc | undefined
      for (let n: HierarchyNode | null = p.node; n && !b; n = n.parent) b = old.get(n.key)
      if (b) {
        const { a0: ba0, a1: ba1, d0: bd } = b
        const k = (ba1 - ba0) / TAU
        n2o = (x) => ({ a0: ba0 + (x.a0 - BASE) * k, a1: ba0 + (x.a1 - BASE) * k, d0: x.d0 + bd, d1: x.d1 + bd })
        const inv = (a: number) => clamp(BASE + (a - ba0) / (k || 1e-9), BASE, BASE + TAU)
        o2n = (x) => ({ a0: inv(x.a0), a1: inv(x.a1), d0: Math.max(0, x.d0 - bd), d1: Math.max(0, x.d1 - bd) })
      }
    } else if (p.kind === 'up') {
      let a: Arc | undefined
      for (let n: HierarchyNode | null = p.from; n && !a; n = n.parent) a = tgt.get(n.key)
      if (a) {
        const { a0: aa0, a1: aa1, d0: ad } = a
        const k = (aa1 - aa0) / TAU
        o2n = (x) => ({ a0: aa0 + (x.a0 - BASE) * k, a1: aa0 + (x.a1 - BASE) * k, d0: x.d0 + ad, d1: x.d1 + ad })
        const inv = (q: number) => clamp(BASE + (q - aa0) / (k || 1e-9), BASE, BASE + TAU)
        n2o = (x) => ({ a0: inv(x.a0), a1: inv(x.a1), d0: Math.max(0, x.d0 - ad), d1: Math.max(0, x.d1 - ad) })
      }
    }
    const collapse = (x: Arc): Partial<Arc> => ({ a0: (x.a0 + x.a1) / 2, a1: (x.a0 + x.a1) / 2 })
    const pairs: { a: Arc; b: Arc }[] = []
    for (const [k, b] of tgt) {
      const a = old.get(k)
      pairs.push({ a: a ?? { ...b, ...(n2o ? n2o(b) : collapse(b)), alpha: 0 }, b })
    }
    for (const [k, a] of old) {
      if (tgt.has(k)) continue
      pairs.push({ a, b: { ...a, ...(o2n ? o2n(a) : collapse(a)), alpha: 0 } })
    }
    pairs.sort((x, y) => x.b.depth - y.b.depth)
    this.pairs = pairs
    this.Lfrom = this.L
    this.Lto = this.levelCount()
    this.tween?.cancel()
    this.t = 0
    this.tween = this.animate(
      new Tween([0], [1], this.animDur, (v) => {
        this.t = v[0]
        if (this.t >= 1) this.pairs = this.pairs.filter((q) => q.b.alpha > 0).map((q) => ({ a: q.b, b: q.b }))
      }, Easings.easeInOut),
    )
  }

  private updateCurrent() {
    const t = this.t
    this.L = t >= 1 ? this.Lto : lerp(this.Lfrom, this.Lto, t)
    const out: Arc[] = []
    for (const { a, b } of this.pairs) {
      if (t >= 1 || a === b) {
        if (b.alpha > 0.004) out.push(b)
        continue
      }
      const alpha = lerp(a.alpha, b.alpha, t)
      if (alpha <= 0.004) continue
      const ints = Number.isInteger(a.value) && Number.isInteger(b.value)
      const v = lerp(a.value, b.value, t)
      out.push({
        key: b.key,
        node: b.node ?? a.node,
        name: t < 0.5 ? a.name : b.name,
        value: ints ? Math.round(v) : v,
        a0: lerp(a.a0, b.a0, t),
        a1: lerp(a.a1, b.a1, t),
        d0: lerp(a.d0, b.d0, t),
        d1: lerp(a.d1, b.d1, t),
        color: a.color.mix(b.color, t),
        alpha,
        depth: b.depth,
      })
    }
    this.cur = out
  }

  /** Depth coordinate to radius (CSS px) for the current ring count. */
  private radius(d: number): number {
    const L = Math.max(1, this.L)
    const rc = this.R * clamp(0.95 / (L + 1.2), 0.13, 0.3)
    const th = (this.R - rc) / L
    return d <= 1 ? Math.max(0, d) * rc : rc + (d - 1) * th
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    const area = this.legend.layout(content)
    this.area = area
    this.cx = area.x + area.w / 2
    this.cy = area.y + area.h / 2
    this.R = Math.max(0, Math.min(area.w, area.h) / 2 - 6)
    if (this.pending) {
      const p = this.pending
      this.pending = null
      const tgt = this.computeTargets()
      if (this.animEnabled && this.animDur > 0 && this.cur.length) this.startTransition(tgt, p)
      else this.setStatic(tgt)
    }
    this.updateCurrent()
    if (this.hoverKey && !this.cur.some((c) => c.key === this.hoverKey)) this.hoverKey = null
  }

  // ---------------------------------------------------------------- drawing

  override hasGL() { return this.cur.length > 0 }

  private fillInstances(inst: Instances, list: Arc[], hl: boolean) {
    inst.clear()
    for (const a of list) {
      const r0 = this.radius(a.d0), r1 = this.radius(a.d1)
      if (a.a1 - a.a0 < 1e-5 || r1 - r0 < 0.3) continue
      const o = inst.add(packColor(a.color, a.alpha))
      const f = inst.f
      f[o] = r0
      f[o + 1] = r1
      f[o + 2] = a.a0
      f[o + 3] = a.a1
      const bb = sectorBox(this.cx, this.cy, r0, r1, a.a0, a.a1)
      f[o + 4] = bb[0]
      f[o + 5] = bb[1]
      f[o + 6] = bb[2]
      f[o + 7] = bb[3]
      f[o + 8] = hl || a.key === this.hoverKey ? 1 : 0
    }
  }

  override drawGL(r: GLRenderer) {
    if (this.R <= 0) return
    const gl = r.gl
    const prog = r.program('sferic-sector', SECTOR_VS, SECTOR_FS)
    const draw = (inst: Instances, outline: boolean) => {
      if (!inst.n) return
      const [fb, cb] = inst.upload(gl)
      r.useXform(prog, pxXform(r))
      r.u2f(prog.u.u_center, this.cx, this.cy)
      r.u1f(prog.u.u_gap, this.gap * r.dpr)
      r.u1f(prog.u.u_effect, this.effect ? (this.theme.isDark ? 1 : 0.5) : 0)
      r.u1f(prog.u.u_borderW, 2 * r.dpr)
      r.u1f(prog.u.u_outline, outline ? 1 : 0)
      const hc = this.theme.examples.highlightColor.toFloat()
      r.u4f(prog.u.u_hlColor, hc[0], hc[1], hc[2], 0.95)
      r.useLUT(prog, 0, null)
      r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.p1, ATTR.c0, ATTR.v0])
      r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
      r.attrib(ATTR.p0, fb, 4, gl.FLOAT, false, 36, 0, 1)
      r.attrib(ATTR.p1, fb, 4, gl.FLOAT, false, 36, 16, 1)
      r.attrib(ATTR.v0, fb, 1, gl.FLOAT, false, 36, 32, 1)
      r.attrib(ATTR.c0, cb, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, inst.n)
    }
    r.scissor(this.rect)
    r.glow = 0
    this.fillInstances(this.inst, this.cur, false)
    draw(this.inst, false)
    const hov = this.hoverKey ? this.cur.find((c) => c.key === this.hoverKey) : undefined
    if (hov) {
      r.glow = 1
      this.fillInstances(this.hlInst, [hov], true)
      draw(this.hlInst, true)
    }
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const fs = t.fontSize
    if (this.labelsVisible && this.R > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(this.rect.x, this.rect.y, this.rect.w, this.rect.h)
      ctx.clip()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const fL = font(t, fs - 1, 600)
      for (const a of this.cur) {
        if (a.alpha < 0.5 || !a.node) continue
        ctx.globalAlpha = Math.min(1, (a.alpha - 0.5) / 0.4)
        if (a.d0 < 0.5 && a.a1 - a.a0 > TAU - 0.01) {
          this.drawCenterLabel(ctx, a)
          continue
        }
        const r0 = this.radius(a.d0), r1 = this.radius(a.d1)
        const span = a.a1 - a.a0
        const rm = (r0 + r1) / 2
        const thick = r1 - r0 - this.gap
        const arcLen = rm * span - this.gap
        const mid = (a.a0 + a.a1) / 2
        ctx.font = fL
        ctx.fillStyle = contrastText(a.color).toCSS()
        let tw = 0
        for (const ch of a.name) tw += textWidth(ch, fL)
        if (tw + 10 <= arcLen && fs + 4 <= thick && span < TAU - 0.01) {
          this.drawArcText(ctx, a.name, rm, mid, fL, tw)
        } else if (fs + 1 <= arcLen && thick >= 28) {
          const label = fitText(a.name, thick - 10, fL)
          if (!label) continue
          const flip = Math.cos(mid) < 0
          ctx.save()
          ctx.translate(this.cx + rm * Math.cos(mid), this.cy + rm * Math.sin(mid))
          ctx.rotate(flip ? mid + Math.PI : mid)
          ctx.fillText(label, 0, 0)
          ctx.restore()
        }
      }
      ctx.restore()
    }
    this.legend.draw(ctx)
    this.drawHoverTip(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawArcText(ctx: CanvasRenderingContext2D, text: string, r: number, mid: number, fnt: string, tw: number) {
    const flip = Math.sin(mid) > 0.05
    let ang = flip ? mid + tw / (2 * r) : mid - tw / (2 * r)
    for (const ch of text) {
      const w = textWidth(ch, fnt)
      const a = flip ? ang - w / (2 * r) : ang + w / (2 * r)
      ctx.save()
      ctx.translate(this.cx + r * Math.cos(a), this.cy + r * Math.sin(a))
      ctx.rotate(flip ? a - Math.PI / 2 : a + Math.PI / 2)
      ctx.fillText(ch, 0, 0)
      ctx.restore()
      ang = flip ? ang - w / r : ang + w / r
    }
  }

  private drawCenterLabel(ctx: CanvasRenderingContext2D, a: Arc) {
    const t = this.theme
    const fs = t.fontSize
    const rc = this.radius(a.d1)
    if (rc < 18) return
    const tc = contrastText(a.color)
    const fB = font(t, fs + 1, 600), fV = font(t, fs - 1)
    const name = fitText(a.node && a.node === this.root ? a.node.name || this.initialText : a.name, rc * 1.7, fB)
    ctx.font = fB
    ctx.fillStyle = tc.toCSS()
    ctx.fillText(name, this.cx, this.cy - (rc > 40 ? fs * 0.55 : 0))
    if (rc > 40) {
      ctx.font = fV
      ctx.fillStyle = tc.setA(180).toCSS()
      ctx.fillText(fitText(this.valueFmt(a.value, a.node), rc * 1.6, fV), this.cx, this.cy + fs * 0.75)
    }
    if (a.node?.parent && rc > 55) {
      ctx.font = font(t, fs - 3)
      ctx.fillStyle = tc.setA(120).toCSS()
      ctx.fillText('▲ up', this.cx, this.cy + fs * 2)
    }
  }

  private drawHoverTip(ctx: CanvasRenderingContext2D) {
    if (!this.pointer || !this.hoverKey || this.t < 1) return
    const arc = this.cur.find((c) => c.key === this.hoverKey)
    const n = arc?.node
    if (!arc || !n) return
    const t = this.theme
    const fB = font(t, t.fontSize, 600)
    const isCenter = arc.d0 < 0.5
    const names = n.getPath().map((p, i) => (i === 0 ? p.name || this.initialText : p.name))
    const rows: TipRow[] = [{ text: fitText(names.join(' › '), 380, fB), bold: true, swatch: arc.color }]
    rows.push({ text: 'Value', value: this.valueFmt(n.value, n) })
    if (n.parent && n.parent.value > 0) rows.push({ text: 'Share of parent', value: `${((n.value / n.parent.value) * 100).toFixed(1)} %` })
    if (this.root && n !== this.root && this.root.value > 0) rows.push({ text: 'Share of total', value: `${((n.value / this.root.value) * 100).toFixed(1)} %` })
    const prop = this.coloring.lookUpProperty
    if (this.coloring.lut && prop && prop !== 'value' && Number.isFinite(n.colorValue)) rows.push({ text: prop, value: formatValue(n.colorValue) })
    if (isCenter && n.parent) rows.push({ text: 'Click to go up', color: t.legend.disabledColor })
    else if (!isCenter && !n.isLeaf()) rows.push({ text: `Click to zoom (${n.children.length} items)`, color: t.legend.disabledColor })
    drawTooltip(ctx, t, this.pointer.x, this.pointer.y, rows, this.rect)
  }

  // ---------------------------------------------------------------- interaction

  private arcAt(x: number, y: number): Arc | null {
    const dx = x - this.cx, dy = y - this.cy
    const rr = Math.hypot(dx, dy)
    if (rr > this.R + 2) return null
    const ang = Math.atan2(dy, dx)
    for (let i = this.cur.length - 1; i >= 0; i--) {
      const a = this.cur[i]
      if (a.alpha < 0.5) continue
      const r0 = this.radius(a.d0), r1 = this.radius(a.d1)
      if (rr < r0 || rr > r1) continue
      if (a.a1 - a.a0 >= TAU - 1e-6) return a
      for (const q of [ang, ang + TAU, ang - TAU]) if (q >= a.a0 && q <= a.a1) return a
    }
    return null
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    switch (e.type) {
      case 'move': {
        this.pointer = { x, y }
        const a = this.arcAt(x, y)
        this.hoverKey = a?.key ?? null
        const clickable = a?.node && (a.d0 < 0.5 ? !!a.node.parent : !a.node.isLeaf())
        this.surface.setCursor(clickable ? 'pointer' : 'default')
        return true
      }
      case 'leave':
        this.pointer = null
        this.hoverKey = null
        return true
      case 'down':
        if (e.button === 2) {
          this.drillUp()
          return true
        }
        return false
      case 'click': {
        if (e.button !== 0) return false
        const a = this.arcAt(x, y)
        if (!a?.node) return false
        this.emit('nodeclick', { node: a.node, chart: this })
        if (a.d0 < 0.5) this.drillUp()
        else if (!a.node.isLeaf()) this.drillTo(a.node)
        return true
      }
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) {
    this.inst.dispose(r)
    this.hlInst.dispose(r)
  }
}
