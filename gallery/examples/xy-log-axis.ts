import { sferic, PointShape } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Logarithmic Axis',
  category: 'XY',
  order: 6,
  tags: ['log', 'axes'],
  description: 'A base-10 logarithmic Y axis spanning nine decades, with minor ticks at 2..9 x 10^n. Zooming keeps the logarithmic mapping.',
  run({ container, theme }) {
    const chart = sferic()
      .ChartXY({ container, theme, defaultAxisY: { type: 'logarithmic', base: 10 } })
      .setTitle('Growth curves on a log scale')
    chart.axisX.setTitle('Generation')
    chart.axisY.setTitle('Population')
    const gens = Array.from({ length: 61 }, (_, i) => i)
    chart.addLineSeries().setName('Exponential (r = 0.35)').appendJSON(gens.map((x) => ({ x, y: Math.exp(0.35 * x) })))
    chart
      .addLineSeries()
      .setName('Logistic (K = 1e7)')
      .appendJSON(gens.map((x) => ({ x, y: 1e7 / (1 + (1e7 - 1) * Math.exp(-0.45 * x)) })))
    chart
      .addPointLineSeries({ pointShape: PointShape.Diamond })
      .setName('Power law x^4')
      .appendJSON(gens.filter((x) => x > 0 && x % 3 === 0).map((x) => ({ x, y: x ** 4 })))
    chart.addLineSeries().setName('Decay').appendJSON(gens.map((x) => ({ x, y: 1e8 * Math.exp(-0.18 * x) })))
    return () => chart.dispose()
  },
} satisfies Example
