import { sferic, LUT, regularColorSteps, type HierarchyNodeData } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Dynamic TreeMap',
  category: 'Hierarchy',
  order: 3,
  tags: ['treemap', 'real-time', 'animation', 'lut'],
  description:
    'Request rate per service in four data centers, refreshed every 1.5 s. Calling setData again animates tile geometry, values and colors; tiles are sized by requests/s and colored by latency.',
  run({ container, theme }) {
    const r = rng(99)
    const centers = ['eu-west', 'us-east', 'us-west', 'ap-south']
    const services = ['auth', 'search', 'checkout', 'catalog', 'images', 'video', 'chat', 'payments', 'reports', 'feeds']
    const state = centers.map((dc) => ({
      name: dc,
      svcs: services.filter(() => r() > 0.25).map((s) => ({ name: s, rps: 200 + r() * 2000, lat: 20 + r() * 200 })),
    }))
    const build = (): HierarchyNodeData[] =>
      state.map((dc) => ({ name: dc.name, children: dc.svcs.map((s) => ({ name: s.name, value: Math.round(s.rps), latency: s.lat })) }))

    const lut = new LUT({
      interpolate: true,
      units: 'ms',
      steps: regularColorSteps(20, 260, theme.examples.badGoodColorPalette.slice().reverse().map((c) => (theme.isDark ? c.scale(0.7) : c))),
    })
    const chart = sferic()
      .TreeMapChart({ container, theme })
      .setTitle('Live service load (requests/s)')
      .setInitialPathButtonText('Global')
      .setNodeColoring({ lut, lookUpProperty: 'latency' }, { legendName: 'Latency' })
      .setValueFormatter((v) => `${Math.round(v).toLocaleString('en-US')} req/s`)
      .setLabelFormatter((n, v) => `${Math.round(v).toLocaleString('en-US')} req/s, ${Math.round(n.colorValue)} ms`)
      .setData(build())

    const timer = setInterval(() => {
      for (const dc of state) {
        for (const s of dc.svcs) {
          s.rps = Math.max(50, s.rps * (0.7 + r() * 0.6) + (r() - 0.5) * 300)
          s.lat = Math.max(15, Math.min(280, s.lat + (r() - 0.5) * 80))
        }
      }
      chart.setData(build())
    }, 1500)
    return () => {
      clearInterval(timer)
      chart.dispose()
    }
  },
} satisfies Example
