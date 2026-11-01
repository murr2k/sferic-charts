import { sferic, AxisTickStrategies, SolidFill, ColorRGBA, emptyLine } from '../../src'
import type { Example } from '../types'

const CITIES: [string, number, number][] = [
  ['Vancouver', 49.28, -123.12],
  ['Reykjavík', 64.15, -21.94],
  ['Singapore', 1.35, 103.82],
  ['Tokyo', 35.68, 139.69],
  ['Cairo', 30.04, 31.24],
  ['Buenos Aires', -34.6, -58.38],
]
const REFRESH_MS = 15 * 60_000

interface Forecast {
  utc_offset_seconds: number
  hourly: { time: number[]; temperature_2m: number[]; apparent_temperature: number[]; precipitation: number[]; wind_speed_10m: number[]; wind_gusts_10m: number[] }
  daily: { sunrise: number[]; sunset: number[] }
}

const cache = new Map<string, { at: number; data: Forecast }>()

async function forecast(lat: number, lon: number): Promise<Forecast> {
  const key = `${lat},${lon}`
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < REFRESH_MS) return hit.data
  const q = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly: 'temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_gusts_10m',
    daily: 'sunrise,sunset',
    past_days: '2',
    forecast_days: '7',
    timezone: 'auto',
    timeformat: 'unixtime',
    wind_speed_unit: 'kmh',
  })
  const r = await fetch(`https://api.open-meteo.com/v1/forecast?${q}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  const data = (await r.json()) as Forecast
  cache.set(key, { at: Date.now(), data })
  return data
}

export default {
  title: 'Live Weather Forecast (Open-Meteo)',
  category: 'Live data',
  order: 2,
  tags: ['live data', 'date-time axis', 'stacked axes', 'bands', 'rectangles'],
  description:
    'Hourly temperature, precipitation and wind for the past two days and the coming week, fetched live from the Open-Meteo forecast API and refreshed every 15 minutes. Three stacked Y axes share one date-time X axis; nights are axis bands computed from sunrise and sunset, and a constant line marks the current time. Times are the city\'s local time. Weather data by Open-Meteo.com (CC BY 4.0).',
  run({ container, theme }) {
    const chart = sferic().ChartXY({ container, theme, legend: { position: 'right' } }).setTitle('Loading forecast…').setCursorMode('show-all')
    chart.axisX.setTickStrategy(AxisTickStrategies.DateTime)
    chart.axisY.dispose()
    const tempAxis = chart.addAxisY({ iStack: 2 }).setTitle('Temperature').setUnits('°C').setLength({ relative: 2.2 }).setMargins(8, 0)
    const rainAxis = chart.addAxisY({ iStack: 1 }).setTitle('Precip.').setUnits('mm/h').setLength({ relative: 1 }).setMargins(8, 8)
    const windAxis = chart.addAxisY({ iStack: 0 }).setTitle('Wind').setUnits('km/h').setLength({ relative: 1.3 }).setMargins(0, 8)

    const temp = chart.addLineSeries({ yAxis: tempAxis, automaticColorIndex: 1 }).setName('Temperature').setStrokeStyle((s) => s.setThickness(2.5))
    const feels = chart.addLineSeries({ yAxis: tempAxis, automaticColorIndex: 3 }).setName('Feels like').setStrokeStyle((s) => s.setThickness(1.2))
    const rain = chart.addRectangleSeries({ yAxis: rainAxis }).setName('Precipitation')
    const rainFill = new SolidFill({ color: theme.seriesColors[0].setA(theme.isDark ? 200 : 220) })
    const gusts = chart.addLineSeries({ yAxis: windAxis, automaticColorIndex: 6 }).setName('Gusts').setStrokeStyle((s) => s.setThickness(1.2))
    const wind = chart.addAreaSeries({ yAxis: windAxis, automaticColorIndex: 2, baseline: 0 }).setName('Wind speed')
    const now = chart.axisX.addConstantLine(true).setName('Now').setMouseInteractions(false)
    let nights: { dispose(): unknown }[] = []
    const nightFill = new SolidFill({ color: theme.isDark ? ColorRGBA(120, 140, 255, 16) : ColorRGBA(40, 60, 140, 18) })

    chart.addUIElement('text').setText('Weather data by Open-Meteo.com').setPosition({ x: 99, y: 1 }).setOrigin({ x: 1, y: -1 })
    let city = 0
    let disposed = false
    const button = chart.addUIElement('button').setText('City').setPosition({ x: 1, y: 99 }).setOrigin({ x: -1, y: 1 })

    const load = async () => {
      const [name, lat, lon] = CITIES[city]
      button.setText(`${name} ▸`)
      try {
        const f = await forecast(lat, lon)
        if (disposed || CITIES[city][0] !== name) return
        // Shift UTC instants so the axis (which formats in the viewer's zone) shows the city's wall-clock time.
        const shift = (t: number) => t * 1000 + f.utc_offset_seconds * 1000 + new Date(t * 1000).getTimezoneOffset() * 60000
        const h = f.hourly
        const xs = Float64Array.from(h.time, shift)
        temp.setSamples({ xValues: xs, yValues: h.temperature_2m })
        feels.setSamples({ xValues: xs, yValues: h.apparent_temperature })
        wind.setSamples({ xValues: xs, yValues: h.wind_speed_10m })
        gusts.setSamples({ xValues: xs, yValues: h.wind_gusts_10m })
        rain.clear()
        h.precipitation.forEach((p, i) => {
          if (p > 0) rain.add({ x1: xs[i] + 300_000, y1: 0, x2: xs[i] + 3_300_000, y2: p }).setFillStyle(rainFill)
        })
        nights.forEach((b) => b.dispose())
        nights = f.daily.sunset.map((set, i) => {
          const rise = f.daily.sunrise[i + 1] ?? set + 12 * 3600
          return chart.axisX.addBand().setName('Night').setValueStart(shift(set)).setValueEnd(shift(rise)).setFillStyle(nightFill).setStrokeStyle(emptyLine).setMouseInteractions(false)
        })
        now.setValue(shift(Date.now() / 1000))
        const lo = Math.min(...h.temperature_2m, ...h.apparent_temperature), hi = Math.max(...h.temperature_2m, ...h.apparent_temperature)
        tempAxis.setInterval({ start: Math.floor(lo - 2), end: Math.ceil(hi + 2), stopAxisAfter: true })
        rainAxis.setInterval({ start: 0, end: Math.max(2, Math.ceil(Math.max(...h.precipitation) * 1.15)), stopAxisAfter: true })
        windAxis.setInterval({ start: 0, end: Math.ceil(Math.max(...h.wind_gusts_10m) * 1.1), stopAxisAfter: true })
        chart.axisX.fit(false)
        const i = h.time.findIndex((t) => t * 1000 >= Date.now())
        const cur = i >= 0 ? `, now ${h.temperature_2m[i].toFixed(1)} °C` : ''
        chart.setTitle(`${name}: hourly forecast in local time${cur}`)
      } catch (e) {
        if (!disposed) chart.setTitle(`${name}: forecast unavailable (${(e as Error).message})`)
      }
    }
    button.addEventListener('click', () => {
      city = (city + 1) % CITIES.length
      load()
    })
    load()
    const timer = setInterval(load, REFRESH_MS)

    return () => {
      disposed = true
      clearInterval(timer)
      chart.dispose()
    }
  },
} satisfies Example
