// Frame-time benchmarks in headless Chrome with the GPU enabled.
//   npm run bench                  default scenarios, vsync off (shows headroom)
//   npm run bench -- --vsync       cap at display rate instead
//   npm run bench -- --filter large
// Reports rAF frame interval (median / p95) and Sferic's own CPU render time per frame.
import { args, checkServer, launch, openGallery, showExample, gpuInfo, settleFor } from './harness.mjs'

const o = args({ filter: '', size: '1920x1080', dpr: 1, frames: 180, vsync: false, theme: 'storm' })
const [width, height] = String(o.size).split('x').map(Number)

/** Scenario: example id + interaction to run while frames are measured. */
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
const browser = await launch({ width, height, dpr: o.dpr, uncapped: !o.vsync })
const page = await openGallery(browser, String(o.theme))
console.log(`GPU: ${await gpuInfo(page)}  viewport ${width}x${height} @${o.dpr}x  vsync ${o.vsync ? 'on' : 'off'}\n`)

const list = SCENARIOS.filter((s) => !o.filter || String(o.filter).split(',').some((f) => s.id.includes(f)))
const rows = []
for (const s of list) {
  await showExample(page, s.id, settleFor(s.id, 1500))
  const box = await page.evaluate(() => {
    const r = document.querySelector('#chart-host').getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })
  // Reset smoothed stats, then measure frames while interacting.
  await page.evaluate(() => {
    const s = globalThis.__sfericStats
    if (s) for (const k of Object.keys(s)) s[k] = 0
  })
  const measuring = page.evaluate(
    (n) =>
      new Promise((res) => {
        const t = []
        let last = performance.now()
        let i = 0
        const f = (now) => {
          t.push(now - last)
          last = now
          if (++i < n) requestAnimationFrame(f)
          else res(t)
        }
        requestAnimationFrame(f)
      }),
    o.frames,
  )
  let done = false
  measuring.then(() => (done = true))
  const cx = box.x + box.w * 0.45, cy = box.y + box.h * 0.5
  await page.mouse.move(cx, cy)
  let k = 0
  while (!done) {
    if (s.action === 'wheel') await page.mouse.wheel({ deltaY: Math.floor(k / 20) % 2 ? 120 : -120 })
    else if (s.action === 'pan') {
      if (k % 40 === 0) await page.mouse.down({ button: 'right' })
      await page.mouse.move(cx + Math.sin(k / 6) * 120, cy + Math.cos(k / 6) * 60)
      if (k % 40 === 39) await page.mouse.up({ button: 'right' })
    } else await new Promise((r) => setTimeout(r, 30))
    k++
  }
  if (s.action === 'pan') await page.mouse.up({ button: 'right' }).catch(() => {})
  const t = (await measuring).slice(5).sort((a, b) => a - b)
  const med = t[Math.floor(t.length / 2)], p95 = t[Math.floor(t.length * 0.95)]
  const st = await page.evaluate(() => ({ ...(globalThis.__sfericStats ?? {}) }))
  rows.push({
    example: s.id,
    scenario: s.note,
    'median ms': med.toFixed(1),
    'p95 ms': p95.toFixed(1),
    fps: (1000 / med).toFixed(0),
    'cpu ms': (st.total ?? 0).toFixed(2),
    'gl ms': (st.gl ?? 0).toFixed(2),
    errors: page.__errors.length,
  })
}
await browser.close()
console.table(rows)
