import type { Theme } from '../src'

export interface ExampleContext {
  container: HTMLElement
  theme: Theme
}

export interface Example {
  title: string
  category: string
  description: string
  tags?: string[]
  order?: number
  /** Builds the example; returns a cleanup function. */
  run(ctx: ExampleContext): (() => void) | void
}
