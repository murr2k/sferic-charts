import { sferic, AxisTickStrategies, AxisScrollStrategies } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Real-time streaming',
  order: 2,
  summary: 'A scrolling time axis and appendSamples: 1,000 samples per second arrive in batches of 50. The series keeps the newest 20,000 samples; zoom or pan to pause scrolling, double-click to resume.',
  run({ container, theme }) {
    // #region
    const chart = sferic().ChartXY({ container, theme }).setTitle('1,000 samples per second')
    chart.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((state) => ({ end: state.dataMax ?? 0, start: (state.dataMax ?? 0) - 5000, stopAxisAfter: false }))
    chart.axisY.setInterval({ start: -2, end: 2 })

    const signal = chart.addLineSeries().setName('Signal').setMaxSampleCount(20_000)
    let t = 0 // ms, one sample per ms
    setInterval(() => {
      const ys = new Float32Array(50)
      for (let i = 0; i < ys.length; i++, t++) {
        ys[i] = Math.sin(t / 300) + 0.35 * Math.sin(t / 23) + (Math.random() - 0.5) * 0.25
      }
      signal.appendSamples({ start: t - ys.length, step: 1, yValues: ys })
    }, 50)
    // #endregion
  },
} satisfies Snippet
