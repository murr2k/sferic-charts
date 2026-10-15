import { sferic, AxisTickStrategies } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

const quantile = (s: number[], p: number) => {
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

export default {
  title: 'Box and Whiskers',
  category: 'Statistics',
  order: 1,
  tags: ['box', 'whiskers', 'quartiles', 'custom ticks'],
  description:
    'Two box series compare the monthly response-time distribution of two server regions. Boxes span the inter-quartile range, whiskers reach the furthest sample within 1.5 IQR and the bright line marks the median. Hover a box for its five-number summary.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Server response time by month')
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
    chart.axisX.setTickStrategy(AxisTickStrategies.Empty).setTitle('Month (2025)').setThickness(50)
    chart.axisY.setTitle('Response time').setUnits('ms')
    chart.setCursor((c) => c.setTickMarkerXVisible(false).setGridYVisible(false))

    const r = rng(42)
    const regions = [
      { name: 'EU West', base: 118, spread: 20, offset: -0.19, color: 0 },
      { name: 'US East', base: 146, spread: 28, offset: 0.19, color: 4 },
    ]
    for (const reg of regions) {
      const series = chart
        .addBoxSeries({ automaticColorIndex: reg.color })
        .setName(reg.name)
        .setDefaultStyle((box) => box.setBodyWidth(1).setTailWidth(0.55))
      months.forEach((_, i) => {
        const season = Math.sin((i / 12) * Math.PI * 2 + 1) * 14
        const xs = Array.from({ length: 500 }, () => reg.base + season + gauss(r) * reg.spread + Math.max(0, gauss(r)) * reg.spread * 0.7)
          .sort((a, b) => a - b)
        const q1 = quantile(xs, 0.25), q3 = quantile(xs, 0.75), iqr = q3 - q1
        series.add({
          x: i + reg.offset,
          width: 0.34,
          lowerExtreme: xs.find((v) => v >= q1 - 1.5 * iqr)!,
          lowerQuartile: q1,
          median: quantile(xs, 0.5),
          upperQuartile: q3,
          upperExtreme: [...xs].reverse().find((v) => v <= q3 + 1.5 * iqr)!,
        })
      })
    }
    months.forEach((m, i) => chart.axisX.addCustomTick().setValue(i).setText(m))
    chart.axisX.setDefaultInterval({ start: -0.6, end: 11.6 })
    return () => chart.dispose()
  },
} satisfies Example
