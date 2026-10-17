import OpenAI from 'openai'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, ToolCall } from '../../harness/types.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  requireCacheSource,
  type CacheBreakResult,
} from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { safeJsonParse } from '../../utils/json.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { buildOpenAIPayload, getOpenAICacheScope } from './openaiPayload.js'
import { chatThinkingParams, resolveChatCompat, sendWithCacheKeyFallback, sendWithThinkingFallback, wantsThinking } from './openaiCompat.js'
import { consumeWithIdleTimeout } from './streamIdle.js'
import {
  assertFinalImageRequestLimits,
  assertRequestImageCapability,
  redactImageBytesFromText,
  resolveImageRequestGuardLimits,
} from './imageRequestGuard.js'
import { normalizeOpenAIUsage } from './usage.js'

export class OpenAIProvider implements ModelProvider {
  name = 'openai'
  /**
   * Adapter image-input capability: Chat Completions accepts `image_url` data
   * URLs in user content. Static so `resolveImageCapability` can read it off
   * the class without building a client; the instance method is what a live
   * request path consults.
   */
  static readonly supportsImageInput = true
  private client: OpenAI
  /**
   * The model-config half of image capability, snapshotted at construction.
   * Combined with the adapter's own flag this reproduces
   * `resolveImageCapability` exactly (see AnthropicProvider's note on why the
   * registry function itself cannot be imported here).
   */
  private readonly imageInputEnabled: boolean
  private readonly thinkingOff: boolean
  private readonly thinkingFormat: string | undefined

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      // withRetry owns retries; SDK retries would multiply its budget.
      maxRetries: 0,
    })
    this.imageInputEnabled = config.supportsImageInput === true
    this.thinkingOff = config.thinking?.type === 'disabled'
    this.thinkingFormat = config.thinkingFormat
  }

  supportsDynamicToolSearch(): boolean {
    return false
  }

  supportsImageInput(): boolean {
    return OpenAIProvider.supportsImageInput
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    // Final capability re-check (design §11.1): runs before any attempt is
    // made, so a bypassed call path fails once, loudly, without retries.
    assertRequestImageCapability(request, this.imageInputEnabled && this.supportsImageInput())
    const compat = resolveChatCompat(this.client.baseURL, this.thinkingFormat)
    const thinking = wantsThinking(request, this.thinkingOff) ? 'on' as const : 'off' as const
    const thinkingFields = Object.keys(chatThinkingParams(compat.thinkingFormat, thinking === 'on', request.effort))
    const key = `${this.client.baseURL}\0${request.model}`
    return withRetry(
      (attempt) => sendWithCacheKeyFallback(key, request, (cacheKey) => sendWithThinkingFallback(
        key,
        thinkingFields,
        request,
        (withThinking) => this.sendMessage(request, attempt, { compat, cacheKey, ...(withThinking ? { thinking } : {}) }),
      )),
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

  private async sendMessage(
    request: ModelRequest,
    attempt: number,
    options: Parameters<typeof buildOpenAIPayload>[1],
  ): Promise<ModelResponse> {
    const payload = buildOpenAIPayload(request, options)
    // The final pre-send check (design §11.1 step 5): per-image bytes, image
    // count, and the whole serialized body. Throws before any debug log or
    // network call; retry classification treats it as non-retryable.
    assertFinalImageRequestLimits(payload, request, resolveImageRequestGuardLimits(this))
    const cacheSource = requireCacheSource(request.cacheSource)
    recordPromptState({
      system: JSON.stringify(getOpenAISystemFromPayload(payload)),
      toolsJson: JSON.stringify(getOpenAIToolsFromPayload(payload)),
      model: String(payload.model ?? request.model),
      cacheScope: getOpenAICacheScope(request),
      firstMessage: request.messages[0]?.content,
      messages: payload.messages,
    }, cacheSource)
    if (attempt > 1) {
      debugProviderPayload('openai-retry', payload, request)
    }
    debugProviderSummary('openai', request, payload)
    debugProviderPayload('openai', payload, request)

    const collector = new ChatStreamCollector(request)
    try {
      const stream = await this.client.chat.completions.create(
        payload as OpenAI.Chat.ChatCompletionCreateParamsStreaming,
        request.retry?.signal ? { signal: request.retry.signal } : undefined,
      )
      await consumeWithIdleTimeout(stream, (chunk) => collector.add(chunk), request.onStreamEvent)
    } catch (error) {
      throw augmentImageEndpointRejection(error, request, this.client.baseURL)
    }
    const response = collector.finish()
    debugProviderResponse('openai', response)

    let cacheBreak: CacheBreakResult | null = null
    if (response.usage) {
      cacheBreak = checkResponseForCacheBreak(
        response.usage.cacheReadInputTokens,
        response.usage.inputTokens,
        cacheSource,
      )
    }
    return { ...response, ...(cacheBreak ? { cacheBreak } : {}) }
  }
}

interface PartialToolCall {
  id: string
  name: string
  arguments: string
}

/** OpenRouter streams `reasoning_details` in fragments; consecutive text or summary pieces are one entry. */
function appendReasoningDetail(details: Record<string, unknown>[], detail: Record<string, unknown>): void {
  const last = details[details.length - 1]
  for (const field of ['text', 'summary'] as const) {
    if (
      last && last.type === detail.type && last.index === detail.index
      && typeof last[field] === 'string' && typeof detail[field] === 'string'
    ) {
      details[details.length - 1] = { ...detail, ...last, [field]: (last[field] as string) + (detail[field] as string) }
      return
    }
  }
  details.push({ ...detail })
}

/**
 * Folds a Chat Completions stream into one response, emitting the same
 * `ModelStreamEvent`s the Anthropic stream does. Compatible servers carry the
 * reasoning text under whichever of three names they chose; the first
 * non-empty one wins, since some send the same text under two.
 */
export class ChatStreamCollector {
  private started = false
  private id: string | undefined
  private text = ''
  private reasoning = ''
  private thinkingOpen = false
  private readonly reasoningDetails: Record<string, unknown>[] = []
  private readonly toolCalls: PartialToolCall[] = []
  private readonly toolCallsByIndex = new Map<number, PartialToolCall>()
  private finishReason: string | undefined
  private usage: unknown

  constructor(private readonly request: Pick<ModelRequest, 'onStreamEvent' | 'onTextDelta'>) {}

  private emit(event: ModelStreamEvent): void {
    this.request.onStreamEvent?.(event)
  }

  private closeThinking(): void {
    if (!this.thinkingOpen) return
    this.thinkingOpen = false
    this.emit({ type: 'thinking_stop', index: 0 })
  }

  add(chunk: OpenAI.Chat.ChatCompletionChunk): void {
    if (!chunk || typeof chunk !== 'object') return
    if (!this.started) {
      this.started = true
      this.emit({ type: 'message_start' })
    }
    this.id ??= chunk.id
    if (chunk.usage) this.usage = chunk.usage
    const choice = chunk.choices?.[0]
    if (!choice) return
    // Moonshot reports usage on the choice instead of the chunk.
    const choiceUsage = (choice as { usage?: unknown }).usage
    if (!chunk.usage && choiceUsage) this.usage = choiceUsage
    if (choice.finish_reason) this.finishReason = choice.finish_reason
    const delta = choice.delta as (OpenAI.Chat.ChatCompletionChunk.Choice.Delta & Record<string, unknown>) | undefined
    if (!delta) return

    // Reasoning before content: a proxy can fold both into one delta.
    const reasoning = [delta.reasoning_content, delta.reasoning, delta.reasoning_text]
      .find((value): value is string => typeof value === 'string' && value.length > 0)
    if (reasoning) {
      if (!this.thinkingOpen) {
        this.thinkingOpen = true
        this.emit({ type: 'thinking_start', index: 0, redacted: false })
      }
      this.reasoning += reasoning
      this.emit({ type: 'thinking_delta', index: 0, thinking: reasoning })
    }
    if (Array.isArray(delta.reasoning_details)) {
      for (const detail of delta.reasoning_details) {
        if (detail && typeof detail === 'object') appendReasoningDetail(this.reasoningDetails, detail as Record<string, unknown>)
      }
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this.closeThinking()
      this.text += delta.content
      this.request.onTextDelta?.(delta.content)
      this.emit({ type: 'text_delta', index: 1, text: delta.content })
    }

    for (const toolDelta of delta.tool_calls ?? []) {
      this.closeThinking()
      const index = typeof toolDelta.index === 'number' ? toolDelta.index : this.toolCalls.length
      let call = this.toolCallsByIndex.get(index)
        ?? (toolDelta.id ? this.toolCalls.find((existing) => existing.id === toolDelta.id) : undefined)
      if (!call) {
        call = { id: toolDelta.id ?? '', name: '', arguments: '' }
        this.toolCalls.push(call)
      }
      this.toolCallsByIndex.set(index, call)
      if (!call.id && toolDelta.id) call.id = toolDelta.id
      if (!call.name && toolDelta.function?.name) call.name = toolDelta.function.name
      const args = toolDelta.function?.arguments
      if (args) {
        call.arguments += args
        this.emit({ type: 'tool_input_delta', index: 2 + index, ...(call.name ? { name: call.name } : {}), partialJson: args })
      }
    }
  }

  finish(): ModelResponse {
    this.closeThinking()
    if (this.finishReason === undefined) {
      // Read as transient by `classifyError`: a dropped connection, not an answer.
      throw new Error('Stream ended without finish_reason')
    }
    if (this.finishReason === 'content_filter') {
      throw new Error('The provider stopped this response with finish_reason content_filter')
    }
    this.emit({ type: 'message_stop' })
    const toolCalls: ToolCall[] = this.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      input: call.arguments.trim() === '' ? {} : safeJsonParse(call.arguments),
    }))
    return {
      content: this.text,
      toolCalls,
      ...(this.usage ? { usage: normalizeOpenAIUsage(this.usage) } : {}),
      ...(this.id ? { requestId: this.id } : {}),
      stopReason: normalizeOpenAIStopReason(this.finishReason),
      ...(this.reasoning ? { reasoningContent: this.reasoning } : {}),
      ...(this.reasoningDetails.length > 0 ? { reasoningDetails: this.reasoningDetails } : {}),
    }
  }
}

function getOpenAISystemFromPayload(payload: ReturnType<typeof buildOpenAIPayload>): unknown {
  const systemMessage = payload.messages.find((message) => message.role === 'system' || message.role === 'developer')
  return systemMessage?.content ?? ''
}

/**
 * A request-shape rejection (4xx other than auth/429) of an image-bearing
 * request is how a custom endpoint that declares vision support but rejects
 * standard data URL parts shows up (design §10.2). Wrap it with the endpoint,
 * model, and the incompatibility explanation — and state explicitly what was
 * NOT done: no protocol switch, no dropped image, no capability toggle
 * change. Everything else (auth, rate limits, 5xx, network) passes through
 * untouched so retry classification and existing error paths stay as they
 * were; `status` is preserved on the wrapper for the same reason.
 */
function augmentImageEndpointRejection(error: unknown, request: ModelRequest, endpoint: string): unknown {
  if (!request.imageBytes || request.imageBytes.size === 0) return error
  if (!(error instanceof Error)) return error
  const status = (error as Error & { status?: number }).status
  if (status === undefined || status === 401 || status === 403 || status === 429) return error
  if (status < 400 || status >= 500) return error

  const wrapped = new Error(
    `Endpoint ${endpoint} (model ${request.model}) rejected a request carrying `
    + `${request.imageBytes.size} image(s): ${redactImageBytesFromText(error.message)}. A custom endpoint that declares `
    + 'vision support may not accept standard data URL image parts; if so, turn off this '
    + "model's image capability switch. No protocol was switched, no image was dropped, and "
    + 'the capability setting was not changed automatically.',
  )
  const wrappedWithError = wrapped as Error & { status?: number; cause?: unknown }
  wrappedWithError.status = status
  wrappedWithError.cause = error
  return wrapped
}

function getOpenAIToolsFromPayload(payload: ReturnType<typeof buildOpenAIPayload>): unknown {
  return 'tools' in payload ? payload.tools : []
}

function normalizeOpenAIStopReason(reason: string | null | undefined): string | undefined {
  if (reason === 'length') return 'max_tokens'
  return reason ?? undefined
}
