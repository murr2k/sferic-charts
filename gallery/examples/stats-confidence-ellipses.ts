import { sferic, SolidFill, SolidLine, DashedLine, StipplePatterns } from '../../src'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Cluster Ellipses and Segments',
  category: 'Statistics',
  order: 4,
  tags: ['ellipse', 'segment', 'scatter', 'clusters'],
  description:
    'Three gaussian clusters with their 1 sigma and 2 sigma ellipses (EllipseSeries, SDF-rendered on the GPU) and the mean plus/minus one standard deviation drawn as segments (SegmentSeries). Hover an ellipse or segment for its dimensions.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Sensor clusters')
    chart.axisX.setTitle('Feature 1')
    chart.axisY.setTitle('Feature 2')
    const t = chart.getTheme()
    const r = rng(5)
    const clusters = [
      { x: 2, y: 3, sx: 0.9, sy: 0.45, n: 1500, c: 0 },
      { x: 5.5, y: 1.5, sx: 0.5, sy: 1.0, n: 1200, c: 1 },
      { x: 6, y: 5, sx: 1.3, sy: 0.6, n: 1800, c: 4 },
    ]
    const stats = clusters.map((cl) => {
      const pts = Array.from({ length: cl.n }, () => ({ x: cl.x + gauss(r) * cl.sx, y: cl.y + gauss(r) * cl.sy }))
      chart
        .addPointSeries({ automaticColorIndex: cl.c })
        .setName(`Cluster ${clusters.indexOf(cl) + 1}`)
        .setPointSize(3)
        .setPointFillStyle(new SolidFill({ color: t.seriesColors[cl.c].setA(150) }))
        .appendJSON(pts)
      const mx = pts.reduce((a, p) => a + p.x, 0) / pts.length
      const my = pts.reduce((a, p) => a + p.y, 0) / pts.length
      const sx = Math.sqrt(pts.reduce((a, p) => a + (p.x - mx) ** 2, 0) / pts.length)
      const sy = Math.sqrt(pts.reduce((a, p) => a + (p.y - my) ** 2, 0) / pts.length)
      return { mx, my, sx, sy, col: t.seriesColors[cl.c] }
    })
    // Figures are drawn above the scatter points.
    const ellipses = chart.addEllipseSeries({ automaticColorIndex: 9 }).setName('Sigma ellipses')
    const segs = chart.addSegmentSeries({ automaticColorIndex: 9 }).setName('Mean +/- 1 sigma')
    const sc = new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: t.examples.mainTextColor.setA(220) }) })
    segs.setStrokeStyle(sc)
    for (const { mx, my, sx, sy, col } of stats) {
      ellipses
        .add({ x: mx, y: my, radiusX: 2 * sx, radiusY: 2 * sy })
        .setFillStyle(new SolidFill({ color: col.setA(18) }))
        .setStrokeStyle(new DashedLine({ thickness: 1.5, pattern: StipplePatterns.Dashed, fillStyle: new SolidFill({ color: col.setA(190) }) }))
      ellipses
        .add({ x: mx, y: my, radiusX: sx, radiusY: sy })
        .setFillStyle(new SolidFill({ color: col.setA(36) }))
        .setStrokeStyle(new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: col }) }))
      segs.add({ startX: mx - sx, startY: my, endX: mx + sx, endY: my })
      segs.add({ startX: mx, startY: my - sy, endX: mx, endY: my + sy })
    }
    return () => chart.dispose()
  },
} satisfies Example
