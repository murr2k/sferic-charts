import { sferic, PieChartTypes, SliceLabelFormatters } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Pie Chart',
  category: 'Pie & Gauges',
  order: 1,
  tags: ['pie', 'labels', 'explode', 'legend'],
  description:
    'Pie chart with labels in side columns. Hover a slice for details, click to explode it (several slices may be exploded at once), click a legend entry to hide a slice; the remaining slices animate to fill the circle.',
  run({ container, theme }) {
    const pie = sferic()
      .Pie({ container, theme, type: PieChartTypes.LabelsOnSides })
      .setTitle('Engineering Hours by Phase')
      .setMultipleSliceExplosion(true)
      .setLabelFormatter(SliceLabelFormatters.NamePlusRelativeValue)
    const data = [
      { name: 'Requirements', value: 32 },
      { name: 'Architecture', value: 56 },
      { name: 'Implementation', value: 146 },
      { name: 'Verification', value: 78 },
      { name: 'Integration', value: 41 },
      { name: 'Documentation', value: 22 },
      { name: 'Release', value: 15 },
    ]
    const slices = data.map((d) => pie.addSlice(d.name, d.value))
    slices[1].setExploded(true)
    return () => pie.dispose()
  },
} satisfies Example
