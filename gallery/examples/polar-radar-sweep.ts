import { sferic, ColorHEX, LUT, PalettedFill, SolidFill, SolidLine } from '../../src'
import type { Example } from '../types'

export default {
  title: 'Radar Sweep (Polar Heatmap)',
  category: 'Polar',
  order: 3,
  tags: ['polar', 'heatmap', 'real-time', 'animation', 'gpu'],
  description:
    'Animated polar heatmap: a 360 x 80 intensity grid streamed every frame and rendered on the GPU. The rotating beam paints echoes from moving targets and clutter, which fade with time since the last sweep.',
  run({ container, theme }) {
    const chart = sferic().Polar({ container, theme }).setTitle('Surveillance Radar PPI')
    chart.getRadialAxis().setNorth(0).setClockwise(true).setDivision(12)
    chart.getAmplitudeAxis().setTitle('Range').setUnits('km').setInterval({ start: 0, end: 40 })
    const sectors = 360, annuli = 80
    const heat = chart.addHeatmapSeries({ sectors, annuli, amplitudeStart: 0, amplitudeEnd: 40 }).setName('Echo')
    heat.setIntensityInterpolation('bilinear')
    const steps = theme.isDark
      ? ['#000000', '#002a12', '#00702e', '#19d35a', '#a6ffb4', '#ffffff']
      : ['#ffffff', '#d9f5df', '#7fd896', '#22a34a', '#0b5e27', '#032d12']
    heat.setFillStyle(new PalettedFill({ lut: new LUT({ steps: steps.map((c, i) => ({ value: i / (steps.length - 1), color: ColorHEX(c) })), interpolate: true }) }))
    const beam = chart.addLineSeries({ automaticColorIndex: 1 }).setName('Beam').setCursorEnabled(false)
    chart.legend.remove(beam)
    beam.setStrokeStyle(new SolidLine({ thickness: 2, fillStyle: new SolidFill({ color: ColorHEX(theme.isDark ? '#8dffa4' : '#127a35') }) }))

    // Echo strength per cell at the time it was last swept, and the sweep time per sector.
    const echo = Array.from({ length: sectors }, () => new Float32Array(annuli))
    const swept = new Float64Array(sectors).fill(-1e9)
    const grid = Array.from({ length: sectors }, () => new Float32Array(annuli))
    const targets = Array.from({ length: 7 }, (_, i) => ({ a: (i * 53) % 360, r: 8 + ((i * 7) % 28), va: (i % 2 ? 1 : -1) * (2 + i), vr: (i % 3) - 1 }))
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    const period = 4000
    const t0 = performance.now()
    let last = 0
    let raf = 0
    const frame = (now: number) => {
      const t = Math.max(last, now - t0)
      const sweep = ((t / period) * 360) % 360
      const prev = ((last / period) * 360) % 360
      const span = (sweep - prev + 360) % 360
      for (const tg of targets) {
        tg.a = (tg.a + (tg.va * (t - last)) / 1000 / 6 + 360) % 360
        tg.r = Math.min(38, Math.max(4, tg.r + (tg.vr * (t - last)) / 1000 / 2))
      }
      for (let k = 0; k <= Math.ceil(span); k++) {
        const s = (Math.floor(prev + k) + sectors) % sectors
        swept[s] = t
        const row = echo[s]
        for (let a = 0; a < annuli; a++) {
          const km = (a / annuli) * 40
          // ground clutter near the center, weather cell around 300 deg / 25 km, noise
          let v = 0.55 * Math.exp(-km / 3) + rnd() * 0.08
          const dw = Math.hypot(((s - 300 + 540) % 360) - 180, (km - 25) * 4)
          v += 0.45 * Math.exp(-dw / 22) * (0.7 + 0.3 * rnd())
          for (const tg of targets) {
            const da = Math.abs(((s - tg.a + 540) % 360) - 180)
            v += Math.exp(-(da * da) / 3 - ((km - tg.r) * (km - tg.r)) / 0.4)
          }
          row[a] = Math.pow(Math.min(1, v), 0.75)
        }
      }
      for (let s = 0; s < sectors; s++) {
        const age = t - swept[s]
        const k = Math.exp(-age / 2400)
        const src = echo[s], dst = grid[s]
        for (let a = 0; a < annuli; a++) dst[a] = src[a] * k
      }
      heat.invalidateIntensityValues(grid)
      beam.setData([{ angle: sweep, amplitude: 0 }, { angle: sweep, amplitude: 40 }])
      last = t
      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      chart.dispose()
    }
  },
} satisfies Example
