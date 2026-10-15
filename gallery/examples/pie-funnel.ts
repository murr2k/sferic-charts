import { sferic, FunnelChartTypes, FunnelLabelSide, FunnelSliceModes, SliceLabelFormatters } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Funnel Chart',
  category: 'Pie & Gauges',
  order: 20,
  tags: ['funnel', 'sales', 'labels'],
  description:
    'Sales pipeline funnel with variable-height slices (height proportional to value), labels on the right with connectors and a 25 % neck. Hover a slice for details.',
  run({ container, theme }) {
    const funnel = sferic()
      .Funnel({ container, theme, type: FunnelChartTypes.LabelsOnSides })
      .setTitle('Sales Pipeline Q3')
      .setSliceMode(FunnelSliceModes.VariableHeight)
      .setHeadWidth(95)
      .setNeckWidth(25)
      .setSliceGap(4)
      .setLabelSide(FunnelLabelSide.Right)
      .setLabelFormatter(SliceLabelFormatters.NamePlusValue)
    funnel.addSlices([
      { name: 'Website visits', value: 12400 },
      { name: 'Downloads', value: 9100 },
      { name: 'Trial sign-ups', value: 6800 },
      { name: 'Qualified leads', value: 5050 },
      { name: 'Proposals', value: 3600 },
      { name: 'Negotiations', value: 2350 },
      { name: 'Closed deals', value: 1480 },
    ])
    return () => funnel.dispose()
  },
} satisfies Example
