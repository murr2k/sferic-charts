import { sferic, LUT, regularColorSteps } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Parallel Coordinates 10 000 Samples',
  category: 'Statistics',
  order: 21,
  tags: ['parallel coordinates', 'performance', 'LUT', 'brushing'],
  description:
    '10 000 synthetic production batches over 7 process parameters, colored by yield with a LUT. Two range selectors filter the batches; drag along any axis to add more, drag or resize selectors, double-click one to remove it. Hover a line for its values.',
  run({ container, theme }) {
    const chart = sferic()
      .ParallelCoordinateChart({ container, theme })
      .setTitle('Production Batches: Process Parameters vs. Yield')
      .setSeriesStrokeThickness(1)
      .setSeriesOpacity(0.25)
    chart.setAxes({
      Temperature: { units: 'C' },
      Pressure: { units: 'bar' },
      Flow: { title: 'Flow Rate', units: 'l/min' },
      Viscosity: { units: 'cP' },
      Speed: { title: 'Mixer Speed', units: 'rpm' },
      Vibration: { units: 'mm/s' },
      Yield: { units: '%' },
    })
    const r = rng(2024)
    const N = 10_000
    for (let i = 0; i < N; i++) {
      const temp = 350 + gauss(r) * 12
      const pressure = 4 + (temp - 350) * 0.05 + gauss(r) * 0.6
      const flow = 120 + gauss(r) * 18
      const viscosity = 900 - (temp - 350) * 9 + gauss(r) * 70
      const speed = 1500 + flow * 2 + gauss(r) * 120
      const vibration = 1.3 * Math.exp(gauss(r) * 0.35 + (speed - 1740) * 0.0015)
      const dev = ((temp - 352) / 10) ** 2 + ((pressure - 4.2) / 0.8) ** 2 + vibration * 0.5
      const yieldPct = Math.min(99.8, Math.max(50, 50 + 49.5 * Math.exp(-dev * 0.25) + gauss(r) * 2))
      chart.addSeries().setData({
        Temperature: temp,
        Pressure: pressure,
        Flow: flow,
        Viscosity: viscosity,
        Speed: speed,
        Vibration: vibration,
        Yield: yieldPct,
      })
    }
    chart.setLUT({
      key: 'Yield',
      lut: new LUT({ steps: regularColorSteps(50, 100, theme.examples.coldHotColorPalette), interpolate: true }),
    })
    chart.getAxis('Temperature').addRangeSelector().setInterval(345, 362)
    chart.getAxis('Pressure').addRangeSelector().setInterval(3.4, 5)
    return () => chart.dispose()
  },
} satisfies Example
