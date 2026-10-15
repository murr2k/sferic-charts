import { sferic, LinearGradientFill, StepOptions, DashedLine, SolidFill, StipplePatterns } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Area, Step and Spline',
  category: 'XY',
  order: 7,
  tags: ['area', 'step', 'spline', 'area range', 'gradient'],
  description:
    'Four charts in one dashboard: a gradient area, step series in before/middle/after modes, a spline through sparse samples, and a confidence band (area range) with its mean line.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 2 })
    const r = rng(5)
    const c = (i: number) => theme.seriesColors[i % theme.seriesColors.length]

    const a = dash.createChartXY({ columnIndex: 0, rowIndex: 0 }).setTitle('Area with gradient fill')
    let y = 50
    const pts = Array.from({ length: 300 }, (_, x) => ({ x, y: (y += (r() - 0.48) * 4) }))
    a.addAreaSeries({ automaticColorIndex: 2 })
      .setName('Throughput')
      .setAreaFillStyle(
        new LinearGradientFill({ angle: 90, stops: [{ offset: 0, color: c(2).setA(0) }, { offset: 1, color: c(2).setA(160) }] }),
      )
      .appendJSON(pts)
    a.axisY.setInterval({ start: 0, end: Math.max(...pts.map((p) => p.y)) * 1.1, stopAxisAfter: true })

    const s = dash.createChartXY({ columnIndex: 1, rowIndex: 0 }).setTitle('Step series')
    const steps = Array.from({ length: 16 }, (_, x) => ({ x, y: Math.round(r() * 8) }))
    ;(['before', 'middle', 'after'] as const).forEach((mode, i) => {
      s.addStepSeries({ mode: StepOptions[mode], automaticColorIndex: i * 2 })
        .setName(`Step ${mode}`)
        .appendJSON(steps.map((p) => ({ x: p.x, y: p.y + i * 10 })))
    })

    const sp = dash.createChartXY({ columnIndex: 0, rowIndex: 1 }).setTitle('Spline vs. linear')
    const sparse = Array.from({ length: 12 }, (_, x) => ({ x: x * 10, y: Math.sin(x * 0.8) * 30 + r() * 10 }))
    sp.addLineSeries({ automaticColorIndex: 7 })
      .setName('Linear')
      .setStrokeStyle(new DashedLine({ thickness: 1.5, fillStyle: new SolidFill({ color: c(7) }), pattern: StipplePatterns.Dashed }))
      .appendJSON(sparse)
    sp.addSplineSeries({ automaticColorIndex: 4 }).setName('Spline').setStrokeStyle((st) => st.setThickness(3)).appendJSON(sparse)
    sp.addPointSeries({ automaticColorIndex: 4 }).setName('Samples').setPointSize(9).appendJSON(sparse)

    const ar = dash.createChartXY({ columnIndex: 1, rowIndex: 1 }).setTitle('Confidence band (area range)')
    const mean: { x: number; y: number }[] = []
    const band: { x: number; y: number; low: number }[] = []
    let m = 0
    for (let x = 0; x < 200; x++) {
      m += (r() - 0.5) * 2
      const spread = 4 + 6 * Math.abs(Math.sin(x / 30))
      mean.push({ x, y: m })
      band.push({ x, y: m + spread, low: m - spread })
    }
    ar.addAreaRangeSeries({ automaticColorIndex: 5 }).setName('95% interval').setStrokeStyle((st) => st.setThickness(1)).appendJSON(band)
    ar.addLineSeries({ automaticColorIndex: 5 }).setName('Mean').appendJSON(mean)
    return () => dash.dispose()
  },
} satisfies Example
