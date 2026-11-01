import { sferic, PointStyle3D, SolidFill } from '../../src'
import { rng } from '../../src/xydata'
import { paramsOf, type Example, type ExampleParam } from '../types'

const PARAMS: ExampleParam[] = [
  { key: 'n', label: 'n (shell)', min: 1, max: 5, step: 1, value: 3 },
  { key: 'l', label: 'l (shape)', min: 0, max: 4, step: 1, value: 2 },
  { key: 'm', label: 'm (orientation)', min: -4, max: 4, step: 1, value: 0 },
  { key: 'samples', label: 'Samples', min: 10_000, max: 200_000, step: 10_000, value: 60_000, format: (v) => `${v / 1000}k` },
]

// Conventional names of the real orbitals (m > 0: cosine, x-like; m < 0: sine, y-like).
const SUFFIX: Record<number, Record<number, string>> = {
  1: { 0: 'z', 1: 'x', [-1]: 'y' },
  2: { 0: 'z²', 1: 'xz', [-1]: 'yz', 2: 'x²−y²', [-2]: 'xy' },
  3: { 0: 'z³', 1: 'xz²', [-1]: 'yz²', 2: 'z(x²−y²)', [-2]: 'xyz', 3: 'x(x²−3y²)', [-3]: 'y(3x²−y²)' },
}
const orbitalName = (n: number, l: number, m: number) => `${n}${'spdfg'[l]}${SUFFIX[l]?.[m] ? ` ${SUFFIX[l][m]}` : ''}`

/** Generalized Laguerre polynomial L_k^α(x). */
function laguerre(k: number, alpha: number, x: number) {
  if (k === 0) return 1
  let a = 1, b = 1 + alpha - x
  for (let j = 1; j < k; j++) {
    const c = ((2 * j + 1 + alpha - x) * b - (j + alpha) * a) / (j + 1)
    a = b
    b = c
  }
  return b
}

/** Associated Legendre function P_l^m(x), m ≥ 0 (Condon-Shortley phase omitted; only the shape matters). */
function legendre(l: number, m: number, x: number) {
  let pmm = 1
  const s = Math.sqrt(Math.max(0, 1 - x * x))
  for (let i = 1; i <= m; i++) pmm *= (2 * i - 1) * s
  if (l === m) return pmm
  let pmm1 = x * (2 * m + 1) * pmm
  for (let ll = m + 2; ll <= l; ll++) {
    const p = ((2 * ll - 1) * x * pmm1 - (ll + m - 1) * pmm) / (ll - m)
    pmm = pmm1
    pmm1 = p
  }
  return pmm1
}

/** Radial part R_nl(r) up to normalization, r in Bohr radii. */
const radial = (n: number, l: number, r: number) => {
  const rho = (2 * r) / n
  return Math.pow(rho, l) * Math.exp(-rho / 2) * laguerre(n - l - 1, 2 * l + 1, rho)
}

/**
 * Sample electron positions from |ψ_nlm|² of hydrogen: r from the tabulated radial density
 * r²R², direction by rejection against the real spherical harmonic. Returns positions split
 * by the sign of ψ (the orbital's phase).
 */
function sampleOrbital(n: number, l: number, m: number, count: number, rand: () => number) {
  const M = 4000
  const rmax = 3 * n * n + 8
  const cdf = new Float64Array(M + 1)
  for (let i = 1; i <= M; i++) {
    const r = (i / M) * rmax
    const R = radial(n, l, r)
    cdf[i] = cdf[i - 1] + r * r * R * R
  }
  const am = Math.abs(m)
  let ymax = 0
  for (let i = 0; i <= 2000; i++) ymax = Math.max(ymax, Math.abs(legendre(l, am, -1 + i / 1000)))
  const out = { pos: { x: [] as number[], y: [] as number[], z: [] as number[] }, neg: { x: [] as number[], y: [] as number[], z: [] as number[] }, radii: [] as number[] }
  while (out.radii.length < count) {
    // Radius: invert the CDF by binary search, then jitter within the bin.
    const target = rand() * cdf[M]
    let lo = 0, hi = M
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (cdf[mid] < target) lo = mid
      else hi = mid
    }
    const r = ((lo + rand()) / M) * rmax
    // Direction: uniform on the sphere, accepted with probability |Y|² / max|Y|².
    let ct = 0, phi = 0, ang = 0
    for (;;) {
      ct = 2 * rand() - 1
      phi = 2 * Math.PI * rand()
      const p = legendre(l, am, ct) / ymax
      ang = m > 0 ? p * Math.cos(m * phi) : m < 0 ? p * Math.sin(am * phi) : p
      if (rand() < ang * ang) break
    }
    const st = Math.sqrt(1 - ct * ct)
    const x = r * st * Math.cos(phi), y = r * st * Math.sin(phi), z = r * ct
    const side = radial(n, l, r) * ang >= 0 ? out.pos : out.neg
    // Chart axes: X = x, Y (up) = z, Z = y.
    side.x.push(x)
    side.y.push(z)
    side.z.push(y)
    out.radii.push(r)
  }
  return out
}

export default {
  title: 'Hydrogen Atom Orbitals',
  category: 'Physics & Math',
  order: 6,
  tags: ['physics', 'quantum', '3d', 'scatter', 'monte carlo'],
  params: PARAMS,
  description:
    'Electron probability clouds of the hydrogen atom: 60 000 positions sampled from |ψₙₗₘ|², built from associated Laguerre polynomials (radial part) and real spherical harmonics (angular part). The two colors are the two signs of the wavefunction, so nodal planes and cones show as color boundaries and the n − l − 1 radial nodes as empty shells. Choose any orbital with the n, l and m sliders (l < n, |m| ≤ l; m > 0 and m < 0 are the cosine and sine real orbitals). The cloud turns slowly until you grab it: drag to rotate, wheel to zoom.',
  run(ctx) {
    const { container, theme } = ctx
    const p = paramsOf(PARAMS, ctx)
    const chart = sferic().Chart3D({ container, theme })
    chart.setBoundingBox({ x: 1, y: 1, z: 1 })
    const pal = theme.examples.positiveNegativeColorPalette
    const alpha = theme.isDark ? 120 : 150
    const style = (c: (typeof pal)[number]) => new PointStyle3D.Pixelated({ shape: 'circle', size: 2.5, fillStyle: new SolidFill({ color: c.setA(alpha) }) })
    const pos = chart.addPointSeries().setName('ψ > 0').setPointStyle(style(pal[pal.length - 1]))
    const neg = chart.addPointSeries().setName('ψ < 0').setPointStyle(style(pal[0]))
    const rand = rng(1)

    const show = () => {
      // Clamp to valid quantum numbers: 0 ≤ l < n, |m| ≤ l.
      const n = p.n
      const l = Math.min(p.l, n - 1)
      const m = Math.max(-l, Math.min(l, p.m))
      const label = orbitalName(n, l, m)
      const s = sampleOrbital(n, l, m, p.samples, rand)
      pos.clear().appendSamples({ xValues: s.pos.x, yValues: s.pos.y, zValues: s.pos.z })
      neg.clear().appendSamples({ xValues: s.neg.x, yValues: s.neg.y, zValues: s.neg.z })
      const radii = s.radii.sort((a, b) => a - b)
      const R = Math.ceil(radii[Math.floor(radii.length * 0.985)])
      for (const [axis, name] of [[chart.getDefaultAxisX(), 'x'], [chart.getDefaultAxisY(), 'z'], [chart.getDefaultAxisZ(), 'y']] as const) {
        axis.setTitle(name).setUnits('a₀').setInterval({ start: -R, end: R, stopAxisAfter: true })
      }
      const clamped = l !== p.l || m !== p.m ? ' (clamped)' : ''
      chart.setTitle(`${label} orbital: n = ${n}, l = ${l}, m = ${m}${clamped}`)
    }
    let pending = 0
    ctx.onParamChange?.(() => {
      // Sampling 200k points takes a moment; coalesce slider drags.
      clearTimeout(pending)
      pending = window.setTimeout(show, 120)
    })
    show()

    // Slow turntable rotation until the user takes the camera.
    const eye = chart.getCameraLocation()
    const dist = Math.hypot(eye.x, eye.y, eye.z) || 3
    const pitch = Math.asin(eye.y / dist)
    let yaw = Math.atan2(eye.x, eye.z)
    let spinning = true
    const stop = () => { spinning = false }
    container.addEventListener('pointerdown', stop)
    container.addEventListener('wheel', stop, { passive: true })
    let raf = 0
    const spin = () => {
      if (!spinning) return
      yaw += 0.0035
      chart.setCameraLocation({ x: dist * Math.sin(yaw) * Math.cos(pitch), y: dist * Math.sin(pitch), z: dist * Math.cos(yaw) * Math.cos(pitch) })
      raf = requestAnimationFrame(spin)
    }
    raf = requestAnimationFrame(spin)

    return () => {
      cancelAnimationFrame(raf)
      clearTimeout(pending)
      container.removeEventListener('pointerdown', stop)
      container.removeEventListener('wheel', stop)
      chart.dispose()
    }
  },
} satisfies Example
