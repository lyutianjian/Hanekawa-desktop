import type { ModelRequest } from '../../harness/types.js'

/**
 * How a Chat Completions endpoint takes the thinking switch and effort. Every
 * vendor spells it differently; `none` sends nothing either way.
 */
export const CHAT_THINKING_FORMATS = ['openai', 'deepseek', 'qwen', 'zai', 'openrouter', 'none'] as const
export type ChatThinkingFormat = typeof CHAT_THINKING_FORMATS[number]

export interface ChatCompat {
  /**
   * `api.openai.com`: the current request shape — `developer` role,
   * `max_completion_tokens`, `store: false`, `prompt_cache_key`. Compatible
   * servers keep the older shape, and some reject parameters they do not know.
   */
  official: boolean
  thinkingFormat: ChatThinkingFormat
  /** DeepSeek in thinking mode wants `reasoning_content` on every assistant message. */
  reasoningContentOnAssistant: boolean
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function detectThinkingFormat(host: string): ChatThinkingFormat {
  if (host === 'api.openai.com' || host.endsWith('.openai.azure.com')) return 'openai'
  if (host.endsWith('deepseek.com')) return 'deepseek'
  if (host.includes('dashscope')) return 'qwen'
  if (host === 'open.bigmodel.cn' || host === 'api.z.ai') return 'zai'
  if (host.endsWith('openrouter.ai')) return 'openrouter'
  if (host.startsWith('api.moonshot.')) return 'none'
  return 'openai'
}

/** `override` is the endpoint's hand-written `thinkingFormat`; anything unknown means auto. */
export function resolveChatCompat(baseUrl: string, override?: string): ChatCompat {
  const host = hostOf(baseUrl)
  const thinkingFormat = CHAT_THINKING_FORMATS.find((format) => format === override) ?? detectThinkingFormat(host)
  return {
    official: host === 'api.openai.com',
    thinkingFormat,
    reasoningContentOnAssistant: thinkingFormat === 'deepseek',
  }
}

/** Whether a request asks for thinking: the global switch, then the model's own. */
export function wantsThinking(request: Pick<ModelRequest, 'thinking'>, modelThinkingOff: boolean): boolean {
  return request.thinking?.type !== 'disabled' && !modelThinkingOff
}

/**
 * The thinking fields for one request. `on` sends the vendor's switch and the
 * effort level as-is; `off` sends an explicit off only where the vendor has
 * one, because elsewhere absence already means the model's default.
 */
export function chatThinkingParams(
  format: ChatThinkingFormat,
  on: boolean,
  effort: ModelRequest['effort'],
): Record<string, unknown> {
  switch (format) {
    case 'openai':
      return on && effort ? { reasoning_effort: effort } : {}
    case 'deepseek':
      return on
        ? { thinking: { type: 'enabled' }, ...(effort ? { reasoning_effort: effort } : {}) }
        : { thinking: { type: 'disabled' } }
    case 'qwen':
      return { enable_thinking: on }
    case 'zai':
      return { thinking: { type: on ? 'enabled' : 'disabled' } }
    case 'openrouter':
      return on && effort ? { reasoning: { effort } } : {}
    case 'none':
      return {}
  }
}

/**
 * Endpoint + model pairs that refused the thinking fields, or the cache key.
 * A compatible server cannot be asked which of its models reason, or which
 * know `prompt_cache_key`, so every model is sent them until it refuses; the refusal is remembered only once a request without
 * them succeeds, and only for this process.
 */
const rejectedThinking = new Set<string>()
const rejectedCacheKey = new Set<string>()

/** A 400/422, or a Responses stream that failed on an invalid parameter after a 200. */
function isRequestRejection(error: unknown): error is Error {
  if (!(error instanceof Error)) return false
  const { status, code } = error as Error & { status?: number; code?: unknown }
  return status === 400 || status === 422 || code === 'invalid_parameter' || code === 'invalid_request_error'
}

async function sendWithFallback<T>(
  rejected: Set<string>,
  key: string,
  isRejection: (error: Error) => boolean,
  label: string,
  request: Pick<ModelRequest, 'model' | 'retry'>,
  send: (withFields: boolean) => Promise<T>,
): Promise<T> {
  if (rejected.has(key)) return send(false)
  try {
    return await send(true)
  } catch (error) {
    if (request.retry?.signal?.aborted || !isRequestRejection(error) || !isRejection(error)) throw error
    const response = await send(false)
    rejected.add(key)
    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error(`[myagent][${label}] ${request.model} rejected ${label} fields; sending without them`)
    }
    return response
  }
}

/** `send(true)`, or `send(false)` once the endpoint has refused the thinking fields for this model. */
export function sendWithThinkingFallback<T>(
  key: string,
  sentFields: readonly string[],
  request: Pick<ModelRequest, 'model' | 'retry'>,
  send: (withThinking: boolean) => Promise<T>,
): Promise<T> {
  const isRejection = (error: Error) => {
    const message = error.message.toLowerCase()
    return sentFields.some((field) => message.includes(field))
  }
  return sendWithFallback(rejectedThinking, key, isRejection, 'thinking', request, send)
}

/** `send(true)`, or `send(false)` once the endpoint has refused `prompt_cache_key` for this model. */
export function sendWithCacheKeyFallback<T>(
  key: string,
  request: Pick<ModelRequest, 'model' | 'retry'>,
  send: (withCacheKey: boolean) => Promise<T>,
): Promise<T> {
  return sendWithFallback(rejectedCacheKey, key, (error) => error.message.includes('prompt_cache_key'), 'cache-key', request, send)
}
