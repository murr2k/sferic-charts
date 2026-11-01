import { Themes, debug, type Theme } from 'sferic-charts'
import type { Example } from '../gallery/types'
import { highlight } from '../gallery/highlight'
import { ParamPanel } from '../gallery/params'
import type { Snippet } from './usage/snippet'
import { checkSyntax, extractSnippet, runSnippet } from './runner'

// ------------------------------------------------------------------ content

/** Gallery examples featured on the page, by section. */
interface Card { id: string; wide?: boolean; height?: number; manual?: string }
const SECTIONS: Record<string, Card[]> = {
  live: [
    { id: 'live-earthquakes', wide: true, height: 620 },
    { id: 'live-weather', wide: true, height: 480 },
    { id: 'live-microphone', height: 460 },
    { id: 'live-page-telemetry', height: 460 },
  ],
  science: [
    { id: 'phys-wave-equation', wide: true, height: 470 },
    { id: 'phys-double-pendulum', wide: true, height: 460 },
    { id: 'phys-hydrogen-orbitals', height: 480 },
    { id: 'math-fourier-series', height: 480 },
    { id: 'math-mandelbrot', wide: true, height: 560 },
    { id: 'math-logistic-map', wide: true, height: 540 },
    { id: '3d-lorenz', height: 440 },
    { id: 'polar-em-field', height: 440 },
  ],
  scale: [
    { id: 'rt-100-channels', wide: true, height: 600 },
    { id: 'xy-large-line', height: 440, manual: 'Generate 10 million points' },
    { id: 'xy-scatter-million', height: 440, manual: 'Generate 1 million points' },
    { id: '3d-spectrogram', height: 440 },
    { id: 'grid-crypto', height: 440 },
    { id: 'trading-candlestick', wide: true, height: 540 },
  ],
}
const HERO = 'rt-vlf-receiver'
const REPO = 'https://github.com/murr2k/sferic-charts'

const modules = import.meta.glob<{ default: Example }>(
  [
    '../gallery/examples/rt-vlf-receiver.ts',
    '../gallery/examples/live-*.ts',
    '../gallery/examples/phys-*.ts',
    '../gallery/examples/math-*.ts',
    '../gallery/examples/3d-lorenz.ts',
    '../gallery/examples/polar-em-field.ts',
    '../gallery/examples/rt-100-channels.ts',
    '../gallery/examples/xy-large-line.ts',
    '../gallery/examples/xy-scatter-million.ts',
    '../gallery/examples/3d-spectrogram.ts',
    '../gallery/examples/grid-crypto.ts',
    '../gallery/examples/trading-candlestick.ts',
  ],
  { eager: true },
)
const sources = import.meta.glob<string>(
  ['../gallery/examples/*.ts'],
  { query: '?raw', import: 'default' },
)
const examples = new Map(Object.entries(modules).map(([path, m]) => [path.replace(/^.*\/|\.ts$/g, ''), m.default]))
const sourceOf = (id: string) => sources[`../gallery/examples/${id}.ts`]?.() ?? Promise.resolve('// source not found')
const galleryUrl = (id = '') => (import.meta.env.DEV ? '/' : './gallery/') + (id ? `#/${id}` : '')

const snippetMods = import.meta.glob<{ default?: Snippet }>('./usage/*.ts', { eager: true })
const snippetRaw = import.meta.glob<string>('./usage/*.ts', { eager: true, query: '?raw', import: 'default' })
const snippets = Object.entries(snippetMods)
  .filter(([, m]) => m.default?.title)
  .map(([path, m]) => ({ ...m.default!, id: path.replace(/^.*\/|\.ts$/g, ''), code: extractSnippet(snippetRaw[path] ?? '') }))
  .sort((a, b) => a.order - b.order)

// ------------------------------------------------------------------ helpers

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => root.querySelector(sel) as T
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* storage unavailable */ } },
}
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

async function copy(text: string, button: HTMLElement) {
  try {
    await navigator.clipboard.writeText(text)
    const old = button.textContent
    button.textContent = 'Copied'
    setTimeout(() => (button.textContent = old), 1200)
  } catch { /* clipboard blocked */ }
}

// ------------------------------------------------------------------ theme

type ThemeKey = keyof typeof Themes
let themeKey = (store.get('sferic.theme') as ThemeKey) || 'storm'
if (!Themes[themeKey]) themeKey = 'storm'
const theme = (): Theme => Themes[themeKey]
const themeSel = $<HTMLSelectElement>('#theme')
for (const k of Object.keys(Themes) as ThemeKey[]) themeSel.append(new Option(k[0].toUpperCase() + k.slice(1), k))
themeSel.value = themeKey
const applyTheme = () => {
  document.documentElement.dataset.theme = themeKey
  document.documentElement.style.colorScheme = theme().isDark ? 'dark' : 'light'
}
applyTheme()
themeSel.addEventListener('change', () => {
  themeKey = themeSel.value as ThemeKey
  store.set('sferic.theme', themeKey)
  applyTheme()
  for (const l of lives) l.restart()
})

// ------------------------------------------------------------------ live mounts

/**
 * A chart slot that builds its content only while on screen (or after a click for heavy
 * demos) and disposes it when scrolled away, so streams and simulations run only where
 * someone is looking. All of them share the library's single WebGL context.
 */
class Live {
  private cleanup: (() => void) | null = null
  private timer = 0
  armed: boolean
  constructor(
    readonly stage: HTMLElement,
    private readonly build: (container: HTMLElement) => (() => void) | void,
    readonly manual: boolean,
    private readonly onError?: (e: unknown) => void,
  ) {
    this.armed = !manual
  }
  get running() { return !!this.cleanup }
  start() {
    if (this.cleanup) return
    const host = el('div', 'host')
    this.stage.prepend(host)
    this.stage.classList.add('running')
    this.stage.querySelector('.stage-error')?.remove()
    try {
      const dispose = this.build(host)
      this.cleanup = () => {
        try { dispose?.() } catch (e) { console.error(e) }
      }
    } catch (e) {
      this.cleanup = () => {}
      if (this.onError) this.onError(e)
      else this.showError(e)
    }
    updateLiveCount()
  }
  stop() {
    clearTimeout(this.timer)
    if (!this.cleanup) return
    this.cleanup()
    this.cleanup = null
    this.stage.querySelector('.host')?.remove()
    this.stage.classList.remove('running')
    if (this.manual) this.armed = false
    updateLiveCount()
  }
  restart() {
    if (!this.cleanup) return
    this.stop()
    this.armed = true
    this.start()
  }
  run() {
    this.armed = true
    this.start()
  }
  setVisible(visible: boolean) {
    clearTimeout(this.timer)
    if (visible && this.armed) this.timer = window.setTimeout(() => this.start(), 80)
    else if (!visible) this.timer = window.setTimeout(() => this.stop(), 700)
  }
  private showError(e: unknown) {
    console.error(e)
    this.stage.append(el('pre', 'stage-error', esc(String((e as Error)?.stack ?? e))))
  }
}

const lives: Live[] = []
const byStage = new Map<Element, Live>()
const observer = new IntersectionObserver(
  (entries) => { for (const e of entries) byStage.get(e.target)?.setVisible(e.isIntersecting) },
  { rootMargin: '120px 0px' },
)
function register(live: Live) {
  lives.push(live)
  byStage.set(live.stage, live)
  observer.observe(live.stage)
  engageable(live.stage)
  return live
}

// ------------------------------------------------------------------ scrolling past charts

/**
 * Charts take the mouse wheel (zoom) and every touch gesture, which would trap a reader
 * scrolling down a page made of charts. Until a chart is engaged, wheel events stop at
 * its stage (the page scrolls; Ctrl or Cmd + wheel still zooms) and touch allows vertical
 * page panning. A mouse press or a tap engages a chart; leaving it with the mouse or
 * pressing anywhere else releases it.
 */
const IS_MAC = /Mac|iPhone|iPad/.test(navigator.userAgent)
function engageable(stage: HTMLElement) {
  const hint = el('div', 'wheel-hint')
  stage.append(hint)
  let hintTimer = 0
  const flash = (text: string) => {
    hint.textContent = text
    hint.classList.add('show')
    clearTimeout(hintTimer)
    hintTimer = window.setTimeout(() => hint.classList.remove('show'), 1600)
  }
  const engage = (touch: boolean) => {
    if (stage.classList.contains('engaged')) return
    stage.classList.add('engaged')
    if (touch) flash('Chart active: drag to pan or rotate, pinch to zoom')
  }
  stage.addEventListener(
    'wheel',
    (e) => {
      if (e.ctrlKey || e.metaKey || stage.classList.contains('engaged')) return
      e.stopPropagation() // never reaches the chart, so the page scrolls
      flash(`${IS_MAC ? '⌘' : 'Ctrl'} + scroll to zoom, or click the chart`)
    },
    { capture: true, passive: true },
  )
  stage.addEventListener('pointerdown', (e) => e.pointerType === 'mouse' && engage(false), { capture: true })
  // Touch engages on a tap only, so a swipe that scrolls the page does not arm the chart.
  stage.addEventListener('click', () => engage(true), { capture: true })
  stage.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') stage.classList.remove('engaged')
  })
}
document.addEventListener(
  'pointerdown',
  (e) => {
    for (const s of document.querySelectorAll('.stage.engaged')) if (!s.contains(e.target as Node)) s.classList.remove('engaged')
  },
  { capture: true },
)
const liveCountEl = $('#st-live')
function updateLiveCount() {
  const n = lives.filter((l) => l.running).length
  liveCountEl.textContent = String(n)
}

function manualOverlay(live: Live, label: string) {
  const b = el('button', 'run-overlay', `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14l11-7z" fill="currentColor"/></svg><span>${esc(label)}</span>`)
  b.addEventListener('click', () => live.run())
  live.stage.append(b)
}

// ------------------------------------------------------------------ cards

function exampleCard(spec: Card) {
  const ex = examples.get(spec.id)
  if (!ex) throw new Error(`site: unknown example ${spec.id}`)
  const card = el('article', `card${spec.wide ? ' wide' : ''}`)
  card.id = `demo-${spec.id}`
  card.innerHTML = `
    <header class="card-head">
      <div class="card-title"><span class="eyebrow">${esc(ex.category)}</span><h3>${esc(ex.title)}</h3></div>
      <div class="card-actions">
        <button class="btn ghost" data-act="source" title="View the source of this example">Source</button>
        <a class="btn ghost" href="${galleryUrl(spec.id)}" target="_blank" rel="noopener" title="Open in the gallery">Gallery</a>
      </div>
    </header>
    <div class="stage" style="--h:${spec.height ?? 440}px"></div>
    <p class="card-desc">${esc(ex.description)}</p>
    <div class="tags">${(ex.tags ?? []).map((t) => `<span>${esc(t)}</span>`).join('')}</div>`
  const stage = $('.stage', card)
  const manual = !!spec.manual || reducedMotion
  // Sliders keep their values across re-runs (theme changes, scrolling away and back).
  const panel = ex.params?.length ? new ParamPanel(ex.params, () => live.restart()) : null
  const live = register(new Live(stage, (container) => ex.run({ container, theme: theme(), ...panel?.context() }), manual))
  if (panel) stage.after(panel.render())
  if (manual) manualOverlay(live, spec.manual ?? 'Run demo')
  $('[data-act=source]', card).addEventListener('click', () => showSource(spec.id, ex.title))
  return card
}

for (const [section, cards] of Object.entries(SECTIONS)) {
  const grid = $(`[data-cards="${section}"]`)
  for (const c of cards) grid.append(exampleCard(c))
}

// Hero
{
  const stage = $('#hero-stage')
  const ex = examples.get(HERO)!
  const panel = ex.params?.length ? new ParamPanel(ex.params, () => live.restart()) : null
  const live = register(new Live(stage, (container) => ex.run({ container, theme: theme(), ...panel?.context() }), reducedMotion))
  if (panel) stage.after(panel.render())
  if (reducedMotion) manualOverlay(live, 'Start the receiver')
  $('#hero-source').addEventListener('click', () => showSource(HERO, ex.title))
}

for (const a of document.querySelectorAll<HTMLAnchorElement>('a[data-gallery]')) a.href = galleryUrl()

// ------------------------------------------------------------------ source dialog

const dlg = $<HTMLDialogElement>('#src-dialog')
let dlgText = ''
async function showSource(id: string, title: string) {
  $('#src-title').textContent = title
  $<HTMLAnchorElement>('#src-file').href = `${REPO}/blob/main/gallery/examples/${id}.ts`
  $('#src-file').textContent = `gallery/examples/${id}.ts`
  $('#src-code').innerHTML = ''
  dlg.showModal()
  dlgText = (await sourceOf(id)).replace(/\r\n/g, '\n')
  $('#src-code').innerHTML = highlight(dlgText)
}
$('#src-close').addEventListener('click', () => dlg.close())
$('#src-copy').addEventListener('click', (e) => copy(dlgText, e.currentTarget as HTMLElement))
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close() })

// ------------------------------------------------------------------ usage editor

{
  const tabs = $('#usage-tabs')
  const ta = $<HTMLTextAreaElement>('#editor-input')
  const hl = $('#editor-hl code')
  const scroller = $('.editor')
  const err = $('#editor-error')
  const title = $('#usage-title')
  const summary = $('#usage-summary')
  const edits = new Map<string, string>()
  let current = snippets[0]
  let pendingRun = 0

  // The editor is a transparent textarea (caret, selection, input) over the highlighted text.
  // The highlighted <pre> sets the size of both, the textarea never scrolls itself, and one
  // outer element (.editor) scrolls the pair, so the two layers cannot drift apart.
  // The extra line and right padding leave room for the next keystroke before the repaint.
  const paint = () => {
    hl.innerHTML = highlight(ta.value) + '\n '
    if (ta.scrollLeft || ta.scrollTop) {
      ta.scrollLeft = 0
      ta.scrollTop = 0
    }
  }
  let cell: { w: number; h: number; left: number; top: number } | null = null
  const measureCell = () => {
    const cs = getComputedStyle(ta)
    const g = document.createElement('canvas').getContext('2d')!
    g.font = `${cs.fontSize} ${cs.fontFamily}`
    return { w: g.measureText('0'.repeat(50)).width / 50, h: parseFloat(cs.lineHeight), left: parseFloat(cs.paddingLeft), top: parseFloat(cs.paddingTop) }
  }
  /** Scroll the editor so the caret stays in view. */
  const followCaret = () => {
    cell ??= measureCell()
    const before = ta.value.slice(0, ta.selectionEnd)
    const line = (before.match(/\n/g) ?? []).length
    const col = before.length - before.lastIndexOf('\n') - 1
    const x = cell.left + col * cell.w, y = cell.top + line * cell.h
    const m = 2 * cell.w
    if (x < scroller.scrollLeft + m) scroller.scrollLeft = Math.max(0, x - 4 * cell.w)
    else if (x > scroller.scrollLeft + scroller.clientWidth - m) scroller.scrollLeft = x - scroller.clientWidth + 4 * cell.w
    if (y < scroller.scrollTop) scroller.scrollTop = Math.max(0, y - cell.h)
    else if (y + cell.h > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = y + 2 * cell.h - scroller.clientHeight
  }
  const setError = (e: unknown) => {
    err.hidden = !e
    err.textContent = e ? `${(e as Error).name ?? 'Error'}: ${(e as Error).message ?? e}` : ''
  }
  const live = register(
    new Live(
      $('#usage-stage'),
      (container) => {
        setError(null)
        return runSnippet(ta.value, container, theme())
      },
      reducedMotion,
      (e) => setError(e),
    ),
  )
  if (reducedMotion) manualOverlay(live, 'Run example')
  const rerun = () => {
    clearTimeout(pendingRun)
    try {
      checkSyntax(ta.value)
    } catch (e) {
      setError(e) // keep the last working preview while the code does not parse
      return
    }
    live.stop()
    live.run()
  }

  const select = (s: (typeof snippets)[number]) => {
    current = s
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.dataset.id === s.id))
    title.textContent = s.title
    summary.textContent = s.summary
    ta.value = edits.get(s.id) ?? s.code
    paint()
    scroller.scrollTop = 0
    scroller.scrollLeft = 0
    setError(null)
    // Off-screen, the observer starts the preview when it scrolls into view.
    if (live.running) rerun()
  }
  for (const s of snippets) {
    const b = el('button', 'tab', esc(s.title))
    b.dataset.id = s.id
    b.setAttribute('role', 'tab')
    b.addEventListener('click', () => select(s))
    tabs.append(b)
  }
  ta.addEventListener('input', () => {
    paint()
    followCaret()
    edits.set(current.id, ta.value)
    clearTimeout(pendingRun)
    pendingRun = window.setTimeout(rerun, 900)
  })
  // If the browser scrolls the textarea itself (a paste wider than the slack), undo that and
  // scroll the outer element instead, so the layers stay aligned.
  ta.addEventListener('scroll', () => {
    if (!ta.scrollLeft && !ta.scrollTop) return
    ta.scrollLeft = 0
    ta.scrollTop = 0
    followCaret()
  })
  // Follow caret moves made with the keyboard only. selectionchange arrives asynchronously,
  // sometimes after the mouse button is released, and scrolling after a click would shift
  // the text the reader just clicked into.
  let keyboardCaret = false
  ta.addEventListener('keydown', () => { keyboardCaret = true })
  ta.addEventListener('pointerdown', () => { keyboardCaret = false })
  document.addEventListener('selectionchange', () => {
    if (keyboardCaret && document.activeElement === ta) followCaret()
  })
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      rerun()
    }
  })
  $('#editor-run').addEventListener('click', rerun)
  $('#editor-reset').addEventListener('click', () => {
    edits.delete(current.id)
    ta.value = current.code
    paint()
    rerun()
  })
  $('#editor-copy').addEventListener('click', (e) => copy(ta.value, e.currentTarget as HTMLElement))
  select(snippets[0])
}

// ------------------------------------------------------------------ install + stats

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-copy]')) b.addEventListener('click', () => copy(b.dataset.copy!, b))
$('#static-code').innerHTML = highlight($('#static-code').textContent ?? '')

const fpsEl = $('#st-fps')
const msEl = $('#st-ms')
const costs: number[] = []
debug.onFrame = (ms) => { if (costs.length < 2000) costs.push(ms) }
let frames = 0
let t0 = performance.now()
const meter = (t: number) => {
  frames++
  if (t - t0 >= 1000) {
    fpsEl.textContent = String(Math.round((frames * 1000) / (t - t0)))
    const s = costs.splice(0).sort((a, b) => a - b)
    msEl.textContent = s.length ? s[s.length >> 1].toFixed(1) : '0.0'
    frames = 0
    t0 = t
  }
  requestAnimationFrame(meter)
}
requestAnimationFrame(meter)

if (!document.createElement('canvas').getContext('webgl2')) $('#no-webgl').hidden = false
