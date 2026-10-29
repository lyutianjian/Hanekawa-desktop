import { z } from 'zod/v3'
import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { canonicalUrl, hasCjk, hostOf, singleLine, timeoutSignal } from '../webText.js'
import {
  defaultSearchProviders,
  describeSearchFailure,
  hasRelevantHit,
  keepDomains,
  orderedProviders,
  queryTokens,
  rankHits,
  resultQuality,
  SearchProviderError,
  urlDepth,
  QUERY_DEADLINE_MS,
  type SearchHit,
  type SearchProvider,
  type SearchQuerySpec,
} from './providers.js'
import { DESCRIPTION } from './prompt.js'

const MAX_QUERIES = 4
const DEFAULT_RESULTS = 8
const MAX_RESULTS = 20
/** Ask each engine for more than we print, so domain filtering has spare rows. */
const OVERFETCH_FACTOR = 2

const querySpecSchema = z.object({
  q: z.string().min(1).describe('The search query.'),
  recencyDays: z.number().int().min(1).max(3650)
    .describe('Only results from the last this-many days, where the engine supports it.')
    .optional(),
  domains: z.array(z.string().min(1)).max(8)
    .describe('Restrict this query to these domains.')
    .optional(),
}).strict()

export const webSearchInputSchema = z.object({
  queries: z.array(z.union([z.string().min(1), querySpecSchema]))
    .min(1)
    .max(MAX_QUERIES)
    .describe(`1–${MAX_QUERIES} queries, each a string or an object with q, recencyDays and domains. They run in parallel.`),
  domains: z.array(z.string().min(1)).max(8)
    .describe('Restrict every string query to these domains, e.g. ["nodejs.org"].')
    .optional(),
  blockedDomains: z.array(z.string().min(1)).max(10)
    .describe('Drop results from these domains.')
    .optional(),
  recencyDays: z.number().int().min(1).max(3650)
    .describe('Only results from the last this-many days, for every string query, where the engine supports it.')
    .optional(),
  maxResults: z.number().int().min(1).max(MAX_RESULTS)
    .describe(`Results per query, 1–${MAX_RESULTS}, default ${DEFAULT_RESULTS}.`)
    .optional(),
}).strict()

export type WebSearchInput = z.infer<typeof webSearchInputSchema>

interface QueryOutcome {
  spec: SearchQuerySpec
  hits: SearchHit[]
  /** The engine that answered, when one did. */
  provider?: string
  /** Why each engine that was tried produced nothing. */
  failures: string[]
  elapsedMs: number
  /** No engine offered results that mention the query; these are its closest. */
  weak?: boolean
}

export interface WebSearchToolOptions {
  providers?: SearchProvider[]
  env?: NodeJS.ProcessEnv
  /** Injectable clock, so the skip window can be tested without waiting. */
  now?: () => number
}

/** How long an engine that could not be reached is skipped. */
const UNREACHABLE_SKIP_MS = 120_000
/** How long an engine that answered with its bot challenge is skipped. */
const BLOCKED_SKIP_MS = 60_000

/**
 * What this process recently learned about each engine's reachability.
 *
 * The chains are only useful if a dead engine is cheap. Without this, an
 * unreachable DuckDuckGo costs a full timeout on *every* query — the first
 * engine is best-first, so that would be the common case on a network that
 * blocks it. One failure is remembered for a couple of minutes and the next
 * search goes straight to the fallback; the memo expires so turning a proxy on
 * is picked up without restarting anything.
 *
 * It records the machine's network, not session or project state: every session
 * reaches an engine through the same route, so they share what it learned.
 */
interface ProviderHealth {
  skipReason(providerId: string): string | undefined
  recordFailure(providerId: string, error: unknown): void
  recordSuccess(providerId: string): void
}

function createProviderHealth(now: () => number): ProviderHealth {
  const skipUntil = new Map<string, { until: number; reason: string }>()
  return {
    skipReason(providerId) {
      const entry = skipUntil.get(providerId)
      if (!entry) return undefined
      if (entry.until > now()) return entry.reason
      skipUntil.delete(providerId)
      return undefined
    },
    recordFailure(providerId, error) {
      const kind = error instanceof SearchProviderError ? error.kind : undefined
      if (kind === 'network') {
        skipUntil.set(providerId, { until: now() + UNREACHABLE_SKIP_MS, reason: 'unreachable a moment ago' })
      } else if (kind === 'blocked') {
        skipUntil.set(providerId, { until: now() + BLOCKED_SKIP_MS, reason: 'challenged a moment ago' })
      }
    },
    recordSuccess(providerId) {
      skipUntil.delete(providerId)
    },
  }
}

/**
 * One query, run against engines in turn until one answers *about this query,
 * with a page rather than a homepage*.
 *
 * A chain rather than a fan-out: the common case must stay one request. Three
 * things make it more than a loop. Every engine shares one deadline, so an
 * unreachable host costs one connect timeout and not the whole budget. A
 * result set is only accepted once its text mentions the query's terms — the
 * difference between an engine answering and an engine answering with its
 * fallback feed. And an answer that only reaches site roots is provisional: one
 * more engine is asked for a deeper one before it is used.
 *
 * Whether a rejected or shallow answer is used at the end depends on what else
 * arrived, so the tool never returns less than a plain first-answer chain did —
 * only labelled, when the best it has is not actually about the query.
 */
async function runQuery(
  spec: SearchQuerySpec,
  providers: readonly SearchProvider[],
  maxResults: number,
  context: ToolContext,
  health: ProviderHealth,
): Promise<QueryOutcome> {
  const startedAt = Date.now()
  const failures: string[] = []
  const deadline = timeoutSignal(context.abortSignal, QUERY_DEADLINE_MS)
  // Chinese queries are tokenised poorly and answered by an engine that reads
  // them correctly, so the relevance gate is skipped there.
  const tokens = hasCjk(spec.q) ? [] : queryTokens(spec.q)
  let best: { hits: SearchHit[]; provider: string; quality: number; weak: boolean } | undefined
  let shallowAnswers = 0

  for (const provider of orderedProviders(providers, spec.q)) {
    if (deadline.aborted) break

    const skipped = health.skipReason(provider.id)
    if (skipped !== undefined) {
      failures.push(`${provider.label}: skipped (${skipped})`)
      continue
    }

    let hits: SearchHit[]
    try {
      hits = await provider.search(spec, {
        signal: deadline,
        maxResults: maxResults * OVERFETCH_FACTOR,
      })
    } catch (error) {
      if (context.abortSignal?.aborted) throw error
      if (deadline.aborted) {
        failures.push(`${provider.label}: timed out`)
        break
      }
      health.recordFailure(provider.id, error)
      failures.push(`${provider.label}: ${describeSearchFailure(error)}`)
      continue
    }
    health.recordSuccess(provider.id)

    const kept = rankHits(
      dedupe(excludeDomains(keepDomains(hits, spec), spec.blockedDomains)),
      tokens,
    ).slice(0, maxResults)
    if (kept.length === 0) {
      failures.push(`${provider.label}: no matching results`)
      continue
    }

    const relevant = hasRelevantHit(kept, tokens)
    const quality = resultQuality(kept, tokens)
    if (relevant && urlDepth(kept[0]!.url) > 0) {
      return { spec, hits: kept, provider: provider.label, failures, elapsedMs: Date.now() - startedAt }
    }

    if (!best || quality > best.quality) best = { hits: kept, provider: provider.label, quality, weak: !relevant }
    if (!relevant) {
      failures.push(`${provider.label}: no result mentioned the query`)
      continue
    }
    // Relevant but shallow: one more engine may hold the page itself.
    shallowAnswers += 1
    if (shallowAnswers > 1) break
  }

  if (best) {
    return {
      spec,
      hits: best.hits,
      provider: best.provider,
      failures,
      elapsedMs: Date.now() - startedAt,
      ...(best.weak ? { weak: true } : {}),
    }
  }
  return { spec, hits: [], failures, elapsedMs: Date.now() - startedAt }
}

function dedupe(hits: SearchHit[]): SearchHit[] {
  const seen = new Set<string>()
  const unique: SearchHit[] = []
  for (const hit of hits) {
    const key = canonicalUrl(hit.url)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(hit)
  }
  return unique
}

function excludeDomains(hits: SearchHit[], blocked: string[] | undefined): SearchHit[] {
  const excluded = (blocked ?? [])
    .map((domain) => domain.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, ''))
    .filter((domain) => domain !== '')
  if (excluded.length === 0) return hits
  return hits.filter((hit) => {
    const host = hostOf(hit.url)
    if (host === undefined) return true
    return !excluded.some((domain) => host === domain || host.endsWith(`.${domain}`))
  })
}

function formatOutcome(outcome: QueryOutcome): string {
  const { spec, hits } = outcome
  const filters = [
    spec.domains && spec.domains.length > 0 ? `sites: ${spec.domains.join(', ')}` : undefined,
    spec.recencyDays ? `past ${spec.recencyDays} day${spec.recencyDays === 1 ? '' : 's'}` : undefined,
  ].filter((part): part is string => part !== undefined)
  const header = `Search results for "${spec.q}"${filters.length > 0 ? ` (${filters.join('; ')})` : ''} — ${hits.length} result${hits.length === 1 ? '' : 's'} from ${outcome.provider}`

  const body = hits.map((hit, index) => {
    const lines = [`${index + 1}. ${singleLine(hit.title, 200)}`.trimEnd()]
    lines.push(`   ${hit.url}`)
    if (hit.snippet) lines.push(`   ${hit.snippet}${hit.published ? ` (${singleLine(hit.published, 40)})` : ''}`)
    else if (hit.published) lines.push(`   (${singleLine(hit.published, 40)})`)
    return lines.join('\n')
  }).join('\n\n')

  const weakness = outcome.weak
    ? '\n\nNote: no engine returned results that mention the query\'s own terms; these are the closest matches it had. Check them before relying on them, or rephrase the query.'
    : ''
  return `${header}\n\n${body}${weakness}`
}

function formatEmptyOutcome(outcome: QueryOutcome): string {
  const detail = outcome.failures.length > 0 ? `\n${outcome.failures.map((failure) => `- ${failure}`).join('\n')}` : ''
  return `No results for "${outcome.spec.q}".${detail}`
}

function formatTotalFailure(outcomes: QueryOutcome[]): string {
  const failures = [...new Set(outcomes.flatMap((outcome) => outcome.failures))]
  const filtered = outcomes.filter((outcome) => (outcome.spec.domains?.length ?? 0) > 0)
  return [
    'Web search failed: no engine returned results.',
    ...failures.map((failure) => `- ${failure}`),
    ...(filtered.length > 0
      ? ['', 'A `domains` filter is enforced strictly: engines honour `site:` only loosely, so a domain that does not carry the answer turns every result away. Try the query without it.']
      : []),
    '',
    'If this network blocks the built-in engines, point HANEKAWA_SEARCH_URL at a SearXNG instance or set HANEKAWA_BRAVE_API_KEY, and the search will use it first.',
  ].join('\n')
}

export function createWebSearchTool(options: WebSearchToolOptions = {}): Tool {
  const resolveProviders = (): SearchProvider[] =>
    options.providers ?? defaultSearchProviders(options.env ?? process.env)
  const health = createProviderHealth(options.now ?? Date.now)

  return {
    name: 'WebSearch',
    description: DESCRIPTION,
    searchHint: 'search the web for current information',
    inputSchema: webSearchInputSchema,
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    maxResultSizeChars: 50_000,
    shouldDefer: true,
    userFacingName: () => 'Web Search',
    getToolUseSummary(input) {
      const specs = querySpecsOf(input)
      const first = specs[0]
      if (!first) return null
      return specs.length > 1 ? `${first.q} +${specs.length - 1}` : first.q
    },
    getActivityDescription(input) {
      const specs = querySpecsOf(input)
      const first = specs[0]
      if (!first) return 'Searching the web'
      return specs.length > 1 ? `Searching the web for ${specs.length} queries` : `Searching for "${first.q}"`
    },
    shouldDisplayResult: () => true,
    async execute(input, context): Promise<ToolResult> {
      const parsed = webSearchInputSchema.safeParse(input)
      if (!parsed.success) {
        return {
          ok: false,
          content: 'WebSearch needs 1–4 `queries`, each either a search string or an object with `q`, optional `recencyDays` and optional `domains`.',
          errorCode: 'invalid_input',
        }
      }
      const specs = normalizeQueries(parsed.data)
      if (specs.length === 0) {
        return { ok: false, content: 'WebSearch needs at least one non-empty query.', errorCode: 'invalid_input' }
      }

      const maxResults = parsed.data.maxResults ?? DEFAULT_RESULTS
      const providers = resolveProviders()
      const startedAt = Date.now()
      const outcomes = await Promise.all(specs.map((spec) => runQuery(spec, providers, maxResults, context, health)))
      const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
      const answered = outcomes.filter((outcome) => outcome.hits.length > 0)
      const total = answered.reduce((count, outcome) => count + outcome.hits.length, 0)

      if (total === 0) {
        return {
          ok: false,
          content: formatTotalFailure(outcomes),
          errorCode: 'execution_failed',
          metadata: { display: { summary: `No engine returned results (${elapsed}s)` } },
        }
      }

      const parts = outcomes.map((outcome) => outcome.hits.length > 0 ? formatOutcome(outcome) : formatEmptyOutcome(outcome))
      const engines = [...new Set(answered.map((outcome) => outcome.provider).filter((name): name is string => name !== undefined))]
      return {
        ok: true,
        content: parts.join('\n\n'),
        metadata: {
          display: {
            summary: `${total} result${total === 1 ? '' : 's'}${engines.length > 0 ? ` from ${engines.join(', ')}` : ''} (${elapsed}s)`,
          },
        },
      }
    },
  }
}

/** String queries take the call's top-level filters; objects carry their own. */
function normalizeQueries(input: WebSearchInput): SearchQuerySpec[] {
  const specs: SearchQuerySpec[] = []
  for (const entry of input.queries) {
    if (typeof entry === 'string') {
      const q = entry.trim()
      if (q === '') continue
      specs.push({
        q,
        ...(input.recencyDays ? { recencyDays: input.recencyDays } : {}),
        ...(input.domains && input.domains.length > 0 ? { domains: input.domains } : {}),
        ...(input.blockedDomains && input.blockedDomains.length > 0 ? { blockedDomains: input.blockedDomains } : {}),
      })
      continue
    }
    const q = entry.q.trim()
    if (q === '') continue
    const domains = entry.domains && entry.domains.length > 0 ? entry.domains : input.domains
    specs.push({
      q,
      ...(entry.recencyDays ? { recencyDays: entry.recencyDays } : input.recencyDays ? { recencyDays: input.recencyDays } : {}),
      ...(domains && domains.length > 0 ? { domains } : {}),
      ...(input.blockedDomains && input.blockedDomains.length > 0 ? { blockedDomains: input.blockedDomains } : {}),
    })
  }
  return specs.slice(0, MAX_QUERIES)
}

/** The queries a call names, for display only; never throws on odd input. */
function querySpecsOf(input: unknown): Array<{ q: string }> {
  if (typeof input !== 'object' || input === null) return []
  const queries = (input as { queries?: unknown }).queries
  if (!Array.isArray(queries)) return []
  return queries.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() === '' ? [] : [{ q: entry.trim() }]
    if (typeof entry === 'object' && entry !== null) {
      const q = (entry as { q?: unknown }).q
      if (typeof q === 'string' && q.trim() !== '') return [{ q: q.trim() }]
    }
    return []
  })
}

export const webSearchTool: Tool = createWebSearchTool()