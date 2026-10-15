import { sferic, LUT, PieChartTypes, regularColorSteps, SliceLabelFormatters, SliceSorters } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Pie Chart with LUT',
  category: 'Pie & Gauges',
  order: 3,
  tags: ['pie', 'lut', 'color', 'animation'],
  description:
    'Slice colors come from a value look-up table instead of the theme palette: low values cold, high values hot. Values change every 2 seconds; colors and angles animate with them.',
  run({ container, theme }) {
    const lut = new LUT({ steps: regularColorSteps(0, 100, theme.examples.coldHotColorPalette), interpolate: true })
    const pie = sferic()
      .Pie({ container, theme, type: PieChartTypes.LabelsOnSides })
      .setTitle('Server Rack Utilization (%)')
      .setLUT(lut)
      .setSliceSorter(SliceSorters.ValueDescending)
      .setLabelFormatter(SliceLabelFormatters.NamePlusValue)
    pie.legend.setOptions({ addEntriesAutomatically: false })
    pie.legend.add(lut, { name: 'Utilization', units: '%' })
    const racks = ['Rack A', 'Rack B', 'Rack C', 'Rack D', 'Rack E', 'Rack F', 'Rack G', 'Rack H']
    const slices = racks.map((r, i) => pie.addSlice(r, 15 + ((i * 29) % 80)))
    const h = setInterval(() => {
      for (const s of slices) s.setValue(Math.round(Math.max(5, Math.min(100, s.getValue() + (Math.random() - 0.5) * 50))))
    }, 2000)
    return () => {
      clearInterval(h)
      pie.dispose()
    }
  },
} satisfies Example
