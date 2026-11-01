import { sferic, BarChartTypes } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Gauges and animated bars',
  order: 7,
  summary: 'A gauge and a bar chart side by side in one Dashboard, updated once a second. Both animate between values on their own.',
  run({ container, theme }) {
    // #region
    const dashboard = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    const gauge = dashboard
      .createGaugeChart({ columnIndex: 0, rowIndex: 0 })
      .setTitle('Total load')
      .setUnitLabel('%')
      .setInterval(0, 100)
    const bars = dashboard
      .createBarChart({ columnIndex: 1, rowIndex: 0, type: BarChartTypes.Horizontal })
      .setTitle('Load per core')
    bars.valueAxis.setInterval({ start: 0, end: 100 })

    const cores = Array.from({ length: 8 }, (_, i) => ({ category: `Core ${i + 1}`, value: 30 }))
    const update = () => {
      for (const core of cores) core.value = Math.min(100, Math.max(2, core.value + (Math.random() - 0.5) * 40))
      bars.setData(cores.map((core) => ({ ...core })))
      gauge.setValue(cores.reduce((sum, core) => sum + core.value, 0) / cores.length)
    }
    update()
    setInterval(update, 1000)
    // #endregion
  },
} satisfies Snippet
