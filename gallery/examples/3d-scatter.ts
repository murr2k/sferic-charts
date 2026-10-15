import { sferic, PointStyle3D, PalettedFill, LUT, regularColorSteps, SolidFill, ColorHEX } from '../../src'
import { gaussianCloud, waterDropPoints } from '../../src/xydata/gen3d'
import type { Example } from '../types'

export default {
  title: '3D Scatter: Ripple Tank',
  category: '3D',
  order: 1,
  tags: ['3d', 'scatter', 'point', 'palette'],
  description:
    'Two 3D point series: lit spheres colored by height (water-drop splash) and a cloud of cubes. Left-drag to rotate, right-drag to pan, wheel to zoom, double-click to reset. Hover a point for its values.',
  run({ container, theme }) {
    const chart = sferic().Chart3D({ container, theme }).setTitle('Ripple Tank Point Cloud')
    chart.getDefaultAxisX().setTitle('Tank X').setUnits('cm')
    chart.getDefaultAxisY().setTitle('Surface height').setUnits('mm')
    chart.getDefaultAxisZ().setTitle('Tank Z').setUnits('cm')

    // Vivid in both themes (the light theme's cold-hot palette has a pale middle).
    const palette = theme.isDark
      ? theme.examples.coldHotColorPalette
      : ['#2c5bd6', '#0f9fd0', '#14b88a', '#e0b020', '#ef6c1e', '#d7191c'].map((c) => ColorHEX(c))
    const lut = new LUT({ steps: regularColorSteps(10, 75, palette), interpolate: true })
    chart
      .addPointSeries()
      .setName('Water drop')
      .setPointStyle(new PointStyle3D.Triangulated({ shape: 'sphere', size: 7, fillStyle: new PalettedFill({ lut, lookUpProperty: 'y' }) }))
      .add(waterDropPoints(4000))

    chart
      .addPointSeries()
      .setName('Cubes')
      .setPointStyle(new PointStyle3D.Triangulated({ shape: 'cube', size: 9, fillStyle: new SolidFill({ color: theme.seriesColors[5] }) }))
      .add(gaussianCloud(400, { x: 50, y: 85, z: 50 }, { x: 14, y: 6, z: 14 }))

    return () => chart.dispose()
  },
} satisfies Example
