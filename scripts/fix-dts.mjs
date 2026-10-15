// Post-process dist/types so the declarations resolve under moduleResolution
// node16 / nodenext: ESM requires explicit extensions on relative specifiers.
//   './lc'        -> './lc.js'
//   './chart3d'   -> './chart3d/index.js'   (directory import)
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const root = resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'dist', 'types')
if (!existsSync(root)) {
  console.error(`fix-dts: ${root} not found (run tsc first)`)
  process.exit(1)
}

const files = []
const walk = (d) => {
  for (const f of readdirSync(d)) {
    const p = join(d, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (p.endsWith('.d.ts')) files.push(p)
  }
}
walk(root)

// from '...', import('...'), export * from '...'
const spec = /(\bfrom\s+|\bimport\s*\(\s*)(['"])(\.{1,2}(?:\/[^'"]*)?)\2/g
let changed = 0, unresolved = []
for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const out = src.replace(spec, (m, pre, q, s) => {
    if (/\.(js|mjs|cjs|json)$/.test(s)) return m
    const base = resolve(dirname(file), s)
    if (existsSync(`${base}.d.ts`)) return `${pre}${q}${s}.js${q}`
    if (existsSync(join(base, 'index.d.ts'))) return `${pre}${q}${s}/index.js${q}`
    unresolved.push(`${file}: ${s}`)
    return m
  })
  if (out !== src) {
    writeFileSync(file, out)
    changed++
  }
}
if (unresolved.length) {
  console.error(`fix-dts: unresolved specifiers:\n  ${unresolved.join('\n  ')}`)
  process.exit(1)
}
console.log(`fix-dts: rewrote relative imports in ${changed} of ${files.length} declaration files`)
