import { setTimeout as delay } from 'node:timers/promises'
import type { ComputerWaitCondition } from '../../runtime/protocol/computerHost.js'
import type { ComputerObservation, ComputerWindow } from './nativeSchema.js'

export interface ObservationSample {
  observation?: ComputerObservation
  windows: ComputerWindow[]
}
export type WaitStatus = 'settled' | 'matched' | 'timed_out' | 'unsupported'

export function checkCondition(condition: ComputerWaitCondition, sample: ObservationSample): 'matched' | 'unsupported' | undefined {
  let present: boolean
  if (condition.kind === 'window') {
    present = sample.windows.some(window => condition.windowId !== undefined
      ? window.id === condition.windowId : window.title.includes(condition.titleIncludes))
  } else {
    if (!sample.observation || sample.observation.truncated) return 'unsupported'
    present = sample.observation.nodes.some(node =>
      (condition.role === undefined || node.role === condition.role)
      && (condition.labelIncludes === undefined || node.label.includes(condition.labelIncludes))
      && (condition.valueIncludes === undefined || node.value.includes(condition.valueIncludes)))
  }
  return present === (condition.state === 'present') ? 'matched' : undefined
}

/** One local polling budget; native reads also share the request's hard deadline. */
export async function pollObservation(read: () => Promise<ObservationSample>, check: (sample: ObservationSample) => Exclude<WaitStatus, 'timed_out'> | undefined,
  waitMs: number, signal: AbortSignal): Promise<{ sample: ObservationSample; wait: { status: WaitStatus; elapsedMs: number } }> {
  const start = performance.now()
  const end = start + waitMs
  signal.throwIfAborted()
  let sample = await read()
  while (true) {
    signal.throwIfAborted()
    const status = check(sample)
    const elapsedMs = Math.round(performance.now() - start)
    if (status) return { sample, wait: { status, elapsedMs } }
    const remaining = end - performance.now()
    if (remaining <= 0) return { sample, wait: { status: 'timed_out', elapsedMs } }
    await delay(Math.min(100, remaining), undefined, { signal })
    signal.throwIfAborted()
    if (performance.now() >= end) return { sample, wait: { status: 'timed_out', elapsedMs: Math.round(performance.now() - start) } }
    sample = await read()
  }
}

export function stableObservation(): (sample: ObservationSample) => 'settled' | 'unsupported' | undefined {
  let previous: string | undefined
  let unchangedSince = 0
  return sample => {
    const data = sample.observation
    if (!data || data.truncated) return 'unsupported'
    const current = JSON.stringify([data.scope, data.windowId, data.bounds, data.nodes])
    const now = performance.now()
    if (current !== previous) { previous = current; unchangedSince = now }
    return now - unchangedSince >= 200 ? 'settled' : undefined
  }
}
