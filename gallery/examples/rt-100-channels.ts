import { sferic, PointLineAreaSeries } from '../../src'
import type { Example } from '../types'

const ROWS = 10
const COLS = 10
const PPS = 1000
const HISTORY_S = 60
const VIEW_SAMPLES = 5_000

export default {
  title: '100 Live Channels Dashboard',
  category: 'Dashboards',
  order: 1,
  tags: ['real-time', 'dashboard', 'performance'],
  description: `A ${COLS}x${ROWS} dashboard of independent charts, each streaming ${PPS} samples per second with ${HISTORY_S} s of retained history (${(ROWS * COLS * PPS * HISTORY_S / 1e6).toFixed(0)} M points in memory when full). All cells render through one shared GPU context and one glow pass.`,
  run({ container, theme }) {
    const lc = sferic()
    const dash = lc.Dashboard({ container, theme, numberOfColumns: COLS, numberOfRows: ROWS + 1 })
    dash.setRowHeight(0, 0.35)
    dash
      .createUIPanel({ columnIndex: 0, rowIndex: 0, columnSpan: COLS })
      .setTitle(`${ROWS * COLS} streams at ${PPS} Hz each, ${HISTORY_S} s retained per stream`)
    const series: PointLineAreaSeries[] = []
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const ch = dash.createChartXY({ columnIndex: c, rowIndex: r + 1, legend: { visible: false } }).setPadding(6)
        ch.axisX.setVisible(false).setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - VIEW_SAMPLES, stopAxisAfter: false }))
        ch.axisY.setVisible(false)
        ch.setCursorMode('disabled')
        const i = r * COLS + c
        series.push(ch.addLineSeries({ automaticColorIndex: i }).setStrokeStyle((s) => s.setThickness(1.5)).setMaxSampleCount(PPS * HISTORY_S))
      }
    }
    const phase = series.map((_, i) => i * 0.37)
    const freq = series.map((_, i) => 0.15 + (i % 7) * 0.05)
    const t0 = performance.now()
    let n = 0
    let raf = 0
    const tick = () => {
      const target = Math.floor(((performance.now() - t0) * PPS) / 1000)
      const count = Math.min(target - n, PPS)
      if (count > 0) {
        series.forEach((s, i) => {
          const ys = new Float32Array(count)
          for (let k = 0; k < count; k++) {
            const t = (n + k) / PPS
            ys[k] = Math.sin(t * freq[i] * 6.283 + phase[i]) + Math.sin(t * 3.1 + i) * 0.35 + (Math.random() - 0.5) * 0.45
          }
          s.appendSamples({ start: n, step: 1, yValues: ys })
        })
        n = target
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
