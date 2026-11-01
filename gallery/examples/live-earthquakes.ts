import { sferic, AxisTickStrategies, LUT, PalettedFill, SolidFill, decodeArcs, ColorRGBA, type Topology, type ChartXY } from '../../src'
import type { Example } from '../types'

const FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/'
const LAND = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json'
const WEEK_MS = 7 * 24 * 3600 * 1000
const POLL_MS = 60_000

interface Quake { id: string; lon: number; lat: number; depth: number; mag: number; time: number; place: string }
interface Feed { features: { id: string; properties: { mag: number | null; place: string | null; time: number }; geometry: { coordinates: [number, number, number] } }[] }

// Shared across mounts so revisiting the example does not download the week again.
const cache = { quakes: new Map<string, Quake>(), weekLoadedAt: 0, coast: null as { x: Float64Array; y: Float64Array } | null }

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-cache' })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json() as Promise<T>
}

function merge(feed: Feed) {
  for (const f of feed.features) {
    const [lon, lat, depth] = f.geometry.coordinates
    if (f.properties.mag == null || !Number.isFinite(lon) || !Number.isFinite(lat)) continue
    cache.quakes.set(f.id, { id: f.id, lon, lat, depth: Math.max(0, depth), mag: f.properties.mag, time: f.properties.time, place: f.properties.place ?? 'Unknown location' })
  }
  const cutoff = Date.now() - WEEK_MS
  for (const [id, q] of cache.quakes) if (q.time < cutoff) cache.quakes.delete(id)
}

/** Coastlines as one polyline with NaN gaps between arcs (and at antimeridian jumps). */
async function coastline() {
  if (cache.coast) return cache.coast
  const arcs = decodeArcs(await getJSON<Topology>(LAND))
  const x: number[] = [], y: number[] = []
  for (const arc of arcs) {
    arc.forEach(([lon, lat], i) => {
      if (i > 0 && Math.abs(lon - arc[i - 1][0]) > 180) { x.push(lon); y.push(NaN) }
      x.push(lon)
      y.push(lat)
    })
    x.push(arc[arc.length - 1][0])
    y.push(NaN)
  }
  cache.coast = { x: Float64Array.from(x), y: Float64Array.from(y) }
  return cache.coast
}

const ago = (t: number) => {
  const m = (Date.now() - t) / 60000
  return m < 60 ? `${Math.max(1, Math.round(m))} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`
}

export default {
  title: 'Live Earthquakes (USGS)',
  category: 'Live data',
  order: 1,
  tags: ['live data', 'geo', 'scatter', 'per-point size', 'lut', 'polling'],
  description:
    'Every earthquake of the past seven days from the USGS real-time GeoJSON feeds, refreshed every minute. Marker size follows magnitude and color follows depth through a LUT; coastlines are decoded from TopoJSON with the library\'s decodeArcs and drawn as a single line series with gaps. Events from the past hour pulse. The lower chart is the same catalog on a date-time axis. Hover any marker for its location, magnitude and depth.',
  run({ container, theme }) {
    const dash = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    dash.setRowHeight(0, 2.5).setRowHeight(1, 1)

    const map = dash.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { position: 'right' } }).setTitle('Loading earthquake feed…')
    const deg = (v: number) => `${Math.round(v)}°`
    map.axisX.setTickStrategy(AxisTickStrategies.Numeric, (s) => s.setFormattingFunction(deg)).setInterval({ start: -180, end: 180, stopAxisAfter: true }).setDefaultInterval({ start: -180, end: 180 })
    map.axisY.setTickStrategy(AxisTickStrategies.Numeric, (s) => s.setFormattingFunction(deg)).setInterval({ start: -62, end: 84, stopAxisAfter: true }).setDefaultInterval({ start: -62, end: 84 })

    const coast = map
      .addLineSeries()
      .setName('Coastline')
      .setStrokeStyle((s) => s.setThickness(1).setFillStyle(new SolidFill({ color: theme.axisLineColor.setA(theme.isDark ? 150 : 190) })))
    coast.setCursorEnabled(false)

    const pal = theme.examples.intensityColorPalette
    const lut = new LUT({
      interpolate: true,
      units: 'km',
      steps: [
        { value: 0, color: pal[5].setA(215) },
        { value: 175, color: pal[4].setA(215) },
        { value: 350, color: pal[3].setA(215) },
        { value: 525, color: pal[2].setA(215) },
        { value: 700, color: pal[1].setA(235) },
      ],
    })
    const pulse = map.addPointSeries().setName('Past hour')
    pulse.setCursorEnabled(false)
    const quakes = map.addPointSeries().setName('Earthquakes').setPointFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }))

    const timeline = dash.createChartXY({ columnIndex: 0, rowIndex: 1, legend: { visible: false } }).setTitle('Magnitude over time')
    timeline.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    timeline.axisY.setTitle('Magnitude').setInterval({ start: -1, end: 8, stopAxisAfter: true }).setDefaultInterval({ start: -1, end: 8 })
    const events = timeline.addPointSeries().setName('Earthquakes').setPointFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }))

    map.legend.remove(coast)
    map.legend.remove(quakes)
    map.legend.remove(pulse)
    map.legend.add(lut, { name: 'Depth', units: 'km', lutLength: 140 })

    let sorted: Quake[] = []
    let recent: Quake[] = []
    const size = (m: number) => 2.5 + 1.25 * Math.pow(Math.max(0, m), 1.7)
    const render = () => {
      sorted = [...cache.quakes.values()].sort((a, b) => a.mag - b.mag)
      const n = sorted.length
      const sizes = Float32Array.from(sorted, (q) => size(q.mag))
      const depth = Float32Array.from(sorted, (q) => q.depth)
      quakes.setSamples({ xValues: Float64Array.from(sorted, (q) => q.lon), yValues: Float64Array.from(sorted, (q) => q.lat), sizes, lookupValues: depth })
      events.setSamples({ xValues: Float64Array.from(sorted, (q) => q.time), yValues: Float64Array.from(sorted, (q) => q.mag), sizes: sizes.map((s) => Math.min(s, 14)), lookupValues: depth })
      const now = Date.now()
      timeline.axisX.setInterval({ start: now - WEEK_MS, end: now + 3600_000, stopAxisAfter: true })
      recent = sorted.filter((q) => now - q.time < 3600_000)
      const big = sorted[n - 1]
      const at = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      map.setTitle(`${n.toLocaleString('en-US')} earthquakes in the past 7 days${big ? `, largest M ${big.mag.toFixed(1)} ${big.place}` : ''} (USGS, updated ${at})`)
    }

    // Hover: the nearest catalog entry to the snapped point.
    const describe = (chart: ChartXY, pick: (q: Quake) => [number, number]) =>
      chart.setCursorFormatting((_c, hit) => {
        let best: Quake | undefined
        let bd = Infinity
        for (const q of sorted) {
          const [x, y] = pick(q)
          const d = (x - hit.x) ** 2 + (y - hit.y) ** 2
          if (d < bd) { bd = d; best = q }
        }
        if (!best) return [['No data']]
        return [[best.place], ['Magnitude', `M ${best.mag.toFixed(1)}`], ['Depth', `${best.depth.toFixed(0)} km`], ['When', `${ago(best.time)}`]]
      })
    describe(map, (q) => [q.lon, q.lat])
    describe(timeline, (q) => [q.time, q.mag])

    let disposed = false
    const fail = (e: unknown) => {
      if (!disposed) map.setTitle(`Earthquake feed unavailable (${(e as Error).message}); retrying every minute`)
    }
    coastline().then((c) => !disposed && coast.setSamples({ xValues: c.x, yValues: c.y })).catch(() => { /* map works without coastlines */ })
    const loadWeek = async () => {
      if (Date.now() - cache.weekLoadedAt > 10 * 60_000) {
        merge(await getJSON<Feed>(`${FEED}all_week.geojson`))
        cache.weekLoadedAt = Date.now()
      }
      if (!disposed) render()
    }
    loadWeek().catch(fail)
    const poll = setInterval(() => {
      const work = cache.weekLoadedAt ? getJSON<Feed>(`${FEED}all_hour.geojson`).then(merge) : loadWeek()
      work.then(() => !disposed && render()).catch(fail)
    }, POLL_MS)

    // Ripple on events from the past hour.
    const ring = theme.examples.highlightColor
    let raf = 0
    let pulsing = false
    const animate = (t: number) => {
      if (recent.length) {
        pulsing = true
        const p = (t / 1600) % 1
        const c = ColorRGBA(ring.getR(), ring.getG(), ring.getB(), Math.round(170 * (1 - p))).toUint32()
        pulse.setSamples({
          xValues: recent.map((q) => q.lon),
          yValues: recent.map((q) => q.lat),
          sizes: recent.map((q) => size(q.mag) + 34 * p),
          colors: recent.map(() => c),
        })
      } else if (pulsing) {
        pulsing = false
        pulse.clear()
      }
      raf = requestAnimationFrame(animate)
    }
    raf = requestAnimationFrame(animate)

    return () => {
      disposed = true
      clearInterval(poll)
      cancelAnimationFrame(raf)
      dash.dispose()
    }
  },
} satisfies Example
