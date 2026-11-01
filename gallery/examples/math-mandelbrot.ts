import { sferic, LUT, PalettedFill, ColorHEX } from '../../src'
import type { Example } from '../types'

const HOME = { x0: -2.55, x1: 1.05, y0: -1.2, y1: 1.2 }
const PRESETS = [
  { name: 'Seahorse valley', cx: -0.7453, cy: 0.1127, w: 0.012 },
  { name: 'Spiral, 10¹⁰×', cx: -0.743643887037151, cy: 0.13182590420533, w: 3.6e-10 },
]

// Escape-time kernel, run in a worker so the page stays responsive during deep zooms.
// Values are log-smoothed iteration counts rescaled to (0, 1] per image; 0 = inside.
const KERNEL = `
onmessage = (e) => {
  const { id, x0, x1, y0, y1, cols, rows, maxIter } = e.data
  const out = new Float32Array(cols * rows)
  const dx = (x1 - x0) / cols, dy = (y1 - y0) / rows
  let lo = Infinity, hi = -Infinity
  for (let r = 0; r < rows; r++) {
    const ci = y0 + (r + 0.5) * dy
    for (let c = 0; c < cols; c++) {
      const cr = x0 + (c + 0.5) * dx
      const i = r * cols + c
      const xq = cr - 0.25, q = xq * xq + ci * ci
      if (q * (q + xq) <= 0.25 * ci * ci || (cr + 1) * (cr + 1) + ci * ci <= 0.0625) { out[i] = 0; continue }
      let zr = 0, zi = 0, zr2 = 0, zi2 = 0, n = 0
      while (n < maxIter && zr2 + zi2 <= 256) { zi = 2 * zr * zi + ci; zr = zr2 - zi2 + cr; zr2 = zr * zr; zi2 = zi * zi; n++ }
      if (n >= maxIter) { out[i] = 0; continue }
      const mu = Math.log(n + 2 - Math.log2(0.5 * Math.log(zr2 + zi2)))
      out[i] = mu
      if (mu < lo) lo = mu
      if (mu > hi) hi = mu
    }
  }
  const span = hi > lo ? hi - lo : 1
  for (let i = 0; i < out.length; i++) if (out[i] !== 0) out[i] = 0.02 + 0.98 * ((out[i] - lo) / span)
  postMessage({ id, out }, [out.buffer])
}`

export default {
  title: 'Mandelbrot Set: Deep Zoom',
  category: 'Physics & Math',
  order: 3,
  tags: ['math', 'fractal', 'heatmap', 'precision', 'web worker'],
  description:
    'The Mandelbrot set as a heatmap that is recomputed for the visible region after every zoom or pan (escape-time iterations in a Web Worker, smooth coloring). Wheel to zoom, drag a rectangle, or take a preset down to 10¹⁰× magnification: the heatmap is positioned in float64 relative to its own origin, so it stays registered with the axes until double-precision arithmetic itself runs out near 10¹³×.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('Mandelbrot set')
    chart.axisX.setTitle('Re c').setInterval({ start: HOME.x0, end: HOME.x1, stopAxisAfter: true }).setDefaultInterval({ start: HOME.x0, end: HOME.x1 })
    chart.axisY.setTitle('Im c').setInterval({ start: HOME.y0, end: HOME.y1, stopAxisAfter: true }).setDefaultInterval({ start: HOME.y0, end: HOME.y1 })

    // Grid resolution follows the container (about one cell per CSS pixel, capped).
    const w = Math.max(320, container.clientWidth || 960), h = Math.max(200, container.clientHeight || 600)
    const cols = Math.min(1100, Math.round(w * 0.9))
    const rows = Math.min(800, Math.round((cols * h) / w))

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

    const url = URL.createObjectURL(new Blob([KERNEL], { type: 'text/javascript' }))
    const worker = new Worker(url)
    let busy = false
    let pending = false
    let seq = 0
    let view = { ...HOME }
    let sent = { ...HOME }
    let t0 = 0

    const iterationsFor = (width: number) => Math.round(Math.min(4000, 160 + 70 * Math.max(0, Math.log2(3.6 / width))))
    const describe = (v: typeof view, ms: number) => {
      const zoom = 3.6 / Math.abs(v.x1 - v.x0)
      const sup = (s: string) => s.replace(/\d/g, (d) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[+d])
      const [m, e] = zoom.toExponential(1).split('e+')
      const z = zoom < 1e3 ? zoom.toFixed(1) : `${m} × 10${sup(e)}`
      const limit = Math.abs(v.x1 - v.x0) < 5e-13 ? ' (float64 limit reached)' : ''
      return `${z}× zoom, ${iterationsFor(Math.abs(v.x1 - v.x0))} iterations, ${(cols * rows).toLocaleString('en-US')} cells in ${ms} ms${limit}`
    }
    const send = () => {
      busy = true
      pending = false
      sent = { ...view }
      t0 = performance.now()
      const width = Math.abs(sent.x1 - sent.x0)
      worker.postMessage({ id: ++seq, ...sent, cols, rows, maxIter: iterationsFor(width) })
    }
    worker.onmessage = (e: MessageEvent<{ id: number; out: Float32Array }>) => {
      busy = false
      if (e.data.id === seq) {
        heat.setStart({ x: sent.x0, y: sent.y0 }).setEnd({ x: sent.x1, y: sent.y1 }).setRowMajorValues(e.data.out)
        chart.setTitle(describe(sent, Math.round(performance.now() - t0)))
      }
      if (pending) send()
    }
    const request = () => {
      const x = chart.axisX.getInterval(), y = chart.axisY.getInterval()
      view = { x0: x.start, x1: x.end, y0: y.start, y1: y.end }
      if (busy) pending = true
      else send()
    }
    chart.axisX.addEventListener('intervalchange', request)
    chart.axisY.addEventListener('intervalchange', request)

    const goto = (cx: number, cy: number, width: number) => {
      const height = (width * (HOME.y1 - HOME.y0)) / (HOME.x1 - HOME.x0)
      chart.axisX.setInterval({ start: cx - width / 2, end: cx + width / 2, stopAxisAfter: true, animate: 900 })
      chart.axisY.setInterval({ start: cy - height / 2, end: cy + height / 2, stopAxisAfter: true, animate: 900 })
    }
    const buttons = [
      { label: 'Full set', go: () => goto((HOME.x0 + HOME.x1) / 2, 0, HOME.x1 - HOME.x0) },
      ...PRESETS.map((p) => ({ label: p.name, go: () => goto(p.cx, p.cy, p.w) })),
    ]
    // Stacked in the plot's top-left corner, which the set itself never reaches.
    buttons.forEach((b, i) => {
      chart.addUIElement('button').setText(b.label).setPosition({ x: 9, y: 89 - i * 7 }).setOrigin({ x: -1, y: 1 }).addEventListener('click', b.go)
    })
    request()

    return () => {
      worker.terminate()
      URL.revokeObjectURL(url)
      chart.dispose()
    }
  },
} satisfies Example
