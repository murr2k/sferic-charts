// Diagnostic: stub individual WebGL calls in-page and see how the frame interval changes.
//   node scripts/gpu-experiment.mjs rt-100-channels bufferSubData,drawArraysInstanced
import { checkServer, launch, openGallery, showExample } from './harness.mjs'

const id = process.argv[2] || 'rt-100-channels'
const stubs = (process.argv[3] || '').split(',').filter(Boolean)
await checkServer()
const browser = await launch({ width: 1920, height: 1080, uncapped: true })
const page = await openGallery(browser, 'graphite')
await showExample(page, id, 3000)
const measure = () =>
  page.evaluate(
    () =>
      new Promise((res) => {
        const t = []
        let last = performance.now()
        let i = 0
        const f = (now) => {
          t.push(now - last)
          last = now
          if (++i < 150) requestAnimationFrame(f)
          else {
            t.sort((a, b) => a - b)
            res(t[75].toFixed(1))
          }
        }
        requestAnimationFrame(f)
      }),
  )
console.log(`baseline median frame: ${await measure()} ms`)
for (const s of stubs) {
  await page.evaluate((name) => {
    WebGL2RenderingContext.prototype[name] = function () {}
  }, s)
  console.log(`after stubbing ${s}: ${await measure()} ms`)
}
await browser.close()
