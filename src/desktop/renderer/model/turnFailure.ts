import type { TurnFailureRecord } from '../../../harness/types.js'

/**
 * A turn that ended on a provider or network error, in the words a user can act
 * on. Pure: the host persists the thrown error as it was (`TurnFailureRecord`),
 * and the wording lives here so it can change without rewriting history.
 */

export type TurnFailureKind =
  | 'network'
  | 'timeout'
  | 'auth'
  | 'quota'
  | 'model'
  | 'endpoint'
  | 'rate-limit'
  | 'overloaded'
  | 'server'
  | 'context'
  | 'rejected'
  | 'unknown'

const COPY: Readonly<Record<TurnFailureKind, { reason: string; hint: string }>> = {
  network: { reason: '连不上服务商', hint: '检查网络，以及服务商设置里的地址是否正确。' },
  timeout: { reason: '请求超时', hint: '服务商响应太慢。稍后重试，或换一个模型。' },
  auth: { reason: 'API key 无效', hint: '检查服务商设置里的 API key 是否填对、是否有权限。' },
  quota: { reason: '额度不足', hint: '服务商账户的余额或额度已用完。充值后重试，或换一个服务商。' },
  model: { reason: '模型不存在', hint: '检查模型名称，或在服务商设置里换一个可用的模型。' },
  endpoint: { reason: '找不到服务商接口', hint: '检查服务商设置里的地址是否正确。' },
  'rate-limit': { reason: '请求太频繁', hint: '被服务商限流了。等一会儿再重试。' },
  overloaded: { reason: '服务商暂时繁忙', hint: '稍后重试。' },
  server: { reason: '服务商出错了', hint: '问题在服务商那一侧。稍后重试。' },
  context: { reason: '对话超出了模型的上下文', hint: '用 /compact 压缩对话，或开始新的会话。' },
  rejected: { reason: '服务商拒绝了这次请求', hint: '详细原因见下方。' },
  unknown: { reason: '请求失败', hint: '详细原因见下方，也可以直接重试。' },
}

const NETWORK_CODES = /^(econn|enotfound|eai_again|epipe|enetunreach|ehostunreach|cert_|unable_to_verify|depth_zero|self_signed|err_tls|err_ssl)/
const TIMEOUT_CODES = /^(etimedout|esockettimedout|und_err_.*timeout)/

export function classifyTurnFailure(input: { error: string; status?: number; code?: string }): TurnFailureKind {
  const { status } = input
  const code = (input.code ?? '').toLowerCase()
  const text = input.error.toLowerCase()

  if (status === 401 || status === 403 || code === 'invalid_api_key' || code === 'authentication_error'
    || /unauthorized|invalid[_ ]api[_ -]?key|incorrect api key|authentication|permission denied|forbidden/.test(text)) {
    return 'auth'
  }
  if (status === 402 || code === 'insufficient_quota' || code === 'billing_not_active'
    || /insufficient[_ ](quota|balance|funds|credit)|exceeded your current quota|credit balance|billing|余额|欠费/.test(text)) {
    return 'quota'
  }
  if (code === 'model_not_found' || /model[^.]{0,80}(not found|does not exist|not exist)|unknown model|invalid model|no such model/.test(text)
    || (status === 404 && /model/.test(text))) {
    return 'model'
  }
  if (status === 404) return 'endpoint'
  if (/context[_ ]length|maximum context|prompt is too long|too many tokens|context window/.test(text)) return 'context'
  if (status === 429 || code === 'rate_limit_exceeded') return 'rate-limit'
  if (status === 529 || status === 503 || /overloaded/.test(text)) return 'overloaded'
  if (TIMEOUT_CODES.test(code) || /timed ?out|timeout/.test(text)) return 'timeout'
  if (status !== undefined && status >= 500) return 'server'
  if (NETWORK_CODES.test(code) || /connection error|fetch failed|network|socket hang up|getaddrinfo|certificate|self[- ]signed|econn|enotfound/.test(text)) {
    return 'network'
  }
  if (status === 400 || status === 422) return 'rejected'
  return 'unknown'
}

/** `api.example.com/v1`: where a request went, without the scheme and without a trailing slash. */
export function endpointLabel(baseUrl: string | undefined, providerName: string | undefined): string | undefined {
  if (baseUrl === undefined) return providerName
  try {
    const url = new URL(baseUrl)
    return `${url.host}${url.pathname}`.replace(/\/+$/, '')
  } catch {
    return baseUrl
  }
}

/** What the transcript's error card draws. `retryable` is the transcript's to decide; see `withFailureActions`. */
export interface TurnFailureCard {
  /** The failure record's id: what 「重试」 names. */
  readonly id: string
  readonly kind: TurnFailureKind
  /** The title: what went wrong, in plain words. */
  readonly reason: string
  /** What to try next. */
  readonly hint: string
  /** `模型 x · 服务商 y`; absent when the record names neither. */
  readonly target?: string
  /** The provider's own words. */
  readonly detail: string
  /** The user message whose turn failed. */
  readonly userMessageId: string
  readonly retryable: boolean
}

export function turnFailureCard(record: TurnFailureRecord): TurnFailureCard {
  const kind = classifyTurnFailure({
    error: record.error,
    ...(record.status === undefined ? {} : { status: record.status }),
    ...(record.code === undefined ? {} : { code: record.code }),
  })
  const endpoint = endpointLabel(record.baseUrl, record.providerName)
  const target = [
    record.model === undefined ? undefined : `模型 ${record.model}`,
    endpoint === undefined ? undefined : `服务商 ${endpoint}`,
  ].filter((part): part is string => part !== undefined).join(' · ')
  return {
    id: record.id,
    kind,
    ...COPY[kind],
    ...(target === '' ? {} : { target }),
    detail: record.error.trim(),
    userMessageId: record.userMessageId,
    retryable: false,
  }
}
