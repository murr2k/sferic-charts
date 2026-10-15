import { sferic } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Spider Chart',
  category: 'Polar',
  order: 10,
  tags: ['spider', 'radar', 'legend'],
  description:
    'Spider (radar) chart comparing three smartphones over seven review categories. Series are filled polygons rendered on the GPU; hover a vertex for its value, click a legend entry to hide a series.',
  run({ container, theme }) {
    const chart = sferic().Spider({ container, theme }).setTitle('Smartphone Review Scores').setAxisInterval(10).setWebCount(5)
    const scores: Record<string, number[]> = {
      'Aurora X': [9.1, 7.2, 8.8, 9.4, 8.6, 5.2, 8.1],
      'Nimbus 12': [7.4, 9.3, 7.1, 7.8, 7.0, 8.7, 7.6],
      'Vertex Pro': [8.3, 6.4, 9.5, 8.2, 9.2, 4.6, 9.0],
    }
    const categories = ['Performance', 'Battery', 'Camera', 'Display', 'Design', 'Price', 'Software']
    for (const [name, values] of Object.entries(scores)) {
      chart
        .addSeries()
        .setName(name)
        .addPoints(...categories.map((axis, i) => ({ axis, value: values[i] })))
    }
    return () => chart.dispose()
  },
} satisfies Example
