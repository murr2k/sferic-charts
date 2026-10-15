import { sferic, PyramidChartTypes, PyramidSliceModes } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Pyramid Chart',
  category: 'Pie & Gauges',
  order: 21,
  tags: ['pyramid', 'labels'],
  description:
    'Pyramid chart with variable-width slices (equal heights, width proportional to value) and labels inside the slices. The largest slice sits at the base.',
  run({ container, theme }) {
    const pyramid = sferic()
      .Pyramid({ container, theme, type: PyramidChartTypes.LabelsInsideSlices })
      .setTitle('Website Traffic by Channel (k sessions)')
      .setSliceMode(PyramidSliceModes.VariableWidth)
      .setNeckWidth(0)
      .setSliceGap(5)
      .setLabelFormatter((s) => `${s.getName()}  ${s.getValue()}`)
    pyramid.addSlices([
      { name: 'Organic search', value: 412 },
      { name: 'Direct', value: 318 },
      { name: 'Social', value: 245 },
      { name: 'Referral', value: 176 },
      { name: 'Email', value: 118 },
      { name: 'Paid', value: 74 },
    ])
    return () => pyramid.dispose()
  },
} satisfies Example
