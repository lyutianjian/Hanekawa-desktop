import Anthropic from '@anthropic-ai/sdk'
import OpenAI from 'openai'
import { USER_AGENT } from '../../utils/userAgent.js'
import type { SupportedProviderName } from './registry.js'

export interface EndpointProbeInput {
  provider: SupportedProviderName
  baseUrl?: string
  apiKey?: string
}

/** What the service says about one model; every field but `id` is only there when it was reported. */
export interface ProbedModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
  imageInput?: boolean
}

export type EndpointProbeFailure =
  | 'no-key'
  | 'bad-url'
  | 'not-api'
  | 'unreachable'
  | 'timeout'
  | 'tls'
  | 'auth'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'server'
  | 'other'

export type EndpointProbeResult =
  | {
      ok: true
      latencyMs: number
      models: ProbedModel[]
      /** Set when the given address only answered with `/v1` added or removed: the address that worked. */
      baseUrl?: string
    }
  | { ok: false; reason: EndpointProbeFailure; status?: number; detail: string }

const PROBE_TIMEOUT_MS = 15_000
const MAX_MODELS = 2_000

/**
 * Lists the endpoint's models, which is both the connection test and the model
 * picker's source: the one request that needs a working address and a valid key
 * and costs no tokens.
 */
export async function probeEndpoint(input: EndpointProbeInput): Promise<EndpointProbeResult> {
  const baseUrl = input.baseUrl?.trim() || undefined
  if (baseUrl !== undefined && !/^https?:\/\/[^/\s]+/i.test(baseUrl)) {
    return { ok: false, reason: 'bad-url', detail: baseUrl }
  }
  const first = await attempt(input.provider, baseUrl, input.apiKey)
  // The SDKs disagree about the version segment — Anthropic's adds `/v1`
  // itself, OpenAI's expects it in the address — so a pasted address is often
  // one `/v1` off. Only a 404 says the host is right and the path is not.
  if (first.ok || first.reason !== 'not-found' || baseUrl === undefined) return first
  const alternate = /\/v1\/?$/.test(baseUrl) ? baseUrl.replace(/\/v1\/?$/, '') : `${baseUrl.replace(/\/+$/, '')}/v1`
  const second = await attempt(input.provider, alternate, input.apiKey)
  if (second.ok) return { ...second, baseUrl: alternate }
  // A 401 there means the path was right and the key is the problem, which says
  // more; any other answer to a guessed path says nothing about the real one.
  return second.reason === 'auth' ? second : first
}

async function attempt(
  provider: SupportedProviderName,
  baseUrl: string | undefined,
  apiKey: string | undefined,
): Promise<EndpointProbeResult> {
  const started = Date.now()
  try {
    const models = provider === 'anthropic'
      ? await listAnthropic(baseUrl, apiKey)
      : await listOpenAI(baseUrl, apiKey)
    models.sort((a, b) => a.id.localeCompare(b.id))
    return { ok: true, latencyMs: Date.now() - started, models }
  } catch (error) {
    return classifyProbeError(error)
  }
}

async function listAnthropic(baseUrl: string | undefined, apiKey: string | undefined): Promise<ProbedModel[]> {
  const client = new Anthropic({
    apiKey: apiKey || undefined,
    baseURL: baseUrl,
    timeout: PROBE_TIMEOUT_MS,
    maxRetries: 0,
    defaultHeaders: { 'User-Agent': USER_AGENT },
  })
  const { data: page, response } = await client.models.list({ limit: 1000 }).withResponse()
  assertJson(response)
  const models: ProbedModel[] = []
  for await (const info of page) {
    if (typeof info.id !== 'string') continue
    const image = info.capabilities?.image_input?.supported
    models.push({
      id: info.id,
      ...(typeof info.display_name === 'string' && info.display_name ? { name: info.display_name } : {}),
      ...(positive(info.max_input_tokens) ? { contextWindow: info.max_input_tokens } : {}),
      ...(positive(info.max_tokens) ? { maxOutputTokens: info.max_tokens } : {}),
      ...(typeof image === 'boolean' ? { imageInput: image } : {}),
    })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

async function listOpenAI(baseUrl: string | undefined, apiKey: string | undefined): Promise<ProbedModel[]> {
  const client = new OpenAI({ apiKey: apiKey || undefined, baseURL: baseUrl, timeout: PROBE_TIMEOUT_MS, maxRetries: 0 })
  const { data: page, response } = await client.models.list().withResponse()
  assertJson(response)
  const models: ProbedModel[] = []
  for await (const info of page) {
    if (typeof info.id !== 'string') continue
    // OpenRouter and several gateways extend the OpenAI shape with these two.
    const extra = info as { context_length?: unknown; architecture?: { input_modalities?: unknown } }
    const modalities = extra.architecture?.input_modalities
    models.push({
      id: info.id,
      ...(positive(extra.context_length) ? { contextWindow: extra.context_length } : {}),
      ...(Array.isArray(modalities) ? { imageInput: modalities.includes('image') } : {}),
    })
    if (models.length >= MAX_MODELS) break
  }
  return models
}

/**
 * Both SDKs hand a non-JSON body back as text and page it as an empty list, so a
 * website's address — its index page answering 200 — would pass as an API.
 */
function assertJson(response: Response): void {
  if (!/json/i.test(response.headers.get('content-type') ?? '')) throw new NotApiError()
}

class NotApiError extends Error {
  constructor() {
    super('The address answered with something other than JSON.')
  }
}

function positive(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

const TLS_CODES = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'])

/** Exported for the table-driven test; a probe never throws. */
export function classifyProbeError(error: unknown): EndpointProbeResult & { ok: false } {
  const detail = error instanceof Error ? error.message : String(error)
  if (error instanceof NotApiError) return { ok: false, reason: 'not-api', detail }
  const status = (error as { status?: unknown }).status
  if (typeof status === 'number') {
    const reason: EndpointProbeFailure = status === 401 ? 'auth'
      : status === 403 ? 'forbidden'
      : status === 404 ? 'not-found'
      : status === 429 ? 'rate-limit'
      : status >= 500 ? 'server'
      : 'other'
    return { ok: false, reason, status, detail }
  }
  if (error instanceof Anthropic.APIConnectionTimeoutError || error instanceof OpenAI.APIConnectionTimeoutError) {
    return { ok: false, reason: 'timeout', detail }
  }
  const code = causeCode(error)
  if (code !== undefined && TLS_CODES.test(code)) return { ok: false, reason: 'tls', detail: `${code}: ${detail}` }
  if (code !== undefined && UNREACHABLE_CODES.has(code)) return { ok: false, reason: 'unreachable', detail: `${code}: ${detail}` }
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    return { ok: false, reason: 'unreachable', detail }
  }
  // Both SDKs refuse to send a request without a key, with an error of their own base class.
  if (/api[_ ]?key|authentication method/i.test(detail)) return { ok: false, reason: 'no-key', detail }
  return { ok: false, reason: 'other', detail }
}

function causeCode(error: unknown): string | undefined {
  for (let current = error, depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') return code
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}
