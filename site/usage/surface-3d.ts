import { sferic, LUT, PalettedFill, regularColorSteps } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: '3D surface',
  order: 5,
  summary: 'A 300 × 300 surface grid of z = sin(r) / r, colored by height with a LUT. Left-drag to orbit, right-drag to pan, wheel to zoom.',
  run({ container, theme }) {
    // #region
    const chart = sferic().Chart3D({ container, theme }).setTitle('z = sin(r) / r')
    chart.setBoundingBox({ x: 1, y: 0.45, z: 1 })
    chart.getDefaultAxisY().setTitle('z')
    const lut = new LUT({ steps: regularColorSteps(-0.25, 1, theme.examples.coldHotColorPalette), interpolate: true })

    const size = 300
    const heights = Array.from({ length: size }, (_, col) =>
      Array.from({ length: size }, (_, row) => {
        const r = Math.hypot(col - size / 2, row - size / 2) / 7 + 1e-9
        return Math.sin(r) / r
      }),
    )
    chart
      .addSurfaceGridSeries({ columns: size, rows: size, start: { x: -20, z: -20 }, end: { x: 20, z: 20 } })
      .setName('sinc')
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' }))
      .invalidateHeightMap(heights)
    // #endregion
  },
} satisfies Snippet
