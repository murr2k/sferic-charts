import { sferic, AxisTickStrategies, AxisScrollStrategies } from '../../src'
import type { Example } from '../types'

const CHANNELS = 10
const PPS = 1000
const WINDOW_MS = 10_000

export default {
  title: 'Multi-channel Real-time Monitoring',
  category: 'Real-time',
  order: 1,
  tags: ['real-time', 'stacked axes', 'scrolling'],
  description: `${CHANNELS} channels at ${PPS} samples per second each, every channel on its own stacked Y axis. The X axis scrolls a ${WINDOW_MS / 1000} s window; zoom or pan to stop scrolling, double-click to resume.`,
  run({ container, theme }) {
    const chart = sferic()
      .ChartXY({ container, theme, legend: { visible: false } })
      .setTitle(`${CHANNELS} channels, ${PPS} points per second each`)
      .setCursorMode('show-all')
    chart.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - WINDOW_MS, stopAxisAfter: false }))
    chart.axisY.dispose()
    const series = Array.from({ length: CHANNELS }, (_, i) => {
      const axis = chart
        .addAxisY({ iStack: CHANNELS - 1 - i })
        .setMargins(i === CHANNELS - 1 ? 0 : 4, i === 0 ? 0 : 4)
        .setTitle(`Ch ${i + 1}`)
      return chart.addLineSeries({ axisY: axis, automaticColorIndex: i }).setName(`Channel ${i + 1}`).setMaxSampleCount(PPS * (WINDOW_MS / 1000 + 2))
    })
    // Each channel: a few incommensurate sines plus noise.
    const f = series.map((_, i) => [0.31 + i * 0.07, 1.7 + i * 0.13, 7.3 + i * 0.5])
    const t0 = performance.now()
    let n = 0
    let raf = 0
    const tick = () => {
      const target = Math.floor(((performance.now() - t0) * PPS) / 1000)
      const count = Math.min(target - n, PPS)
      if (count > 0) {
        const xs = new Float64Array(count)
        for (let k = 0; k < count; k++) xs[k] = ((n + k) * 1000) / PPS
        series.forEach((s, i) => {
          const ys = new Float32Array(count)
          for (let k = 0; k < count; k++) {
            const t = xs[k] / 1000
            ys[k] = Math.sin(t * f[i][0] * 6.28) * 2 + Math.sin(t * f[i][1] * 6.28) * 0.8 + Math.sin(t * f[i][2] * 6.28) * 0.25 + (Math.random() - 0.5) * 0.4
          }
          s.appendSamples({ xValues: xs, yValues: ys })
        })
        n = target
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
