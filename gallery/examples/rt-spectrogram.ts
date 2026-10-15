import { sferic, AxisTickStrategies, AxisScrollStrategies, LUT, PalettedFill, regularColorSteps, LinearGradientFill } from '../../src'
import { fftDb } from '../../src/xydata'
import type { Example } from '../types'

const FS = 16_000
const N = 1024
const COLUMNS_PER_S = 40
const VIEW_S = 12

export default {
  title: 'Real-time Spectrogram',
  category: 'Real-time',
  order: 3,
  tags: ['real-time', 'heatmap', 'FFT', 'spectrogram'],
  description: `A synthetic audio signal (chirps, tones and noise) at ${FS / 1000} kHz is transformed with a ${N}-point FFT ${COLUMNS_PER_S} times per second. The top chart shows the latest spectrum; the bottom a scrolling heatmap (GPU ring-buffer texture) of the last ${VIEW_S} s.`,
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 1).setRowHeight(1, 2)
    const lut = new LUT({
      steps: regularColorSteps(-100, -10, theme.examples.spectrogramColorPalette),
      units: 'dB',
      interpolate: true,
    })

    const spec = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } }).setTitle('Spectrum')
    spec.axisX.setTitle('Frequency').setUnits('Hz').setInterval({ start: 0, end: FS / 2, stopAxisAfter: true })
    spec.axisY.setTitle('Level').setUnits('dB').setInterval({ start: -110, end: 0, stopAxisAfter: true })
    const line = spec
      .addAreaSeries({ automaticColorIndex: 0, baseline: -110 })
      .setName('Spectrum')
      .setStrokeStyle((s) => s.setThickness(1.5).setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' })))
      .setAreaFillStyle(
        new LinearGradientFill({
          angle: 90,
          stops: [
            { offset: 0, color: theme.examples.spectrogramColorPalette[1].setA(40) },
            { offset: 1, color: theme.examples.spectrogramColorPalette[4].setA(150) },
          ],
        }),
      )

    const chart = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { position: 'right' } }).setTitle('Spectrogram')
    chart.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => ({ end: Math.max(s.dataMax ?? 0, VIEW_S * 1000), start: Math.max(s.dataMax ?? 0, VIEW_S * 1000) - VIEW_S * 1000, stopAxisAfter: false }))
    chart.axisY.setTitle('Frequency').setUnits('Hz').setInterval({ start: 0, end: FS / 2, stopAxisAfter: true })
    const heat = chart
      .addHeatmapScrollingGridSeries({ resolution: N / 2, start: { x: 0, y: 0 }, step: { x: 1000 / COLUMNS_PER_S, y: FS / N }, capacity: 512, maxColumns: COLUMNS_PER_S * 60 })
      .setName('Power')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
    chart.legend.add(lut, { name: 'Power', units: 'dB', lutLength: 180 })
    chart.legend.remove(heat)

    // Signal synthesis state
    const buf = new Float32Array(N)
    let sampleIndex = 0
    let phase1 = 0, phase2 = 0
    const synth = (count: number, out: Float32Array, offset: number) => {
      for (let i = 0; i < count; i++) {
        const t = (sampleIndex + i) / FS
        const sweep = 400 + 3600 * (0.5 + 0.5 * Math.sin(t * 0.35))
        phase1 += (2 * Math.PI * sweep) / FS
        phase2 += (2 * Math.PI * (1200 + 600 * Math.sin(t * 2.1))) / FS
        const burst = Math.sin(t * 1.3) > 0.6 ? 0.25 * Math.sin(2 * Math.PI * 5200 * t) : 0
        out[offset + i] = 0.5 * Math.sin(phase1) + 0.18 * Math.sin(phase2) + 0.06 * Math.sin(2 * Math.PI * 7000 * t) + burst + (Math.random() - 0.5) * 0.02
      }
      sampleIndex += count
    }
    const hop = Math.round(FS / COLUMNS_PER_S)
    const ring = new Float32Array(N)
    const freqs = Float64Array.from({ length: N / 2 }, (_, i) => (i * FS) / N)
    const t0 = performance.now()
    let columns = 0
    let raf = 0
    const tick = () => {
      const target = Math.floor(((performance.now() - t0) / 1000) * COLUMNS_PER_S)
      const cols: Float32Array[] = []
      while (columns < target && cols.length < COLUMNS_PER_S) {
        // slide window by `hop` samples
        ring.copyWithin(0, hop)
        synth(hop, ring, N - hop)
        buf.set(ring)
        cols.push(fftDb(buf))
        columns++
      }
      if (cols.length) {
        heat.addIntensityValues(cols)
        line.setSamples({ xValues: freqs, yValues: cols[cols.length - 1] })
      }
      raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
