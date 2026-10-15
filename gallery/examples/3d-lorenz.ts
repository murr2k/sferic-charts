import { sferic, LUT, PalettedFill, regularColorSteps, SolidLine } from '../../src'
import { lorenz } from '../../src/xydata/gen3d'
import type { Example } from '../types'

export default {
  title: '3D Line Series',
  category: '3D',
  order: 2,
  tags: ['3d', 'line', 'palette', 'glow'],
  description:
    'Lorenz attractor drawn as a thick 3D polyline (60 000 samples) colored by height with a palette. Lines are screen-space quads built in the vertex shader. Drag to rotate, wheel to zoom.',
  run({ container, theme }) {
    const chart = sferic().Chart3D({ container, theme }).setTitle('Lorenz Attractor')
    chart.setBoundingBox({ x: 1, y: 0.8, z: 1 })
    chart.getDefaultAxisX().setTitle('X')
    chart.getDefaultAxisY().setTitle('Z (height)')
    chart.getDefaultAxisZ().setTitle('Y')

    const lut = new LUT({ steps: regularColorSteps(2, 48, theme.examples.spectrogramColorPalette.slice(2)), interpolate: true })
    const series = chart
      .addLineSeries()
      .setName('Trajectory')
      .setLineStyle(new SolidLine({ thickness: 2, fillStyle: new PalettedFill({ lut, lookUpProperty: 'y' }) }))

    // Grow the trajectory progressively for a drawing effect.
    const data = lorenz(60000)
    let i = 0
    let raf = 0
    const step = () => {
      const n = Math.min(900, data.length - i)
      if (n > 0) {
        series.add(data.slice(i, i + n))
        i += n
        raf = requestAnimationFrame(step)
      }
    }
    step()
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
