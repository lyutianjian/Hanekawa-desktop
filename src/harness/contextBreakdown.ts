import { countTextTokens } from '../prompts/budget.js'
import { getCachedToolSchema } from './toolApiSchema.js'
import type { Tool } from './types.js'

export type ContextCategoryKey = 'system' | 'tools' | 'mcpTools' | 'skills' | 'memory' | 'messages'

/** What occupies the context, by source. Plain data: it crosses the wire as is. */
export interface ContextBreakdown {
  /** The same figure the context ring shows. */
  readonly usedTokens: number
  /** No provider count backs `usedTokens` yet: every figure is an estimate. */
  readonly estimated: boolean
  /** Sums to `usedTokens`. */
  readonly categories: readonly { readonly key: ContextCategoryKey; readonly tokens: number }[]
  /** Tools announced by name only; their schemas are not in the context. */
  readonly deferred: readonly { readonly key: 'tools' | 'mcpTools'; readonly tokens: number }[]
  readonly mcpTools: readonly { readonly name: string; readonly tokens: number; readonly deferred: boolean }[]
  readonly memoryFiles: readonly { readonly path: string; readonly tokens: number }[]
}

/** The fixed parts of a request, as the loop would build it now. */
export interface ContextSources {
  readonly system: string
  /** The `# Available skills` part of `system`. */
  readonly skillsSection?: string
  readonly loadedTools: readonly Tool[]
  readonly deferredTools: readonly Tool[]
  /** The opening reminder: instruction files and the memory index. */
  readonly instructions?: string
}

/**
 * Splits `usedTokens` across the sources. Each fixed part is a character
 * estimate and the conversation is what remains; the estimator reads high, so
 * when the fixed parts alone exceed the total every figure is scaled down by
 * the same factor rather than leaving the messages negative.
 */
export function breakDownContext(sources: ContextSources, usedTokens: number, estimated: boolean): ContextBreakdown {
  const toolTokens = (tool: Tool) => countTextTokens(JSON.stringify(getCachedToolSchema(tool)))
  const sum = (tools: readonly Tool[]) => tools.reduce((total, tool) => total + toolTokens(tool), 0)
  const loadedMcp = sources.loadedTools.filter((tool) => tool.isMcp)
  const loadedBuiltin = sources.loadedTools.filter((tool) => !tool.isMcp)
  const deferredMcp = sources.deferredTools.filter((tool) => tool.isMcp)
  const deferredBuiltin = sources.deferredTools.filter((tool) => !tool.isMcp)

  const skills = countTextTokens(sources.skillsSection ?? '')
  const fixed = {
    system: Math.max(0, countTextTokens(sources.system) - skills),
    tools: sum(loadedBuiltin),
    mcpTools: sum(loadedMcp),
    skills,
    memory: countTextTokens(sources.instructions ?? ''),
  }
  const fixedTotal = Object.values(fixed).reduce((a, b) => a + b, 0)
  const factor = fixedTotal > usedTokens && fixedTotal > 0 ? usedTokens / fixedTotal : 1
  const scale = (tokens: number) => Math.round(tokens * factor)

  const categories = (Object.keys(fixed) as (keyof typeof fixed)[]).map((key) => ({ key, tokens: scale(fixed[key]) }))
  const messages = Math.max(0, usedTokens - categories.reduce((total, row) => total + row.tokens, 0))

  return {
    usedTokens,
    estimated,
    categories: [...categories, { key: 'messages', tokens: messages }],
    deferred: [
      { key: 'mcpTools' as const, tokens: scale(sum(deferredMcp)) },
      { key: 'tools' as const, tokens: scale(sum(deferredBuiltin)) },
    ].filter((row) => row.tokens > 0),
    mcpTools: [
      ...loadedMcp.map((tool) => ({ name: tool.name, tokens: scale(toolTokens(tool)), deferred: false })),
      ...deferredMcp.map((tool) => ({ name: tool.name, tokens: scale(toolTokens(tool)), deferred: true })),
    ],
    memoryFiles: splitInstructionFiles(sources.instructions ?? '').map((file) => ({
      path: file.path,
      tokens: scale(countTextTokens(file.text)),
    })),
  }
}

/**
 * The files inside the opening reminder, by the `Contents of <path> (<what>):`
 * header that `composeProjectContext` and `buildMemoryIndexContext` put on each.
 */
export function splitInstructionFiles(instructions: string): { path: string; text: string }[] {
  const headers = [...instructions.matchAll(/^Contents of (.+?) \([^\n]*\):$/gm)]
  return headers.map((match, index) => ({
    path: match[1]!,
    text: instructions.slice(match.index, headers[index + 1]?.index ?? instructions.length),
  }))
}
