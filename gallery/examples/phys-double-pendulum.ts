import { sferic, ColorRGBA, PointShape } from '../../src'
import type { Example } from '../types'

const N = 300
const G = 9.81
const DELTA = 1e-7 // rad between neighbouring initial conditions
const THETA0 = 2.4 // rad, high-energy (chaotic) start
const DT = 1 / 600
const SUBSTEPS = 10 // per frame: 1/60 s of simulated time
const RUN_S = 24

/** Equal masses and lengths (m = l = 1): returns [θ1', θ2', ω1', ω2']. */
function deriv(t1: number, t2: number, w1: number, w2: number, out: Float64Array) {
  const d = t1 - t2
  const sd = Math.sin(d), cd = Math.cos(d)
  const den = 3 - Math.cos(2 * d)
  out[0] = w1
  out[1] = w2
  out[2] = (-3 * G * Math.sin(t1) - G * Math.sin(t1 - 2 * t2) - 2 * sd * (w2 * w2 + w1 * w1 * cd)) / den
  out[3] = (2 * sd * (2 * w1 * w1 + 2 * G * Math.cos(t1) + w2 * w2 * cd)) / den
}

export default {
  title: 'Chaos: 300 Double Pendulums',
  category: 'Physics & Math',
  order: 5,
  tags: ['physics', 'chaos', 'simulation', 'log axis', 'per-vertex color'],
  description:
    'Three hundred double pendulums whose starting angles differ by 10⁻⁷ rad, integrated with fourth-order Runge-Kutta. For a few seconds they move as one; then the tiny differences grow exponentially and the ensemble fans out. The right chart plots the spread of the lower arm angle on a logarithmic axis: the straight segment is exponential growth, its slope the largest Lyapunov exponent. All 300 pendulums are one line series with per-vertex colors and NaN gaps, re-uploaded every frame.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    dash.setColumnWidth(0, 1.15).setColumnWidth(1, 1)

    const view = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } }).setTitle('Pendulums')
    view.axisX.setInterval({ start: -2.3, end: 2.3, stopAxisAfter: true }).setDefaultInterval({ start: -2.3, end: 2.3 }).setTitle('x').setUnits('m')
    view.axisY.setInterval({ start: -2.3, end: 2.3, stopAxisAfter: true }).setDefaultInterval({ start: -2.3, end: 2.3 }).setTitle('y').setUnits('m')
    const rods = view.addLineSeries().setName('Arms').setStrokeStyle((s) => s.setThickness(1.2))
    rods.setCursorEnabled(false)
    const bobs = view.addPointSeries({ pointShape: PointShape.Circle }).setName('Bobs').setPointSize(5)
    bobs.setCursorEnabled(false)

    const div = dash
      .createChartXY({ columnIndex: 1, rowIndex: 0, legend: { visible: false }, defaultAxisY: { type: 'logarithmic', base: 10 } })
      .setTitle('Spread of θ₂ (RMS, rad)')
    div.axisX.setTitle('Time').setUnits('s').setInterval({ start: 0, end: RUN_S, stopAxisAfter: true }).setDefaultInterval({ start: 0, end: RUN_S })
    div.axisY.setTitle('Spread').setUnits('rad').setInterval({ start: 1e-6, end: 10, stopAxisAfter: true }).setDefaultInterval({ start: 1e-6, end: 10 })
    const spread = div.addLineSeries({ automaticColorIndex: 1 }).setName('RMS spread').setStrokeStyle((s) => s.setThickness(2))

    // Colors run between two palette slots in order of initial angle.
    const a = theme.seriesColors[0], b = theme.seriesColors[3]
    const mix = (f: number) =>
      ColorRGBA(
        Math.round(a.getR() + (b.getR() - a.getR()) * f),
        Math.round(a.getG() + (b.getG() - a.getG()) * f),
        Math.round(a.getB() + (b.getB() - a.getB()) * f),
        theme.isDark ? 175 : 200,
      ).toUint32()
    const hue = Uint32Array.from({ length: N }, (_, i) => mix(i / (N - 1)))
    const rodColors = new Uint32Array(4 * N)
    for (let i = 0; i < N; i++) rodColors.fill(hue[i], 4 * i, 4 * i + 4)

    const s = new Float64Array(4 * N)
    const k1 = new Float64Array(4), k2 = new Float64Array(4), k3 = new Float64Array(4), k4 = new Float64Array(4)
    const xs = new Float64Array(4 * N), ys = new Float64Array(4 * N)
    const bx = new Float64Array(N), by = new Float64Array(N)
    let time = 0

    const reset = () => {
      for (let i = 0; i < N; i++) {
        s[4 * i] = THETA0 + (i - N / 2) * DELTA
        s[4 * i + 1] = THETA0
        s[4 * i + 2] = 0
        s[4 * i + 3] = 0
      }
      time = 0
      spread.clear()
    }

    const rk4 = (o: number) => {
      const t1 = s[o], t2 = s[o + 1], w1 = s[o + 2], w2 = s[o + 3]
      const h = DT
      deriv(t1, t2, w1, w2, k1)
      deriv(t1 + (h / 2) * k1[0], t2 + (h / 2) * k1[1], w1 + (h / 2) * k1[2], w2 + (h / 2) * k1[3], k2)
      deriv(t1 + (h / 2) * k2[0], t2 + (h / 2) * k2[1], w1 + (h / 2) * k2[2], w2 + (h / 2) * k2[3], k3)
      deriv(t1 + h * k3[0], t2 + h * k3[1], w1 + h * k3[2], w2 + h * k3[3], k4)
      for (let j = 0; j < 4; j++) s[o + j] += (h / 6) * (k1[j] + 2 * k2[j] + 2 * k3[j] + k4[j])
    }

    const draw = () => {
      for (let i = 0; i < N; i++) {
        const t1 = s[4 * i], t2 = s[4 * i + 1]
        const x1 = Math.sin(t1), y1 = -Math.cos(t1)
        const x2 = x1 + Math.sin(t2), y2 = y1 - Math.cos(t2)
        const o = 4 * i
        xs[o] = 0; ys[o] = 0
        xs[o + 1] = x1; ys[o + 1] = y1
        xs[o + 2] = x2; ys[o + 2] = y2
        xs[o + 3] = x2; ys[o + 3] = NaN // gap before the next pendulum
        bx[i] = x2; by[i] = y2
      }
      rods.setSamples({ xValues: xs, yValues: ys, colors: rodColors })
      bobs.setSamples({ xValues: bx, yValues: by, colors: hue })
      // RMS of the lower-arm angle relative to the ensemble's first member, wrapped to [-π, π].
      let sum = 0
      const ref = s[1]
      for (let i = 0; i < N; i++) {
        let d = (s[4 * i + 1] - ref) % (2 * Math.PI)
        if (d > Math.PI) d -= 2 * Math.PI
        else if (d < -Math.PI) d += 2 * Math.PI
        sum += d * d
      }
      spread.appendSample({ x: time, y: Math.max(1e-9, Math.sqrt(sum / N)) })
    }

    div.addUIElement('button').setText('Restart').setPosition({ x: 99, y: 99 }).setOrigin({ x: 1, y: 1 }).addEventListener('click', reset)
    reset()

    let raf = 0
    const frame = () => {
      for (let k = 0; k < SUBSTEPS; k++) {
        for (let i = 0; i < N; i++) rk4(4 * i)
        time += DT
      }
      draw()
      if (time >= RUN_S) reset()
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
