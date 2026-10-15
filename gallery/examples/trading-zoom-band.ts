import { sferic } from '../../src'
import { createProgressiveTraceGenerator } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Zoom Band Chart',
  category: 'XY',
  order: 31,
  tags: ['zoom band', 'navigation', 'overview', 'dashboard'],
  description:
    'A ZoomBandChart below a line chart mirrors its series as a compact overview. The highlighted band is the main X interval: drag it to pan, drag its grips to resize, drag in empty space to select a new range, wheel over it to zoom and double-click to reset. Zooming the main chart moves the band too.',
  run({ container, theme }) {
    const db = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    db.setRowHeight(0, 3).setRowHeight(1, 1)
    const chart = db.createChartXY({ columnIndex: 0, rowIndex: 0 }).setTitle('Sensor traces, 3 x 100 000 samples')
    chart.axisX.setTitle('Sample')
    chart.axisY.setTitle('Value')
    for (let i = 0; i < 3; i++) {
      const data = createProgressiveTraceGenerator().setNumberOfPoints(100_000).setSeed(10 + i).generate().get()
      chart.addLineSeries({ automaticColorIndex: [0, 1, 4][i] }).setName(`Trace ${i + 1}`).appendJSON(data.map((p) => ({ x: p.x, y: p.y + i * 120 })))
    }
    db.createZoomBandChart({ columnIndex: 0, rowIndex: 1, axis: chart.axisX })
    chart.axisX.setInterval({ start: 42_000, end: 58_000, stopAxisAfter: true })
    return () => db.dispose()
  },
} satisfies Example
