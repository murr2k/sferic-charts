import { sferic, LUT, PalettedFill, regularColorSteps, AxisScrollStrategies } from '../../src'
import { rng } from '../../src/xydata'
import { spectrumColumn } from '../../src/xydata/gen3d'
import type { Example } from '../types'

export default {
  title: 'Real-Time 3D Spectrogram',
  category: '3D',
  order: 4,
  tags: ['3d', 'surface', 'real-time', 'spectrogram', 'scrolling'],
  description:
    'Scrolling 3D surface fed one spectrum (512 frequency bins) per frame. A ring-buffer float texture keeps 400 time columns; only the new column is uploaded each frame. The time axis follows the newest data.',
  run({ container, theme }) {
    const ROWS = 512, COLS = 400
    const chart = sferic().Chart3D({ container, theme }).setTitle('Real-Time 3D Spectrogram')
    chart.setBoundingBox({ x: 1.4, y: 0.5, z: 1 })
    chart.setCameraLocation({ x: 0.9, y: 0.75, z: 1.4 })
    chart.getDefaultAxisX().setTitle('Time').setUnits('frames').setScrollStrategy(AxisScrollStrategies.progressive)
    chart.getDefaultAxisY().setTitle('Magnitude').setUnits('dB').setInterval({ start: 0, end: 90, stopAxisAfter: true })
    chart.getDefaultAxisZ().setTitle('Frequency').setUnits('Hz').setInterval({ start: 0, end: 22050, stopAxisAfter: true })
    chart.legend.setPosition('right')

    const lut = new LUT({ steps: regularColorSteps(5, 80, theme.examples.spectrogramColorPalette), interpolate: true, units: 'dB' })
    const surface = chart
      .addSurfaceScrollingGridSeries({ columns: COLS, rows: ROWS, start: { x: 0, z: 0 }, step: { x: 1, z: 22050 / (ROWS - 1) } })
      .setName('Spectrum')
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' }))
    chart.getDefaultAxisX().setInterval({ start: -COLS, end: 0, stopAxisAfter: false })

    const r = rng(17)
    let t = 0
    // Pre-fill so the surface is complete immediately.
    const pre = Array.from({ length: COLS }, () => spectrumColumn(t++, ROWS, r))
    surface.addValues({ yValues: pre })
    let raf = 0
    const tick = () => {
      surface.addValues({ yValues: [spectrumColumn(t++, ROWS, r)] })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
