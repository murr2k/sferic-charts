// Minimal TopoJSON / GeoJSON decoding to polygon rings ([lon, lat] pairs).
// Supports quantized (delta-encoded + transform) and plain arcs, Polygon /
// MultiPolygon geometries and GeometryCollections.

export type Position = [number, number]
export type Ring = Position[]

/** A decoded region: polygons as [outer ring, ...holes]. */
export interface GeoFeature {
  id?: string | number
  properties: Record<string, unknown>
  polygons: Ring[][]
}

interface TopoGeometry {
  type: string
  arcs?: unknown
  geometries?: TopoGeometry[]
  id?: string | number
  properties?: Record<string, unknown>
}

export interface Topology {
  type: 'Topology'
  transform?: { scale: [number, number]; translate: [number, number] }
  arcs: number[][][]
  objects: Record<string, TopoGeometry>
}

export const isTopology = (o: unknown): o is Topology =>
  !!o && typeof o === 'object' && (o as { type?: string }).type === 'Topology' && Array.isArray((o as Topology).arcs)

/** Decode all arcs to absolute positions. */
export function decodeArcs(topo: Topology): Position[][] {
  const t = topo.transform
  return topo.arcs.map((arc) => {
    if (!t) return arc.map((p) => [p[0], p[1]] as Position)
    let x = 0, y = 0
    return arc.map((p) => {
      x += p[0]
      y += p[1]
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] as Position
    })
  })
}

/** Stitch arc references (negative = reversed, ~i) into one ring. */
function ringFromArcs(ids: number[], arcs: Position[][]): Ring {
  const out: Ring = []
  for (const i of ids) {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i]
    if (!a) continue
    for (let k = out.length ? 1 : 0; k < a.length; k++) out.push(a[k])
  }
  return out
}

/** Pick the object to decode: the named one, 'countries' if present, else the first. */
export function topologyObjectName(topo: Topology, name?: string): string {
  if (name && topo.objects[name]) return name
  if (topo.objects.countries) return 'countries'
  return Object.keys(topo.objects)[0]
}

/** Decode a TopoJSON object to features. */
export function topologyToFeatures(topo: Topology, name?: string): GeoFeature[] {
  const arcs = decodeArcs(topo)
  const obj = topo.objects[topologyObjectName(topo, name)]
  const out: GeoFeature[] = []
  const visit = (o: TopoGeometry) => {
    if (o.type === 'GeometryCollection') {
      for (const g of o.geometries ?? []) visit(g)
      return
    }
    let polys: Ring[][] | null = null
    if (o.type === 'Polygon') polys = [(o.arcs as number[][]).map((r) => ringFromArcs(r, arcs))]
    else if (o.type === 'MultiPolygon') polys = (o.arcs as number[][][]).map((p) => p.map((r) => ringFromArcs(r, arcs)))
    if (polys) out.push({ id: o.id, properties: o.properties ?? {}, polygons: polys.filter((p) => p.length && p[0].length >= 3) })
  }
  if (obj) visit(obj)
  return out
}

/** Each arc used by the object's polygons, once (shared borders are drawn a single time). */
export function topologyMesh(topo: Topology, name?: string): Position[][] {
  const arcs = decodeArcs(topo)
  const obj = topo.objects[topologyObjectName(topo, name)]
  const used = new Set<number>()
  const visit = (o: TopoGeometry) => {
    if (o.type === 'GeometryCollection') {
      for (const g of o.geometries ?? []) visit(g)
      return
    }
    const add = (r: number[]) => r.forEach((i) => used.add(i < 0 ? ~i : i))
    if (o.type === 'Polygon') (o.arcs as number[][]).forEach(add)
    else if (o.type === 'MultiPolygon') (o.arcs as number[][][]).forEach((p) => p.forEach(add))
  }
  if (obj) visit(obj)
  return [...used].sort((a, b) => a - b).map((i) => arcs[i]).filter(Boolean)
}

// ---------------------------------------------------------------- antimeridian

/** Segment jumps across lon = +-180 (but not a run along a pole). */
const crossesAM = (a: Position, b: Position) => Math.abs(b[0] - a[0]) > 180 && !(Math.abs(a[1]) > 89 && Math.abs(b[1]) > 89)

/** Make longitudes continuous across the antimeridian; returns the ring and its net wrap. */
function unwrapRing(ring: Ring): [Ring, number] {
  const out: Ring = []
  let off = 0
  for (let i = 0; i < ring.length; i++) {
    const p = ring[i]
    if (i > 0 && crossesAM(ring[i - 1], p)) off += ring[i - 1][0] > p[0] ? 360 : -360
    out.push([p[0] + off, p[1]])
  }
  return [out, off]
}

/** Sutherland-Hodgman clip of a ring to lo <= lon <= hi. */
function clipRingLon(ring: Ring, lo: number, hi: number): Ring {
  let pts = ring
  for (const [edge, keepAbove] of [[lo, true], [hi, false]] as [number, boolean][]) {
    const out: Ring = []
    const n = pts.length
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n]
      const ina = keepAbove ? a[0] >= edge : a[0] <= edge
      const inb = keepAbove ? b[0] >= edge : b[0] <= edge
      if (ina) out.push(a)
      if (ina !== inb) {
        const t = (edge - a[0]) / (b[0] - a[0])
        out.push([edge, a[1] + t * (b[1] - a[1])])
      }
    }
    pts = out
  }
  return pts
}

const ringArea = (r: Ring) => {
  let s = 0
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[i][1] + r[j][1])
  return s / 2
}

/**
 * Split a polygon whose rings jump across the antimeridian (as in unclipped world-atlas
 * data) into pieces that each stay within [-180, 180]. Pole-encircling rings are left as is.
 */
export function cutPolygonAtAntimeridian(poly: Ring[]): Ring[][] {
  const crosses = (r: Ring) => r.some((p, i) => i > 0 && crossesAM(r[i - 1], p))
  if (!poly.some(crosses)) return [poly]
  const unwrapped = poly.map(unwrapRing)
  if (unwrapped.some(([, off]) => off !== 0)) return [poly]
  const pieces: Ring[][] = []
  for (const shift of [0, -360, 360]) {
    const lo = -180 - shift, hi = 180 - shift
    const back = (r: Ring): Ring => r.map((p) => [p[0] + shift, p[1]] as Position)
    const outer = clipRingLon(unwrapped[0][0], lo, hi)
    if (outer.length < 3 || Math.abs(ringArea(outer)) < 1e-9) continue
    const holes = unwrapped.slice(1).map(([h]) => clipRingLon(h, lo, hi)).filter((h) => h.length >= 3 && Math.abs(ringArea(h)) > 1e-9)
    pieces.push([back(outer), ...holes.map(back)])
  }
  return pieces.length ? pieces : [poly]
}

/** Split a polyline where it jumps across the antimeridian, adding the edge points. */
export function splitLineAtAntimeridian(line: Position[]): Position[][] {
  if (!line.length) return []
  const out: Position[][] = [[line[0]]]
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1], b = line[i]
    if (crossesAM(a, b)) {
      const edge = a[0] > b[0] ? 180 : -180
      const bx = b[0] + (edge > 0 ? 360 : -360)
      const t = (edge - a[0]) / (bx - a[0] || 1)
      const lat = a[1] + t * (b[1] - a[1])
      out[out.length - 1].push([edge, lat])
      out.push([[-edge, lat], b])
    } else out[out.length - 1].push(b)
  }
  return out.filter((l) => l.length > 1)
}

interface GeoJSONGeometry { type: string; coordinates?: unknown; geometries?: GeoJSONGeometry[] }
interface GeoJSONFeature { type: 'Feature'; id?: string | number; properties?: Record<string, unknown> | null; geometry: GeoJSONGeometry | null }

/** Decode GeoJSON (FeatureCollection, Feature or bare geometry) to features. */
export function geojsonToFeatures(gj: unknown): GeoFeature[] {
  const out: GeoFeature[] = []
  const polysOf = (g: GeoJSONGeometry | null): Ring[][] => {
    if (!g) return []
    if (g.type === 'Polygon') return [g.coordinates as Ring[]]
    if (g.type === 'MultiPolygon') return g.coordinates as Ring[][]
    if (g.type === 'GeometryCollection') return (g.geometries ?? []).flatMap(polysOf)
    return []
  }
  const o = gj as { type?: string; features?: GeoJSONFeature[] }
  if (o?.type === 'FeatureCollection') {
    for (const f of o.features ?? []) out.push({ id: f.id, properties: f.properties ?? {}, polygons: polysOf(f.geometry) })
  } else if (o?.type === 'Feature') {
    const f = gj as GeoJSONFeature
    out.push({ id: f.id, properties: f.properties ?? {}, polygons: polysOf(f.geometry) })
  } else if (o?.type) {
    out.push({ properties: {}, polygons: polysOf(gj as GeoJSONGeometry) })
  }
  return out.filter((f) => f.polygons.length)
}
