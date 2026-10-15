import { sferic } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Parallel Coordinates',
  category: 'Statistics',
  order: 20,
  tags: ['parallel coordinates', 'category axis', 'brushing', 'spline'],
  description:
    'Iris-style flower measurements: every flower is one line across the axes, colored by species. Drag along any axis to brush (filter) lines, drag a selector to move it or its ends to resize, click the axis to clear. Click legend entries to toggle species.',
  run({ container, theme }) {
    const chart = sferic()
      .ParallelCoordinateChart({ container, theme })
      .setTitle('Iris Flower Measurements')
      .setSpline(true)
    chart.setAxes({
      Species: {},
      SepalLength: { title: 'Sepal Length', units: 'cm' },
      SepalWidth: { title: 'Sepal Width', units: 'cm' },
      PetalLength: { title: 'Petal Length', units: 'cm' },
      PetalWidth: { title: 'Petal Width', units: 'cm' },
    })
    // Per-species mean / standard deviation of the classic Iris data set.
    const species = [
      { name: 'Setosa', color: 0, m: [5.01, 3.43, 1.46, 0.25], sd: [0.35, 0.38, 0.17, 0.11] },
      { name: 'Versicolor', color: 1, m: [5.94, 2.77, 4.26, 1.33], sd: [0.52, 0.31, 0.47, 0.2] },
      { name: 'Virginica', color: 4, m: [6.59, 2.97, 5.55, 2.03], sd: [0.64, 0.32, 0.55, 0.27] },
    ]
    const r = rng(42)
    const round = (v: number) => Math.round(v * 10) / 10
    const groups = species.map((sp) => {
      const lines = []
      for (let i = 0; i < 50; i++) {
        const [sl, sw, pl, pw] = sp.m.map((m, k) => Math.max(0.1, round(m + gauss(r) * sp.sd[k])))
        lines.push(
          chart
            .addSeries({ automaticColorIndex: sp.color })
            .setName(`${sp.name} #${i + 1}`)
            .setData({ Species: sp.name, SepalLength: sl, SepalWidth: sw, PetalLength: pl, PetalWidth: pw }),
        )
      }
      return { sp, lines }
    })
    // One legend entry per species toggles all of its lines.
    for (const g of groups) {
      let visible = true
      chart.legend.add({
        getName: () => g.sp.name,
        getLegendSymbol: () => ({ kind: 'line', color: g.lines[0].getColor() }),
        getVisible: () => visible,
        setVisible: (v: boolean) => {
          visible = v
          g.lines.forEach((l) => l.setVisible(v))
        },
      })
    }
    chart.legend.setTitle('Species')
    chart.getAxis('PetalLength').addRangeSelector().setInterval(3.5, 5.2)
    return () => chart.dispose()
  },
} satisfies Example
