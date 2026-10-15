import { sferic, LUT, PalettedFill, regularColorSteps } from '../../src'
import { createWaterDropDataGenerator } from '../../src/xydata'
import type { Example } from '../types'

const SIZE = 1000

export default {
  title: 'Heatmap Grid 1000x1000',
  category: 'Heatmaps',
  order: 1,
  tags: ['heatmap', 'LUT', 'bilinear'],
  description: `A ${SIZE}x${SIZE} intensity grid (one million cells) uploaded once as a float texture and colored by a LUT in the fragment shader. Toggle interpolation with the button. Hover to read a cell value.`,
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { position: 'right' } }).setTitle(`Heatmap Grid ${SIZE}x${SIZE}`)
    const data = createWaterDropDataGenerator().setRows(SIZE).setColumns(SIZE).generateSync()
    let max = 0
    for (const row of data) for (const v of row) if (v > max) max = v
    const lut = new LUT({ steps: regularColorSteps(0, max, theme.examples.intensityColorPalette), interpolate: true, units: 'mm' })
    const heat = chart
      .addHeatmapGridSeries({ columns: SIZE, rows: SIZE, start: { x: 0, y: 0 }, end: { x: SIZE, y: SIZE }, dataOrder: 'rows' })
      .setName('Water depth')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
      .invalidateIntensityValues(data)
    chart.legend.add(lut, { name: 'Depth' })
    chart.legend.remove(heat)
    let bilinear = true
    const btn = chart.addUIElement('button').setText('Interpolation: bilinear').setPosition({ x: 1, y: 99 }).setOrigin({ x: -1, y: 1 })
    btn.addEventListener('click', () => {
      bilinear = !bilinear
      heat.setIntensityInterpolation(bilinear ? 'bilinear' : 'disabled')
      btn.setText(`Interpolation: ${bilinear ? 'bilinear' : 'off'}`)
    })
    return () => chart.dispose()
  },
} satisfies Example
