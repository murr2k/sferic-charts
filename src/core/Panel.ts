import { Color } from './color'
import { Fill, fillToCanvas, LineStyle, applyLineToCanvas, Mutator, resolve, SolidFill } from './style'
import { Theme, Themes, font as themeFont } from './theme'
import { containerOf, Emitter, Rect, rectContains, roundRect, textWidth, Tween } from './util'
import { Drawable, PointerInfo, Surface } from '../render/Surface'
import { GLRenderer } from '../render/GLRenderer'
import type { GlowSettings } from './theme'

/** Font descriptor with immutable setters. */
export class FontSettings {
  constructor(
    readonly size: number = 13,
    readonly weight: string | number = 'normal',
    readonly family: string = '"Segoe UI", -apple-system, Arial, sans-serif',
    readonly style: string = 'normal',
  ) {}
  setSize(size: number) { return new FontSettings(size, this.weight, this.family, this.style) }
  setWeight(weight: string | number) { return new FontSettings(this.size, weight, this.family, this.style) }
  setFamily(family: string) { return new FontSettings(this.size, this.weight, family, this.style) }
  setStyle(style: string) { return new FontSettings(this.size, this.weight, this.family, style) }
  toCSS() { return `${this.style} ${this.weight} ${this.size}px ${this.family}` }
}

export interface Padding { left: number; right: number; top: number; bottom: number }
export const toPadding = (p: number | Partial<Padding>, base: Padding): Padding =>
  typeof p === 'number' ? { left: p, right: p, top: p, bottom: p } : { ...base, ...p }

export interface PanelOptions {
  theme?: Theme
  container?: HTMLElement | string
}

/** Text-box style UI element positioned in percentages of the panel (0..100). */
export class UITextBox {
  text = ''
  pos = { x: 50, y: 50 }
  origin = { x: 0, y: 0 } // -1..1 (left/center/right, bottom/center/top)
  fontSize: number
  textColor: Color
  bgFill: Fill | null = null
  stroke: LineStyle | null = null
  visible = true
  padding = 6
  mouseInteractions = true
  private listeners: ((e: PointerInfo) => void)[] = []
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  constructor(private panel: Panel, readonly kind: 'text' | 'button' | 'checkbox' = 'text') {
    const t = panel.getTheme()
    this.fontSize = t.fontSize
    this.textColor = t.uiText
    if (kind !== 'text') {
      this.bgFill = new SolidFill({ color: t.uiFill })
    }
  }
  checked = false
  setText(t: string) { this.text = t; this.panel.requestRender(); return this }
  getText() { return this.text }
  setPosition(p: { x: number; y: number }) { this.pos = { ...p }; this.panel.requestRender(); return this }
  setOrigin(o: { x: number; y: number }) { this.origin = { ...o }; this.panel.requestRender(); return this }
  setTextFillStyle(f: Fill | ((prev: SolidFill) => Fill)) {
    const nf = typeof f === 'function' ? f(new SolidFill({ color: this.textColor })) : f
    this.textColor = nf.getPrimaryColor()
    this.panel.requestRender()
    return this
  }
  setTextFont(f: Mutator<FontSettings>) {
    const nf = resolve(new FontSettings(this.fontSize), f)
    this.fontSize = nf.size
    this.panel.requestRender()
    return this
  }
  setBackground(f: (bg: { setFillStyle: (f: Fill) => any; setStrokeStyle: (l: LineStyle) => any }) => any) {
    const self = this
    const api = {
      setFillStyle(fill: Fill) { self.bgFill = fill; return api },
      setStrokeStyle(l: LineStyle) { self.stroke = l; return api },
    }
    f(api)
    this.panel.requestRender()
    return this
  }
  setVisible(v: boolean) { this.visible = v; this.panel.requestRender(); return this }
  setOn(v: boolean) { this.checked = v; this.panel.requestRender(); return this }
  getOn() { return this.checked }
  setPadding(p: number) { this.padding = p; return this }
  setMouseInteractions(v: boolean) { this.mouseInteractions = v; return this }
  addEventListener(type: 'click' | 'switch', fn: (e: any) => void) {
    this.listeners.push((e) => fn(type === 'switch' ? { state: this.checked } : e))
    return this
  }
  onSwitch(fn: (_: any, state: boolean) => void) {
    this.listeners.push(() => fn(this, this.checked))
    return this
  }
  onMouseClick(fn: (e: any) => void) { this.listeners.push(fn); return this }
  dispose() { this.panel.removeUI(this) }
  /** @internal */
  click(e: PointerInfo) {
    if (this.kind === 'checkbox') this.checked = !this.checked
    for (const l of this.listeners) l(e)
  }
  /** @internal */
  layoutAndDraw(ctx: CanvasRenderingContext2D, area: Rect) {
    if (!this.visible || !this.text && this.kind === 'text') return
    const t = this.panel.getTheme()
    const fnt = themeFont(t, this.fontSize)
    const lines = this.text.split('\n')
    const box = this.kind === 'checkbox' ? this.fontSize + 6 : 0
    const tw = Math.max(...lines.map((l) => textWidth(l, fnt))) + box
    const lh = this.fontSize * 1.3
    const w = tw + this.padding * 2
    const h = lines.length * lh + this.padding * 2 - (lh - this.fontSize) / 2
    const ax = area.x + (this.pos.x / 100) * area.w
    const ay = area.y + area.h - (this.pos.y / 100) * area.h
    const x = ax - ((this.origin.x + 1) / 2) * w
    const y = ay - ((1 - this.origin.y) / 2) * h
    this.rect = { x, y, w, h }
    if (this.bgFill && this.bgFill.type !== 'empty') {
      roundRect(ctx, x, y, w, h, 4)
      ctx.fillStyle = fillToCanvas(ctx, this.bgFill, x, y, w, h) ?? 'transparent'
      ctx.fill()
    }
    if (this.kind !== 'text' || this.stroke) {
      roundRect(ctx, x + 0.5, y + 0.5, w - 1, h - 1, 4)
      if (this.stroke ? applyLineToCanvas(ctx, this.stroke) : ((ctx.strokeStyle = t.uiStroke.toCSS()), (ctx.lineWidth = 1), true)) ctx.stroke()
    }
    if (this.kind === 'checkbox') {
      const bx = x + this.padding, by = y + h / 2 - this.fontSize / 2
      roundRect(ctx, bx, by, this.fontSize, this.fontSize, 3)
      ctx.strokeStyle = t.uiStroke.toCSS()
      ctx.stroke()
      if (this.checked) {
        roundRect(ctx, bx + 3, by + 3, this.fontSize - 6, this.fontSize - 6, 2)
        ctx.fillStyle = t.examples.highlightColor.toCSS()
        ctx.fill()
      }
    }
    ctx.font = fnt
    ctx.fillStyle = this.textColor.toCSS()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    lines.forEach((l, i) => ctx.fillText(l, x + this.padding + box, y + this.padding + lh * i + this.fontSize / 2 + 1))
  }
}

export const UIElementBuilders = {
  TextBox: 'text',
  ButtonBox: 'button',
  CheckBox: 'checkbox',
} as const
export const UIOrigins = {
  LeftTop: { x: -1, y: 1 }, CenterTop: { x: 0, y: 1 }, RightTop: { x: 1, y: 1 },
  LeftCenter: { x: -1, y: 0 }, Center: { x: 0, y: 0 }, RightCenter: { x: 1, y: 0 },
  LeftBottom: { x: -1, y: -1 }, CenterBottom: { x: 0, y: -1 }, RightBottom: { x: 1, y: -1 },
}

/**
 * Base for every chart. Owns title, background, padding and theme; participates
 * in a Surface either standalone or as a dashboard cell.
 */
export abstract class Panel extends Emitter implements Drawable {
  rect: Rect = { x: 0, y: 0, w: 0, h: 0 }
  z = 1
  readonly surface: Surface
  protected theme: Theme
  protected title = ''
  protected titleColor: Color
  protected titleFont: FontSettings
  protected padding: Padding = { left: 10, right: 10, top: 10, bottom: 10 }
  protected bgFill: Fill
  protected ownsSurface: boolean
  protected disposed = false
  protected tweens: Tween[] = []
  protected ui: UITextBox[] = []
  private uiPressed: UITextBox | null = null
  /** Content area after title and padding (computed by layoutBase). */
  protected content: Rect = { x: 0, y: 0, w: 0, h: 0 }

  constructor(opts: PanelOptions & { surface?: Surface }) {
    super()
    this.theme = opts.theme ?? Themes.storm
    this.titleColor = this.theme.titleColor
    this.titleFont = new FontSettings(this.theme.titleFontSize, 'normal', this.theme.fontFamily)
    this.bgFill = this.theme.chartBackgroundFill
    if (opts.surface) {
      this.surface = opts.surface
      this.ownsSurface = false
    } else {
      this.surface = new Surface(containerOf(opts.container))
      this.ownsSurface = true
    }
    this.surface.add(this)
  }

  getTheme(): Theme { return this.theme }
  requestRender() { this.surface.requestRender() }

  setTitle(t: string) { this.title = t; this.requestRender(); return this }
  getTitle() { return this.title }
  setTitleFillStyle(f: Fill | ((prev: SolidFill) => Fill)) {
    this.titleColor = (typeof f === 'function' ? f(new SolidFill({ color: this.titleColor })) : f).getPrimaryColor()
    this.requestRender()
    return this
  }
  setTitleFont(f: Mutator<FontSettings>) { this.titleFont = resolve(this.titleFont, f); this.requestRender(); return this }
  setTitlePosition(_p: string) { return this }
  setPadding(p: number | Partial<Padding>) { this.padding = toPadding(p, this.padding); this.requestRender(); return this }
  getPadding() { return this.padding }
  setBackgroundFillStyle(f: Mutator<Fill>) { this.bgFill = resolve(this.bgFill, f); this.requestRender(); return this }
  getBackgroundFillStyle() { return this.bgFill }
  setBackgroundStrokeStyle(_l: Mutator<LineStyle>) { return this }

  addUIElement(kind: 'text' | 'button' | 'checkbox' = 'text') {
    const el = new UITextBox(this, kind)
    this.ui.push(el)
    this.requestRender()
    return el
  }
  removeUI(el: UITextBox) { this.ui = this.ui.filter((u) => u !== el); this.requestRender() }

  /** Start a tween; it drives re-rendering until done. */
  protected animate(t: Tween) {
    this.tweens.push(t)
    this.requestRender()
    return t
  }

  /** Lay out title + padding, returning the content rect. */
  protected layoutBase(): Rect {
    // Standalone charts fill their surface; dashboard cells get rect from the Dashboard.
    if (this.ownsSurface) this.rect = { x: 0, y: 0, w: this.surface.cssW, h: this.surface.cssH }
    const r = this.rect
    const p = this.padding
    let top = r.y + p.top
    if (this.title) top += this.titleFont.size * 1.35 + 4
    this.content = { x: r.x + p.left, y: top, w: Math.max(0, r.w - p.left - p.right), h: Math.max(0, r.y + r.h - p.bottom - top) }
    return this.content
  }

  layout(_ctx: CanvasRenderingContext2D): void {
    this.layoutBase()
  }

  drawBackground(ctx: CanvasRenderingContext2D) {
    const r = this.rect
    const paint = fillToCanvas(ctx, this.bgFill, r.x, r.y, r.w, r.h)
    if (paint) {
      ctx.fillStyle = paint
      ctx.fillRect(r.x, r.y, r.w, r.h)
    }
  }

  protected drawTitle(ctx: CanvasRenderingContext2D) {
    if (!this.title) return
    ctx.font = this.titleFont.toCSS()
    ctx.fillStyle = this.titleColor.toCSS()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText(this.title, this.rect.x + this.rect.w / 2, this.rect.y + this.padding.top - 2, this.rect.w - 20)
  }

  hasGL(): boolean { return false }
  prepareGL(_r: GLRenderer): void {}
  drawGL(_r: GLRenderer): void {}
  drawOverlay(ctx: CanvasRenderingContext2D) {
    this.drawTitle(ctx)
    this.drawUI(ctx)
  }
  protected drawUI(ctx: CanvasRenderingContext2D) {
    for (const u of this.ui) u.layoutAndDraw(ctx, this.rect)
  }
  glow(): GlowSettings | null { return this.theme.glow }
  /** Override to return true when drawing non-antialiased triangles (3D meshes, filled polygons). */
  wantsMSAA(): boolean { return false }
  /** Override to return false when drawGL only uses GLRenderer helpers (enables state caching across panels). */
  usesRawGL(): boolean { return true }

  tick(now: number): boolean {
    if (!this.tweens.length) return false
    this.tweens = this.tweens.filter((t) => t.tick(now))
    return this.tweens.length > 0
  }

  /** UI element hit handling; subclasses call first. */
  protected handleUI(e: PointerInfo): boolean {
    const hit = this.ui.find((u) => u.visible && u.kind !== 'text' && u.mouseInteractions && rectContains(u.rect, e.x, e.y))
    if (e.type === 'down' && hit) {
      this.uiPressed = hit
      return true
    }
    if (e.type === 'up' && this.uiPressed) {
      const p = this.uiPressed
      this.uiPressed = null
      if (hit === p) p.click(e)
      return true
    }
    if (e.type === 'move' && hit) {
      this.surface.setCursor('pointer')
      return false
    }
    return false
  }

  onPointer(e: PointerInfo): boolean {
    return this.handleUI(e)
  }

  disposeGL(_r: GLRenderer | null): void {}

  dispose() {
    if (this.disposed) return
    this.disposed = true
    if (this.ownsSurface) this.surface.dispose()
    else this.surface.remove(this)
    this.emit('dispose', {})
  }
  isDisposed() { return this.disposed }

  /** Download a PNG of the surface. */
  saveToFile(name = 'chart', type = 'image/png') {
    this.surface.afterRender = () => {
      this.surface.afterRender = null
      this.surface.canvas.toBlob((b) => {
        if (!b) return
        const a = document.createElement('a')
        a.href = URL.createObjectURL(b)
        a.download = `${name}.${type.split('/')[1]}`
        a.click()
        setTimeout(() => URL.revokeObjectURL(a.href), 1000)
      }, type)
    }
    this.requestRender()
  }
}
