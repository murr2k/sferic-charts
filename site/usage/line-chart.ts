import { sferic, AxisTickStrategies } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Line chart',
  order: 1,
  summary: 'A date-time X axis, two series built from {x, y} objects, axis titles and units. Hover for values; wheel to zoom, drag to pan, double-click to reset.',
  run({ container, theme }) {
    // #region
    const chart = sferic().ChartXY({ container, theme }).setTitle('Daily mean temperature, 2025')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    chart.axisY.setTitle('Temperature').setUnits('°C')

    const day = 24 * 60 * 60 * 1000
    const jan1 = new Date(2025, 0, 1).getTime()
    const cities = [
      { name: 'Northern city', mean: 8, swing: 10, coldest: 15 },
      { name: 'Southern city', mean: 18, swing: 6, coldest: 197 },
    ]
    for (const city of cities) {
      chart
        .addLineSeries()
        .setName(city.name)
        .appendJSON(
          Array.from({ length: 365 }, (_, d) => ({
            x: jan1 + d * day,
            y: city.mean - city.swing * Math.cos(((d - city.coldest) / 365) * 2 * Math.PI) + (Math.random() - 0.5) * 4,
          })),
        )
    }
    // #endregion
  },
} satisfies Snippet
