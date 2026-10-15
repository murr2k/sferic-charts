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

// ---------------------------------------------------------------- validation
// Geometry may come from untrusted sources, so malformed input fails with a clear
// error instead of a TypeError deep inside decoding, and nesting / size are bounded.

/** Maximum GeometryCollection nesting depth. */
const MAX_DEPTH = 64
/** Maximum number of decoded positions (guards against memory exhaustion). */
const MAX_POINTS = 20_000_000

const fail = (msg: string): never => {
  throw new Error(`sferic: invalid map geometry: ${msg}`)
}
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length >= 2 && isNum(v[0]) && isNum(v[1])

/** Depth-first walk over a geometry tree without recursion. */
function walk<T extends { type?: string; geometries?: unknown }>(root: T, leaf: (g: T) => void) {
  const stack: [T, number][] = [[root, 0]]
  while (stack.length) {
    const [g, depth] = stack.pop()!
    if (!g || typeof g !== 'object') fail('geometry is not an object')
    if (g.type === 'GeometryCollection') {
      if (depth >= MAX_DEPTH) fail(`GeometryCollection nested deeper than ${MAX_DEPTH}`)
      const kids: unknown = g.geometries ?? []
      if (!Array.isArray(kids)) fail('GeometryCollection.geometries is not an array')
      const list = kids as unknown[]
      for (let i = list.length - 1; i >= 0; i--) stack.push([list[i] as T, depth + 1])
    } else leaf(g)
  }
}

/** Decode all arcs to absolute positions. */
export function decodeArcs(topo: Topology): Position[][] {
  const t = topo.transform
  if (t !== undefined && !(t && isPair(t.scale) && isPair(t.translate))) fail('transform needs numeric scale and translate pairs')
  let total = 0
  return topo.arcs.map((arc, ai) => {
    if (!Array.isArray(arc)) fail(`arc ${ai} is not an array`)
    total += arc.length
    if (total > MAX_POINTS) fail(`more than ${MAX_POINTS} arc points`)
    let x = 0, y = 0
    return arc.map((p, pi) => {
      if (!isPair(p)) fail(`arc ${ai} point ${pi} is not a numeric pair`)
      if (!t) return [p[0], p[1]] as Position
      x += p[0]
      y += p[1]
      return [x * t.scale[0] + t.translate[0], y * t.scale[1] + t.translate[1]] as Position
    })
  })
}

/** Resolve an arc reference (negative = reversed, ~i), bounds-checked. */
function arcIndex(i: unknown, n: number): number {
  if (!Number.isInteger(i)) fail(`arc reference ${String(i)} is not an integer`)
  const k = (i as number) < 0 ? ~(i as number) : (i as number)
  if (k >= n) fail(`arc reference ${String(i)} is out of range (${n} arcs)`)
  return k
}

/** Stitch arc references into one ring. */
function ringFromArcs(ids: unknown, arcs: Position[][]): Ring {
  if (!Array.isArray(ids)) fail('ring is not an array of arc references')
  const out: Ring = []
  for (const i of ids as unknown[]) {
    const k = arcIndex(i, arcs.length)
    const a = (i as number) < 0 ? arcs[k].slice().reverse() : arcs[k]
    for (let j = out.length ? 1 : 0; j < a.length; j++) out.push(a[j])
  }
  return out
}

const polygonArcs = (o: TopoGeometry): unknown[][] => {
  if (!Array.isArray(o.arcs)) fail(`${o.type} has no arcs array`)
  return o.type === 'Polygon' ? [o.arcs as unknown[]] : (o.arcs as unknown[][])
}

/** Pick the object to decode: the named one, 'countries' if present, else the first. */
export function topologyObjectName(topo: Topology, name?: string): string {
  if (!topo.objects || typeof topo.objects !== 'object') fail('topology has no objects')
  if (name && topo.objects[name]) return name
  if (topo.objects.countries) return 'countries'
  return Object.keys(topo.objects)[0]
}

/** Decode a TopoJSON object to features. */
export function topologyToFeatures(topo: Topology, name?: string): GeoFeature[] {
  const arcs = decodeArcs(topo)
  const obj = topo.objects[topologyObjectName(topo, name)]
  const out: GeoFeature[] = []
  if (!obj) return out
  walk(obj, (o) => {
    if (o.type !== 'Polygon' && o.type !== 'MultiPolygon') return
    const polys = polygonArcs(o).map((p) => {
      if (!Array.isArray(p)) fail('polygon is not an array of rings')
      return (p as unknown[]).map((r) => ringFromArcs(r, arcs))
    })
    const props = o.properties && typeof o.properties === 'object' ? o.properties : {}
    out.push({ id: o.id, properties: props, polygons: polys.filter((p) => p.length && p[0].length >= 3) })
  })
  return out
}

/** Each arc used by the object's polygons, once (shared borders are drawn a single time). */
export function topologyMesh(topo: Topology, name?: string): Position[][] {
  const arcs = decodeArcs(topo)
  const obj = topo.objects[topologyObjectName(topo, name)]
  const used = new Set<number>()
  if (!obj) return []
  walk(obj, (o) => {
    if (o.type !== 'Polygon' && o.type !== 'MultiPolygon') return
    for (const p of polygonArcs(o)) {
      if (!Array.isArray(p)) fail('polygon is not an array of rings')
      for (const r of p as unknown[]) {
        if (!Array.isArray(r)) fail('ring is not an array of arc references')
        for (const i of r as unknown[]) used.add(arcIndex(i, arcs.length))
      }
    }
  })
  return [...used].sort((a, b) => a - b).map((i) => arcs[i])
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

/** Validate a GeoJSON ring: an array of numeric positions. */
function ringOf(r: unknown, budget: { n: number }): Ring {
  if (!Array.isArray(r)) fail('GeoJSON ring is not an array')
  budget.n += (r as unknown[]).length
  if (budget.n > MAX_POINTS) fail(`more than ${MAX_POINTS} coordinates`)
  return (r as unknown[]).map((p, i) => {
    if (!isPair(p)) fail(`GeoJSON position ${i} is not a numeric pair`)
    return [(p as number[])[0], (p as number[])[1]] as Position
  })
}

/** Decode GeoJSON (FeatureCollection, Feature or bare geometry) to features. */
export function geojsonToFeatures(gj: unknown): GeoFeature[] {
  const out: GeoFeature[] = []
  const budget = { n: 0 }
  const polysOf = (g: GeoJSONGeometry | null): Ring[][] => {
    if (!g) return []
    const polys: Ring[][] = []
    walk(g, (leaf) => {
      const c = leaf.coordinates
      if (leaf.type === 'Polygon') {
        if (!Array.isArray(c)) fail('Polygon coordinates are not an array')
        polys.push((c as unknown[]).map((r) => ringOf(r, budget)))
      } else if (leaf.type === 'MultiPolygon') {
        if (!Array.isArray(c)) fail('MultiPolygon coordinates are not an array')
        for (const p of c as unknown[]) {
          if (!Array.isArray(p)) fail('MultiPolygon member is not an array of rings')
          polys.push((p as unknown[]).map((r) => ringOf(r, budget)))
        }
      }
    })
    return polys
  }
  const props = (p: unknown) => (p && typeof p === 'object' ? (p as Record<string, unknown>) : {})
  const o = gj as { type?: string; features?: unknown }
  if (o?.type === 'FeatureCollection') {
    if (!Array.isArray(o.features)) fail('FeatureCollection.features is not an array')
    for (const f of o.features as GeoJSONFeature[]) {
      if (!f || typeof f !== 'object') fail('feature is not an object')
      out.push({ id: f.id, properties: props(f.properties), polygons: polysOf(f.geometry) })
    }
  } else if (o?.type === 'Feature') {
    const f = gj as GeoJSONFeature
    out.push({ id: f.id, properties: props(f.properties), polygons: polysOf(f.geometry) })
  } else if (o?.type) {
    out.push({ properties: {}, polygons: polysOf(gj as GeoJSONGeometry) })
  } else {
    fail('input is neither TopoJSON nor GeoJSON')
  }
  return out.filter((f) => f.polygons.length)
}
