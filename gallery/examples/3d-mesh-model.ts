import { sferic, LUT, PalettedFill, regularColorSteps, ColorShadingStyles } from '../../src'
import { torusKnot } from '../../src/xydata/gen3d'
import type { Example } from '../types'

export default {
  title: '3D Mesh Model',
  category: '3D',
  order: 6,
  tags: ['3d', 'mesh', 'model', 'phong', 'animated'],
  description:
    'Procedural torus knot (20 000 triangles) loaded with setModelGeometry, colored by per-vertex values through a palette and lit with Phong shading. The model rotates with setModelRotation.',
  run({ container, theme }) {
    const chart = sferic().Chart3D({ container, theme }).setTitle('Torus Knot Mesh')
    for (const a of chart.getDefaultAxes()) a.setInterval({ start: -1, end: 1, stopAxisAfter: true })
    chart.getDefaultAxisX().setTitle('X')
    chart.getDefaultAxisY().setTitle('Y')
    chart.getDefaultAxisZ().setTitle('Z')

    const knot = torusKnot(3, 5, 500, 24)
    const lut = new LUT({ steps: regularColorSteps(0, 1, [...theme.examples.coldHotColorPalette, theme.examples.coldHotColorPalette[0]]), interpolate: true })
    const model = chart
      .addMeshModel()
      .setName('Torus knot')
      .setModelGeometry({ vertices: knot.vertices, indices: knot.indices })
      .setVertexValues(knot.t)
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }))
      .setColorShadingStyle(new ColorShadingStyles.Phong({ specularReflection: 0.5, shininess: 40 }))
      .setScale(0.76)

    let raf = 0
    const t0 = performance.now()
    const tick = (now: number) => {
      const t = (now - t0) / 1000
      model.setModelRotation({ x: t * 17, y: t * 23, z: 0 })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
