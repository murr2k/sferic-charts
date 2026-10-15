import type { Axis } from './Axis'
import type { ChartXY } from './ChartXY'

/** Keep the intervals of several axes identical. */
export function synchronizeAxisIntervals(...axes: Axis[]) {
  let busy = false
  const handlers = axes.map((src) => {
    const h = (ev: { start: number; end: number }) => {
      if (busy) return
      busy = true
      for (const a of axes) {
        if (a === src) continue
        a.stopped = src.stopped
        a.applyInterval(ev.start, ev.end)
      }
      busy = false
    }
    src.addEventListener('intervalchange', h)
    return h
  })
  return () => axes.forEach((a, i) => a.removeEventListener('intervalchange', handlers[i]))
}

/** Mirror the cursor X position between charts (each shows its own series values). */
export function synchronizeCursors(...charts: ChartXY[]) {
  const handlers = charts.map((src) => {
    const h = (ev: { x: number | null }) => {
      for (const c of charts) if (c !== src) c.showCursorAtX(ev.x)
    }
    src.addEventListener('cursorchange', h)
    return h
  })
  return () => charts.forEach((c, i) => c.removeEventListener('cursorchange', handlers[i]))
}
