import { sferic, MapTypes, LUT, PalettedFill, ColorHEX, regularColorSteps } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'

export default {
  title: 'World Map (choropleth)',
  category: 'Other',
  order: 30,
  tags: ['map', 'topojson', 'lut', 'geo'],
  description:
    'Countries from the world-atlas TopoJSON (fetched at runtime), triangulated once and filled on the GPU with a per-region color texture. Values are synthetic. Wheel to zoom, drag to pan, double-click to reset; hover a country for its value.',
  run({ container, theme }) {
    const chart = sferic().Map({ container, theme, type: MapTypes.World }).setTitle('Loading world map…')
    const colors = theme.isDark
      ? ['#0e2f3a', '#16606a', '#2f9a8a', '#c9c25a', '#f0a03c', '#ff5a3c']
      : ['#f7fbff', '#c6dbef', '#6baed6', '#fdae6b', '#e6550d', '#a63603']
    const lut = new LUT({ interpolate: true, units: 'pts', steps: regularColorSteps(0, 100, colors.map((c) => ColorHEX(c))) })
    chart.setFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }), { legendName: 'Synthetic index' })
    chart.setValueFormatter((v) => `${v.toFixed(1)} pts`)

    let disposed = false
    fetch(WORLD_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((topology) => {
        if (disposed) return
        chart.setGeometry(topology).setTitle('Synthetic development index by country')
        // Deterministic pseudo-random value per country name.
        chart.invalidateRegionValues((region) => {
          let seed = 0
          for (const ch of region.name) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0
          const r = rng(seed)
          r()
          return Math.round((15 + r() * 70 + (r() - 0.5) * 30) * 10) / 10
        })
      })
      .catch((err: Error) => {
        if (disposed) return
        chart.setTitle('World map').setMessage(`Could not load map data (${err.message}). Check the network connection and reload.`)
      })
    return () => {
      disposed = true
      chart.dispose()
    }
  },
} satisfies Example
