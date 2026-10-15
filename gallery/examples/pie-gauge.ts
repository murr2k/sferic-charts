import { sferic, ColorHEX } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Gauge Chart',
  category: 'Pie & Gauges',
  order: 10,
  tags: ['gauge', 'animation', 'value indicators'],
  description:
    'Speedometer-style gauge: value bar with colored value indicator ranges (the bar takes the color of the range holding the value), tick labels, animated needle and readout. A new random value is set every 2 seconds.',
  run({ container, theme }) {
    const gauge = sferic()
      .Gauge({ container, theme })
      .setTitle('Vehicle Speed')
      .setUnitLabel('km/h')
      .setInterval(0, 220)
      .setValueIndicators([
        { start: 0, end: 90, color: ColorHEX(theme.isDark ? '#4fd88a' : '#21a366') },
        { start: 90, end: 160, color: ColorHEX(theme.isDark ? '#f2c14e' : '#d79b00') },
        { start: 160, end: 220, color: ColorHEX(theme.isDark ? '#ff5d5d' : '#e0335f') },
      ])
      .setValueLabelFormatter((v) => v.toFixed(0))
      .setValue(72)
    const h = setInterval(() => gauge.setValue(Math.round(Math.random() * 220)), 2000)
    return () => {
      clearInterval(h)
      gauge.dispose()
    }
  },
} satisfies Example
