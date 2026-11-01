import { sferic, LUT, PalettedFill, regularColorSteps, SolidFill } from '../../src'
import type { Example } from '../types'

// Grid: 1 cell = 1 mm. Courant number squared c²Δt²/Δx² = 0.25 (stable below 0.5 in 2D).
const W = 360, H = 240
const C2 = 0.25
const WAVELENGTH = 16 // cells
const OMEGA = (2 * Math.PI * Math.sqrt(C2)) / WAVELENGTH
const STEPS_PER_FRAME = 6
const SPONGE = 26
const SOURCE_X = 8
const BARRIER_X = 120, BARRIER_W = 4
const SCREEN_X = W - SPONGE - 6

type Scene = { name: string; openings: [number, number][]; sources: [number, number][] | null }
const SCENES: Scene[] = [
  { name: 'Double slit', openings: [[H / 2 - 30, H / 2 - 22], [H / 2 + 22, H / 2 + 30]], sources: null },
  { name: 'Single slit', openings: [[H / 2 - 9, H / 2 + 9]], sources: null },
  { name: 'Two point sources', openings: [], sources: [[110, H / 2 - 26], [110, H / 2 + 26]] },
]

export default {
  title: 'Wave Interference: Double Slit',
  category: 'Physics & Math',
  order: 4,
  tags: ['physics', 'simulation', 'heatmap', 'wave equation', 'interactive'],
  description:
    'A finite-difference solution of the 2D wave equation on a 360 × 240 grid, advanced six time steps per frame and uploaded to a heatmap every frame. A plane wave hits a barrier with two slits; the right panel accumulates the time-averaged intensity across the far edge, building the interference fringes. Absorbing layers at the edges stop reflections. Click the tank to drop a pebble; the button switches between double slit, single slit (diffraction) and two point sources.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 2, numberOfRows: 1 })
    dash.setColumnWidth(0, 3.4).setColumnWidth(1, 1)

    const tank = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } }).setMouseInteractions(false)
    tank.axisX.setTitle('x').setUnits('cm').setInterval({ start: 0, end: W / 10, stopAxisAfter: true })
    tank.axisY.setTitle('y').setUnits('cm').setInterval({ start: 0, end: H / 10, stopAxisAfter: true })
    const lut = new LUT({ steps: regularColorSteps(-0.7, 0.7, theme.examples.positiveNegativeColorPalette), interpolate: true })
    const heat = tank
      .addHeatmapGridSeries({ columns: W, rows: H, start: { x: 0, y: 0 }, end: { x: W / 10, y: H / 10 } })
      .setName('Displacement')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
    const walls = tank.addRectangleSeries().setName('Barrier')
    const wallFill = new SolidFill({ color: theme.isDark ? theme.axisLineColor : theme.titleColor })
    tank.axisX.addConstantLine().setName('Screen').setValue(SCREEN_X / 10).setMouseInteractions(false)

    const screen = dash.createChartXY({ columnIndex: 1, rowIndex: 0, legend: { visible: false } }).setTitle('Intensity at screen')
    screen.axisY.setTitle('y').setUnits('cm').setInterval({ start: 0, end: H / 10, stopAxisAfter: true })
    screen.axisX.setTitle('⟨u²⟩').setInterval({ start: 0, end: 1.05, stopAxisAfter: true })
    const profile = screen.addLineSeries({ automaticColorIndex: 1 }).setName('Intensity').setStrokeStyle((s) => s.setThickness(2))

    // Fields: u (now), v (previous, overwritten with next), per-cell damping and wall mask.
    let u = new Float32Array(W * H)
    let v = new Float32Array(W * H)
    const damp = new Float32Array(W * H)
    const wall = new Uint8Array(W * H)
    const intensity = new Float64Array(H)
    const ys = Float64Array.from({ length: H }, (_, y) => (y + 0.5) / 10)
    const prof = new Float32Array(H)
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const d = Math.min(x, W - 1 - x, y, H - 1 - y)
        const s = Math.max(0, (SPONGE - d) / SPONGE)
        damp[y * W + x] = 1 - 0.12 * s * s
      }
    }

    let scene = SCENES[0]
    let t = 0
    const setScene = (s: Scene) => {
      scene = s
      u.fill(0)
      v.fill(0)
      wall.fill(0)
      intensity.fill(0)
      t = 0
      walls.clear()
      if (!s.sources) {
        // Barrier with openings [a, b) in cells; drawn as rectangles between the openings.
        const edges = [0, ...s.openings.flat(), H]
        for (let k = 0; k < edges.length; k += 2) {
          const [a, b] = [edges[k], edges[k + 1]]
          for (let y = a; y < b; y++) for (let x = BARRIER_X; x < BARRIER_X + BARRIER_W; x++) wall[y * W + x] = 1
          walls.add({ x1: BARRIER_X / 10, y1: a / 10, x2: (BARRIER_X + BARRIER_W) / 10, y2: b / 10 }).setFillStyle(wallFill)
        }
      }
      button.setText(`Scene: ${s.name} ▸`)
      tank.setTitle(`${s.name}: λ = ${WAVELENGTH / 10} cm (click the tank to drop a pebble)`)
    }

    const step = () => {
      for (let y = 1; y < H - 1; y++) {
        let i = y * W + 1
        for (let x = 1; x < W - 1; x++, i++) {
          if (wall[i]) { v[i] = 0; continue }
          const lap = u[i - 1] + u[i + 1] + u[i - W] + u[i + W] - 4 * u[i]
          v[i] = (2 * u[i] - v[i] + C2 * lap) * damp[i]
        }
      }
      const tmp = u; u = v; v = tmp
      t++
      const a = Math.sin(OMEGA * t) * Math.min(1, t / 60)
      if (scene.sources) {
        for (const [sx, sy] of scene.sources) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) u[(sy + dy) * W + sx + dx] = a
      } else {
        for (let y = 1; y < H - 1; y++) u[y * W + SOURCE_X] = a * 0.8
      }
      for (let y = 0; y < H; y++) {
        const s = u[y * W + SCREEN_X]
        intensity[y] = intensity[y] * 0.996 + s * s * 0.004
      }
    }

    const drop = (e: PointerEvent) => {
      const p = tank.translateCoordinate(e, tank.axisX, tank.axisY)
      const cx = Math.round(p.x * 10), cy = Math.round(p.y * 10)
      if (!(cx > 4 && cx < W - 4 && cy > 4 && cy < H - 4)) return
      for (let y = cy - 7; y <= cy + 7; y++) {
        for (let x = cx - 7; x <= cx + 7; x++) {
          if (x < 1 || x >= W - 1 || y < 1 || y >= H - 1) continue
          const r2 = (x - cx) ** 2 + (y - cy) ** 2
          u[y * W + x] += 1.6 * Math.exp(-r2 / 9)
        }
      }
    }
    container.addEventListener('pointerdown', drop)

    const button = tank.addUIElement('button').setText('Scene').setPosition({ x: 1, y: 99 }).setOrigin({ x: -1, y: 1 })
    button.addEventListener('click', () => setScene(SCENES[(SCENES.indexOf(scene) + 1) % SCENES.length]))
    setScene(SCENES[0])

    let raf = 0
    const frame = () => {
      for (let k = 0; k < STEPS_PER_FRAME; k++) step()
      heat.setRowMajorValues(u)
      let max = 1e-9
      for (let y = 0; y < H; y++) if (intensity[y] > max) max = intensity[y]
      for (let y = 0; y < H; y++) prof[y] = intensity[y] / max
      profile.setSamples({ xValues: prof, yValues: ys })
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('pointerdown', drop)
      dash.dispose()
    }
  },
} satisfies Example
