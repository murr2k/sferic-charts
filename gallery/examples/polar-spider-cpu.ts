import { sferic, SpiderWebMode, SolidFill, emptyFill } from '../../src'
import type { Example } from '../types'

const PERIOD_MS = 1000
const PEAK_SAMPLES = 10
const SIM_CORES = 22

/** Cumulative [idle, busy] ms per logical processor, served by the dev server (vite.config.ts). */
type CpuTimes = [idle: number, busy: number][]

async function readTimes(signal: AbortSignal): Promise<CpuTimes | null> {
  try {
    const res = await fetch('/__cpu', { signal, cache: 'no-store' })
    const body = res.ok ? await res.json() : null
    return Array.isArray(body?.times) && body.times.length ? body.times : null
  } catch {
    return null
  }
}

/** Busy percentage per processor over the interval between two samples. */
const utilization = (a: CpuTimes, b: CpuTimes) =>
  b.map(([idle, busy], i) => {
    const di = idle - a[i][0]
    const db = busy - a[i][1]
    return di + db > 0 ? Math.min(100, (100 * db) / (di + db)) : 0
  })

/** Stand-in when the endpoint is missing (static gallery build): mean-reverting load with bursts. */
function simulator() {
  const base = Array.from({ length: SIM_CORES }, (_, i) => 6 + ((i * 29) % 31))
  const load = [...base]
  return () =>
    load.map((v, i) => {
      const burst = Math.random() < 0.05 ? 35 + Math.random() * 55 : 0
      load[i] = Math.max(0.5, Math.min(100, v + 0.35 * (base[i] - v) + (Math.random() - 0.5) * 12 + burst))
      return load[i]
    })
}

const axisName = (i: number) => `CPU ${i}`

export default {
  title: 'Spider Chart Live CPU Cores',
  category: 'Polar',
  order: 12,
  tags: ['spider', 'radar', 'real-time', 'live data'],
  description:
    'Live utilization of every logical processor on the machine running the dev server, one spoke per core, sampled once per second from the operating system. The outline holds each core\'s peak over the last 10 s. In the static gallery build, where the endpoint does not exist, the load is simulated.',
  run({ container, theme }) {
    const chart = sferic()
      .Spider({ container, theme })
      .setTitle('CPU Utilization per Logical Processor')
      .setWebMode(SpiderWebMode.Circle)
      .setWebCount(5)
      .setAxisInterval(100)
    chart.setScaleLabelStrategy((v) => `${Math.round(v)}%`)
    const current = chart.addSeries().setName('Utilization')
    // The peak envelope is a reference mark: thin, translucent, no glow, so the live series reads first.
    const peak = chart
      .addSeries()
      .setName(`Peak, last ${PEAK_SAMPLES} s`)
      .setFillStyle(emptyFill)
      .setPointFillStyle(emptyFill)
      .setEffect(false)
      .setStrokeStyle((l) => l.setThickness(1).setFillStyle(new SolidFill({ color: l.getFillStyle().getPrimaryColor().setA(170) })))

    const history: number[][] = []
    const show = (util: number[], simulated: boolean) => {
      history.push(util)
      if (history.length > PEAK_SAMPLES) history.shift()
      current.setPoints(util.map((value, i) => ({ axis: axisName(i), value })))
      peak.setPoints(util.map((_, i) => ({ axis: axisName(i), value: Math.max(...history.map((h) => h[i])) })))
      const avg = util.reduce((a, b) => a + b, 0) / util.length
      chart.setTitle(`${simulated ? 'Simulated ' : ''}CPU Utilization, ${util.length} Logical Processors (avg ${avg.toFixed(0)}%)`)
    }

    const ctrl = new AbortController()
    let timer = 0
    let prev: CpuTimes | null = null
    let sim: (() => number[]) | null = null
    const tick = async () => {
      if (!sim) {
        const t = await readTimes(ctrl.signal)
        if (ctrl.signal.aborted) return
        if (!t) sim = simulator()
        else {
          if (prev?.length === t.length) show(utilization(prev, t), false)
          else t.forEach((_, i) => chart.addAxis(axisName(i)))
          prev = t
        }
      }
      if (sim) show(sim(), true)
      // The first delta comes after half a period so the chart fills quickly.
      timer = window.setTimeout(tick, history.length ? PERIOD_MS : PERIOD_MS / 2)
    }
    tick()
    return () => {
      ctrl.abort()
      clearTimeout(timer)
      chart.dispose()
    }
  },
} satisfies Example
