import { sferic, AxisTickStrategies, PointLineAreaSeries, ChartXY, UIOrigins, UIPanel } from '../../src'
import type { Example } from '../types'

const SWEEP_S = 8
const GAP_S = 0.12

interface Channel {
  name: string
  unit: string
  rate: number
  color: number
  range: [number, number]
  wave: (t: number) => number
  value: () => string
}

// Synthetic physiological waveforms.
const hr = 72
const rr = 60 / hr
const gaussian = (x: number, mu: number, s: number) => Math.exp(-((x - mu) ** 2) / (2 * s * s))
const ecg = (t: number) => {
  const p = (t % rr) / rr
  return 0.12 * gaussian(p, 0.18, 0.025) - 0.15 * gaussian(p, 0.355, 0.008) + 1.25 * gaussian(p, 0.38, 0.011) - 0.3 * gaussian(p, 0.405, 0.01) + 0.32 * gaussian(p, 0.62, 0.045) + (Math.random() - 0.5) * 0.02
}
const pleth = (t: number) => {
  const p = ((t - 0.15) % rr + rr) % rr / rr
  return gaussian(p, 0.25, 0.09) + 0.35 * gaussian(p, 0.52, 0.07)
}
const resp = (t: number) => Math.sin(t * 2 * Math.PI * 0.25) + 0.15 * Math.sin(t * 2 * Math.PI * 0.75)
const abp = (t: number) => {
  const p = (t % rr) / rr
  return 78 + 40 * gaussian(p, 0.42, 0.06) + 12 * gaussian(p, 0.62, 0.05) + 4 * Math.cos(p * 2 * Math.PI)
}

export default {
  title: 'Medical Monitor (sweeping)',
  category: 'Real-time',
  order: 2,
  tags: ['real-time', 'sweeping', 'dashboard', 'ECG'],
  description:
    'A patient monitor: four synthetic waveforms in sweeping mode (new data overwrites the oldest from left to right, with a moving gap), plus live numeric readouts. Built from two series per channel on a fixed X interval.',
  run({ container, theme }) {
    const channels: Channel[] = [
      { name: 'ECG II', unit: 'mV', rate: 500, color: 6, range: [-0.5, 1.5], wave: ecg, value: () => `${hr + Math.round((Math.random() - 0.5) * 2)}` },
      { name: 'Pleth SpO2', unit: '%', rate: 250, color: 0, range: [-0.1, 1.2], wave: pleth, value: () => `${97 + Math.round(Math.random())}` },
      { name: 'Resp', unit: 'rpm', rate: 100, color: 1, range: [-1.4, 1.4], wave: resp, value: () => '15' },
      { name: 'ABP', unit: 'mmHg', rate: 250, color: 3, range: [60, 130], wave: abp, value: () => `${118 + Math.round(Math.random() * 3)}/${78 + Math.round(Math.random() * 2)}` },
    ]
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: channels.length })
    dash.setColumnWidth(0, 5).setColumnWidth(1, 1.2)
    const color = (i: number) => theme.seriesColors[i % theme.seriesColors.length]
    const rows = channels.map((c, i) => {
      const chart: ChartXY = dash.createChartXY({ columnIndex: 0, rowIndex: i, legend: { visible: false } }).setTitle('')
      chart.setPadding({ top: 6, bottom: 6, left: 8, right: 16 })
      chart.axisX.setTickStrategy(AxisTickStrategies.Empty).setInterval({ start: 0, end: SWEEP_S, stopAxisAfter: true }).setMouseInteractions(false)
      chart.axisY.setTitle(c.name).setInterval({ start: c.range[0], end: c.range[1], stopAxisAfter: true }).setMouseInteractions(false)
      chart.setCursorMode('disabled').setMouseInteractions(false)
      const mk = () => chart.addLineSeries({ automaticColorIndex: c.color }).setStrokeStyle((s) => s.setThickness(2))
      const panel: UIPanel = dash.createUIPanel({ columnIndex: 1, rowIndex: i })
      const label = panel.addUIElement().setText(c.name).setPosition({ x: 6, y: 92 }).setOrigin(UIOrigins.LeftTop).setTextFillStyle((f) => f.setColor(color(c.color)))
      const big = panel.addUIElement().setText('--').setPosition({ x: 50, y: 45 }).setOrigin(UIOrigins.Center).setTextFont((f) => f.setSize(i === 3 ? 30 : 44)).setTextFillStyle((f) => f.setColor(color(c.color)))
      panel.addUIElement().setText(c.unit).setPosition({ x: 94, y: 8 }).setOrigin(UIOrigins.RightBottom).setTextFillStyle((f) => f.setColor(theme.minorTickLabelColor))
      void label
      return { c, chart, cur: mk(), prev: mk(), big, xs: [] as number[], ys: [] as number[], n: 0 }
    })
    const t0 = performance.now()
    let raf = 0
    let lastReadout = -1
    const tick = () => {
      const t = (performance.now() - t0) / 1000
      for (const r of rows) {
        const target = Math.floor(t * r.c.rate)
        const xs: number[] = [], ys: number[] = []
        for (let k = r.n; k < target; k++) {
          const ts = k / r.c.rate
          const x = ts % SWEEP_S
          if (r.xs.length && x < r.xs[r.xs.length - 1]) {
            // Wrap: the finished sweep becomes the fading "previous" trace.
            if (xs.length) { r.cur.appendSamples({ xValues: xs, yValues: ys }); xs.length = 0; ys.length = 0 }
            r.prev.clear().appendSamples({ xValues: r.xs, yValues: r.ys })
            r.cur.clear()
            r.xs = []
            r.ys = []
          }
          const y = r.c.wave(ts)
          xs.push(x); ys.push(y)
          r.xs.push(x); r.ys.push(y)
        }
        r.n = target
        if (xs.length) r.cur.appendSamples({ xValues: xs, yValues: ys })
        // Erase the previous sweep just ahead of the write head.
        const head = r.xs.length ? r.xs[r.xs.length - 1] : 0
        const keep = r.prev.getSampleCount() ? Math.floor((SWEEP_S - head - GAP_S) * r.c.rate) : 0
        if (keep <= 0) { if (r.prev.getSampleCount()) r.prev.clear() }
        else if (keep < r.prev.getSampleCount()) r.prev.setMaxSampleCount(keep)
      }
      if (Math.floor(t) !== lastReadout) {
        lastReadout = Math.floor(t)
        for (const r of rows) r.big.setText(r.c.value())
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

export type { PointLineAreaSeries }
