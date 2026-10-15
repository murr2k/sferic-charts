import { sferic, BarChartTypes, BarChartSorting, UIOrigins } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Horizontal Bar Chart',
  category: 'Bars',
  order: 2,
  tags: ['bars', 'horizontal', 'sorting', 'animation'],
  description:
    'Horizontal bars sorted in descending order with value labels inside the bars. Click "Randomize" to load new values: bars animate to their new lengths and re-sort smoothly.',
  run({ container, theme }) {
    const chart = sferic()
      .BarChart({ container, theme, type: BarChartTypes.Horizontal })
      .setTitle('Website Sessions by Traffic Source (synthetic data)')
      .setSorting(BarChartSorting.Descending)
      .setValueLabels({ position: 'inside-bar', formatter: (info) => `${Math.round(info.value).toLocaleString('en-US')}` })
      .setCornerRadius(2)
    chart.valueAxis.setTitle('Sessions per day')
    const sources = ['Organic search', 'Direct', 'Social media', 'Email', 'Paid search', 'Referral', 'Display ads', 'Affiliates', 'Video', 'Podcasts']
    const base = [18400, 12100, 9300, 6800, 5600, 4200, 2900, 2100, 1500, 900]
    const r = rng(42)
    let round = 0
    const load = () => {
      const k = round++ === 0 ? 0 : 1
      chart.setData(sources.map((category, i) => ({ category, value: base[i] * (1 + k * (r() - 0.5) * 1.2) })))
    }
    load()
    chart
      .addUIElement('button')
      .setText('Randomize')
      .setPosition({ x: 99, y: 99 })
      .setOrigin(UIOrigins.RightTop)
      .onMouseClick(load)
    return () => chart.dispose()
  },
} satisfies Example
