// Count WebGL calls per frame for one example (diagnostic).
//   node scripts/glcount.mjs rt-100-channels
import { checkServer, launch, openGallery, showExample } from './harness.mjs'

const id = process.argv[2] || 'rt-100-channels'
await checkServer()
const browser = await launch({ width: 1920, height: 1080, uncapped: true })
const page = await openGallery(browser, 'storm')
await page.evaluate(() => {
  const counts = {}
  const proto = WebGL2RenderingContext.prototype
  for (const k of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, k)
    if (!d || typeof d.value !== 'function') continue
    const f = d.value
    proto[k] = function (...a) {
      counts[k] = (counts[k] || 0) + 1
      return f.apply(this, a)
    }
  }
  globalThis.__glCounts = counts
})
await showExample(page, id, 3000)
const res = await page.evaluate(async () => {
  const c = globalThis.__glCounts
  for (const k of Object.keys(c)) delete c[k]
  const f0 = globalThis.__sfericStats.frames
  await new Promise((r) => setTimeout(r, 2000))
  const frames = globalThis.__sfericStats.frames - f0
  const per = Object.entries(c).map(([k, v]) => [k, +(v / frames).toFixed(1)]).sort((a, b) => b[1] - a[1])
  return { frames, total: per.reduce((s, [, v]) => s + v, 0), per: per.slice(0, 25) }
})
await browser.close()
console.log(`${id}: ${res.frames} frames, ${res.total.toFixed(0)} GL calls per frame`)
for (const [k, v] of res.per) console.log(`  ${String(v).padStart(8)}  ${k}`)
