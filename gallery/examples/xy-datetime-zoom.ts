import { sferic, AxisTickStrategies, LinearGradientFill } from '../../src'
import { rng, gauss } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'DateTime Axis: Years to Minutes',
  category: 'XY',
  order: 5,
  tags: ['datetime', 'zoom', 'area'],
  description:
    'Twenty years of minute-resolution price data (about 10 million samples) on a DateTime axis. Wheel-zoom from decades down to minutes: tick levels switch between years, months, weeks, days, hours and minutes.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('Generating 20 years of data...')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    chart.axisY.setTitle('Price').setUnits('USD')
    const series = chart
      .addAreaSeries({ automaticColorIndex: 0, baseline: 0 })
      .setName('Price')
      .setStrokeStyle((s) => s.setThickness(1.5))
      .setAreaFillStyle(
        new LinearGradientFill({
          angle: 90,
          stops: [
            { offset: 0, color: theme.seriesColors[0].setA(0) },
            { offset: 1, color: theme.seriesColors[0].setA(90) },
          ],
        }),
      )
    const timer = setTimeout(() => {
      const t0 = Date.UTC(2005, 0, 3)
      const MIN = 60_000
      const n = Math.floor((20 * 365.25 * 24 * 60) / 1)
      const r = rng(77)
      const ys = new Float32Array(n)
      let p = 40
      for (let i = 0; i < n; i++) {
        p *= 1 + gauss(r) * 0.0006 + 0.0000002
        ys[i] = p
      }
      series.appendSamples({ start: t0, step: MIN, yValues: ys })
      chart.setTitle(`${(n / 1e6).toFixed(1)} M minute samples, 2005-2025`)
    }, 30)
    return () => {
      clearTimeout(timer)
      chart.dispose()
    }
  },
} satisfies Example
