// Smoke test of the website (site/, served by the dev server at /site/): scrolls every demo
// card into view (clicking the click-to-run ones), steps through every usage example, and
// screenshots each into .snapshots/site/. Fails on page errors, WebGL warnings, a demo that
// never produced a canvas, or a usage example that reports an error.
//   npm run test:site
//   npm run test:site -- --theme daylight --size 390x844 --filter live-,math-
//   SFERIC_URL=http://127.0.0.1:<port> npm run test:site -- --path /   (a built site from preview:site)
// Console errors from third-party data hosts (USGS, Open-Meteo, the map CDN) are reported
// but do not fail the run: those demos show a message when offline.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { args, checkServer, launch, openPage, gpuInfo, ROOT } from './harness.mjs'

const o = args({ theme: 'storm', size: '1440x900', dpr: 1, filter: '', wait: 2200, path: '/site/' })
const [width, height] = String(o.size).split('x').map(Number)
const EXTERNAL = ['earthquake.usgs.gov', 'api.open-meteo.com', 'cdn.jsdelivr.net']
const SLOW = { 'live-': 6000, 'xy-large-line': 7000, 'xy-scatter-million': 4000, 'rt-100-channels': 3500, 'phys-hydrogen': 3000 }
const settle = (id) => Object.entries(SLOW).reduce((ms, [k, v]) => (id.startsWith(k) ? Math.max(ms, v) : ms), Number(o.wait))
const wanted = (id) => !o.filter || o.filter === true || String(o.filter).split(',').some((f) => id.includes(f))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await checkServer()
const outDir = join(ROOT, '.snapshots', 'site', String(o.theme))
mkdirSync(outDir, { recursive: true })
const browser = await launch({ width, height, dpr: o.dpr })
const page = await openPage(browser, String(o.path), o.theme, { ignoreHosts: EXTERNAL })
const gpu = await gpuInfo(page)
console.log(`GPU: ${gpu}`)
if (gpu === 'no WebGL2') {
  console.error('No WebGL2 in this browser: charts would be blank. Site not checked.')
  await browser.close()
  process.exit(1)
}

const failures = []
const record = (id, extra = []) => {
  const errs = [...new Set([...page.__errors, ...extra])]
  page.__errors.length = 0
  if (errs.length) failures.push({ id, errs })
  console.log(`${errs.length ? 'ERR ' : 'ok  '} ${id}${errs.length ? '  ' + errs[0].slice(0, 160) : ''}`)
}

// Hero
await page.waitForFunction(() => !!document.querySelector('#hero-stage canvas'), { timeout: 20_000 }).catch(() => {})
await sleep(3000)
await page.screenshot({ path: join(outDir, '_top.png') })
const hasHero = await page.evaluate(() => !!document.querySelector('#hero-stage canvas'))
record('hero (rt-vlf-receiver)', hasHero ? [] : ['hero chart did not render'])

// Demo cards
const ids = await page.$$eval('article.card', (cards) => cards.map((c) => c.id.replace(/^demo-/, '')))
for (const id of ids.filter(wanted)) {
  const sel = `#demo-${id}`
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }))
  await sleep(150)
  const overlay = await page.$(`${sel} .run-overlay`)
  if (overlay) await overlay.click()
  await page.waitForFunction((s) => !!document.querySelector(`${s} .stage canvas`), { timeout: 15_000 }, sel).catch(() => {})
  await sleep(settle(id))
  const ok = await page.$eval(sel, (el) => !!el.querySelector('.stage canvas') && !el.querySelector('.stage-error'))
  const card = await page.$(sel)
  await card.screenshot({ path: join(outDir, `${id}.png`) })
  record(id, ok ? [] : ['no chart canvas (or the demo threw)'])
}

// Sliders: drive every slider of the hero and each card to its maximum, then back to defaults.
const canvasHash = (sel) => page.$eval(sel, (el) => {
  const c = el.querySelector('canvas')
  if (!c) return ''
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
  let h = 2166136261
  for (let i = 0; i < d.length; i += 97) h = Math.imul(h ^ d[i], 16777619)
  return (h >>> 0).toString(16)
})
const withParams = ['.hero-figure', ...ids.filter(wanted).map((id) => `#demo-${id}`)]
for (const sel of withParams) {
  if (!(await page.$(`${sel} .params input[type=range]`))) continue
  await page.$eval(sel, (el) => el.scrollIntoView({ block: 'center' }))
  await page.waitForFunction((s) => !!document.querySelector(`${s} .stage canvas`), { timeout: 15_000 }, sel).catch(() => {})
  await sleep(800)
  await page.$$eval(`${sel} .params input[type=range]`, (xs) =>
    xs.forEach((x) => {
      x.value = x.max
      x.dispatchEvent(new Event('input', { bubbles: true }))
    }),
  )
  await sleep(2500)
  await (await page.$(sel)).screenshot({ path: join(outDir, `params-max-${sel.replace(/[#.]/g, '')}.png`) })
  const okMax = await page.$eval(sel, (el) => !!el.querySelector('.stage canvas') && !el.querySelector('.stage-error'))
  await page.click(`${sel} .param-reset`)
  await sleep(1200)
  const okReset = await page.$eval(sel, (el) => !!el.querySelector('.stage canvas') && !el.querySelector('.stage-error'))
  record(`sliders ${sel}`, okMax && okReset ? [] : ['chart missing or errored after moving sliders'])
}

// Scrolling past charts: a plain wheel over an idle chart scrolls the page and leaves the
// chart alone; Ctrl + wheel zooms the chart and does not scroll; touch pans only when idle.
if (wanted('math-logistic-map')) {
  const stage = '#demo-math-logistic-map .stage'
  const center = async () => {
    await page.$eval(stage, (el) => el.scrollIntoView({ block: 'center' }))
    await sleep(1500)
    const b = await (await page.$(stage)).boundingBox()
    await page.mouse.move(b.x + b.width / 2, b.y + b.height * 0.35)
    await sleep(200)
  }
  await center()
  let y0 = await page.evaluate(() => scrollY)
  let h0 = await canvasHash(stage)
  await page.mouse.wheel({ deltaY: 240 })
  await sleep(600)
  const scrolled = (await page.evaluate(() => scrollY)) > y0
  const hint = await page.$eval(`${stage} .wheel-hint`, (el) => el.classList.contains('show'))
  await center()
  y0 = await page.evaluate(() => scrollY)
  h0 = await canvasHash(stage)
  await page.keyboard.down('Control')
  await page.mouse.wheel({ deltaY: -240 })
  await page.keyboard.up('Control')
  await sleep(900)
  const zoomed = (await canvasHash(stage)) !== h0
  const stayed = (await page.evaluate(() => scrollY)) === y0
  const idleTouch = await page.$eval(`${stage} .host > div`, (d) => getComputedStyle(d).touchAction)
  await page.click(stage)
  const engagedTouch = await page.$eval(`${stage} .host > div`, (d) => getComputedStyle(d).touchAction)
  const problems = []
  if (!scrolled) problems.push('plain wheel over an idle chart did not scroll the page')
  if (!hint) problems.push('no zoom hint after a plain wheel')
  if (!zoomed || !stayed) problems.push(`Ctrl + wheel: chart zoomed ${zoomed}, page stayed ${stayed}`)
  if (idleTouch !== 'pan-y' || engagedTouch !== 'none') problems.push(`touch-action idle ${idleTouch}, engaged ${engagedTouch}`)
  record('wheel and touch scrolling', problems)
}

// Usage examples
if (wanted('usage')) {
  await page.$eval('#usage', (el) => el.scrollIntoView({ block: 'start' }))
  const tabs = await page.$$eval('#usage-tabs button', (bs) => bs.map((b) => b.dataset.id))
  for (const id of tabs) {
    await page.click(`#usage-tabs button[data-id="${id}"]`)
    await page.waitForFunction(() => !!document.querySelector('#usage-stage canvas'), { timeout: 15_000 }).catch(() => {})
    await sleep(1600)
    const err = await page.$eval('#editor-error', (el) => (el.hidden ? '' : el.textContent))
    const usage = await page.$('.usage')
    await usage.screenshot({ path: join(outDir, `usage-${id}.png`) })
    record(`usage/${id}`, err ? [err] : [])
  }
  // An edit that does not parse must keep the last preview and show the error.
  await page.evaluate(() => {
    const ta = document.querySelector('#editor-input')
    ta.value += '\nconst = broken'
    ta.dispatchEvent(new Event('input'))
  })
  await sleep(1300)
  const syntax = await page.$eval('#editor-error', (el) => (el.hidden ? '' : el.textContent))
  const kept = await page.evaluate(() => !!document.querySelector('#usage-stage canvas'))
  record('usage/syntax-error', syntax && kept ? [] : [`expected a syntax error with the preview kept (error: "${syntax}", preview: ${kept})`])
  page.__errors.length = 0
  await page.click('#editor-reset')
  await sleep(800)
}

const live = await page.$eval('#st-live', (el) => el.textContent)
const fps = await page.$eval('#st-fps', (el) => el.textContent)
console.log(`\nStats panel: ${fps} fps, ${live} demos running at the end`)
if (page.__external.length) {
  console.log(`${page.__external.length} console errors from external data hosts (not failures):`)
  for (const e of [...new Set(page.__external)].slice(0, 5)) console.log(`  ${e.slice(0, 200)}`)
}
await browser.close()
console.log(`Screenshots: ${outDir}`)
if (failures.length) {
  console.log(`${failures.length} with errors:`)
  for (const f of failures) console.log(`  ${f.id}: ${f.errs.join(' | ').slice(0, 300)}`)
  process.exitCode = 1
}
