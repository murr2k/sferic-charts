import { sferic } from '../../src'
import { createProgressiveTraceGenerator } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'One Million Samples, Streamed',
  category: 'XY',
  order: 2,
  tags: ['line', 'performance', 'streaming'],
  description: 'One million points streamed into a single line series, 20 000 points per frame. The X axis fits as data arrives.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('Preparing a one-million-sample random walk...')
    const series = chart.addLineSeries({ automaticColorIndex: 2 }).setMaxSampleCount(1_000_000)
    let raf = 0
    createProgressiveTraceGenerator()
      .setNumberOfPoints(1_000_000)
      .generate()
      .toPromise()
      .then((data) => {
        chart.setTitle('One million samples, streamed 20 000 per frame')
        let i = 0
        const step = () => {
          series.appendJSON(data.slice(i, i + 20_000))
          i += 20_000
          if (i < data.length) raf = requestAnimationFrame(step)
        }
        step()
      })
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
