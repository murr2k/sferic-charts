import { sferic, LUT, PalettedFill, ColorRGBA, type CellContent } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Server Monitoring Grid',
  category: 'Other',
  order: 21,
  tags: ['datagrid', 'heatmap', 'lut', 'scrolling', 'real-time'],
  description:
    '2,000 hosts by 8 metrics. Cell backgrounds are PalettedFills, so each cell is colored by its own value through a LUT. Only visible rows are drawn: scroll with the wheel or drag the scrollbar. Values refresh every second.',
  run({ container, theme }) {
    const r = rng(11)
    const N = 2000
    const dcs = ['fra', 'ams', 'iad', 'sfo', 'sin', 'syd']
    const roles = ['web', 'api', 'db', 'cache', 'queue', 'batch']
    // [name, min, max, warn, crit, decimals, units]
    const metrics: [string, number, number, number, number, number, string][] = [
      ['CPU', 0, 100, 70, 90, 0, '%'], ['Memory', 0, 100, 75, 92, 0, '%'], ['Disk', 0, 100, 80, 95, 0, '%'], ['Load', 0, 16, 8, 12, 2, ''],
      ['Net in', 0, 1000, 700, 900, 0, ' Mb/s'], ['Latency', 1, 400, 150, 300, 0, ' ms'], ['Errors', 0, 50, 10, 30, 0, '/min'], ['Temp', 30, 95, 75, 85, 0, ' C'],
    ]
    const hosts = Array.from({ length: N }, (_, i) => {
      const hot = r() < 0.08
      return {
        name: `${dcs[i % dcs.length]}-${roles[Math.floor(r() * roles.length)]}-${String(i + 1).padStart(4, '0')}`,
        vals: metrics.map(([, lo, hi, warn]) => {
          const f = hot ? 0.8 + r() * 0.6 : Math.pow(r(), 1.6) * 0.85
          return Math.min(hi, lo + f * (warn - lo))
        }),
      }
    })
    const clampV = (m: number, v: number) => Math.max(metrics[m][1], Math.min(metrics[m][2], v))
    const cell = (m: number, v: number): CellContent => ({ value: clampV(m, v), text: `${clampV(m, v).toFixed(metrics[m][5])}${metrics[m][6]}` })

    // Healthy cells get only a faint tint so warnings and critical values stand out.
    const ok = theme.isDark ? ColorRGBA(60, 170, 100, 34) : ColorRGBA(40, 160, 90, 26)
    const warn = theme.isDark ? ColorRGBA(196, 150, 30, 175) : ColorRGBA(255, 205, 80, 190)
    const crit = theme.isDark ? ColorRGBA(205, 45, 45, 215) : ColorRGBA(232, 80, 70, 200)

    const grid = sferic().DataGrid({ container, theme }).setTitle(`Server Monitoring (${N.toLocaleString('en-US')} hosts)`)
    grid.setTableContent([
      ['Host', ...metrics.map((m) => m[0] + (m[6].trim() ? ` (${m[6].trim()})` : ''))],
      ...hosts.map((h) => [h.name, ...h.vals.map((v, m) => cell(m, v))]),
    ])
    metrics.forEach(([, lo, hi, w, c], m) => {
      const lut = new LUT({
        interpolate: true,
        steps: [
          { value: lo, color: ok },
          { value: w * 0.85, color: ok },
          { value: w, color: warn },
          { value: c, color: crit },
          { value: hi, color: crit },
        ],
      })
      grid.setColumnBackgroundFillStyle(m + 1, new PalettedFill({ lut }))
      grid.setColumnWidth(m + 1, { min: 92 })
    })
    grid.setColumnWidth(0, { min: 150 }).setCellChangeHighlight(false)

    const timer = setInterval(() => {
      for (let k = 0; k < 400; k++) {
        const i = Math.floor(r() * N)
        const m = Math.floor(r() * metrics.length)
        const [, lo, hi] = metrics[m]
        const h = hosts[i]
        h.vals[m] = clampV(m, h.vals[m] + (r() - 0.5) * (hi - lo) * 0.08)
        grid.setCellContent(m + 1, i + 1, cell(m, h.vals[m]))
      }
    }, 1000)
    return () => {
      clearInterval(timer)
      grid.dispose()
    }
  },
} satisfies Example
