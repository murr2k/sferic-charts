import type { Theme } from 'sferic-charts'

/**
 * A website usage example. The code between `// #region` and `// #endregion` is what the
 * page shows, lets the reader edit and runs (as plain JavaScript, with `container` and
 * `theme` in scope), so it must not use TypeScript-only syntax. `run` exists so that
 * `npm run typecheck` checks the same code against the library's types.
 */
export interface Snippet {
  title: string
  summary: string
  order: number
  run(ctx: { container: HTMLElement; theme: Theme }): void
}
