import { Color } from '../core/color'
import { Legend, LegendOptions } from '../core/Legend'
import { Panel, PanelOptions } from '../core/Panel'
import { fillToCanvas } from '../core/style'
import { font } from '../core/theme'
import { Easings, Rect, rectContains, roundRect, textWidth, Tween } from '../core/util'
import { GLRenderer } from '../render/GLRenderer'
import { ATTR } from '../render/shaders'
import type { PointerInfo, Surface } from '../render/Surface'
import {
  buildHierarchy, contrastText, drawTooltip, findNode, fitText, formatValue, hash01, HierarchyNode, HierarchyNodeData,
  Instances, LRect, NodeColoring, NodeColoringInput, nodeBaseColor, normalizeColoring, packColor, pxXform, squarify, TipRow, WHITE,
} from './common'
import { TILE_FS, TILE_VS } from './shaders'

export interface TreeMapChartOptions extends PanelOptions {
  surface?: Surface
  legend?: Partial<LegendOptions>
  [k: string]: unknown
}

/** A laid-out tile; coordinates are relative to the treemap area origin. */
interface Tile {
  key: string
  node: HierarchyNode | null
  name: string
  value: number
  x: number
  y: number
  w: number
  h: number
  color: Color
  alpha: number
  /** Container drawn with a header and its children inside. */
  parent: boolean
  depth: number
}

type Pending = { kind: 'data' } | { kind: 'down'; node: HierarchyNode } | { kind: 'up'; from: HierarchyNode }

const lerp = (a: number, b: number, t: number) => a + (b - a) * t
/** Map rect `r` from frame `src` into frame `dst`. */
const mapRect = (r: LRect, src: LRect, dst: LRect): LRect => {
  const kx = dst.w / (src.w || 1), ky = dst.h / (src.h || 1)
  return { x: dst.x + (r.x - src.x) * kx, y: dst.y + (r.y - src.y) * ky, w: r.w * kx, h: r.h * ky }
}

/**
 * Squarified treemap with drill-down.
 * Tiles are GPU instanced quads; labels, path buttons and tooltip are 2D overlay.
 */
export class TreeMapChart extends Panel {
  readonly legend: Legend
  private root: HierarchyNode | null = null
  private byKey = new Map<string, HierarchyNode>()
  private input: HierarchyNodeData | HierarchyNodeData[] | null = null
  private view: HierarchyNode | null = null
  private levels = 2
  private coloring: NodeColoring = {}
  private lutName = ''
  private effect = true
  private animEnabled = true
  private animDur = 650
  private initialText = 'All'
  private pathVisible = true
  private labelsVisible = true
  private valueFmt: (v: number, node: HierarchyNode | null) => string = (v) => formatValue(v)
  private labelFmt: ((node: HierarchyNode, value: number) => string) | null = null
  private gap = 2
  private stable = true
  private ranks = new Map<string, number>()
  private rankSeq = 0
  // layout + transition state
  private area: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private pathRect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  private lastSize = { w: -1, h: -1 }
  private pending: Pending | null = null
  private pairs: { a: Tile; b: Tile }[] = []
  private t = 1
  private tween: Tween | null = null
  private cur: Tile[] = []
  // interaction
  private pointer: { x: number; y: number } | null = null
  private hoverKey: string | null = null
  private crumbs: { node: HierarchyNode; rect: Rect; label: string }[] = []
  private hoverCrumb = -1
  private inst = new Instances(5)
  private hlInst = new Instances(5)

  constructor(o: TreeMapChartOptions = {}) {
    super(o)
    this.legend = new Legend(this, { position: 'bottom', ...o.legend })
  }

  // ---------------------------------------------------------------- data / config

  /** Set the hierarchy: a root node `{ name, value?, children? }` or an array of top-level nodes. Animates from the previous data. */
  setData(data: HierarchyNodeData | HierarchyNodeData[]) {
    this.input = data
    this.rebuild()
    return this
  }
  getData() { return this.input }
  /** Resolved root node. */
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

  /** Number of hierarchy levels shown at once below the current drill-down node (default 2). */
  setDisplayLevelCount(n: number) {
    this.levels = Math.max(1, Math.floor(n))
    this.pending = { kind: 'data' }
    this.requestRender()
    return this
  }
  getDisplayLevelCount() { return this.levels }
  /** Alias of `setDisplayLevelCount`. */
  setDisplayLevel(n: number) { return this.setDisplayLevelCount(n) }

  /**
   * Node coloring: `{ lut, lookUpProperty? }` colors by a numeric property through a LUT,
   * `{ palette }` colors per top-level branch, or a callback `(node) => Color`.
   */
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

  /** Text of the first path button (the root). */
  setInitialPathButtonText(text: string) { this.initialText = text; this.requestRender(); return this }
  setPathVisible(v: boolean) { this.pathVisible = v; this.lastSize = { w: -1, h: -1 }; this.requestRender(); return this }
  /** Subtle bevel/gradient shading on tiles. */
  setNodeEffect(enabled: boolean) { this.effect = enabled; this.requestRender(); return this }
  setLabelsVisible(v: boolean) { this.labelsVisible = v; this.requestRender(); return this }
  setValueFormatter(f: (value: number, node: HierarchyNode | null) => string) { this.valueFmt = f; this.requestRender(); return this }
  /** Second label line of leaf tiles (default: formatted value). `value` is the animated value. */
  setLabelFormatter(f: ((node: HierarchyNode, value: number) => string) | null) { this.labelFmt = f; this.requestRender(); return this }
  setAnimationsEnabled(v: boolean) { this.animEnabled = v; return this }
  setAnimationDuration(ms: number) { this.animDur = Math.max(0, ms); return this }
  /** Gap between tiles in px. */
  setNodeGap(px: number) { this.gap = Math.max(0, px); this.requestRender(); return this }
  /**
   * Keep each tile's placement order across `setData` updates (default true) so value
   * changes animate smoothly. When false, every update re-sorts by value (best aspect ratios).
   */
  setStableLayout(v: boolean) {
    this.stable = v
    this.ranks.clear()
    this.rankSeq = 0
    this.pending = { kind: 'data' }
    this.requestRender()
    return this
  }

  /** Drill down to a node (node object, its input data, or a name path). */
  setDrillDownNode(node: HierarchyNode | HierarchyNodeData | string[] | string | null) {
    const n = node === null ? this.root : findNode(this.root, this.byKey, node)
    if (n) this.drillTo(n.children.length ? n : n.parent ?? n)
    return this
  }
  getDrillDownNode() { return this.view }
  /** Go one level up. */
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

  private headerH() { return Math.round(this.theme.fontSize * 1.25 + 8) }

  private tileColor(n: HierarchyNode, parent: boolean): Color {
    const t = this.theme
    const base = nodeBaseColor(t, this.coloring, n)
    const lv = Math.max(0, n.depth - (this.view?.depth ?? 0) - 1)
    if (parent) return t.isDark ? base.scale(0.2 + 0.09 * lv) : base.mix(WHITE, 0.76 - 0.12 * lv)
    if (this.coloring.lut || this.coloring.color) return base
    const k = hash01(n.key)
    return t.isDark ? base.scale(0.4 + 0.32 * k + 0.05 * lv) : base.scale(0.78 + 0.22 * k).mix(WHITE, 0.1 + 0.08 * lv)
  }

  private computeTargets(): Map<string, Tile> {
    const out = new Map<string, Tile>()
    const W = this.area.w, H = this.area.h
    if (!this.view || W < 4 || H < 4) return out
    const headerH = this.headerH()
    const pad = 3
    const rank = (c: HierarchyNode) => this.ranks.get(c.key) ?? 0
    const rec = (node: HierarchyNode, r: LRect, level: number) => {
      let order: number[] | undefined
      if (this.stable) {
        for (const c of [...node.children].sort((p, q) => q.value - p.value)) if (!this.ranks.has(c.key)) this.ranks.set(c.key, this.rankSeq++)
        order = node.children.map((_, i) => i).sort((p, q) => rank(node.children[p]) - rank(node.children[q]))
      }
      const rects = squarify(node.children.map((c) => c.value), r, order)
      node.children.forEach((c, i) => {
        const cr = rects[i]
        if (cr.w < 0.5 || cr.h < 0.5) return
        const showKids = c.children.length > 0 && level < this.levels && cr.w > pad * 2 + 36 && cr.h > headerH + pad + 22
        out.set(c.key, { key: c.key, node: c, name: c.name, value: c.value, ...cr, color: this.tileColor(c, showKids), alpha: 1, parent: showKids, depth: c.depth })
        if (showKids) rec(c, { x: cr.x + pad, y: cr.y + headerH, w: cr.w - pad * 2, h: cr.h - headerH - pad }, level + 1)
      })
    }
    rec(this.view, { x: 0, y: 0, w: W, h: H }, 1)
    return out
  }

  private setStatic(tgt: Map<string, Tile>) {
    this.tween?.cancel()
    this.tween = null
    this.t = 1
    this.pairs = [...tgt.values()].map((b) => ({ a: b, b }))
  }

  private startTransition(tgt: Map<string, Tile>, p: Pending) {
    const old = new Map(this.cur.map((x) => [x.key, x]))
    const full: LRect = { x: 0, y: 0, w: this.area.w, h: this.area.h }
    let n2o: ((r: LRect) => LRect) | null = null
    let o2n: ((r: LRect) => LRect) | null = null
    if (p.kind === 'down') {
      let b: Tile | undefined
      for (let n: HierarchyNode | null = p.node; n && !b; n = n.parent) b = old.get(n.key)
      if (b) {
        const br = b
        n2o = (r) => mapRect(r, full, br)
        o2n = (r) => mapRect(r, br, full)
      }
    } else if (p.kind === 'up') {
      let a: Tile | undefined
      for (let n: HierarchyNode | null = p.from; n && !a; n = n.parent) a = tgt.get(n.key)
      if (a) {
        const ar = a
        o2n = (r) => mapRect(r, full, ar)
        n2o = (r) => mapRect(r, ar, full)
      }
    }
    const center = (r: LRect): LRect => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 })
    const pairs: { a: Tile; b: Tile }[] = []
    for (const [k, b] of tgt) {
      const a = old.get(k)
      pairs.push({ a: a ?? { ...b, ...(n2o ? n2o(b) : center(b)), alpha: 0 }, b })
    }
    for (const [k, a] of old) {
      if (tgt.has(k)) continue
      const node = this.byKey.get(k) ?? null
      pairs.push({ a: { ...a, node: node ?? a.node }, b: { ...a, ...(o2n ? o2n(a) : center(a)), alpha: 0 } })
    }
    pairs.sort((x, y) => x.b.depth - y.b.depth || (x.b.parent === y.b.parent ? 0 : x.b.parent ? -1 : 1))
    this.pairs = pairs
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
    const out: Tile[] = []
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
        x: lerp(a.x, b.x, t),
        y: lerp(a.y, b.y, t),
        w: lerp(a.w, b.w, t),
        h: lerp(a.h, b.h, t),
        color: a.color.mix(b.color, t),
        alpha,
        parent: t < 0.5 ? a.parent : b.parent,
        depth: b.depth,
      })
    }
    this.cur = out
  }

  override layout(_ctx: CanvasRenderingContext2D) {
    const content = this.layoutBase()
    let area = this.legend.layout(content)
    const fs = this.theme.fontSize
    if (this.pathVisible) {
      const ph = Math.round(fs * 1.75 + 8)
      this.pathRect = { x: area.x, y: area.y, w: area.w, h: ph }
      area = { x: area.x, y: area.y + ph, w: area.w, h: Math.max(0, area.h - ph) }
    } else this.pathRect = { x: area.x, y: area.y, w: 0, h: 0 }
    this.area = area
    const sizeChanged = area.w !== this.lastSize.w || area.h !== this.lastSize.h
    if (this.pending || sizeChanged) {
      const p = this.pending
      this.pending = null
      this.lastSize = { w: area.w, h: area.h }
      const tgt = this.computeTargets()
      if (p && !sizeChanged && this.animEnabled && this.animDur > 0 && this.cur.length) this.startTransition(tgt, p)
      else this.setStatic(tgt)
    }
    this.updateCurrent()
    if (this.hoverKey && !this.cur.some((c) => c.key === this.hoverKey)) this.hoverKey = null
  }

  // ---------------------------------------------------------------- drawing

  override drawBackground(ctx: CanvasRenderingContext2D) {
    super.drawBackground(ctx)
    const a = this.area
    const paint = fillToCanvas(ctx, this.theme.seriesBackgroundFill, a.x, a.y, a.w, a.h)
    if (paint && a.w > 0 && a.h > 0) {
      ctx.fillStyle = paint
      ctx.fillRect(a.x, a.y, a.w, a.h)
    }
  }

  override hasGL() { return this.cur.length > 0 }

  override drawGL(r: GLRenderer) {
    const A = this.area
    if (A.w <= 0 || A.h <= 0) return
    const gl = r.gl
    const prog = r.program('sferic-tile', TILE_VS, TILE_FS)
    const g = this.gap / 2
    const fill = (inst: Instances, list: Tile[], hl: boolean) => {
      inst.clear()
      for (const tl of list) {
        if (tl.w - 2 * g <= 0.2 || tl.h - 2 * g <= 0.2) continue
        const o = inst.add(packColor(tl.color, tl.alpha))
        const f = inst.f
        f[o] = A.x + tl.x + g
        f[o + 1] = A.y + tl.y + g
        f[o + 2] = A.x + tl.x + tl.w - g
        f[o + 3] = A.y + tl.y + tl.h - g
        f[o + 4] = hl || tl.key === this.hoverKey ? 1 : 0
      }
    }
    const draw = (inst: Instances, outline: boolean) => {
      if (!inst.n) return
      const [fb, cb] = inst.upload(gl)
      r.useXform(prog, pxXform(r))
      r.u1f(prog.u.u_radius, 2 * r.dpr)
      r.u1f(prog.u.u_effect, this.effect ? (this.theme.isDark ? 1 : 0.5) : 0)
      r.u1f(prog.u.u_borderW, 2 * r.dpr)
      r.u1f(prog.u.u_outline, outline ? 1 : 0)
      const hc = this.theme.examples.highlightColor.toFloat()
      r.u4f(prog.u.u_hlColor, hc[0], hc[1], hc[2], 0.95)
      r.useLUT(prog, 0, null)
      r.resetAttribs([ATTR.corner, ATTR.p0, ATTR.c0, ATTR.v0])
      r.attrib(ATTR.corner, r.cornerBuffer('quad'), 2, gl.FLOAT, false, 0, 0, 0)
      r.attrib(ATTR.p0, fb, 4, gl.FLOAT, false, 20, 0, 1)
      r.attrib(ATTR.v0, fb, 1, gl.FLOAT, false, 20, 16, 1)
      r.attrib(ATTR.c0, cb, 4, gl.UNSIGNED_BYTE, true, 4, 0, 1)
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, inst.n)
    }
    r.scissor(A)
    r.glow = 0
    fill(this.inst, this.cur, false)
    draw(this.inst, false)
    const hov = this.hoverKey ? this.cur.find((c) => c.key === this.hoverKey) : undefined
    if (hov) {
      r.glow = 1
      fill(this.hlInst, [hov], true)
      draw(this.hlInst, true)
    }
    r.glow = 0
    r.scissor(null)
  }

  override drawOverlay(ctx: CanvasRenderingContext2D) {
    const t = this.theme
    const A = this.area
    const fs = t.fontSize
    const g = this.gap / 2
    if (this.labelsVisible && A.w > 0 && A.h > 0) {
      ctx.save()
      ctx.beginPath()
      ctx.rect(A.x, A.y, A.w, A.h)
      ctx.clip()
      ctx.textBaseline = 'middle'
      ctx.textAlign = 'left'
      const fN = font(t, fs, 600), fV = font(t, fs - 1)
      const headerH = this.headerH()
      for (const tl of this.cur) {
        if (tl.alpha < 0.3) continue
        const x = A.x + tl.x + g, y = A.y + tl.y + g, w = tl.w - 2 * g, h = tl.h - 2 * g
        const pad = 6
        if (w < 22 || h < fs + 4) continue
        const tc = contrastText(tl.color)
        ctx.globalAlpha = Math.min(1, (tl.alpha - 0.3) / 0.5)
        const val = this.valueFmt(tl.value, tl.node)
        if (tl.parent) {
          const cy = y + (headerH - g) / 2
          const name = fitText(tl.name, w - pad * 2, fN)
          if (!name) continue
          ctx.font = fN
          ctx.fillStyle = tc.toCSS()
          ctx.fillText(name, x + pad, cy)
          const nw = textWidth(name, fN)
          if (name === tl.name && nw + textWidth(val, fV) + 12 < w - pad * 2) {
            ctx.font = fV
            ctx.fillStyle = tc.setA(170).toCSS()
            ctx.fillText(val, x + pad + nw + 8, cy)
          }
          continue
        }
        // Larger labels on big tiles.
        const k = Math.max(1, Math.min(1.9, Math.sqrt(Math.min(w, h * 1.6) / 110)))
        const lfs = Math.round(fs * k)
        const fN2 = k > 1 ? font(t, lfs, 600) : fN, fV2 = k > 1 ? font(t, lfs - 1) : fV
        const lp = pad * Math.sqrt(k)
        const name = fitText(tl.name, w - lp * 2, fN2)
        if (!name) continue
        ctx.font = fN2
        ctx.fillStyle = tc.toCSS()
        ctx.fillText(name, x + lp, y + lp + lfs / 2)
        if (h >= lfs * 2 + 14) {
          const line = this.labelFmt && tl.node ? this.labelFmt(tl.node, tl.value) : val
          const v = fitText(line, w - lp * 2, fV2)
          ctx.font = fV2
          ctx.fillStyle = tc.setA(190).toCSS()
          ctx.fillText(v, x + lp, y + lp + lfs * 1.6 + lfs / 2)
        }
      }
      ctx.restore()
    }
    if (!this.root) {
      ctx.font = font(t, fs)
      ctx.fillStyle = t.legend.disabledColor.toCSS()
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('No data', A.x + A.w / 2, A.y + A.h / 2)
    }
    this.drawPath(ctx)
    this.legend.draw(ctx)
    this.drawHoverTip(ctx)
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }

  private drawPath(ctx: CanvasRenderingContext2D) {
    this.crumbs = []
    const P = this.pathRect
    if (!this.pathVisible || !this.view || P.h <= 0) return
    const t = this.theme
    const fs = t.fontSize
    const fnt = font(t, fs), fB = font(t, fs, 600)
    const path = this.view.getPath()
    const items = path.map((n, i) => ({ node: n, label: i === 0 ? this.initialText : n.name }))
    const sep = '›'
    const sepW = textWidth(sep, fnt) + 8
    const widthOf = (list: typeof items) => list.reduce((s, it, i) => s + textWidth(it.label, i === list.length - 1 ? fB : fnt) + 18 + (i ? sepW : 0), 0)
    // Collapse the middle of long paths into an ellipsis button.
    while (items.length > 3 && widthOf(items) > P.w - 80) {
      items.splice(1, 1)
      items[1] = { ...items[1], label: items[1].label.startsWith('…') ? items[1].label : '… ' + items[1].label }
    }
    const h = Math.round(fs * 1.65)
    const y = P.y + (P.h - h) / 2 - 2
    let x = P.x
    ctx.save()
    ctx.textBaseline = 'middle'
    items.forEach((it, i) => {
      const last = i === items.length - 1
      if (i) {
        ctx.font = fnt
        ctx.fillStyle = t.legend.disabledColor.toCSS()
        ctx.textAlign = 'center'
        ctx.fillText(sep, x + sepW / 2 - 2, y + h / 2 + 1)
        x += sepW
      }
      const label = fitText(it.label, Math.max(40, P.x + P.w - x - 30), last ? fB : fnt)
      const w = textWidth(label, last ? fB : fnt) + 18
      const rect = { x, y, w, h }
      ctx.textAlign = 'left'
      if (!last) {
        const hov = this.hoverCrumb === this.crumbs.length
        roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4)
        ctx.fillStyle = (hov ? t.uiFill.mix(t.examples.highlightColor, 0.18) : t.uiFill).toCSS()
        ctx.fill()
        ctx.strokeStyle = (hov ? t.examples.highlightColor : t.uiStroke).toCSS()
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.font = fnt
        ctx.fillStyle = t.uiText.toCSS()
        ctx.fillText(label, x + 9, y + h / 2 + 1)
      } else {
        ctx.font = fB
        ctx.fillStyle = t.axisTitleColor.toCSS()
        ctx.fillText(label, x + 9, y + h / 2 + 1)
        const v = this.valueFmt(it.node.value, it.node)
        ctx.font = fnt
        ctx.fillStyle = t.legend.disabledColor.toCSS()
        if (x + w + textWidth(v, fnt) + 8 < P.x + P.w) ctx.fillText(v, x + w + 2, y + h / 2 + 1)
      }
      this.crumbs.push({ node: it.node, rect, label })
      x += w
    })
    ctx.restore()
  }

  private drawHoverTip(ctx: CanvasRenderingContext2D) {
    if (!this.pointer || !this.hoverKey || this.t < 1) return
    const tile = this.cur.find((c) => c.key === this.hoverKey)
    const n = tile?.node
    if (!tile || !n) return
    const t = this.theme
    const fB = font(t, t.fontSize, 600)
    const names = n.getPath().map((p, i) => (i === 0 ? this.initialText : p.name))
    const rows: TipRow[] = [{ text: fitText(names.join(' › '), 380, fB), bold: true, swatch: tile.color }]
    rows.push({ text: 'Value', value: this.valueFmt(n.value, n) })
    if (n.parent && n.parent.value > 0) {
      const pn = n.parent === this.root ? this.initialText : n.parent.name
      rows.push({ text: `Share of ${fitText(pn, 160, font(t))}`, value: `${((n.value / n.parent.value) * 100).toFixed(1)} %` })
    }
    const prop = this.coloring.lookUpProperty
    if (this.coloring.lut && prop && prop !== 'value' && Number.isFinite(n.colorValue)) {
      rows.push({ text: prop.charAt(0).toUpperCase() + prop.slice(1), value: formatValue(n.colorValue) })
    }
    if (!n.isLeaf()) rows.push({ text: 'Items', value: String(n.children.length) })
    drawTooltip(ctx, t, this.pointer.x, this.pointer.y, rows, this.rect)
  }

  // ---------------------------------------------------------------- interaction

  private tileAt(x: number, y: number): Tile | null {
    if (!rectContains(this.area, x, y)) return null
    const lx = x - this.area.x, ly = y - this.area.y
    for (let i = this.cur.length - 1; i >= 0; i--) {
      const c = this.cur[i]
      if (c.alpha > 0.5 && lx >= c.x && lx <= c.x + c.w && ly >= c.y && ly <= c.y + c.h) return c
    }
    return null
  }

  private drillTargetFor(tile: Tile): HierarchyNode | null {
    const n = tile.node
    if (!n || !this.view) return null
    if (tile.parent) return n
    let c: HierarchyNode = n
    while (c.parent && c.parent !== this.view) c = c.parent
    if (c.parent !== this.view) return null
    return c.children.length ? c : null
  }

  override onPointer(e: PointerInfo): boolean {
    if (this.handleUI(e)) return true
    const { x, y } = e
    switch (e.type) {
      case 'move': {
        this.pointer = { x, y }
        const ci = this.crumbs.findIndex((c, i) => i < this.crumbs.length - 1 && rectContains(c.rect, x, y))
        const tile = ci < 0 ? this.tileAt(x, y) : null
        const key = tile?.key ?? null
        this.hoverCrumb = ci
        this.hoverKey = key
        this.surface.setCursor(ci >= 0 || (tile && this.drillTargetFor(tile)) ? 'pointer' : 'default')
        return true
      }
      case 'leave':
        this.pointer = null
        this.hoverKey = null
        this.hoverCrumb = -1
        return true
      case 'down':
        if (e.button === 2) {
          this.drillUp()
          return true
        }
        return false
      case 'click': {
        if (e.button !== 0) return false
        const ci = this.crumbs.findIndex((c, i) => i < this.crumbs.length - 1 && rectContains(c.rect, x, y))
        if (ci >= 0) {
          this.drillTo(this.crumbs[ci].node)
          return true
        }
        const tile = this.tileAt(x, y)
        if (!tile?.node) return false
        this.emit('nodeclick', { node: tile.node, chart: this })
        const target = this.drillTargetFor(tile)
        if (target) this.drillTo(target)
        return true
      }
    }
    return false
  }

  override disposeGL(r: GLRenderer | null) {
    this.inst.dispose(r)
    this.hlInst.dispose(r)
  }

  /** Accepted for API compatibility; no-op. */
  setNodeBorderStyle(_s: unknown) { return this }
}
