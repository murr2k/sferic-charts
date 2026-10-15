import { sferic, ColorHSV } from '../../src'
import { rng, gauss } from '../../src/xydata'
import type { Example } from '../types'

const N = 1_000_000

export default {
  title: 'Large Scatter (1M points)',
  category: 'XY',
  order: 3.5,
  tags: ['scatter', 'performance', 'per-point color'],
  description:
    'One million points with individual colors, rendered as instanced GPU quads with signed-distance shapes. The cursor finds the nearest point using per-block bounding boxes.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle(`${N.toLocaleString()} points, colored by angle`)
    const r = rng(21)
    const xs = new Float64Array(N)
    const ys = new Float64Array(N)
    const colors = new Uint32Array(N)
    const lut = Array.from({ length: 360 }, (_, h) => ColorHSV(h, 0.55, 1).toUint32())
    for (let i = 0; i < N; i++) {
      // Spiral galaxy: arms + gaussian scatter
      const arm = i % 3
      const t = Math.sqrt(r()) * 9
      const ang = t + (arm * 2 * Math.PI) / 3 + gauss(r) * 0.25
      const rad = t + gauss(r) * 0.35
      xs[i] = Math.cos(ang) * rad
      ys[i] = Math.sin(ang) * rad
      const deg = Math.floor(((Math.atan2(ys[i], xs[i]) * 180) / Math.PI + 360) % 360)
      colors[i] = lut[deg]
    }
    chart.addPointSeries().setName('Stars').setPointSize(2).appendSamples({ xValues: xs, yValues: ys, colors })
    return () => chart.dispose()
  },
} satisfies Example
