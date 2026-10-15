import { sferic, ColorHEX, type CellContent } from '../../src'
import { rng, gauss } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Live Prices Data Grid',
  category: 'Other',
  order: 20,
  tags: ['datagrid', 'real-time', 'sparkline', 'table'],
  description:
    'A live price table. Prices update several times per second; changed cells flash green or red, the 7-day trend is a GPU sparkline with glow and the volume column is a bar-in-cell.',
  run({ container, theme }) {
    const r = rng(7)
    const coins: [string, string, number, number][] = [
      // Fictional tokens; prices and supplies are synthetic.
      ['Aurum', 'AUR', 67250, 19.7], ['Nexa', 'NXA', 3480, 120], ['Steady Dollar', 'SDL', 1.0, 110000], ['Orbit', 'ORB', 585, 146],
      ['Helion', 'HLN', 152, 462], ['Quark', 'QRK', 0.52, 55000], ['Pegged Unit', 'PGU', 1.0, 33000], ['Cobalt', 'CBT', 0.45, 35000],
      ['Pupcoin', 'PUP', 0.15, 145000], ['Avalon', 'AVL', 34.2, 393], ['Voltra', 'VLT', 0.12, 87000], ['Polyhedra', 'PHD', 6.9, 1430],
      ['Linkwell', 'LWL', 14.8, 587], ['Prism', 'PRZ', 0.71, 9900], ['Tundra', 'TND', 7.1, 3470], ['Lumicoin', 'LMC', 82.4, 74.5],
      ['Kittycoin', 'KTY', 0.000024, 589e9], ['Unifold', 'UFD', 9.8, 600], ['Starling', 'STL', 0.11, 29000], ['Cosmo', 'CSM', 8.6, 390],
      ['Shade', 'SHD', 128, 18.4], ['Archive', 'ARV', 5.9, 560], ['Apex', 'APX', 8.7, 460], ['Nearfield', 'NRF', 6.2, 1070],
    ]
    const up = theme.isDark ? ColorHEX('#3ddc84') : ColorHEX('#1b8a4a')
    const down = theme.isDark ? ColorHEX('#ff5c5c') : ColorHEX('#c62828')
    const fmtPrice = (p: number) => (p >= 1000 ? `$${p.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}` : p >= 1 ? `$${p.toFixed(2)}` : `$${p.toPrecision(4)}`)
    const fmtBig = (v: number) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : `$${(v / 1e6).toFixed(1)}M`)

    const state = coins.map(([name, sym, price, supplyM]) => {
      const vol = sym === 'SDL' || sym === 'PGU' ? 0.0004 : 0.012
      const hist: number[] = []
      let p = price * (1 + gauss(r) * vol * 6)
      for (let i = 0; i < 48; i++) {
        p *= 1 + gauss(r) * vol + (price - p) / price / 30
        hist.push(p)
      }
      return { name, sym, price: hist[hist.length - 1], open: hist[0], hist, supply: supplyM * 1e6, vol: 0.2 + r() * 0.8, sigma: vol / 3 }
    })

    const grid = sferic().DataGrid({ container, theme }).setTitle('Token Prices (fictional, simulated)')
    const COLS = ['#', 'Coin', 'Price', '24h %', '7d trend', 'Volume (24h)', 'Market cap']
    const rowOf = (s: (typeof state)[number], i: number): CellContent[] => {
      const ch = (s.price / s.open - 1) * 100
      return [
        i + 1,
        { text: `${s.name}  ${s.sym}`, align: 'left' },
        { value: s.price, text: fmtPrice(s.price) },
        { value: ch, text: `${ch >= 0 ? '+' : ''}${ch.toFixed(2)} %`, textColor: ch >= 0 ? up : down },
        { sparkline: s.hist.slice(-36), sparklineColor: ch >= 0 ? up : down },
        { bar: s.vol * 100, text: fmtBig(s.vol * s.price * s.supply * 0.06), barColor: theme.seriesColors[3] },
        { value: s.price * s.supply, text: fmtBig(s.price * s.supply) },
      ]
    }
    grid.setTableContent([COLS, ...state.map(rowOf)])
    grid.setColumnWidth(0, 44).setColumnWidth(4, { min: 140 }).setColumnWidth(5, { min: 150 })
    grid.setCellChangeHighlight(true, 800)

    const timer = setInterval(() => {
      for (let k = 0; k < 6; k++) {
        const i = Math.floor(r() * state.length)
        const s = state[i]
        s.price *= 1 + gauss(r) * s.sigma
        s.hist.push(s.price)
        if (s.hist.length > 120) s.hist.shift()
        s.vol = Math.max(0.05, Math.min(1, s.vol + gauss(r) * 0.04))
        const row = rowOf(s, i)
        // Numeric cells (price, change, market cap) flash green or red when their value changes.
        row.forEach((cell, col) => col > 0 && grid.setCellContent(col, i + 1, cell))
      }
    }, 300)
    return () => {
      clearInterval(timer)
      grid.dispose()
    }
  },
} satisfies Example
