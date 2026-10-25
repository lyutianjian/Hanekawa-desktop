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

export const MODEL_CONTEXT_WINDOW_DEFAULT = 272_000
/** One-shot escalation when a response is truncated by `max_tokens`. */
export const ESCALATED_MAX_TOKENS = 128_000
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000
export const AUTOCOMPACT_RESERVE_RATIO = 0.083
/** Room for the compact prompt itself, on top of the summary's output. */
export const COMPACT_PROMPT_RESERVE_TOKENS = 2_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
export const MICROCOMPACT_THRESHOLD_RATIO = 0.9
/** Slack left between a planned request and the window it must fit. */
export const CONTEXT_SAFETY_BUFFER_TOKENS = 1_000
export const TIME_BASED_MC_GAP_THRESHOLD_MINUTES = 60
export const TIME_BASED_MC_KEEP_RECENT = 5

export interface ContextManagementConfig {
  contextWindow: number
  summaryOutputTokens: number
  /** Share of the raw window kept free below the autocompact threshold. */
  autoCompactReserveRatio: number
  manualCompactBufferTokens: number
  microCompactThresholdRatio: number
}

export const DEFAULT_CONTEXT_MANAGEMENT: ContextManagementConfig = {
  contextWindow: MODEL_CONTEXT_WINDOW_DEFAULT,
  summaryOutputTokens: MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  autoCompactReserveRatio: AUTOCOMPACT_RESERVE_RATIO,
  manualCompactBufferTokens: MANUAL_COMPACT_BUFFER_TOKENS,
  microCompactThresholdRatio: MICROCOMPACT_THRESHOLD_RATIO,
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

/**
 * The raw window minus the reserve ratio's share, but never less reserve than
 * the compaction request needs: it sends the whole context plus the compact
 * prompt and gets the summary back in the same window.
 */
export function getAutoCompactThreshold(
  config: Partial<ContextManagementConfig> = {},
): number {
  const merged = { ...DEFAULT_CONTEXT_MANAGEMENT, ...config }
  const reserve = Math.max(
    Math.ceil(merged.contextWindow * merged.autoCompactReserveRatio),
    merged.summaryOutputTokens + COMPACT_PROMPT_RESERVE_TOKENS,
  )
  return Math.max(0, merged.contextWindow - reserve)
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
  return Math.ceil(textTokenWeight(text))
}

/** {@link countTextTokens} unrounded, so pieces of one text can be summed without a ceiling each. */
export function textTokenWeight(text: string): number {
  const asciiChars = text.replace(/[^\x00-\x7F]/g, '').length
  const nonAsciiChars = text.length - asciiChars
  return asciiChars / 3.0 + nonAsciiChars / 1.2
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

/** A declared tool schema as the provider receives it. */
export interface ToolSchemaCost {
  name: string
  description?: string
  inputSchema?: unknown
}

/** Fixed request content, including any inherited history prefix, in tokens. */
export interface RequestOverhead {
  /** The composed system prompt plus the instruction block counted into it. */
  systemTokens: number
  toolSchemaTokens: number
  total: number
}

export function countToolSchemasTokens(tools: readonly ToolSchemaCost[]): number {
  let total = 0
  for (const tool of tools) {
    total += textTokenWeight(`${tool.name}\n${tool.description ?? ''}\n${JSON.stringify(tool.inputSchema ?? {})}`)
  }
  return Math.ceil(total)
}

/**
 * The one place a request's fixed cost is measured, so the compaction decision
 * and the request builder cannot disagree about what history may spend.
 */
export function requestOverhead(input: { system?: string; tools?: readonly ToolSchemaCost[]; prefixTokens?: number }): RequestOverhead {
  const systemTokens = input.system ? countTextTokens(input.system) : 0
  const toolSchemaTokens = input.tools?.length ? countToolSchemasTokens(input.tools) : 0
  return { systemTokens, toolSchemaTokens, total: systemTokens + toolSchemaTokens + Math.max(0, input.prefixTokens ?? 0) }
}

/** The window history may spend once the request's fixed parts are paid for. */
export function getAvailableTokensForOverhead(
  config: Partial<ContextManagementConfig> = {},
  overheadTokens: number,
): number {
  return getEffectiveContextWindowSize(config) - Math.max(0, overheadTokens) - CONTEXT_SAFETY_BUFFER_TOKENS
}

export function getAvailableContextTokens(
  config: Partial<ContextManagementConfig> = {},
  system?: string,
  tools?: readonly ToolSchemaCost[],
): number {
  return getAvailableTokensForOverhead(config, requestOverhead({ system, tools }).total)
}

export function selectMessagesForContext(
  messages: ChatMessage[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
  tools?: readonly ToolSchemaCost[],
): ChatMessage[] {
  const availableTokens = getAvailableContextTokens(config, system, tools)

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
  tools?: readonly ToolSchemaCost[],
): ModelContextItem[] {
  return planContextItems(items, config, system, tools).items
}

/**
 * What a request will carry, and what it cannot give up.
 *
 * Trimming walks from the newest item backwards, so an over-budget request used
 * to lose its oldest items first — which is exactly where a compaction summary
 * and the continuation restored with it sit. They are marked `pinned`: they are
 * counted first and never trimmed while a trimmable item is left. `overflowTokens`
 * reports the case no trimming can solve — the pinned content alone is larger
 * than the window — so the caller can compact or stop instead of sending a
 * request the model would answer with the wrong task in mind.
 */
export interface ContextSelectionPlan {
  items: ModelContextItem[]
  availableTokens: number
  pinnedTokens: number
  overflowTokens: number
  /**
   * What the budget dropped, identified by record where one exists. Kept on
   * the plan rather than recomputed by the caller: this is the only point that
   * still holds both the full list and the kept one.
   */
  trimmed: TrimmedItems
}

export interface TrimmedItems {
  count: number
  /** Capped: a log line naming every old tool result is not a log line. */
  ids: string[]
}

/** How many dropped items a plan names. The count still reports all of them. */
const MAX_TRIMMED_IDS = 20

export function planContextItems(
  items: ModelContextItem[],
  config: Partial<ContextManagementConfig> = {},
  system?: string,
  tools?: readonly ToolSchemaCost[],
  imageTokenStrategy: ImageTokenStrategy = DEFAULT_IMAGE_TOKEN_STRATEGY,
  prefixTokens = 0,
): ContextSelectionPlan {
  const availableTokens = getAvailableTokensForOverhead(config, requestOverhead({ system, tools, prefixTokens }).total)
  const pinned = items.filter(isPinnedItem)
  const pinnedTokens = pinned.reduce((sum, item) => sum + countContextItemTokens(item, imageTokenStrategy), 0)
  // Pinned content must survive even when the fixed request leaves no budget;
  // the caller reports capacity failure instead of sending an incomplete task.
  const overflowTokens = Math.max(0, pinnedTokens - Math.max(0, availableTokens))

  if (availableTokens <= 0) {
    const lastUserItem = [...items].reverse().find(
      (item) => item.kind === 'message' && item.message.role === 'user',
    )
    const kept = new Set(pinned)
    if (lastUserItem) kept.add(lastUserItem)
    const itemsKept = items.filter((item) => kept.has(item))
    return {
      items: itemsKept,
      availableTokens,
      pinnedTokens,
      overflowTokens,
      trimmed: describeTrimmed(items, itemsKept),
    }
  }

  const kept = new Set(pinned)
  let used = pinnedTokens
  let keptTrimmable = 0

  for (const item of [...items].reverse()) {
    if (kept.has(item)) continue
    const tokens = countContextItemTokens(item, imageTokenStrategy)
    if (used + tokens > availableTokens) {
      if (keptTrimmable > 0) break
      continue
    }
    kept.add(item)
    used += tokens
    keptTrimmable += 1
  }

  const itemsKept = repairToolPairing(items.filter((item) => kept.has(item)))
  return {
    items: itemsKept,
    availableTokens,
    pinnedTokens,
    overflowTokens,
    trimmed: describeTrimmed(items, itemsKept),
  }
}

function isPinnedItem(item: ModelContextItem): boolean {
  return item.kind === 'message' && item.pinned === true
}

/** What the plan dropped, named by record id where the item has one. */
function describeTrimmed(
  items: readonly ModelContextItem[],
  keptItems: readonly ModelContextItem[],
): TrimmedItems {
  const kept = new Set(keptItems)
  const ids: string[] = []
  let count = 0
  for (const item of items) {
    if (kept.has(item)) continue
    count += 1
    if (ids.length < MAX_TRIMMED_IDS) ids.push(itemIdentifier(item))
  }
  return { count, ids }
}

function itemIdentifier(item: ModelContextItem): string {
  if (item.kind === 'tool_use') return `tool_use:${item.id}`
  if (item.kind === 'tool_result') return `tool_result:${item.toolUseId}`
  return `message:${item.message.role}:${item.message.id}`
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

  if (record.type === 'coordination_update' || record.type === 'memory_update') {
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
