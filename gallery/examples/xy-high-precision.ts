import { sferic, AxisTickStrategies } from '../../src'
import type { Example } from '../types'

const N = 2_000_000
const STEP_MS = 0.001 // 1 microsecond

export default {
  title: 'Microsecond Timestamps',
  category: 'XY',
  order: 10,
  tags: ['precision', 'datetime', 'zoom'],
  description:
    'Two million samples at 1 µs spacing on absolute epoch timestamps (about 1.7e12 ms). Coordinates are stored per chunk relative to a float64 origin, so you can zoom from the full 2 s view down to individual microsecond samples without jitter. The DateTime axis switches to microsecond ticks.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('2 M samples, 1 µs resolution, epoch-millisecond X axis')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    chart.axisY.setTitle('Signal').setUnits('V').setFitToVisibleData(true)
    const t0 = Date.UTC(2025, 2, 14, 9, 26, 53)
    const ys = new Float32Array(N)
    for (let i = 0; i < N; i++) {
      const t = i * 1e-6
      ys[i] = Math.sin(t * 2 * Math.PI * 3) + 0.35 * Math.sin(t * 2 * Math.PI * 4100) + 0.12 * Math.sin(t * 2 * Math.PI * 97_000) + (i % 997 === 0 ? 0.6 : 0)
    }
    const s = chart.addPointLineSeries({ automaticColorIndex: 1 }).setPointSize(4).appendSamples({ start: t0, step: STEP_MS, yValues: ys })
    void s
    // Start zoomed to 50 µs so the individual samples are visible.
    chart.axisX.setInterval({ start: t0 + 1000, end: t0 + 1000.05, stopAxisAfter: true })
    const btn = chart.addUIElement('button').setText('Show all (2 s)').setPosition({ x: 1, y: 99 }).setOrigin({ x: -1, y: 1 })
    btn.addEventListener('click', () => chart.axisX.fit(600))
    return () => chart.dispose()
  },
} satisfies Example
