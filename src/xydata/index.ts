// Synthetic data generators for examples and tests.
// Deterministic when given a seed (mulberry32), so examples look the same each load.

export function rng(seed = 12345) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Normal distribution sample (Box-Muller). */
export function gauss(r: () => number) {
  let u = 0, v = 0
  while (u === 0) u = r()
  while (v === 0) v = r()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

interface Point { x: number; y: number }

/** Data stream emitting batches on an interval. */
export class DataStream<T> {
  private interval = 30
  private batch = 10
  private repeat = false
  constructor(private data: T[]) {}
  setStreamInterval(ms: number) { this.interval = ms; return this }
  setStreamBatchSize(n: number) { this.batch = n; return this }
  setStreamRepeat(r: boolean) { this.repeat = r; return this }
  /** Calls cb per item; returns a stop function. */
  forEach(cb: (item: T) => void): () => void {
    let i = 0
    const h = setInterval(() => {
      for (let k = 0; k < this.batch; k++) {
        if (i >= this.data.length) {
          if (!this.repeat) { clearInterval(h); return }
          i = 0
        }
        cb(this.data[i++])
      }
    }, this.interval)
    return () => clearInterval(h)
  }
}

class Generated<T> {
  constructor(private make: () => T[]) {}
  toPromise(): Promise<T[]> { return Promise.resolve(this.make()) }
  toStream(): DataStream<T> { return new DataStream(this.make()) }
  get(): T[] { return this.make() }
}

abstract class Gen<T> {
  protected n = 1000
  protected seed = 1
  setNumberOfPoints(n: number) { this.n = n; return this }
  setSeed(s: number) { this.seed = s; return this }
  abstract build(): T[]
  generate() { return new Generated(() => this.build()) }
}

/** Random walk with x = 0..n-1. */
export class ProgressiveTraceGenerator extends Gen<Point> {
  build() {
    const r = rng(this.seed)
    const out: Point[] = new Array(this.n)
    let y = 0
    for (let i = 0; i < this.n; i++) {
      y += (r() - 0.5) * 2
      out[i] = { x: i, y }
    }
    return out
  }
}
export const createProgressiveTraceGenerator = () => new ProgressiveTraceGenerator()

/** Uniform noise in [0,1) with x = 0..n-1. */
export class ProgressiveRandomGenerator extends Gen<Point> {
  build() {
    const r = rng(this.seed)
    return Array.from({ length: this.n }, (_, i) => ({ x: i, y: r() }))
  }
}
export const createProgressiveRandomGenerator = () => new ProgressiveRandomGenerator()

export class ProgressiveFunctionGenerator extends Gen<Point> {
  private f: (x: number) => number = Math.sin
  private a = 0
  private b = 100
  private step = 1
  setSamplingFunction(f: (x: number) => number) { this.f = f; return this }
  setStart(a: number) { this.a = a; return this }
  setEnd(b: number) { this.b = b; return this }
  setStep(s: number) { this.step = s; return this }
  build() {
    const out: Point[] = []
    for (let x = this.a; x <= this.b + 1e-12; x += this.step) out.push({ x, y: this.f(x) })
    return out
  }
}
export const createProgressiveFunctionGenerator = () => new ProgressiveFunctionGenerator()

/** 2D random walk (non-monotonic x). */
export class TraceGenerator extends Gen<Point> {
  build() {
    const r = rng(this.seed)
    let x = 0, y = 0
    return Array.from({ length: this.n }, () => {
      x += r() - 0.5
      y += r() - 0.5
      return { x, y }
    })
  }
}
export const createTraceGenerator = () => new TraceGenerator()

/** Gaussian clusters for scatter plots. */
export function createClusters(n: number, clusters: { x: number; y: number; sx: number; sy: number }[], seed = 7): Point[] {
  const r = rng(seed)
  const out: Point[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const c = clusters[Math.floor(r() * clusters.length)]
    out[i] = { x: c.x + gauss(r) * c.sx, y: c.y + gauss(r) * c.sy }
  }
  return out
}

/** OHLC candles: [timestamp, open, high, low, close]. */
export class OHLCGenerator extends Gen<[number, number, number, number, number]> {
  private t0 = Date.UTC(2024, 0, 1)
  private freq = 24 * 3600 * 1000
  private start = 100
  setStartTimestamp(t: number) { this.t0 = t; return this }
  setDataFrequency(ms: number) { this.freq = ms; return this }
  setStart(v: number) { this.start = v; return this }
  build() {
    const r = rng(this.seed)
    let p = this.start
    const out: [number, number, number, number, number][] = []
    for (let i = 0; i < this.n; i++) {
      const o = p
      const drift = gauss(r) * p * 0.02
      const c = Math.max(1, o + drift)
      const h = Math.max(o, c) + Math.abs(gauss(r)) * p * 0.008
      const l = Math.min(o, c) - Math.abs(gauss(r)) * p * 0.008
      out.push([this.t0 + i * this.freq, o, h, l, c])
      p = c
    }
    return out
  }
}
export const createOHLCGenerator = () => new OHLCGenerator()

/** Concentric "water drop" ripples on a grid: Promise<number[][]> as rows x columns. */
export class WaterDropDataGenerator {
  private rows = 100
  private cols = 100
  private drops: { x: number; y: number; amp: number; spread: number }[] | null = null
  private seed = 3
  setRows(n: number) { this.rows = n; return this }
  setColumns(n: number) { this.cols = n; return this }
  setSeed(s: number) { this.seed = s; return this }
  setWaterDrops(d: { rowNormalized: number; columnNormalized: number; amplitude: number }[]) {
    this.drops = d.map((q) => ({ x: q.columnNormalized, y: q.rowNormalized, amp: q.amplitude, spread: 0.25 }))
    return this
  }
  generateSync(): number[][] {
    const r = rng(this.seed)
    const drops = this.drops ?? Array.from({ length: 5 }, () => ({ x: r(), y: r(), amp: 20 + r() * 40, spread: 0.08 + r() * 0.2 }))
    const out: number[][] = []
    for (let i = 0; i < this.rows; i++) {
      const row = new Array(this.cols)
      const v = i / (this.rows - 1 || 1)
      for (let j = 0; j < this.cols; j++) {
        const u = j / (this.cols - 1 || 1)
        let z = 0
        for (const d of drops) {
          const dist = Math.hypot(u - d.x, v - d.y)
          z += d.amp * Math.exp(-dist / d.spread) * (0.6 + 0.4 * Math.cos(dist * 40))
        }
        row[j] = z
      }
      out.push(row)
    }
    return out
  }
  generate(): Promise<number[][]> { return Promise.resolve(this.generateSync()) }
}
export const createWaterDropDataGenerator = () => new WaterDropDataGenerator()

/** Spectrum-like rows of `sampleSize` values that drift over `numberOfSamples` rows. */
export class SpectrumDataGenerator {
  private size = 512
  private count = 100
  private variation = 0.1
  private seed = 9
  setSampleSize(n: number) { this.size = n; return this }
  setNumberOfSamples(n: number) { this.count = n; return this }
  setVariation(v: number) { this.variation = v; return this }
  setSeed(s: number) { this.seed = s; return this }
  generateSync(): number[][] {
    const r = rng(this.seed)
    const peaks = Array.from({ length: 6 }, () => ({ f: r() * 0.8 + 0.05, a: 0.3 + r() * 0.7, w: 0.004 + r() * 0.02, df: (r() - 0.5) * 0.002 }))
    const out: number[][] = []
    for (let k = 0; k < this.count; k++) {
      const row = new Array(this.size)
      for (let i = 0; i < this.size; i++) {
        const f = i / this.size
        let v = 0.05 * Math.exp(-f * 3) + r() * this.variation * 0.3
        for (const p of peaks) v += p.a * Math.exp(-((f - p.f - p.df * k) ** 2) / (2 * p.w * p.w))
        row[i] = v
      }
      out.push(row)
    }
    return out
  }
  generate() { return new Generated(() => this.generateSync()) }
}
export const createSpectrumDataGenerator = () => new SpectrumDataGenerator()

/** In-place radix-2 FFT magnitude in dB of a real signal (length power of two). */
export function fftDb(samples: ArrayLike<number>, out?: Float32Array): Float32Array {
  const n = samples.length
  const re = new Float64Array(n)
  const im = new Float64Array(n)
  // Hann window + bit reversal
  for (let i = 0, j = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))
    re[j] = samples[i] * w
    let bit = n >> 1
    while (j & bit) { j ^= bit; bit >>= 1 }
    j |= bit
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = ncr
      }
    }
  }
  const half = n / 2
  const res = out ?? new Float32Array(half)
  for (let i = 0; i < half; i++) res[i] = 20 * Math.log10((Math.hypot(re[i], im[i]) * 2) / n + 1e-12)
  return res
}
