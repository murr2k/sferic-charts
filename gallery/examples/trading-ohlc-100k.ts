import { sferic, AxisTickStrategies, UIOrigins } from '../../src'
import { OHLCFigures, XOHLC } from '../../src/xy/series/OHLCSeries'
import { gauss, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: '100 000 OHLC Candles',
  category: 'XY',
  order: 32,
  tags: ['ohlc', 'candlestick', 'bars', 'performance', 'zoom band'],
  description:
    'One hundred thousand one-minute candles in a single OHLC series (chunked GPU instances, culled per chunk, rebuilt only when data changes). Zoom out with the wheel or the band to see all of them; the button switches between candlestick and OHLC bar figures.',
  run({ container, theme }) {
    const N = 100_000
    const r = rng(21)
    const t0 = Date.UTC(2025, 0, 6, 9, 30)
    const data: XOHLC[] = new Array(N)
    let p = 250
    for (let i = 0; i < N; i++) {
      const o = p
      const c = o * Math.exp(gauss(r) * 0.0011 + (Math.log(250) - Math.log(o)) * 0.0004)
      const h = Math.max(o, c) * (1 + Math.abs(gauss(r)) * 0.0005)
      const l = Math.min(o, c) * (1 - Math.abs(gauss(r)) * 0.0005)
      data[i] = [t0 + i * 60_000, o, h, l, c]
      p = c
    }

    const db = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    db.setRowHeight(0, 4).setRowHeight(1, 1)
    const chart = db.createChartXY({ columnIndex: 0, rowIndex: 0, legend: { visible: false } })
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    chart.axisY.setTitle('Price').setUnits('USD')
    const t = performance.now()
    const ohlc = chart.addOHLCSeries().setName('SFRC 1m').add(data)
    chart.setTitle(`100 000 one-minute candles (series built in ${(performance.now() - t).toFixed(1)} ms)`)

    chart.axisX.addEventListener('intervalchange', ({ start, end }: { start: number; end: number }) => {
      const b = ohlc.yBoundsInX(Math.min(start, end), Math.max(start, end))
      if (!b) return
      const pad = (b.ymax - b.ymin) * 0.06 || 1
      chart.axisY.setInterval({ start: b.ymin - pad, end: b.ymax + pad, stopAxisAfter: true })
    })
    db.createZoomBandChart({ columnIndex: 0, rowIndex: 1, axis: chart.axisX })
    chart.axisX.setInterval({ start: data[N - 300][0], end: data[N - 1][0] + 60_000, stopAxisAfter: true })

    let bars = false
    const btn = chart.addUIElement('button').setText('Show OHLC bars').setPosition({ x: 1, y: 99 }).setOrigin(UIOrigins.LeftTop)
    btn.addEventListener('click', () => {
      bars = !bars
      ohlc.setFigure(bars ? OHLCFigures.Bar : OHLCFigures.Candlestick)
      btn.setText(bars ? 'Show candlesticks' : 'Show OHLC bars')
    })
    return () => db.dispose()
  },
} satisfies Example
