import { sferic, LUT, PalettedFill, ColorHEX } from '../../src'
import { paramsOf, type Example, type ExampleParam } from '../types'

const PARAMS: ExampleParam[] = [
  { key: 'iter', label: 'Iteration budget', min: 0.25, max: 4, step: 0.25, value: 1, format: (v) => `${v}×` },
  { key: 'res', label: 'Cells per pixel', min: 0.3, max: 1.5, step: 0.1, value: 0.9, restart: true },
]

const HOME = { x0: -2.55, x1: 1.05, y0: -1.2, y1: 1.2 }
const PRESETS = [
  { name: 'Seahorse valley', cx: -0.7453, cy: 0.1127, w: 0.012 },
  { name: 'Spiral, 10¹⁰×', cx: -0.743643887037151, cy: 0.13182590420533, w: 3.6e-10 },
]
/** Lattice steps of the progressive passes: every 8th cell, then 4th, 2nd, all. */
const PASSES = [8, 4, 2, 1]

type View = { x0: number; x1: number; y0: number; y1: number }
interface Part { id: number; s: number; nc: number; rows: Int32Array; data: Float32Array }

// Escape-time worker. A job is split across a pool of these by lattice row and computed
// in progressive passes; each pass computes only the cells earlier passes did not, and
// is posted as soon as it is done. The loop yields every few ms so a newer job (a new
// view) cancels the current one instead of queuing behind it.
// Values: log-smoothed iteration count (> 0) outside the set, 0 inside.
const KERNEL = `
let current = 0
const tick = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0) })
function escape(cr, ci, maxIter) {
  const xq = cr - 0.25, q = xq * xq + ci * ci
  if (q * (q + xq) <= 0.25 * ci * ci || (cr + 1) * (cr + 1) + ci * ci <= 0.0625) return 0
  // (A periodicity check was measured and dropped: interior cells in deep views sit near the
  // boundary, where orbits converge too slowly for it to end them before maxIter.)
  let zr = 0, zi = 0, zr2 = 0, zi2 = 0, n = 0
  while (n < maxIter) {
    zi = 2 * zr * zi + ci
    zr = zr2 - zi2 + cr
    zr2 = zr * zr
    zi2 = zi * zi
    n++
    if (zr2 + zi2 > 256) return Math.log(n + 2 - Math.log2(0.5 * Math.log(zr2 + zi2)))
  }
  return 0
}
onmessage = async (e) => {
  const { id, x0, x1, y0, y1, cols, rows, maxIter, part, parts, passes } = e.data
  current = id
  const dx = (x1 - x0) / cols, dy = (y1 - y0) / rows
  let since = performance.now()
  for (let p = 0; p < passes.length; p++) {
    const s = passes[p]
    const nc = Math.ceil(cols / s)
    const idx = [], vals = []
    for (let r = 0, li = 0; r < rows; r += s, li++) {
      if (li % parts !== part) continue
      const row = new Float32Array(nc).fill(-1)
      const ci = y0 + (r + 0.5) * dy
      const anchors = p > 0 && r % (2 * s) === 0 // cells (2s-multiples) done in the previous pass
      for (let j = 0, c = 0; c < cols; c += s, j++) {
        if (anchors && c % (2 * s) === 0) continue
        row[j] = escape(x0 + (c + 0.5) * dx, ci, maxIter)
      }
      idx.push(r)
      vals.push(row)
      if (performance.now() - since > 6) {
        await tick()
        if (current !== id) return
        since = performance.now()
      }
    }
    const data = new Float32Array(idx.length * nc)
    vals.forEach((v, k) => data.set(v, k * nc))
    const rowIdx = Int32Array.from(idx)
    postMessage({ id, s, nc, rows: rowIdx, data }, [rowIdx.buffer, data.buffer])
  }
}`

export default {
  title: 'Mandelbrot Set: Deep Zoom',
  category: 'Physics & Math',
  order: 3,
  tags: ['math', 'fractal', 'heatmap', 'precision', 'web workers'],
  params: PARAMS,
  description:
    'The Mandelbrot set as a heatmap that is recomputed for the visible region after every zoom or pan: escape-time iterations spread over a pool of Web Workers, refined progressively from a coarse preview to full resolution, with stale work cancelled as soon as the view moves on. Wheel to zoom, drag a rectangle, or take a preset down to 10¹⁰× magnification: the heatmap is positioned in float64 relative to its own origin, so it stays registered with the axes until double-precision arithmetic itself runs out near 10¹³×.',
  run(ctx) {
    const { container, theme } = ctx
    const p = paramsOf(PARAMS, ctx)
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('Mandelbrot set')
    chart.axisX.setTitle('Re c').setInterval({ start: HOME.x0, end: HOME.x1, stopAxisAfter: true }).setDefaultInterval({ start: HOME.x0, end: HOME.x1 })
    chart.axisY.setTitle('Im c').setInterval({ start: HOME.y0, end: HOME.y1, stopAxisAfter: true }).setDefaultInterval({ start: HOME.y0, end: HOME.y1 })
    // Reserve room for deep-zoom tick labels (0.131825904203...), so the plot keeps its size,
    // and with it its aspect ratio, as the labels grow while zooming in.
    chart.axisY.setThickness({ min: 132 })

    // Grid resolution follows the container (about one cell per CSS pixel, capped).
    const w = Math.max(320, container.clientWidth || 960), h = Math.max(200, container.clientHeight || 600)
    const cols = Math.min(1600, Math.round(w * p.res))
    const rows = Math.min(1200, Math.round((cols * h) / w))

    const pal = theme.examples.intensityColorPalette
    const inside = ColorHEX(theme.isDark ? '#000000' : '#0b0d12')
    const lut = new LUT({
      interpolate: true,
      steps: [{ value: 0, color: inside }, ...pal.map((color, i) => ({ value: 0.02 + (0.98 * i) / (pal.length - 1), color }))],
    })
    const heat = chart
      .addHeatmapGridSeries({ columns: cols, rows, start: { x: HOME.x0, y: HOME.y0 }, end: { x: HOME.x1, y: HOME.y1 } })
      .setName('Escape time')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')

    // One worker per spare core.
    const threads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1))
    const url = URL.createObjectURL(new Blob([KERNEL], { type: 'text/javascript' }))
    const pool = Array.from({ length: threads }, () => new Worker(url))
    const raw = new Float32Array(cols * rows) // smoothed counts as computed, by cell
    const disp = new Float32Array(cols * rows) // normalized, block-filled for display

    const iterationsFor = (width: number) => Math.round(p.iter * Math.min(4000, 160 + 70 * Math.max(0, Math.log2(3.6 / width))))
    const describe = (v: View, maxIter: number, ms: number) => {
      const zoom = 3.6 / Math.abs(v.x1 - v.x0)
      const sup = (s: string) => s.replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d])
      const [m, e] = zoom.toExponential(1).split('e+')
      const z = zoom < 1e3 ? zoom.toFixed(1) : `${m} × 10${sup(e)}`
      const limit = Math.abs(v.x1 - v.x0) < 5e-13 ? ' (float64 limit reached)' : ''
      return `${z}× zoom, ${maxIter} iterations, ${(cols * rows).toLocaleString('en-US')} cells in ${ms} ms on ${threads} threads${limit}`
    }

    let seq = 0
    let job: { id: number; view: View; maxIter: number; t0: number; done: Map<number, number>; shown: boolean; lo: number; hi: number } | null = null
    let pending: View | null = null

    const start = (view: View) => {
      pending = null
      const maxIter = iterationsFor(Math.abs(view.x1 - view.x0))
      job = { id: ++seq, view, maxIter, t0: performance.now(), done: new Map(), shown: false, lo: 0, hi: 1 }
      pool.forEach((wk, part) => wk.postMessage({ id: job!.id, ...view, cols, rows, maxIter, part, parts: threads, passes: PASSES }))
    }

    /** Show the job's cells computed so far: each cell takes the value of its pass-s anchor. */
    const present = (s: number) => {
      const j = job!
      if (!j.shown) {
        // Color range from the first (coarse) pass, kept for the finer passes so colors do not shift.
        let lo = Infinity, hi = -Infinity
        for (let r = 0; r < rows; r += s) {
          for (let c = 0; c < cols; c += s) {
            const v = raw[r * cols + c]
            if (v > 0) {
              if (v < lo) lo = v
              if (v > hi) hi = v
            }
          }
        }
        j.lo = Number.isFinite(lo) ? lo : 0
        j.hi = hi > lo ? hi : j.lo + 1
        j.shown = true
      }
      const k = 0.98 / (j.hi - j.lo)
      for (let r = 0; r < rows; r++) {
        const anchorRow = (r - (r % s)) * cols
        const out = r * cols
        for (let c = 0; c < cols; c++) {
          const v = raw[anchorRow + c - (c % s)]
          disp[out + c] = v > 0 ? Math.min(1, Math.max(0.02, 0.02 + (v - j.lo) * k)) : 0
        }
      }
      heat.setStart({ x: j.view.x0, y: j.view.y0 }).setEnd({ x: j.view.x1, y: j.view.y1 }).setRowMajorValues(disp)
      if (s === 1) chart.setTitle(describe(j.view, j.maxIter, Math.round(performance.now() - j.t0)))
      // The view moved on while this job ran: start the newest view now that something is on screen.
      if (pending) start(pending)
    }

    for (const wk of pool) {
      wk.onmessage = (e: MessageEvent<Part>) => {
        const { id, s, nc, rows: rowIdx, data } = e.data
        if (!job || id !== job.id) return // a stale job's result
        for (let k = 0; k < rowIdx.length; k++) {
          const base = rowIdx[k] * cols
          for (let jx = 0; jx < nc; jx++) {
            const v = data[k * nc + jx]
            if (v !== -1) raw[base + jx * s] = v
          }
        }
        const n = (job.done.get(s) ?? 0) + 1
        job.done.set(s, n)
        if (n === threads) present(s)
      }
    }

    // ---- Aspect ratio: one data unit per pixel scale on both axes, so the set is never stretched.
    const currentView = (): View => {
      const x = chart.axisX.getInterval(), y = chart.axisY.getInterval()
      return { x0: x.start, x1: x.end, y0: y.start, y1: y.end }
    }
    const plotPx = () => {
      const x = chart.axisX.getInterval(), y = chart.axisY.getInterval()
      const w = Math.abs(chart.axisX.valueToPx(x.end) - chart.axisX.valueToPx(x.start))
      const h = Math.abs(chart.axisY.valueToPx(y.end) - chart.axisY.valueToPx(y.start))
      return w > 10 && h > 10 ? { w, h } : null // null until the chart has been laid out
    }
    /** The same region at one scale on both axes, centered, keeping all of it in view; `v` itself if already square. */
    const fitted = (v: View): View | null => {
      const px = plotPx()
      if (!px) return null
      const sx = Math.abs(v.x1 - v.x0) / px.w, sy = Math.abs(v.y1 - v.y0) / px.h
      if (Math.abs(sx / sy - 1) < 1e-3) return v
      const s = Math.max(sx, sy), cx = (v.x0 + v.x1) / 2, cy = (v.y0 + v.y1) / 2
      return { x0: cx - (s * px.w) / 2, x1: cx + (s * px.w) / 2, y0: cy - (s * px.h) / 2, y1: cy + (s * px.h) / 2 }
    }
    const apply = (v: View, animate: number | false) => {
      chart.axisX.setInterval({ start: v.x0, end: v.x1, stopAxisAfter: true, animate })
      chart.axisY.setInterval({ start: v.y0, end: v.y1, stopAxisAfter: true, animate })
    }

    // Coalesce the X and Y interval changes of one frame into one view. While the view keeps
    // moving, a new job waits until the current one has shown its preview, so previews keep
    // arriving during a zoom instead of every job being cancelled before it shows anything.
    // Zooming to a drawn rectangle, zooming one axis or resizing can leave the axes at
    // different scales; once the view has been still for a moment it is eased back to one
    // scale. (Correcting sooner would cut short the library's rectangle-zoom animation.)
    let raf = 0
    let fixTimer = 0
    let ready = false
    let quiet = false // set while the first fit changes the axes, so that change starts no extra job
    const frame = () => {
      raf = 0
      const view = currentView()
      if (!ready) {
        // First layout: fit the home view to the plot before anything is drawn, and make
        // that the view a double-click returns to.
        const f = fitted(view)
        if (!f) {
          raf = requestAnimationFrame(frame)
          return
        }
        quiet = true
        chart.axisX.setDefaultInterval({ start: f.x0, end: f.x1 })
        chart.axisY.setDefaultInterval({ start: f.y0, end: f.y1 })
        if (f !== view) apply(f, false)
        quiet = false
        ready = true
        start(f)
        return
      }
      // The library stops zooming an axis once its interval nears float64 resolution, so
      // past about 10¹² the X axis (|Re c| ≈ 0.74) stops before Y (|Im c| ≈ 0.13). Square the
      // view at once there, so zooming simply stops at the limit instead of stretching.
      const atFloor = (a: number, b: number) => Math.abs(b - a) < Math.max(Math.abs(a), Math.abs(b)) * 1.5e-12
      let view2 = view
      if (atFloor(view.x0, view.x1) || atFloor(view.y0, view.y1)) {
        const f = fitted(view)
        if (f && f !== view) {
          quiet = true
          apply(f, false)
          quiet = false
          view2 = f
        }
      }
      if (job && !job.shown) pending = view2
      else start(view2)
    }
    const fixAspect = () => {
      const v = currentView()
      const f = ready ? fitted(v) : null
      if (f && f !== v) apply(f, 220)
    }
    const request = () => {
      if (quiet) return
      clearTimeout(fixTimer)
      fixTimer = window.setTimeout(fixAspect, 120)
      if (!raf) raf = requestAnimationFrame(frame)
    }
    chart.axisX.addEventListener('intervalchange', request)
    chart.axisY.addEventListener('intervalchange', request)
    ctx.onParamChange?.(request)
    const resize = new ResizeObserver(request)
    resize.observe(container)

    /** Animate to a region centered on (cx, cy) and `width` wide; its height follows the plot's aspect. */
    const goto = (cx: number, cy: number, width: number) => {
      const px = plotPx()
      const height = px ? (width * px.h) / px.w : (width * (HOME.y1 - HOME.y0)) / (HOME.x1 - HOME.x0)
      apply({ x0: cx - width / 2, x1: cx + width / 2, y0: cy - height / 2, y1: cy + height / 2 }, 900)
    }
    const buttons = [
      { label: 'Full set', go: () => apply(fitted({ ...HOME }) ?? HOME, 900) },
      ...PRESETS.map((q) => ({ label: q.name, go: () => goto(q.cx, q.cy, q.w) })),
    ]
    // Stacked in the plot's top-left corner, which the set itself never reaches.
    buttons.forEach((b, i) => {
      chart.addUIElement('button').setText(b.label).setPosition({ x: 9, y: 89 - i * 7 }).setOrigin({ x: -1, y: 1 }).addEventListener('click', b.go)
    })
    request()

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(fixTimer)
      resize.disconnect()
      pool.forEach((wk) => wk.terminate())
      URL.revokeObjectURL(url)
      chart.dispose()
    }
  },
} satisfies Example
