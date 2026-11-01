import { sferic, synchronizeAxisIntervals, synchronizeCursors } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Dashboard with linked charts',
  order: 4,
  summary: 'Three charts on one canvas. Their X axes and cursors are synchronized: zoom or pan any of them and the others follow; hover to read all three at once. Drag the splitters to resize.',
  run({ container, theme }) {
    // #region
    const dashboard = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 3 })
    const names = ['Pressure (bar)', 'Flow (L/min)', 'Temperature (°C)']
    const charts = names.map((name, i) => {
      const chart = dashboard.createChartXY({ columnIndex: 0, rowIndex: i, legend: { visible: false } }).setTitle(name)
      let y = 0
      chart
        .addAreaSeries({ automaticColorIndex: i, baseline: 0 })
        .setName(name)
        .appendJSON(Array.from({ length: 3000 }, (_, x) => ({ x, y: 20 + (y += Math.random() - 0.5) })))
      return chart
    })
    synchronizeAxisIntervals(...charts.map((chart) => chart.axisX))
    synchronizeCursors(...charts)
    // #endregion
  },
} satisfies Snippet
