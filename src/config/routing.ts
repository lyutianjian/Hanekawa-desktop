/**
 * Model routing.
 *
 * Three layers of configuration:
 *  - endpoints:     provider + baseUrl + apiKey
 *  - models:        a model id + reference to an endpoint (or legacy inline endpoint fields)
 *
 * Plus a `routing` map from semantic role to a **model key**:
 *  - main:        the main loop
 *  - plan:        used while permissionMode === 'plan'
 *  - compact:     used by autoCompact and tool-use summarizer
 *  - coordinator: the project's coordination session
 *  - thread:      sessions a coordinator starts for one task
 *  - subagent:    per subagent_type (general / explore / plan / ...)
 *
 * The router accepts an `'inherit'` sentinel to mean "fall back to the parent /
 * main loop model".
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
  explore?: RoutedModel
  plan?: RoutedModel
  /** Custom subagent types declared via `.myagent/agents/*.md`. */
  [type: string]: RoutedModel | undefined
}

export interface Routing {
  main?: RoutedModel
  plan?: RoutedModel
  compact?: RoutedModel
  coordinator?: RoutedModel
  thread?: RoutedModel
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
export const DEFAULT_ROUTING: Required<Pick<Routing, 'main' | 'plan' | 'compact' | 'coordinator' | 'thread'>> & { subagent: SubagentRouting } = {
  main: 'inherit',
  plan: 'inherit',
  compact: 'inherit',
  coordinator: 'inherit',
  thread: 'inherit',
  subagent: {
    general: 'inherit',
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
    coordinator: DEFAULT_ROUTING.coordinator,
    thread: DEFAULT_ROUTING.thread,
    subagent: { ...DEFAULT_ROUTING.subagent },
  }

  for (const source of sources) {
    if (!source) continue
    if (source.main !== undefined) result.main = source.main
    if (source.plan !== undefined) result.plan = source.plan
    if (source.compact !== undefined) result.compact = source.compact
    if (source.coordinator !== undefined) result.coordinator = source.coordinator
    if (source.thread !== undefined) result.thread = source.thread
    if (source.subagent) {
      result.subagent = { ...result.subagent, ...source.subagent }
    }
  }

  // Retired built-in routes must not return as custom rows in settings.
  delete result.subagent!.fork
  return result
}

export type RoutingRole =
  | { kind: 'main' }
  | { kind: 'plan' }
  | { kind: 'compact' }
  | { kind: 'coordinator' }
  | { kind: 'thread' }
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
    case 'coordinator':
      return r.coordinator
    case 'thread':
      return r.thread
    case 'subagent': {
      const subagent = r.subagent ?? {}
      // Type-specific override first, then fall through to general, then inherit.
      return subagent[role.type] ?? subagent.general ?? 'inherit'
    }
  }
}
