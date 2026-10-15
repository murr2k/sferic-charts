import { sferic, Color, ColorHEX } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Gauge Dashboard',
  category: 'Pie & Gauges',
  order: 11,
  tags: ['gauge', 'dashboard', 'real-time'],
  description:
    'Six gauges in one Dashboard (a single canvas): different angle intervals, needle-less bars, value indicator ranges and formatters, all updating independently.',
  run({ container, theme }) {
    const db = sferic().Dashboard({ container, theme, numberOfColumns: 3, numberOfRows: 2 })
    const good = ColorHEX(theme.isDark ? '#4fd88a' : '#21a366')
    const warn = ColorHEX(theme.isDark ? '#f2c14e' : '#d79b00')
    const bad = ColorHEX(theme.isDark ? '#ff5d5d' : '#e0335f')
    const cfg: { title: string; unit: string; min: number; max: number; ind: [number, number, Color][]; angles: [number, number]; needle: boolean }[] = [
      { title: 'CPU Temperature', unit: '°C', min: 20, max: 100, ind: [[20, 65, good], [65, 85, warn], [85, 100, bad]], angles: [225, -45], needle: true },
      { title: 'Engine Speed', unit: 'x1000 rpm', min: 0, max: 8, ind: [[0, 6, good], [6, 7, warn], [7, 8, bad]], angles: [210, -30], needle: true },
      { title: 'Battery', unit: '%', min: 0, max: 100, ind: [[0, 15, bad], [15, 35, warn], [35, 100, good]], angles: [180, 0], needle: false },
      { title: 'Network Latency', unit: 'ms', min: 0, max: 200, ind: [[0, 60, good], [60, 120, warn], [120, 200, bad]], angles: [180, 0], needle: true },
      { title: 'Humidity', unit: '% RH', min: 0, max: 100, ind: [[0, 30, warn], [30, 60, good], [60, 100, warn]], angles: [240, -60], needle: false },
      { title: 'Fuel Pressure', unit: 'bar', min: 0, max: 6, ind: [[0, 1.5, bad], [1.5, 4.5, good], [4.5, 6, warn]], angles: [225, -45], needle: true },
    ]
    const gauges = cfg.map((c, i) => {
      const g = db
        .createGaugeChart({ columnIndex: i % 3, rowIndex: Math.floor(i / 3) })
        .setTitle(c.title)
        .setUnitLabel(c.unit)
        .setInterval(c.min, c.max)
        .setAngleInterval(c.angles[0], c.angles[1])
        .setNeedleVisible(c.needle)
        .setValueIndicators(c.ind.map(([start, end, color]) => ({ start, end, color })))
        .setValueLabelFormatter((v) => (c.max - c.min <= 10 ? v.toFixed(1) : v.toFixed(0)))
      g.setValue(c.min + (c.max - c.min) * (0.3 + 0.4 * Math.random()))
      return { g, c }
    })
    const h = setInterval(() => {
      for (const { g, c } of gauges) {
        if (Math.random() < 0.4) continue
        const span = c.max - c.min
        g.setValue(Math.max(c.min, Math.min(c.max, g.getValue() + (Math.random() - 0.5) * span * 0.35)))
      }
    }, 1200)
    return () => {
      clearInterval(h)
      db.dispose()
    }
  },
} satisfies Example
