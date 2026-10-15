// CPU-profile one example for a few seconds and print self time by function.
//   node scripts/profile.mjs rt-100-channels [seconds]
import { checkServer, launch, openGallery, showExample } from './harness.mjs'

const id = process.argv[2] || 'rt-100-channels'
const secs = Number(process.argv[3] || 3)
await checkServer()
const browser = await launch({ width: 1920, height: 1080, uncapped: true })
const page = await openGallery(browser, 'storm')
await showExample(page, id, 3000)
const cdp = await page.createCDPSession()
await cdp.send('Profiler.enable')
await cdp.send('Profiler.setSamplingInterval', { interval: 200 })
await cdp.send('Profiler.start')
await new Promise((r) => setTimeout(r, secs * 1000))
const { profile } = await cdp.send('Profiler.stop')
await browser.close()
const dt = new Map()
const byId = new Map(profile.nodes.map((n) => [n.id, n]))
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i])
  const k = `${n.callFrame.functionName || '(anon)'}  ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber + 1}`
  dt.set(k, (dt.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0))
}
const total = [...dt.values()].reduce((a, b) => a + b, 0)
console.log(`${id}: ${(total / 1000).toFixed(0)} ms sampled`)
for (const [k, v] of [...dt.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`)
