// Map projections: (lon, lat) degrees -> planar (x, y), y up, unit sphere.

export type MapProjection = 'equirectangular' | 'mercator' | 'naturalEarth'

export const MapProjections = {
  Equirectangular: 'equirectangular',
  Mercator: 'mercator',
  NaturalEarth: 'naturalEarth',
} as const

const RAD = Math.PI / 180
/** Mercator latitude limit (Web Mercator). */
export const MERCATOR_MAX_LAT = 85.05

export type Projector = (lon: number, lat: number) => [number, number]

export function projector(p: MapProjection): Projector {
  switch (p) {
    case 'mercator':
      return (lon, lat) => {
        const phi = Math.max(-MERCATOR_MAX_LAT, Math.min(MERCATOR_MAX_LAT, lat)) * RAD
        return [lon * RAD, Math.log(Math.tan(Math.PI / 4 + phi / 2))]
      }
    case 'naturalEarth':
      // Natural Earth I (Savric et al.), polynomial form as in d3-geo.
      return (lon, lat) => {
        const l = lon * RAD, phi = lat * RAD
        const p2 = phi * phi, p4 = p2 * p2
        return [
          l * (0.8707 - 0.131979 * p2 + p4 * (-0.013791 + p4 * (0.003971 * p2 - 0.001529 * p4))),
          phi * (1.007226 + p2 * (0.015085 + p4 * (-0.044475 + 0.028874 * p2 - 0.005916 * p4))),
        ]
      }
    default:
      return (lon, lat) => [lon * RAD, lat * RAD]
  }
}

/** Outline of the whole globe in projected space (closed ring). */
export function sphereOutline(p: MapProjection, steps = 90): [number, number][] {
  const f = projector(p)
  const top = p === 'mercator' ? MERCATOR_MAX_LAT : 90
  const out: [number, number][] = []
  for (let i = 0; i <= steps; i++) out.push(f(-180, -top + (2 * top * i) / steps))
  for (let i = 1; i <= steps; i++) out.push(f(-180 + (360 * i) / steps, top))
  for (let i = 1; i <= steps; i++) out.push(f(180, top - (2 * top * i) / steps))
  for (let i = 1; i < steps; i++) out.push(f(180 - (360 * i) / steps, -top))
  return out
}
