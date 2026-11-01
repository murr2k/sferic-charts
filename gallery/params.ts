import type { ExampleContext, ExampleParam } from './types'

const decimals = (step: number) => Math.max(0, -Math.floor(Math.log10(step) + 1e-9))

/**
 * Host side of an example's params (gallery and website): owns the live values, which
 * persist across re-runs, and renders them as sliders. Params without `restart` notify
 * the running example through onParamChange; the others re-run it after a short pause.
 */
export class ParamPanel {
  readonly values: Record<string, number>
  private listeners: ((key: string) => void)[] = []
  private timer = 0
  private inputs = new Map<string, { input: HTMLInputElement; out: HTMLOutputElement }>()

  constructor(
    readonly defs: readonly ExampleParam[],
    private readonly restart: () => void,
  ) {
    this.values = Object.fromEntries(defs.map((d) => [d.key, d.value]))
  }

  /** Context fields for one run of the example; listeners of earlier runs are dropped. */
  context(): Pick<ExampleContext, 'params' | 'onParamChange'> {
    this.listeners = []
    return { params: this.values, onParamChange: (fn) => void this.listeners.push(fn) }
  }

  private text(d: ExampleParam, v: number) {
    return d.format ? d.format(v) : v.toFixed(decimals(d.step))
  }

  private changed(d: ExampleParam) {
    if (d.restart) {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(this.restart, 250)
    } else {
      for (const fn of this.listeners) fn(d.key)
    }
  }

  render(): HTMLElement {
    const root = document.createElement('div')
    root.className = 'params'
    this.inputs.clear()
    for (const d of this.defs) {
      const label = document.createElement('label')
      label.className = 'param'
      const name = document.createElement('span')
      name.className = 'param-name'
      name.textContent = d.label
      const input = document.createElement('input')
      input.type = 'range'
      input.min = String(d.min)
      input.max = String(d.max)
      input.step = String(d.step)
      input.value = String(this.values[d.key])
      const out = document.createElement('output')
      out.textContent = this.text(d, this.values[d.key])
      input.addEventListener('input', () => {
        const v = Number(input.value)
        this.values[d.key] = v
        out.textContent = this.text(d, v)
        this.changed(d)
      })
      label.append(name, input, out)
      root.append(label)
      this.inputs.set(d.key, { input, out })
    }
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'param-reset'
    reset.textContent = 'Defaults'
    reset.addEventListener('click', () => {
      let restart = false
      for (const d of this.defs) {
        if (this.values[d.key] === d.value) continue
        this.values[d.key] = d.value
        const ui = this.inputs.get(d.key)
        if (ui) {
          ui.input.value = String(d.value)
          ui.out.textContent = this.text(d, d.value)
        }
        if (d.restart) restart = true
        else for (const fn of this.listeners) fn(d.key)
      }
      if (restart) this.restart()
    })
    root.append(reset)
    return root
  }
}
