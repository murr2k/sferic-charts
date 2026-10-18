// Render-cost benchmarks in headless Chrome with the GPU enabled.
//   npm run bench                     default scenarios
//   npm run bench -- --filter large
//   npm run bench -- --renders 300
// Sferic renders on demand, so the interval between animation frames measures input
// and display pacing, not render cost (the same scenario could read 3 ms or 16.7 ms).
// Instead each scenario drives renders (interaction or streaming) with debug.syncGPU
// on and records the wall time of every rendered frame including GPU completion: what
// a frame costs on this GPU, and so the frame rate it could sustain. (debug.syncGPU
// reads back a pixel; gl.finish() does not wait for the GPU in Chrome.)
import { args, checkServer, launch, openGallery, showExample, gpuInfo, settleFor } from './harness.mjs'

const o = args({ filter: '', size: '1920x1080', dpr: 1, renders: 180, timeout: 30, theme: 'storm' })
const [width, height] = String(o.size).split('x').map(Number)

/** Scenario: example id + interaction that triggers renders while they are measured. */
const SCENARIOS = [
  { id: 'xy-large-line', action: 'wheel', note: '10 M points, zoom in/out' },
  { id: 'xy-datetime-zoom', action: 'wheel', note: '10.5 M points, area, DateTime' },
  { id: 'xy-scatter-million', action: 'pan', note: '1 M points, per-point color' },
  { id: 'heatmap-grid', action: 'wheel', note: '1000x1000 heatmap, bilinear' },
  { id: 'rt-multichannel', action: 'idle', note: '10 ch x 1 kHz streaming' },
  { id: 'rt-100-channels', action: 'idle', note: '100 charts streaming' },
  { id: 'rt-spectrogram', action: 'idle', note: 'FFT + scrolling heatmap' },
  { id: 'rt-medical', action: 'idle', note: 'sweeping monitor dashboard' },
]

await checkServer()
const browser = await launch({ width, height, dpr: o.dpr, uncapped: true })
const page = await openGallery(browser, String(o.theme))
console.log(`GPU: ${await gpuInfo(page)}  viewport ${width}x${height} @${o.dpr}x  GPU-synced, ${o.renders} renders per scenario\n`)

const list = SCENARIOS.filter((s) => !o.filter || String(o.filter).split(',').some((f) => s.id.includes(f)))
const rows = []
for (const s of list) {
  await showExample(page, s.id, settleFor(s.id, 1500))
  const box = await page.evaluate(() => {
    const r = document.querySelector('#chart-host').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  // Restart the moving averages, sync every frame with the GPU and record frame times.
  await page.evaluate(() => {
    const d = window.__sfericDebug
    d.stats.frames = 0
    d.syncGPU = true
    window.__benchMs = []
    d.onFrame = (ms) => window.__benchMs.push(ms)
  })
  const cx = box.x + box.w * 0.45, cy = box.y + box.h * 0.5
  await page.mouse.move(cx, cy)
  const deadline = Date.now() + o.timeout * 1000
  let k = 0
  let count = 0
  while (count < o.renders && Date.now() < deadline) {
    if (s.action === 'wheel') await page.mouse.wheel({ deltaY: Math.floor(k / 20) % 2 ? 120 : -120 })
    else if (s.action === 'pan') {
      if (k % 40 === 0) await page.mouse.down({ button: 'right' })
      await page.mouse.move(cx + Math.sin(k / 6) * 120, cy + Math.cos(k / 6) * 60)
      if (k % 40 === 39) await page.mouse.up({ button: 'right' })
    } else await new Promise((r) => setTimeout(r, 30))
    k++
    if (k % 8 === 0) count = await page.evaluate(() => window.__benchMs.length)
  }
  if (s.action === 'pan') await page.mouse.up({ button: 'right' }).catch(() => {})
  const res = await page.evaluate(() => {
    const d = window.__sfericDebug
    d.onFrame = null
    d.syncGPU = false
    return { ms: window.__benchMs, st: { ...d.stats } }
  })
  // The first renders after an interaction starts include warm-up (LOD builds, uploads).
  const t = res.ms.slice(5).sort((a, b) => a - b)
  const med = t[Math.floor(t.length / 2)] ?? NaN, p95 = t[Math.floor(t.length * 0.95)] ?? NaN
  rows.push({
    example: s.id,
    scenario: s.note,
    renders: res.ms.length,
    'median ms': med.toFixed(2),
    'p95 ms': p95.toFixed(2),
    'fps max': (1000 / med).toFixed(0),
    'gpu wait ms': (res.st.gpuSync ?? 0).toFixed(2),
    errors: page.__errors.length,
  })
  if (res.ms.length < o.renders) console.warn(`${s.id}: only ${res.ms.length} renders in ${o.timeout} s`)
}
await browser.close()
console.table(rows)
console.log('median/p95: wall time per rendered frame including GPU completion; gpu wait: time blocked waiting for the GPU (moving average).')
