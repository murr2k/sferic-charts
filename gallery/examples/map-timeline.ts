import { sferic, MapTypes, LUT, PalettedFill, ColorHEX, regularColorSteps } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

const WORLD_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'

export default {
  title: 'Map Timeline Animation',
  category: 'Other',
  order: 31,
  tags: ['map', 'animation', 'timeline', 'lut'],
  description:
    'A synthetic adoption curve per country (logistic, with a country-specific start year and ceiling) played from 1990 to 2024. Each step calls invalidateRegionValues and region colors interpolate smoothly on the GPU.',
  run({ container, theme }) {
    const chart = sferic().Map({ container, theme, type: MapTypes.World }).setTitle('Loading world map…')
    const colors = theme.isDark
      ? ['#1a1a1a', '#3b2a10', '#7a5a14', '#c9a227', '#f2dc6b', '#fff7c2']
      : ['#f7f7f7', '#d9f0d3', '#a6dba0', '#5aae61', '#1b7837', '#00441b']
    const lut = new LUT({ interpolate: true, units: '%', steps: regularColorSteps(0, 100, colors.map((c) => ColorHEX(c))) })
    chart
      .setFillStyle(new PalettedFill({ lut, lookUpProperty: 'value' }), { legendName: 'Adoption' })
      .setValueFormatter((v) => `${v.toFixed(1)} %`)
      .setAnimationDuration(380)

    const model = new Map<string, { t0: number; k: number; cap: number }>()
    const params = (name: string) => {
      let p = model.get(name)
      if (!p) {
        let seed = 7
        for (const ch of name) seed = (seed * 33 + ch.charCodeAt(0)) >>> 0
        const r = rng(seed)
        r()
        p = { t0: 1998 + r() * 18, k: 2 + r() * 3, cap: 55 + r() * 43 }
        model.set(name, p)
      }
      return p
    }
    let timer = 0
    let disposed = false
    fetch(WORLD_URL)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      .then((topology) => {
        if (disposed) return
        chart.setGeometry(topology)
        let year = 1990
        const step = () => {
          chart.setTitle(`Synthetic technology adoption, ${year}`)
          chart.invalidateRegionValues((region) => {
            const p = params(region.name)
            return p.cap / (1 + Math.exp(-(year - p.t0) / p.k))
          })
          year = year >= 2024 ? 1990 : year + 1
        }
        step()
        timer = window.setInterval(step, 450)
      })
      .catch((err: Error) => {
        if (disposed) return
        chart.setTitle('Map timeline').setMessage(`Could not load map data (${err.message}). Check the network connection and reload.`)
      })
    return () => {
      disposed = true
      clearInterval(timer)
      chart.dispose()
    }
  },
} satisfies Example
