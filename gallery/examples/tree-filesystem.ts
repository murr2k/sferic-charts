import { sferic, type HierarchyNodeData } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Disk Usage TreeMap (drill-down)',
  category: 'Hierarchy',
  order: 2,
  tags: ['treemap', 'drill-down', 'animation'],
  description:
    'A synthetic file system, four levels deep, colored per top-level folder. Three levels are shown at once; click any tile to zoom into its folder with an animated transition, and use the path buttons or right-click to go back up.',
  run({ container, theme }) {
    const r = rng(2024)
    const folderNames = ['src', 'assets', 'build', 'docs', 'cache', 'logs', 'data', 'lib', 'tests', 'media', 'backup', 'config', 'tmp', 'vendor']
    const exts = ['.bin', '.dat', '.mp4', '.png', '.zip', '.iso', '.log', '.db', '.pak', '.wav']
    const pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)]
    const files = (n: number, scale: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `${pick(['data', 'file', 'chunk', 'export', 'image', 'track', 'part'])}_${i + 1}${pick(exts)}`, value: Math.round(5 + Math.pow(r(), 2.4) * scale) }))
    const folder = (name: string, depth: number, scale: number): HierarchyNodeData => {
      const kids: HierarchyNodeData[] = []
      const nf = depth < 2 ? 3 + Math.floor(r() * 4) : 0
      const used = new Set<string>()
      for (let i = 0; i < nf; i++) {
        let fn = pick(folderNames)
        while (used.has(fn)) fn = pick(folderNames)
        used.add(fn)
        kids.push(folder(fn, depth + 1, scale * (0.4 + r() * 0.8)))
      }
      kids.push(...files(2 + Math.floor(r() * (depth < 2 ? 4 : 9)), scale))
      return { name, children: kids }
    }
    const top: [string, number][] = [['Games', 4200], ['Videos', 2600], ['Projects', 900], ['Users', 1500], ['Windows', 700], ['Program Files', 1100], ['Music', 500], ['Photos', 800]]
    const data = { name: 'C:\\', children: top.map(([n, s]) => folder(n, 0, s)) }

    const chart = sferic()
      .TreeMapChart({ container, theme })
      .setTitle('Disk Usage')
      .setInitialPathButtonText('C:\\')
      .setDisplayLevelCount(3)
      .setValueFormatter((v) => (v >= 1000 ? `${(v / 1000).toFixed(2)} GB` : `${Math.round(v)} MB`))
      .setData(data)
    return () => chart.dispose()
  },
} satisfies Example
