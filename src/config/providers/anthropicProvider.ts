import Anthropic from '@anthropic-ai/sdk'
import type { ModelConfig } from '../service.js'
import type { PromptCachingMode } from '../routing.js'
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, ThinkingBlock } from '../../harness/types.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  requireCacheSource,
} from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { buildAnthropicPayload, getAnthropicBetaHeaders, getAnthropicCacheScope } from './anthropicPayload.js'
import {
  assertFinalImageRequestLimits,
  assertRequestImageCapability,
  resolveImageRequestGuardLimits,
} from './imageRequestGuard.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { normalizeAnthropicUsage } from './usage.js'
import { isExperimentalToolSearchBetaDisabled } from '../../utils/toolSearch.js'
import { getPromptCachingEnabled } from '../../harness/cacheControl.js'
import { USER_AGENT } from '../../utils/userAgent.js'

const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.MYAGENT_STREAM_IDLE_HARD_TIMEOUT_MS || '', 10) || 10 * 60_000
const STREAM_IDLE_WARNING_MS =
  parseInt(
    process.env.MYAGENT_STREAM_IDLE_WARNING_MS
      || process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS
      || '',
    10,
  ) || 90_000

function isUnsupportedPromptCachingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const status = (error as Error & { status?: number }).status
  if (status !== 400 && status !== 422) return false

  return /\bcache_control\b|\bprompt[ _-]cach(?:e|ing)\b/i.test(error.message)
    && /not supported|unsupported|unrecognized|unknown (?:field|parameter|key)|unexpected (?:field|parameter|key|keyword)|extra inputs are not permitted|extra_forbidden|not permitted|not allowed/i.test(error.message)
}

/**
 * Successful uncached fallbacks record endpoint/model rejections for this process.
 * Later sessions, subagents, and routed runtimes reuse those results instead of
 * probing again. Concurrent initial requests may still probe independently until
 * a successful fallback records the rejection.
 */
const rejectedPromptCaching = new Set<string>()

function rejectionKey(endpoint: string, model: string): string {
  return `${endpoint}\u0000${model}`
}

/** Test seam, mirroring `resetCacheBreakDetection`. */
export function resetRejectedPromptCaching(): void {
  rejectedPromptCaching.clear()
}

/** A misconfigured `baseUrl` must not throw out of provider construction. */
function isOfficialAnthropicEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com'
  } catch {
    return false
  }
}

export class AnthropicProvider implements ModelProvider {
  name = 'anthropic'
  /**
   * Adapter image-input capability: the Messages API accepts base64 image
   * blocks. Static so `resolveImageCapability` can read it off the class
   * without building a client; the instance method is what a live request
   * path consults.
   */
  static readonly supportsImageInput = true
  private client: Anthropic
  /** Captured up front: tests replace `client` with a stub that has no `baseURL`. */
  private readonly endpoint: string
  private maxOutputTokens: number | undefined
  private readonly nativeToolSearch: boolean
  private readonly promptCaching: PromptCachingMode
  /** Static per model, like `maxOutputTokens` — not a per-request decision. */
  private longContext1m: boolean
  /**
   * The model-config half of image capability, snapshotted at construction
   * (providers are rebuilt per model switch). Combined with the adapter's own
   * flag this reproduces `resolveImageCapability` exactly — the registry's
   * function cannot be imported here without an import cycle, and the two
   * facts it reads are this class's own static and this switch.
   */
  private readonly imageInputEnabled: boolean

  constructor(config: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: { 'User-Agent': USER_AGENT },
    })
    this.endpoint = this.client.baseURL
    this.maxOutputTokens = config.maxOutputTokens
    this.nativeToolSearch = isOfficialAnthropicEndpoint(this.endpoint)
    this.promptCaching = config.promptCaching ?? 'auto'
    this.longContext1m = config.longContext1m === true
    this.imageInputEnabled = config.supportsImageInput === true
  }

  supportsDynamicToolSearch(): boolean {
    return this.nativeToolSearch && !isExperimentalToolSearchBetaDisabled()
  }

  supportsImageInput(): boolean {
    return AnthropicProvider.supportsImageInput
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    // Final capability re-check (design §11.1): runs before any attempt is
    // made, so a bypassed call path fails once, loudly, without retries.
    assertRequestImageCapability(request, this.imageInputEnabled && this.supportsImageInput())
    return withRetry(
      async (attempt) => {
        const key = rejectionKey(this.endpoint, request.model)
        const enableCaching = this.promptCaching !== 'off'
          && request.promptCaching !== false
          && getPromptCachingEnabled()
          && (this.promptCaching === 'on' || !rejectedPromptCaching.has(key))

        try {
          return await this.sendMessage(request, attempt, enableCaching)
        } catch (error) {
          if (!enableCaching || this.promptCaching !== 'auto' || !isUnsupportedPromptCachingError(error)) {
            throw error
          }
          if (request.retry?.signal?.aborted) throw error

          // Only an uncached request that actually succeeds proves the rejection
          // was about caching. Proxies echo the request body into error messages,
          // so an unrelated 400 can mention `cache_control` by accident.
          const response = await this.sendMessage(request, attempt, false)
          rejectedPromptCaching.add(key)
          if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
            console.error(`[myagent][prompt-cache] ${request.model} rejected prompt caching; retrying without cache_control`)
          }
          return response
        }
      },
      {
        maxRetries: request.retry?.maxRetries,
        callerKind: request.retry?.callerKind ?? 'interactive',
        persistent: request.retry?.persistent,
        signal: request.retry?.signal,
        onRetry: ({ attempt, category, delayMs }) =>
          request.onStreamEvent?.({ type: 'retry', attempt, reason: category, delayMs }),
      },
    )
  }

  private async sendMessage(request: ModelRequest, attempt: number, enableCaching: boolean): Promise<ModelResponse> {
    const dynamicToolSearch = this.supportsDynamicToolSearch()
    const payload = buildAnthropicPayload(request, this.maxOutputTokens, {
      promptCaching: enableCaching,
      dynamicToolSearch,
    })
    // The final pre-send check (design §11.1 step 5): per-image bytes, image
    // count, and the whole serialized body, against the stricter of the local
    // policy and this adapter's declared limits. Throws before any debug log
    // or network call; retry classification treats it as non-retryable.
    assertFinalImageRequestLimits(payload, request, resolveImageRequestGuardLimits(this))
    const cacheSource = requireCacheSource(request.cacheSource)
    // Hash the exact beta headers and cache policy sent on every attempt,
    // including the request rebuilt after a compatibility fallback.
    const betas = getAnthropicBetaHeaders(request, {
      dynamicToolSearch,
      longContext1m: this.longContext1m,
    })
    recordPromptState({
      system: JSON.stringify(payload.system ?? ''),
      toolsJson: JSON.stringify(payload.tools ?? []),
      model: request.model,
      betas,
      cacheScope: getAnthropicCacheScope(request, enableCaching),
      messages: payload.messages,
    }, cacheSource)
    if (attempt > 1) {
      debugProviderPayload('anthropic-retry', payload, request)
    }
    debugProviderSummary('anthropic', request, payload, betas)
    debugProviderPayload('anthropic', payload, request)

    const stream = this.client.messages.stream(
      payload as unknown as Anthropic.Messages.MessageStreamParams,
      betas.length > 0
        ? { headers: { 'anthropic-beta': betas.join(',') } as Record<string, string> }
        : undefined,
    )
    const response = await streamWithTimeout(
      stream,
      request.retry?.signal,
      STREAM_IDLE_TIMEOUT_MS,
      request.onTextDelta,
      request.onStreamEvent,
      STREAM_IDLE_WARNING_MS,
    )

    debugProviderResponse('anthropic', response)
    const parsed = this.parseResponse(response)
    const cacheReadTokens = response.usage?.cache_read_input_tokens
    // Compatible endpoints may omit cache usage. Missing data must not be
    // committed as a zero hit or classified as an eviction.
    const cacheBreak = typeof cacheReadTokens === 'number' && Number.isFinite(cacheReadTokens)
      ? checkResponseForCacheBreak(cacheReadTokens, parsed.usage?.inputTokens ?? 0, cacheSource)
      : null
    return {
      ...parsed,
      ...(cacheBreak ? { cacheBreak } : {}),
    }
  }

  private parseResponse(response: Anthropic.Messages.Message): ModelResponse {
    // Concatenate ALL text blocks — the API can return multiple text blocks
    // (e.g., text before and after tool use in the same message).
    const textBlocks = response.content.filter((c) => c.type === 'text')
    const toolUses = response.content.filter((c) => c.type === 'tool_use')
    const thinkingBlocks: ThinkingBlock[] = response.content
      .filter((c) => c.type === 'thinking' || c.type === 'redacted_thinking')
      .map((c) => {
        if (c.type === 'thinking') {
          return {
            type: 'thinking' as const,
            thinking: (c as { thinking?: string }).thinking ?? '',
            signature: (c as { signature?: string }).signature ?? '',
          }
        }
        return {
          type: 'redacted_thinking' as const,
          data: (c as { data?: string }).data ?? '',
        }
      })

    let textContent = textBlocks.map((c) => c.type === 'text' ? c.text : '').join('')

    if (toolUses.length > 0 && textContent.trim() === '') {
      textContent = ''
    }

    return {
      content: textContent,
      toolCalls: toolUses.map((c) => {
        if (c.type !== 'tool_use') throw new Error('Unexpected content type')
        let input = c.input
        if (typeof input === 'string') {
          try { input = JSON.parse(input) } catch { /* keep as-is */ }
        }
        return {
          id: c.id,
          name: c.name,
          input,
        }
      }),
      usage: normalizeAnthropicUsage(response.usage),
      requestId: response.id,
      stopReason: response.stop_reason ?? undefined,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    }
  }

}

type AnthropicMessageStream = {
  finalMessage: () => Promise<Anthropic.Messages.Message>
  abort: () => void
  on: (event: 'streamEvent', listener: (...args: unknown[]) => void) => unknown
  off: (event: 'streamEvent', listener: (...args: unknown[]) => void) => unknown
}

export async function streamWithTimeout(
  stream: AnthropicMessageStream,
  signal?: AbortSignal,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  onTextDelta?: (delta: string) => void,
  onStreamEvent?: (event: ModelStreamEvent) => void,
  idleWarningMs = STREAM_IDLE_WARNING_MS,
): Promise<Anthropic.Messages.Message> {
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  const resetTimer = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    if (idleWarningMs > 0 && idleWarningMs < idleTimeoutMs) {
      warningTimer = setTimeout(() => {
        onStreamEvent?.({ type: 'idle_warning', idleMs: idleWarningMs })
      }, idleWarningMs)
    }
    timeoutTimer = setTimeout(() => {
      stream.abort()
      rejectTimeout(new Error('Stream idle timeout'))
    }, idleTimeoutMs)
  }
  let rejectTimeout: (error: Error) => void = () => {}
  const timeoutPromise = new Promise<never>((_, reject) => {
    rejectTimeout = reject
  })
  const blockTypes = new Map<number, string>()
  const toolNames = new Map<number, string>()
  const handleStreamEvent = (event: unknown) => {
    resetTimer()
    for (const modelEvent of extractModelStreamEvents(event, blockTypes, toolNames)) {
      if (modelEvent.type === 'text_delta') onTextDelta?.(modelEvent.text)
      onStreamEventCallback?.(modelEvent)
    }
  }
  const onStreamEventCallback = onStreamEvent
  stream.on('streamEvent', handleStreamEvent)
  resetTimer()

  let onAbort: (() => void) | undefined
  const abortPromise = signal
    ? new Promise<never>((_, reject) => {
        if (signal.aborted) {
          stream.abort()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
          return
        }
        onAbort = () => {
          stream.abort()
          reject(new DOMException('The operation was aborted.', 'AbortError'))
        }
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  try {
    const racers: Promise<Anthropic.Messages.Message>[] = [stream.finalMessage(), timeoutPromise]
    if (abortPromise) racers.push(abortPromise)
    return await Promise.race(racers)
  } finally {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
    stream.off('streamEvent', handleStreamEvent)
    if (signal && onAbort) signal.removeEventListener('abort', onAbort)
  }
}

function extractModelStreamEvents(
  event: unknown,
  blockTypes: Map<number, string>,
  toolNames: Map<number, string>,
): ModelStreamEvent[] {
  if (!event || typeof event !== 'object') return []
  const events: ModelStreamEvent[] = []
  const typed = event as {
    type?: unknown
    index?: unknown
    content_block?: {
      type?: unknown
      name?: unknown
    }
    delta?: {
      type?: unknown
      text?: unknown
      thinking?: unknown
      signature?: unknown
      partial_json?: unknown
    }
  }
  const index = typeof typed.index === 'number' ? typed.index : undefined

  if (typed.type === 'message_start') {
    return [{ type: 'message_start' }]
  }
  if (typed.type === 'message_stop') {
    return [{ type: 'message_stop' }]
  }

  if (typed.type === 'content_block_start') {
    const blockType = typeof typed.content_block?.type === 'string'
      ? typed.content_block.type
      : undefined
    if (index !== undefined && blockType) blockTypes.set(index, blockType)
    if (index !== undefined && blockType === 'tool_use' && typeof typed.content_block?.name === 'string') {
      toolNames.set(index, typed.content_block.name)
    }
    if (blockType === 'thinking') {
      events.push({ type: 'thinking_start', index, redacted: false })
    } else if (blockType === 'redacted_thinking') {
      events.push({ type: 'thinking_start', index, redacted: true })
      events.push({ type: 'redacted_thinking', index })
    }
    return events
  }

  if (typed.type === 'content_block_delta') {
    if (typed.delta?.type === 'text_delta' && typeof typed.delta.text === 'string' && typed.delta.text.length > 0) {
      events.push({ type: 'text_delta', index, text: typed.delta.text })
    } else if (typed.delta?.type === 'thinking_delta' && typeof typed.delta.thinking === 'string' && typed.delta.thinking.length > 0) {
      events.push({ type: 'thinking_delta', index, thinking: typed.delta.thinking })
    } else if (typed.delta?.type === 'signature_delta' && typeof typed.delta.signature === 'string') {
      events.push({ type: 'thinking_signature', index, signature: typed.delta.signature })
    } else if (typed.delta?.type === 'input_json_delta' && typeof typed.delta.partial_json === 'string' && typed.delta.partial_json.length > 0) {
      const name = index === undefined ? undefined : toolNames.get(index)
      events.push({ type: 'tool_input_delta', index, ...(name === undefined ? {} : { name }), partialJson: typed.delta.partial_json })
    }
    return events
  }

  if (typed.type === 'content_block_stop') {
    const blockType = index === undefined ? undefined : blockTypes.get(index)
    if (index !== undefined) {
      blockTypes.delete(index)
      toolNames.delete(index)
    }
    if (blockType === 'thinking' || blockType === 'redacted_thinking') {
      events.push({ type: 'thinking_stop', index })
    }
    return events
  }

  return events
}
