import { sferic, AxisTickStrategies, SolidFill, SolidLine } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

const quantile = (s: number[], p: number) => {
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i)
  return s[lo] + (s[hi] - s[lo]) * (i - lo)
}

export default {
  title: 'Box Plot with Outliers',
  category: 'Statistics',
  order: 2,
  tags: ['box', 'scatter', 'outliers', 'jitter'],
  description:
    'Box plot of six experiment groups with every sample drawn as a jittered point behind the box. Samples beyond 1.5 IQR from the quartiles are classified as outliers and drawn as diamonds. Box, samples and outliers are three GPU series in one chart.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Reaction time per test group')
    const groups = ['Control', 'Dose A', 'Dose B', 'Dose C', 'Placebo', 'Sleep dep.']
    chart.axisX.setTickStrategy(AxisTickStrategies.Empty).setTitle('Group').setThickness(50)
    chart.axisY.setTitle('Reaction time').setUnits('ms')
    chart.setCursor((c) => c.setTickMarkerXVisible(false).setGridYVisible(false))

    const r = rng(7)
    const samples = chart.addPointSeries({ automaticColorIndex: 1 }).setName('Samples').setPointSize(3.5)
    const boxes = chart.addBoxSeries({ automaticColorIndex: 1 }).setName('Distribution')
    const outliers = chart.addPointSeries({ automaticColorIndex: 4 }).setName('Outliers').setPointShape('diamond').setPointSize(8)
    const t = chart.getTheme()
    samples.setPointFillStyle(new SolidFill({ color: t.seriesColors[1].setA(t.isDark ? 105 : 110) }))
    outliers.setPointFillStyle(new SolidFill({ color: t.examples.highlightColor }))
    boxes.setDefaultStyle((b) =>
      b.setBodyWidth(0.62).setTailWidth(0.32).setBodyFillStyle(new SolidFill({ color: t.seriesColors[1].setA(t.isDark ? 60 : 50) })).setBodyStrokeStyle(
        new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: t.seriesColors[1] }) }),
      ),
    )

    groups.forEach((g, i) => {
      const mean = 260 + [0, -18, -32, -44, 4, 70][i]
      const sd = 30 + [0, 4, 8, 6, 2, 18][i]
      const xs = Array.from({ length: 160 }, () => {
        const tail = r() < 0.04 ? (r() < 0.5 ? -1 : 1) * (2.5 + r() * 2) * sd : 0
        return mean + gauss(r) * sd + tail
      }).sort((a, b) => a - b)
      const q1 = quantile(xs, 0.25), q3 = quantile(xs, 0.75), iqr = q3 - q1
      const lo = q1 - 1.5 * iqr, hi = q3 + 1.5 * iqr
      const inl = xs.filter((v) => v >= lo && v <= hi)
      boxes.add({
        x: i, width: 1,
        lowerExtreme: inl[0], lowerQuartile: q1, median: quantile(xs, 0.5), upperQuartile: q3, upperExtreme: inl[inl.length - 1],
      })
      samples.appendJSON(inl.map((y) => ({ x: i + (r() - 0.5) * 0.5, y })))
      outliers.appendJSON(xs.filter((v) => v < lo || v > hi).map((y) => ({ x: i, y })))
      chart.axisX.addCustomTick().setValue(i).setText(g)
    })
    chart.axisX.setDefaultInterval({ start: -0.7, end: groups.length - 0.3 })
    return () => chart.dispose()
  },
} satisfies Example
