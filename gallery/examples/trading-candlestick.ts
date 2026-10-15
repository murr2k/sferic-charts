import { sferic, AxisTickStrategies, SolidFill } from '../../src'
import { createOHLCGenerator, rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Candlestick Trading Chart',
  category: 'XY',
  order: 30,
  tags: ['ohlc', 'candlestick', 'volume', 'zoom band', 'trading', 'stacked axes'],
  description:
    'Daily candlesticks with 20 and 50 day moving averages above a volume histogram on a stacked Y axis, plus a zoom band chart. The price and volume axes fit to the visible candles. Drag or resize the band (or drag in the overview) to navigate; hover a candle for OHLC values.',
  run({ container, theme }) {
    const db = sferic().Dashboard({ container, theme, numberOfColumns: 1, numberOfRows: 2 })
    db.setRowHeight(0, 4.2).setRowHeight(1, 1)
    const chart = db.createChartXY({ columnIndex: 0, rowIndex: 0 }).setTitle('SFRC / USD, daily')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    const volAxis = chart.axisY
      .setTitle('Volume')
      .setLength({ relative: 1 })
      .setMargins(0, 12)
      .setTickStrategy(AxisTickStrategies.Numeric, (s) => s.setFormattingFunction((v) => (v === 0 ? '0' : `${(v / 1e6).toFixed(1)}M`)))
    const priceAxis = chart.addAxisY({ iStack: 1 }).setTitle('Price').setUnits('USD').setLength({ relative: 3.2 }).setMargins(12, 0)

    const data = createOHLCGenerator().setNumberOfPoints(720).setStart(100).setSeed(4).generate().get()
    const DAY = 24 * 3600 * 1000
    const ohlc = chart.addOHLCSeries({ yAxis: priceAxis }).setName('SFRC').add(data)

    const sma = (n: number) =>
      data.slice(n - 1).map((_, i) => ({ x: data[i + n - 1][0], y: data.slice(i, i + n).reduce((a, d) => a + d[4], 0) / n }))
    chart.addLineSeries({ yAxis: priceAxis, automaticColorIndex: 0 }).setName('SMA 20').appendJSON(sma(20))
    chart.addLineSeries({ yAxis: priceAxis, automaticColorIndex: 5 }).setName('SMA 50').appendJSON(sma(50))

    const t = chart.getTheme()
    const pal = t.examples.badGoodColorPalette
    const up = pal[pal.length - 1], down = pal[0]
    const r = rng(9)
    const vol = chart.addRectangleSeries({ yAxis: volAxis }).setName('Volume')
    const volumes = data.map(([, o, , , c]) => (0.6 + r() * 0.8) * 1.4e6 * (1 + (Math.abs(c - o) / o) * 40))
    data.forEach(([x, o, , , c], i) => {
      vol.add({ x1: x - DAY * 0.36, y1: 0, x2: x + DAY * 0.36, y2: volumes[i] }).setFillStyle(new SolidFill({ color: (c >= o ? up : down).setA(t.isDark ? 150 : 170) }))
    })

    // Fit price and volume axes to what is visible on X.
    chart.axisX.addEventListener('intervalchange', ({ start, end }: { start: number; end: number }) => {
      const b = ohlc.yBoundsInX(Math.min(start, end), Math.max(start, end))
      if (b) {
        const pad = (b.ymax - b.ymin) * 0.06 || 1
        priceAxis.setInterval({ start: b.ymin - pad, end: b.ymax + pad, stopAxisAfter: true })
      }
      let vmax = 0
      data.forEach(([x], i) => { if (x >= start && x <= end && volumes[i] > vmax) vmax = volumes[i] })
      if (vmax > 0) volAxis.setInterval({ start: 0, end: vmax * 1.1, stopAxisAfter: true })
    })

    const zbc = db.createZoomBandChart({ columnIndex: 0, rowIndex: 1, axis: chart.axisX })
    zbc.add(ohlc)
    const n = data.length
    chart.axisX.setInterval({ start: data[n - 140][0] - DAY, end: data[n - 1][0] + DAY, stopAxisAfter: true })
    return () => db.dispose()
  },
} satisfies Example
