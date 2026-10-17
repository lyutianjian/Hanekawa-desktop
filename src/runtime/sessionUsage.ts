import type { SessionRecord, TaskDisplaySnapshot, TokenUsage } from '../harness/types.js'
import { addUsageCost, cacheCreationTokens, costField, reportsCacheCreation, subtractUsageCost } from '../harness/usage.js'
import type { SessionStore } from '../sessions/service.js'

/** Token accounting for a session: the last request plus the running total. */
export interface SessionUsage {
  lastRequest: TokenUsage | null
  total: TokenUsage
}

/**
 * Cache writes are summed only when a side reported them, so a provider that
 * never answers with the field keeps producing three-field usage. See
 * `harness/usage.ts`, which draws the same distinction for the same reason.
 */
function combineCacheCreation(
  a: TokenUsage,
  b: TokenUsage,
  combine: (left: number, right: number) => number,
): Pick<TokenUsage, 'cacheCreationInputTokens'> | Record<string, never> {
  if (!reportsCacheCreation(a) && !reportsCacheCreation(b)) return {}
  return { cacheCreationInputTokens: combine(cacheCreationTokens(a), cacheCreationTokens(b)) }
}

export function addTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    ...combineCacheCreation(a, b, (left, right) => left + right),
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...costField(addUsageCost(a.cost, b.cost)),
  }
}

/**
 * `a - b`, clamped at zero per field.
 *
 * Only one caller: `SessionController` adds each request's usage to the running
 * total the moment it lands, then settles the run by adding whatever the
 * end-of-run figure holds *beyond* what it already counted — compaction and
 * subagent transcripts, which never come through `onRequestUsage`. The clamp is
 * the safety net for a run whose total somehow trails its own requests; a
 * negative token count on screen would be worse than a stale one.
 */
export function subtractTokenUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
    ...combineCacheCreation(a, b, (left, right) => Math.max(0, left - right)),
    cacheReadInputTokens: Math.max(0, a.cacheReadInputTokens - b.cacheReadInputTokens),
    outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
    ...costField(subtractUsageCost(a.cost, b.cost)),
  }
}

export function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
  }
}

/** Nothing counted yet — the one condition under which a seeded total may land. */
export function isEmptyUsage(usage: TokenUsage): boolean {
  return usage.inputTokens === 0
    && cacheCreationTokens(usage) === 0
    && usage.cacheReadInputTokens === 0
    && usage.outputTokens === 0
}

export function createEmptySessionUsage(): SessionUsage {
  return {
    lastRequest: null,
    total: createEmptyUsage(),
  }
}

export function findLatestTaskSnapshot(records: readonly SessionRecord[]): TaskDisplaySnapshot | undefined {
  for (const record of [...records].reverse()) {
    if (record.type !== 'tool_result') continue
    if (record.display?.taskSnapshot) return record.display.taskSnapshot
  }
  return undefined
}

export async function formatInterruptMessage(
  store: SessionStore,
  sessionId: string,
  userMessageId: string,
): Promise<string> {
  try {
    const loaded = await store.loadRecordsWithDiagnostics(sessionId)
    const interruption = [...loaded.records]
      .reverse()
      .find((record) => record.type === 'turn_interruption' && record.userMessageId === userMessageId)
    if (!interruption || interruption.type !== 'turn_interruption') return 'Interrupted.'
    const remaining = interruption.remainingTasks.length
    if (remaining === 0) return 'Interrupted.'
    return `Interrupted. ${remaining} ${remaining === 1 ? 'task' : 'tasks'} remaining.`
  } catch {
    return 'Interrupted.'
  }
}
