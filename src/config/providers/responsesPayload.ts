import type OpenAI from 'openai'
import type { ModelContextItem, ModelRequest } from '../../harness/types.js'
import { toolToAPISchema } from '../../harness/toolApiSchema.js'
import { buildOpenAIPromptCacheKey, imageDataUrls } from './openaiPayload.js'

type InputItem = OpenAI.Responses.ResponseInputItem

export interface ResponsesPayloadOptions {
  /** Absent sends no reasoning fields at all: the endpoint rejected them for this model. */
  thinking?: 'on' | 'off'
  /** `prompt_cache_key`; absent once the endpoint rejected it. */
  cacheKey?: boolean
}

function isFunctionCall(item: unknown): item is { type: 'function_call'; call_id: string } {
  return typeof item === 'object' && item !== null
    && (item as { type?: unknown }).type === 'function_call'
    && typeof (item as { call_id?: unknown }).call_id === 'string'
}

/**
 * The conversation as Responses input items.
 *
 * An assistant message that kept its `responseItems` goes back verbatim when
 * the same model reads it — reasoning, text and calls together, since the API
 * checks that each reasoning item arrives with the items it produced. That
 * needs every call it made still present in the history; otherwise, and for
 * any other model, the message is rebuilt from its text and tool calls without
 * the reasoning.
 */
export function buildResponsesInput(request: ModelRequest): InputItem[] {
  const contextItems = request.contextItems ?? request.messages.map((message) => ({ kind: 'message', message }) satisfies ModelContextItem)
  const toolUseIds = new Set(contextItems.flatMap((item) => item.kind === 'tool_use' ? [item.id] : []))
  const replayedCalls = new Set<string>()
  const input: InputItem[] = []

  for (const item of contextItems) {
    if (item.kind === 'message') {
      const { message } = item
      if (message.role === 'user') {
        const urls = imageDataUrls(message.images, request.imageBytes)
        input.push({
          role: 'user',
          content: urls.length === 0
            ? message.content
            : [
                ...(message.content.trim() === '' ? [] : [{ type: 'input_text' as const, text: message.content }]),
                ...urls.map((url) => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
              ],
        })
        continue
      }
      if (message.role !== 'assistant') continue
      if (message.images?.length) {
        throw new Error(
          `Assistant message ${message.id} carries image attachments, which Responses assistant input cannot hold; `
          + 'refusing to build a payload that would silently drop them.',
        )
      }
      const kept = message.model === request.model ? message.responseItems ?? [] : []
      const calls = kept.filter(isFunctionCall)
      if (kept.length > 0 && calls.every((call) => toolUseIds.has(call.call_id))) {
        input.push(...(kept as InputItem[]))
        for (const call of calls) replayedCalls.add(call.call_id)
      } else if (message.content !== '') {
        input.push({ role: 'assistant', content: message.content })
      }
      continue
    }

    if (item.kind === 'tool_use') {
      if (replayedCalls.has(item.id)) continue
      input.push({ type: 'function_call', call_id: item.id, name: item.tool, arguments: JSON.stringify(item.input ?? {}) })
      continue
    }

    // Use apiResultBlock content when available (e.g. ToolSearch schemas text for OpenAI)
    const text = item.apiResultBlock
      ? (typeof item.apiResultBlock.content === 'string' ? item.apiResultBlock.content : item.content)
      : item.content
    // Unlike Chat Completions, a function output can carry images itself.
    const urls = item.apiResultBlock ? [] : imageDataUrls(item.images, request.imageBytes)
    input.push({
      type: 'function_call_output',
      call_id: item.toolUseId,
      output: urls.length === 0
        ? text
        : [
            ...(text.trim() === '' ? [] : [{ type: 'input_text' as const, text }]),
            ...urls.map((url) => ({ type: 'input_image' as const, image_url: url, detail: 'auto' as const })),
          ],
    })
  }
  return input
}

/**
 * The conversation id Codex sends as `prompt_cache_key` and in its session
 * headers. A request outside any conversation (a title, a summary) gets one
 * taken from its static prompt prefix, UUID-shaped like Codex's own.
 */
export function responsesConversationId(request: ModelRequest): string {
  if (request.promptCacheKey) return request.promptCacheKey
  const hex = buildOpenAIPromptCacheKey(request).slice('myagent:'.length)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

export function buildResponsesPayload(request: ModelRequest, options: ResponsesPayloadOptions = {}) {
  const tools = (request.tools ?? []).map((tool) => ({
    type: 'function' as const,
    name: tool.name,
    description: tool.description,
    parameters: toolToAPISchema(tool) as Record<string, unknown>,
    // Omitted, Responses tries to coerce the schema into strict mode, which
    // our optional parameters do not survive.
    strict: false,
  }))
  return {
    model: request.model,
    ...(request.system ? { instructions: request.system } : {}),
    input: buildResponsesInput(request),
    stream: true as const,
    store: false,
    ...(tools.length > 0 ? { tools } : {}),
    ...(request.maxOutputTokens ? { max_output_tokens: request.maxOutputTokens } : {}),
    ...(options.cacheKey ? { prompt_cache_key: responsesConversationId(request) } : {}),
    ...(request.promptCacheRetention ? { prompt_cache_retention: request.promptCacheRetention } : {}),
    // Off sends nothing: `effort: 'none'` is refused outright by models that lack it.
    ...(options.thinking === 'on'
      ? {
          reasoning: { ...(request.effort ? { effort: request.effort } : {}), summary: 'auto' as const },
          include: ['reasoning.encrypted_content' as const],
        }
      : {}),
  }
}
