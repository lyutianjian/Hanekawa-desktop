export interface CacheRuntime {
  settings?: {
    cache?: {
      ttl1h?: boolean
    }
  }
  env?: Record<string, string | undefined>
}

export function getCacheControl(runtime?: CacheRuntime): { type: 'ephemeral'; ttl?: '1h' } {
  return {
    type: 'ephemeral',
    ...(should1hCacheTTL(runtime) && { ttl: '1h' as const }),
  }
}

/**
 * Latched for the life of the process. A mid-session flip of the TTL changes the
 * shape of every `cache_control` marker we send, which is itself a cache break:
 * the server keys on the marker, so a settings reload that toggles `ttl1h` throws
 * away the whole cached prefix. Evaluate once, then stay put until an explicit
 * reset.
 */
let latchedTtl1h: boolean | undefined

/**
 * On by default (spec §6.1). A tool loop routinely goes quiet for longer than
 * five minutes — one full test run, one long build — and a 5m TTL then charges
 * a fresh cache write for the entire prefix on the very next turn. Opting out
 * takes `cache.ttl1h === false` or `HANEKAWA_PROMPT_CACHE_1H=0`.
 */
export function should1hCacheTTL(runtime?: CacheRuntime): boolean {
  if (latchedTtl1h !== undefined) return latchedTtl1h
  latchedTtl1h = evaluate1hCacheTTL(runtime)
  return latchedTtl1h
}

function evaluate1hCacheTTL(runtime?: CacheRuntime): boolean {
  return typeof runtime?.settings?.cache?.ttl1h === 'boolean'
    ? runtime.settings.cache.ttl1h
    : (runtime?.env ?? process.env).HANEKAWA_PROMPT_CACHE_1H !== '0'
}

/**
 * The cache TTL a request would be written with, in milliseconds. Reads the
 * latched value when one exists; otherwise evaluates without latching, so
 * callers that only need to know the TTL (idle timing) never pin it.
 */
export function promptCacheTtlMs(runtime?: CacheRuntime): number {
  const ttl1h = latchedTtl1h ?? evaluate1hCacheTTL(runtime)
  return ttl1h ? 3_600_000 : 300_000
}

/** Clear the latched TTL so the next {@link should1hCacheTTL} re-evaluates. */
export function resetCacheTTLEvaluation(): void {
  latchedTtl1h = undefined
}

export function getPromptCachingEnabled(): boolean {
  if (process.env.HANEKAWA_DISABLE_PROMPT_CACHING === '1') return false

  return true
}

interface TextBlockParam {
  type: 'text'
  text: string
  cache_control?: { type: 'ephemeral'; ttl?: '1h' }
}

interface ContentMessage {
  role?: string
  content?: string | Array<Record<string, unknown>>
  [key: string]: unknown
}

/** Blocks the API refuses to accept a `cache_control` marker on. */
const UNCACHEABLE_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking'])

/**
 * The block that carries the message-level cache write.
 *
 * The last block of the message, whatever its type — a turn that ends in
 * `tool_result` or `tool_use` is the common shape in an agent loop, and
 * requiring a `text` block there means those turns write no cache at all.
 * Thinking blocks are the one exception the API rejects, so walk back past them.
 */
function findBreakpointBlock(
  content: Array<Record<string, unknown>>,
): Record<string, unknown> | undefined {
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index]
    if (!block || typeof block !== 'object') continue
    if (UNCACHEABLE_BLOCK_TYPES.has(block.type as string)) continue
    return block
  }
  return undefined
}

/**
 * Marks a provider message the context builder rebuilds every request. Set by
 * `buildAnthropicMessages` from `ChatMessage.transient`, read here, and always
 * stripped before the payload leaves this function — the API rejects unknown
 * message fields.
 */
export const TRANSIENT_MESSAGE_KEY = '__hanekawaTransient'

/**
 * The last message the next turn will still have in the same position.
 * Anything after it is rebuilt per request, so a breakpoint there writes a
 * prefix nothing can read back (spec §5). -1 when every message is transient.
 */
function findAnchorIndex(messages: ContentMessage[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]?.[TRANSIENT_MESSAGE_KEY] !== true) return index
  }
  return -1
}

/**
 * Where the previous request of this conversation put its breakpoint: the
 * last durable message before the latest assistant reply. The API finds an
 * earlier write only by looking back ~20 blocks from a breakpoint, and one
 * step of a tool loop can add more than that (a thinking block, text, and a
 * tool_use plus tool_result per parallel call). A second marker exactly on the
 * previous write turns that lookback into a direct hit. -1 when there is none.
 */
function findPreviousAnchorIndex(messages: ContentMessage[], anchorIndex: number): number {
  let index = anchorIndex - 1
  while (index >= 0 && messages[index]?.role !== 'assistant') index--
  for (index--; index >= 0; index--) {
    if (messages[index]?.[TRANSIENT_MESSAGE_KEY] !== true) return index
  }
  return -1
}

function withoutTransientKey(msg: ContentMessage): ContentMessage {
  if (!(TRANSIENT_MESSAGE_KEY in msg)) return msg
  const { [TRANSIENT_MESSAGE_KEY]: _transient, ...rest } = msg
  return rest
}

export function addCacheBreakpoints(
  messages: ContentMessage[],
  enablePromptCaching: boolean,
  runtime?: CacheRuntime,
): ContentMessage[] {
  if (messages.length === 0) return messages
  const anchorIndex = enablePromptCaching ? findAnchorIndex(messages) : -1
  const marked = new Set([anchorIndex, findPreviousAnchorIndex(messages, anchorIndex)])

  return messages.map((msg, index) => {
    if (!marked.has(index)) return withoutTransientKey(msg)

    const rawContent = Array.isArray(msg.content)
      ? msg.content
      : [{ type: 'text', text: msg.content }]

    if (rawContent.length === 0) return withoutTransientKey(msg)

    // Deep copy blocks so we don't mutate the original message objects.
    const content = rawContent.map((b) => ({ ...b }))

    const targetBlock = findBreakpointBlock(content)

    if (targetBlock) {
      targetBlock.cache_control = getCacheControl(runtime)
    }

    return { ...withoutTransientKey(msg), content }
  })
}

export function addCacheControlToLastSystemBlock(
  blocks: TextBlockParam[],
  enablePromptCaching: boolean,
  runtime?: CacheRuntime,
): TextBlockParam[] {
  if (!enablePromptCaching || blocks.length === 0) return blocks.map((b) => ({ type: b.type, text: b.text }))

  const cacheCtrl = getCacheControl(runtime)
  let marked = false

  const result = [...blocks].reverse().map((b) => {
    if (!marked && b.type === 'text') {
      marked = true
      return { type: b.type, text: b.text, cache_control: cacheCtrl }
    }
    return { type: b.type, text: b.text }
  }).reverse()

  return result
}

export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__HANEKAWA_SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

export function splitSystemForCaching(systemBlocks: string[]): {
  staticBlocks: string[]
  dynamicBlocks: string[]
} {
  const boundaryIndex = systemBlocks.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  if (boundaryIndex < 0) {
    return { staticBlocks: [...systemBlocks], dynamicBlocks: [] }
  }
  return {
    staticBlocks: systemBlocks.slice(0, boundaryIndex),
    dynamicBlocks: systemBlocks.slice(boundaryIndex + 1),
  }
}
