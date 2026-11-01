import { sferic, AxisTickStrategies, AxisScrollStrategies, LUT, PalettedFill, regularColorSteps } from '../../src'
import { fftDb, rng } from '../../src/xydata'
import { paramsOf, type Example, type ExampleParam } from '../types'

const PARAMS: ExampleParam[] = [
  { key: 'strokes', label: 'Lightning strokes', min: 2, max: 150, step: 1, value: 28, format: (v) => `${v} /s` },
  { key: 'tweeks', label: 'Tweeks (night)', min: 0, max: 80, step: 2, value: 18, format: (v) => `${v} %` },
  { key: 'whistler', label: 'Whistler every', min: 3, max: 40, step: 1, value: 11, format: (v) => `~${v} s` },
]

const FS = 48_000
const N = 1024
const COLUMNS_PER_S = 50
const HOP = FS / COLUMNS_PER_S
const VIEW_S = 10
const WAVE_MS = 400
const TWEEK_FC = 1750 // Hz, first-order cutoff of the night-time Earth-ionosphere waveguide

/** A sinusoid advanced by complex rotation (no Math.sin per sample). */
class Tone {
  private c: number
  private s: number
  private readonly dc: number
  private readonly ds: number
  constructor(readonly hz: number, readonly amp: number, phase: number) {
    this.c = Math.cos(phase)
    this.s = Math.sin(phase)
    this.dc = Math.cos((2 * Math.PI * hz) / FS)
    this.ds = Math.sin((2 * Math.PI * hz) / FS)
  }
  next() {
    const c = this.c * this.dc - this.s * this.ds
    this.s = this.s * this.dc + this.c * this.ds
    this.c = c
    return this.s * this.amp
  }
  renorm() {
    const m = Math.hypot(this.c, this.s)
    this.c /= m
    this.s /= m
  }
}

interface Click { at: number; amp: number; f1: number; tau1: number; f2: number; tau2: number; ph: number }
interface Glide { at: number; amp: number; phase: number; kind: 'tweek' | 'whistler'; D: number; t0: number; end: number }

/**
 * Synthetic VLF receiver signal: sferics (damped broadband impulses at Poisson times),
 * tweeks (impulses ringing down toward the waveguide cutoff and its harmonic), whistlers
 * (tones falling as f = (D / t)², Eckersley's dispersion law, arriving after a strong
 * sferic), 60 Hz mains harmonics, and keyed VLF transmitter carriers.
 */
class VlfSignal {
  private n = 0
  private nextArrival = 0
  private nextWhistler = FS * 3
  private clicks: Click[] = []
  private glides: Glide[] = []
  private hum: Tone[] = []
  private carriers: Tone[] = []
  counts = { sferics: 0, tweeks: 0, whistlers: 0 }
  /** `p`: live rates (strokes per second, tweek percentage, mean seconds between whistlers). */
  constructor(private r: () => number, private p: Record<string, number>) {
    for (let k = 1; k <= 11; k++) this.hum.push(new Tone(60 * k, (k % 2 ? 0.02 : 0.008) / Math.pow(k, 0.6), r() * 6.28))
    for (const [hz, amp] of [[18_200, 0.006], [19_800, 0.022], [21_400, 0.014], [22_200, 0.01], [23_400, 0.008]]) this.carriers.push(new Tone(hz, amp, r() * 6.28))
  }
  private exp(mean: number) { return -Math.log(1 - this.r()) * mean }
  private spawnSferic(at: number, amp: number) {
    const r = this.r
    this.clicks.push({ at, amp, f1: 5500 + r() * 6000, tau1: 5 + r() * 9, f2: 1800 + r() * 2500, tau2: 14 + r() * 16, ph: r() * 6.28 })
    this.counts.sferics++
    if (r() < this.p.tweeks / 100) {
      this.glides.push({ at: at + 30 + r() * 60, amp: amp * (0.25 + r() * 0.2), phase: 0, kind: 'tweek', D: 0, t0: 0, end: Math.round(FS * (0.03 + r() * 0.06)) })
      this.counts.tweeks++
    }
  }
  /** Fill `out` with the next out.length samples. */
  fill(out: Float32Array) {
    const r = this.r
    const len = out.length
    const end = this.n + len
    while (this.nextArrival < end) {
      // Log-normal-ish amplitudes: many distant strokes, a few close ones.
      const amp = Math.min(0.95, 0.09 * Math.exp((r() + r() + r() - 1.5) * 1.6))
      this.spawnSferic(Math.max(this.n, Math.round(this.nextArrival)), amp)
      this.nextArrival += this.exp(FS / this.p.strokes)
    }
    if (this.nextWhistler < end) {
      // A strong causative sferic, then its whistler: f(t) = (D/t)², starting where f = 9.5 kHz.
      const at = Math.max(this.n, Math.round(this.nextWhistler))
      this.spawnSferic(at, 0.9)
      const D = 55 + r() * 25
      const t0 = D / Math.sqrt(9500)
      const t1 = D / Math.sqrt(650)
      for (const [dD, a] of [[0, 0.07 + r() * 0.04], [2.5 + r() * 2, 0.03]]) {
        this.glides.push({ at: at + Math.round(t0 * FS), amp: a, phase: 0, kind: 'whistler', D: D + dD, t0, end: Math.round((t1 - t0) * FS) })
      }
      this.counts.whistlers++
      this.nextWhistler += FS * this.p.whistler * (0.6 + 0.8 * r())
    }
    for (let i = 0; i < len; i++) {
      let v = (r() + r() + r() - 1.5) * 0.009
      for (const t of this.hum) v += t.next()
      for (let k = 0; k < this.carriers.length; k++) {
        const t = this.carriers[k]
        // Keyed carriers: the 18.2 and 22.2 kHz stations switch on and off.
        const keyed = k === 0 ? ((this.n + i) / (FS * 0.35)) % 3 < 2 : k === 3 ? ((this.n + i) / (FS * 4)) % 2 < 1.4 : true
        const s = t.next()
        if (keyed) v += s
      }
      out[i] = v
    }
    if ((this.n / len) % 64 === 0) for (const t of [...this.hum, ...this.carriers]) t.renorm()
    // Impulses
    this.clicks = this.clicks.filter((c) => {
      const life = Math.ceil(10 * Math.max(c.tau1, c.tau2))
      const i0 = Math.max(0, c.at - this.n), i1 = Math.min(len, c.at + life - this.n)
      const w1 = (2 * Math.PI * c.f1) / FS, w2 = (2 * Math.PI * c.f2) / FS
      for (let i = i0; i < i1; i++) {
        const dt = this.n + i - c.at
        out[i] += c.amp * (Math.exp(-dt / c.tau1) * Math.sin(w1 * dt + c.ph) + 0.6 * Math.exp(-dt / c.tau2) * Math.sin(w2 * dt))
      }
      return c.at + life > end
    })
    // Tweeks and whistlers (phase accumulators)
    this.glides = this.glides.filter((g) => {
      const i0 = Math.max(0, g.at - this.n), i1 = Math.min(len, g.at + g.end - this.n)
      for (let i = i0; i < i1; i++) {
        const t = (this.n + i - g.at) / FS
        let f: number, a: number
        if (g.kind === 'tweek') {
          f = TWEEK_FC * (1 + 1.8 * Math.exp(-t / 0.006))
          a = g.amp * Math.exp(-t / 0.022)
          g.phase += (2 * Math.PI * f) / FS
          out[i] += a * (Math.sin(g.phase) + 0.45 * Math.sin(2 * g.phase))
        } else {
          const tt = g.t0 + t
          f = (g.D / tt) ** 2
          const rise = Math.min(1, t / 0.05)
          a = g.amp * rise * Math.min(1, Math.pow(f / 2500, 0.5)) * (0.75 + 0.25 * Math.sin(t * 37))
          g.phase += (2 * Math.PI * f) / FS
          out[i] += a * Math.sin(g.phase)
        }
      }
      return g.at + g.end > end
    })
    this.n = end
  }
}

export default {
  title: 'VLF Receiver: Sferics, Tweeks and Whistlers',
  category: 'Real-time',
  order: 0.5,
  tags: ['real-time', 'spectrogram', 'physics', 'radio', '48 kHz'],
  params: PARAMS,
  description:
    'A simulated very-low-frequency radio receiver sampling at 48 kHz. Lightning strokes around the world arrive as sferics: sharp broadband clicks, the vertical streaks. At night the Earth-ionosphere waveguide stretches some into tweeks that ring down toward its cutoff near 1.8 kHz, and energy guided along the geomagnetic field returns as a whistler, a tone falling from about 9.5 kHz to under 1 kHz as f = (D/t)². Horizontal lines are 60 Hz mains harmonics and keyed navy transmitters above 18 kHz. 48 000 samples per second stream into the waveform and a 1024-point FFT feeds the scrolling spectrogram 50 times per second.',
  run(ctx) {
    const { container, theme } = ctx
    const p = paramsOf(PARAMS, ctx)
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 1).setRowHeight(1, 2.1)

    const wave = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } }).setTitle('Antenna voltage, 48 kS/s')
    wave.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => ({ end: s.dataMax ?? 0, start: (s.dataMax ?? 0) - WAVE_MS, stopAxisAfter: false }))
    wave.axisY.setTitle('E field').setInterval({ start: -1, end: 1, stopAxisAfter: true })
    const line = wave
      .addLineSeries({ automaticColorIndex: 0 })
      .setName('Signal')
      .setStrokeStyle((s) => s.setThickness(1))
      .setMaxSampleCount(FS * 2)

    const lut = new LUT({ steps: regularColorSteps(-88, -22, theme.examples.spectrogramColorPalette), units: 'dB', interpolate: true })
    const spec = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { position: 'right' } }).setTitle('Spectrogram')
    spec.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => {
        const end = Math.max(s.dataMax ?? 0, VIEW_S * 1000)
        return { end, start: end - VIEW_S * 1000, stopAxisAfter: false }
      })
    spec.axisY.setTitle('Frequency').setUnits('kHz').setInterval({ start: 0, end: FS / 2000, stopAxisAfter: true })
    const heat = spec
      .addHeatmapScrollingGridSeries({
        resolution: N / 2,
        start: { x: 0, y: 0 },
        step: { x: 1000 / COLUMNS_PER_S, y: FS / N / 1000 },
        capacity: 1024,
        maxColumns: COLUMNS_PER_S * 60,
      })
      .setName('Power')
      .setFillStyle(new PalettedFill({ lut }))
      .setIntensityInterpolation('bilinear')
    spec.legend.add(lut, { name: 'Power', units: 'dB', lutLength: 160 })
    spec.legend.remove(heat)

    const signal = new VlfSignal(rng(2026), p)
    const block = new Float32Array(HOP)
    const ring = new Float32Array(N)
    let produced = 0 // samples

    /** Synthesize whole FFT hops up to `target` samples and push them to both charts. */
    const advance = (target: number) => {
      const hops = Math.floor((target - produced) / HOP)
      if (hops <= 0) return
      const ys = new Float32Array(hops * HOP)
      const cols: Float32Array[] = []
      for (let h = 0; h < hops; h++) {
        signal.fill(block)
        ring.copyWithin(0, HOP)
        ring.set(block, N - HOP)
        cols.push(fftDb(ring))
        ys.set(block, h * HOP)
      }
      line.appendSamples({ start: (produced * 1000) / FS, step: 1000 / FS, yValues: ys })
      heat.addIntensityValues(cols)
      produced += hops * HOP
    }

    // Start with a full window of signal so the spectrogram is complete on arrival.
    advance(VIEW_S * FS)
    const t0 = performance.now() - VIEW_S * 1000
    let raf = 0
    let lastTitle = 0
    const tick = (now: number) => {
      const target = Math.floor(((now - t0) / 1000) * FS)
      // After a stall (hidden tab) skip ahead instead of synthesizing the whole backlog.
      if (target - produced > FS / 2) produced = target - HOP * 4
      advance(target)
      if (now - lastTitle > 1000) {
        lastTitle = now
        const c = signal.counts
        spec.setTitle(`Spectrogram: ${c.sferics.toLocaleString('en-US')} sferics, ${c.tweeks} tweeks, ${c.whistlers} whistler${c.whistlers === 1 ? '' : 's'}`)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
