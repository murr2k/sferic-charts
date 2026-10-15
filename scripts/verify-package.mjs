// Pre-publish gate: pack the library, install the tarball into a throwaway project and
// check what a consumer would get. Exits non-zero on any failure.
//   npm run verify:package        (also run by prepublishOnly)
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const ROOT = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
const work = mkdtempSync(join(tmpdir(), 'sferic-verify-'))
const results = []
const check = (name, fn) => {
  try {
    const detail = fn()
    results.push({ name, ok: true, detail: detail ?? '' })
  } catch (e) {
    results.push({ name, ok: false, detail: String(e.stdout ?? '') + String(e.message ?? e).split('\n')[0] })
  }
}
const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'pipe', encoding: 'utf8' })

try {
  // 1. Pack
  const pack = JSON.parse(run(`npm pack --json --pack-destination "${work}"`, ROOT))[0]
  const files = pack.files.map((f) => f.path)
  check('package contents', () => {
    const need = ['package.json', 'README.md', 'LICENSE', 'dist/sferic.js', 'dist/sferic.umd.cjs', 'dist/types/index.d.ts']
    const missing = need.filter((f) => !files.includes(f))
    if (missing.length) throw new Error(`missing ${missing.join(', ')}`)
    const stray = files.filter((f) => !/^(package\.json|README\.md|LICENSE|dist\/)/.test(f))
    if (stray.length) throw new Error(`unexpected files ${stray.join(', ')}`)
    return `${files.length} files, ${(pack.size / 1048576).toFixed(2)} MB packed`
  })

  // 2. Forbidden content in what ships
  check('no forbidden strings in dist', () => {
    const bad = [
      [/lightningchart|\bLCJS\b|arction/i, 'third-party product name'],
      [/globalThis\.__sferic|window\.__sferic/, 'debug global'],
      [/[A-Za-z]:[\\/]+Users[\\/]/, 'local absolute path'],
    ]
    const hits = []
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (statSync(p).isDirectory()) walk(p)
        else {
          const s = readFileSync(p, 'utf8')
          for (const [re, what] of bad) if (re.test(s)) hits.push(`${p.slice(ROOT.length + 1)}: ${what}`)
        }
      }
    }
    walk(join(ROOT, 'dist'))
    if (hits.length) throw new Error(hits.join('; '))
  })

  // 3. Install into a clean consumer
  const app = join(work, 'app')
  run(`mkdir "${app}"`, work)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }))
  run(`npm install "${join(work, pack.filename)}" --no-audit --no-fund --loglevel=error`, app)
  check('installs with zero runtime dependencies', () => {
    const lock = JSON.parse(readFileSync(join(app, 'package-lock.json'), 'utf8'))
    const extra = Object.keys(lock.packages).filter((k) => k && k !== 'node_modules/sferic-charts')
    if (extra.length) throw new Error(`pulled in ${extra.join(', ')}`)
  })

  // 4. Runtime imports without a DOM (SSR safety)
  check('ESM import in Node', () => run(`node -e "import('sferic-charts').then(m => { if (typeof m.sferic !== 'function') process.exit(2); if ('lightningChart' in m) process.exit(3) })"`, app))
  check('CommonJS require in Node', () => run(`node -e "const m = require('sferic-charts'); if (typeof m.sferic !== 'function') process.exit(2)"`, app))

  // 5. Type resolution as a consumer, strict, without skipLibCheck
  writeFileSync(
    join(app, 'app.ts'),
    `import { sferic, Themes, AxisTickStrategies, LUT, PalettedFill, regularColorSteps } from 'sferic-charts'
const c = sferic().ChartXY({ container: 'x', theme: Themes.storm })
c.axisX.setTickStrategy(AxisTickStrategies.DateTime)
c.addLineSeries().appendJSON([{ x: 1, y: 2 }])
const lut = new LUT({ steps: regularColorSteps(0, 1, Themes.storm.examples.intensityColorPalette) })
c.addHeatmapGridSeries({ columns: 2, rows: 2 }).setFillStyle(new PalettedFill({ lut }))
sferic().Chart3D({ container: 'y' }).addPointSeries().appendJSON([{ x: 1, y: 2, z: 3 }])
`,
  )
  for (const [mod, res] of [['esnext', 'bundler'], ['node16', 'node16'], ['nodenext', 'nodenext']]) {
    check(`types: moduleResolution ${res}`, () =>
      run(`node "${TSC}" --noEmit --strict --skipLibCheck false --target es2022 --lib es2022,dom --module ${mod} --moduleResolution ${res} app.ts`, app),
    )
  }
} catch (e) {
  results.push({ name: 'setup', ok: false, detail: String(e.message ?? e).split('\n')[0] })
} finally {
  rmSync(work, { recursive: true, force: true })
}

for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail.trim().slice(0, 300)})` : ''}`)
const failed = results.filter((r) => !r.ok).length
console.log(failed ? `\n${failed} check(s) failed` : '\nall package checks passed')
console.log('Reminder: run `npm run snap` with the dev server up for a visual check before publishing.')
process.exit(failed ? 1 : 0)
