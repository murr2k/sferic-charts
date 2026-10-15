// Deterministic 3D data generators for the Chart3D examples.
import { gauss, rng } from './index'

export interface P3 { x: number; y: number; z: number }

/** Water-drop splash: a rippled crown of samples (y = height). */
export function waterDropPoints(n: number, seed = 5): P3[] {
  const r = rng(seed)
  const out: P3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const rad = Math.sqrt(r()) * 50
    const a = r() * Math.PI * 2
    const x = 50 + Math.cos(a) * rad, z = 50 + Math.sin(a) * rad
    const y = 40 + 34 * Math.cos(rad * 0.28) * Math.exp(-rad / 28) + gauss(r) * 2.2
    out[i] = { x, y, z }
  }
  return out
}

/** Gaussian cloud around a center. */
export function gaussianCloud(n: number, c: P3, s: P3, seed = 9): P3[] {
  const r = rng(seed)
  return Array.from({ length: n }, () => ({ x: c.x + gauss(r) * s.x, y: c.y + gauss(r) * s.y, z: c.z + gauss(r) * s.z }))
}

/** Lorenz attractor trajectory (RK4). */
export function lorenz(n: number, dt = 0.005, sigma = 10, rho = 28, beta = 8 / 3): P3[] {
  let x = 0.1, y = 0, z = 0
  const f = (x: number, y: number, z: number): [number, number, number] => [sigma * (y - x), x * (rho - z) - y, x * y - beta * z]
  const out: P3[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const k1 = f(x, y, z)
    const k2 = f(x + (dt / 2) * k1[0], y + (dt / 2) * k1[1], z + (dt / 2) * k1[2])
    const k3 = f(x + (dt / 2) * k2[0], y + (dt / 2) * k2[1], z + (dt / 2) * k2[2])
    const k4 = f(x + dt * k3[0], y + dt * k3[1], z + dt * k3[2])
    x += (dt / 6) * (k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0])
    y += (dt / 6) * (k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1])
    z += (dt / 6) * (k1[2] + 2 * k2[2] + 2 * k3[2] + k4[2])
    // Lorenz z is the "vertical" variable; map it to chart Y.
    out[i] = { x, y: z, z: y }
  }
  return out
}

/**
 * Terrain-like height field, column-major (index = column * rows + row), values ~0..100.
 * Smooth enough to look good at any resolution.
 */
export function terrainHeights(cols: number, rows: number, seed = 3): Float32Array {
  const r = rng(seed)
  const waves = Array.from({ length: 7 }, () => ({ fx: 1 + r() * 5, fz: 1 + r() * 5, p: r() * 6.28, a: 0.4 + r() * 0.8 }))
  const peaks = Array.from({ length: 6 }, () => ({ x: r(), z: r(), s: 0.06 + r() * 0.12, a: (r() - 0.35) * 2.2 }))
  const out = new Float32Array(cols * rows)
  let lo = Infinity, hi = -Infinity
  for (let c = 0; c < cols; c++) {
    const u = c / (cols - 1)
    for (let k = 0; k < rows; k++) {
      const v = k / (rows - 1)
      let h = 0
      for (const w of waves) h += w.a * Math.sin(u * w.fx * 3.1 + w.p) * Math.cos(v * w.fz * 3.1 - w.p) * 0.35
      for (const p of peaks) {
        const d2 = (u - p.x) ** 2 + (v - p.z) ** 2
        h += p.a * Math.exp(-d2 / (2 * p.s * p.s))
      }
      out[c * rows + k] = h
      if (h < lo) lo = h
      if (h > hi) hi = h
    }
  }
  const k = 100 / (hi - lo || 1)
  for (let i = 0; i < out.length; i++) out[i] = (out[i] - lo) * k
  return out
}

/** Spectrum-like column of `rows` magnitudes at time step t (drifting peaks over a noise floor). */
export function spectrumColumn(t: number, rows: number, r: () => number): Float32Array {
  const out = new Float32Array(rows)
  const peaks = [
    { f: 0.18 + 0.06 * Math.sin(t * 0.021), a: 62, w: 0.018 },
    { f: 0.42 + 0.12 * Math.sin(t * 0.013 + 1), a: 48, w: 0.025 },
    { f: 0.66 + 0.03 * Math.sin(t * 0.05), a: 38 + 18 * Math.sin(t * 0.04), w: 0.012 },
    { f: 0.83, a: 24 + 20 * Math.max(0, Math.sin(t * 0.09)), w: 0.03 },
  ]
  // Smoothed noise floor (one-pole filter) so the surface reads as a spectrum, not speckle.
  let n = r() * 4
  for (let i = 0; i < rows; i++) {
    const f = i / (rows - 1)
    n = n * 0.82 + r() * 4 * 0.18
    let v = 6 + 10 * Math.exp(-f * 4) + n * 1.6
    for (const p of peaks) v += p.a * Math.exp(-((f - p.f) ** 2) / (2 * p.w * p.w))
    out[i] = v
  }
  return out
}

/** Torus knot triangle mesh (p, q winding), unit-ish size. */
export function torusKnot(p = 2, q = 3, tubular = 360, radial = 28, tube = 0.28): { vertices: Float32Array; indices: Uint32Array; t: Float32Array } {
  const verts = new Float32Array((tubular + 1) * (radial + 1) * 3)
  const ts = new Float32Array((tubular + 1) * (radial + 1))
  const idx = new Uint32Array(tubular * radial * 6)
  const curve = (u: number): [number, number, number] => {
    const cu = Math.cos(u), su = Math.sin(u), qr = (q / p) * u
    const rr = 0.75 * (2 + Math.cos(qr)) * 0.5
    return [rr * cu, rr * su, 0.75 * Math.sin(qr) * 0.5]
  }
  let k = 0
  for (let i = 0; i <= tubular; i++) {
    const u = (i / tubular) * p * Math.PI * 2
    const P1 = curve(u), P2 = curve(u + 0.01)
    const T = [P2[0] - P1[0], P2[1] - P1[1], P2[2] - P1[2]]
    const N = [P2[0] + P1[0], P2[1] + P1[1], P2[2] + P1[2]]
    let B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]]
    let Nn = [B[1] * T[2] - B[2] * T[1], B[2] * T[0] - B[0] * T[2], B[0] * T[1] - B[1] * T[0]]
    const lb = Math.hypot(B[0], B[1], B[2]), ln = Math.hypot(Nn[0], Nn[1], Nn[2])
    B = B.map((x) => x / lb)
    Nn = Nn.map((x) => x / ln)
    for (let j = 0; j <= radial; j++) {
      const v = (j / radial) * Math.PI * 2
      const cx = -tube * 0.5 * Math.cos(v), cy = tube * 0.5 * Math.sin(v)
      verts[k * 3] = P1[0] + cx * Nn[0] + cy * B[0]
      verts[k * 3 + 1] = P1[1] + cx * Nn[1] + cy * B[1]
      verts[k * 3 + 2] = P1[2] + cx * Nn[2] + cy * B[2]
      ts[k] = i / tubular
      k++
    }
  }
  let n = 0
  for (let i = 0; i < tubular; i++)
    for (let j = 0; j < radial; j++) {
      const a = i * (radial + 1) + j, b = (i + 1) * (radial + 1) + j
      idx[n++] = a; idx[n++] = b; idx[n++] = a + 1
      idx[n++] = b; idx[n++] = b + 1; idx[n++] = a + 1
    }
  return { vertices: verts, indices: idx, t: ts }
}
