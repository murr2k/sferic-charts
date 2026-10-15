import { sferic, LUT, PalettedFill, regularColorSteps, ColorShadingStyles } from '../../src'
import { terrainHeights } from '../../src/xydata/gen3d'
import type { Example } from '../types'

export default {
  title: '3D Surface Grid 1024x1024',
  category: '3D',
  order: 3,
  tags: ['3d', 'surface', 'heatmap', 'dashboard', 'palette'],
  description:
    'Dashboard with a 2D heatmap (left) and a lit 3D surface (right) of the same 1024 x 1024 height map (over one million vertices), both colored by height with the same palette, with contour lines every 10 m. The surface is rendered from a float texture with an index-buffered triangle-strip grid.',
  run({ container, theme }) {
    const COLS = 1024, ROWS = 1024
    const heights = terrainHeights(COLS, ROWS)
    const lut = new LUT({ steps: regularColorSteps(0, 100, theme.examples.intensityColorPalette), interpolate: true, units: 'm' })

    const dashboard = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    dashboard.setColumnWidth(0, 0.8)

    const chart2d = dashboard.createChartXY({ columnIndex: 0, rowIndex: 0 }).setTitle('Height map (2D)')
    chart2d.axisX.setTitle('X')
    chart2d.axisY.setTitle('Z')
    // The 2D heatmap is row-major (row = Z); transpose from the column-major height buffer.
    const rowMajor = new Float32Array(COLS * ROWS)
    for (let c = 0; c < COLS; c++) for (let r = 0; r < ROWS; r++) rowMajor[r * COLS + c] = heights[c * ROWS + r]
    chart2d
      .addHeatmapGridSeries({ columns: COLS, rows: ROWS, start: { x: 0, y: 0 }, end: { x: 1000, y: 1000 } })
      .setName('Height')
      .setFillStyle(new PalettedFill({ lut }))
      .setRowMajorValues(rowMajor)
    chart2d.legend.setVisible(false)

    const chart3d = dashboard.createChart3D({ columnIndex: 1, rowIndex: 0 }).setTitle('Surface (3D)')
    chart3d.setBoundingBox({ x: 1, y: 0.4, z: 1 })
    chart3d.getDefaultAxisX().setTitle('X')
    chart3d.getDefaultAxisY().setTitle('Height').setUnits('m')
    chart3d.getDefaultAxisZ().setTitle('Z')
    chart3d.legend.setPosition('right')
    chart3d
      .addSurfaceGridSeries({ columns: COLS, rows: ROWS, start: { x: 0, z: 0 }, end: { x: 1000, z: 1000 } })
      .setName('Terrain')
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' }))
      .setColorShadingStyle(new ColorShadingStyles.Phong({ specularReflection: 0.15 }))
      .setContours({ interval: 10 })
      .invalidateHeightMap(heights)

    return () => dashboard.dispose()
  },
} satisfies Example
