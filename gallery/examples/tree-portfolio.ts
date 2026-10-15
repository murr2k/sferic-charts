import { sferic, LUT, ColorHEX } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Stock Market TreeMap',
  category: 'Hierarchy',
  order: 1,
  tags: ['treemap', 'lut', 'drill-down', 'finance'],
  description:
    'Market capitalisation of a fictional stock index by sector and company, tiles sized by cap and colored by the daily change through a LUT. Click a sector to drill down, use the path buttons (or right-click) to go back. Hover for details.',
  run({ container, theme }) {
    // Fictional companies; caps and daily changes are synthetic.
    const sectors: Record<string, [string, number][]> = {
      Technology: [['Novacore', 3400], ['Brightlane', 3100], ['Krellis Semi', 2900], ['Tessarine', 780], ['Orvane Data', 420], ['Pixelmoor', 230], ['Quillon Cloud', 280], ['Halvex Micro', 260], ['Corvin Silicon', 120], ['Netwyre', 210], ['Sonavi', 190], ['Teralux Instr.', 170]],
      Communication: [['Glimmr', 2100], ['Chatterbox', 1400], ['Reelhouse', 300], ['Storybrook', 170], ['Cablewave', 150], ['Signalis', 170], ['Teletide', 160]],
      'Consumer Cyclical': [['Parcelia', 1900], ['Voltaic Motors', 800], ['Homestead Supply', 380], ['Burgerly', 210], ['Stridewell', 120], ['Bean & Ember', 100], ['Wanderbook', 160]],
      Financial: [['Granite Holdings', 960], ['Ledgerton Bank', 620], ['Paywise', 560], ['Cardella', 470], ['Harborline Bank', 320], ['Westvale Financial', 230], ['Ashgrove Capital', 170], ['Pemberton & Co', 190]],
      Healthcare: [['Lilacure', 760], ['Mendwell Health', 520], ['Solace Pharma', 380], ['Abrivo', 320], ['Merrow Bio', 260], ['Pellucid Rx', 160], ['Corvia Medical', 200], ['Amberline Bio', 160]],
      'Consumer Defensive': [['Grocera', 700], ['Bulkhaven', 400], ['Homecraft Goods', 390], ['Fizzland', 280], ['Crunchly', 210], ['Leaf & Ash', 190]],
      Energy: [['Basin Petroleum', 480], ['Ridgeway Oil', 270], ['Northfield Energy', 120], ['Drillcraft', 60]],
      Industrials: [['Aerona', 200], ['Earthmover Co', 180], ['Iron Rail', 140], ['Hollis Controls', 140], ['Skylift Aircraft', 110], ['Bastion Defense', 120]],
      Utilities: [['Gridline Power', 150], ['Southwind Utilities', 95], ['Lakeshore Electric', 85]],
      'Real Estate': [['Depotline REIT', 100], ['Towerpoint', 90], ['Datavault REIT', 85]],
    }
    const r = rng(42)
    const data = Object.entries(sectors).map(([name, cos]) => {
      const bias = (r() - 0.45) * 2
      return { name, children: cos.map(([n, cap]) => ({ name: n, value: cap, change: Math.max(-4.8, Math.min(4.8, bias + (r() - 0.5) * 5)) })) }
    })

    const c = theme.isDark ? ['#e5383b', '#7a2224', '#2a2a2a', '#1d6b3a', '#2fd06a'] : ['#c62828', '#ef9a9a', '#eceff1', '#a5d6a7', '#2e7d32']
    const lut = new LUT({
      interpolate: true,
      units: '%',
      steps: [-5, -2, 0, 2, 5].map((value, i) => ({ value, color: ColorHEX(c[i]), label: `${value > 0 ? '+' : ''}${value}%` })),
    })

    const chart = sferic()
      .TreeMapChart({ container, theme })
      .setTitle('Meridian Index by Sector (fictional companies, market cap $B) - daily change')
      .setInitialPathButtonText('Meridian Index')
      .setDisplayLevelCount(2)
      .setNodeColoring({ lut, lookUpProperty: 'change' }, { legendName: 'Daily change' })
      .setValueFormatter((v) => `$${v >= 1000 ? (v / 1000).toFixed(2) + 'T' : Math.round(v) + 'B'}`)
      .setLabelFormatter((node) => `${node.colorValue >= 0 ? '+' : ''}${node.colorValue.toFixed(2)} %`)
      .setData(data)
    return () => chart.dispose()
  },
} satisfies Example
