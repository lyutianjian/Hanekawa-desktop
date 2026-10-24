/**
 * Shell syntax colouring. Shiki's synchronous core with the JavaScript regex
 * engine tokenises on the render path itself — no wasm, no worker — so a command
 * is coloured in its first frame. The theme's colours are `var(--syntax-*)`
 * strings mapped back to kinds here, so every colour lives in the style sheet and
 * a theme switch recolours drawn nodes. Tokenising is capped and cached because
 * tool rows and streaming Markdown rebuild their nodes on every repaint.
 */
import { createHighlighterCoreSync, type HighlighterCore, type ThemeRegistration } from '@shikijs/core'
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript'
import shellscript from '@shikijs/langs/shellscript'

export const SYNTAX_KINDS = ['comment', 'punctuation', 'keyword', 'string', 'regex', 'number', 'property', 'attr', 'function', 'variable', 'parameter'] as const
export type SyntaxKind = (typeof SYNTAX_KINDS)[number]
export interface SyntaxRun { readonly text: string; readonly kind?: SyntaxKind }

const SHELL_LANGS = ['bash', 'sh', 'shell', 'zsh', 'shellscript']
const MAX_CHARS = 20_000
// The regex engine is quadratic on a long unbroken word (20k chars: ~1s); longer lines stay plain.
const MAX_LINE_CHARS = 1_000
const CACHE_LIMIT = 256

const v = (kind: SyntaxKind | 'plain'): string => `var(--syntax-${kind})`

const THEME: ThemeRegistration = {
  name: 'hanekawa-syntax',
  type: 'dark',
  fg: v('plain'),
  bg: 'transparent',
  settings: [
    { settings: { foreground: v('plain') } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: v('comment') } },
    { scope: ['punctuation', 'meta.brace', 'entity.name.namespace'], settings: { foreground: v('punctuation') } },
    { scope: ['keyword', 'storage', 'variable.language'], settings: { foreground: v('keyword') } },
    { scope: ['keyword.operator'], settings: { foreground: v('plain') } },
    { scope: ['keyword.operator.expression', 'keyword.operator.new', 'keyword.operator.word'], settings: { foreground: v('keyword') } },
    { scope: ['string', 'punctuation.definition.string'], settings: { foreground: v('string') } },
    { scope: ['string.regexp'], settings: { foreground: v('regex') } },
    { scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other.symbol'], settings: { foreground: v('number') } },
    { scope: ['entity.name.tag', 'support.type.property-name', 'meta.object-literal.key'], settings: { foreground: v('property') } },
    { scope: ['entity.other.attribute-name'], settings: { foreground: v('attr') } },
    { scope: ['entity.name.function', 'support.function'], settings: { foreground: v('function') } },
    { scope: ['entity.name.command'], settings: { foreground: v('function') } },
    { scope: ['variable.parameter'], settings: { foreground: v('parameter') } },
    { scope: ['constant.other.option'], settings: { foreground: v('parameter') } },
    { scope: ['variable.other.normal', 'punctuation.definition.variable'], settings: { foreground: v('variable') } },
    { scope: ['entity.name.type', 'entity.name.class', 'entity.other.inherited-class', 'support.class', 'support.type'], settings: { foreground: v('variable') } },
  ],
}

let highlighter: HighlighterCore | undefined
function shell(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({ themes: [THEME], langs: [shellscript], engine: createJavaScriptRegexEngine() })
  return highlighter
}

const cache = new Map<string, readonly SyntaxRun[]>()

export function isShellLang(lang: string | undefined): boolean {
  return lang !== undefined && SHELL_LANGS.includes(lang.toLowerCase())
}

function kindOf(color: string | undefined): SyntaxKind | undefined {
  const name = color?.match(/^var\(--syntax-([a-z]+)\)$/)?.[1]
  return SYNTAX_KINDS.find((kind) => kind === name)
}

/** Runs whose texts join back to `code`; `undefined` when it cannot be highlighted. */
export function highlightShell(code: string): readonly SyntaxRun[] | undefined {
  if (code.length > MAX_CHARS) return undefined
  const cached = cache.get(code)
  if (cached !== undefined) {
    cache.delete(code)
    cache.set(code, cached)
    return cached
  }
  let lines
  try {
    lines = shell().codeToTokensBase(code, { lang: 'bash', theme: 'hanekawa-syntax', tokenizeMaxLineLength: MAX_LINE_CHARS })
  } catch {
    return undefined
  }
  const runs: { text: string; kind?: SyntaxKind }[] = []
  const push = (text: string, kind: SyntaxKind | undefined): void => {
    const last = runs.at(-1)
    if (last !== undefined && last.kind === kind) last.text += text
    else runs.push(kind === undefined ? { text } : { text, kind })
  }
  lines.forEach((line, index) => {
    if (index > 0) push('\n', undefined)
    for (const token of line) push(token.content, kindOf(token.color))
  })
  if (runs.map((run) => run.text).join('') !== code) return undefined
  cache.set(code, runs)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  return runs
}
