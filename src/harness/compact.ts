import { randomUUID } from 'node:crypto'
import type { ChatMessage, CompactBoundaryRecord, ModelProvider, SessionRecord, Tool, TokenUsage } from './types.js'
import type { ActiveModelRuntime } from './loop.js'
import { EMPTY_TOKEN_USAGE, addTokenUsage } from './usage.js'
import {
  countTextTokens,
  countSessionRecordTokens,
  countSessionRecordsTokens,
  getAutoCompactThreshold,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import { getRecordsAfterLastCompact } from './requestPrep.js'
import type { ImageTokenStrategy } from '../media/imageTokens.js'
import { compactCacheSource } from './cacheBreakDetection.js'
import { wrapInSystemReminder } from './systemReminder.js'
import { getCompactPrompt, getSharedPrefixCompactPrompt, formatCompactSummary, type CompactPromptVariant } from '../prompts/compactPrompt.js'
import {
  projectRecordsImagesToText,
  resolveAttachmentFactsForRecords,
  type AttachmentFactsResolver,
} from './turnImages.js'

export const COMPACT_FAILURE_LIMIT = 3
const compactFailuresByKey = new Map<string, number>()
const compactRunsByKey = new Map<string, Promise<CompactCheckResult>>()

export interface CompactCheckInput {
  records: SessionRecord[]
  provider: ModelProvider
  model: string
  compactRuntime?: ActiveModelRuntime
  tools: Tool[]
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  lastResponseTokenCount?: number
  lastResponseRecordId?: string
  lastResponseRecordCount?: number
  /** Image-token strategy of the model serving the request being sized. */
  imageTokenStrategy?: ImageTokenStrategy
  promptCacheRetention?: 'in_memory' | '24h'
  turnId?: string
  circuitKey?: string
  /** Project root, for the compaction request's cache source. Defaults to `process.cwd()`. */
  cwd?: string
  /** Tool names discovered via ToolSearch — preserved in compact boundary. */
  discoveredToolNames?: Set<string>
  /** Custom instructions to append to the compact prompt (from CLI args or hook output). */
  compactInstructions?: string
  /** Prompt variant for the summary request; defaults to the standard prompt. */
  compactPromptVariant?: CompactPromptVariant
  /** Skips only the threshold check; the circuit breaker and history checks still apply. */
  force?: boolean
  /**
   * Resolves attachment facts so summarized images name their cache location
   * (design §11.3). Optional: without it the placeholder names the attachment
   * ID instead, and the summary request is text-only either way.
   */
  attachmentFacts?: AttachmentFactsResolver
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  /**
   * Sends `prompt` as the last message of the conversation's own request, so
   * the summary reads the main cached prefix. Absent when the compact model
   * differs from the active one — then the prefix cannot be shared and the
   * conversation goes out as text. A failure or an empty answer falls back to
   * that text path.
   */
  summarizeWithSharedPrefix?(prompt: string): Promise<{ content: string; usage?: TokenUsage }>
  /** Stops the shared-prefix summary; the text fallback runs in the background. */
  signal?: AbortSignal
  appendRecord(record: SessionRecord): Promise<void>
  onBeforeCompact?(event: CompactHookEvent): Promise<void>
  onAfterCompact?(event: CompactHookEvent & { summary: string; postTokens: number; compactDurationMs: number }): Promise<void>
}

export interface CompactHookEvent {
  trigger: 'auto' | 'manual'
  preTokens: number
  recordCount: number
}

export interface CompactCheckResult {
  compacted: boolean
  usage: TokenUsage
  metrics?: {
    preTokens: number
    postTokens: number
    compactDurationMs: number
  }
}

export interface ContinuationSummaryInput {
  records: SessionRecord[]
  provider: ModelProvider
  model: string
  compactRuntime?: ActiveModelRuntime
  promptCacheRetention?: 'in_memory' | '24h'
  preTokens?: number
  /** Custom instructions to append to the compact prompt. */
  compactInstructions?: string
  compactPromptVariant?: CompactPromptVariant
  /** See {@link CompactCheckInput.attachmentFacts}; also used by rewind summaries. */
  attachmentFacts?: AttachmentFactsResolver
  /**
   * Project root, so the `compact` cache source is bound to it. Two projects
   * compacting in one process would otherwise share a cache-read baseline.
   */
  cwd?: string
}

export interface ContinuationSummaryResult {
  content: string
  usage?: TokenUsage
  preTokens: number
}

export async function autoCompactIfNeeded(input: CompactCheckInput): Promise<CompactCheckResult> {
  const circuitKey = input.circuitKey ?? 'default'
  const existingRun = compactRunsByKey.get(circuitKey)
  if (existingRun) return existingRun

  const run = autoCompactIfNeededOnce(input, circuitKey)
  compactRunsByKey.set(circuitKey, run)
  try {
    return await run
  } finally {
    if (compactRunsByKey.get(circuitKey) === run) {
      compactRunsByKey.delete(circuitKey)
    }
  }
}

async function autoCompactIfNeededOnce(input: CompactCheckInput, circuitKey: string): Promise<CompactCheckResult> {
  const currentFailures = await getCompactFailureCount(input, circuitKey)
  if (currentFailures >= COMPACT_FAILURE_LIMIT) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  const compactableRecords = getRecordsAfterLastCompact(input.records)
  const tokenCount = countCurrentTokens(input, compactableRecords)
  const threshold = getAutoCompactThreshold(input.contextManagement)

  if (!input.force && tokenCount < threshold) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }

  if (!hasHistoryBeforeLatestUserMessage(compactableRecords)) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }
  // Everything goes into the summary, the latest user message and this turn's
  // work included: the boundary lands after all of it, so whatever the summary
  // leaves out is gone from every later request.
  try {
    return await compactRecords(input, compactableRecords, tokenCount, 'auto', circuitKey)
  } catch (error) {
    const failureCount = currentFailures + 1
    await setCompactFailureCount(input, circuitKey, failureCount)
    await appendCompactFailureRecord(input, error, failureCount, tokenCount)
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }
}

/**
 * `/compact`: summarizes everything since the last boundary now. The circuit
 * breaker does not apply and a success closes it; a failure throws without
 * counting toward it. `compacted: false` means there was nothing to summarize.
 */
export async function compactNow(input: CompactCheckInput): Promise<CompactCheckResult> {
  const records = getRecordsAfterLastCompact(input.records)
  if (!records.some((record) => record.type === 'message' && record.role === 'user')) {
    return { compacted: false, usage: { ...EMPTY_TOKEN_USAGE } }
  }
  return compactRecords(input, records, countCurrentTokens(input, records), 'manual', input.circuitKey ?? 'default')
}

async function compactRecords(
  input: CompactCheckInput,
  recordsToCompact: SessionRecord[],
  tokenCount: number,
  trigger: CompactHookEvent['trigger'],
  circuitKey: string,
): Promise<CompactCheckResult> {
  const compactStartedAt = Date.now()
  await runBeforeCompactHook(input, { trigger, preTokens: tokenCount, recordCount: recordsToCompact.length })

  const summary = await summarizeForAutoCompact(input, recordsToCompact, tokenCount)
  const postTokens = countTextTokens(summary.content)
  const compactDurationMs = Date.now() - compactStartedAt
  await input.appendRecord({
    id: randomUUID(),
    type: 'compact_boundary',
    summary: summary.content,
    preTokens: tokenCount,
    postCompactRestore: 'pending',
    ...(input.turnId ? { turnId: input.turnId } : {}),
    ...(input.discoveredToolNames && input.discoveredToolNames.size > 0
      ? { preCompactDiscoveredTools: [...input.discoveredToolNames] }
      : {}),
    createdAt: new Date().toISOString(),
  })
  compactFailuresByKey.delete(circuitKey)
  await setCompactFailureCount(input, circuitKey, 0)
  await runAfterCompactHook(input, {
    trigger,
    preTokens: tokenCount,
    recordCount: recordsToCompact.length,
    summary: summary.content,
    postTokens,
    compactDurationMs,
  })

  return {
    compacted: true,
    usage: addTokenUsage({ ...EMPTY_TOKEN_USAGE }, summary.usage),
    metrics: {
      preTokens: tokenCount,
      postTokens,
      compactDurationMs,
    },
  }
}

async function summarizeForAutoCompact(
  input: CompactCheckInput,
  recordsToCompact: SessionRecord[],
  tokenCount: number,
): Promise<ContinuationSummaryResult> {
  let sharedUsage: TokenUsage | undefined
  if (input.summarizeWithSharedPrefix) {
    try {
      const response = await input.summarizeWithSharedPrefix(getSharedPrefixCompactPrompt(input.compactInstructions, input.compactPromptVariant))
      const content = formatCompactSummary(response.content.trim())
      if (content) return { content, usage: response.usage, preTokens: tokenCount }
      sharedUsage = response.usage
    } catch (error) {
      if (input.signal?.aborted) throw error
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error('[compact] shared-prefix summary failed; falling back to text:', error)
      }
    }
  }

  const summary = await summarizeRecordsForContinuation({
    records: recordsToCompact,
    provider: input.provider,
    model: input.model,
    compactRuntime: input.compactRuntime,
    promptCacheRetention: input.promptCacheRetention,
    preTokens: tokenCount,
    compactInstructions: input.compactInstructions,
    compactPromptVariant: input.compactPromptVariant,
    ...(input.attachmentFacts ? { attachmentFacts: input.attachmentFacts } : {}),
    cwd: input.cwd,
  })
  return sharedUsage ? { ...summary, usage: addTokenUsage(sharedUsage, summary.usage) } : summary
}

async function runBeforeCompactHook(input: CompactCheckInput, event: CompactHookEvent): Promise<void> {
  try {
    await input.onBeforeCompact?.(event)
  } catch (hookError) {
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error('[compact] preCompact hook failed:', hookError)
    }
  }
}

async function runAfterCompactHook(
  input: CompactCheckInput,
  event: CompactHookEvent & { summary: string; postTokens: number; compactDurationMs: number },
): Promise<void> {
  try {
    await input.onAfterCompact?.(event)
  } catch (hookError) {
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error('[compact] postCompact hook failed:', hookError)
    }
  }
}

export function resetAutoCompactFailureState(circuitKey?: string): void {
  if (circuitKey) {
    compactFailuresByKey.delete(circuitKey)
    compactRunsByKey.delete(circuitKey)
    return
  }
  compactFailuresByKey.clear()
  compactRunsByKey.clear()
}

function countCurrentTokens(input: CompactCheckInput, compactableRecords: SessionRecord[]): number {
  if (input.lastResponseTokenCount === undefined) {
    return countSessionRecordsTokens(compactableRecords, input.system, input.imageTokenStrategy)
  }

  const pendingTokens = countPendingRecordTokens(input)
  if (pendingTokens === undefined) {
    return countSessionRecordsTokens(compactableRecords, input.system, input.imageTokenStrategy)
  }
  return input.lastResponseTokenCount + pendingTokens
}

function countPendingRecordTokens(input: CompactCheckInput): number | undefined {
  if (input.lastResponseRecordId === undefined && input.lastResponseRecordCount === undefined) return 0

  const boundaryIndex = findLastResponseBoundaryIndex(input)
  if (boundaryIndex === undefined) return undefined

  const pendingRecords = input.records.slice(boundaryIndex + 1)
  let skippedResponseMessage = false

  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordTokens(record, input.imageTokenStrategy)
  }, 0)
}

function findLastResponseBoundaryIndex(input: CompactCheckInput): number | undefined {
  if (input.lastResponseRecordId) {
    const index = input.records.findIndex((record) => record.id === input.lastResponseRecordId)
    return index >= 0 ? index : undefined
  }

  if (input.lastResponseRecordCount === undefined) return undefined
  return input.lastResponseRecordCount - 1
}

async function getCompactFailureCount(input: CompactCheckInput, circuitKey: string): Promise<number> {
  if (!input.getCompactFailureCount) {
    return compactFailuresByKey.get(circuitKey) ?? 0
  }

  try {
    return await input.getCompactFailureCount()
  } catch {
    return compactFailuresByKey.get(circuitKey) ?? 0
  }
}

async function setCompactFailureCount(input: CompactCheckInput, circuitKey: string, count: number): Promise<void> {
  if (count <= 0) {
    compactFailuresByKey.delete(circuitKey)
  } else {
    compactFailuresByKey.set(circuitKey, count)
  }

  if (!input.setCompactFailureCount) return
  try {
    await input.setCompactFailureCount(count)
  } catch {
    // Persistent circuit state is best-effort; compaction must remain fail-open.
  }
}

async function appendCompactFailureRecord(
  input: CompactCheckInput,
  error: unknown,
  failureCount: number,
  tokenCount: number,
): Promise<void> {
  try {
    await input.appendRecord({
      id: randomUUID(),
      type: 'compact_attempt_failed',
      error: formatCompactError(error),
      failureCount,
      circuitOpen: failureCount >= COMPACT_FAILURE_LIMIT,
      preTokens: tokenCount,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  } catch {
    // Telemetry is best-effort; compact failure should not fail the user turn.
  }
}

function hasHistoryBeforeLatestUserMessage(records: SessionRecord[]): boolean {
  return findLastRecordIndex(records, (record) => record.type === 'message' && record.role === 'user') > 0
}

function findLastRecordIndex(records: SessionRecord[], predicate: (record: SessionRecord) => boolean): number {
  for (let index = records.length - 1; index >= 0; index--) {
    const record = records[index]
    if (record && predicate(record)) return index
  }
  return -1
}

export async function summarizeRecordsForContinuation(input: ContinuationSummaryInput): Promise<ContinuationSummaryResult> {
  const tokenCount = input.preTokens ?? countSessionRecordsTokens(input.records)
  // The summary request is text only (design §11.3): images become placeholders
  // naming the attachment, its size and its cache location, so a compact model
  // that cannot see images is still a valid compact model.
  const facts = await resolveAttachmentFactsForRecords(input.records, input.attachmentFacts)
  const content = [
    getCompactPrompt(input.compactInstructions, input.compactPromptVariant),
    '',
    `<pre_compact_tokens>${tokenCount}</pre_compact_tokens>`,
    '<conversation>',
    formatRecordsForSummary(projectRecordsImagesToText(input.records, facts)),
    '</conversation>',
  ].join('\n')

  const message: ChatMessage = {
    id: 'compact-request',
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  }

  const runtime = input.compactRuntime
  const provider = runtime?.provider ?? input.provider
  const model = runtime?.model ?? input.model
  const promptCacheRetention = runtime?.promptCacheRetention ?? input.promptCacheRetention

  const response = await provider.createMessage({
    system: 'You summarize prior conversation context so an agent can continue after compaction.',
    systemBlocks: [
      'You summarize prior conversation context so an agent can continue after compaction.',
    ],
    messages: [message],
    contextItems: [{ kind: 'message', message }],
    tools: [],
    model,
    promptCacheRetention,
    promptCaching: false,
    cacheSource: compactCacheSource(input.cwd),
    retry: { callerKind: 'background', persistent: true },
  })

  return {
    content: formatCompactSummary(response.content.trim()) || '(No compact summary was produced.)',
    usage: response.usage,
    preTokens: tokenCount,
  }
}

function formatRecordsForSummary(records: SessionRecord[]): string {
  return records.map((record) => {
    if (record.type === 'message') {
      return `<message role="${record.role}">\n${record.content}\n</message>`
    }

    if (record.type === 'at_mention_context') {
      return `<at_mention_context user_message_id="${record.userMessageId}">\n${record.content}\n</at_mention_context>`
    }

    if (record.type === 'tool_use') {
      return `<tool_use name="${record.tool}" id="${record.id}">\n${JSON.stringify(record.input ?? {})}\n</tool_use>`
    }

    if (record.type === 'tool_result') {
      return `<tool_result name="${record.tool}" tool_use_id="${record.toolUseId}" ok="${record.ok}">\n${record.content}\n</tool_result>`
    }

    if (record.type === 'compact_boundary') {
      return `<compact_summary>\n${record.summary}\n</compact_summary>`
    }

    if (record.type === 'tool_use_summary') {
      return `<tool_use_summary tool_use_ids="${record.toolUseIds.join(',')}">\n${record.summary}\n</tool_use_summary>`
    }

    if (record.type === 'coordination_update') {
      return `<coordination_update>\n${record.content}\n</coordination_update>`
    }

    if (record.type === 'tool_approval') {
      return `<tool_approval name="${record.tool}" approved="${record.approved}">\n${JSON.stringify(record.input ?? {})}\n</tool_approval>`
    }

    return ''
  }).filter(Boolean).join('\n\n')
}

export function compactBoundaryToMessage(record: CompactBoundaryRecord): ChatMessage {
  return {
    id: record.id,
    role: 'user',
    content: wrapInSystemReminder(`Prior conversation was compacted. Continue from this summary:\n\n${record.summary}`),
    createdAt: record.createdAt,
  }
}

function formatCompactError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
