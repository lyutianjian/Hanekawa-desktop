import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../../shellProtocol.js'

/**
 * How a coordination thread's status reads in the renderer: its label, its
 * colour tone, which list section it sits in, and the counts the project row
 * badges. Pure, from wire types only.
 *
 * The table's nine statuses read as four: 运行中, 阻塞 (waiting on the user or
 * the coordinator), 空闲 (its turn is over; it can still be messaged) and 已完成
 * (resolved, final). A failed or interrupted turn is 空闲 with a reason line.
 */

export const THREAD_STATUS_LABEL: Readonly<Record<WireThreadStatus, string>> = {
  running: '运行中',
  idle: '空闲',
  'awaiting-coordinator': '阻塞',
  'needs-you': '阻塞',
  failed: '空闲',
  interrupted: '空闲',
  quiet: '空闲',
  resolved: '已完成',
  stale: '已完成',
}

/** Why an idle-looking thread stopped, when its status says more than 空闲. */
export const THREAD_STATUS_REASON: Readonly<Partial<Record<WireThreadStatus, string>>> = {
  'awaiting-coordinator': '等协调者回复',
  'needs-you': '等你处理',
  failed: '上一回合出错',
  interrupted: '上一回合被中断',
}

/** Resolved and stale threads take no more messages. */
export function threadFinished(status: WireThreadStatus): boolean {
  return status === 'resolved' || status === 'stale'
}

export type ThreadTone = 'running' | 'attention' | 'neutral' | 'muted'

export function threadTone(status: WireThreadStatus): ThreadTone {
  switch (status) {
    case 'running':
      return 'running'
    case 'needs-you':
    case 'awaiting-coordinator':
      return 'attention'
    case 'idle':
    case 'failed':
    case 'interrupted':
    case 'quiet':
      return 'neutral'
    case 'resolved':
    case 'stale':
      return 'muted'
  }
}

export type ThreadBucket = 'active' | 'quiet' | 'resolved'

/** A stale thread (its session is gone) is as finished as a resolved one. */
export function threadBucket(status: WireThreadStatus): ThreadBucket {
  if (status === 'quiet') return 'quiet'
  if (status === 'resolved' || status === 'stale') return 'resolved'
  return 'active'
}

/** Waiting on the user or the coordinator; what the counts call 需要你. */
export function threadBlocked(status: WireThreadStatus): boolean {
  return status === 'needs-you' || status === 'awaiting-coordinator'
}

/** A project with a coordinator now, one that had it deleted, or threads of an earlier one. */
export function isCoordinationProject(state: WireCoordinationThreads): boolean {
  return state.started === true || state.coordinatorSessionId !== undefined || state.threads.length > 0
}

export function coordinationCounts(threads: readonly WireThreadInfo[]): { running: number; blocked: number } {
  let running = 0
  let blocked = 0
  for (const thread of threads) {
    if (thread.status === 'running') running += 1
    else if (threadBlocked(thread.status)) blocked += 1
  }
  return { running, blocked }
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** 刚刚 / N 分钟前 / N 小时前 / N 天前. An unreadable timestamp reads as empty. */
export function formatLastActivity(iso: string, now: number): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const elapsed = Math.max(0, now - at)
  if (elapsed < MINUTE) return '刚刚'
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)} 分钟前`
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)} 小时前`
  return `${Math.floor(elapsed / DAY)} 天前`
}

export function threadBySession(
  state: WireCoordinationThreads | undefined,
  sessionId: string,
): WireThreadInfo | undefined {
  return state?.threads.find((thread) => thread.sessionId === sessionId)
}
