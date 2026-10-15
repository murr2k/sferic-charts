import { sferic, type HierarchyNodeData } from '../../src'
import type { Example } from '../types'

/** Approximate 2023 populations in millions: continent > sub-region > country. */
const raw: Record<string, Record<string, Record<string, number>>> = {
  Asia: {
    'Eastern Asia': { China: 1410, Japan: 124, 'South Korea': 52, 'North Korea': 26, Taiwan: 23, Mongolia: 3.4 },
    'Southern Asia': { India: 1430, Pakistan: 240, Bangladesh: 173, Iran: 89, Afghanistan: 42, Nepal: 31, 'Sri Lanka': 22 },
    'South-eastern Asia': { Indonesia: 278, Philippines: 117, Vietnam: 99, Thailand: 72, Myanmar: 54, Malaysia: 34, Cambodia: 17 },
    'Western Asia': { Turkey: 85, Iraq: 45, 'Saudi Arabia': 37, Yemen: 34, Syria: 23, UAE: 10, Israel: 10 },
    'Central Asia': { Uzbekistan: 35, Kazakhstan: 20, Tajikistan: 10, Kyrgyzstan: 7, Turkmenistan: 6.5 },
  },
  Africa: {
    'Eastern Africa': { Ethiopia: 127, Tanzania: 67, Kenya: 55, Uganda: 49, Mozambique: 34, Madagascar: 30 },
    'Western Africa': { Nigeria: 224, Ghana: 34, "Cote d'Ivoire": 29, Niger: 27, Mali: 23, 'Burkina Faso': 23, Senegal: 18 },
    'Northern Africa': { Egypt: 113, Sudan: 48, Algeria: 46, Morocco: 38, Tunisia: 12, Libya: 7 },
    'Middle Africa': { 'DR Congo': 102, Angola: 37, Cameroon: 28, Chad: 18 },
    'Southern Africa': { 'South Africa': 60, Botswana: 2.7, Namibia: 2.6, Lesotho: 2.3 },
  },
  Europe: {
    'Eastern Europe': { Russia: 144, Poland: 38, Ukraine: 37, Romania: 19, Czechia: 10.5, Hungary: 9.6, Belarus: 9.2, Bulgaria: 6.4 },
    'Western Europe': { Germany: 84, France: 68, Netherlands: 18, Belgium: 11.7, Austria: 9.1, Switzerland: 8.8 },
    'Southern Europe': { Italy: 59, Spain: 48, Portugal: 10.4, Greece: 10.4, Serbia: 6.6 },
    'Northern Europe': { 'United Kingdom': 68, Sweden: 10.5, Denmark: 5.9, Finland: 5.6, Norway: 5.5, Ireland: 5.2 },
  },
  'Latin America': {
    'South America': { Brazil: 216, Colombia: 52, Argentina: 46, Peru: 34, Venezuela: 28, Chile: 19.6, Ecuador: 18 },
    'Central America': { Mexico: 128, Guatemala: 18, Honduras: 10.6, Nicaragua: 7, 'El Salvador': 6.4, 'Costa Rica': 5.2, Panama: 4.5 },
    Caribbean: { Haiti: 11.7, 'Dominican Rep.': 11.3, Cuba: 11, 'Puerto Rico': 3.2, Jamaica: 2.8 },
  },
  'Northern America': { 'Northern America': { 'United States': 335, Canada: 40 } },
  Oceania: {
    'Australia & NZ': { Australia: 26.6, 'New Zealand': 5.2 },
    Melanesia: { 'Papua New Guinea': 10.3, Fiji: 0.9, 'Solomon Is.': 0.74 },
  },
}

const worldPopulation: HierarchyNodeData = {
  name: 'World',
  children: Object.entries(raw).map(([continent, regions]) => ({
    name: continent,
    children: Object.entries(regions).map(([region, countries]) => ({
      name: region,
      children: Object.entries(countries).map(([name, value]) => ({ name, value })),
    })),
  })),
}

const formatPopulation = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(2)} billion` : `${v.toFixed(v < 10 ? 1 : 0)} million`)

export default {
  title: 'Sunburst Chart',
  category: 'Hierarchy',
  order: 4,
  tags: ['sunburst', 'drill-down', 'animation'],
  description:
    'World population by continent, sub-region and country. Each branch takes a palette color with lighter children. Click a sector to zoom into it, click the center (or right-click) to go back up.',
  run({ container, theme }) {
    const chart = sferic()
      .SunburstChart({ container, theme })
      .setTitle('World Population')
      .setValueFormatter(formatPopulation)
      .setData(worldPopulation)
    return () => chart.dispose()
  },
} satisfies Example
