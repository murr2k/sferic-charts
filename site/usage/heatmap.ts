import { sferic, LUT, PalettedFill, regularColorSteps } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Heatmap and color lookup table',
  order: 3,
  summary: 'A 500 × 500 heatmap of two-source interference, colored on the GPU through a LUT that also feeds the legend. Values are a plain number[][] (rows × columns).',
  run({ container, theme }) {
    // #region
    const chart = sferic().ChartXY({ container, theme }).setTitle('Two-source interference')
    const lut = new LUT({ steps: regularColorSteps(0, 1, theme.examples.intensityColorPalette), interpolate: true })

    const size = 500
    const intensity = Array.from({ length: size }, (_, row) =>
      Array.from({ length: size }, (_, col) => {
        const x = (col / size) * 20 - 10
        const y = (row / size) * 20 - 10
        const r1 = Math.hypot(x - 1.6, y)
        const r2 = Math.hypot(x + 1.6, y)
        return Math.cos(2.2 * (r1 - r2)) ** 2 / (1 + 0.08 * (r1 + r2))
      }),
    )
    const heatmap = chart
      .addHeatmapGridSeries({ columns: size, rows: size, start: { x: -10, y: -10 }, end: { x: 10, y: 10 }, dataOrder: 'rows' })
      .setName('Intensity')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
      .invalidateIntensityValues(intensity)
    // Show the color scale in the legend instead of the series' own entry.
    chart.legend.remove(heatmap)
    chart.legend.add(lut, { name: 'Intensity' })
    // #endregion
  },
} satisfies Snippet
