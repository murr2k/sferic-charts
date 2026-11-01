import { sferic, SolidFill, DashedLine, StipplePatterns, LUT, PalettedFill, synchronizeAxisIntervals } from '../../src'
import type { Example } from '../types'

const COLUMNS = 1600
const TRANSIENT = 600
const KEEP = 240
const MAX_TRIES = 6000
const LYAP_ITER = 400

export default {
  title: 'Logistic Map: Route to Chaos',
  category: 'Physics & Math',
  order: 2,
  tags: ['math', 'chaos', 'bifurcation', 'scatter', 'recompute on zoom'],
  description:
    'Bifurcation diagram of xₙ₊₁ = r·xₙ(1 − xₙ): the long-run values of x for each growth rate r. Period doubling leads to chaos near r ≈ 3.57, interrupted by periodic windows. Zoom anywhere (wheel or drag a rectangle) and the diagram is recomputed for the visible range, up to 380 000 points per view, so self-similar copies of the whole picture appear at every scale. The lower chart is the Lyapunov exponent λ(r): negative where the orbit is stable, positive in chaos.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 2.6).setRowHeight(1, 1)

    const chart = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } })
    chart.axisX.setTitle('Growth rate r').setInterval({ start: 2.5, end: 4, stopAxisAfter: true }).setDefaultInterval({ start: 2.5, end: 4 })
    chart.axisY.setTitle('x').setInterval({ start: 0, end: 1, stopAxisAfter: true }).setDefaultInterval({ start: 0, end: 1 })
    const pts = chart
      .addPointSeries()
      .setName('Attractor')
      .setPointSize(1.3)
      .setPointFillStyle(new SolidFill({ color: theme.seriesColors[0].setA(theme.isDark ? 85 : 110) }))
    pts.setCursorEnabled(false)

    const lyapChart = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { visible: false } }).setTitle('Lyapunov exponent λ(r)')
    lyapChart.axisY.setTitle('λ').setInterval({ start: -2.2, end: 0.9, stopAxisAfter: true }).setDefaultInterval({ start: -2.2, end: 0.9 })
    // Same range as the diagram before linking, so neither axis fits itself to data first.
    lyapChart.axisX.setTitle('Growth rate r').setInterval({ start: 2.5, end: 4, stopAxisAfter: true }).setDefaultInterval({ start: 2.5, end: 4 })
    const stable = theme.seriesColors[0]
    const chaotic = theme.seriesColors[1]
    const lut = new LUT({ interpolate: true, steps: [{ value: -0.002, color: stable }, { value: 0.002, color: chaotic }] })
    const lyap = lyapChart
      .addLineSeries()
      .setName('λ(r)')
      .setStrokeStyle((s) => s.setThickness(1.5).setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' })))
    lyapChart.axisY
      .addConstantLine()
      .setName('λ = 0')
      .setValue(0)
      .setMouseInteractions(false)
      .setStrokeStyle(new DashedLine({ thickness: 1, fillStyle: new SolidFill({ color: theme.axisLineColor }), pattern: StipplePatterns.Dashed }))
    synchronizeAxisIntervals(chart.axisX, lyapChart.axisX)

    const xs = new Float64Array(COLUMNS * KEEP)
    const ys = new Float64Array(COLUMNS * KEEP)
    const rs = new Float64Array(COLUMNS)
    const lam = new Float32Array(COLUMNS)

    const compute = () => {
      const t0 = performance.now()
      const { start: a, end: b } = chart.axisX.getInterval()
      const { start: c, end: d } = chart.axisY.getInterval()
      const r0 = Math.max(0, Math.min(a, b)), r1 = Math.min(4, Math.max(a, b))
      const y0 = Math.min(c, d), y1 = Math.max(c, d)
      let n = 0
      for (let i = 0; i < COLUMNS; i++) {
        const r = r0 + ((r1 - r0) * (i + 0.5)) / COLUMNS
        rs[i] = r
        let x = 0.5 + 1e-3 * Math.sin(i)
        for (let k = 0; k < TRANSIENT; k++) x = r * x * (1 - x)
        let sumLog = 0
        let kept = 0
        for (let k = 0; k < MAX_TRIES && (kept < KEEP || k < LYAP_ITER); k++) {
          x = r * x * (1 - x)
          if (k < LYAP_ITER) sumLog += Math.log(Math.abs(r * (1 - 2 * x)) + 1e-12)
          if (kept < KEEP && x >= y0 && x <= y1) {
            xs[n] = r
            ys[n++] = x
            kept++
          }
          // A periodic orbit that never enters a zoomed y-range: give up on this column.
          if (kept === 0 && k > 2 * LYAP_ITER) break
        }
        lam[i] = Math.max(-2.2, sumLog / LYAP_ITER)
      }
      pts.setSamples({ xValues: xs.subarray(0, n), yValues: ys.subarray(0, n) })
      lyap.setSamples({ xValues: rs, yValues: lam })
      const range = `r ∈ [${r0.toPrecision(6)}, ${r1.toPrecision(6)}]`
      chart.setTitle(
        n
          ? `Bifurcation diagram: ${n.toLocaleString('en-US')} points for ${range}, computed in ${Math.round(performance.now() - t0)} ms`
          : `No attractor values in this x range for ${range}: zoom out or widen x`,
      )
    }

    // Recompute once per frame at most, after the view settles.
    let raf = 0
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; compute() })
    }
    chart.axisX.addEventListener('intervalchange', schedule)
    chart.axisY.addEventListener('intervalchange', schedule)
    compute()

    return () => {
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
