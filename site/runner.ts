import * as lib from 'sferic-charts'
import type { Theme } from 'sferic-charts'

/** Display text of a usage snippet: its value imports, then the `// #region` body, de-indented. */
export function extractSnippet(source: string): string {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  const imports = lines.filter((l) => /^import\s/.test(l) && !/^import type\s/.test(l))
  const a = lines.findIndex((l) => l.trim() === '// #region')
  const b = lines.findIndex((l) => l.trim() === '// #endregion')
  const body = a >= 0 && b > a ? lines.slice(a + 1, b) : lines
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length))
  return [...imports, '', ...body.map((l) => l.slice(indent))].join('\n').trim() + '\n'
}

const IDENT = /^[A-Za-z_$][\w$]*$/
const stripImports = (code: string) => code.replace(/^\s*import\s[^\n]*$/gm, '')

/** Throws a SyntaxError if the snippet does not parse (without running it). */
export function checkSyntax(code: string) {
  // eslint-disable-next-line no-new-func
  new Function(`"use strict";\n${stripImports(code)}`)
}

/**
 * Run snippet code with every library export, `container` and `theme` in scope. Charts
 * created through `sferic()` and timers or animation frames the code starts are tracked,
 * so the returned cleanup disposes everything even though the code never returns a
 * disposer. Imports are stripped: the names they bind are already in scope.
 */
export function runSnippet(code: string, container: HTMLElement, theme: Theme): () => void {
  const charts: { dispose(): unknown }[] = []
  const intervals = new Set<number>()
  const timeouts = new Set<number>()
  const frames = new Set<number>()
  const track = (v: unknown) => {
    if (v && typeof (v as { dispose?: unknown }).dispose === 'function') charts.push(v as { dispose(): unknown })
    return v
  }
  const factory = (o?: lib.SfericOptions) =>
    new Proxy(lib.sferic(o), {
      get(target, key, receiver) {
        const v = Reflect.get(target, key, receiver)
        return typeof v === 'function' ? (...a: unknown[]) => track(v.apply(target, a)) : v
      },
    })
  const scope: Record<string, unknown> = {
    ...lib,
    sferic: factory,
    container,
    theme,
    setInterval: (fn: TimerHandler, ms?: number, ...a: unknown[]) => {
      const id = window.setInterval(fn, ms, ...a)
      intervals.add(id)
      return id
    },
    clearInterval: (id: number) => {
      intervals.delete(id)
      window.clearInterval(id)
    },
    setTimeout: (fn: (...a: unknown[]) => void, ms?: number, ...a: unknown[]) => {
      const id = window.setTimeout(() => {
        timeouts.delete(id)
        fn(...a)
      }, ms)
      timeouts.add(id)
      return id
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id)
      window.clearTimeout(id)
    },
    requestAnimationFrame: (fn: FrameRequestCallback) => {
      const id = window.requestAnimationFrame((t) => {
        frames.delete(id)
        fn(t)
      })
      frames.add(id)
      return id
    },
    cancelAnimationFrame: (id: number) => {
      frames.delete(id)
      window.cancelAnimationFrame(id)
    },
  }
  const names = Object.keys(scope).filter((n) => IDENT.test(n))
  // eslint-disable-next-line no-new-func
  const fn = new Function(...names, `"use strict";\n${stripImports(code)}`)
  let done = false
  const cleanup = () => {
    if (done) return
    done = true
    intervals.forEach((id) => window.clearInterval(id))
    timeouts.forEach((id) => window.clearTimeout(id))
    frames.forEach((id) => window.cancelAnimationFrame(id))
    for (const c of charts.reverse()) {
      try {
        c.dispose()
      } catch (e) {
        console.error(e)
      }
    }
    container.replaceChildren()
  }
  try {
    fn(...names.map((n) => scope[n]))
  } catch (e) {
    cleanup()
    throw e
  }
  return cleanup
}
