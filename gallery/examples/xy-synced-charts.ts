import { sferic, AxisTickStrategies, synchronizeAxisIntervals, synchronizeCursors, ChartXY } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Synchronized Charts',
  category: 'Dashboards',
  order: 2,
  tags: ['dashboard', 'synchronized axes', 'shared cursor'],
  description:
    'Three stacked charts share their X interval and cursor: zoom or pan any chart and the others follow; hovering one shows the matching values in all of them.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 3 })
    const r = rng(11)
    const t0 = new Date(2024, 0, 1).getTime()
    const n = 5000
    const names = ['CPU load (%)', 'Memory (GB)', 'Network (Mbit/s)']
    const charts: ChartXY[] = names.map((name, i) => {
      const c = dash.createChartXY({ columnIndex: 0, rowIndex: i, legend: { visible: false } }).setTitle(name).setPadding({ top: 4, bottom: 4 })
      c.axisX.setTickStrategy(AxisTickStrategies.DateTime)
      c.axisY.setThickness(70)
      let y = 50
      const pts = Array.from({ length: n }, (_, k) => {
        y += (r() - 0.5) * (i === 2 ? 18 : 4) + (50 - y) * 0.02
        return { x: t0 + k * 60_000, y: i === 1 ? y / 6 : Math.max(0, y) }
      })
      c.addAreaSeries({ automaticColorIndex: [0, 4, 2][i], baseline: 0 }).setName(name).appendJSON(pts)
      return c
    })
    synchronizeAxisIntervals(...charts.map((c) => c.axisX))
    synchronizeCursors(...charts)
    return () => dash.dispose()
  },
} satisfies Example
