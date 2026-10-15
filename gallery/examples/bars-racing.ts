import { sferic, BarChartTypes, BarChartSorting, ColorHSV, UIOrigins } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Racing Bars',
  category: 'Bars',
  order: 5,
  tags: ['bars', 'animation', 'racing', 'sorting'],
  description:
    'Bar chart race: every step loads a new year of data, bars grow, re-sort and enter or leave the top 10 with smooth transitions. Values follow synthetic logistic growth curves.',
  run({ container, theme }) {
    const chart = sferic()
      .BarChart({ container, theme, type: BarChartTypes.Horizontal })
      .setTitle('Largest Metropolitan Areas, Top 10 (synthetic data)')
      .setSorting(BarChartSorting.Descending)
      .setValueLabels({ position: 'after-bar', formatter: (info) => `${info.value.toFixed(1)} M` })
      .setAnimationDuration(900)
      .setCornerRadius(2)
    chart.valueAxis.setTitle('Population').setUnits('millions')

    // Synthetic logistic growth per city: start level, saturation, midpoint year, rate.
    const cities = [
      'Tokyo', 'Delhi', 'Shanghai', 'Sao Paulo', 'Mexico City', 'Cairo', 'Mumbai', 'Beijing', 'Dhaka', 'Osaka',
      'New York', 'Karachi', 'Buenos Aires', 'Chongqing', 'Istanbul', 'Kolkata', 'Lagos', 'Manila', 'Kinshasa', 'Jakarta',
    ]
    // One distinct hue per city so entrants never share a color with a bar on screen.
    chart.setPalette(cities.map((_, i) => (theme.isDark ? ColorHSV((i * 137.5) % 360, 0.5, 0.95) : ColorHSV((i * 137.5) % 360, 0.72, 0.82))))
    const r = rng(2024)
    const model = cities.map((_, i) => ({
      start: 2 + r() * 12,
      sat: 14 + r() * 26 - i * 0.3,
      mid: 1965 + r() * 60,
      rate: 0.04 + r() * 0.08,
    }))
    const valueAt = (i: number, year: number) => {
      const m = model[i]
      return m.start + (m.sat - m.start) / (1 + Math.exp(-m.rate * (year - m.mid)))
    }
    const y0 = 1960, y1 = 2030
    let year = y0
    const yearLabel = chart
      .addUIElement()
      .setPosition({ x: 97, y: 6 })
      .setOrigin(UIOrigins.RightBottom)
      .setTextFont((f) => f.setSize(44).setWeight(600))
    const load = () => {
      const rows = cities.map((category, i) => ({ category, value: valueAt(i, year) }))
      rows.sort((a, b) => b.value - a.value)
      chart.setData(rows.slice(0, 10))
      yearLabel.setText(String(year))
      year = year >= y1 ? y0 : year + 1
    }
    load()
    const timer = setInterval(load, 1000)
    return () => {
      clearInterval(timer)
      chart.dispose()
    }
  },
} satisfies Example
