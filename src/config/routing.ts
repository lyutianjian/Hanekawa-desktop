/**
 * Model routing.
 *
 * Three layers of configuration:
 *  - endpoints:     provider + baseUrl + apiKey
 *  - models:        a model id + reference to an endpoint (or legacy inline endpoint fields)
 *
 * Plus a `routing` map from semantic role to a **model key**:
 *  - main:     the main loop
 *  - plan:     used while permissionMode === 'plan'
 *  - compact:  used by autoCompact and tool-use summarizer
 *  - subagent: per subagent_type (general / explore / plan / fork / ...)
 *
 * The router accepts an `'inherit'` sentinel to mean "fall back to the parent /
 * main loop model", which is essential for fork-style sub-agents that share
 * the parent's prompt-cache stream.
 *
 * There is deliberately no tier layer. Routing names a model key directly, and
 * anything that is not a resolvable key degrades to `'inherit'` at the service.
 */

import type { ChatThinkingFormat } from './providers/openaiCompat.js'

export type PromptCachingMode = 'auto' | 'on' | 'off'

export interface Endpoint {
  provider: string
  baseUrl?: string
  apiKey?: string
  /** Anthropic prompt caching. Defaults to auto with compatibility fallback. */
  promptCaching?: PromptCachingMode
  /**
   * Chat Completions only, hand-written: how this server takes the thinking
   * switch. Absent detects it from `baseUrl`; a relay the detection cannot
   * see through is what this is for.
   */
  thinkingFormat?: ChatThinkingFormat
}

/** A model key, or the `'inherit'` sentinel. */
export type RoutedModel = string

export interface SubagentRouting {
  general?: RoutedModel
  fork?: RoutedModel
  explore?: RoutedModel
  plan?: RoutedModel
  /** Custom subagent types declared via `.myagent/agents/*.md`. */
  [type: string]: RoutedModel | undefined
}

export interface Routing {
  main?: RoutedModel
  plan?: RoutedModel
  compact?: RoutedModel
  subagent?: SubagentRouting
}

/**
 * Default routing applied on top of any user-provided routing config.
 *
 * Every role inherits. With no tiers there is no tier to promote *to*, so
 * "plan mode automatically upgrades" and "compaction automatically downgrades"
 * have no honest default to express — following the main model is the only one
 * that is true for a config the user has not spoken about. A user who wants a
 * cheaper compaction model still has the dedicated `compactModel` setting.
 */
export const DEFAULT_ROUTING: Required<Pick<Routing, 'main' | 'plan' | 'compact'>> & { subagent: Required<Pick<SubagentRouting, 'general' | 'fork' | 'explore' | 'plan'>> } = {
  main: 'inherit',
  plan: 'inherit',
  compact: 'inherit',
  subagent: {
    general: 'inherit',
    fork: 'inherit',
    explore: 'inherit',
    plan: 'inherit',
  },
}

/**
 * Deep-merge user routing on top of defaults. Later sources override earlier.
 * `subagent` is merged key-by-key; missing keys keep defaults.
 */
export function mergeRouting(...sources: (Routing | undefined)[]): Routing {
  const result: Routing = {
    main: DEFAULT_ROUTING.main,
    plan: DEFAULT_ROUTING.plan,
    compact: DEFAULT_ROUTING.compact,
    subagent: { ...DEFAULT_ROUTING.subagent },
  }

  for (const source of sources) {
    if (!source) continue
    if (source.main !== undefined) result.main = source.main
    if (source.plan !== undefined) result.plan = source.plan
    if (source.compact !== undefined) result.compact = source.compact
    if (source.subagent) {
      result.subagent = { ...result.subagent, ...source.subagent }
    }
  }

  return result
}

export type RoutingRole =
  | { kind: 'main' }
  | { kind: 'plan' }
  | { kind: 'compact' }
  | { kind: 'subagent'; type: string }

/**
 * Pick which model a given role wants. Returns `'inherit'` to mean "use the
 * parent / main loop model directly", or a model key. Returns undefined if the
 * routing entry is not configured (caller should treat as 'inherit').
 */
export function pickRoutedModel(routing: Routing | undefined, role: RoutingRole): RoutedModel | undefined {
  const r = routing ?? {}
  switch (role.kind) {
    case 'main':
      return r.main
    case 'plan':
      return r.plan
    case 'compact':
      return r.compact
    case 'subagent': {
      const subagent = r.subagent ?? {}
      // Type-specific override first, then fall through to general, then inherit.
      return subagent[role.type] ?? subagent.general ?? 'inherit'
    }
  }
}
