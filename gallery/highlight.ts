/** Minimal TypeScript syntax highlighter for example sources (gallery and website). */
export function highlight(src: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|('(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`)|\b(\d[\d_]*\.?\d*(?:e[+-]?\d+)?)\b|\b(const|let|var|function|return|if|else|for|while|of|in|new|import|from|export|default|async|await|true|false|null|undefined|type|interface|as|satisfies|class|extends)\b|\b([A-Za-z_$][\w$]*)(?=\()/g
  let out = ''
  let last = 0
  for (const m of src.matchAll(re)) {
    out += esc(src.slice(last, m.index))
    const cls = m[1] ? 'c' : m[2] ? 's' : m[3] ? 'n' : m[4] ? 'k' : 'f'
    out += `<span class="tk-${cls}">${esc(m[0])}</span>`
    last = m.index! + m[0].length
  }
  return out + esc(src.slice(last))
}
