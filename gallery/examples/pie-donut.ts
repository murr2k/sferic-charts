import { sferic, PieChartTypes, SliceSorters } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Donut Chart',
  category: 'Pie & Gauges',
  order: 2,
  tags: ['pie', 'donut', 'labels', 'animation'],
  description:
    'Donut chart (inner radius 55 %) with labels inside the slices, sorted by value. New values arrive every 3 seconds and the slices animate to their new sizes.',
  run({ container, theme }) {
    const donut = sferic()
      .Pie({ container, theme, type: PieChartTypes.LabelsInsideSlices })
      .setTitle('Energy Mix (TWh)')
      .setInnerRadius(55)
      .setSliceSorter(SliceSorters.ValueDescending)
      .setLabelFormatter((s, rel) => (rel > 0.06 ? `${s.getName()}\n${(rel * 100).toFixed(0)} %` : ''))
    donut.legend.setPosition('right')
    const sources = [
      { name: 'Hydro', value: 412 },
      { name: 'Nuclear', value: 287 },
      { name: 'Wind', value: 236 },
      { name: 'Solar', value: 154 },
      { name: 'Gas', value: 198 },
      { name: 'Coal', value: 96 },
      { name: 'Biomass', value: 61 },
    ]
    const slices = sources.map((s) => donut.addSlice(s.name, s.value))
    const h = setInterval(() => {
      slices.forEach((s, i) => s.setValue(Math.round(sources[i].value * (0.7 + Math.random() * 0.6))))
    }, 3000)
    return () => {
      clearInterval(h)
      donut.dispose()
    }
  },
} satisfies Example
