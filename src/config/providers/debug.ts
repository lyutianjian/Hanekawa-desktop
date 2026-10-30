import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import type { ModelRequest } from '../../harness/types.js'
import { collectRequestImageRefs } from './imageRequestGuard.js'
import { collectCacheControlTelemetry } from './cacheControlTelemetry.js'
import { normalizeAnthropicUsage, normalizeOpenAIUsage } from './usage.js'

function shouldDebugProviderPayloads() {
  return process.env.HANEKAWA_DEBUG_PROVIDER === '1'
}

/**
 * Redacts image bodies out of a debug payload (design §13): base64 `data`
 * fields and data URLs are replaced with their lengths, and the attachment
 * facts (id, name, MIME, dimensions, byte count) ride a separate summary line
 * instead. The payload the wire would carry is never logged as-is once it can
 * contain pixels. Copy-on-write: the original payload object is not mutated.
 */
export function debugProviderPayload(label: string, payload: unknown, request?: ModelRequest) {
  if (!shouldDebugProviderPayloads()) return
  console.error(`[hanekawa][provider:${label}] payload\n${JSON.stringify(redactPayloadImageBytes(payload), null, 2)}`)
  if (!request) return
  const refs = collectRequestImageRefs(request)
  if (refs.length === 0) return
  const facts = refs.map((ref) => {
    const loaded = request.imageBytes?.get(ref.id)
    return {
      attachmentId: ref.id,
      name: ref.name,
      mimeType: ref.mimeType,
      width: ref.width,
      height: ref.height,
      byteLength: ref.byteLength,
      ...(loaded ? { loadedByteLength: loaded.bytes.byteLength } : {}),
    }
  })
  console.error(`[hanekawa][provider:${label}] payload images\n${JSON.stringify(facts, null, 2)}`)
}

function approxBase64Bytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((base64.length * 3) / 4) - padding)
}

function redactPayloadImageBytes<T>(value: T): T {
  return redactValue(value) as T
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const redacted = redactValue(item)
      if (redacted !== item) changed = true
      return redacted
    })
    return changed ? next : value
  }
  if (!isRecord(value)) return value

  // Anthropic image block: keep the source shape and MIME, drop the data.
  if (
    value.type === 'image'
    && isRecord(value.source)
    && value.source.type === 'base64'
    && typeof value.source.data === 'string'
  ) {
    const data = value.source.data
    return {
      ...value,
      source: {
        ...value.source,
        data: `<redacted base64: ${data.length} chars, ~${approxBase64Bytes(data).toLocaleString('en-US')} bytes>`,
      },
    }
  }

  // OpenAI image_url part: keep the data URL prefix (it names the MIME), drop
  // the encoded body.
  if (
    value.type === 'image_url'
    && isRecord(value.image_url)
    && typeof value.image_url.url === 'string'
    && value.image_url.url.startsWith('data:')
  ) {
    const url = value.image_url.url
    const marker = url.indexOf('base64,')
    if (marker >= 0) {
      const prefix = url.slice(0, marker + 'base64,'.length)
      const encoded = url.slice(prefix.length)
      return {
        ...value,
        image_url: {
          ...value.image_url,
          url: `${prefix}<redacted ${encoded.length} chars, ~${approxBase64Bytes(encoded).toLocaleString('en-US')} bytes>`,
        },
      }
    }
  }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    const redacted = redactValue(child)
    if (redacted !== child) changed = true
    next[key] = redacted
  }
  return changed ? next : value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function previewContent(value: unknown): string {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return `text:${item.slice(0, 80)}`
        if (item && typeof item === 'object' && 'type' in item) {
          const typed = item as Record<string, unknown>
          if (typed.type === 'tool_use') return `tool_use:${String(typed.name ?? '')}`
          if (typed.type === 'tool_result') return `tool_result:${String(typed.tool_use_id ?? '')}`
          if (typed.type === 'text') return `text:${String(typed.text ?? '').slice(0, 80)}`
          if (typed.type === 'image') {
            const source = typed.source as { media_type?: unknown } | undefined
            return `image:${typeof source?.media_type === 'string' ? source.media_type : 'unknown'}`
          }
          if (typed.type === 'image_url') {
            const image = typed.image_url as { url?: unknown } | undefined
            const mime = typeof image?.url === 'string' && image.url.startsWith('data:')
              ? image.url.slice(5, image.url.indexOf(';'))
              : 'unknown'
            return `image_url:${mime}`
          }
          return String(typed.type)
        }
        return typeof item
      })
      .join(', ')
  }
  if (typeof value === 'string') return value.slice(0, 120)
  return typeof value
}

/**
 * `betas` is passed in rather than read off the payload: `anthropic-beta` is an
 * HTTP header, so it is nowhere in the request body and this is the only place
 * a running session can be seen to carry it.
 */
export function debugProviderSummary(
  label: string,
  request: ModelRequest,
  payload: unknown,
  betas?: string[],
) {
  if (!shouldDebugProviderPayloads()) return
  const toolNames = (request.tools ?? []).map((tool) => tool.name)
  const contextKinds = (request.contextItems ?? []).map((item) => item.kind)
  const messagesPreview = request.messages.map((message) => `${message.role}:${message.content.slice(0, 60)}`)
  let payloadPreview: unknown
  if (payload && typeof payload === 'object') {
    const candidate = payload as Record<string, unknown>
    const payloadMessages = Array.isArray(candidate.messages) ? candidate.messages : []
    payloadPreview = payloadMessages.map((message) => {
      const typed = message as Record<string, unknown>
      return {
        role: typed.role,
        content: previewContent(typed.content),
      }
    })
  }

  console.error(`[hanekawa][provider:${label}] request summary ${JSON.stringify({
    model: request.model,
    ...(betas ? { betas } : {}),
    systemPresent: Boolean(request.system),
    toolNames,
    messageCount: request.messages.length,
    contextItemCount: request.contextItems?.length ?? 0,
    contextKinds,
    messagesPreview,
    payloadPreview,
    cacheControl: collectCacheControlTelemetry(payload),
    promptCacheKeyPresent: Boolean((payload as Record<string, unknown> | undefined)?.prompt_cache_key),
    promptCacheRetention: (payload as Record<string, unknown> | undefined)?.prompt_cache_retention,
  }, null, 2)}`)
}

export function debugProviderResponse(label: string, response: unknown) {
  if (!shouldDebugProviderPayloads()) return
  if (label === 'anthropic') {
    const typed = response as Anthropic.Messages.Message
    const textBlocks = typed.content.filter((item) => item.type === 'text')
    const toolBlocks = typed.content.filter((item) => item.type === 'tool_use')
    const usage = normalizeAnthropicUsage(typed.usage)
    console.error(`[hanekawa][provider:${label}] response summary ${JSON.stringify({
      id: typed.id,
      model: typed.model,
      stopReason: typed.stop_reason,
      contentTypes: typed.content.map((item) => item.type),
      textLength: textBlocks.reduce((sum, item) => sum + (item.type === 'text' ? item.text.length : 0), 0),
      toolCalls: toolBlocks.map((item) => item.type === 'tool_use' ? item.name : undefined).filter(Boolean),
      usage,
      cacheUsage: {
        uncachedInputTokens: typed.usage?.input_tokens ?? null,
        cacheCreationInputTokens: typed.usage?.cache_creation_input_tokens ?? null,
        cacheReadInputTokens: typed.usage?.cache_read_input_tokens ?? null,
      },
    }, null, 2)}`)
    return
  }

  const typed = response as OpenAI.Chat.ChatCompletion
  const message = typed.choices[0]?.message
  const usage = normalizeOpenAIUsage(typed.usage)
  console.error(`[hanekawa][provider:${label}] response summary ${JSON.stringify({
    id: typed.id,
    model: typed.model,
    finishReason: typed.choices[0]?.finish_reason,
    textLength: typeof message?.content === 'string' ? message.content.length : 0,
    usage,
    toolCalls: message?.tool_calls?.map((call) => {
      const fn = call as { function?: { name?: string } }
      return fn.function?.name
    }) ?? [],
  }, null, 2)}`)
}
