import { sferic, BarChartTypes } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Stacked Bars',
  category: 'Bars',
  order: 4,
  tags: ['bars', 'stacked', 'legend'],
  description:
    'Stacked bar chart: sub category values stacked per category, segment values inside the bars and the stack total above each stack. Click legend entries to toggle sources.',
  run({ container, theme }) {
    const chart = sferic()
      .BarChart({ container, theme, type: BarChartTypes.Vertical })
      .setTitle('Electricity Generation by Source (synthetic data)')
      .setValueLabels({ position: 'inside-bar', displayStackedSum: true, formatter: (info) => info.value.toFixed(0) })
      .setBarsMargin(0.35)
    chart.valueAxis.setTitle('Generation').setUnits('TWh')
    chart.setDataStacked(
      ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'],
      [
        { subCategory: 'Coal', values: [210, 196, 171, 168, 152, 131, 117, 98] },
        { subCategory: 'Natural gas', values: [148, 152, 149, 155, 151, 146, 139, 133] },
        { subCategory: 'Nuclear', values: [96, 97, 94, 95, 92, 93, 95, 96] },
        { subCategory: 'Hydro', values: [64, 61, 66, 63, 59, 62, 64, 63] },
        { subCategory: 'Wind', values: [48, 57, 66, 74, 86, 98, 112, 127] },
        { subCategory: 'Solar', values: [17, 23, 31, 42, 55, 71, 88, 109] },
      ],
    )
    return () => chart.dispose()
  },
} satisfies Example
