import { sferic, BarChartTypes, BarChartSorting } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Bar Chart',
  category: 'Bars',
  order: 1,
  tags: ['bars', 'categories', 'value labels'],
  description:
    'Vertical bar chart: one bar per category, colors from the theme palette, value labels after each bar. Hover a bar for its tooltip. Bars are drawn on the GPU as a single instanced batch.',
  run({ container, theme }) {
    const chart = sferic()
      .BarChart({ container, theme, type: BarChartTypes.Vertical })
      .setTitle('Online Store Revenue by Product Category (synthetic data)')
      .setSorting(BarChartSorting.None)
      .setValueLabels({ position: 'after-bar', formatter: (info) => `$${info.value.toFixed(1)}M` })
      .setCornerRadius(2)
    chart.valueAxis.setTitle('Revenue').setUnits('M$')
    chart.categoryAxis.setTitle('Product category')
    chart.setData([
      { category: 'Electronics', value: 48.2 },
      { category: 'Apparel', value: 36.9 },
      { category: 'Home & Garden', value: 29.4 },
      { category: 'Sports', value: 21.7 },
      { category: 'Beauty', value: 18.3 },
      { category: 'Toys', value: 14.6 },
      { category: 'Books', value: 11.2 },
      { category: 'Automotive', value: 8.9 },
    ])
    return () => chart.dispose()
  },
} satisfies Example
