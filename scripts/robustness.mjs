// Browser robustness checks (needs the dev server running):
//   npm run test:browser
// 1. GPU context loss: charts recover and redraw in a replacement context.
// 2. WebGL disabled: 2D charts still render, GPU charts show a notice, no exceptions.
// 3. GPU memory: the shared context is released after the last chart is disposed,
//    and oversized render targets shrink when charts get smaller.
// 4. Accessibility: the canvas exposes the chart title as its label.
import { BASE, checkServer, launch, openGallery, showExample } from './harness.mjs'

await checkServer()
const results = []
const ok = (name, pass, detail = '') => results.push({ name, pass, detail })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// Chrome reports an intentional loss as a WebGL warning; that is expected here.
const realErrors = (page) => page.__errors.filter((e) => !/CONTEXT_LOST_WEBGL|loseContext/.test(e))

/** Mean absolute difference (0..255) between two PNG screenshots of the chart area. */
async function shot(page) {
  const el = await page.$('#chart-host')
  return el.screenshot({ encoding: 'base64' })
}
async function diff(page, a, b) {
  return page.evaluate(async (a, b) => {
    const load = (s) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = 'data:image/png;base64,' + s })
    const [ia, ib] = await Promise.all([load(a), load(b)])
    const w = Math.min(ia.width, ib.width), h = Math.min(ia.height, ib.height)
    const c = new OffscreenCanvas(w, h).getContext('2d')
    c.drawImage(ia, 0, 0); const da = c.getImageData(0, 0, w, h).data
    c.clearRect(0, 0, w, h); c.drawImage(ib, 0, 0); const db = c.getImageData(0, 0, w, h).data
    let s = 0
    for (let i = 0; i < da.length; i += 4) s += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2])
    return s / (da.length / 4) / 3
  }, a, b)
}

// ---------------------------------------------------------------- 1. context loss
{
  const browser = await launch({ width: 1280, height: 800 })
  const page = await openGallery(browser, 'storm')
  // Static examples covering every GPU resource holder family.
  for (const id of ['line-series', 'xy-palette', 'heatmap-grid', 'trading-candlestick', '3d-scatter', '3d-surface-heatmap', 'polar-heatmap-sensors', 'polar-microphone', 'tree-portfolio', 'stats-parallel-coordinates', 'bars-grouped']) {
    await showExample(page, id, 2500)
    const before = await shot(page)
    const lost = await page.evaluate(() => { window.__sfericDebug.loseContext(); return true })
    await sleep(1500)
    const alive = await page.evaluate(() => window.__sfericDebug.renderer().alive)
    const after = await shot(page)
    const d = await diff(page, before, after)
    const errs = realErrors(page)
    ok(`context loss recovers: ${id}`, lost && alive && d < 6 && !errs.length, `pixel diff ${d.toFixed(2)}${errs.length ? `; ${errs[0].slice(0, 120)}` : ''}`)
  }
  // 4. accessibility
  await showExample(page, 'line-series', 1500)
  const label = await page.evaluate(() => {
    const c = document.querySelector('#chart-host canvas')
    return { role: c.getAttribute('role'), label: c.getAttribute('aria-label') }
  })
  ok('canvas exposes role and chart title', label.role === 'img' && /Power Price/.test(label.label ?? ''), JSON.stringify(label))
  // 3a. render targets shrink
  await showExample(page, 'rt-multichannel', 2000)
  const big = await page.evaluate(() => window.__sfericDebug.renderer())
  await page.setViewport({ width: 700, height: 500 })
  await sleep(7000)
  const small = await page.evaluate(() => window.__sfericDebug.renderer())
  ok('oversized render targets shrink', small.targetW < big.targetW && small.targetH < big.targetH, `${big.targetW}x${big.targetH} -> ${small.targetW}x${small.targetH}`)
  // 3b. release after the last chart is disposed, then recreate on demand.
  // (The gallery home renders thumbnails, so use a minimal fixture page.)
  await page.goto(`${BASE}/tests/fixtures/release.html`, { waitUntil: 'load' })
  await sleep(1500)
  const live = await page.evaluate(() => window.__sfericDebug.renderer().alive)
  await page.evaluate(() => window.__fixture.dispose())
  await sleep(4000)
  const released = await page.evaluate(() => window.__sfericDebug.renderer())
  await page.evaluate(() => window.__fixture.recreate())
  await sleep(1500)
  const again = await page.evaluate(() => window.__sfericDebug.renderer())
  ok('GPU context released when no charts remain', live && released.alive === false, JSON.stringify(released))
  ok('a new chart after release gets a fresh context', again.alive === true && realErrors(page).length === 0, JSON.stringify(again))
  await browser.close()
}

// ---------------------------------------------------------------- 2. WebGL unavailable
{
  const browser = await launch({ width: 1280, height: 800, extraArgs: ['--disable-webgl', '--disable-webgl2', '--disable-3d-apis'] })
  const page = await openGallery(browser, 'storm')
  for (const id of ['pie-chart', 'line-series', 'pie-gauge-dashboard']) {
    await showExample(page, id, 1500)
    const state = await page.evaluate(() => ({ glError: window.__sfericDebug.glError(), frames: window.__sfericDebug.stats.frames }))
    const errs = page.__errors.filter((e) => !/WebGL2 unavailable/.test(e))
    ok(`no WebGL: ${id} renders without exceptions`, state.frames > 0 && !errs.length, `${state.glError ? 'GL disabled; ' : ''}frames ${state.frames}${errs.length ? `; ${errs[0].slice(0, 120)}` : ''}`)
  }
  await browser.close()
}

for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`)
const failed = results.filter((r) => !r.pass).length
console.log(failed ? `\n${failed} check(s) failed` : '\nall robustness checks passed')
process.exit(failed ? 1 : 0)
