// Shared headless-Chrome harness for gallery snapshots and benchmarks.
// Drives the running dev server (http://127.0.0.1:8779 by default, see run.cmd).
import puppeteer from 'puppeteer-core'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export const BASE = process.env.SFERIC_URL || 'http://127.0.0.1:8779'
export const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

export function chromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  const hit = candidates.find((p) => existsSync(p))
  if (!hit) throw new Error('No Chrome/Edge found; set CHROME_PATH')
  return hit
}

/** Simple --key value / --flag argument parser. */
export function args(defaults) {
  const out = { ...defaults }
  const a = process.argv.slice(2)
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue
    const k = a[i].slice(2)
    const v = a[i + 1] && !a[i + 1].startsWith('--') ? a[++i] : true
    out[k] = typeof defaults[k] === 'number' ? Number(v) : v
  }
  return out
}

export async function checkServer() {
  try {
    const r = await fetch(BASE)
    if (r.ok) return
  } catch { /* fall through */ }
  console.error(`Gallery not reachable at ${BASE}. Start it first (run.cmd or npm run dev).`)
  process.exit(1)
}

/**
 * Launch headless Chrome with the GPU enabled.
 * uncapped: disable vsync / frame-rate limit so rAF reports real headroom.
 */
export async function launch({ width = 1600, height = 900, dpr = 1, uncapped = false, extraArgs = [] } = {}) {
  const flags = [
    '--use-angle=d3d11',
    '--enable-gpu',
    '--ignore-gpu-blocklist',
    '--enable-webgl',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    `--window-size=${width},${height}`,
  ]
  if (uncapped) flags.push('--disable-gpu-vsync', '--disable-frame-rate-limit')
  flags.push(...extraArgs)
  // Extra Chrome flags for any script, e.g. SFERIC_CHROME_ARGS="--disable-webgl --disable-webgl2"
  flags.push(...(process.env.SFERIC_CHROME_ARGS ?? '').split(/\s+/).filter(Boolean))
  return puppeteer.launch({
    executablePath: chromePath(),
    headless: true,
    args: flags,
    defaultViewport: { width, height, deviceScaleFactor: dpr },
    protocolTimeout: 240_000,
  })
}

const CANARY = 'WebGL: INVALID_OPERATION: sferic harness canary'

/**
 * Fail fast unless the console hook records a planted WebGL warning. Puppeteer once
 * renamed the warning type ('warning' -> 'warn') and every WebGL warning went unseen.
 */
async function assertSeesWarnings(page) {
  await page.evaluate((t) => console.warn(t), CANARY)
  for (let i = 0; i < 100 && !page.__errors.includes(CANARY); i++) await new Promise((r) => setTimeout(r, 10))
  if (!page.__errors.includes(CANARY)) throw new Error('harness: the console hook did not record a planted WebGL warning')
  page.__errors.length = 0
}

/** Open the gallery with a theme preset; collects page errors into page.__errors. */
export async function openGallery(browser, theme = 'storm') {
  return openPage(browser, '/#/', theme)
}

/**
 * Open a dev-server page (path relative to BASE) with a theme preset. Page errors and
 * WebGL warnings are collected into page.__errors; console errors from `ignoreHosts`
 * (third-party data a demo fetches, which may be offline) go to page.__external instead.
 */
export async function openPage(browser, path, theme = 'storm', { ignoreHosts = [] } = {}) {
  const page = await browser.newPage()
  page.__errors = []
  page.__external = []
  await page.evaluateOnNewDocument((t) => {
    try {
      localStorage.setItem('sferic.theme', t)
      localStorage.setItem('sferic.source', '0')
    } catch { /* ignore */ }
  }, theme)
  page.on('pageerror', (e) => page.__errors.push(String(e?.message ?? e)))
  page.on('console', (m) => {
    // WebGL validation failures (feedback loops, invalid ops) only show up as warnings.
    // Puppeteer reports them as 'warn' ('warning' in older versions).
    const warn = m.type() === 'warn' || m.type() === 'warning'
    const gl = warn && /WebGL|GL_INVALID|GL ERROR/i.test(m.text())
    if (m.type() !== 'error' && !gl) return
    const url = m.location()?.url ?? ''
    if (/favicon\.ico$/.test(url)) return
    if (ignoreHosts.some((h) => url.includes(h))) return page.__external.push(`${m.text()} (${url})`)
    page.__errors.push(m.text())
  })
  await page.goto(`${BASE}${path}`, { waitUntil: 'load' })
  await assertSeesWarnings(page)
  return page
}

/** Route the gallery to an example (in-place hash routing) and wait for a canvas. */
export async function showExample(page, id, settleMs = 1500) {
  page.__errors.length = 0
  await page.evaluate((h) => { location.hash = h }, `#/${id}`)
  await page.waitForFunction(() => !!document.querySelector('#chart-host canvas'), { timeout: 20_000 }).catch(() => {})
  await new Promise((r) => setTimeout(r, settleMs))
}

export function exampleIds(filter) {
  const ids = readdirSync(join(ROOT, 'gallery', 'examples'))
    .filter((f) => f.endsWith('.ts'))
    .map((f) => f.slice(0, -3))
    .sort()
  if (!filter || filter === true) return ids
  const parts = String(filter).split(',')
  return ids.filter((id) => parts.some((p) => id.includes(p)))
}

/** Which GPU backs WebGL in this browser (to tell hardware from SwiftShader). */
export async function gpuInfo(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return 'no WebGL2'
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)
  })
}

/** Per-example settle times for heavy loads (ms). */
export const SETTLE = {
  'xy-large-line': 6000,
  'xy-datetime-zoom': 6000,
  'xy-high-precision': 3000,
  'xy-scatter-million': 3000,
  'million-points': 3500,
  'heatmap-grid': 2500,
  'map-': 5000,
  'rt-': 2500,
  '3d-': 2500,
  'live-': 5000,
  'math-': 2500,
  'phys-': 2500,
}
export const settleFor = (id, base) => {
  for (const [k, v] of Object.entries(SETTLE)) if (id === k || (k.endsWith('-') && id.startsWith(k))) return Math.max(v, base)
  return base
}
