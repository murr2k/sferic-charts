import { sferic, PointShape } from '../../src'
import { createClusters } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Point Clusters',
  category: 'XY',
  order: 3,
  tags: ['scatter', 'point', 'shapes'],
  description: 'Three Gaussian clusters rendered as point series with different shapes. The cursor snaps to the nearest point in screen space.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Point Clusters')
    const shapes = [PointShape.Circle, PointShape.Triangle, PointShape.Square]
    const centers = [
      { x: 2, y: 3, sx: 0.6, sy: 0.4 },
      { x: 5, y: 6, sx: 0.5, sy: 0.9 },
      { x: 8, y: 2.5, sx: 0.8, sy: 0.6 },
    ]
    centers.forEach((c, i) => {
      chart
        .addPointSeries({ pointShape: shapes[i] })
        .setName(`Cluster ${i + 1}`)
        .setPointSize(7)
        .appendJSON(createClusters(1500, [c], i + 11))
    })
    return () => chart.dispose()
  },
} satisfies Example
