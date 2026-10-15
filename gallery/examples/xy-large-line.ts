import { sferic, PointLineAreaSeries } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

const SIZES = [1_000_000, 10_000_000, 30_000_000]
const TRACES = 4

export default {
  title: 'Large Line Chart (10M+ points)',
  category: 'XY',
  order: 2.5,
  tags: ['performance', 'LOD', 'line', 'large data'],
  description:
    'Up to 30 million points in four traces. Dense progressive data is drawn from an incremental min/max level-of-detail pyramid (about four vertices per pixel column), switching to raw samples as you zoom in, so panning and zooming stay interactive.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Generating...')
    const series: PointLineAreaSeries[] = Array.from({ length: TRACES }, (_, i) =>
      chart.addLineSeries({ automaticColorIndex: i }).setName(`Trace ${i + 1}`).setStrokeStyle((s) => s.setThickness(1.5)),
    )
    const load = (total: number) => {
      chart.setTitle(`Generating ${(total / 1e6).toFixed(0)} M points...`)
      setTimeout(() => {
        const t0 = performance.now()
        const per = total / TRACES
        series.forEach((s, i) => {
          const r = rng(100 + i)
          const ys = new Float32Array(per)
          let y = i * 400
          for (let k = 0; k < per; k++) {
            y += (r() - 0.5) * 2 + Math.sin(k / 50_000) * 0.05
            ys[k] = y
          }
          s.clear().appendSamples({ start: 0, step: 1, yValues: ys })
        })
        chart.axisX.fit(false)
        chart.axisY.fit(false)
        chart.setTitle(`${(total / 1e6).toFixed(0)} million points (generated + uploaded in ${Math.round(performance.now() - t0)} ms)`)
      }, 30)
    }
    SIZES.forEach((n, i) => {
      chart
        .addUIElement('button')
        .setText(`${n / 1e6} M`)
        .setPosition({ x: 1 + i * 4.5, y: 99 })
        .setOrigin({ x: -1, y: 1 })
        .addEventListener('click', () => load(n))
    })
    load(SIZES[1])
    return () => chart.dispose()
  },
} satisfies Example
