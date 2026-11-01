import { sferic, AxisTickStrategies, AxisScrollStrategies, debug } from '../../src'
import type { Example } from '../types'

const WINDOW_MS = 30_000
const LAG_PERIOD_MS = 50

export default {
  title: 'This Page, Live',
  category: 'Live data',
  order: 4,
  tags: ['live data', 'real-time', 'stacked axes', 'performance', 'telemetry'],
  description:
    'Telemetry from the page you are looking at: the interval between animation frames, the CPU time Sferic spends per rendered frame (from debug.onFrame), event-loop lag (how late a 50 ms timer fires) and how fast you move the pointer. Four stacked Y axes scroll over a shared 30 s time axis. Press the button to block the main thread for 150 ms and watch the spike travel through every channel.',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { visible: false } }).setTitle('This page').setCursorMode('show-all')
    chart.axisX
      .setTickStrategy(AxisTickStrategies.Time)
      .setScrollStrategy(AxisScrollStrategies.scrolling)
      .setDefaultInterval((s) => {
        const end = Math.max(s.dataMax ?? 0, WINDOW_MS)
        return { end, start: end - WINDOW_MS, stopAxisAfter: false }
      })
    chart.axisY.dispose()
    const channels = [
      { name: 'Frame interval', units: 'ms', max: 40 },
      { name: 'Render cost', units: 'ms', max: 8 },
      { name: 'Event-loop lag', units: 'ms', max: 40 },
      { name: 'Pointer speed', units: 'px/s', max: 3000 },
    ]
    const series = channels.map((c, i) => {
      const axis = chart
        .addAxisY({ iStack: channels.length - 1 - i })
        .setTitle(c.name)
        .setUnits(c.units)
        .setMargins(i === channels.length - 1 ? 0 : 6, i === 0 ? 0 : 6)
        .setInterval({ start: 0, end: c.max, stopAxisAfter: false })
      const s = i === 1
        ? chart.addPointLineSeries({ yAxis: axis, automaticColorIndex: i }).setPointSize(3)
        : chart.addLineSeries({ yAxis: axis, automaticColorIndex: i })
      return s.setName(c.name).setMaxSampleCount(20_000)
    })
    const [frameS, renderS, lagS, pointerS] = series

    const t0 = performance.now()
    const at = (t = performance.now()) => t - t0

    // Render cost: chain onto any hook already installed and restore it afterwards.
    const prev = debug.onFrame
    const costs: number[] = []
    const hook = (ms: number, surfaces: number) => {
      prev?.(ms, surfaces)
      costs.push(ms)
      renderS.appendSample({ x: at(), y: ms })
    }
    debug.onFrame = hook

    let lastTick = performance.now()
    const lag = setInterval(() => {
      const now = performance.now()
      lagS.appendSample({ x: at(now), y: Math.max(0, now - lastTick - LAG_PERIOD_MS) })
      lastTick = now
    }, LAG_PERIOD_MS)

    let travelled = 0
    let lastPointer: { x: number; y: number } | null = null
    const onMove = (e: PointerEvent) => {
      if (lastPointer) travelled += Math.hypot(e.clientX - lastPointer.x, e.clientY - lastPointer.y)
      lastPointer = { x: e.clientX, y: e.clientY }
    }
    window.addEventListener('pointermove', onMove, { passive: true })

    chart
      .addUIElement('button')
      .setText('Block 150 ms')
      .setPosition({ x: 99, y: 99 })
      .setOrigin({ x: 1, y: 1 })
      .addEventListener('click', () => {
        const until = performance.now() + 150
        while (performance.now() < until) { /* deliberately busy */ }
      })

    let raf = 0
    let last = performance.now()
    let frames = 0
    let lastTitle = last
    const tick = (now: number) => {
      const dt = now - last
      last = now
      frames++
      frameS.appendSample({ x: at(now), y: dt })
      pointerS.appendSample({ x: at(now), y: dt > 0 ? (travelled / dt) * 1000 : 0 })
      travelled = 0
      if (now - lastTitle >= 1000) {
        const fps = (frames * 1000) / (now - lastTitle)
        const sorted = costs.splice(0).sort((a, b) => a - b)
        const med = sorted.length ? sorted[sorted.length >> 1] : 0
        chart.setTitle(`${fps.toFixed(0)} fps, ${med.toFixed(2)} ms render (median)`)
        frames = 0
        lastTitle = now
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(raf)
      clearInterval(lag)
      window.removeEventListener('pointermove', onMove)
      if (debug.onFrame === hook) debug.onFrame = prev
      chart.dispose()
    }
  },
} satisfies Example
