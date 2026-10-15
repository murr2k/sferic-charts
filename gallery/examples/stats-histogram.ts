import { sferic, ColorRGBA, SolidFill, SolidLine } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Histogram',
  category: 'Statistics',
  order: 3,
  tags: ['histogram', 'rectangles', 'gaussian', 'density'],
  description:
    '200 000 samples from a two-component gaussian mixture binned into 90 bins (RectangleSeries, one GPU draw), overlaid with the analytic density scaled to counts. Hover a bin for its range and count.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Distribution of 200 000 measurements')
    chart.axisX.setTitle('Value')
    chart.axisY.setTitle('Count')

    const N = 200_000
    const r = rng(11)
    const comps = [
      { w: 0.68, mu: 0, sd: 1 },
      { w: 0.32, mu: 2.8, sd: 0.65 },
    ]
    const lo = -4, hi = 5, bins = 90
    const bw = (hi - lo) / bins
    const counts = new Array(bins).fill(0)
    for (let i = 0; i < N; i++) {
      const c = r() < comps[0].w ? comps[0] : comps[1]
      const v = c.mu + gauss(r) * c.sd
      const b = Math.floor((v - lo) / bw)
      if (b >= 0 && b < bins) counts[b]++
    }

    const t = chart.getTheme()
    const hist = chart.addRectangleSeries({ automaticColorIndex: 3 }).setName('Frequency')
    hist.setStrokeStyle(new SolidLine({ thickness: 1, fillStyle: new SolidFill({ color: t.isDark ? ColorRGBA(0, 0, 0, 170) : ColorRGBA(255, 255, 255, 220) }) }))
    counts.forEach((c, i) => hist.add({ x1: lo + i * bw, y1: 0, x2: lo + (i + 1) * bw, y2: c }))
    hist.setCursorResultTableFormatter((b, s, _x, _y, hit) => {
      const f = (s as typeof hist).getFigures()[hit.extra?.figure as number]
      const d = f.getDimensionsTwoPoints()
      return b
        .addRow('Frequency')
        .addRow('Range:', `${d.x1.toFixed(2)} .. ${d.x2.toFixed(2)}`)
        .addRow('Count:', String(d.y2))
        .addRow('Share:', `${((d.y2 / N) * 100).toFixed(2)} %`)
    })

    const pdf = (x: number) =>
      comps.reduce((a, c) => a + (c.w / (c.sd * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - c.mu) / c.sd) ** 2), 0)
    chart
      .addLineSeries({ automaticColorIndex: 0 })
      .setName('Mixture density')
      .appendJSON(Array.from({ length: 400 }, (_, i) => { const x = lo + ((hi - lo) * i) / 399; return { x, y: pdf(x) * N * bw } }))
    chart.axisY.setDefaultInterval((s) => ({ start: 0, end: (s.dataMax ?? 1) * 1.08 }))
    return () => chart.dispose()
  },
} satisfies Example
