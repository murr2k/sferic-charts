import { Themes, Theme } from '../src'
import type { Example } from './types'

const modules = import.meta.glob<{ default: Example }>('./examples/*.ts', { eager: true })
const sources = import.meta.glob<string>('./examples/*.ts', { eager: true, query: '?raw', import: 'default' })

interface Entry extends Example { id: string; source: string }

const CATEGORY_ORDER = ['XY', 'Real-time', 'Heatmaps', 'Dashboards', '3D', 'Polar', 'Bars', 'Pie & Gauges', 'Statistics', 'Hierarchy', 'Other']

const entries: Entry[] = Object.entries(modules)
  .map(([path, m]) => ({ ...m.default, id: path.replace(/^.*\/|\.ts$/g, ''), source: sources[path] ?? '' }))
  .sort((a, b) => {
    const ca = CATEGORY_ORDER.indexOf(a.category), cb = CATEGORY_ORDER.indexOf(b.category)
    return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb) || (a.order ?? 50) - (b.order ?? 50) || a.title.localeCompare(b.title)
  })

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const nav = $('nav')
const host = $('chart-host')
const titleEl = $('ex-title')
const catEl = $('ex-cat')
const descEl = $('desc')
const codeEl = $('code')
const sourcePane = $('source')
const btnSource = $<HTMLButtonElement>('btn-source')
const themeSel = $<HTMLSelectElement>('theme')
const search = $<HTMLInputElement>('search')
const fpsEl = $('fps')

// Listener registry so a hot update can unbind everything before re-running this module.
const offs: (() => void)[] = []
function on<K extends keyof HTMLElementEventMap>(el: HTMLElement | Window, type: K | string, fn: (e: any) => void) {
  el.addEventListener(type, fn)
  offs.push(() => el.removeEventListener(type, fn))
}

const store = {
  get(k: string) { try { return localStorage.getItem(k) } catch { return null } },
  set(k: string, v: string) { try { localStorage.setItem(k, v) } catch { /* quota or blocked */ } },
}

// ------------------------------------------------------------------ theme

const themeNames = Object.keys(Themes) as (keyof typeof Themes)[]
themeSel.innerHTML = ''
for (const n of themeNames) {
  const o = document.createElement('option')
  o.value = n
  o.textContent = n
  themeSel.appendChild(o)
}
let themeName = (store.get('sferic.theme') as keyof typeof Themes) || 'storm'
if (!Themes[themeName]) themeName = 'storm'
themeSel.value = themeName
const theme = (): Theme => Themes[themeName]
const applyPageTheme = () => {
  document.documentElement.dataset.theme = theme().isDark ? 'dark' : 'light'
}
applyPageTheme()
on(themeSel, 'change', () => {
  themeName = themeSel.value as keyof typeof Themes
  store.set('sferic.theme', themeName)
  applyPageTheme()
  route()
})

// ------------------------------------------------------------------ nav

function renderNav(filter = '') {
  nav.innerHTML = ''
  const f = filter.trim().toLowerCase()
  const cats = new Map<string, Entry[]>()
  for (const e of entries) {
    if (f && !(`${e.title} ${e.category} ${(e.tags ?? []).join(' ')} ${e.description}`.toLowerCase().includes(f))) continue
    if (!cats.has(e.category)) cats.set(e.category, [])
    cats.get(e.category)!.push(e)
  }
  for (const [cat, list] of cats) {
    const h = document.createElement('h3')
    h.textContent = cat
    nav.appendChild(h)
    for (const e of list) {
      const a = document.createElement('a')
      a.href = `#/${e.id}`
      a.textContent = e.title
      a.dataset.id = e.id
      nav.appendChild(a)
    }
  }
  markActive()
}
function markActive() {
  const id = currentId()
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.id === id))
}
on(search, 'input', () => renderNav(search.value))

// ------------------------------------------------------------------ source view

function highlight(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(\d[\d_]*\.?\d*(?:e[+-]?\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|of|in|new|import|from|export|default|async|await|true|false|null|undefined|type|interface|as|satisfies|class|extends)\b|\b([A-Za-z_$][\w$]*)(?=\()/g
  let out = ''
  let last = 0
  for (const m of src.matchAll(re)) {
    out += esc(src.slice(last, m.index))
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'k' : 'f'
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`
    last = m.index! + m[0].length
  }
  return out + esc(src.slice(last))
}
let showSource = store.get('sferic.source') === '1'
const syncSource = () => {
  sourcePane.hidden = !showSource
  btnSource.classList.toggle('on', showSource)
}
on(btnSource, 'click', () => {
  showSource = !showSource
  store.set('sferic.source', showSource ? '1' : '0')
  syncSource()
})
syncSource()

// ------------------------------------------------------------------ routing

let cleanup: (() => void) | null = null
const currentId = () => decodeURIComponent(location.hash.replace(/^#\/?/, ''))

function teardown() {
  try { cleanup?.() } catch (e) { console.error(e) }
  cleanup = null
  host.innerHTML = ''
}

function route() {
  teardown()
  markActive()
  const id = currentId()
  const e = entries.find((x) => x.id === id)
  if (!e) return showHome()
  titleEl.textContent = e.title
  catEl.textContent = e.category
  descEl.innerHTML = `${e.description}${e.tags?.length ? `<div class="tags" style="margin-top:6px">${e.tags.map((t) => `<span>${t}</span>`).join('')}</div>` : ''}`
  descEl.hidden = false
  codeEl.innerHTML = highlight(e.source)
  btnSource.hidden = false
  const div = document.createElement('div')
  div.style.cssText = 'position:absolute;inset:0;'
  host.appendChild(div)
  try {
    const c = e.run({ container: div, theme: theme() })
    cleanup = typeof c === 'function' ? c : null
  } catch (err) {
    console.error(err)
    div.innerHTML = `<pre style="color:#f66;padding:20px;white-space:pre-wrap">${String((err as Error)?.stack ?? err)}</pre>`
  }
}

// ------------------------------------------------------------------ home + thumbnails

const THUMB_VER = 'v3'
let thumbQueue: Entry[] = []
let thumbBusy = false

function showHome() {
  titleEl.textContent = `${entries.length} interactive examples`
  catEl.textContent = 'Sferic'
  descEl.hidden = true
  btnSource.hidden = true
  sourcePane.hidden = true
  const home = document.createElement('div')
  home.className = 'home'
  const cats = new Map<string, Entry[]>()
  for (const e of entries) {
    if (!cats.has(e.category)) cats.set(e.category, [])
    cats.get(e.category)!.push(e)
  }
  thumbQueue = []
  for (const [cat, list] of cats) {
    const h = document.createElement('h2')
    h.textContent = cat
    home.appendChild(h)
    const grid = document.createElement('div')
    grid.className = 'grid'
    for (const e of list) {
      const a = document.createElement('a')
      a.className = 'card'
      a.href = `#/${e.id}`
      const th = document.createElement('div')
      th.className = 'thumb'
      th.dataset.id = e.id
      const cached = store.get(`sferic.thumb.${THUMB_VER}.${themeName}.${e.id}`)
      if (cached) th.style.backgroundImage = `url(${cached})`
      else thumbQueue.push(e)
      a.appendChild(th)
      const meta = document.createElement('div')
      meta.className = 'meta'
      meta.innerHTML = `<b>${e.title}</b><small>${(e.tags ?? []).slice(0, 3).join(' · ')}</small>`
      a.appendChild(meta)
      grid.appendChild(a)
    }
    home.appendChild(grid)
  }
  host.appendChild(home)
  cleanup = () => { thumbQueue = [] }
  pumpThumbs()
}

/** Render examples one at a time in a hidden rig and snapshot their canvas. */
/** Keep only the current theme's thumbnails so the cache stays within localStorage quota. */
function pruneThumbs() {
  try {
    const keep = `sferic.thumb.${THUMB_VER}.${themeName}.`
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith('sferic.thumb.') && !k.startsWith(keep)) localStorage.removeItem(k)
    }
  } catch { /* storage unavailable */ }
}

async function pumpThumbs() {
  if (thumbBusy) return
  thumbBusy = true
  pruneThumbs()
  while (thumbQueue.length) {
    const e = thumbQueue.shift()!
    const rig = document.createElement('div')
    rig.style.cssText = 'position:fixed;left:0;top:0;width:640px;height:400px;opacity:0;pointer-events:none;z-index:-1;'
    document.body.appendChild(rig)
    let dispose: (() => void) | null = null
    try {
      const c = e.run({ container: rig, theme: theme() })
      dispose = typeof c === 'function' ? c : null
      await new Promise((r) => setTimeout(r, 1100))
      const canvas = rig.querySelector('canvas')
      if (canvas) {
        const url = await snapshot(canvas)
        if (url) {
          store.set(`sferic.thumb.${THUMB_VER}.${themeName}.${e.id}`, url)
          const el = host.querySelector<HTMLElement>(`.thumb[data-id="${e.id}"]`)
          if (el) el.style.backgroundImage = `url(${url})`
        }
      }
    } catch (err) {
      console.warn('thumbnail failed', e.id, err)
    }
    try { dispose?.() } catch { /* ignore */ }
    rig.remove()
  }
  thumbBusy = false
}

function snapshot(canvas: HTMLCanvasElement): Promise<string | null> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      try {
        const out = document.createElement('canvas')
        out.width = 360
        out.height = 225
        out.getContext('2d')!.drawImage(canvas, 0, 0, out.width, out.height)
        resolve(out.toDataURL('image/jpeg', 0.78))
      } catch {
        resolve(null)
      }
    })
  })
}

// ------------------------------------------------------------------ fps meter

let frames = 0
let t0 = performance.now()
let fpsRaf = 0
const loop = (t: number) => {
  frames++
  if (t - t0 >= 500) {
    fpsEl.textContent = `${Math.round((frames * 1000) / (t - t0))} fps`
    frames = 0
    t0 = t
  }
  fpsRaf = requestAnimationFrame(loop)
}
fpsRaf = requestAnimationFrame(loop)

// Dev helper: POST the current chart canvas to the Vite snapshot sink (see vite.config.ts).
if (import.meta.env.DEV) {
  ;(window as any).__snap = async (name: string) => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    const c = host.querySelector('canvas')
    if (!c) return 'no canvas'
    const b = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'))
    const res = await fetch(`/__snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: b })
    return `${c.width}x${c.height} -> ${await res.text()}`
  }
}

on(window, 'hashchange', route)
renderNav(search.value)
route()

// Hot updates (library or example edits) re-run the current example in place instead of reloading the page.
if (import.meta.hot) {
  import.meta.hot.accept()
  import.meta.hot.dispose(() => {
    teardown()
    thumbQueue = []
    offs.forEach((f) => f())
    cancelAnimationFrame(fpsRaf)
  })
}
