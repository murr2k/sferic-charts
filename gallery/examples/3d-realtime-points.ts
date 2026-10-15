import { sferic, PointStyle3D, PalettedFill, LUT, regularColorSteps } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Real-Time 3D Points',
  category: '3D',
  order: 7,
  tags: ['3d', 'point', 'real-time', 'streaming', 'pixelated'],
  description:
    'Streaming particle swarm: 2 000 new points per frame into a 200 000 sample ring buffer (setMaxSampleCount), drawn as pixelated points colored by age with a value palette. Only new samples are uploaded each frame.',
  run({ container, theme }) {
    const MAX = 200_000, PER_FRAME = 2000
    const chart = sferic().Chart3D({ container, theme }).setTitle('Real-Time 3D Points')
    for (const a of chart.getDefaultAxes()) a.setInterval({ start: -10, end: 10, stopAxisAfter: true })
    chart.getDefaultAxisX().setTitle('X')
    chart.getDefaultAxisY().setTitle('Y')
    chart.getDefaultAxisZ().setTitle('Z')
    chart.legend.setPosition('right')

    const lut = new LUT({ steps: regularColorSteps(0, 1, theme.examples.spectrogramColorPalette.slice(1)), interpolate: true, percentageValues: true })
    const series = chart
      .addPointSeries()
      .setName('Particles')
      .setMaxSampleCount(MAX)
      .setPointStyle(new PointStyle3D.Pixelated({ shape: 'circle', size: 3, fillStyle: new PalettedFill({ lut, lookUpProperty: 'value' }) }))
    series.setEffect(true)

    const r = rng(23)
    let t = 0
    const xs = new Float64Array(PER_FRAME), ys = new Float64Array(PER_FRAME), zs = new Float64Array(PER_FRAME), vs = new Float64Array(PER_FRAME)
    let raf = 0
    const tick = () => {
      // Three emitters orbiting the center; values are the emission time (older = darker).
      for (let i = 0; i < PER_FRAME; i++) {
        const e = i % 3
        const a = t * 0.02 + (e * Math.PI * 2) / 3
        const cx = Math.cos(a) * 5.5, cz = Math.sin(a) * 5.5, cy = Math.sin(t * 0.03 + e) * 4
        xs[i] = cx + gauss(r) * 0.9
        ys[i] = cy + gauss(r) * 0.9
        zs[i] = cz + gauss(r) * 0.9
        vs[i] = t
      }
      series.appendSamples({ xValues: xs, yValues: ys, zValues: zs, values: vs })
      t++
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
