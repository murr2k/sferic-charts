import { sferic, AxisTickStrategies } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Line Series',
  category: 'XY',
  order: 1,
  tags: ['line', 'datetime', 'legend'],
  description:
    'Two line series on a DateTime X axis (synthetic hourly power prices). Hover for the cursor, wheel to zoom, left-drag a rectangle to zoom in (drag up-left to reset), right-drag to pan, double-click to fit.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Day-ahead vs. Intraday Power Price (synthetic)')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    const r = rng(2024)
    const t0 = new Date(2025, 2, 3).getTime()
    const H = 3600_000
    const dayAhead: { x: number; y: number }[] = []
    const intraday: { x: number; y: number }[] = []
    for (let h = 0; h < 21 * 24; h++) {
      const hod = h % 24
      const weekend = Math.floor(h / 24) % 7 >= 5
      // Morning and evening demand peaks, lower on weekends.
      const shape = 18 * Math.exp(-((hod - 8) ** 2) / 6) + 26 * Math.exp(-((hod - 19) ** 2) / 5) - (weekend ? 14 : 0)
      const base = 62 + shape + 6 * Math.sin(h / 60)
      dayAhead.push({ x: t0 + h * H, y: base })
      intraday.push({ x: t0 + h * H, y: base + (r() - 0.5) * 16 + (r() < 0.02 ? 35 : 0) })
    }
    chart.addLineSeries({ automaticColorIndex: 0 }).setName('Day-ahead').appendJSON(dayAhead)
    chart.addLineSeries({ automaticColorIndex: 1 }).setName('Intraday').appendJSON(intraday)
    chart.axisY.setTitle('Price').setUnits('EUR/MWh')
    return () => chart.dispose()
  },
} satisfies Example
