/**
 * The runtime side of coordination: implements the {@link CoordinationHost}
 * the seven tools call, plus the host-side commands the desktop shell issues
 * directly (open the coordinator, stop everything, startup reconcile, branch
 * merges). No Electron: everything that touches lanes or notifications goes
 * through {@link CoordinationPort}, which `main.ts` implements.
 */

import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { CoordinationSettings } from '../../config/settings.js'
import type { SessionRecord } from '../../harness/types.js'
import { applyLifecycle, effectiveThreadStatus } from '../../services/coordination/lifecycle.js'
import { CoordinationStore, newThreadId } from '../../services/coordination/threadStore.js'
import {
  branchDiff,
  createThreadWorktree,
  mergeBranch,
  removeThreadWorktree,
  type MergeResult,
} from '../../services/coordination/threadWorktree.js'
import type { ThreadRecord, ThreadWorktree } from '../../services/coordination/types.js'
import type { SessionCoordination, SessionMeta } from '../../sessions/service.js'
import { REPORT_MAX, sanitizeReportText, sanitizeTitle } from '../../utils/reportSanitizer.js'
import { projectDataKey } from '../../utils/paths.js'
import { readGitBranch } from '../gitBranch.js'
import type {
  CoordinationCaller,
  CoordinationErrorCode,
  CoordinationHost,
  CoordinationLaneControl,
  FetchedThread,
  FetchThreadOptions,
  StartedThread,
  StartThreadRequest,
  ThreadMessage,
  ThreadSummary,
} from '../protocol/coordinationHost.js'
import { lastCompactSummary } from './contextPolicy.js'
import { composeThreadKickoff, formatCoordinatorSeed, formatOpeningMessage, threadSlug } from './messages.js'

export const COORDINATOR_SESSION_TITLE = '项目调度'
const FETCH_DEFAULT_LIMIT = 20
const FETCH_MESSAGE_MAX = 4000

/** The slice of `SessionStore` the service uses. */
export interface CoordinationSessionStore {
  create(title?: string): Promise<SessionMeta>
  setCoordination(sessionIdOrPrefix: string, value: SessionCoordination | undefined): Promise<void>
  resolve(idOrPrefix: string): Promise<SessionMeta | undefined>
  loadRecords(sessionIdOrPrefix: string): Promise<SessionRecord[]>
  appendRecord(sessionIdOrPrefix: string, record: SessionRecord): Promise<void>
}

/** What the shell provides; implemented by `main.ts`, faked in tests. */
export interface CoordinationPort {
  storeFor(cwd: string): CoordinationSessionStore
  /** The live lane of a session, when one is open. */
  laneControl(sessionId: string): CoordinationLaneControl | undefined
  /** Opens (or returns) the session's lane; `activate:false` leaves the visible lane alone. */
  openLane(cwd: string, sessionId: string, options: { activate: boolean }): Promise<CoordinationLaneControl>
  notify(input: { title: string; body: string; sessionId: string }): void
  settings(cwd: string): CoordinationSettings
}

/** The wake engine calls the service needs; `CoordinationWakeEngine` satisfies it. */
export interface CoordinationEngineHooks {
  beginThreadStart(cwd: string): void | Promise<void>
  endThreadStart(cwd: string): void | Promise<void>
  markStopped(cwd: string, sessionId: string): void | Promise<void>
  noteQuestion(cwd: string, sessionId: string, question: string): void | Promise<void>
}

export class CoordinationError extends Error {
  constructor(readonly code: CoordinationErrorCode, message: string) {
    super(message)
    this.name = 'CoordinationError'
  }
}

export interface PendingMerge {
  threadId: string
  title: string
  branch: string
  added: number
  removed: number
  conflict: boolean
  /** The thread is still working (or waiting on the user); merging is not yet possible. */
  running: boolean
}

/** One thread as the desktop sees it: the tool summary plus the session behind it. */
export interface ThreadInfo extends ThreadSummary {
  sessionId: string
  statusLine?: string
}

export type ThreadMergeResult = MergeResult | { kind: 'running' | 'no-worktree'; message: string }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Thread text is quoted by the tools inside `<thread_data>`; it must not close that wrapper itself. */
function quotable(text: string, max: number): string {
  const neutral = text.replace(/<(\/?)(thread_data)/gi, '‹$1$2')
  const points = Array.from(neutral)
  return points.length <= max ? neutral : `${points.slice(0, max - 1).join('')}…`
}

export class CoordinationService implements CoordinationHost {
  private readonly stores = new Map<string, CoordinationStore>()
  private readonly threadListeners = new Set<(cwd: string) => void>()

  constructor(
    private readonly port: CoordinationPort,
    private readonly engine: CoordinationEngineHooks,
  ) {}

  /** The project's thread table; one instance per project root. */
  coordinationStore(cwd: string): CoordinationStore {
    const key = path.resolve(cwd)
    let store = this.stores.get(key)
    if (!store) {
      store = new CoordinationStore(cwd, {
        lifecycle: () => this.port.settings(cwd),
        onWrite: () => {
          for (const listener of [...this.threadListeners]) {
            try {
              listener(cwd)
            } catch {
              // a bad listener must not break the others
            }
          }
        },
      })
      this.stores.set(key, store)
    }
    return store
  }

  /** Fires after any write through a project's store; returns the unsubscribe. */
  onThreadsChanged(listener: (cwd: string) => void): () => void {
    this.threadListeners.add(listener)
    return () => {
      this.threadListeners.delete(listener)
    }
  }

  /** The project's threads for the desktop, newest activity first; no coordinator check. */
  async threadInfos(cwd: string): Promise<{ coordinatorSessionId?: string; started: boolean; threads: ThreadInfo[] }> {
    const store = this.coordinationStore(cwd)
    const file = await store.read()
    const threads = applyLifecycle(file.threads, new Date(), this.port.settings(cwd))
      .map((thread): ThreadInfo => ({
        ...this.summarize(thread),
        sessionId: thread.sessionId,
        ...(thread.statusLine ? { statusLine: sanitizeReportText(thread.statusLine, REPORT_MAX) } : {}),
      }))
      .sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? ''))
    return {
      ...(file.coordinator?.sessionId ? { coordinatorSessionId: file.coordinator.sessionId } : {}),
      started: await store.exists(),
      threads,
    }
  }

  private summarize(thread: ThreadRecord): ThreadSummary {
    return {
      threadId: thread.threadId,
      title: sanitizeTitle(thread.title),
      status: thread.status,
      writesCode: thread.worktree !== undefined,
      ...(thread.worktree ? { branch: thread.worktree.branch } : {}),
      ...(thread.status === 'needs-you' ? { needsUser: true } : {}),
      lastActivityAt: thread.lastActivityAt,
      ...(thread.lastReport ? { lastReport: sanitizeReportText(thread.lastReport, REPORT_MAX) } : {}),
    }
  }

  // ---------------------------------------------------------------------------
  // CoordinationHost

  async startThread(caller: CoordinationCaller, request: StartThreadRequest): Promise<StartedThread> {
    await this.requireCoordinator(caller)
    const cwd = caller.projectDir
    const store = this.coordinationStore(cwd)
    const sessions = this.port.storeFor(cwd)
    const threadId = newThreadId()
    const name = threadSlug(request.title)
    const now = new Date().toISOString()
    const base: ThreadRecord = {
      threadId,
      sessionId: '',
      title: request.title,
      name,
      brief: request.brief,
      background: request.background,
      status: 'running',
      createdAt: now,
      lastActivityAt: now,
    }

    await this.engine.beginThreadStart(cwd)
    try {
      let worktree: ThreadWorktree | undefined
      if (request.writesCode) {
        try {
          worktree = await createThreadWorktree({ cwd, threadId, slug: name })
        } catch (error) {
          throw new CoordinationError('WORKTREE_FAILED', `Worktree could not be created: ${errorMessage(error)}`)
        }
      }

      const meta = await sessions.create(request.title)
      // Before the lane opens: the session scope snapshots its role.
      await sessions.setCoordination(meta.id, {
        role: 'thread',
        projectKey: projectDataKey(cwd),
        threadId,
        ...(worktree ? { workingDir: worktree.cwd } : {}),
      })
      const record: ThreadRecord = { ...base, sessionId: meta.id, ...(worktree ? { worktree } : {}) }
      await store.upsertThread(record)

      try {
        const control = await this.port.openLane(cwd, meta.id, { activate: false })
        const model = request.model ?? this.port.settings(cwd).threadModel
        if (model) control.setModel(model)
        const effort = this.port.settings(cwd).threadEffort
        if (effort) control.setEffort(effort)
        await control.enqueueFromCoordinator(composeThreadKickoff({
          background: request.background,
          brief: request.brief,
          ...(worktree ? { worktree: { branch: worktree.branch } } : {}),
        }))
      } catch (error) {
        // A thread that never started leaves no row; the tool error tells the coordinator why.
        await store.removeThreadsBySession([meta.id])
        if (worktree) await removeThreadWorktree(cwd, worktree)
        throw new Error(`The brief could not be delivered: ${errorMessage(error)}`)
      }

      return { threadId, sessionId: meta.id, ...(worktree ? { branch: worktree.branch } : {}) }
    } finally {
      await this.engine.endThreadStart(cwd)
    }
  }

  async messageThread(caller: CoordinationCaller, threadId: string, text: string): Promise<void> {
    await this.requireCoordinator(caller)
    await this.deliver(caller.projectDir, threadId, text)
  }

  async stopThread(caller: CoordinationCaller, threadId: string): Promise<void> {
    await this.requireCoordinator(caller)
    await this.stopThreadById(caller.projectDir, threadId)
  }

  /** The user's stop: same effect as the tool, without the coordinator check. */
  async stopThreadById(cwd: string, threadId: string): Promise<void> {
    const thread = await this.findThread(cwd, threadId)
    await this.stopSession(cwd, thread.sessionId)
  }

  /** The user's resolve: same effect as the tool, without the coordinator check. */
  async resolveThreadById(cwd: string, threadId: string, note?: string): Promise<void> {
    const thread = await this.findThread(cwd, threadId)
    // Resolving is final, so whatever the thread is still doing ends with it.
    await this.stopSession(cwd, thread.sessionId)
    await this.coordinationStore(cwd).patchThread(threadId, {
      status: 'resolved',
      ...(note?.trim() ? { statusLine: sanitizeReportText(note, REPORT_MAX) } : {}),
    })
  }

  async resolveThread(caller: CoordinationCaller, threadId: string, note?: string): Promise<void> {
    await this.requireCoordinator(caller)
    await this.resolveThreadById(caller.projectDir, threadId, note)
  }

  async listThreads(caller: CoordinationCaller): Promise<ThreadSummary[]> {
    await this.requireCoordinator(caller)
    const cwd = caller.projectDir
    const { threads } = await this.coordinationStore(cwd).read()
    return applyLifecycle(threads, new Date(), this.port.settings(cwd)).map((thread) => this.summarize(thread))
  }

  async fetchThread(caller: CoordinationCaller, threadId: string, options: FetchThreadOptions = {}): Promise<FetchedThread> {
    await this.requireCoordinator(caller)
    const cwd = caller.projectDir
    const thread = await this.findThread(cwd, threadId)
    const records = thread.sessionId ? await this.port.storeFor(cwd).loadRecords(thread.sessionId) : []
    const messages: ThreadMessage[] = []
    for (const record of records) {
      if (record.type !== 'message' || record.transient) continue
      if (record.role !== 'user' && record.role !== 'assistant') continue
      if (!record.content.trim()) continue
      messages.push({ role: record.role, text: quotable(record.content, FETCH_MESSAGE_MAX), at: record.createdAt })
    }
    const offset = Math.max(0, options.offset ?? 0)
    const limit = Math.max(1, options.limit ?? FETCH_DEFAULT_LIMIT)
    const end = Math.max(0, messages.length - offset)
    const start = Math.max(0, end - limit)
    const page = messages.slice(start, end)
    return {
      brief: quotable(thread.brief, FETCH_MESSAGE_MAX),
      ...(thread.lastReport ? { lastReport: quotable(thread.lastReport, FETCH_MESSAGE_MAX) } : {}),
      messages: page,
      ...(start > 0 ? { nextOffset: offset + page.length } : {}),
    }
  }

  async askCoordinator(caller: CoordinationCaller, question: string): Promise<void> {
    const cwd = caller.projectDir
    const meta = await this.port.storeFor(cwd).resolve(caller.sessionId)
    if (meta?.coordination?.role !== 'thread') {
      throw new CoordinationError('THREAD_NOT_FOUND', 'AskCoordinator can only be called from a coordination thread.')
    }
    if (!(await this.coordinationStore(cwd).getCoordinatorSessionId())) {
      throw new CoordinationError('NO_COORDINATOR', 'This project has no coordinator session to ask.')
    }
    await this.engine.noteQuestion(cwd, meta.id, question)
  }

  // ---------------------------------------------------------------------------
  // Host-side commands (never exposed to the model)

  /** The project's coordinator session, created when the pointer is missing or names a session that is gone. */
  async ensureCoordinator(cwd: string, options: { opening?: boolean } = {}): Promise<string> {
    const store = this.coordinationStore(cwd)
    const sessions = this.port.storeFor(cwd)
    const pointer = await store.getCoordinatorSessionId()
    if (pointer && (await sessions.resolve(pointer))) return pointer
    const id = await this.createCoordinatorSession(cwd)
    if (options.opening) await this.issueOpening(cwd, id)
    return id
  }

  /** The opening turn goes through the wake channel but is never counted in `autoWakeCount`. */
  private async issueOpening(cwd: string, sessionId: string): Promise<void> {
    const lane = await this.port.openLane(cwd, sessionId, { activate: false })
    if (!(await this.coordinationStore(cwd).claimOpening(sessionId))) return
    lane.requestWake(formatOpeningMessage(), { opening: true })
  }

  /**
   * Replaces a coordinator whose compaction circuit has opened: a new session
   * seeded with the old one's last summary takes over the pointer. The old
   * session keeps its role and stays as history. A no-op returning the current
   * pointer once it no longer names `oldSessionId`.
   */
  async reseedCoordinator(cwd: string, oldSessionId: string): Promise<string> {
    const store = this.coordinationStore(cwd)
    const pointer = await store.getCoordinatorSessionId()
    if (pointer !== oldSessionId) return pointer ?? oldSessionId
    const sessions = this.port.storeFor(cwd)
    const summary = lastCompactSummary(await sessions.loadRecords(oldSessionId))
    const newId = await this.createCoordinatorSession(cwd, async (id) => {
      // A pending boundary as the first record: the loop's post-compact restore
      // adds the current board and the queued notes to the first request.
      await sessions.appendRecord(id, {
        id: randomUUID(),
        type: 'compact_boundary',
        summary: formatCoordinatorSeed({ previousSessionId: oldSessionId, ...(summary ? { summary } : {}) }),
        preTokens: 0,
        postCompactRestore: 'pending',
        createdAt: new Date().toISOString(),
      })
    }, { alwaysOpen: true })
    this.port.notify({
      title: COORDINATOR_SESSION_TITLE,
      body: 'The coordinator context could no longer be compacted; a new coordinator session continues from its last summary.',
      sessionId: newId,
    })
    return newId
  }

  /** A fresh coordinator session behind the pointer; `seed` runs before the pointer moves and the lane opens. */
  private async createCoordinatorSession(
    cwd: string,
    seed?: (sessionId: string) => Promise<void>,
    options: { alwaysOpen?: boolean } = {},
  ): Promise<string> {
    const sessions = this.port.storeFor(cwd)
    const meta = await sessions.create(COORDINATOR_SESSION_TITLE)
    await sessions.setCoordination(meta.id, { role: 'coordinator', projectKey: projectDataKey(cwd) })
    await seed?.(meta.id)
    await this.coordinationStore(cwd).setCoordinatorSessionId(meta.id)
    const model = this.port.settings(cwd).coordinatorModel
    const effort = this.port.settings(cwd).coordinatorEffort
    if (model || effort || options.alwaysOpen) {
      const control = await this.port.openLane(cwd, meta.id, { activate: false })
      if (model) control.setModel(model)
      if (effort) control.setEffort(effort)
    }
    return meta.id
  }

  /** Stops the coordinator and every thread that has a live lane. */
  async stopAll(cwd: string): Promise<void> {
    const store = this.coordinationStore(cwd)
    const file = await store.read()
    const coordinator = file.coordinator?.sessionId
    if (coordinator) await this.port.laneControl(coordinator)?.stop()
    for (const thread of file.threads) {
      if (thread.sessionId && this.port.laneControl(thread.sessionId)) await this.stopSession(cwd, thread.sessionId)
    }
  }

  /** At app start: nothing can still be running, so those threads were interrupted. */
  async reconcileOnStartup(cwd: string): Promise<void> {
    const store = this.coordinationStore(cwd)
    const file = await store.read()
    const stuck = file.threads.some((t) => t.status === 'running' || t.status === 'needs-you')
    if (!stuck && !file.coordinator?.wakeLocked) return
    await store.update((f) => {
      for (const thread of f.threads) {
        if (thread.status === 'running' || thread.status === 'needs-you') thread.status = 'interrupted'
      }
      if (f.coordinator) f.coordinator.wakeLocked = false
    })
  }

  /** Worktree threads whose branch has commits the project's branch lacks. */
  async pendingMerges(cwd: string): Promise<PendingMerge[]> {
    const { threads } = await this.coordinationStore(cwd).read()
    const result: PendingMerge[] = []
    for (const thread of threads) {
      const wt = thread.worktree
      if (!wt || thread.status === 'stale') continue
      let diff
      try {
        diff = await branchDiff(cwd, wt.branch)
      } catch {
        continue
      }
      if (diff.ahead <= 0 || diff.head === thread.merge?.dismissedHead) continue
      result.push({
        threadId: thread.threadId,
        title: sanitizeTitle(thread.title),
        branch: wt.branch,
        added: diff.added,
        removed: diff.removed,
        conflict: thread.merge?.conflict === true,
        running: thread.status === 'running' || thread.status === 'needs-you',
      })
    }
    return result
  }

  async mergeThread(cwd: string, threadId: string): Promise<ThreadMergeResult> {
    const thread = await this.findThread(cwd, threadId)
    const wt = thread.worktree
    if (!wt) return { kind: 'no-worktree', message: 'This thread has no branch of its own.' }
    if (thread.status === 'running' || thread.status === 'needs-you') {
      return { kind: 'running', message: 'The thread is still running; merge once it has finished.' }
    }
    const store = this.coordinationStore(cwd)
    const result = await mergeBranch(cwd, wt.branch)
    switch (result.kind) {
      case 'dirty':
        return { kind: 'dirty', message: 'The project directory has uncommitted changes. Commit or stash them, then merge again.' }
      case 'conflict':
        await store.patchThread(threadId, { merge: { ...thread.merge, conflict: true } })
        return { kind: 'conflict', message: `Merging ${wt.branch} conflicts with the current branch; the merge was undone.` }
      case 'merged':
        await removeThreadWorktree(cwd, wt)
        await store.patchThread(threadId, {
          status: 'resolved',
          statusLine: 'merged',
          worktree: undefined,
          merge: undefined,
          lastActivityAt: new Date().toISOString(),
        })
        return result
      default:
        return result
    }
  }

  /** Hides the merge prompt until the branch gets a new commit. */
  async dismissMerge(cwd: string, threadId: string): Promise<void> {
    const thread = await this.findThread(cwd, threadId)
    if (!thread.worktree) return
    const { head } = await branchDiff(cwd, thread.worktree.branch)
    await this.coordinationStore(cwd).patchThread(threadId, { merge: { ...thread.merge, dismissedHead: head } })
  }

  /** Asks the thread to bring its branch up to date with the project's branch and resolve the conflict. */
  async resolveConflictViaThread(cwd: string, threadId: string): Promise<void> {
    const thread = await this.findThread(cwd, threadId)
    if (!thread.worktree) throw new CoordinationError('THREAD_NOT_FOUND', 'This thread has no branch of its own.')
    const current = await readGitBranch(cwd)
    const target = current ? `the project's current branch (${current})` : "the project's current branch"
    await this.deliver(cwd, threadId, [
      `Your branch ${thread.worktree.branch} conflicts with ${target}.`,
      `Rebase or merge your branch onto ${target}, resolve the conflicts, and commit the result to ${thread.worktree.branch}.`,
    ].join(' '))
  }

  // ---------------------------------------------------------------------------

  private async requireCoordinator(caller: CoordinationCaller): Promise<void> {
    const meta = await this.port.storeFor(caller.projectDir).resolve(caller.sessionId)
    if (meta?.coordination?.role !== 'coordinator') {
      throw new CoordinationError('NOT_COORDINATOR', 'Only the project coordinator session can manage threads.')
    }
  }

  private async findThread(cwd: string, threadId: string): Promise<ThreadRecord> {
    const { threads } = await this.coordinationStore(cwd).read()
    const thread = threads.find((t) => t.threadId === threadId)
    if (!thread) throw new CoordinationError('THREAD_NOT_FOUND', `No thread with id ${threadId}. Use ListThreads to see the threads.`)
    return thread
  }

  /** Queues a coordinator message on the thread's lane, cold-opening it when unloaded. */
  private async deliver(cwd: string, threadId: string, text: string): Promise<void> {
    const store = this.coordinationStore(cwd)
    const thread = await this.findThread(cwd, threadId)
    const stale = (why: string) => new CoordinationError('THREAD_STALE', `Thread ${threadId} (${sanitizeTitle(thread.title)}) ${why}; start a new thread instead.`)
    if (thread.status === 'stale') throw stale('is stale: its session no longer exists')
    if (effectiveThreadStatus(thread, new Date(), this.port.settings(cwd)) === 'resolved') {
      throw new CoordinationError('THREAD_RESOLVED', `Thread ${threadId} (${sanitizeTitle(thread.title)}) is resolved and takes no more messages; start a new thread instead.`)
    }
    if (!thread.sessionId) throw stale('never started')
    if (!(await this.port.storeFor(cwd).resolve(thread.sessionId))) {
      await store.patchThread(threadId, { status: 'stale', statusLine: 'session deleted' })
      throw stale('is stale: its session no longer exists')
    }
    const control = this.port.laneControl(thread.sessionId)
      ?? await this.port.openLane(cwd, thread.sessionId, { activate: false })
    await control.enqueueFromCoordinator(text)
    await store.patchThread(threadId, { lastActivityAt: new Date().toISOString() })
  }

  private async stopSession(cwd: string, sessionId: string): Promise<void> {
    if (sessionId) await this.port.laneControl(sessionId)?.stop()
    await this.engine.markStopped(cwd, sessionId)
  }
}
