// Turns thread turn-ends into coordinator notes and decides when to wake the
// coordinator. The decision itself is `decideWake`; this module gathers its
// input from the store and the live lanes, and acts on the verdict.

import { COMPACT_FAILURE_LIMIT } from '../../harness/compact.js'
import type { CoordinationRole, TurnOrigin } from '../../harness/types.js'
import type { CoordinationStore } from '../../services/coordination/threadStore.js'
import type { ThreadRecord } from '../../services/coordination/types.js'
import type { SessionMeta } from '../../sessions/service.js'
import type { CoordinationLaneControl } from '../protocol/coordinationHost.js'
import type { SessionEvent } from '../sessionController.js'
import { formatThreadNote, formatWakeMessage, threadStatusAfterTurn } from './messages.js'
import {
  decideWake,
  nextAutoWakeCount,
  releaseWake,
  requestWake,
  type WakeChild,
  type WakeParentState,
} from './wakeDecision.js'

export interface WakeEnginePort {
  storeFor(cwd: string): CoordinationStore
  /** The live lane of a session, if one is open. */
  laneControl(sessionId: string): CoordinationLaneControl | undefined
  /** Opens a lane for a session without a live one. */
  openLane(cwd: string, sessionId: string, options: { activate: boolean }): Promise<CoordinationLaneControl>
  notify(notice: { title: string; body: string; sessionId: string }): void
  /**
   * Replaces a coordinator whose compaction circuit opened with a freshly
   * seeded session and moves the pointer; a no-op once the pointer moved.
   */
  reseedCoordinator?(cwd: string, sessionId: string): Promise<string>
  /** Background failures; the engine never throws out of an event handler. */
  onError?(error: unknown): void
}

/** The part of a `SessionController` the engine reads. */
export interface WakeLaneController {
  onEvent(listener: (event: SessionEvent) => void): () => void
  getSessionMeta(): SessionMeta
  getSessionId(): string
}

interface LaneTurn {
  origin: TurnOrigin
  lastText: string
}

interface ProjectState {
  startingThreads: number
  /** The coordinator session whose turn is running, if any; a retired coordinator's lane never sets it. */
  runningCoordinator: string | undefined
  /** Coordinator sessions known to be replaced; their lanes are ignored synchronously. */
  retired: Set<string>
  /** A wake was refused by the lock and must be replayed on release. */
  suppressed: boolean
  lastTurnOutcome: WakeParentState['lastTurnOutcome']
  /** The last verdict asked to be re-evaluated when something settles. */
  retryPending: boolean
  /** Thread sessions whose turn ended but whose note is not written yet; they still count as running. */
  settling: Set<string>
  /** Thread sessions the coordinator stopped; their current turn only queues. */
  stopped: Set<string>
  /** Questions from AskCoordinator, keyed by thread session id. */
  questions: Map<string, string>
  /** Thread sessions currently flagged as waiting on the user. */
  needsYou: Set<string>
  chain: Promise<void>
}

const INACTIVE: ReadonlySet<ThreadRecord['status']> = new Set(['resolved', 'stale'])

export class CoordinationWakeEngine {
  private readonly projects = new Map<string, ProjectState>()

  constructor(private readonly port: WakeEnginePort) {}

  /** Wires a lane into the engine. Lanes with no coordination role are ignored. Returns the detach. */
  attachLane(cwd: string, controller: WakeLaneController, control: CoordinationLaneControl): () => void {
    const sessionId = controller.getSessionId()
    const role = (): CoordinationRole | undefined => controller.getSessionMeta().coordination?.role
    let turn: LaneTurn | undefined
    /** The compaction circuit opened on this coordinator lane; reseed at turn end. */
    let circuitOpen = false

    const offEvent = controller.onEvent((event) => {
      const r = role()
      if (!r) return
      if (event.type === 'turn-start') {
        turn = { origin: event.origin ?? 'user', lastText: '' }
        if (r === 'coordinator') this.coordinatorTurnStart(cwd, sessionId, turn.origin)
        else this.threadTurnStart(cwd, sessionId)
      } else if (event.type === 'record') {
        const rec = event.record
        if (r === 'coordinator' && rec.type === 'compact_attempt_failed' && rec.circuitOpen) circuitOpen = true
        if (turn && rec.type === 'message' && rec.role === 'assistant' && rec.content.trim()) turn.lastText = rec.content
      } else if (event.type === 'turn-end') {
        const ended = turn ?? { origin: event.origin ?? 'user', lastText: '' }
        turn = undefined
        const outcome = { aborted: event.aborted, failed: event.failed === true }
        if (r === 'coordinator') {
          const failures = controller.getSessionMeta().compactFailureCount ?? 0
          const reseed = circuitOpen || failures >= COMPACT_FAILURE_LIMIT
          circuitOpen = false
          this.coordinatorTurnEnd(cwd, sessionId, event.origin ?? ended.origin, outcome, reseed)
        }
        else this.threadTurnEnd(cwd, sessionId, ended, outcome)
      }
    })

    const offState = control.onStateChange(() => {
      const r = role()
      if (r === 'thread') this.threadStateChanged(cwd, sessionId, control)
      else if (r === 'coordinator' && this.project(cwd).retryPending) this.schedule(cwd, () => this.evaluate(cwd))
    })

    return () => {
      offEvent()
      offState()
      if (role() === 'coordinator') {
        // A wake still waiting in this lane is gone with it; don't leave the lock stuck.
        this.schedule(cwd, async () => {
          const store = this.port.storeFor(cwd)
          const coord = (await store.read()).coordinator
          if (coord?.sessionId === sessionId && coord.wakeLocked) {
            this.project(cwd).suppressed = false
            await store.setWakeLocked(false)
          }
        })
      }
    }
  }

  /** A thread is being created; report wakes wait for it. */
  beginThreadStart(cwd: string): void {
    this.project(cwd).startingThreads++
  }

  endThreadStart(cwd: string): void {
    const p = this.project(cwd)
    p.startingThreads = Math.max(0, p.startingThreads - 1)
    this.schedule(cwd, () => this.evaluate(cwd))
  }

  /** The coordinator stopped a thread: its current turn's note only queues. */
  markStopped(cwd: string, sessionId: string): void {
    const p = this.project(cwd)
    p.questions.delete(sessionId)
    if (this.port.laneControl(sessionId)?.state().streaming || p.settling.has(sessionId)) {
      p.stopped.add(sessionId)
      return
    }
    // No turn is going to end; settle the table directly.
    this.schedule(cwd, async () => {
      const store = this.port.storeFor(cwd)
      const thread = findThread(await store.read(), sessionId)
      if (thread && (thread.status === 'running' || thread.status === 'needs-you')) {
        await store.patchThread(thread.threadId, { status: 'interrupted', lastActivityAt: now() })
      }
    })
  }

  /** AskCoordinator from a thread; delivered as a question note when its turn ends. */
  noteQuestion(cwd: string, sessionId: string, question: string): void {
    this.project(cwd).questions.set(sessionId, question)
  }

  /** Runs after everything already scheduled for the project; for tests and shutdown. */
  idle(cwd: string): Promise<void> {
    return this.project(cwd).chain
  }

  private project(cwd: string): ProjectState {
    let p = this.projects.get(cwd)
    if (!p) {
      p = {
        startingThreads: 0,
        runningCoordinator: undefined,
        retired: new Set(),
        suppressed: false,
        lastTurnOutcome: 'none',
        retryPending: false,
        settling: new Set(),
        stopped: new Set(),
        questions: new Map(),
        needsYou: new Set(),
        chain: Promise.resolve(),
      }
      this.projects.set(cwd, p)
    }
    return p
  }

  /** Serializes store work per project so reads and the lock never interleave. */
  private schedule(cwd: string, job: () => Promise<void>): void {
    const p = this.project(cwd)
    p.chain = p.chain.then(job).catch((error: unknown) => this.port.onError?.(error))
  }

  // A coordinator lane whose session is no longer the pointer (replaced after
  // its compaction circuit opened) is history: its turns touch nothing here.
  // Known replacements are skipped synchronously; anything else is checked
  // against the pointer on the chain, and `evaluate` only counts the running
  // turn of the session the pointer names.

  /** True (and remembered) when the pointer no longer names this coordinator session. */
  private async isRetired(cwd: string, sessionId: string): Promise<boolean> {
    const p = this.project(cwd)
    if (p.retired.has(sessionId)) return true
    if ((await this.port.storeFor(cwd).read()).coordinator?.sessionId === sessionId) return false
    p.retired.add(sessionId)
    return true
  }

  private coordinatorTurnStart(cwd: string, sessionId: string, origin: TurnOrigin): void {
    const p = this.project(cwd)
    if (p.retired.has(sessionId)) return
    p.runningCoordinator = sessionId
    if (origin !== 'user') return
    this.schedule(cwd, async () => {
      if (await this.isRetired(cwd, sessionId)) return
      await this.port.storeFor(cwd).setAutoWakeCount(nextAutoWakeCount(0, 'user-message-in-coordinator'))
    })
  }

  private coordinatorTurnEnd(
    cwd: string,
    sessionId: string,
    origin: TurnOrigin,
    outcome: { aborted: boolean; failed: boolean },
    reseed: boolean,
  ): void {
    const p = this.project(cwd)
    if (p.retired.has(sessionId)) return
    if (p.runningCoordinator === sessionId) p.runningCoordinator = undefined
    p.lastTurnOutcome = outcome.aborted ? 'interrupted' : outcome.failed ? 'failed' : 'completed'
    this.schedule(cwd, async () => {
      if (await this.isRetired(cwd, sessionId)) return
      const store = this.port.storeFor(cwd)
      if (origin === 'wake') {
        p.suppressed = releaseWake({ locked: true, suppressed: p.suppressed }).state.suppressed
        await store.setWakeLocked(false)
      }
      if (reseed && this.port.reseedCoordinator) {
        try {
          const next = await this.port.reseedCoordinator(cwd, sessionId)
          // The new session has not run: nothing it did can hold wakes back.
          if (next !== sessionId) {
            p.retired.add(sessionId)
            p.lastTurnOutcome = 'none'
          }
        } catch (error) {
          // The old coordinator stays in place; the next tripped turn retries.
          this.port.onError?.(error)
        }
      }
      // Also the replay of anything suppressed while the wake ran.
      await this.evaluate(cwd)
    })
  }

  private threadTurnStart(cwd: string, sessionId: string): void {
    const p = this.project(cwd)
    p.stopped.delete(sessionId)
    p.needsYou.delete(sessionId)
    this.schedule(cwd, async () => {
      const store = this.port.storeFor(cwd)
      const thread = findThread(await store.read(), sessionId)
      if (thread && !INACTIVE.has(thread.status)) await store.patchThread(thread.threadId, { status: 'running', lastActivityAt: now() })
    })
  }

  private threadTurnEnd(
    cwd: string,
    sessionId: string,
    turn: LaneTurn,
    outcome: { aborted: boolean; failed: boolean },
  ): void {
    const p = this.project(cwd)
    // Marked synchronously: a sibling's evaluation must still see this thread as running.
    p.settling.add(sessionId)
    const stopped = p.stopped.delete(sessionId) || outcome.aborted
    const question = p.questions.get(sessionId)
    p.questions.delete(sessionId)
    p.needsYou.delete(sessionId)
    this.schedule(cwd, async () => {
      try {
        const store = this.port.storeFor(cwd)
        const file = await store.read()
        const thread = findThread(file, sessionId)
        if (!thread) return
        const askedQuestion = question !== undefined && !stopped && !outcome.failed
        // A thread resolved mid-turn stays resolved; its last report still goes out.
        const status = INACTIVE.has(thread.status)
          ? thread.status
          : threadStatusAfterTurn({ aborted: stopped, failed: outcome.failed, askedQuestion })
        const report = askedQuestion
          ? [`Question: ${question}`, turn.lastText].filter(Boolean).join('\n\n')
          : turn.lastText
        const text = formatThreadNote(thread, { status, report })
        await store.patchThread(thread.threadId, {
          status,
          lastActivityAt: now(),
          ...(turn.lastText ? { lastReport: turn.lastText } : {}),
        })
        if (!file.coordinator) return
        await store.enqueueNote({
          threadId: thread.threadId,
          kind: askedQuestion ? 'question' : 'report',
          // Turns the user drove, or that were stopped or failed, only queue.
          userDriven: turn.origin === 'user' || stopped || outcome.failed,
          text,
          at: now(),
        })
      } finally {
        p.settling.delete(sessionId)
      }
      await this.evaluate(cwd)
    })
  }

  private threadStateChanged(cwd: string, sessionId: string, control: CoordinationLaneControl): void {
    const p = this.project(cwd)
    const s = control.state()
    const waiting = s.streaming && s.pendingApproval
    if (waiting === p.needsYou.has(sessionId)) return
    if (waiting) p.needsYou.add(sessionId)
    else p.needsYou.delete(sessionId)
    this.schedule(cwd, async () => {
      const store = this.port.storeFor(cwd)
      const thread = findThread(await store.read(), sessionId)
      if (!thread || INACTIVE.has(thread.status)) return
      if (waiting) {
        await store.patchThread(thread.threadId, { status: 'needs-you', lastActivityAt: now() })
        this.port.notify({ title: thread.title, body: 'A thread is waiting for your approval.', sessionId })
      } else if (thread.status === 'needs-you') {
        await store.patchThread(thread.threadId, { status: 'running', lastActivityAt: now() })
      }
    })
  }

  /** Gathers the wake input, decides, and wakes the coordinator if the verdict says so. Runs on the chain. */
  private async evaluate(cwd: string): Promise<void> {
    const p = this.project(cwd)
    const store = this.port.storeFor(cwd)
    const file = await store.read()
    const coord = file.coordinator
    p.retryPending = false
    if (!coord || coord.notes.length === 0) return

    const control = this.port.laneControl(coord.sessionId)
    const live = control?.state()
    const parent: WakeParentState = {
      status: p.runningCoordinator === coord.sessionId || live?.streaming ? 'running' : 'idle',
      lastTurnOutcome: p.lastTurnOutcome,
      pendingApproval: live?.pendingApproval ?? false,
      pendingDialog: live?.pendingDialog ?? false,
      startingThreads: p.startingThreads,
    }
    const children: WakeChild[] = file.threads
      .filter((t) => !INACTIVE.has(t.status))
      .map((t) => ({
        threadId: t.threadId,
        running: p.settling.has(t.sessionId) || this.port.laneControl(t.sessionId)?.state().streaming === true,
      }))
    const verdict = decideWake({ parent, children, notes: coord.notes, autoWakeCount: coord.autoWakeCount })
    if (!verdict.wake) {
      p.retryPending = verdict.retryLater
      return
    }

    const lock = requestWake({ locked: coord.wakeLocked, suppressed: p.suppressed })
    p.suppressed = lock.state.suppressed
    if (!lock.proceed) return

    await store.setWakeLocked(true)
    const notes = await store.drainNotes()
    const count = nextAutoWakeCount(coord.autoWakeCount, 'auto-wake')
    await store.setAutoWakeCount(count)
    const text = formatWakeMessage({ reason: verdict.reason, notes: notes.map((n) => ({ threadId: n.threadId, text: n.text })), count })
    try {
      const lane = control ?? await this.port.openLane(cwd, coord.sessionId, { activate: false })
      lane.requestWake(text)
    } catch (error) {
      // Nothing was delivered: put the notes back and unlock.
      for (const note of notes) await store.enqueueNote(note)
      await store.setAutoWakeCount(coord.autoWakeCount)
      await store.setWakeLocked(false)
      throw error
    }
  }
}

function findThread(file: { threads: ThreadRecord[] }, sessionId: string): ThreadRecord | undefined {
  return file.threads.find((t) => t.sessionId === sessionId)
}

function now(): string {
  return new Date().toISOString()
}
