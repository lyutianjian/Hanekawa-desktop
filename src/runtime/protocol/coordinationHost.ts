/**
 * The contract between the coordination tools and whatever owns threads.
 *
 * Like `browserHost.ts` this is types only, in the Electron-free protocol
 * layer: `src/tools/` sees the {@link CoordinationHost}, the runtime implements
 * it, and `main.ts` joins them through `extraTools`. Failures are thrown with a
 * structural `code` (see {@link CoordinationErrorCode}); the tools read it
 * without importing an error class.
 */

import type { EffortLevel } from '../../config/effort.js'

/** The calling session, its project, and the turn making the call. */
export interface CoordinationCaller {
  sessionId: string
  projectDir: string
  turnId?: string
}

export type CoordinationErrorCode =
  | 'THREAD_NOT_FOUND'
  | 'THREAD_STALE'
  | 'THREAD_RESOLVED'
  | 'NOT_COORDINATOR'
  | 'NO_COORDINATOR'
  | 'WORKTREE_FAILED'

export interface StartThreadRequest {
  title: string
  brief: string
  background: string
  writesCode: boolean
  model?: string
}

export interface StartedThread {
  threadId: string
  sessionId: string
  /** Present for a thread that got its own worktree. */
  branch?: string
}

export interface ThreadSummary {
  threadId: string
  title: string
  /** The thread table's status, rendered by the implementation (running, idle, waiting, resolved, ...). */
  status: string
  writesCode: boolean
  branch?: string
  /** True while the thread waits on the user (a permission prompt or dialog). */
  needsUser?: boolean
  /** When the thread last did something, ISO 8601. */
  lastActivityAt?: string
  /** One line of the thread's last report. */
  lastReport?: string
}

export interface FetchThreadOptions {
  /** Messages to skip, counted from the newest. */
  offset?: number
  limit?: number
}

export interface ThreadMessage {
  role: 'user' | 'assistant'
  text: string
  at?: string
}

export interface FetchedThread {
  brief: string
  lastReport?: string
  /** The page, oldest first. */
  messages: ThreadMessage[]
  /** Feed back as `offset` to read older messages; absent when there are none. */
  nextOffset?: number
}

/** First line of the opening instruction; the renderer recognises the turn by it. */
export const OPENING_HEAD = 'This is the opening of a new coordinator session (not an automatic wake).'

export interface CoordinationHost {
  startThread(caller: CoordinationCaller, request: StartThreadRequest): Promise<StartedThread>
  messageThread(caller: CoordinationCaller, threadId: string, text: string): Promise<void>
  stopThread(caller: CoordinationCaller, threadId: string): Promise<void>
  resolveThread(caller: CoordinationCaller, threadId: string, note?: string): Promise<void>
  listThreads(caller: CoordinationCaller): Promise<ThreadSummary[]>
  fetchThread(caller: CoordinationCaller, threadId: string, options?: FetchThreadOptions): Promise<FetchedThread>
  /** From a thread: park a question for the coordinator. The thread then ends its turn. */
  askCoordinator(caller: CoordinationCaller, question: string): Promise<void>
}

/** What a session lane offers the coordination service; implemented by `SessionHost`. */
export interface CoordinationLaneControl {
  /** Queue a message from the coordinator; it never interrupts a user-driven turn. */
  enqueueFromCoordinator(text: string): Promise<void>
  /** Ask the lane to start a wake turn with this text when it can. */
  requestWake(text: string, options?: { opening?: boolean }): void
  /** Drop queued messages, then interrupt the running turn. */
  stop(): Promise<void>
  setModel(key: string): void
  /** Applied after the model, since the level is clamped against it. */
  setEffort(level: EffortLevel): void
  state(): { streaming: boolean; pendingApproval: boolean; pendingDialog: boolean }
  onStateChange(listener: () => void): () => void
}
