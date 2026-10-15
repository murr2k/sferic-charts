import { sferic } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Microphone Sensitivity',
  category: 'Polar',
  order: 1,
  tags: ['polar', 'line', 'dB', 'legend'],
  description:
    'Polar pick-up pattern of a cardioid condenser microphone at six frequencies (dB relative to on-axis). Front is at the top, angles increase clockwise. Hover for the nearest point, wheel to zoom the amplitude axis, double-click to fit.',
  run({ container, theme }) {
    const chart = sferic().Polar({ container, theme }).setTitle('Cardioid Microphone Polar Pattern')
    chart.getRadialAxis().setNorth(0).setClockwise(true).setDivision(24)
    chart.getAmplitudeAxis().setTitle('Sensitivity').setUnits('dB').setInterval({ start: -30, end: 0 })
    // Pattern a + (1 - a) cos(t): a = 1 omni, 0.5 cardioid, ~0.37 supercardioid.
    const bands = [
      { name: '125 Hz', a: 0.82, ripple: 0.02 },
      { name: '500 Hz', a: 0.62, ripple: 0.03 },
      { name: '1 kHz', a: 0.52, ripple: 0.03 },
      { name: '4 kHz', a: 0.42, ripple: 0.06 },
      { name: '8 kHz', a: 0.36, ripple: 0.1 },
      { name: '16 kHz', a: 0.3, ripple: 0.16 },
    ]
    const floor = Math.pow(10, -30 / 20)
    bands.forEach((b, i) => {
      const data = []
      for (let deg = 0; deg < 360; deg += 0.5) {
        const t = (deg * Math.PI) / 180
        const g = Math.abs(b.a + (1 - b.a) * Math.cos(t)) * (1 + b.ripple * Math.cos(5 * t + i))
        data.push({ angle: deg, amplitude: Math.max(-30, 20 * Math.log10(Math.max(floor, g / (1 + b.ripple * Math.cos(i))))) })
      }
      chart.addLineSeries().setName(b.name).setConnectDataAutomaticallyEnabled(true).setData(data)
    })
    return () => chart.dispose()
  },
} satisfies Example
