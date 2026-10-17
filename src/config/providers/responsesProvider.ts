import OpenAI from 'openai'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent } from '../../harness/types.js'
import {
  checkResponseForCacheBreak,
  recordPromptState,
  requireCacheSource,
} from '../../harness/cacheBreakDetection.js'
import { withRetry } from '../retry.js'
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from '../../utils/userAgent.js'
import { safeJsonParse } from '../../utils/json.js'
import { debugProviderPayload, debugProviderResponse, debugProviderSummary } from './debug.js'
import { getOpenAICacheScope } from './openaiPayload.js'
import { sendWithCacheKeyFallback, sendWithThinkingFallback, wantsThinking } from './openaiCompat.js'
import { buildResponsesPayload, responsesConversationId, type ResponsesPayloadOptions } from './responsesPayload.js'
import { consumeWithIdleTimeout } from './streamIdle.js'
import {
  assertFinalImageRequestLimits,
  assertRequestImageCapability,
  resolveImageRequestGuardLimits,
} from './imageRequestGuard.js'
import { normalizeResponsesUsage } from './usage.js'

const REPLAYED_ITEM_TYPES = new Set(['reasoning', 'message', 'function_call'])
/** A sticky-routing token a Codex backend hands out; sent back for the rest of that turn. */
const TURN_STATE_HEADER = 'x-codex-turn-state'

export class ResponsesProvider implements ModelProvider {
  name = 'openai-responses'
  /** `input_image` data URLs in user messages and function outputs. */
  static readonly supportsImageInput = true
  private client: OpenAI
  private readonly imageInputEnabled: boolean
  private readonly thinkingOff: boolean
  private readonly turnStates = new Map<string, { turnId: string; state: string }>()

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
      defaultHeaders: { 'User-Agent': CODEX_USER_AGENT, originator: CODEX_ORIGINATOR },
    })
    this.imageInputEnabled = config.supportsImageInput === true
    this.thinkingOff = config.thinking?.type === 'disabled'
  }

  supportsDynamicToolSearch(): boolean {
    return false
  }

  supportsImageInput(): boolean {
    return ResponsesProvider.supportsImageInput
  }

  async createMessage(request: ModelRequest): Promise<ModelResponse> {
    assertRequestImageCapability(request, this.imageInputEnabled && this.supportsImageInput())
    const thinking = wantsThinking(request, this.thinkingOff) ? 'on' as const : 'off' as const
    const key = `${this.client.baseURL}\0${request.model}`
    return withRetry(
      (attempt) => sendWithCacheKeyFallback(key, request, (cacheKey) => sendWithThinkingFallback(
        key,
        thinking === 'on' ? ['reasoning', 'include'] : [],
        request,
        (withThinking) => this.sendMessage(request, attempt, { cacheKey, ...(withThinking ? { thinking } : {}) }),
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

  private async sendMessage(request: ModelRequest, attempt: number, options: ResponsesPayloadOptions): Promise<ModelResponse> {
    const payload = buildResponsesPayload(request, options)
    const conversationId = responsesConversationId(request)
    const turnState = this.turnStates.get(conversationId)
    assertFinalImageRequestLimits(payload, request, resolveImageRequestGuardLimits(this))
    const cacheSource = requireCacheSource(request.cacheSource)
    recordPromptState({
      system: JSON.stringify(payload.instructions ?? ''),
      toolsJson: JSON.stringify(payload.tools ?? []),
      model: payload.model,
      cacheScope: getOpenAICacheScope(request),
      firstMessage: request.messages[0]?.content,
      messages: payload.input,
    }, cacheSource)
    if (attempt > 1) debugProviderPayload('openai-responses-retry', payload, request)
    debugProviderSummary('openai-responses', request, payload)
    debugProviderPayload('openai-responses', payload, request)

    const collector = new ResponsesStreamCollector(request)
    const { data: stream, response: httpResponse } = await this.client.responses.create(
      payload as OpenAI.Responses.ResponseCreateParamsStreaming,
      {
        headers: {
          'session-id': conversationId,
          'thread-id': conversationId,
          'x-client-request-id': conversationId,
          ...(turnState && turnState.turnId === request.turnId ? { [TURN_STATE_HEADER]: turnState.state } : {}),
        },
        ...(request.retry?.signal ? { signal: request.retry.signal } : {}),
      },
    ).withResponse()
    const nextTurnState = httpResponse.headers.get(TURN_STATE_HEADER)
    if (nextTurnState && request.turnId) this.turnStates.set(conversationId, { turnId: request.turnId, state: nextTurnState })
    await consumeWithIdleTimeout(stream, (event) => collector.add(event), request.onStreamEvent)
    const response = collector.finish()
    debugProviderResponse('openai-responses', response)

    const cacheBreak = response.usage
      ? checkResponseForCacheBreak(response.usage.cacheReadInputTokens, response.usage.inputTokens, cacheSource)
      : null
    return { ...response, ...(cacheBreak ? { cacheBreak } : {}) }
  }
}

/**
 * Folds a Responses event stream into one response. Deltas only drive the live
 * view; the answer is read off the terminal event's `response.output`, which
 * is the complete, authoritative item list.
 */
export class ResponsesStreamCollector {
  private started = false
  private final: OpenAI.Responses.Response | undefined
  private readonly toolNames = new Map<number, string>()

  constructor(private readonly request: Pick<ModelRequest, 'onStreamEvent' | 'onTextDelta'>) {}

  private emit(event: ModelStreamEvent): void {
    this.request.onStreamEvent?.(event)
  }

  add(event: OpenAI.Responses.ResponseStreamEvent): void {
    if (!this.started) {
      this.started = true
      this.emit({ type: 'message_start' })
    }
    switch (event.type) {
      case 'response.output_item.added':
        if (event.item.type === 'reasoning') this.emit({ type: 'thinking_start', index: event.output_index, redacted: false })
        if (event.item.type === 'function_call') this.toolNames.set(event.output_index, event.item.name)
        return
      case 'response.reasoning_summary_part.added':
        if (event.summary_index > 0) this.emit({ type: 'thinking_delta', index: event.output_index, thinking: '\n\n' })
        return
      case 'response.reasoning_summary_text.delta':
      case 'response.reasoning_text.delta':
        if (event.delta) this.emit({ type: 'thinking_delta', index: event.output_index, thinking: event.delta })
        return
      case 'response.output_item.done':
        if (event.item.type === 'reasoning') this.emit({ type: 'thinking_stop', index: event.output_index })
        return
      case 'response.output_text.delta':
        if (!event.delta) return
        this.request.onTextDelta?.(event.delta)
        this.emit({ type: 'text_delta', index: event.output_index, text: event.delta })
        return
      case 'response.function_call_arguments.delta': {
        const name = this.toolNames.get(event.output_index)
        this.emit({ type: 'tool_input_delta', index: event.output_index, ...(name ? { name } : {}), partialJson: event.delta })
        return
      }
      case 'response.completed':
      case 'response.incomplete':
        this.final = event.response
        return
      case 'response.failed': {
        const failure = event.response.error
        throw Object.assign(new Error(`Response failed${failure ? `: ${failure.code} ${failure.message}` : ''}`), { code: failure?.code })
      }
      case 'error':
        throw Object.assign(new Error(event.message), { code: event.code })
      default:
        return
    }
  }

  finish(): ModelResponse {
    const final = this.final
    // Read as transient by `classifyError`: a dropped connection, not an answer.
    if (!final) throw new Error('Stream ended without a completed response')
    const incomplete = final.status === 'incomplete' ? final.incomplete_details?.reason : undefined
    if (final.status === 'incomplete' && incomplete !== 'max_output_tokens') {
      throw new Error(`Response incomplete: ${incomplete ?? 'no reason given'}`)
    }
    this.emit({ type: 'message_stop' })

    const output = final.output ?? []
    const text = output
      .flatMap((item) => item.type === 'message' ? item.content : [])
      .map((part) => part.type === 'output_text' ? part.text : '')
      .join('')
    const toolCalls = output.flatMap((item) => item.type === 'function_call'
      ? [{ id: item.call_id, name: item.name, input: item.arguments.trim() === '' ? {} : safeJsonParse(item.arguments) }]
      : [])
    const reasoning = output
      .flatMap((item) => item.type === 'reasoning'
        ? [...item.summary.map((part) => part.text), ...(item.content ?? []).map((part) => part.text)]
        : [])
      .filter((part) => part.trim() !== '')
      .join('\n\n')
    const reasoned = output.some((item) => item.type === 'reasoning')
    return {
      content: text,
      toolCalls,
      ...(final.usage ? { usage: normalizeResponsesUsage(final.usage) } : {}),
      requestId: final.id,
      stopReason: incomplete === 'max_output_tokens' ? 'max_tokens' : toolCalls.length > 0 ? 'tool_calls' : 'stop',
      ...(reasoning ? { reasoningContent: reasoning } : {}),
      ...(reasoned ? { responseItems: output.filter((item) => REPLAYED_ITEM_TYPES.has(item.type)) } : {}),
    }
  }
}
