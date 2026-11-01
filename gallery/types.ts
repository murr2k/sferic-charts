import type { Theme } from '../src'

/** A numeric setting an example exposes; hosts (gallery, website) render it as a slider. */
export interface ExampleParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  /** Default value. */
  value: number
  /** Text shown next to the slider, e.g. (v) => `${v} cm`. */
  format?: (v: number) => string
  /** Re-run the whole example when it changes (for settings fixed at build time). */
  restart?: boolean
}

export interface ExampleContext {
  container: HTMLElement
  theme: Theme
  /** Live values of the example's params, updated in place by the host's sliders. */
  params?: Record<string, number>
  /** Called after a param without `restart` changes, with its key. */
  onParamChange?: (fn: (key: string) => void) => void
}

export interface Example {
  title: string
  category: string
  description: string
  tags?: string[]
  order?: number
  params?: readonly ExampleParam[]
  /** Builds the example; returns a cleanup function. */
  run(ctx: ExampleContext): (() => void) | void
}

/** The live param values for one run: the host's object when it has sliders, else the defaults. */
export function paramsOf(defs: readonly ExampleParam[], ctx: ExampleContext): Record<string, number> {
  return ctx.params ?? Object.fromEntries(defs.map((d) => [d.key, d.value]))
}
