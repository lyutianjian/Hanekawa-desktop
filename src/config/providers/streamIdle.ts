import type { ModelStreamEvent } from '../../harness/types.js'

export const STREAM_IDLE_TIMEOUT_MS =
  parseInt(process.env.MYAGENT_STREAM_IDLE_HARD_TIMEOUT_MS || '', 10) || 10 * 60_000
export const STREAM_IDLE_WARNING_MS =
  parseInt(
    process.env.MYAGENT_STREAM_IDLE_WARNING_MS
      || process.env.MYAGENT_STREAM_IDLE_TIMEOUT_MS
      || '',
    10,
  ) || 90_000

/**
 * Feeds every item of an SDK stream to `onItem`, aborting it once nothing has
 * arrived for `idleTimeoutMs`. Reasoning models can stay silent for minutes
 * before their first token, so silence first raises an `idle_warning` and only
 * the hard limit ends the request — with a message `classifyError` reads as
 * transient. Caller aborts reach the SDK through its own `signal` option.
 */
export async function consumeWithIdleTimeout<T>(
  stream: AsyncIterable<T> & { controller: AbortController },
  onItem: (item: T) => void,
  onStreamEvent?: (event: ModelStreamEvent) => void,
  idleTimeoutMs = STREAM_IDLE_TIMEOUT_MS,
  idleWarningMs = STREAM_IDLE_WARNING_MS,
): Promise<void> {
  let timedOut = false
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined
  let warningTimer: ReturnType<typeof setTimeout> | undefined
  const clearTimers = () => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer)
    if (warningTimer !== undefined) clearTimeout(warningTimer)
  }
  const resetTimers = () => {
    clearTimers()
    if (idleWarningMs > 0 && idleWarningMs < idleTimeoutMs) {
      warningTimer = setTimeout(() => onStreamEvent?.({ type: 'idle_warning', idleMs: idleWarningMs }), idleWarningMs)
    }
    timeoutTimer = setTimeout(() => {
      timedOut = true
      stream.controller.abort()
    }, idleTimeoutMs)
  }
  resetTimers()
  try {
    for await (const item of stream) {
      resetTimers()
      onItem(item)
    }
  } catch (error) {
    if (timedOut) throw new Error('Stream idle timeout')
    throw error
  } finally {
    clearTimers()
  }
  if (timedOut) throw new Error('Stream idle timeout')
}
