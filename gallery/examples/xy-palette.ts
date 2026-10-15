import { sferic, LUT, PalettedFill, regularColorSteps } from '../../src'
import { rng, gauss } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Value Palette Coloring',
  category: 'XY',
  order: 9,
  tags: ['palette', 'LUT', 'scatter', 'line'],
  description:
    'Per-vertex color lookup on the GPU: a line colored by its Y value, and 200 000 scatter points colored by an extra value channel. The LUTs are shown in the legends.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    const r = rng(3)
    const lutY = new LUT({ steps: regularColorSteps(-1, 1, theme.examples.coldHotColorPalette), interpolate: true })
    const a = dash.createChartXY({ columnIndex: 0, rowIndex: 0 }).setTitle('Line colored by Y')
    const line = a
      .addLineSeries()
      .setName('Temperature anomaly')
      .setStrokeStyle((s) => s.setThickness(3).setFillStyle(new PalettedFill({ lut: lutY, lookUpProperty: 'y' })))
    line.appendJSON(Array.from({ length: 1500 }, (_, i) => ({ x: i, y: Math.sin(i / 120) * 0.7 + Math.sin(i / 17) * 0.2 + (r() - 0.5) * 0.15 })))
    a.legend.add(lutY, { name: 'Anomaly', units: '°C' })
    a.legend.remove(line)

    const b = dash.createChartXY({ columnIndex: 1, rowIndex: 0 }).setTitle('200 000 points colored by value')
    const lutV = new LUT({ steps: regularColorSteps(0, 1, theme.examples.intensityColorPalette.slice(1)), interpolate: true })
    const N = 200_000
    const pts = new Array(N)
    for (let i = 0; i < N; i++) {
      const x = gauss(r)
      const y = gauss(r) * 0.8 + x * 0.4
      pts[i] = { x, y, value: Math.exp(-(x * x + y * y) / 2) }
    }
    const sc = b.addPointSeries().setName('Samples').setPointSize(3).setPointFillStyle(new PalettedFill({ lut: lutV, lookUpProperty: 'value' }))
    sc.appendJSON(pts)
    b.legend.add(lutV, { name: 'Density' })
    b.legend.remove(sc)
    return () => dash.dispose()
  },
} satisfies Example
