import { sferic } from 'sferic-charts'
import type { Snippet } from './snippet'

export default {
  title: 'Polar chart',
  order: 6,
  summary: 'The radiation pattern of a four-element antenna array, |sin(Nψ/2) / (N sin(ψ/2))|, for three element spacings. Polar series take {angle, amplitude} points with angles in degrees.',
  run({ container, theme }) {
    // #region
    const chart = sferic().Polar({ container, theme }).setTitle('4-element array factor')
    chart.getAmplitudeAxis().setInterval({ start: 0, end: 1 })

    const N = 4
    for (const spacing of [0.25, 0.5, 0.75]) {
      const pattern = Array.from({ length: 721 }, (_, i) => {
        const angle = i / 2
        const psi = 2 * Math.PI * spacing * Math.cos((angle * Math.PI) / 180)
        const den = N * Math.sin(psi / 2)
        return { angle, amplitude: Math.abs(den) < 1e-9 ? 1 : Math.abs(Math.sin((N * psi) / 2) / den) }
      })
      chart.addLineSeries().setName(`d = ${spacing} λ`).setData(pattern)
    }
    // #endregion
  },
} satisfies Snippet
