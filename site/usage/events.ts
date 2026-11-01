import { sferic } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Events and annotations',
  order: 8,
  summary: 'Axis markers are interactive: drag the limit line and its valuechange event recounts the samples above it; zooming fires intervalchange on the axis, which reports the visible range.',
  run({ container, theme }) {
    // #region
    const chart = sferic().ChartXY({ container, theme })
    let y = 50
    const data = Array.from({ length: 2000 }, (_, x) => ({ x, y: (y += (Math.random() - 0.5) * 2.5 + (50 - y) * 0.01) }))
    chart.addLineSeries().setName('Sensor').appendJSON(data)

    const limit = chart.axisY.addConstantLine().setName('Limit (drag me)').setValue(56)
    chart.axisY.addBand().setName('Target').setValueStart(46).setValueEnd(54)

    const update = () => {
      const { start, end } = chart.axisX.getInterval()
      const visible = data.filter((p) => p.x >= start && p.x <= end)
      const over = visible.filter((p) => p.y > limit.getValue()).length
      chart.setTitle(`${over} of ${visible.length} visible samples above ${limit.getValue().toFixed(1)}`)
    }
    limit.addEventListener('valuechange', update)
    chart.axisX.addEventListener('intervalchange', update)
    update()
    // #endregion
  },
} satisfies Snippet
