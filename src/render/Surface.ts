import { GLRenderer, existingRenderer, getRenderer } from './GLRenderer'
import { Rect, rectContains } from '../core/util'
import type { GlowSettings } from '../core/theme'

export interface PointerInfo {
  type: 'down' | 'move' | 'up' | 'leave' | 'wheel' | 'dblclick' | 'click'
  /** CSS px relative to the surface. */
  x: number
  y: number
  button: number
  buttons: number
  shiftKey: boolean
  ctrlKey: boolean
  altKey: boolean
  deltaY: number
  deltaX: number
  pointerId: number
  pointerType: string
  /** Active touch/pointer positions (for pinch). */
  pointers: Map<number, { x: number; y: number }>
  native: Event
}

/** Something drawn on a surface: a chart, a dashboard splitter layer, a UI overlay. */
export interface Drawable {
  rect: Rect
  /** Lower draws first; higher gets pointer events first. */
  z: number
  layout(ctx: CanvasRenderingContext2D): void
  drawBackground(ctx: CanvasRenderingContext2D): void
  hasGL(): boolean
  /** Optional: upload pending GPU data before any drawable draws (batches buffer updates). */
  prepareGL?(r: GLRenderer): void
  drawGL(r: GLRenderer): void
  drawOverlay(ctx: CanvasRenderingContext2D): void
  glow(): GlowSettings | null
  /** Request multisampled rendering (needed for un-antialiased triangles: 3D, filled polygons). */
  wantsMSAA?(): boolean
  /**
   * Whether drawGL may change GL state behind the renderer's back (raw gl.* calls).
   * Defaults to true; the renderer's state shadow is then invalidated around it.
   */
  usesRawGL?(): boolean
  /** Advance animations; return true to keep rendering. */
  tick(now: number): boolean
  /** Return true if the event was consumed. */
  onPointer(e: PointerInfo): boolean
  /** Whether this drawable wants pointer events at (x, y). Defaults to rect containment. */
  hitTest?(x: number, y: number): boolean
  disposeGL(r: GLRenderer | null): void
}

const surfaces = new Set<Surface>()

/** Per-phase timings of the last rendered frame (ms), for profiling. */
export const frameStats = { glPost: 0, layout: 0, background: 0, gl: 0, glFinish: 0, blit: 0, overlay: 0, total: 0, frames: 0 }
;(globalThis as any).__sfericStats = frameStats
let rafId = 0

function schedule() {
  if (!rafId) rafId = requestAnimationFrame(frame)
}

function frame(now: number) {
  rafId = 0
  let r: GLRenderer | null = null
  for (const s of surfaces) {
    if (!s.needsFrame()) continue
    if (!r && s.needsGL()) r = getRenderer()
    try {
      s.render(r, now)
    } catch (err) {
      console.error('sferic: render failed', err)
      s.failed = true
    }
  }
  for (const s of surfaces) if (s.needsFrame()) { schedule(); break }
}

/**
 * A visible canvas hosting one or more drawables.
 * Draw order per frame: backgrounds (2D) -> GL content (shared context, blitted) -> overlays (2D).
 */
export class Surface {
  readonly root: HTMLDivElement
  readonly canvas: HTMLCanvasElement
  readonly ctx: CanvasRenderingContext2D
  drawables: Drawable[] = []
  cssW = 0
  cssH = 0
  dpr = 1
  private dirty = true
  private animating = false
  visible = true
  failed = false
  private ro: ResizeObserver
  private io: IntersectionObserver
  private captured: Drawable | null = null
  private hover: Drawable | null = null
  private pointers = new Map<number, { x: number; y: number }>()
  private disposed = false
  /** Called after every render with the surface canvas (for "saveToFile" etc.). */
  afterRender: (() => void) | null = null

  constructor(readonly container: HTMLElement) {
    this.root = document.createElement('div')
    this.root.style.cssText = 'position:relative;width:100%;height:100%;overflow:hidden;touch-action:none;user-select:none;'
    this.canvas = document.createElement('canvas')
    this.canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;outline:none;'
    this.canvas.tabIndex = 0
    this.root.appendChild(this.canvas)
    container.appendChild(this.root)
    this.ctx = this.canvas.getContext('2d', { alpha: true })!
    this.ro = new ResizeObserver(() => this.requestRender())
    this.ro.observe(this.root)
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) this.visible = e.isIntersecting
      if (this.visible) this.requestRender()
    })
    this.io.observe(this.root)
    this.bindEvents()
    surfaces.add(this)
    this.requestRender()
  }

  add(d: Drawable) {
    this.drawables.push(d)
    this.drawables.sort((a, b) => a.z - b.z)
    this.requestRender()
  }
  remove(d: Drawable) {
    this.drawables = this.drawables.filter((x) => x !== d)
    d.disposeGL(existingRenderer())
    this.requestRender()
  }

  requestRender() {
    if (this.disposed) return
    this.dirty = true
    schedule()
  }
  needsFrame() { return !this.disposed && !this.failed && this.visible && (this.dirty || this.animating) }
  needsGL() { return this.drawables.some((d) => d.hasGL()) }

  render(r: GLRenderer | null, now: number) {
    const T0 = performance.now()
    this.dirty = false
    const dpr = window.devicePixelRatio || 1
    const w = Math.max(1, this.root.clientWidth)
    const h = Math.max(1, this.root.clientHeight)
    if (w !== this.cssW || h !== this.cssH || dpr !== this.dpr) {
      this.cssW = w
      this.cssH = h
      this.dpr = dpr
      this.canvas.width = Math.round(w * dpr)
      this.canvas.height = Math.round(h * dpr)
    }
    let anim = false
    for (const d of this.drawables) if (d.tick(now)) anim = true
    this.animating = anim
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    for (const d of this.drawables) {
      ctx.save()
      d.layout(ctx)
      ctx.restore()
    }
    const T1 = performance.now()
    for (const d of this.drawables) {
      ctx.save()
      d.drawBackground(ctx)
      ctx.restore()
    }
    const T2 = performance.now()
    let T3 = T2, T4 = T2
    const gls = this.drawables.filter((d) => d.hasGL())
    if (gls.length && r) {
      const W = this.canvas.width, H = this.canvas.height
      r.begin(W, H, dpr, gls.some((d) => d.wantsMSAA?.() ?? false))
      let glow: GlowSettings | null = null
      // All uploads first: interleaving bufferSubData with draws stalls ANGLE's command stream.
      for (const d of gls) d.prepareGL?.(r)
      for (const d of gls) {
        const raw = d.usesRawGL?.() ?? true
        if (raw) {
          r.invalidateCache()
          r.scissor(null)
        }
        d.drawGL(r)
        if (raw) r.invalidateCache()
        const g = d.glow()
        if (g?.enabled) glow = g
      }
      const Tm = performance.now()
      r.end(glow)
      T3 = performance.now()
      frameStats.glPost += (T3 - Tm - frameStats.glPost) * 0.1
      if ((globalThis as any).__sfericFinish) r.gl.finish()
      T4 = performance.now()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.drawImage(r.canvas, 0, 0, W, H, 0, 0, W, H)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    const T5 = performance.now()
    for (const d of this.drawables) {
      ctx.save()
      d.drawOverlay(ctx)
      ctx.restore()
    }
    const T6 = performance.now()
    const k = 0.1
    const fs = frameStats
    fs.layout += (T1 - T0 - fs.layout) * k
    fs.background += (T2 - T1 - fs.background) * k
    fs.gl += (T3 - T2 - fs.gl) * k
    fs.glFinish += (T4 - T3 - fs.glFinish) * k
    fs.blit += (T5 - T4 - fs.blit) * k
    fs.overlay += (T6 - T5 - fs.overlay) * k
    fs.total += (T6 - T0 - fs.total) * k
    fs.frames++
    this.afterRender?.()
  }

  // ---------------------------------------------------------------- events

  private info(type: PointerInfo['type'], e: PointerEvent | WheelEvent | MouseEvent): PointerInfo {
    const b = this.canvas.getBoundingClientRect()
    return {
      type,
      x: e.clientX - b.left,
      y: e.clientY - b.top,
      button: e.button,
      buttons: e.buttons,
      shiftKey: e.shiftKey,
      ctrlKey: e.ctrlKey || e.metaKey,
      altKey: e.altKey,
      deltaY: (e as WheelEvent).deltaY ?? 0,
      deltaX: (e as WheelEvent).deltaX ?? 0,
      pointerId: (e as PointerEvent).pointerId ?? 0,
      pointerType: (e as PointerEvent).pointerType ?? 'mouse',
      pointers: this.pointers,
      native: e,
    }
  }

  private target(x: number, y: number): Drawable | null {
    for (let i = this.drawables.length - 1; i >= 0; i--) {
      const d = this.drawables[i]
      if (d.hitTest ? d.hitTest(x, y) : rectContains(d.rect, x, y)) return d
    }
    return null
  }

  private dispatch(p: PointerInfo, d: Drawable | null) {
    if (d && d.onPointer(p)) this.requestRender()
  }

  private bindEvents() {
    const c = this.canvas
    c.addEventListener('contextmenu', (e) => e.preventDefault())
    c.addEventListener('pointerdown', (e) => {
      const p = this.info('down', e)
      this.pointers.set(e.pointerId, { x: p.x, y: p.y })
      const d = this.captured ?? this.target(p.x, p.y)
      this.captured = d
      try { c.setPointerCapture(e.pointerId) } catch { /* ignore */ }
      this.dispatch(p, d)
    })
    c.addEventListener('pointermove', (e) => {
      const p = this.info('move', e)
      if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: p.x, y: p.y })
      const d = this.captured ?? this.target(p.x, p.y)
      if (!this.captured && d !== this.hover) {
        if (this.hover) this.dispatch({ ...p, type: 'leave' }, this.hover)
        this.hover = d
      }
      this.dispatch(p, d)
    })
    const up = (e: PointerEvent) => {
      const p = this.info('up', e)
      this.pointers.delete(e.pointerId)
      const d = this.captured ?? this.target(p.x, p.y)
      this.dispatch(p, d)
      if (this.pointers.size === 0) this.captured = null
      try { c.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
    }
    c.addEventListener('pointerup', up)
    c.addEventListener('pointercancel', up)
    c.addEventListener('pointerleave', (e) => {
      if (this.captured) return
      const p = this.info('leave', e)
      if (this.hover) this.dispatch(p, this.hover)
      this.hover = null
    })
    c.addEventListener(
      'wheel',
      (e) => {
        const p = this.info('wheel', e)
        const d = this.target(p.x, p.y)
        if (d && d.onPointer(p)) {
          e.preventDefault()
          this.requestRender()
        }
      },
      { passive: false },
    )
    c.addEventListener('dblclick', (e) => {
      const p = this.info('dblclick', e)
      this.dispatch(p, this.target(p.x, p.y))
    })
    c.addEventListener('click', (e) => {
      const p = this.info('click', e)
      this.dispatch(p, this.target(p.x, p.y))
    })
  }

  setCursor(css: string) {
    if (this.canvas.style.cursor !== css) this.canvas.style.cursor = css
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    surfaces.delete(this)
    this.ro.disconnect()
    this.io.disconnect()
    const r = existingRenderer()
    for (const d of this.drawables) d.disposeGL(r)
    this.drawables = []
    this.root.remove()
  }
}
