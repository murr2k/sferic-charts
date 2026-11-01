import { sferic, AxisTickStrategies, AxisScrollStrategies, LUT, PalettedFill, regularColorSteps, LinearGradientFill, type HeatmapScrollingGridSeries } from '../../src'
import type { Example } from '../types'

const MAX_HZ = 12_000
const COLUMNS_PER_S = 60
const VIEW_S = 8
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B']
const note = (f: number) => {
  const n = Math.round(12 * Math.log2(f / 440)) + 69
  return `${NOTES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

export default {
  title: 'Live Microphone Spectrogram',
  category: 'Live data',
  order: 3,
  tags: ['live data', 'audio', 'spectrogram', 'scrolling heatmap', 'web audio'],
  description:
    'Your microphone through the Web Audio API: a 4096-point spectrum every frame and a scrolling spectrogram of the last 8 seconds (a GPU ring-buffer texture, one column per frame). Whistle, hum or speak and the strongest frequency is reported with its musical note. Nothing is recorded or sent anywhere; audio stays in the browser and stops when you leave the example.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 1.2).setRowHeight(1, 1.8)
    const lut = new LUT({ steps: regularColorSteps(-105, -25, theme.examples.spectrogramColorPalette), units: 'dB', interpolate: true })

    const spec = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } }).setTitle('Spectrum')
    spec.axisX.setTitle('Frequency').setUnits('Hz').setInterval({ start: 0, end: MAX_HZ, stopAxisAfter: true })
    spec.axisY.setTitle('Level').setUnits('dB').setInterval({ start: -120, end: -10, stopAxisAfter: true })
    const area = spec
      .addAreaSeries({ automaticColorIndex: 0, baseline: -120 })
      .setName('Spectrum')
      .setStrokeStyle((s) => s.setThickness(1.5).setFillStyle(new PalettedFill({ lut, lookUpProperty: 'y' })))
      .setAreaFillStyle(
        new LinearGradientFill({
          angle: 90,
          stops: [
            { offset: 0, color: theme.examples.spectrogramColorPalette[1].setA(40) },
            { offset: 1, color: theme.examples.spectrogramColorPalette[4].setA(140) },
          ],
        }),
      )

    const chart = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { position: 'right' } }).setTitle('Spectrogram (press Start)')
    chart.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => {
        const end = Math.max(s.dataMax ?? 0, VIEW_S * 1000)
        return { end, start: end - VIEW_S * 1000, stopAxisAfter: false }
      })
      .setInterval({ start: 0, end: VIEW_S * 1000, stopAxisAfter: false })
    chart.axisY.setTitle('Frequency').setUnits('Hz').setInterval({ start: 0, end: MAX_HZ, stopAxisAfter: true })
    chart.legend.add(lut, { name: 'Level', units: 'dB', lutLength: 160 })

    let audio: { ctx: AudioContext; stream: MediaStream; analyser: AnalyserNode } | null = null
    let heat: HeatmapScrollingGridSeries | null = null
    let raf = 0
    let disposed = false
    const button = chart.addUIElement('button').setText('Start microphone').setPosition({ x: 1, y: 99 }).setOrigin({ x: -1, y: 1 })

    const stop = () => {
      cancelAnimationFrame(raf)
      audio?.stream.getTracks().forEach((t) => t.stop())
      audio?.ctx.close().catch(() => {})
      audio = null
      button.setText('Start microphone')
    }

    const start = async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        chart.setTitle('Microphone input needs a secure (https or localhost) page')
        return
      }
      button.setText('Starting…')
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
        if (disposed) {
          stream.getTracks().forEach((t) => t.stop())
          return
        }
        const ctx = new AudioContext()
        await ctx.resume()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 4096
        analyser.smoothingTimeConstant = 0.2
        ctx.createMediaStreamSource(stream).connect(analyser)
        audio = { ctx, stream, analyser }
      } catch (e) {
        button.setText('Start microphone')
        chart.setTitle(`Microphone unavailable: ${(e as Error).message}`)
        return
      }
      const { ctx, analyser } = audio
      const binHz = ctx.sampleRate / analyser.fftSize
      const bins = Math.min(analyser.frequencyBinCount, Math.floor(MAX_HZ / binHz))
      const full = new Float32Array(analyser.frequencyBinCount)
      const freqs = Float64Array.from({ length: bins }, (_, i) => i * binHz)
      heat?.dispose()
      heat = chart
        .addHeatmapScrollingGridSeries({ resolution: bins, start: { x: 0, y: 0 }, step: { x: 1000 / COLUMNS_PER_S, y: binHz }, capacity: 1024, maxColumns: COLUMNS_PER_S * 60 })
        .setName('Level')
        .setFillStyle(new PalettedFill({ lut }))
        .setIntensityInterpolation('bilinear')
      chart.legend.remove(heat)
      button.setText('Stop microphone')
      const t0 = performance.now()
      let columns = 0
      let lastTitle = 0
      const tick = (now: number) => {
        analyser.getFloatFrequencyData(full)
        const col = new Float32Array(bins)
        let peak = 0
        for (let i = 0; i < bins; i++) {
          col[i] = Number.isFinite(full[i]) ? Math.max(-130, full[i]) : -130
          if (i > 3 && col[i] > col[peak]) peak = i
        }
        area.setSamples({ xValues: freqs, yValues: col })
        const target = Math.floor(((now - t0) / 1000) * COLUMNS_PER_S)
        const cols: Float32Array[] = []
        while (columns < target && cols.length < 10) {
          cols.push(col)
          columns++
        }
        if (columns < target) columns = target // skipped after a stall
        if (cols.length) heat!.addIntensityValues(cols)
        if (now - lastTitle > 250) {
          lastTitle = now
          // Parabolic interpolation around the peak bin.
          const a = col[peak - 1] ?? col[peak], b = col[peak], c = col[peak + 1] ?? col[peak]
          const off = a - 2 * b + c !== 0 ? (0.5 * (a - c)) / (a - 2 * b + c) : 0
          const f = (peak + off) * binHz
          spec.setTitle(b > -70 ? `Spectrum: peak ${f.toFixed(0)} Hz (${note(f)}), ${b.toFixed(0)} dB` : 'Spectrum: listening…')
          chart.setTitle(`Spectrogram, ${ctx.sampleRate / 1000} kHz input`)
        }
        raf = requestAnimationFrame(tick)
      }
      raf = requestAnimationFrame(tick)
    }

    button.addEventListener('click', () => (audio ? stop() : start()))

    return () => {
      disposed = true
      stop()
      dash.dispose()
    }
  },
} satisfies Example
