import type Anthropic from '@anthropic-ai/sdk'
import type { ImageAttachmentRef } from '../../media/types.js'
import type { ChatMessage, ModelContextItem, ModelRequest, RequestImageBytes, ThinkingBlock, Tool } from '../../harness/types.js'
import { getCachedToolSchema } from '../../harness/toolApiSchema.js'
import {
  addCacheBreakpoints,
  type CacheRuntime,
  getCacheControl,
  getPromptCachingEnabled,
  splitSystemForCaching,
  TRANSIENT_MESSAGE_KEY,
} from '../../harness/cacheControl.js'
import {
  ANTHROPIC_CACHE_CONTROL_LIMIT,
  assertAnthropicCacheControlLimit,
  collectCacheControlTelemetry,
} from './cacheControlTelemetry.js'

const MAX_OUTPUT_TOKENS_DEFAULT = 64_000
const MAX_OUTPUT_TOKENS_UPPER_LIMIT = 128_000
const TOOL_SEARCH_BETA = 'advanced-tool-use-2025-11-20'

/**
 * Output limits come from configuration only — `MYAGENT_MAX_OUTPUT_TOKENS`,
 * then `ModelConfig.maxOutputTokens`, then a flat default. Requests truncated
 * at this default get one retry at `ESCALATED_MAX_TOKENS`.
 */
export function getMaxOutputTokens(configValue?: number): number {
  const envValue = process.env.MYAGENT_MAX_OUTPUT_TOKENS
  if (envValue) {
    const parsed = parseInt(envValue, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.min(parsed, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
    }
  }
  const num = typeof configValue === 'number' ? configValue : Number(configValue)
  if (Number.isFinite(num) && num > 0) {
    return Math.min(num, MAX_OUTPUT_TOKENS_UPPER_LIMIT)
  }
  return MAX_OUTPUT_TOKENS_DEFAULT
}

function anthropicContent(content: string): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: content }]
}

/**
 * Base64 image blocks for the refs a user message or tool result carries
 * (design §10.1). The bytes arrive through `ModelRequest.imageBytes`, loaded
 * by the loop only after the final send decision — so by the time they reach
 * this builder, every capability and cap check has already run and these
 * blocks cannot bypass them. A ref without loaded bytes is an invariant
 * violation (the loop blocks or placeholders unloadable refs before the
 * request is built): refusing to build beats silently sending a request that
 * dropped images.
 */
function anthropicImageBlocks(
  images: readonly ImageAttachmentRef[] | undefined,
  imageBytes: Map<string, RequestImageBytes> | undefined,
): Array<Record<string, unknown>> {
  if (!images || images.length === 0) return []
  const blocks: Array<Record<string, unknown>> = []
  for (const ref of images) {
    const loaded = imageBytes?.get(ref.id)
    if (!loaded) {
      throw new Error(
        `Image ${ref.name} (attachment ${ref.id}) has no send bytes loaded for this request; `
        + 'refusing to build a payload that would silently drop it.',
      )
    }
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: loaded.mimeType,
        data: Buffer.from(loaded.bytes).toString('base64'),
      },
    })
  }
  return blocks
}

function anthropicSystemWithCache(request: ModelRequest, enableCaching: boolean): Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> {
  const { staticBlocks, dynamicBlocks } = splitSystemForCaching(
    request.systemBlocks ?? (request.system ? [request.system] : []),
  )
  const staticText = staticBlocks.join('\n\n')
  const blocks: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral'; ttl?: '1h' } }> = []

  if (staticText) {
    blocks.push({
      type: 'text',
      text: staticText,
      ...(enableCaching ? { cache_control: getCacheControl(request.cacheRuntime) } : {}),
    })
  }
  for (const b of dynamicBlocks) {
    blocks.push({ type: 'text', text: b })
  }

  return blocks.filter((b) => b.text.length > 0)
}

/**
 * The opaque replay blocks this request may carry, and nothing else.
 *
 * A thinking signature is bound to the model that produced it: replaying one to
 * a different model or endpoint may be rejected. Both model and the provider's
 * opaque source identity must match; a model alias alone cannot prove origin.
 * Missing provenance is not evidence — an unknown source is treated like a
 * different one and the blocks are dropped.
 *
 * Deliberately narrow: only the opaque blocks go. Assistant text and the
 * tool_use / tool_result pairing stay, so a stripped history remains valid, and
 * while the model has not moved the payload is byte-identical to before — the
 * cached prefix survives. `requestPrep`'s strip-on-model-change runs earlier as
 * the front-line protection; this is the last boundary, for the paths that build
 * a request without going through it (resume, fork, a manual model switch).
 */
function eligibleThinkingBlocks(message: ChatMessage, request: ModelRequest): ThinkingBlock[] {
  const blocks = message.thinkingBlocks
  if (!blocks || blocks.length === 0) return []
  if (!message.model || message.model !== request.model) return []
  if (!message.thinkingSource || !request.thinkingSource || message.thinkingSource !== request.thinkingSource) return []
  return blocks
}

export function buildAnthropicMessages(request: ModelRequest) {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const messages: Array<Record<string, unknown>> = []
  let pendingToolResults: Array<Record<string, unknown>> = []

  for (const item of contextItems) {
    if (item.kind === 'message') {
      if (pendingToolResults.length > 0) {
        messages.push({ role: 'user', content: pendingToolResults })
        pendingToolResults = []
      }
      if (item.message.role !== 'user' && item.message.role !== 'assistant') continue
      // Text blocks keep their empty-string filter; image blocks ride after
      // the text, so a pure-image message survives it instead of being
      // dropped as "empty" (design §10.1).
      const content = [
        ...anthropicContent(item.message.content).filter((block) => block.text.trim() !== ''),
        ...anthropicImageBlocks(item.message.images, request.imageBytes),
      ]

      const replayableThinkingBlocks = item.message.role === 'assistant'
        ? eligibleThinkingBlocks(item.message, request)
        : []
      if (replayableThinkingBlocks.length > 0) {
        const thinkingBlocks = replayableThinkingBlocks.map((block) => {
          if (block.type === 'redacted_thinking') {
            return { type: 'redacted_thinking', data: block.data }
          }
          return { type: 'thinking', thinking: block.thinking ?? '', signature: block.signature ?? '' }
        })
        const merged = [...thinkingBlocks, ...content] as Array<Record<string, unknown>>
        if (merged.length === 0) continue
        messages.push({
          role: item.message.role,
          content: merged,
        })
        continue
      }

      if (content.length === 0) continue
      messages.push({
        role: item.message.role,
        content,
        // Stripped again by addCacheBreakpoints before the payload is sent.
        ...(item.message.transient ? { [TRANSIENT_MESSAGE_KEY]: true } : {}),
      })
      continue
    }

    if (item.kind === 'tool_use') {
      const lastMessage = messages[messages.length - 1]
      const toolUseBlock = {
        type: 'tool_use',
        id: item.id,
        name: item.tool,
        input: item.input,
      }
      if (lastMessage && lastMessage.role === 'assistant') {
        const existingContent = lastMessage.content as unknown[]
        const contentArray = Array.isArray(existingContent)
          ? existingContent
          : typeof existingContent === 'string'
            ? anthropicContent(existingContent)
            : [existingContent]

        const filteredContent = contentArray.filter((block) => {
          if (typeof block === 'string') {
            return block.trim() !== ''
          }
          if (typeof block === 'object' && block !== null && 'text' in block) {
            const text = (block as { text?: unknown }).text
            return typeof text === 'string' && text.trim() !== ''
          }
          return true
        })

        lastMessage.content = [...filteredContent, toolUseBlock]
      } else {
        messages.push({
          role: 'assistant',
          content: [toolUseBlock],
        })
      }
      continue
    }

    // Use pre-mapped API block when available (e.g. tool_reference for ToolSearch),
    // otherwise fall back to plain-text content. Images ride only the plain
    // branch: pre-mapped blocks are ToolSearch schemas and never carry images,
    // so they cannot serve as a path around the shared capability and cap
    // checks the bytes already passed.
    if (item.apiResultBlock) {
      pendingToolResults.push({
        ...(item.apiResultBlock as unknown as Record<string, unknown>),
        is_error: !item.ok,
      })
    } else {
      const imageBlocks = anthropicImageBlocks(item.images, request.imageBytes)
      pendingToolResults.push({
        type: 'tool_result',
        tool_use_id: item.toolUseId,
        // A text-only result stays the string it always was; images upgrade
        // content to a block array, keeping the text (when any) in front.
        content: imageBlocks.length > 0
          ? [
              ...(item.content.trim() === '' ? [] : [{ type: 'text', text: item.content }]),
              ...imageBlocks,
            ]
          : item.content,
        is_error: !item.ok,
      })
    }
  }

  if (pendingToolResults.length > 0) {
    messages.push({ role: 'user', content: pendingToolResults })
  }

  if (messages.length === 0) {
    messages.push({ role: 'user', content: anthropicContent('(context truncated - please continue)') })
  }

  return messages
}

export function buildAnthropicTools(
  tools: Tool[] = [],
  enablePromptCaching = false,
  runtime?: CacheRuntime,
  deferredToolNames?: Set<string>,
) {
  // MCP servers reconnect and ToolSearch discovers tools mid-session, so those
  // schemas churn between requests. Keep them behind the marker: a volatile tool
  // appearing or vanishing then only changes the suffix, leaving the cached
  // built-in prefix (and the system + messages downstream of it) intact.
  const isVolatile = (tool: Tool) => tool.isMcp === true || deferredToolNames?.has(tool.name) === true
  const stable = tools.filter((tool) => !isVolatile(tool))
  const volatile = tools.filter(isVolatile)
  const ordered = [...stable, ...volatile]
  // With no stable tool to anchor to, fall back to the last tool overall.
  const markerIndex = stable.length > 0 ? stable.length - 1 : ordered.length - 1

  return ordered.map((tool, index) => {
    // Get cached base schema (name + description + input_schema)
    const base = getCachedToolSchema(tool)
    // Apply per-request overlays (not cached; vary per call)
    return {
      ...base,
      ...(deferredToolNames?.has(tool.name) ? { defer_loading: true } : {}),
      ...(enablePromptCaching && index === markerIndex
        ? { cache_control: getCacheControl(runtime) }
        : {}),
    }
  })
}

export interface AnthropicPayloadOptions {
  promptCaching?: boolean
  dynamicToolSearch?: boolean
}

export function buildAnthropicPayload(request: ModelRequest, maxOutputTokens?: number, options: AnthropicPayloadOptions = {}) {
  const enableCaching = options.promptCaching !== false && getPromptCachingEnabled()
  const dynamicToolSearch = options.dynamicToolSearch === true && request.hasDeferredTools === true
  // Only tools discovered AFTER the last compaction should have defer_loading.
  // Pre-compact discovered tools have lost their tool_reference blocks in the
  // message history, so the API can't expand them; send them as regular tools.
  const deferLoadingNames = dynamicToolSearch
    ? (request.postCompactDiscoveredNames ?? new Set<string>())
    : undefined
  // ALL deferred tool names from the full (unfiltered) tool list for <available-deferred-tools>.
  const allDeferredNames = request.allDeferredToolNames
  const tools = buildAnthropicTools(request.tools, enableCaching, request.cacheRuntime, deferLoadingNames)
  let messages: Array<Record<string, unknown>> = buildAnthropicMessages(request)
  const systemBlocks = request.systemBlocks ?? (request.system ? [request.system] : [])

  // Announce ALL deferred tool names (not just discovered ones) so the model
  // knows the full set reachable via ToolSearch. The list moves whenever an
  // MCP server connects or drops, so it rides the per-request tail: as the
  // first message, every such change would void the whole cached history.
  if (dynamicToolSearch && allDeferredNames && allDeferredNames.size > 0) {
    const deferredList = [...allDeferredNames].sort().join('\n')
    messages = [
      ...messages,
      {
        role: 'user',
        content: anthropicContent(`<available-deferred-tools>\n${deferredList}\n</available-deferred-tools>`),
        [TRANSIENT_MESSAGE_KEY]: true,
      },
    ]
  }

  // Build thinking config: adaptive by default, or from request
  let thinking: { type: 'adaptive' } | { type: 'enabled'; budget_tokens: number } | undefined
  if (request.thinking?.type === 'enabled') {
    thinking = { type: 'enabled', budget_tokens: request.thinking.budgetTokens }
  } else if (request.thinking?.type === 'disabled') {
    thinking = undefined
  } else {
    // Default: adaptive thinking
    thinking = { type: 'adaptive' }
  }

  const maxOutput = getMaxOutputTokens(maxOutputTokens ?? request.maxOutputTokens)
  const thinkingBudget = thinking?.type === 'enabled' ? thinking.budget_tokens : 0
  const finalMaxOutput = thinkingBudget > 0 && maxOutput <= thinkingBudget
    ? thinkingBudget + 1024
    : maxOutput

  // Build output_config with effort if specified
  const outputConfig = request.effort
    ? { effort: request.effort }
    : undefined

  const payload = {
    model: request.model,
    max_tokens: finalMaxOutput,
    messages: addCacheBreakpoints(messages, enableCaching, request.cacheRuntime) as unknown as Anthropic.Messages.MessageParam[],
    ...(systemBlocks.length > 0
      ? {
          system: anthropicSystemWithCache(request, enableCaching) as unknown as Anthropic.Messages.MessageCreateParams['system'],
        }
      : {}),
    ...(tools.length > 0
      ? {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          tools: tools as any,
        }
      : {}),
    ...(thinking ? { thinking } : {}),
    ...(outputConfig ? { output_config: outputConfig } : {}),
  }

  return finalizeAnthropicCacheControl(payload)
}

export interface AnthropicBetaOptions {
  dynamicToolSearch?: boolean
}

export function getAnthropicBetaHeaders(
  request: ModelRequest,
  options: AnthropicBetaOptions = {},
): string[] {
  const betas: string[] = []
  // Independent of ordinary prompt caching, which does not require beta
  // headers (including the 1-hour TTL).
  if (options.dynamicToolSearch && request.hasDeferredTools) {
    betas.push(TOOL_SEARCH_BETA)
  }
  return betas
}

export function getAnthropicCacheScope(request: ModelRequest, enableCaching = true): string {
  if (!enableCaching || !getPromptCachingEnabled()) return 'disabled'
  return getCacheControl(request.cacheRuntime).ttl === '1h' ? 'ephemeral:1h' : 'ephemeral:5m'
}

export function enforceAnthropicCacheControlLimit<T extends Record<string, unknown>>(payload: T): T {
  let remaining = collectCacheControlTelemetry(payload).total - ANTHROPIC_CACHE_CONTROL_LIMIT
  if (remaining <= 0) return payload

  remaining = removeCacheControlMarkers(payload.tools, remaining)
  remaining = removeCacheControlMarkers(payload.messages, remaining)
  removeCacheControlMarkers(payload.system, remaining)

  return payload
}

function finalizeAnthropicCacheControl<T extends Record<string, unknown>>(payload: T): T {
  enforceAnthropicCacheControlLimit(payload)
  const telemetry = assertAnthropicCacheControlLimit(payload)
  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(`[myagent][prompt-cache] cache_control markers ${JSON.stringify(telemetry)}`)
  }
  return payload
}

function removeCacheControlMarkers(value: unknown, remaining: number): number {
  if (remaining <= 0) return 0
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0 && remaining > 0; index--) {
      remaining = removeCacheControlMarkers(value[index], remaining)
    }
    return remaining
  }
  if (!isRecord(value)) return remaining

  if (Object.hasOwn(value, 'cache_control')) {
    delete value.cache_control
    remaining -= 1
  }

  for (const item of Object.values(value).reverse()) {
    if (remaining <= 0) break
    remaining = removeCacheControlMarkers(item, remaining)
  }

  return remaining
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
