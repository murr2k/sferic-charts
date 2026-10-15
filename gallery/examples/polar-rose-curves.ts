import { sferic } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Animated Polar Lines',
  category: 'Polar',
  order: 5,
  tags: ['polar', 'line', 'animation', 'performance', 'glow'],
  description:
    'Three rhodonea (rose) curves of 10 000 points each, re-generated every frame with a drifting phase: 30k polar points mapped, clipped and drawn as glowing GPU lines per frame.',
  run({ container, theme }) {
    const chart = sferic().Polar({ container, theme }).setTitle('Rose Curves r = sin(k t + phase)')
    chart.getAmplitudeAxis().setInterval({ start: 0, end: 1.1 })
    chart.getRadialAxis().setDivision(8)
    const N = 10000
    const curves = [
      { k: 7 / 3, turns: 3, color: 0 },
      { k: 5 / 4, turns: 4, color: 2 },
      { k: 9 / 5, turns: 5, color: 4 },
    ].map((c) => ({
      ...c,
      series: chart.addLineSeries({ automaticColorIndex: c.color }).setName(`k = ${c.k.toFixed(2)}`).setConnectDataAutomaticallyEnabled(true),
      data: Array.from({ length: N }, () => ({ angle: 0, amplitude: 0 })),
    }))
    let raf = 0
    const t0 = performance.now()
    const frame = (now: number) => {
      const t = (now - t0) / 1000
      curves.forEach((c, j) => {
        const ph = t * (0.6 + j * 0.25)
        for (let i = 0; i < N; i++) {
          const th = (i / N) * Math.PI * 2 * c.turns
          const p = c.data[i]
          p.angle = ((th * 180) / Math.PI + t * 12 * (j % 2 ? -1 : 1)) % 360
          p.amplitude = Math.abs(Math.sin(c.k * th + ph)) * (0.55 + 0.45 * (1 - j * 0.15))
        }
        c.series.setData(c.data)
      })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
