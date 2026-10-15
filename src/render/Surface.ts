import { GLRenderer, existingRenderer, getRenderer, releaseRenderer, setRendererLostHandler } from './GLRenderer'
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
  /** Text alternative for assistive technology (chart title by default). */
  accessibleLabel?(): string
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

/**
 * Diagnostics (no globals are touched; tools opt in by importing this).
 * syncGPU forces gl.finish() after each frame so timings include GPU work.
 */
export const debug = {
  stats: frameStats,
  syncGPU: false,
  /** Current shared GPU context state. */
  renderer: () => {
    const r = existingRenderer()
    return r ? { alive: true, ...r.memoryInfo() } : { alive: false }
  },
  /** Simulate a GPU context loss (testing). */
  loseContext: () => existingRenderer()?.simulateLoss(),
  /** Why WebGL2 could not be created, if it failed. */
  glError: () => glFailure?.message ?? null,
}

let rafId = 0
let glFailure: Error | null = null
let glRetryAt = 0
let warned = false
let releaseTimer = 0
/** Release the GPU context this long after the last chart is disposed. */
const IDLE_RELEASE_MS = 3000

function schedule() {
  if (!rafId) rafId = requestAnimationFrame(frame)
}

// A lost context is replaced on the next frame; every surface must redraw into it.
// Registered lazily (first surface) so importing the module has no side effects.
let lostHandlerSet = false
function ensureLostHandler() {
  if (lostHandlerSet) return
  lostHandlerSet = true
  setRendererLostHandler(() => {
    for (const s of surfaces) s.requestRender()
  })
}

/** The shared renderer, or null when WebGL2 is unavailable (retried every few seconds). */
function acquireRenderer(): GLRenderer | null {
  if (glFailure && performance.now() < glRetryAt) return null
  try {
    const r = getRenderer()
    glFailure = null
    return r
  } catch (err) {
    glFailure = err instanceof Error ? err : new Error(String(err))
    glRetryAt = performance.now() + 5000
    if (!warned) {
      console.warn('sferic: WebGL2 unavailable; GPU-rendered content is disabled.', glFailure.message)
      warned = true
    }
    return null
  }
}

function frame(now: number) {
  rafId = 0
  let r: GLRenderer | null = null
  let triedGL = false
  let maxW = 0, maxH = 0, msaa = false
  for (const s of surfaces) {
    if (!s.needsFrame()) continue
    if (!triedGL && s.needsGL()) {
      triedGL = true
      r = acquireRenderer()
    }
    try {
      const used = s.render(r, now)
      if (used) {
        maxW = Math.max(maxW, used.w)
        maxH = Math.max(maxH, used.h)
        msaa ||= used.msaa
      }
    } catch (err) {
      console.error('sferic: render failed', err)
      s.failed = true
    }
  }
  // Let the renderer shrink render targets that stay far larger than needed.
  if (r && maxW > 0) r.trim(maxW, maxH, msaa, now)
  for (const s of surfaces) if (s.needsFrame()) { schedule(); break }
}

/** Free the shared GPU context once no chart has existed for a while. */
function scheduleIdleRelease() {
  clearTimeout(releaseTimer)
  releaseTimer = window.setTimeout(() => {
    if (surfaces.size === 0) releaseRenderer()
  }, IDLE_RELEASE_MS)
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
    this.canvas.setAttribute('role', 'img')
    this.canvas.setAttribute('aria-label', 'Chart')
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
    ensureLostHandler()
    surfaces.add(this)
    clearTimeout(releaseTimer)
    this.requestRender()
  }

  private ariaLabel = 'Chart'

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

  /** Renders one frame; returns the GL target size used (device px), if any. */
  render(r: GLRenderer | null, now: number): { w: number; h: number; msaa: boolean } | null {
    const T0 = performance.now()
    let used: { w: number; h: number; msaa: boolean } | null = null
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
      const msaa = gls.some((d) => d.wantsMSAA?.() ?? false)
      used = { w: W, h: H, msaa }
      r.begin(W, H, dpr, msaa)
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
      if (debug.syncGPU) r.gl.finish()
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
    if (gls.length && !r) for (const d of gls) drawGLUnavailable(ctx, d.rect)
    const label = this.drawables.map((d) => d.accessibleLabel?.() ?? '').filter(Boolean).join('; ') || 'Chart'
    if (label !== this.ariaLabel) {
      this.ariaLabel = label
      this.canvas.setAttribute('aria-label', label)
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
    return used
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
    if (surfaces.size === 0) scheduleIdleRelease()
  }
}

/** Notice drawn over GPU-rendered panels when WebGL2 cannot be created. */
function drawGLUnavailable(ctx: CanvasRenderingContext2D, r: Rect) {
  if (r.w < 40 || r.h < 30) return
  const text = 'WebGL2 is unavailable: GPU-rendered content cannot be shown'
  ctx.save()
  ctx.font = '13px "Segoe UI", -apple-system, Arial, sans-serif'
  const w = Math.min(r.w - 16, ctx.measureText(text).width + 24)
  const x = r.x + (r.w - w) / 2, y = r.y + r.h / 2 - 16
  ctx.fillStyle = 'rgba(20,20,24,0.85)'
  ctx.fillRect(x, y, w, 32)
  ctx.strokeStyle = 'rgba(255,255,255,0.35)'
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, 31)
  ctx.fillStyle = '#f0f0f0'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, r.x + r.w / 2, y + 16, w - 12)
  ctx.restore()
}
