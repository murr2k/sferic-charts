import { sferic, LUT, PalettedFill, regularColorSteps } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: '3D Bar Chart',
  category: '3D',
  order: 5,
  tags: ['3d', 'box', 'bar', 'animated', 'palette'],
  description:
    'Box series as a 3D bar chart: 12 x 12 bars colored by height with a gradient palette. Bars are updated in place by id with an animated wave. Hover a bar to read its values.',
  run({ container, theme }) {
    const N = 12
    const chart = sferic().Chart3D({ container, theme }).setTitle('3D Bar Chart')
    chart.setBoundingBox({ x: 1, y: 0.6, z: 1 })
    chart.getDefaultAxisX().setTitle('Category A').setInterval({ start: 0, end: N, stopAxisAfter: true })
    chart.getDefaultAxisY().setTitle('Value').setInterval({ start: 0, end: 100, stopAxisAfter: true })
    chart.getDefaultAxisZ().setTitle('Category B').setInterval({ start: 0, end: N, stopAxisAfter: true })
    chart.legend.setPosition('right')

    const lut = new LUT({ steps: regularColorSteps(0, 100, theme.examples.coldHotColorPalette), interpolate: true })
    const bars = chart.addBoxSeries().setName('Bars').setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' }))
    const r = rng(4)
    const base = Array.from({ length: N * N }, () => r())
    const update = (time: number) => {
      const data = []
      for (let i = 0; i < N; i++)
        for (let j = 0; j < N; j++) {
          const k = i * N + j
          const wave = Math.sin(i * 0.5 + time) * Math.cos(j * 0.45 - time * 0.7)
          const h = Math.max(2, 45 + 30 * wave + 18 * base[k])
          data.push({ id: k, xCenter: i + 0.5, yCenter: h / 2, zCenter: j + 0.5, xSize: 0.72, ySize: h, zSize: 0.72 })
        }
      bars.invalidateData(data)
    }
    update(0)
    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      update((now - t0) / 1600)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
