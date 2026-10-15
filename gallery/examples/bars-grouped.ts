import { sferic, BarChartTypes } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Grouped Bars',
  category: 'Bars',
  order: 3,
  tags: ['bars', 'grouped', 'legend'],
  description:
    'Grouped bar chart: one bar per sub category inside each category. Click a legend entry to hide or show a sub category; the remaining bars re-flow with an animation.',
  run({ container, theme }) {
    const chart = sferic()
      .BarChart({ container, theme, type: BarChartTypes.Vertical })
      .setTitle('Annual Sales by Region (synthetic data)')
      .setValueLabels({ position: 'after-bar', formatter: (info) => info.value.toFixed(0) })
      .setBarsMargin(0.3)
      .setCornerRadius(2)
    chart.valueAxis.setTitle('Units sold').setUnits('thousands')
    chart.setDataGrouped(
      ['2021', '2022', '2023', '2024', '2025'],
      [
        { subCategory: 'North America', values: [142, 156, 171, 168, 189] },
        { subCategory: 'Europe', values: [118, 124, 133, 147, 152] },
        { subCategory: 'Asia Pacific', values: [96, 121, 148, 176, 204] },
        { subCategory: 'Latin America', values: [41, 47, 52, 61, 73] },
      ],
    )
    return () => chart.dispose()
  },
} satisfies Example
