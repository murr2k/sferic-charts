import { sferic, PointShape } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Data Gaps',
  category: 'XY',
  order: 11,
  tags: ['gaps', 'NaN', 'line', 'area'],
  description:
    'Missing samples are expressed as NaN; lines and areas break across them instead of interpolating. Useful for sensors that drop out or for separating sessions.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Sensor readings with dropouts')
    const r = rng(9)
    const a: { x: number; y: number }[] = []
    const b: { x: number; y: number }[] = []
    let y1 = 20, y2 = 12
    for (let x = 0; x < 600; x++) {
      y1 += (r() - 0.5) * 1.2 + (20 - y1) * 0.02
      y2 += (r() - 0.5) * 0.8 + (12 - y2) * 0.02
      const dropA = (x > 120 && x < 160) || (x > 400 && x < 430)
      const dropB = x % 150 > 130
      a.push({ x, y: dropA ? NaN : y1 })
      b.push({ x, y: dropB ? NaN : y2 })
    }
    chart.addAreaSeries({ automaticColorIndex: 1, baseline: 0 }).setName('Sensor A').appendJSON(a)
    chart.addPointLineSeries({ automaticColorIndex: 2, pointShape: PointShape.Circle }).setName('Sensor B').setPointSize(4).appendJSON(b)
    chart.axisY.setTitle('Temperature').setUnits('°C')
    chart.axisX.setTitle('Minute')
    return () => chart.dispose()
  },
} satisfies Example
