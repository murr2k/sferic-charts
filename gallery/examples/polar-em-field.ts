import { sferic, LUT, PalettedFill, regularColorSteps, SolidFill, SolidLine } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Antenna Radiation Pattern',
  category: 'Polar',
  order: 2,
  tags: ['polar', 'area', 'lut', 'gradient'],
  description:
    'Normalized electric field strength of an 8-element phased array (E-plane, beam steered 20°) next to a single dipole (H-plane), as polar area series. The E-plane fill is colored by amplitude through a LUT, giving a radial gradient.',
  run({ container, theme }) {
    const chart = sferic().Polar({ container, theme }).setTitle('Electromagnetic Field Strength')
    chart.getRadialAxis().setDivision(12)
    chart.getAmplitudeAxis().setTitle('|E| / |E|max').setInterval({ start: 0, end: 1 })
    // Array factor of N isotropic elements, half-wavelength spacing, progressive phase beta.
    const N = 8
    const beta = -Math.PI * Math.sin((20 * Math.PI) / 180)
    const eplane = []
    const dipole = []
    for (let deg = 0; deg < 360; deg += 0.25) {
      const t = (deg * Math.PI) / 180
      const psi = Math.PI * Math.sin(t) + beta
      const af = Math.abs(psi) < 1e-9 ? 1 : Math.abs(Math.sin((N * psi) / 2) / (N * Math.sin(psi / 2)))
      // element pattern: forward hemisphere only
      eplane.push({ angle: deg, amplitude: af * (0.35 + 0.65 * Math.max(0, Math.cos(t))) })
      dipole.push({ angle: deg, amplitude: 0.42 * Math.abs(Math.cos(t - Math.PI / 2)) ** 1.5 + 0.04 })
    }
    const pal = theme.examples.intensityColorPalette
    const lut = new LUT({ steps: regularColorSteps(0, 1, pal.slice(1)), interpolate: true })
    chart
      .addAreaSeries()
      .setName('E-plane (phased array)')
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }))
      .setStrokeStyle(new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: pal[pal.length - 2] }) }))
      .setData(eplane)
    chart
      .addAreaSeries({ automaticColorIndex: 4 })
      .setName('H-plane (dipole)')
      .setData(dipole)
    return () => chart.dispose()
  },
} satisfies Example
