import { sferic, SolidFill, RectangleFigure } from '../../src'
import { paramsOf, type Example, type ExampleParam } from '../types'

const SAMPLES = 2400
const HOLD_MS = 2200
const PARAMS: ExampleParam[] = [
  { key: 'nmax', label: 'Highest harmonic', min: 5, max: 151, step: 2, value: 45, restart: true },
  { key: 'stepMs', label: 'Time per term', min: 40, max: 1000, step: 20, value: 320, format: (v) => `${v} ms` },
]

const frac = (t: number) => t - Math.floor(t)

/** Sine-series coefficients b_n of odd waveforms with period 1 and amplitude 1. */
const WAVES = [
  {
    name: 'Square',
    coef: (n: number) => (n % 2 ? 4 / (Math.PI * n) : 0),
    target: (t: number) => (frac(t) < 0.5 ? 1 : -1),
  },
  {
    name: 'Sawtooth',
    coef: (n: number) => ((n % 2 ? 1 : -1) * 2) / (Math.PI * n),
    target: (t: number) => 2 * frac(t + 0.5) - 1,
  },
  {
    name: 'Triangle',
    coef: (n: number) => (n % 2 ? ((((n - 1) / 2) % 2 ? -1 : 1) * 8) / (Math.PI * Math.PI * n * n) : 0),
    target: (t: number) => 1 - 4 * Math.abs(frac(t + 0.25) - 0.5),
  },
]

export default {
  title: 'Fourier Series and the Gibbs Phenomenon',
  category: 'Physics & Math',
  order: 1,
  tags: ['math', 'fourier', 'animation', 'rectangles'],
  params: PARAMS,
  description:
    'Partial sums of the Fourier sine series of a square, sawtooth and triangle wave, adding one harmonic at a time. Near a jump the partial sums overshoot by about 9 % of the jump however many terms are added (the Gibbs phenomenon; the title reports the overshoot as a share of the jump); the continuous triangle wave converges without it. The lower chart shows the coefficient magnitudes |bₙ| with the terms used so far highlighted.',
  run(ctx) {
    const { container, theme } = ctx
    const p = paramsOf(PARAMS, ctx)
    const NMAX = p.nmax
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 2.2).setRowHeight(1, 1)

    const chart = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { position: 'right' } })
    chart.axisX.setTitle('t').setUnits('periods').setInterval({ start: 0, end: 2, stopAxisAfter: true }).setDefaultInterval({ start: 0, end: 2 })
    chart.axisY.setTitle('f(t)').setInterval({ start: -1.45, end: 1.45, stopAxisAfter: true }).setDefaultInterval({ start: -1.45, end: 1.45 })
    const target = chart
      .addLineSeries({ automaticColorIndex: 4 })
      .setName('Target f(t)')
      .setStrokeStyle((s) => s.setThickness(1.5).setFillStyle(new SolidFill({ color: theme.seriesColors[4].setA(170) })))
    const term = chart
      .addLineSeries({ automaticColorIndex: 2 })
      .setName('Newest term')
      .setStrokeStyle((s) => s.setThickness(1.2).setFillStyle(new SolidFill({ color: theme.seriesColors[2].setA(150) })))
    const sum = chart.addLineSeries({ automaticColorIndex: 0 }).setName('Partial sum Sₙ').setStrokeStyle((s) => s.setThickness(2.5))

    const spec = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { visible: false } }).setTitle('Coefficients |bₙ|')
    spec.axisX.setTitle('Harmonic n').setInterval({ start: 0, end: NMAX + 1, stopAxisAfter: true }).setDefaultInterval({ start: 0, end: NMAX + 1 })
    spec.axisY.setTitle('|bₙ|').setInterval({ start: 0, end: 1.4, stopAxisAfter: true }).setDefaultInterval({ start: 0, end: 1.4 })
    const bars = spec.addRectangleSeries().setName('|bₙ|')
    const on = new SolidFill({ color: theme.seriesColors[0] })
    const off = new SolidFill({ color: theme.axisLineColor.setA(70) })
    const figs: RectangleFigure[] = []
    const barW = Math.min(0.34, 0.34 * (45 / NMAX) + 0.1)
    for (let n = 1; n <= NMAX; n++) figs.push(bars.add({ x1: n - barW, y1: 0, x2: n + barW, y2: 0 }).setFillStyle(off))

    const ts = Float64Array.from({ length: SAMPLES }, (_, i) => (2 * i) / (SAMPLES - 1))
    const acc = new Float64Array(SAMPLES)
    const ys = new Float32Array(SAMPLES)
    let wave = WAVES[0]
    let harmonics: number[] = []
    let k = 0

    const selectWave = (w: (typeof WAVES)[number]) => {
      wave = w
      harmonics = []
      for (let n = 1; n <= NMAX; n++) if (wave.coef(n) !== 0) harmonics.push(n)
      acc.fill(0)
      k = 0
      target.setSamples({ xValues: ts, yValues: Float32Array.from(ts, (t) => wave.target(t)) })
      figs.forEach((f, i) => f.setDimensions({ x1: i + 1 - barW, y1: 0, x2: i + 1 + barW, y2: Math.abs(wave.coef(i + 1)) }).setFillStyle(off))
      button.setText(`Waveform: ${wave.name} ▸`)
    }

    /** Add the next harmonic to the running sum and redraw. */
    const addHarmonic = () => {
      const n = harmonics[k++]
      const b = wave.coef(n)
      let peak = -Infinity
      for (let i = 0; i < SAMPLES; i++) {
        const v = b * Math.sin(2 * Math.PI * n * ts[i])
        acc[i] += v
        ys[i] = v
        if (acc[i] > peak) peak = acc[i]
      }
      term.setSamples({ xValues: ts, yValues: ys })
      sum.setSamples({ xValues: ts, yValues: Float32Array.from(acc) })
      figs[n - 1].setFillStyle(on)
      const over = wave.name === 'Triangle' ? '' : `, overshoot ${(((peak - 1) / 2) * 100).toFixed(2)} %`
      chart.setTitle(`${k} term${k > 1 ? 's' : ''}${over}`)
    }

    const button = chart
      .addUIElement('button')
      .setText('Waveform')
      .setPosition({ x: 1, y: 99 })
      .setOrigin({ x: -1, y: 1 })
    let timer = 0
    const schedule = (ms: number) => {
      clearTimeout(timer)
      timer = window.setTimeout(tick, ms)
    }
    const tick = () => {
      if (k < harmonics.length) {
        addHarmonic()
        // Slow start so the first few terms can be followed, then speed up.
        schedule(k < 6 ? p.stepMs * 2.5 : p.stepMs)
      } else {
        // Hold the converged sum, then continue with the next waveform.
        timer = window.setTimeout(() => {
          selectWave(WAVES[(WAVES.indexOf(wave) + 1) % WAVES.length])
          tick()
        }, HOLD_MS)
      }
    }
    button.addEventListener('click', () => {
      selectWave(WAVES[(WAVES.indexOf(wave) + 1) % WAVES.length])
      tick()
    })
    selectWave(WAVES[0])
    tick()

    return () => {
      clearTimeout(timer)
      dash.dispose()
    }
  },
} satisfies Example
