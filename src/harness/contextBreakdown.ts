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
  /** Sums to `usedTokens`, unless a provider count came in below the fixed estimate. */
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

const toolTokens = (tool: Tool) => countTextTokens(JSON.stringify(getCachedToolSchema(tool)))
const sumTools = (tools: readonly Tool[]) => tools.reduce((total, tool) => total + toolTokens(tool), 0)

function fixedParts(sources: ContextSources) {
  const skills = countTextTokens(sources.skillsSection ?? '')
  return {
    system: Math.max(0, countTextTokens(sources.system) - skills),
    tools: sumTools(sources.loadedTools.filter((tool) => !tool.isMcp)),
    mcpTools: sumTools(sources.loadedTools.filter((tool) => tool.isMcp)),
    skills,
    memory: countTextTokens(sources.instructions ?? ''),
  }
}

/** What every request carries before any message: system, loaded tool schemas, skills, instructions. */
export function fixedContextTokens(sources: ContextSources): number {
  return Object.values(fixedParts(sources)).reduce((a, b) => a + b, 0)
}

/**
 * Splits `usedTokens` across the sources. Each fixed part is a character
 * estimate shown as is, and the conversation is what remains. A provider count
 * below the fixed estimate leaves the messages at zero rather than shrinking
 * the fixed parts, which would make them move with the total.
 */
export function breakDownContext(sources: ContextSources, usedTokens: number, estimated: boolean): ContextBreakdown {
  const fixed = fixedParts(sources)
  const categories = (Object.keys(fixed) as (keyof typeof fixed)[]).map((key) => ({ key, tokens: fixed[key] }))
  const messages = Math.max(0, usedTokens - categories.reduce((total, row) => total + row.tokens, 0))
  const deferredMcp = sources.deferredTools.filter((tool) => tool.isMcp)
  const deferredBuiltin = sources.deferredTools.filter((tool) => !tool.isMcp)

  return {
    usedTokens,
    estimated,
    categories: [...categories, { key: 'messages', tokens: messages }],
    deferred: [
      { key: 'mcpTools' as const, tokens: sumTools(deferredMcp) },
      { key: 'tools' as const, tokens: sumTools(deferredBuiltin) },
    ].filter((row) => row.tokens > 0),
    mcpTools: [
      ...sources.loadedTools.filter((tool) => tool.isMcp).map((tool) => ({ name: tool.name, tokens: toolTokens(tool), deferred: false })),
      ...deferredMcp.map((tool) => ({ name: tool.name, tokens: toolTokens(tool), deferred: true })),
    ],
    memoryFiles: splitInstructionFiles(sources.instructions ?? '').map((file) => ({
      path: file.path,
      tokens: countTextTokens(file.text),
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
