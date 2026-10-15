import { sferic, LUT, PalettedFill, regularColorSteps, SolidFill } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Polar Heatmap Sensors',
  category: 'Polar',
  order: 4,
  tags: ['polar', 'heatmap', 'lut', 'interpolation'],
  description:
    'Temperature across a circular heat-treatment plate, interpolated (inverse distance weighting) from 14 thermocouples onto a 360 x 60 polar grid and drawn as a GPU polar heatmap with bilinear smoothing. Sensor positions are shown as a point series.',
  run({ container, theme }) {
    const chart = sferic().Polar({ container, theme }).setTitle('Plate Temperature')
    chart.getRadialAxis().setDivision(8)
    chart.getAmplitudeAxis().setTitle('Radius').setUnits('mm').setInterval({ start: 0, end: 300 })
    chart.legend.setPosition('right')
    const sensors = [
      { angle: 0, amplitude: 0, t: 74 },
      { angle: 20, amplitude: 120, t: 68 },
      { angle: 80, amplitude: 210, t: 52 },
      { angle: 140, amplitude: 90, t: 71 },
      { angle: 165, amplitude: 260, t: 38 },
      { angle: 200, amplitude: 180, t: 47 },
      { angle: 245, amplitude: 60, t: 76 },
      { angle: 260, amplitude: 280, t: 31 },
      { angle: 300, amplitude: 160, t: 58 },
      { angle: 330, amplitude: 250, t: 41 },
      { angle: 45, amplitude: 290, t: 35 },
      { angle: 110, amplitude: 290, t: 33 },
      { angle: 220, amplitude: 290, t: 29 },
      { angle: 350, amplitude: 60, t: 79 },
    ]
    const xy = (a: number, r: number) => [r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)]
    const pts = sensors.map((s) => ({ ...s, p: xy(s.angle, s.amplitude) }))
    const sectors = 360, annuli = 60
    const values: number[][] = []
    for (let s = 0; s < sectors; s++) {
      const row: number[] = []
      for (let a = 0; a < annuli; a++) {
        const [x, y] = xy(s + 0.5, ((a + 0.5) / annuli) * 300)
        let wsum = 0, vsum = 0
        for (const q of pts) {
          const d2 = (x - q.p[0]) ** 2 + (y - q.p[1]) ** 2 + 1
          const w = 1 / (d2 * d2)
          wsum += w
          vsum += w * q.t
        }
        row.push(vsum / wsum)
      }
      values.push(row)
    }
    const lut = new LUT({ steps: regularColorSteps(25, 80, theme.examples.coldHotColorPalette), interpolate: true, units: '°C' })
    chart
      .addHeatmapSeries({ sectors, annuli, amplitudeStart: 0, amplitudeEnd: 300 })
      .setName('Temperature')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
      .invalidateIntensityValues(values)
    chart
      .addPointSeries({ pointShape: 'diamond' })
      .setName('Thermocouples')
      .setPointSize(10)
      .setPointFillStyle(new SolidFill({ color: theme.isDark ? theme.examples.mainTextColor : theme.titleColor }))
      .setData(sensors)
    return () => chart.dispose()
  },
} satisfies Example
