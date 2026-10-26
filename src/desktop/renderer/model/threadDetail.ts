/**
 * Which page the side panel's 概览 tab shows: the thread list, or one thread's
 * conversation read-only. Pure, from wire types only.
 */

import type { WireCoordinationThreads, WireThreadInfo } from '../../shellProtocol.js'
import { THREAD_STATUS_LABEL, threadBlocked, threadTone, type ThreadTone } from './coordinationStatus.js'
import type { TranscriptState } from './transcript.js'

export interface ThreadSelection {
  readonly projectRoot: string
  readonly threadId: string
}

export type ThreadPage =
  | {
      readonly kind: 'list'
      /** The selection no longer leads anywhere and should be dropped. */
      readonly clear: boolean
      readonly notice?: string
    }
  | {
      readonly kind: 'detail'
      readonly threadId: string
      readonly sessionId: string
      readonly title: string
      readonly statusLabel: string
      readonly tone: ThreadTone
      /** Re-read the transcript on a timer; otherwise once per change. */
      readonly poll: boolean
      /** Waiting on a permission request or a question: the main canvas is where to answer. */
      readonly needsYou: boolean
      readonly canStop: boolean
      readonly stopPending: boolean
    }

export function threadPage(
  selection: ThreadSelection | undefined,
  state: WireCoordinationThreads | undefined,
  pending: ReadonlySet<string>,
): ThreadPage {
  if (selection === undefined || state === undefined) return { kind: 'list', clear: false }
  if (state.projectRoot !== selection.projectRoot) return { kind: 'list', clear: true }
  const thread: WireThreadInfo | undefined = state.threads.find((info) => info.threadId === selection.threadId)
  if (thread === undefined) return { kind: 'list', clear: true, notice: '这个线程已被删除' }
  if (thread.status === 'stale') return { kind: 'list', clear: true, notice: '这个线程的会话已不存在' }
  return {
    kind: 'detail',
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    title: thread.title,
    statusLabel: THREAD_STATUS_LABEL[thread.status],
    tone: threadTone(thread.status),
    poll: thread.status === 'running',
    needsYou: thread.status === 'needs-you',
    canStop: thread.status === 'running' || threadBlocked(thread.status),
    stopPending: pending.has(thread.threadId),
  }
}

/**
 * A thread's first user message is the coordinator's brief, not anything the
 * user typed; the page draws it as a card of its own above the conversation.
 */
export function splitThreadBrief(state: TranscriptState): { brief: string | undefined; state: TranscriptState } {
  const index = state.items.findIndex((item) => item.kind === 'user')
  if (index < 0) return { brief: undefined, state }
  return { brief: state.items[index]!.text, state: { ...state, items: state.items.filter((_, i) => i !== index) } }
}
