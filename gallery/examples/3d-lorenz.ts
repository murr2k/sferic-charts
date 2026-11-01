import { sferic, LUT, PalettedFill, regularColorSteps, SolidLine } from '../../src'
import { lorenz } from '../../src/xydata/gen3d'
import { paramsOf, type Example, type ExampleParam } from '../types'

const PARAMS: ExampleParam[] = [
  { key: 'sigma', label: 'σ', min: 1, max: 30, step: 0.5, value: 10 },
  { key: 'rho', label: 'ρ', min: 0.5, max: 100, step: 0.5, value: 28 },
  { key: 'beta', label: 'β', min: 0.5, max: 6, step: 0.05, value: 2.65, format: (v) => v.toFixed(2) },
]

export default {
  title: '3D Line Series',
  category: '3D',
  order: 2,
  tags: ['3d', 'line', 'palette', 'glow'],
  params: PARAMS,
  description:
    'Lorenz attractor drawn as a thick 3D polyline (60 000 samples) colored by height with a palette. Lines are screen-space quads built in the vertex shader. Drag to rotate, wheel to zoom. Change σ, ρ and β to redraw it: below ρ ≈ 24.7 the trajectory settles onto one of two fixed points, ρ = 28 is the classic butterfly, and some larger values give periodic orbits.',
  run(ctx) {
    const { container, theme } = ctx
    const p = paramsOf(PARAMS, ctx)
    const chart = sferic().Chart3D({ container, theme })
    chart.setBoundingBox({ x: 1, y: 0.8, z: 1 })
    chart.getDefaultAxisX().setTitle('X')
    chart.getDefaultAxisY().setTitle('Z (height)')
    chart.getDefaultAxisZ().setTitle('Y')
    const series = chart.addLineSeries().setName('Trajectory')

    // Grow the trajectory progressively for a drawing effect.
    let raf = 0
    const draw = () => {
      cancelAnimationFrame(raf)
      chart.setTitle(`Lorenz Attractor (σ = ${p.sigma}, ρ = ${p.rho}, β = ${p.beta.toFixed(2)})`)
      // Color by height over the range the attractor occupies (z stays near 0..1.7ρ).
      const lut = new LUT({ steps: regularColorSteps(Math.min(2, p.rho / 14), Math.max(4, 1.72 * p.rho), theme.examples.spectrogramColorPalette.slice(2)), interpolate: true })
      series.clear().setLineStyle(new SolidLine({ thickness: 2, fillStyle: new PalettedFill({ lut, lookUpProperty: 'y' }) }))
      const data = lorenz(60000, 0.005, p.sigma, p.rho, p.beta)
      let i = 0
      const step = () => {
        const n = Math.min(900, data.length - i)
        if (n > 0) {
          series.add(data.slice(i, i + n))
          i += n
          raf = requestAnimationFrame(step)
        }
      }
      step()
    }
    let pending = 0
    ctx.onParamChange?.(() => {
      clearTimeout(pending)
      pending = window.setTimeout(draw, 120)
    })
    draw()
    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(pending)
      chart.dispose()
    }
  },
} satisfies Example
