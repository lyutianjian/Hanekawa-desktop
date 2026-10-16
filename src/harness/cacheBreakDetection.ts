/**
 * Unified prompt cache diagnostics.
 *
 * Two responsibilities:
 *
 *  1. Cache-break detection: track prompt state (system, tools, model, first
 *     message) before each request, then compare cache_read_input_tokens after
 *     the response to classify a break by cause (system_prompt_changed,
 *     tool_schemas_changed, model_changed, first_message_changed, or
 *     server_side eviction).
 *
 *  2. Hit-rate formatting: a small helper for human-readable cache hit rate
 *     output, kept here so all prompt-cache diagnostics live together.
 *
 * State is partitioned by `source` so unrelated request streams do not pollute
 * each other's cache-read baselines. Keep main agent conversations under
 * `agent:<id>`; reserve the other names for non-agent request streams.
 */

import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { getProjectDataDir } from '../utils/paths.js'
import { cacheHitRate } from './usage.js'

export type CacheBreakSource =
  | `agent:${string}`
  | `agent:plan:${string}`
  | `agent:fork:${string}`
  | 'repl_main_thread'
  | 'sdk'
  | 'compact'
  | 'tool_use_summary'
  | 'session_title'
  | 'hook_agent'
  | 'hook_prompt'
  | 'side_question'
  | 'bash_classifier'

export function agentCacheSource(agentId: string, root?: string): CacheBreakSource {
  const normalized = agentId.trim() || 'unknown'
  return bindRoot(`agent:${normalized}`, root)
}

/**
 * Project root each source belongs to.
 *
 * Detection runs inside the provider, which has no cwd of its own, so the root
 * travels *inside the source string*: whoever mints a source says where it came
 * from, and the root becomes part of the identity. A side table keyed by source
 * would not do — two projects can mint the same logical source (the same
 * session id, or any of the fixed literals like `compact`), and the second
 * binding would silently retarget the first.
 *
 * `ROOT_TAG` cannot appear in a source name, which is why it separates cleanly.
 */
const ROOT_TAG = '@root-'
const rootBySource = new Map<CacheBreakSource, string>()

function bindRoot(base: string, root: string | undefined): CacheBreakSource {
  if (!root) return base as CacheBreakSource
  // A digest rather than the path itself: this string is hashed into
  // `prompt_cache_key` on the OpenAI path and printed in debug output, and
  // neither wants an absolute path in it.
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8)
  const source = `${base}${ROOT_TAG}${digest}` as CacheBreakSource
  rootBySource.set(source, root)
  return source
}

function rootFor(source: CacheBreakSource): string {
  return rootBySource.get(source) ?? process.cwd()
}

/** The source without its root suffix, for diagnostics output and filenames. */
export function displayCacheSource(source: CacheBreakSource): string {
  const index = source.indexOf(ROOT_TAG)
  return index === -1 ? source : source.slice(0, index)
}

/**
 * The fixed-literal sources, bound to the project that minted them.
 *
 * These exist because `compact` and `tool_use_summary` are the same string in
 * every project, so without a root two projects running at once share one
 * cache-read baseline: whichever one answers second is measured against the
 * other's `prevCacheReadTokens` and reports a break that never happened. The
 * root also decides which project's `diagnostics/` the debug JSON lands in.
 *
 * `root` stays optional so a caller with no cwd in reach still gets the bare
 * literal — the pre-existing behaviour, and the reason there is no process-wide
 * default to set any more.
 */
export function compactCacheSource(root?: string): CacheBreakSource {
  return bindRoot('compact', root)
}

export function toolUseSummaryCacheSource(root?: string): CacheBreakSource {
  return bindRoot('tool_use_summary', root)
}

export function sessionTitleCacheSource(root?: string): CacheBreakSource {
  return bindRoot('session_title', root)
}

/** One per fork run: concurrent forks must not share a cache-read baseline. */
export function forkCacheSource(forkId: string, root?: string): CacheBreakSource {
  const normalized = forkId.trim() || 'unknown'
  return bindRoot(`agent:fork:${normalized}`, root)
}

export function planCacheSource(sessionId: string, root?: string): CacheBreakSource {
  const normalized = sessionId.trim() || 'unknown'
  return bindRoot(`agent:plan:${normalized}`, root)
}

export function requireCacheSource(source: CacheBreakSource | undefined): CacheBreakSource {
  if (!source) {
    throw new Error('ModelRequest.cacheSource is required for prompt cache diagnostics.')
  }
  return source
}

export interface CacheUsageSnapshot {
  inputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens: number
  outputTokens: number
}

interface PreviousSnapshot {
  systemHash: string
  toolsHash: string
  betasHash: string
  cacheScopeHash: string
  model: string
  systemCharCount: number
  firstMessageHash: string
  prevCacheReadTokens: number | null
  messageHashes?: string[]
}

interface PendingChanges {
  systemPromptChanged: boolean
  toolSchemasChanged: boolean
  betaHeadersChanged: boolean
  cacheScopeChanged: boolean
  modelChanged: boolean
  firstMessageChanged: boolean
  systemCharDelta: number
  previous: PromptHashes | null
  current: PromptHashes
  messagesChangedAt: number | null
  messageCount?: number
  previousMessageCount?: number
  pendingSnapshot?: PreviousSnapshot
}

interface PromptState {
  system: string
  toolsJson: string
  model: string
  betas?: string[]
  cacheScope?: string
  /**
   * The conversation's first message: the instruction files and memory index
   * when there are any. They left the system prompt for it, so this is what
   * names a break that edited them; hashed always, unlike `messages`.
   */
  firstMessage?: string
  /**
   * The outbound message array. Fingerprinted per message so a break caused by
   * a rewrite inside the history reports *where* it happened instead of landing
   * in `server_side`. Only hashed under `MYAGENT_DEBUG_PROVIDER=1` — the normal
   * path must not pay a full serialization of the history per request.
   */
  messages?: readonly unknown[]
}

export interface PromptHashes {
  systemHash: string
  toolsHash: string
  betasHash: string
  cacheScopeHash: string
  model: string
}

// Keyed by the root-qualified source, so the same logical source used from two
// project roots never shares a cache-read baseline.
const previousSnapshots = new Map<string, PreviousSnapshot>()
const pendingChangesBySource = new Map<string, PendingChanges>()

export function recordPromptState(
  state: PromptState,
  source: CacheBreakSource,
): void {
  const systemHash = hashString(state.system)
  const firstMessageHash = hashString(state.firstMessage ?? '')
  const toolsHash = hashString(state.toolsJson)
  const normalizedBetas = [...(state.betas ?? [])].sort()
  const betasHash = hashString(JSON.stringify(normalizedBetas))
  const cacheScope = state.cacheScope ?? 'default'
  const cacheScopeHash = hashString(cacheScope)
  const current: PromptHashes = {
    systemHash,
    toolsHash,
    betasHash,
    cacheScopeHash,
    model: state.model,
  }

  const changes: PendingChanges = {
    systemPromptChanged: false,
    toolSchemasChanged: false,
    betaHeadersChanged: false,
    cacheScopeChanged: false,
    modelChanged: false,
    firstMessageChanged: false,
    systemCharDelta: 0,
    previous: null,
    current,
    messagesChangedAt: null,
  }

  const messageHashes = fingerprintMessages(state.messages)

  const previous = previousSnapshots.get(source)
  if (previous) {
    changes.previous = {
      systemHash: previous.systemHash,
      toolsHash: previous.toolsHash,
      betasHash: previous.betasHash,
      cacheScopeHash: previous.cacheScopeHash,
      model: previous.model,
    }
    if (previous.systemHash !== systemHash) {
      changes.systemPromptChanged = true
      changes.systemCharDelta = state.system.length - previous.systemCharCount
    }
    if (previous.toolsHash !== toolsHash) {
      changes.toolSchemasChanged = true
    }
    if (previous.betasHash !== betasHash) {
      changes.betaHeadersChanged = true
    }
    if (previous.cacheScopeHash !== cacheScopeHash) {
      changes.cacheScopeChanged = true
    }
    if (previous.model !== state.model) {
      changes.modelChanged = true
    }
    if (previous.firstMessageHash !== firstMessageHash) {
      changes.firstMessageChanged = true
    }
    if (messageHashes && previous.messageHashes) {
      changes.messagesChangedAt = firstChangedMessageIndex(previous.messageHashes, messageHashes)
      changes.previousMessageCount = previous.messageHashes.length
      changes.messageCount = messageHashes.length
    }
  }

  pendingChangesBySource.set(source, changes)

  // Defer the snapshot update to checkResponseForCacheBreak to avoid
  // overwriting state if concurrent requests share the same source.
  // Store the pending snapshot so it can be committed after the response.
  changes.pendingSnapshot = {
    systemHash,
    toolsHash,
    betasHash,
    cacheScopeHash,
    model: state.model,
    systemCharCount: state.system.length,
    firstMessageHash,
    prevCacheReadTokens: previous?.prevCacheReadTokens ?? null,
    ...(messageHashes ? { messageHashes } : {}),
  }
}

function fingerprintMessages(messages: readonly unknown[] | undefined): string[] | undefined {
  if (!messages || process.env.MYAGENT_DEBUG_PROVIDER !== '1') return undefined
  return messages.map((message) => hashString(JSON.stringify(message ?? null)))
}

/**
 * Index of the first message whose content differs from the previous request,
 * or null when the previous sequence is still a prefix of the current one.
 *
 * A pure append is the healthy shape — it keeps the cached prefix intact — so
 * only a rewrite at some existing index (or a truncation, which shows up as a
 * missing entry) counts as a change.
 */
function firstChangedMessageIndex(previous: string[], current: string[]): number | null {
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== current[index]) return index
  }
  return null
}

export function checkResponseForCacheBreak(
  cacheReadTokens: number,
  inputTokens: number,
  source: CacheBreakSource,
): CacheBreakResult | null {
  void inputTokens
  const pending = pendingChangesBySource.get(source)

  // Commit the deferred snapshot now that the response is complete.
  if (pending?.pendingSnapshot) {
    previousSnapshots.set(source, pending.pendingSnapshot)
  }

  const previous = previousSnapshots.get(source)
  if (!previous) return null

  const prevCacheRead = previous.prevCacheReadTokens
  previous.prevCacheReadTokens = cacheReadTokens

  if (prevCacheRead === null) {
    pendingChangesBySource.delete(source)
    return null
  }

  const tokenDrop = prevCacheRead - cacheReadTokens
  if (cacheReadTokens >= prevCacheRead * 0.95 || tokenDrop < 2000) {
    pendingChangesBySource.delete(source)
    return null
  }

  const result: CacheBreakResult = {
    tokenDrop,
    prevCacheRead,
    currentCacheRead: cacheReadTokens,
    reasons: [],
    source,
  }

  if (pending) {
    if (pending.systemPromptChanged) {
      result.reasons.push(`system_prompt_changed(+${pending.systemCharDelta} chars)`)
    }
    if (pending.toolSchemasChanged) {
      result.reasons.push('tool_schemas_changed')
    }
    if (pending.betaHeadersChanged) {
      result.reasons.push('beta_headers_changed')
    }
    if (pending.cacheScopeChanged) {
      result.reasons.push('cache_scope_changed')
    }
    if (pending.modelChanged) {
      result.reasons.push('model_changed')
    }
    if (pending.firstMessageChanged) {
      result.reasons.push('first_message_changed')
    }
    if (pending.messagesChangedAt !== null) {
      result.messagesChangedAt = pending.messagesChangedAt
      result.reasons.push(`messages_changed_at=${pending.messagesChangedAt}`)
    }
    if (pending.messageCount !== undefined) {
      result.messageCounts = {
        previous: pending.previousMessageCount ?? 0,
        current: pending.messageCount,
      }
    }
    if (pending.previous) {
      result.hashes = {
        previous: pending.previous,
        current: pending.current,
      }
    }
    pendingChangesBySource.delete(source)
  }

  if (result.reasons.length === 0) {
    result.reasons.push('server_side')
  }

  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    const diagnosticsPath = writeCacheBreakDiagnostic(result)
    console.error(
      `[myagent][cache-break] source=${displayCacheSource(source)} drop=${tokenDrop} tokens prev=${prevCacheRead} current=${cacheReadTokens} reasons=${result.reasons.join(',')}${diagnosticsPath ? ` diagnostics=${diagnosticsPath}` : ''}`,
    )
  }

  return result
}

export interface CacheBreakResult {
  tokenDrop: number
  prevCacheRead: number
  currentCacheRead: number
  reasons: string[]
  source: CacheBreakSource
  hashes?: {
    previous: PromptHashes
    current: PromptHashes
  }
  /** Index of the first rewritten message, when message fingerprints are on. */
  messagesChangedAt?: number
  messageCounts?: {
    previous: number
    current: number
  }
}

export function notifyCompaction(source: CacheBreakSource): void {
  const previous = previousSnapshots.get(source)
  if (previous) {
    previous.prevCacheReadTokens = null
  }
}

export function resetCacheBreakDetection(source?: CacheBreakSource): void {
  if (source === undefined) {
    previousSnapshots.clear()
    pendingChangesBySource.clear()
    return
  }
  previousSnapshots.delete(source)
  pendingChangesBySource.delete(source)
}

/**
 * Format a cache hit-rate summary line for debug output.
 */
export function formatCacheHitRate(usage: CacheUsageSnapshot): string {
  const rate = cacheHitRate(usage)
  if (rate === null) return 'cache: n/a'
  return `cache: ${(rate * 100).toFixed(0)}% hit`
}

function writeCacheBreakDiagnostic(result: CacheBreakResult): string | null {
  if (!result.hashes) return null
  try {
    // The root is stripped for output: it is already implied by the directory
    // this lands in, and a full path makes for an unreadable filename.
    const display = displayCacheSource(result.source)
    const session = display.startsWith('agent:') ? display.slice('agent:'.length) : display
    const diagnosticsDir = path.join(getProjectDataDir(rootFor(result.source)), 'diagnostics')
    mkdirSync(diagnosticsDir, { recursive: true, mode: 0o700 })
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const filePath = path.join(diagnosticsDir, `${sanitizeFilePart(session)}-cache-break-${timestamp}.json`)
    const payload = {
      created_at: new Date().toISOString(),
      event: 'tengu_prompt_cache_break',
      source: display,
      reasons: result.reasons,
      drop_tokens: result.tokenDrop,
      prev_cache_read_tokens: result.prevCacheRead,
      current_cache_read_tokens: result.currentCacheRead,
      hashes: result.hashes,
      hash_diff: promptHashDiff(result.hashes.previous, result.hashes.current),
      ...(result.messagesChangedAt !== undefined ? { messages_changed_at: result.messagesChangedAt } : {}),
      ...(result.messageCounts
        ? {
          prev_message_count: result.messageCounts.previous,
          current_message_count: result.messageCounts.current,
        }
        : {}),
    }
    writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 })
    return filePath
  } catch {
    return null
  }
}

function promptHashDiff(previous: PromptHashes, current: PromptHashes): string[] {
  const lines = ['--- previous', '+++ current']
  for (const key of ['systemHash', 'toolsHash', 'betasHash', 'cacheScopeHash', 'model'] as const) {
    if (previous[key] === current[key]) continue
    lines.push(`-${key}: ${previous[key]}`)
    lines.push(`+${key}: ${current[key]}`)
  }
  return lines
}

function sanitizeFilePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'unknown'
}

function hashString(str: string): string {
  return createHash('sha256').update(str).digest('hex').slice(0, 16)
}
