// Screenshot gallery examples in headless Chrome.
//   npm run snap                         all examples, storm theme, chart area only
//   npm run snap -- --filter rt-,xy-log  subset (comma-separated substrings)
//   npm run snap -- --theme daylight --full --size 1280x800 --dpr 2
// Output: .snapshots/<theme>/<id>.png plus a summary of page errors.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { args, checkServer, launch, openGallery, showExample, exampleIds, gpuInfo, settleFor, ROOT } from './harness.mjs'

const o = args({ theme: 'storm', filter: '', size: '1600x900', dpr: 1, wait: 1500, full: false, out: '' })
const [width, height] = String(o.size).split('x').map(Number)
await checkServer()
const outDir = o.out || join(ROOT, '.snapshots', String(o.theme))
mkdirSync(outDir, { recursive: true })

const browser = await launch({ width, height, dpr: o.dpr })
const page = await openGallery(browser, o.theme)
const gpu = await gpuInfo(page)
console.log(`GPU: ${gpu}`)
// Without WebGL2 every GPU-drawn example renders blank but raises no page error.
if (gpu === 'no WebGL2') {
  console.error('No WebGL2 in this browser: GPU-rendered content would be blank. Snapshots not taken.')
  await browser.close()
  process.exit(1)
}
if (/SwiftShader|llvmpipe|software/i.test(gpu)) console.warn('Note: software rendering; snapshots are valid but slow.')
const ids = exampleIds(o.filter)
const failures = []
const t0 = Date.now()
for (const id of ids) {
  await showExample(page, id, settleFor(id, o.wait))
  const file = join(outDir, `${id}.png`)
  if (o.full) await page.screenshot({ path: file })
  else {
    const el = await page.$('#chart-host')
    await (el ?? page).screenshot({ path: file })
  }
  const glError = await page.evaluate(() => window.__sfericDebug?.glError?.() ?? null)
  if (glError) page.__errors.push(`GPU context unavailable: ${glError}`)
  const errs = [...new Set(page.__errors)]
  if (errs.length) failures.push({ id, errs })
  console.log(`${errs.length ? 'ERR ' : 'ok  '} ${id}${errs.length ? '  ' + errs[0].slice(0, 160) : ''}`)
}
await browser.close()
console.log(`\n${ids.length} examples in ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${outDir}`)
if (failures.length) {
  console.log(`${failures.length} with errors:`)
  for (const f of failures) console.log(`  ${f.id}: ${f.errs.join(' | ').slice(0, 300)}`)
  process.exitCode = 1
}
