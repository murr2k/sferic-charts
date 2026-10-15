import { sferic, DashedLine, SolidFill, StipplePatterns, ColorRGBA } from '../../src'
import { rng } from '../../src/xydata'
import type { Example } from '../types'

export default {
  title: 'Bands and Constant Lines',
  category: 'XY',
  order: 8,
  tags: ['bands', 'constant lines', 'thresholds', 'draggable'],
  description:
    'Threshold lines and highlighted bands attached to axes. Drag a constant line or a band edge with the mouse to move it; the title reports how many samples exceed the alarm limit.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme }).setTitle('Process value with alarm limits')
    const r = rng(17)
    let y = 50
    const data = Array.from({ length: 2000 }, (_, x) => ({ x, y: (y += (r() - 0.5) * 3 + (50 - y) * 0.01) }))
    chart.addLineSeries({ automaticColorIndex: 3 }).setName('Process value').appendJSON(data)
    chart.axisY.setTitle('Value')
    chart.axisX.setTitle('Sample')
    const warn = theme.examples.badGoodColorPalette[1]
    const alarm = theme.examples.badGoodColorPalette[0]
    const hi = chart.axisY
      .addConstantLine()
      .setName('High alarm')
      .setValue(68)
      .setStrokeStyle(new DashedLine({ thickness: 2, fillStyle: new SolidFill({ color: alarm }), pattern: StipplePatterns.Dashed }))
    chart.axisY
      .addConstantLine()
      .setName('Low warning')
      .setValue(34)
      .setStrokeStyle((l) => l.setFillStyle(new SolidFill({ color: warn })))
    chart.axisY
      .addBand()
      .setValueStart(45)
      .setValueEnd(55)
      .setName('Target')
      .setFillStyle(new SolidFill({ color: ColorRGBA(120, 220, 140, 28) }))
      .setStrokeStyle((l) => l.setFillStyle(new SolidFill({ color: ColorRGBA(120, 220, 140, 90) })))
    chart.axisX.addBand().setValueStart(800).setValueEnd(1100).setName('Maintenance window')
    const update = () => {
      const n = data.filter((p) => p.y > hi.getValue()).length
      chart.setTitle(`Process value with alarm limits: ${n} samples above ${hi.getValue().toFixed(1)}`)
    }
    hi.addEventListener('valuechange', update)
    update()
    return () => chart.dispose()
  },
} satisfies Example
