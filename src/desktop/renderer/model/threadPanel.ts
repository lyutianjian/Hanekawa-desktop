/**
 * The side panel's 「线程」 section, as data: a project's coordination threads
 * grouped by state (阻塞, 运行中, 空闲, 安静, 已完成), each group foldable, each
 * row one line with its status mark, unread dot and the controls its menu may
 * offer.
 *
 * DOM-free like the rest of `model/`. Status labels and tones come from
 * `coordinationStatus.ts`, so the sidebar and this panel never disagree.
 */

import type { WireCoordinationThreads, WireThreadStatus } from '../../shellProtocol.js'
import { THREAD_STATUS_LABEL, THREAD_STATUS_REASON, formatLastActivity, threadBlocked, threadTone, type ThreadTone } from './coordinationStatus.js'

export type ThreadGroup = 'blocked' | 'running' | 'idle' | 'quiet' | 'resolved'

const GROUP_ORDER: readonly ThreadGroup[] = ['blocked', 'running', 'idle', 'quiet', 'resolved']

const GROUP_LABEL: Readonly<Record<ThreadGroup, string>> = {
  blocked: '阻塞',
  running: '运行中',
  idle: '空闲',
  quiet: '安静',
  resolved: '已完成',
}

/** Groups drawn folded until the user opens them. */
const FOLDED_BY_DEFAULT: ReadonlySet<ThreadGroup> = new Set(['quiet', 'resolved'])

function threadGroup(status: WireThreadStatus): ThreadGroup {
  if (status === 'running') return 'running'
  if (threadBlocked(status)) return 'blocked'
  if (status === 'quiet') return 'quiet'
  if (status === 'resolved' || status === 'stale') return 'resolved'
  return 'idle'
}

export interface ThreadPanelRow {
  readonly threadId: string
  readonly sessionId: string
  readonly title: string
  /** The status mark's tooltip. */
  readonly statusLabel: string
  readonly tone: ThreadTone
  readonly lastActivity: string
  /** The thread's own one-line status, or why it is blocked or stopped. */
  readonly statusLine?: string
  /** The session on screen is this thread's. */
  readonly current: boolean
  /** Activity since the user last looked at it. */
  readonly unread: boolean
  /** A stop or resolve for this thread is in flight. */
  readonly pending: boolean
}

export interface ThreadPanelGroup {
  readonly group: ThreadGroup
  readonly label: string
  readonly folded: boolean
  /** Always populated; the view draws them only while unfolded. */
  readonly rows: readonly ThreadPanelRow[]
}

/** The row menu that is open, and what it may offer. */
export interface ThreadPanelMenu {
  readonly threadId: string
  readonly sessionId: string
  /** Running, waiting on the user, or waiting on the coordinator: a stop applies. */
  readonly canStop: boolean
  /** Settled threads (resolved, stale) and live ones have nothing to close out. */
  readonly canResolve: boolean
  readonly pending: boolean
}

export interface ThreadPanelView {
  /** The project has threads at all; without them the section shows its empty state. */
  readonly available: boolean
  /** Non-empty groups, in order. */
  readonly groups: readonly ThreadPanelGroup[]
  readonly menu?: ThreadPanelMenu
  /** A line above the list, e.g. why the page the user was reading is gone. */
  readonly notice?: string
  /** `error`: the line reports a failure, not a fact. */
  readonly noticeTone?: 'error'
}

export interface ThreadPanelInput {
  readonly state: WireCoordinationThreads | undefined
  /** Epoch ms, for the relative time column. */
  readonly now: number
  readonly activeSessionId: string | undefined
  /** Groups the user folded or opened against their default. */
  readonly toggled: ReadonlySet<ThreadGroup>
  /** Thread ids with a stop or resolve in flight. */
  readonly pending: ReadonlySet<string>
  /** Per thread id, the `lastActivityAt` the user has seen (see `nextThreadSeen`). */
  readonly seen: ReadonlyMap<string, string>
  /** The thread whose row menu is open. */
  readonly menuThreadId?: string | undefined
  readonly notice?: string | undefined
  readonly noticeTone?: 'error' | undefined
}

const STOPPABLE: ReadonlySet<WireThreadStatus> = new Set(['running', 'needs-you', 'awaiting-coordinator'])
const NOT_RESOLVABLE: ReadonlySet<WireThreadStatus> = new Set(['running', 'needs-you', 'awaiting-coordinator', 'resolved', 'stale'])

export function threadPanelView(input: ThreadPanelInput): ThreadPanelView {
  const threads = input.state?.threads ?? []
  const rows = new Map<ThreadGroup, ThreadPanelRow[]>()
  let menu: ThreadPanelMenu | undefined
  for (const thread of threads) {
    const statusLine = thread.statusLine || THREAD_STATUS_REASON[thread.status]
    const current = thread.sessionId === input.activeSessionId
    const seenAt = input.seen.get(thread.threadId)
    const pending = input.pending.has(thread.threadId)
    const row: ThreadPanelRow = {
      threadId: thread.threadId,
      sessionId: thread.sessionId,
      title: thread.title,
      statusLabel: THREAD_STATUS_LABEL[thread.status],
      tone: threadTone(thread.status),
      lastActivity: formatLastActivity(thread.lastActivityAt, input.now),
      ...(statusLine ? { statusLine } : {}),
      current,
      // A running thread moves on by itself; its dot would never go out.
      unread: !current && thread.status !== 'running' && seenAt !== undefined && seenAt !== thread.lastActivityAt,
      pending,
    }
    const group = threadGroup(thread.status)
    rows.set(group, [...(rows.get(group) ?? []), row])
    if (thread.threadId === input.menuThreadId) {
      menu = {
        threadId: thread.threadId,
        sessionId: thread.sessionId,
        canStop: STOPPABLE.has(thread.status),
        canResolve: !NOT_RESOLVABLE.has(thread.status),
        pending,
      }
    }
  }
  const groups = GROUP_ORDER.flatMap((group): ThreadPanelGroup[] => {
    const members = rows.get(group)
    if (members === undefined) return []
    const folded = FOLDED_BY_DEFAULT.has(group) !== input.toggled.has(group)
    return [{ group, label: GROUP_LABEL[group], folded, rows: members }]
  })
  return {
    available: threads.length > 0,
    groups,
    ...(menu ? { menu } : {}),
    ...(input.notice ? { notice: input.notice, ...(input.noticeTone ? { noticeTone: input.noticeTone } : {}) } : {}),
  }
}

/**
 * The seen map after a coordination push. A thread met for the first time
 * counts as seen, so a window opening onto a busy project is not all dots; a
 * thread the user is looking at (`watching`, by session id) stays seen as it
 * moves. Other projects' entries are kept, so switching back keeps their dots.
 */
export function nextThreadSeen(
  seen: ReadonlyMap<string, string>,
  state: WireCoordinationThreads | undefined,
  watching: ReadonlySet<string>,
): ReadonlyMap<string, string> {
  const next = new Map(seen)
  for (const thread of state?.threads ?? []) {
    const previous = seen.get(thread.threadId)
    next.set(thread.threadId, previous === undefined || watching.has(thread.sessionId) ? thread.lastActivityAt : previous)
  }
  return next
}

/** What a control in the panel asks the window to do. */
export type ThreadPanelIntent =
  | { readonly kind: 'view'; readonly threadId: string }
  | { readonly kind: 'open'; readonly sessionId: string }
  | { readonly kind: 'stop'; readonly threadId: string }
  | { readonly kind: 'resolve'; readonly threadId: string }
  | { readonly kind: 'toggle-group'; readonly group: ThreadGroup }
  /** `undefined` closes the open menu. */
  | { readonly kind: 'menu'; readonly threadId: string | undefined }
