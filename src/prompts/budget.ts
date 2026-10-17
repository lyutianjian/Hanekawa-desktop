import type { ChatMessage, ModelContextItem, SessionRecord } from '../harness/types.js'
import {
  countImageTokens,
  DEFAULT_IMAGE_TOKEN_STRATEGY,
  type ImageTokenStrategy,
} from '../media/imageTokens.js'

export interface TokenCount {
  total: number
  messages: number[]
}

export const MODEL_CONTEXT_WINDOW_DEFAULT = 200_000
/** One-shot escalation when a response is truncated by `max_tokens`. */
export const ESCALATED_MAX_TOKENS = 128_000
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9
export const AUTOCOMPACT_THRESHOLD_RATIO = 0.93
export const TIME_BASED_MC_GAP_THRESHOLD_MINUTES = 60
export const TIME_BASED_MC_KEEP_RECENT = 5

export interface ContextManagementConfig {
  contextWindow: number
  summaryOutputTokens: number
  autoCompactBufferTokens: number
  manualCompactBufferTokens: number
  microCompactThresholdRatio: number
  autoCompactThresholdRatio: number
}

export const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementConfig = {
  contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
  summaryOutputTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  autoCompactBufferTokens: AUTOCOMPACT_BUFFER_TOKENS,
  manualCompactBufferTokens: MANUAL_COMPACT_BUFFER_TOKENS,
  microCompactThresholdRatio: MICROCOMPACT_THRESHOLD_RATIO,
  autoCompactThresholdRatio: AUTOCOMPACT_THRESHOLD_RATIO,
}

/**
 * Returns the configured raw context window size (no output token subtraction).
 * Provider/model configuration is the sole source of model-specific limits;
 * callers that do not provide one use the 200k default in the merged config.
 */
export function getContextWindowForModel(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return merged.contextWindow
}

/**
 * Returns the effective context window (raw window minus reserved output tokens).
 * Used for compact thresholds and context budget calculations.
 */
export function getEffectiveContextWindowSize(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  const contextWindow = getContextWindowForModel(config)
  return Math.max(0, contextWindow - merged.summaryOutputTokens)
}

export function getAutoCompactThreshold(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  const effectiveContextWindow = getEffectiveContextWindowSize(merged)
  const ratioThreshold = Math.floor(effectiveContextWindow * merged.autoCompactThresholdRatio)
  const bufferThreshold = effectiveContextWindow - merged.autoCompactBufferTokens
  return Math.max(0, Math.min(ratioThreshold, bufferThreshold))
}

export function getMicroCompactThreshold(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, Math.floor(getEffectiveContextWindowSize(merged) * merged.microCompactThresholdRatio))
}

export function getManualCompactThreshold(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  return Math.max(0, getEffectiveContextWindowSize(merged) - merged.manualCompactBufferTokens)
}

export function countTextTokens(text: string): number {
  // Conservative estimate that intentionally compacts early to avoid exceeding
  // the context window. Claude Code uses content.length / 4 with a 4/3 safety
  // multiplier (~length / 3). We use per-character-class ratios instead:
  //   ASCII:  ~3 chars/token  (code, JSON, Markdown — denser than English)
  //   non-ASCII: ~1.2 chars/token  (CJK characters typically 1-2 chars/token)
  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length
  const nonAsciiChars = text.length - asciiChars
  return Math.ceil(asciiChars / 3.0 + nonAsciiChars / 1.2)
}

/**
 * Message cost: its text plus its images. Image cost comes from the sent
 * dimensions the refs describe, under the serving model's estimation strategy
 * — never from path length or Base64 length (design §11.2). Without a
 * strategy the conservative estimate applies, so an unnamed model never reads
 * as cheaper than a real provider might charge.
 */
export function countMessageTokens(
  message: ChatMessage,
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
): number {
  return countTextTokens(message.content)
    + countReasoningReplayTokens(message)
    + countImageTokens(message.images, imageTokenStrategy)
}

/** Reasoning an assistant message hands back to its provider: outside `content`, but in the request. */
function countReasoningReplayTokens(message: ChatMessage): number {
  // Responses items also repeat the message text and tool calls, which are counted elsewhere.
  const opaque = message.responseItems?.filter((item) => (item as { type?: unknown }).type === 'reasoning')
    ?? message.reasoningDetails
  if (opaque?.length) return countTextTokens(JSON.stringify(opaque))
  return countTextTokens(message.reasoningContent ?? '')
    + (message.thinkingBlocks ?? []).reduce((sum, block) => sum + countTextTokens(block.thinking ?? block.data ?? ''), 0)
}

export function countMessagesTokens(
  messages: ChatMessage[],
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
): TokenCount {
  const counts = messages.map((message) => countMessageTokens(message, imageTokenStrategy))
  return {
    total: counts.reduce((a, b) => a + b, 0),
    messages: counts,
  }
}

export function getAvailableContextTokens(
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): number {
  const systemTokens = system ? countTextTokens(system) : 0
  return getEffectiveContextWindowSize(config) - systemTokens - 1000
}

export function selectMessagesForContext(
  messages: ChatMessage[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): ChatMessage[] {
  const availableTokens = getAvailableContextTokens(config, system)

  if (availableTokens <= 0) {
    return []
  }

  const result: ChatMessage[] = []
  let used = 0

  for (const message of messages) {
    const tokens = countMessageTokens(message)
    if (used + tokens > availableTokens) {
      break
    }
    result.push(message)
    used += tokens
  }

  return result
}

export function selectContextItemsForContext(
  items: ModelContextItem[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
): ModelContextItem[] {
  const availableTokens = getAvailableContextTokens(config, system)

  if (availableTokens <= 0) {
    const lastUserItem = [...items].reverse().find(
      (item) => item.kind === 'message' && item.message.role === 'user',
    )
    return lastUserItem ? [lastUserItem] : []
  }

  const result: ModelContextItem[] = []
  let used = 0

  for (const item of [...items].reverse()) {
    const tokens = countContextItemTokens(item)
    if (used + tokens > availableTokens) {
      if (result.length > 0) break
      continue
    }
    result.push(item)
    used += tokens
  }

  return repairToolPairing(result.reverse())
}

export function countContextItemTokens(
  item: ModelContextItem,
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
): number {
  if (item.kind === 'message') {
    return countMessageTokens(item.message, imageTokenStrategy)
  }

  if (item.kind === 'tool_use') {
    return countTextTokens(`${item.tool}\n${JSON.stringify(item.input ?? {})}`)
  }

  return countTextTokens(`${item.tool}\n${item.content}`)
    + countImageTokens(item.images, imageTokenStrategy)
}

export function countSessionRecordTokens(
  record: SessionRecord,
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
): number {
  if (record.type === 'message') {
    return countMessageTokens(record, imageTokenStrategy)
  }

  if (record.type === 'at_mention_context') {
    return countTextTokens(record.content)
  }

  if (record.type === 'tool_use') {
    return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`)
  }

  if (record.type === 'tool_result') {
    // `_tokens` caches the *text* cost only. Image cost is cheap arithmetic on
    // the refs and strategy-dependent, so it is always computed live on top of
    // the cache — a cache written before images existed, or under a different
    // model, never reads as the whole count (design §11.2).
    const textTokens = typeof record._tokens === 'number'
      ? record._tokens
      : countTextTokens(`${record.tool}\n${record.content}`)
    return textTokens + countImageTokens(record.images, imageTokenStrategy)
  }

  if (record.type === 'compact_boundary') {
    return countTextTokens(record.summary) + (record.restoredContext ? countTextTokens(record.restoredContext) : 0)
  }

  if (record.type === 'tool_approval') {
    return countTextTokens(`${record.tool}\n${JSON.stringify(record.input ?? {})}`)
  }

  if (record.type === 'coordination_update') {
    return countTextTokens(record.content)
  }

  if (record.type === 'tool_use_summary') {
    return countTextTokens(record.summary)
  }

  if (record.type === 'turn_interruption') {
    return countTextTokens(`${record.prompt}\n${JSON.stringify(record.remainingTasks)}`)
  }

  return 0
}

export function countSessionRecordsTokens(
  records: SessionRecord[],
  system?: string,
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
): number {
  return records.reduce(
    (sum, record) => sum + countSessionRecordTokens(record, imageTokenStrategy),
    system ? countTextTokens(system) : 0,
  )
}

function repairToolPairing(items: ModelContextItem[]): ModelContextItem[] {
  const toolUseIds = new Set(
    items
      .filter((item): item is ModelContextItem & { kind: 'tool_use' } => item.kind === 'tool_use')
      .map((item) => item.id),
  )
  const toolResultIds = new Set(
    items
      .filter((item): item is ModelContextItem & { kind: 'tool_result' } => item.kind === 'tool_result')
      .map((item) => item.toolUseId),
  )

  return items.filter((item) => {
    if (item.kind === 'tool_use') return toolResultIds.has(item.id)
    if (item.kind === 'tool_result') return toolUseIds.has(item.toolUseId)
    return true
  })
}
