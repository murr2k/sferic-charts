import { sferic, AxisTickStrategies } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Several Y Axes',
  category: 'XY',
  order: 4,
  tags: ['axes', 'multi-axis', 'datetime'],
  description:
    'Three series on independent Y axes: two on the left, one on the opposite side. Each axis can be zoomed or panned by itself with the mouse wheel or a drag over the axis.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Weather station, last 30 days').setCursorMode('show-all')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    const r = rng(42)
    const t0 = new Date(2024, 5, 1).getTime()
    const H = 3600_000
    const temp: { x: number; y: number }[] = []
    const hum: { x: number; y: number }[] = []
    const press: { x: number; y: number }[] = []
    let p = 1012
    for (let i = 0; i < 30 * 24; i++) {
      const x = t0 + i * H
      const day = Math.sin((((i % 24) - 9) / 24) * 2 * Math.PI)
      temp.push({ x, y: 18 + 7 * day + 3 * Math.sin(i / 90) + (r() - 0.5) * 1.2 })
      hum.push({ x, y: 62 - 18 * day + (r() - 0.5) * 6 })
      p += (r() - 0.5) * 0.9 + (1012 - p) * 0.01
      press.push({ x, y: p })
    }
    chart.axisY.setTitle('Temperature').setUnits('°C')
    const axHum = chart.addAxisY().setTitle('Humidity').setUnits('%')
    const axPress = chart.addAxisY({ opposite: true }).setTitle('Pressure').setUnits('hPa')
    chart.addLineSeries().setName('Temperature').appendJSON(temp)
    chart.addLineSeries({ axisY: axHum }).setName('Humidity').appendJSON(hum)
    chart.addLineSeries({ axisY: axPress }).setName('Pressure').appendJSON(press)
    return () => chart.dispose()
  },
} satisfies Example
