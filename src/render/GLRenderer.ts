import { LUT, GradientStop, sampleStops, Fill, LinearGradientFill, PalettedFill, SolidFill } from '../core/style'
import { Color } from '../core/color'
import { GlowSettings } from '../core/theme'
import * as S from './shaders'

const { ATTR } = S

export interface Program {
  prog: WebGLProgram
  u: Record<string, WebGLUniformLocation | null>
  vs: string
  fs: string
}

/** Device-pixel mapping of chunk-relative data: px = toLog?(p + origin) * scale + bias. */
export interface Xform {
  scale: [number, number]
  bias: [number, number]
  origin: [number, number]
  logb: [number, number]
}

/** One axis mapping in CSS px: px = a0 + (f(v) - f(start)) * k where f is identity or log_base. */
export interface AxisMap {
  a0: number
  start: number
  k: number
  log: number
}

const logb = (v: number, b: number) => Math.log(v) / Math.log(b)

/** Build a chunk transform from two axis maps (CSS px) and a chunk origin, scaled to device px. */
export function makeXform(mx: AxisMap, my: AxisMap, ox: number, oy: number, dpr: number): Xform {
  const one = (m: AxisMap, o: number): [number, number] => {
    if (m.log > 0) return [m.k * dpr, (m.a0 - logb(m.start, m.log) * m.k) * dpr]
    return [m.k * dpr, (m.a0 + (o - m.start) * m.k) * dpr]
  }
  const [sx, bx] = one(mx, ox)
  const [sy, by] = one(my, oy)
  return { scale: [sx, sy], bias: [bx, by], origin: [ox, oy], logb: [mx.log, my.log] }
}

export interface Rect { x: number; y: number; w: number; h: number }
interface BlurTarget { fbo: WebGLFramebuffer; tex: WebGLTexture; w: number; h: number }

/** Fill setup shared by area/rect programs. */
export interface FillParams {
  color: Color
  fill?: Fill
  /** Plot rect (CSS px) for gradient fills. */
  rect?: Rect
}

/**
 * Shared WebGL2 context. Every surface renders into this context's framebuffer
 * region, then copies the result into its own visible 2D canvas.
 */
export class GLRenderer {
  readonly canvas: HTMLCanvasElement
  readonly gl: WebGL2RenderingContext
  private programs = new Map<string, Program>()
  private vao: WebGLVertexArrayObject
  private enabled = new Set<number>()
  // State shadows. Valid only within one drawable's drawGL: Surface calls
  // invalidateCache() between drawables because some modules issue raw GL calls.
  private ucache = new Map<WebGLUniformLocation, number[]>()
  private generic = new Map<number, number>()
  private divisors = new Map<number, number>()
  private pointers = new Map<number, { buf: WebGLBuffer; size: number; type: number; norm: boolean; stride: number; offset: number }>()
  private scissorKey: string | null = null
  private cornerQuad: WebGLBuffer      // (0,0),(1,0),(0,1),(1,1)
  private cornerLine: WebGLBuffer      // (0,-1),(0,1),(1,-1),(1,1)
  private cornerPoint: WebGLBuffer     // (-1,-1),(1,-1),(-1,1),(1,1)
  private lutTex = new Map<number, { tex: WebGLTexture; lut: LUT }>()
  private gradTex = new Map<string, WebGLTexture>()
  private whiteTex: WebGLTexture
  // framebuffers
  private W = 0
  private H = 0
  readonly samples: number
  private msFbo: WebGLFramebuffer | null = null
  private msRb: WebGLRenderbuffer[] = []
  private msDepthRb: WebGLRenderbuffer | null = null
  private directFbo: WebGLFramebuffer | null = null
  /** Whether the current frame renders into the MSAA target. */
  private usingMs = false
  private sceneFbo!: WebGLFramebuffer
  private sceneTex!: WebGLTexture
  private glowFbo!: WebGLFramebuffer
  private glowTex!: WebGLTexture
  private depthRb: WebGLRenderbuffer | null = null
  private blur: BlurTarget[] = []
  /** Current surface size in device px. */
  w = 0
  h = 0
  dpr = 1
  /** Current glow multiplier for subsequent draws (0..1). */
  glow = 0
  readonly maxTextureSize: number
  lost = false

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 16
    this.canvas.height = 16
    const gl = this.canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    })
    if (!gl) throw new Error('sferic: WebGL2 is not available')
    this.gl = gl
    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      this.lost = true
      // A replacement context is created on the next frame; holders of GPU handles
      // notice the new context object and re-upload from their CPU copies.
      if (!this.releasing) lostHandler?.()
    })
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE)
    this.samples = Math.min(4, gl.getParameter(gl.MAX_SAMPLES) || 0)
    gl.getExtension('EXT_color_buffer_float')
    this.vao = gl.createVertexArray()!
    gl.bindVertexArray(this.vao)
    this.cornerQuad = this.staticBuffer([0, 0, 1, 0, 0, 1, 1, 1])
    this.cornerLine = this.staticBuffer([0, -1, 0, 1, 1, -1, 1, 1])
    this.cornerPoint = this.staticBuffer([-1, -1, 1, -1, -1, 1, 1, 1])
    this.whiteTex = this.makeTex1D(new Uint8Array(1024 * 4).fill(255))
  }

  // ---------------------------------------------------------------- resources

  staticBuffer(data: number[] | Float32Array): WebGLBuffer {
    const gl = this.gl
    const b = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, b)
    gl.bufferData(gl.ARRAY_BUFFER, data instanceof Float32Array ? data : new Float32Array(data), gl.STATIC_DRAW)
    return b
  }

  program(name: string, vs: string, fs: string): Program {
    let p = this.programs.get(name)
    // Same-name program with different source (hot reload of edited shaders): recompile.
    if (p && p.vs === vs && p.fs === fs) return p
    if (p) {
      this.gl.deleteProgram(p.prog)
      this.programs.delete(name)
    }
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s)
        const numbered = src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n')
        throw new Error(`sferic: shader ${name} failed to compile:\n${log}\n${numbered}`)
      }
      return s
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error(`sferic: program ${name} failed to link: ${gl.getProgramInfoLog(prog)}`)
    }
    const u: Record<string, WebGLUniformLocation | null> = {}
    const n = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS)
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(prog, i)!
      const key = info.name.replace(/\[0\]$/, '')
      u[key] = gl.getUniformLocation(prog, info.name)
    }
    p = { prog, u, vs, fs }
    this.programs.set(name, p)
    return p
  }

  private makeTex1D(rgba: Uint8Array): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rgba.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }

  /** 1024-texel RGBA texture of a LUT over [lut.min, lut.max]. */
  lutTexture(lut: LUT): WebGLTexture {
    const hit = this.lutTex.get(lut.id)
    if (hit) return hit.tex
    const tex = this.makeTex1D(lut.bake(1024))
    if (!lut.interpolate) {
      const gl = this.gl
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    }
    this.lutTex.set(lut.id, { tex, lut })
    if (this.lutTex.size > 256) {
      const [k, v] = this.lutTex.entries().next().value!
      this.gl.deleteTexture(v.tex)
      this.lutTex.delete(k)
    }
    return tex
  }

  gradientTexture(stops: GradientStop[]): WebGLTexture {
    const key = stops.map((s) => `${s.offset}:${s.color.toHex()}`).join('|')
    let t = this.gradTex.get(key)
    if (t) return t
    const data = new Uint8Array(1024 * 4)
    for (let i = 0; i < 1024; i++) {
      const c = sampleStops(stops, i / 1023)
      data.set([c.r, c.g, c.b, c.a], i * 4)
    }
    t = this.makeTex1D(data)
    this.gradTex.set(key, t)
    return t
  }

  /** Forget shadowed GL state (call when foreign code may have changed it). */
  invalidateCache() {
    this.ucache.clear()
    this.generic.clear()
    this.divisors.clear()
    this.pointers.clear()
    this.scissorKey = null
  }

  // Cached uniform setters: skip the GL call when the value is unchanged.
  private same(loc: WebGLUniformLocation, v: number[]): boolean {
    const c = this.ucache.get(loc)
    if (c && c.length === v.length) {
      let eq = true
      for (let i = 0; i < v.length; i++) if (c[i] !== v[i]) { eq = false; break }
      if (eq) return true
    }
    this.ucache.set(loc, v)
    return false
  }
  u1f(loc: WebGLUniformLocation | null | undefined, a: number) { if (loc && !this.same(loc, [a])) this.gl.uniform1f(loc, a) }
  u1i(loc: WebGLUniformLocation | null | undefined, a: number) { if (loc && !this.same(loc, [a])) this.gl.uniform1i(loc, a) }
  u2f(loc: WebGLUniformLocation | null | undefined, a: number, b: number) { if (loc && !this.same(loc, [a, b])) this.gl.uniform2f(loc, a, b) }
  u3f(loc: WebGLUniformLocation | null | undefined, a: number, b: number, c: number) { if (loc && !this.same(loc, [a, b, c])) this.gl.uniform3f(loc, a, b, c) }
  u2i(loc: WebGLUniformLocation | null | undefined, a: number, b: number) { if (loc && !this.same(loc, [a, b])) this.gl.uniform2i(loc, a, b) }
  u4f(loc: WebGLUniformLocation | null | undefined, a: number, b: number, c: number, d: number) {
    if (loc && !this.same(loc, [a, b, c, d])) this.gl.uniform4f(loc, a, b, c, d)
  }

  // ---------------------------------------------------------------- attributes

  attrib(loc: number, buf: WebGLBuffer, size: number, type: number, normalized: boolean, stride: number, offset: number, divisor: number) {
    const gl = this.gl
    if (!this.enabled.has(loc)) {
      gl.enableVertexAttribArray(loc)
      this.enabled.add(loc)
    }
    // vertexAttribPointer is costly in Chrome; skip when the binding is unchanged.
    const pp = this.pointers.get(loc)
    if (!pp || pp.buf !== buf || pp.offset !== offset || pp.stride !== stride || pp.size !== size || pp.type !== type || pp.norm !== normalized) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf)
      gl.vertexAttribPointer(loc, size, type, normalized, stride, offset)
      this.pointers.set(loc, { buf, size, type, norm: normalized, stride, offset })
    }
    if (this.divisors.get(loc) !== divisor) {
      gl.vertexAttribDivisor(loc, divisor)
      this.divisors.set(loc, divisor)
    }
  }

  /** Generic (constant) attribute value, cached. */
  private gen1(loc: number, v: number) {
    if (this.generic.get(loc) === v) return
    this.generic.set(loc, v)
    this.gl.vertexAttrib1f(loc, v)
  }
  private gen4white(loc: number) {
    if (this.generic.get(loc) === 1) return
    this.generic.set(loc, 1)
    this.gl.vertexAttrib4f(loc, 1, 1, 1, 1)
  }
  /** Set a generic float attribute (e.g. area baseline) through the cache. */
  generic1f(loc: number, v: number) { this.gen1(loc, v) }

  /** Disable all arrays except `keep`, setting generic constant values for the rest. */
  resetAttribs(keep: number[]) {
    const gl = this.gl
    for (const loc of [...this.enabled]) {
      if (!keep.includes(loc)) {
        gl.disableVertexAttribArray(loc)
        this.enabled.delete(loc)
        this.pointers.delete(loc)
      }
    }
    // Generic defaults: colors white, values 0, size 0, rotation 0.
    if (!keep.includes(ATTR.c0)) this.gen4white(ATTR.c0)
    if (!keep.includes(ATTR.c1)) this.gen4white(ATTR.c1)
    if (!keep.includes(ATTR.v0)) this.gen1(ATTR.v0, 0)
    if (!keep.includes(ATTR.v1)) this.gen1(ATTR.v1, 0)
    if (!keep.includes(ATTR.d0)) this.gen1(ATTR.d0, 0)
    if (!keep.includes(ATTR.size)) this.gen1(ATTR.size, 0)
    if (!keep.includes(ATTR.rot)) this.gen1(ATTR.rot, 0)
  }

  cornerBuffer(kind: 'quad' | 'line' | 'point'): WebGLBuffer {
    return kind === 'quad' ? this.cornerQuad : kind === 'line' ? this.cornerLine : this.cornerPoint
  }

  // ---------------------------------------------------------------- uniforms

  useXform(p: Program, x: Xform) {
    this.gl.useProgram(p.prog)
    this.u2f(p.u.u_res, this.w, this.h)
    this.u2f(p.u.u_scale, x.scale[0], x.scale[1])
    this.u2f(p.u.u_bias, x.bias[0], x.bias[1])
    this.u2f(p.u.u_origin, x.origin[0], x.origin[1])
    this.u2f(p.u.u_logb, x.logb[0], x.logb[1])
    this.u1f(p.u.u_glow, this.glow)
  }

  /** Bind a LUT for per-point coloring (mode 1 x, 2 y, 3 value; 0 disables). */
  useLUT(p: Program, mode: number, lut: LUT | null, range?: [number, number]) {
    const gl = this.gl
    this.u1i(p.u.u_lutMode, lut ? mode : 0)
    if (!lut) return // mode 0 never samples the LUT
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture(lut))
    this.u1i(p.u.u_lut, 0)
    const r = range ?? [lut.min, lut.max]
    this.u2f(p.u.u_lutRange, r[0], r[1])
  }

  /** Fill uniforms for area / rect programs. */
  useFill(p: Program, f: FillParams) {
    const gl = this.gl
    const fill = f.fill
    let mode = 0
    let color = f.color
    gl.activeTexture(gl.TEXTURE1)
    if (fill instanceof PalettedFill) {
      mode = 1
      gl.bindTexture(gl.TEXTURE_2D, this.lutTexture(fill.lut))
      gl.uniform2f(p.u.u_ftexRange, fill.lut.min, fill.lut.max)
      color = new Color(255, 255, 255, 255)
    } else if (fill instanceof LinearGradientFill && f.rect) {
      mode = 2
      gl.bindTexture(gl.TEXTURE_2D, this.gradientTexture(fill.stops))
      const r = f.rect
      const a = (fill.angle * Math.PI) / 180
      const dx = Math.cos(a), dy = -Math.sin(a)
      const half = (Math.abs(dx) * r.w + Math.abs(dy) * r.h) / 2
      const cx = r.x + r.w / 2, cy = r.y + r.h / 2
      const ox = (cx - dx * half) * this.dpr, oy = (cy - dy * half) * this.dpr
      const len = 2 * half * this.dpr || 1
      gl.uniform4f(p.u.u_grad, ox, oy, dx / len, dy / len)
      color = new Color(255, 255, 255, 255)
    } else {
      gl.bindTexture(gl.TEXTURE_2D, this.whiteTex)
      if (fill instanceof SolidFill) color = fill.color
    }
    this.u1i(p.u.u_ftex, 1)
    this.u1i(p.u.u_fillMode, mode)
    const c = color.toFloat()
    this.u4f(p.u.u_color, c[0], c[1], c[2], c[3])
  }

  // ---------------------------------------------------------------- frame

  private makeTex(tw: number, th: number): WebGLTexture {
    const gl = this.gl
    const t = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, t)
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, tw, th)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    return t
  }
  private fboFor(t: WebGLTexture): WebGLFramebuffer {
    const gl = this.gl
    const f = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, f)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
    return f
  }

  /**
   * Render targets: a direct FBO (scene + glow textures, depth) used by default,
   * plus a lazily allocated MSAA FBO for surfaces that request it (3D, filled polygons).
   */
  private ensureTargets(w: number, h: number, msaa: boolean) {
    const gl = this.gl
    if (!(w <= this.W && h <= this.H && this.directFbo)) {
      const W = Math.max(w, this.W, 256)
      const H = Math.max(h, this.H, 256)
      this.disposeTargets()
      this.W = W
      this.H = H
      this.canvas.width = W
      this.canvas.height = H
      this.sceneTex = this.makeTex(W, H)
      this.glowTex = this.makeTex(W, H)
      this.directFbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.directFbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sceneTex, 0)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.glowTex, 0)
      this.depthRb = gl.createRenderbuffer()!
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthRb)
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, W, H)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthRb)
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
      this.sceneFbo = this.fboFor(this.sceneTex)
      this.glowFbo = this.fboFor(this.glowTex)
      // Blur pyramid: [half A, half B, quarter A, quarter B]
      for (const div of [2, 2, 4, 4]) {
        const bw = Math.ceil(W / div), bh = Math.ceil(H / div)
        const t = this.makeTex(bw, bh)
        this.blur.push({ fbo: this.fboFor(t), tex: t, w: bw, h: bh })
      }
    }
    if (msaa && this.samples > 0 && !this.msFbo) {
      const W = this.W, H = this.H
      this.msFbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.msFbo)
      for (let i = 0; i < 2; i++) {
        const rb = gl.createRenderbuffer()!
        gl.bindRenderbuffer(gl.RENDERBUFFER, rb)
        gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.RGBA8, W, H)
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.RENDERBUFFER, rb)
        this.msRb.push(rb)
      }
      this.msDepthRb = gl.createRenderbuffer()!
      gl.bindRenderbuffer(gl.RENDERBUFFER, this.msDepthRb)
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, gl.DEPTH_COMPONENT24, W, H)
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.msDepthRb)
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
  }

  private disposeMsaa() {
    const gl = this.gl
    for (const rb of this.msRb) gl.deleteRenderbuffer(rb)
    this.msRb = []
    if (this.msDepthRb) gl.deleteRenderbuffer(this.msDepthRb)
    if (this.msFbo) gl.deleteFramebuffer(this.msFbo)
    this.msDepthRb = null
    this.msFbo = null
  }

  private disposeTargets() {
    const gl = this.gl
    this.disposeMsaa()
    if (!this.directFbo) return
    if (this.depthRb) gl.deleteRenderbuffer(this.depthRb)
    gl.deleteFramebuffer(this.directFbo)
    gl.deleteFramebuffer(this.sceneFbo)
    gl.deleteFramebuffer(this.glowFbo)
    gl.deleteTexture(this.sceneTex)
    gl.deleteTexture(this.glowTex)
    for (const b of this.blur) {
      gl.deleteFramebuffer(b.fbo)
      gl.deleteTexture(b.tex)
    }
    this.blur = []
    this.directFbo = null
  }

  // ---------------------------------------------------------------- memory management

  private releasing = false
  private oversizeSince = 0
  private msaaIdleSince = 0

  /**
   * Called once per frame with the largest surface rendered. Render targets that stay
   * far larger than needed for 5 s are reallocated, and MSAA buffers unused for 10 s
   * are freed, so a briefly fullscreen chart does not pin GPU memory forever.
   */
  trim(w: number, h: number, msaa: boolean, now: number) {
    const oversize = this.W * this.H > 2 * w * h && (this.W > w * 1.25 || this.H > h * 1.25)
    if (!oversize) this.oversizeSince = 0
    else if (!this.oversizeSince) this.oversizeSince = now
    else if (now - this.oversizeSince > 5000) {
      this.disposeTargets()
      this.W = this.H = 0
      this.oversizeSince = 0
    }
    if (msaa || !this.msFbo) this.msaaIdleSince = 0
    else if (!this.msaaIdleSince) this.msaaIdleSince = now
    else if (now - this.msaaIdleSince > 10_000) {
      this.disposeMsaa()
      this.msaaIdleSince = 0
    }
  }

  /** Approximate GPU memory held by render targets. */
  memoryInfo() {
    const px = this.W * this.H
    const msaaBytes = this.msFbo ? px * 4 * this.samples * 3 : 0
    const bytes = px * 4 * 4 + px * 4 * (2 / 4 + 2 / 16) + msaaBytes
    return { targetW: this.W, targetH: this.H, msaa: !!this.msFbo, approxMB: Math.round(bytes / 1048576) }
  }

  /** Testing aid: force a context loss through WEBGL_lose_context. */
  simulateLoss() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext()
  }

  /** Free every GPU resource and the context itself. The renderer is unusable afterwards. */
  release() {
    const gl = this.gl
    this.releasing = true
    if (!gl.isContextLost()) {
      this.disposeTargets()
      for (const p of this.programs.values()) gl.deleteProgram(p.prog)
      for (const v of this.lutTex.values()) gl.deleteTexture(v.tex)
      for (const t of this.gradTex.values()) gl.deleteTexture(t)
      gl.deleteTexture(this.whiteTex)
      gl.deleteBuffer(this.cornerQuad)
      gl.deleteBuffer(this.cornerLine)
      gl.deleteBuffer(this.cornerPoint)
      gl.deleteVertexArray(this.vao)
    }
    this.programs.clear()
    this.lutTex.clear()
    this.gradTex.clear()
    this.lost = true
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    this.canvas.width = this.canvas.height = 1
  }

  /** Start rendering a surface of w x h device pixels. */
  begin(w: number, h: number, dpr: number, msaa = false) {
    const gl = this.gl
    this.w = Math.max(1, w | 0)
    this.h = Math.max(1, h | 0)
    this.dpr = dpr
    this.ensureTargets(this.w, this.h, msaa)
    this.usingMs = msaa && !!this.msFbo
    gl.bindVertexArray(this.vao)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.usingMs ? this.msFbo : this.directFbo)
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1])
    gl.disable(gl.SCISSOR_TEST)
    gl.viewport(0, 0, this.w, this.h)
    gl.clearColor(0, 0, 0, 0)
    gl.clearDepth(1)
    gl.depthMask(true)
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT)
    gl.enable(gl.BLEND)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.CULL_FACE)
    this.glow = 0
    this.invalidateCache()
    this.scissorKey = 'off'
    this.parkTextures()
  }

  /**
   * Bind a harmless texture to the low units. Samplers that a shader declares but
   * does not use (e.g. u_lut with lutMode 0) still default to unit 0, and WebGL rejects
   * the draw as a feedback loop if that unit holds the current render target.
   */
  private parkTextures() {
    const gl = this.gl
    for (let u = 0; u < 4; u++) {
      gl.activeTexture(gl.TEXTURE0 + u)
      gl.bindTexture(gl.TEXTURE_2D, this.whiteTex)
    }
    gl.activeTexture(gl.TEXTURE0)
  }

  /** Restrict drawing to a rect in CSS px (surface coordinates, y down). */
  scissor(r: Rect | null) {
    const gl = this.gl
    if (!r) {
      if (this.scissorKey !== 'off') gl.disable(gl.SCISSOR_TEST)
      this.scissorKey = 'off'
      return
    }
    const d = this.dpr
    const x0 = Math.max(0, Math.floor(r.x * d))
    const y0 = Math.max(0, Math.floor(r.y * d))
    const x1 = Math.min(this.w, Math.ceil((r.x + r.w) * d))
    const y1 = Math.min(this.h, Math.ceil((r.y + r.h) * d))
    const key = `${x0},${y1},${x1},${y0}`
    if (key === this.scissorKey) return
    if (this.scissorKey === null || this.scissorKey === 'off') gl.enable(gl.SCISSOR_TEST)
    gl.scissor(x0, this.h - y1, Math.max(0, x1 - x0), Math.max(0, y1 - y0))
    this.scissorKey = key
  }

  /** Resolve, apply glow, and composite the surface into the top-left of the GL canvas. */
  end(glow: GlowSettings | null): void {
    const gl = this.gl
    const w = this.w, h = this.h, W = this.W, H = this.H
    this.invalidateCache()
    gl.disable(gl.SCISSOR_TEST)
    gl.disable(gl.DEPTH_TEST)
    gl.disable(gl.BLEND)
    this.resetAttribs([])
    if (this.usingMs) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.msFbo)
      gl.readBuffer(gl.COLOR_ATTACHMENT0)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.sceneFbo)
      gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      if (glow?.enabled) {
        gl.readBuffer(gl.COLOR_ATTACHMENT1)
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.glowFbo)
        gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST)
      }
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null)
    }
    const quad = this.program('fsquad-down', S.FS_QUAD_VS, S.DOWN_FS)
    const blurP = this.program('fsquad-blur', S.FS_QUAD_VS, S.BLUR_FS)
    const comp = this.program('fsquad-comp', S.FS_QUAD_VS, S.COMPOSITE_FS)
    this.attrib(ATTR.corner, this.cornerQuad, 2, gl.FLOAT, false, 0, 0, 0)
    const doGlow = !!glow?.enabled && glow.intensity > 0
    if (doGlow) {
      const pass = (p: Program, src: WebGLTexture, dst: BlurTarget, uvScale: [number, number], set: () => void) => {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo)
        const vw = Math.ceil(w * (dst.w / W)), vh = Math.ceil(h * (dst.h / H))
        gl.viewport(0, 0, vw, vh)
        gl.useProgram(p.prog)
        gl.uniform2f(p.u.u_uvScale, uvScale[0], uvScale[1])
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, src)
        gl.uniform1i(p.u.u_tex, 0)
        set()
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
      }
      for (const b of this.blur) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, b.fbo)
        gl.viewport(0, 0, b.w, b.h)
        gl.clearColor(0, 0, 0, 0)
        gl.clear(gl.COLOR_BUFFER_BIT)
      }
      const [hA, hB, qA, qB] = this.blur
      const spread = Math.max(0.5, (glow!.radius * this.dpr) / 8)
      const uvFull: [number, number] = [w / W, h / H]
      const uvH: [number, number] = [Math.ceil(w * (hA.w / W)) / hA.w, Math.ceil(h * (hA.h / H)) / hA.h]
      const uvQ: [number, number] = [Math.ceil(w * (qA.w / W)) / qA.w, Math.ceil(h * (qA.h / H)) / qA.h]
      pass(quad, this.glowTex, hA, uvFull, () => gl.uniform2f(quad.u.u_texel, 1 / W, 1 / H))
      pass(blurP, hA.tex, hB, uvH, () => gl.uniform2f(blurP.u.u_dir, spread / hA.w, 0))
      pass(blurP, hB.tex, hA, uvH, () => gl.uniform2f(blurP.u.u_dir, 0, spread / hA.h))
      pass(quad, hA.tex, qA, uvH, () => gl.uniform2f(quad.u.u_texel, 1 / hA.w, 1 / hA.h))
      pass(blurP, qA.tex, qB, uvQ, () => gl.uniform2f(blurP.u.u_dir, (spread * 1.5) / qA.w, 0))
      pass(blurP, qB.tex, qA, uvQ, () => gl.uniform2f(blurP.u.u_dir, 0, (spread * 1.5) / qA.h))
    }
    // Composite into the default framebuffer, top-left region.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, H - h, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.enable(gl.SCISSOR_TEST)
    gl.scissor(0, H - h, w, h)
    gl.clear(gl.COLOR_BUFFER_BIT)
    gl.disable(gl.SCISSOR_TEST)
    gl.useProgram(comp.prog)
    gl.uniform2f(comp.u.u_uvScale, w / W, h / H)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.sceneTex)
    gl.uniform1i(comp.u.u_scene, 0)
    if (doGlow) {
      const [hA, , qA] = this.blur
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, hA.tex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, qA.tex)
      gl.uniform1i(comp.u.u_glow1, 1)
      gl.uniform1i(comp.u.u_glow2, 2)
      gl.uniform2f(comp.u.u_glowUv, W / hA.w / 2, H / hA.h / 2)
      gl.uniform2f(comp.u.u_glowUv2, W / qA.w / 4, H / qA.h / 4)
      gl.uniform1f(comp.u.u_intensity, glow!.intensity)
    } else {
      gl.uniform1f(comp.u.u_intensity, 0)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.whiteTex)
      gl.activeTexture(gl.TEXTURE2)
      gl.bindTexture(gl.TEXTURE_2D, this.whiteTex)
      gl.uniform1i(comp.u.u_glow1, 1)
      gl.uniform1i(comp.u.u_glow2, 2)
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.enable(gl.BLEND)
    this.parkTextures()
  }

  /** Canvas pixel rect containing the last composited surface (for drawImage). */
  sourceRect(): [number, number, number, number] {
    return [0, 0, this.w, this.h]
  }
}

let shared: GLRenderer | null = null
let lostHandler: (() => void) | null = null
/** Register the callback run when the shared context is lost (the Surface scheduler). */
export function setRendererLostHandler(fn: () => void) { lostHandler = fn }
/** The shared context if one exists (never creates one); for freeing resources. */
export function existingRenderer(): GLRenderer | null {
  return shared && !shared.lost ? shared : null
}
/** The process-wide shared GL context, replaced transparently after a context loss. */
export function getRenderer(): GLRenderer {
  if (!shared || shared.lost || shared.gl.isContextLost()) shared = new GLRenderer()
  return shared
}
/** Free the shared context and all its GPU memory (it is recreated on demand). */
export function releaseRenderer() {
  shared?.release()
  shared = null
}
