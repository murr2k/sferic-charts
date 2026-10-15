import { sferic, SpiderWebMode } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Spider Chart Animated',
  category: 'Polar',
  order: 11,
  tags: ['spider', 'radar', 'animation', 'real-time'],
  description:
    'Live server health over eight metrics, refreshed every 900 ms. New values animate smoothly from the previous ones; the web is drawn in circle mode and the scale follows the data automatically.',
  run({ container, theme }) {
    const chart = sferic().Spider({ container, theme }).setTitle('Cluster Node Load (%)').setWebMode(SpiderWebMode.Circle).setWebCount(4)
    chart.setScaleLabelStrategy((v) => `${Math.round(v)}%`)
    const metrics = ['CPU', 'Memory', 'Disk I/O', 'Network', 'GPU', 'Cache', 'Threads', 'Queue']
    const nodes = ['node-a', 'node-b', 'node-c'].map((name, k) => ({
      series: chart.addSeries().setName(name),
      base: metrics.map((_, i) => 30 + ((i * 37 + k * 23) % 50)),
    }))
    const update = () => {
      for (const n of nodes) {
        n.series.addPoints(
          ...metrics.map((axis, i) => ({ axis, value: Math.max(2, Math.min(100, n.base[i] + (Math.random() - 0.5) * 40)) })),
        )
      }
    }
    update()
    const h = setInterval(update, 900)
    return () => {
      clearInterval(h)
      chart.dispose()
    }
  },
} satisfies Example
