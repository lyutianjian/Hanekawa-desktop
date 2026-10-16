import OpenAI from 'openai'
import type { ModelConfig } from '../service.js'
import type { ModelProvider, ModelRequest, ModelResponse } from '../../harness/types.js'
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

  constructor(config: ModelConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    })
    this.imageInputEnabled = config.supportsImageInput === true
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
    return withRetry(
      async (attempt) => {
        const effectiveRequest: ModelRequest = {
          ...request,
        }
        const payload = buildOpenAIPayload(effectiveRequest)
        // The final pre-send check (design §11.1 step 5): per-image bytes,
        // image count, and the whole serialized body. Throws before any debug
        // log or network call; retry classification treats it as non-retryable.
        assertFinalImageRequestLimits(payload, effectiveRequest, resolveImageRequestGuardLimits(this))
        const cacheSource = requireCacheSource(effectiveRequest.cacheSource)
        recordPromptState({
          system: JSON.stringify(getOpenAISystemFromPayload(payload)),
          toolsJson: JSON.stringify(getOpenAIToolsFromPayload(payload)),
          model: String(payload.model ?? effectiveRequest.model),
          cacheScope: getOpenAICacheScope(effectiveRequest),
          firstMessage: effectiveRequest.messages[0]?.content,
          messages: payload.messages,
        }, cacheSource)
        if (attempt > 1) {
          debugProviderPayload('openai-retry', payload, effectiveRequest)
        }
        debugProviderSummary('openai', effectiveRequest, payload)
        debugProviderPayload('openai', payload, effectiveRequest)
        let response: OpenAI.Chat.ChatCompletion
        try {
          response = await this.client.chat.completions.create(payload, {
            signal: request.retry?.signal,
            ...(request.retry?.signal ? {} : { timeout: 120_000 }),
          })
        } catch (error) {
          throw augmentImageEndpointRejection(error, effectiveRequest, this.client.baseURL)
        }
        debugProviderResponse('openai', response)

        if (!response.choices || response.choices.length === 0) {
          throw new Error('OpenAI API returned empty choices array — possible content filtering or upstream error')
        }

        const choice = response.choices[0]
        const message = choice?.message

        const toolCalls =
          message?.tool_calls?.map((tc) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const fn = tc as any
            return {
              id: tc.id,
              name: fn.function.name,
              input: safeJsonParse(fn.function.arguments),
            }
          }) ?? []

        let content = message?.content ?? ''
        if (toolCalls.length > 0 && typeof content === 'string' && content.trim() === '') {
          content = ''
        }

        const reasoningContent = (message as { reasoning_content?: unknown } | undefined)?.reasoning_content
        const reasoning = typeof reasoningContent === 'string' && reasoningContent.length > 0
          ? reasoningContent
          : undefined
        const usage = normalizeOpenAIUsage(response.usage)
        let cacheBreak: CacheBreakResult | null = null
        if (response.usage) {
          cacheBreak = checkResponseForCacheBreak(
            usage.cacheReadInputTokens,
            usage.inputTokens,
            cacheSource,
          )
        }

        return {
          content,
          toolCalls,
          usage,
          requestId: response.id,
          stopReason: normalizeOpenAIStopReason(choice?.finish_reason),
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(cacheBreak ? { cacheBreak } : {}),
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
}

function getOpenAISystemFromPayload(payload: ReturnType<typeof buildOpenAIPayload>): unknown {
  const systemMessage = payload.messages.find((message) => message.role === 'system')
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
