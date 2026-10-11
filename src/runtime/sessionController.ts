import { randomUUID } from 'node:crypto'
import type { AgentRunOverrides, ActiveModelRuntime } from '../harness/loop.js'
import { logDiagnostics, summarizeDiagnosticsForTui } from '../harness/diagnostics.js'
import type {
  AgentRunResult,
  ModelStreamEvent,
  SessionRecord,
  TaskDisplaySnapshot,
  TokenUsage,
  ToolProgressEvent,
  TurnOrigin,
} from '../harness/types.js'
import { getRecordsAfterLastCompact } from '../harness/requestPrep.js'
import { promptTokens } from '../harness/usage.js'
import { promptCacheTtlMs } from '../harness/cacheControl.js'
import { shouldIdleCompact } from './coordination/contextPolicy.js'
import { isSystemReminderBlock } from '../harness/systemReminder.js'
import { countSessionRecordsTokens } from '../prompts/budget.js'
import { generateSessionTitle } from '../harness/sessionTitle.js'
import { deriveSessionTitle, type SessionMeta, type SessionStore } from '../sessions/service.js'
import { FileHistoryService } from '../services/fileHistory/fileHistoryService.js'
import type { ImageAttachmentRef, UserInput } from '../media/types.js'
import { describeImageBlockError } from '../media/imageErrors.js'
import type { RecordProxy } from './bridges.js'
import { rollbackInterruptedPromptIfSynthetic } from './interruptRollback.js'
import { SessionRecordLedger } from './recordLedger.js'
import {
  addTokenUsage,
  createEmptySessionUsage,
  createEmptyUsage,
  findLatestTaskSnapshot,
  formatInterruptMessage,
  isEmptyUsage,
  subtractTokenUsage,
  type SessionUsage,
} from './sessionUsage.js'
import {
  formatSingleToolProgress,
  formatSubagentSpinnerProgress,
  formatToolProgress,
  truncateMiddle,
} from './toolProgress.js'
import { getToolDisplay } from '../tools/display.js'
import type { AgentSession } from './types.js'

/**
 * Everything a UI must react to during a session, as one ordered stream.
 *
 * The stream is deliberately a single union rather than named EventEmitter
 * channels: it is the exact payload a desktop shell will forward over IPC, and
 * a union lets TypeScript check the consumer's dispatch exhaustively.
 *
 * Presentation state that has no meaning outside a terminal (transcript
 * static/live partitioning, `<Static>` remount keys, spinner phase) is *not*
 * modelled here — the adapter derives it from these events.
 */
export type SessionEvent =
  /** A turn is beginning. Emitted synchronously before any I/O. */
  | { type: 'turn-start'; messageId: string; displayInput: string; createdAt: string; images?: ImageAttachmentRef[]; queuedMessageId?: string; origin?: TurnOrigin }
  /** A record reached the UI. `approvalToolUseId`/`subagentProgress` are the correlations the controller tracks. */
  | { type: 'record'; record: SessionRecord; approvalToolUseId?: string; subagentProgress?: string }
  /**
   * The set of in-flight tool calls changed. Spinner text itself lives on the snapshot.
   * `subagents` is what each foreground `Agent` call's run is doing, keyed by that call.
   */
  | { type: 'tool-progress'; listContent?: string; subagents?: SubagentActivity[] }
  /** Raw model stream event, forwarded untouched. */
  | { type: 'stream'; event: ModelStreamEvent }
  /** A one-off message to surface in the transcript. */
  | { type: 'notice'; level: 'system' | 'error'; content: string }
  /**
   * The session's own metadata moved without the session moving — today, the
   * title it takes from its first message.
   *
   * Separate from `record` because the consumers are different: a shell draws
   * this in its window chrome (a tab, a sidebar row, a header), not in the
   * transcript. The id never changes here; a shell that reacts by *switching*
   * sessions has misread it.
   */
  | { type: 'session-meta'; session: SessionMeta }
  /** The session's records were replaced wholesale; rebuild from `records`. */
  | { type: 'transcript-reset'; records: readonly SessionRecord[]; systemMessages: readonly string[]; bumpGeneration: boolean }
  /** An interrupted prompt was rolled back; put the input back in the composer. */
  | { type: 'restore-input'; text: string; images?: ImageAttachmentRef[] }
  /** The loop switched models on its own (fallback activation). */
  | { type: 'active-model'; model: Omit<ActiveModelRuntime, 'provider'> }
  /**
   * The turn finished. `aborted` mirrors `AbortSignal.aborted`, *not* "did it
   * throw" — a failed turn is not aborted and still gets a duration summary.
   */
  | { type: 'turn-end'; origin?: TurnOrigin; failed?: boolean; aborted: boolean; rolledBack: boolean; durationMs: number; usage?: TokenUsage }

/**
 * A submission that came from the message queue (design §12.2).
 *
 * `onAccepted` is the hand-off's consume signal, and it deliberately does not
 * ride on `submit`'s returned promise: that resolves when the *turn* is over,
 * which is far too late to be an acceptance confirmation — a queue that waited
 * for it would keep a message that is already in the conversation. It fires
 * once, when the user record reaches disk, and never for a submission the
 * runtime refused before that point.
 */
export interface QueuedSubmissionHandoff {
  /** Stamped on the user record, so a replay can tell the message was sent. */
  queuedMessageId: string
  onAccepted: () => void
}

/** The pull-based half of the controller, shaped for `useSyncExternalStore`. */
export interface SessionControllerSnapshot {
  readonly isStreaming: boolean
  readonly usage: SessionUsage
  readonly taskSnapshot: TaskDisplaySnapshot | undefined
  readonly spinnerSubText: string | undefined
  /**
   * How much of the context window the conversation occupies, and the only
   * definition of it: the last request's `promptTokens` plus an estimate for
   * every record appended since. Both the TUI status line and the desktop strip
   * read this field rather than deriving a number of their own.
   */
  readonly contextUsedTokens: number | undefined
  /**
   * Output tokens the current turn's foreground requests have reported so far —
   * no subagents, no compaction. Cleared when a turn starts and absent until its
   * first response lands; an aborted or failed turn keeps what it reported.
   */
  readonly turnOutputTokens: number | undefined
}

export interface SessionControllerDeps {
  cwd: string
  store: SessionStore
  session: SessionMeta
  existingRecords: readonly SessionRecord[]
  /** The controller owns all three of this proxy's handlers; nothing else may install them. */
  recordProxy: RecordProxy
  /** Read once per turn, so a mid-turn runtime swap cannot retarget the in-flight run. */
  getSession: () => AgentSession
  /** Seam for tests; production backs up real files under `~/.myagent`. */
  createFileHistoryService?: (cwd: string, sessionId: string) => FileHistoryService
}

/** The latest tool a subagent run started, for the parent `Agent` call that owns the run. */
export interface SubagentActivity {
  /** The parent's `Agent` tool_use id. */
  toolUseId: string
  tool: string
  summary: string
  /** Tool calls the run has started so far. */
  toolCount: number
  /** The run's own id, which names its transcript file. */
  agentId?: string
}

/**
 * The headless half of a chat session: turn lifecycle, token accounting,
 * file history, tool-progress correlation and interrupt rollback.
 *
 * Owns no framework state. The TUI subscribes to {@link onEvent} for the
 * ordered stream and to {@link subscribe}/{@link getSnapshot} for the pull
 * state; an Electron main process can forward both across IPC unchanged.
 */
export class SessionController {
  private readonly cwd: string
  private readonly store: SessionStore
  private readonly recordProxy: RecordProxy
  private readonly getSession: () => AgentSession
  private readonly newFileHistoryService: (cwd: string, sessionId: string) => FileHistoryService

  private session: SessionMeta
  private abortController: AbortController | null = null
  /** Most recent tool_use id per tool name, for matching the approval record that follows. */
  private readonly lastToolUseIdByTool = new Map<string, string>()
  private readonly activeToolProgress = new Map<string, ToolProgressEvent>()
  private readonly subagentProgress = new Map<string, string>()
  private readonly subagentActivity = new Map<string, SubagentActivity>()
  private fileHistory: FileHistoryService
  /**
   * False until `init()` has replayed the log. Snapshots taken before that
   * would be wiped by the replay, and an edit tracked before the turn's
   * snapshot exists has nothing to attach itself to.
   */
  private fileHistoryReady = false
  private didRollback = false
  private loopStartMs = 0
  /** The queued submission waiting for its user record; see {@link QueuedSubmissionHandoff}. */
  private pendingAcceptance: { messageId: string; notify: () => void } | undefined

  private streaming = false
  private usage: SessionUsage = createEmptySessionUsage()
  /**
   * What the current run has already folded into `usage.total` request by
   * request. Reset at the top of every run and subtracted from the end-of-run
   * figure at the settle, so the live readout and the authoritative accounting
   * agree instead of double-counting each other.
   */
  private runReportedUsage = createEmptyUsage()
  private turnOutputTokens: number | undefined
  private taskSnapshot: TaskDisplaySnapshot | undefined
  private spinnerSubText: string | undefined
  /** Records of the live session, for the part of the context estimate no usage covers. */
  private readonly ledger: SessionRecordLedger
  /** Last record the most recent request carried; everything after it is estimated. */
  private usageAnchorRecordId: string | undefined
  /** When the last provider response landed; idle compaction measures from here. */
  private lastRequestAt: number | undefined
  /** Memo for {@link contextUsed}, invalidated by either input that feeds it. */
  private contextUsedMemo:
    | { anchor: string | undefined; size: number; base: number | undefined; tokens: number }
    | undefined

  private snapshot: SessionControllerSnapshot
  private readonly listeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: SessionEvent) => void>()
  private disposed = false

  constructor(deps: SessionControllerDeps) {
    this.cwd = deps.cwd
    this.store = deps.store
    this.recordProxy = deps.recordProxy
    this.getSession = deps.getSession
    this.newFileHistoryService = deps.createFileHistoryService
      ?? ((cwd, sessionId) => new FileHistoryService(cwd, sessionId))
    this.session = deps.session
    this.ledger = new SessionRecordLedger(deps.existingRecords)
    this.taskSnapshot = findLatestTaskSnapshot(deps.existingRecords)
    this.snapshot = this.buildSnapshot()

    this.fileHistory = this.newFileHistoryService(this.cwd, this.session.id)
    this.initFileHistory(this.fileHistory)

    this.recordProxy.setHandler(this.handleRecord)
    this.recordProxy.setProgressHandler(this.handleProgress)
    this.recordProxy.setStreamEventHandler(this.handleStreamEvent)
    this.recordProxy.setRequestUsageHandler(this.handleRequestUsage)
    this.seedUsageFromMetrics(this.session.id)
  }

  // --- pull state -----------------------------------------------------------

  getSnapshot = (): SessionControllerSnapshot => this.snapshot

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Live per-agent progress text. Deliberately *not* on the snapshot: consumers
   * need the whole map by reference and it changes on every tool event.
   */
  getSubagentProgress(): ReadonlyMap<string, string> {
    return this.subagentProgress
  }

  // --- event stream ---------------------------------------------------------

  onEvent(listener: (event: SessionEvent) => void): () => void {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  // --- commands -------------------------------------------------------------

  /**
   * Runs one turn. Resolves when the turn is over, however it ended.
   *
   * The input is a {@link UserInput} — text always, image refs when the turn
   * has any — so the submission path has a single shape from either shell down
   * to the loop. Callers that only have text wrap it as `{ text }`; there is no
   * parallel string channel on this method.
   *
   * Rejects rather than queueing when a turn is already in flight: everything
   * below assigns to `this.abortController`, so a second concurrent run would
   * overwrite the live one and leave the first turn impossible to interrupt.
   * Deciding *what* to do with the rejected input is a shell's job — the two
   * shells answer differently (both enqueue it, but "the UI is blocked" means
   * different things; see `queuePump.ts`) — and both callers catch it.
   *
   * It throws rather than silently returning because a dropped message is
   * indistinguishable from a message that was sent and answered with nothing.
   */
  /**
   * The submission gate without the submission (design §12.2).
   *
   * The queue's accept path runs this so an input the active model cannot take
   * is refused while the composer still holds it, instead of being persisted
   * and refused later with nothing left to hand back. It reads the model in
   * effect *now*; the pump re-checks against whatever is actually serving the
   * request when the message's turn comes, because either can change while the
   * message waits.
   */
  assertInputAcceptable(input: UserInput): void {
    this.getSession().loop.assertImagesAllowedForSubmission(input)
  }

  async submit(input: UserInput, options?: AgentRunOverrides, handoff?: QueuedSubmissionHandoff): Promise<void> {
    if (this.streaming) {
      throw new Error('A turn is already running; queue the message instead of submitting it.')
    }
    const agentSession = this.getSession()
    const loop = agentSession.loop
    const messageId = randomUUID()
    const origin: TurnOrigin = options?.origin ?? 'user'
    let runOverrides: AgentRunOverrides | undefined = handoff
      ? { ...options, sourceQueuedMessageId: handoff.queuedMessageId }
      : options
    if (this.shouldCompactIdle(loop)) runOverrides = { ...runOverrides, compactBeforeSend: true }
    let failed = false

    // Submission preparation (design §9.2): the new-image gate runs before
    // turn-start is emitted and before any record exists, so a blocked input
    // stays a rejected submit — the caller's draft is untouched — instead of a
    // turn that started and immediately failed. Shares the rule the loop
    // re-checks per request; @-mentioned images are gated inside run().
    loop.assertImagesAllowedForSubmission(input, runOverrides)

    this.emit({
      type: 'turn-start',
      messageId,
      origin,
      displayInput: options?.displayInput ?? input.text,
      createdAt: new Date().toISOString(),
      ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      ...(handoff ? { queuedMessageId: handoff.queuedMessageId } : {}),
    })

    this.streaming = true
    this.spinnerSubText = undefined
    this.turnOutputTokens = undefined

    const ac = new AbortController()
    let completedResult: AgentRunResult | undefined

    // The `try` starts here rather than after the checkpoint so that *every*
    // statement past `streaming = true` is covered by the `finally` that clears
    // it. `publish()` calls its subscribers synchronously and one of them is a
    // channel post, so a dead renderer used to be able to throw out of this
    // method with the flag still set — which merely wedged the spinner before
    // the guard above existed, and would now reject every later turn as well.
    // Ordering inside is unchanged: publish, then snapshot, then run.
    try {
      this.publish()

      await this.snapshotFileHistory(messageId)

      this.abortController = ac
      this.didRollback = false
      this.loopStartMs = Date.now()
      // Zeroed before the first request of this run, not after the last one: an
      // aborted or failed run never reaches the settle below, and a leftover
      // accumulator would be subtracted from the *next* run's total.
      this.runReportedUsage = createEmptyUsage()
      // Armed for the whole run, not just the first record: the user record is
      // the *only* thing that resolves it, and nothing else may.
      if (handoff) this.pendingAcceptance = { messageId, notify: handoff.onAccepted }

      const result = await loop.run(input, ac.signal, messageId, runOverrides)
      completedResult = result
      this.usage = {
        // Already live from `handleRequestUsage`; this is the settle, not the
        // first sighting. Falling back to what is there rather than to null
        // matters for a run that produced no response at all — the last request
        // still describes the context, and dropping it would send the readout
        // back to the record-only estimate.
        lastRequest: result.statusUsage ?? this.usage.lastRequest,
        // Only the part `handleRequestUsage` could not have seen: compaction
        // (`loop.ts` folds `compactResult.usage` in) and subagent transcripts,
        // neither of which is a foreground response. Adding `result.usage`
        // whole would count every foreground request twice.
        total: addTokenUsage(
          this.usage.total,
          subtractTokenUsage(result.usage, this.runReportedUsage),
        ),
      }
      this.publish()
    } catch (err: unknown) {
      if (err instanceof Error && (err.name === 'AbortError' || (err as Error & { aborted?: boolean }).aborted)) {
        const restored = await this.tryRestoreInterruptedPrompt(ac.signal, messageId, input)
        if (restored) {
          this.didRollback = true
        } else {
          this.emit({
            type: 'notice',
            level: 'system',
            content: await formatInterruptMessage(this.store, this.session.id, messageId),
          })
        }
      } else {
        failed = true
        // A mid-turn image block (a fallback or plan route onto a text-only
        // model, the provider's final check) leaves the notice as its only
        // trace, so it arrives with its exit attached (design §13, S24). A
        // provider HTTP error, a bad endpoint, or an outage passes through
        // word for word: labelling those as an image problem would be a lie.
        this.emit({
          type: 'notice',
          level: 'error',
          content: describeImageBlockError(err),
        })
      }
    } finally {
      this.emit({ type: 'active-model', model: loop.getActiveModel() })

      this.pendingAcceptance = undefined
      this.abortController = null
      this.lastToolUseIdByTool.clear()
      this.activeToolProgress.clear()
      this.subagentProgress.clear()
      this.subagentActivity.clear()
      this.streaming = false
      this.spinnerSubText = undefined
      this.publish()

      this.emit({
        type: 'turn-end',
        origin,
        failed,
        aborted: ac.signal.aborted,
        rolledBack: this.didRollback,
        durationMs: Date.now() - this.loopStartMs,
        ...(completedResult ? { usage: completedResult.usage } : {}),
      })
    }
  }

  interrupt(reason: unknown = 'user-cancel'): void {
    this.abortController?.abort(reason)
  }

  /** Reloads records from disk (after truncation or a rewind) and rebuilds the view. */
  async reload(): Promise<SessionRecord[]> {
    const loaded = await this.store.loadRecordsWithDiagnostics(this.session.id)
    logDiagnostics(loaded.diagnostics)
    const summary = summarizeDiagnosticsForTui(loaded.diagnostics)
    this.ledger.rebase(loaded.records)
    this.taskSnapshot = findLatestTaskSnapshot(loaded.records)
    this.publish()
    this.emit({
      type: 'transcript-reset',
      records: loaded.records,
      systemMessages: summary ? [summary] : [],
      bumpGeneration: true,
    })
    return loaded.records
  }

  /**
   * Points the controller at a different session (`/clear`, `/resume`).
   * Resets everything that is scoped to a session, including token totals.
   */
  retarget(session: SessionMeta, records: readonly SessionRecord[]): void {
    this.session = session
    this.lastToolUseIdByTool.clear()
    this.activeToolProgress.clear()
    this.subagentProgress.clear()
    this.subagentActivity.clear()
    this.usage = createEmptySessionUsage()
    this.usageAnchorRecordId = undefined
    this.ledger.rebase(records)
    this.seedUsageFromMetrics(session.id)
    this.taskSnapshot = findLatestTaskSnapshot(records)
    this.spinnerSubText = undefined
    this.fileHistoryReady = false
    // The outgoing service may still have backups in flight.
    this.fileHistory.dispose()
    this.fileHistory = this.newFileHistoryService(this.cwd, session.id)
    this.initFileHistory(this.fileHistory)
    this.publish()
  }

  /**
   * Refreshes the session meta *in place* — the session did not move, only its
   * metadata did (a rename).
   *
   * `retarget` is the wrong tool for that: it is the session-switch path and
   * clears usage, tool progress and the file history. The id guard is the
   * invariant that keeps the distinction real — this must never become a back
   * door around `sessionSwitch.ts`.
   */
  refreshSessionMeta(session: SessionMeta): void {
    if (session.id !== this.session.id) {
      throw new Error('refreshSessionMeta cannot change the session id; use retarget')
    }
    this.session = session
    this.publish()
  }

  /** The one file history for the active session; also drives `/rewind`. */
  getFileHistoryService(): FileHistoryService {
    return this.fileHistory
  }

  /**
   * Backs a file up before a write tool changes it. Handed to the scope's tool
   * context, so it must follow `retarget` to whichever session is live now —
   * hence the method rather than a bound reference to the service.
   */
  trackFileEdit = async (filePath: string): Promise<void> => {
    if (!this.fileHistoryReady) return
    try {
      await this.fileHistory.trackEdit(filePath)
    } catch (err) {
      // The edit itself matters more than being able to undo it.
      debugFileHistory(`Failed to track ${filePath}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  getSessionId(): string {
    return this.session.id
  }

  /**
   * The session this controller currently drives, which `retarget` moves.
   *
   * Named for the meta rather than "session" because the dep of that name is
   * the *runtime*. Exposed so nothing downstream has to keep a second copy in
   * sync: a `SessionPane` derives its session from here rather than tracking
   * one that a `/clear` in between would leave stale.
   */
  getSessionMeta(): SessionMeta {
    return this.session
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.fileHistoryReady = false
    // Stops any further backup or log write from a session that is going away.
    this.fileHistory.dispose()
    this.recordProxy.setHandler(() => {})
    this.recordProxy.setProgressHandler(() => {})
    this.recordProxy.setStreamEventHandler(() => {})
    this.recordProxy.setRequestUsageHandler(() => {})
    this.listeners.clear()
    this.eventListeners.clear()
  }

  // --- proxy handlers -------------------------------------------------------

  /**
   * A provider request just settled: publish its size straight away.
   *
   * The total moves here too, so the readout under the composer counts up
   * through a long turn instead of jumping once at the end. `runReportedUsage`
   * remembers what this path contributed and `sendMessage`'s settle subtracts
   * it, since `AgentRunResult.usage` is the sum of exactly these responses plus
   * the compaction and subagent usage this path never sees.
   *
   * A run that aborts or throws keeps what was reported — those tokens were
   * spent whether or not the turn finished.
   */
  private handleRequestUsage = (usage: TokenUsage, anchorRecordId?: string): void => {
    this.runReportedUsage = addTokenUsage(this.runReportedUsage, usage)
    this.turnOutputTokens = (this.turnOutputTokens ?? 0) + usage.outputTokens
    this.usage = { lastRequest: usage, total: addTokenUsage(this.usage.total, usage) }
    this.usageAnchorRecordId = anchorRecordId
    this.lastRequestAt = Date.now()
    this.publish()
  }

  /** Coordinator sessions only: the prompt cache went cold while idle and the context is big enough to compact. */
  private shouldCompactIdle(loop: AgentSession['loop']): boolean {
    if (this.session.coordination?.role !== 'coordinator') return false
    let at = this.lastRequestAt
    if (at === undefined) {
      const records = this.ledger.list()
      for (let i = records.length - 1; i >= 0; i--) {
        const record = records[i]!
        if (record.type === 'message' && record.role === 'assistant') {
          const parsed = Date.parse(record.createdAt)
          if (Number.isFinite(parsed)) at = parsed
          break
        }
      }
    }
    if (at === undefined) return false
    const lastRequest = this.usage.lastRequest
    return shouldIdleCompact({
      idleMs: Date.now() - at,
      cacheTtlMs: promptCacheTtlMs(),
      ...(lastRequest ? { occupiedTokens: promptTokens(lastRequest) } : {}),
      usableContextWindow: loop.getContextBudget().usableContextWindow,
    })
  }

  /**
   * The context readout (see {@link SessionControllerSnapshot.contextUsedTokens}).
   *
   * The provider's count describes the request it answered, which is already a
   * turn behind by the time its tool results land — so the records after the
   * anchor are estimated on top of it. Without an anchor (a resumed session
   * before its first request, or one whose anchor a compaction or a rewind took
   * away) the whole transcript is estimated instead, which is what the
   * compactor thresholds on anyway.
   *
   * Memoized because this runs on every publish, and publish now fires per
   * record.
   */
  /**
   * The system text, or nothing when no runtime is installed yet — the first
   * snapshot is built in the constructor, before a session exists, and a
   * misconfigured model never gets one at all.
   */
  private systemPromptForEstimate(): string | undefined {
    try {
      return this.getSession().loop.getSystemPrompt()
    } catch {
      return undefined
    }
  }

  private contextUsed(): number | undefined {
    const anchor = this.usageAnchorRecordId
    const size = this.ledger.size
    const base = this.usage.lastRequest ? promptTokens(this.usage.lastRequest) : undefined
    if (base === undefined && size === 0) return undefined
    const memo = this.contextUsedMemo
    if (!memo || memo.anchor !== anchor || memo.size !== size || memo.base !== base) {
      const records = this.ledger.list()
      let anchorIndex = -1
      if (anchor !== undefined) {
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i]?.id === anchor) { anchorIndex = i; break }
        }
      }
      const tokens = base !== undefined && anchorIndex >= 0
        ? base + countSessionRecordsTokens(records.slice(anchorIndex + 1))
        // No anchor: estimate the same thing a request would carry — the
        // records the compactor would keep, plus the system prompt no record
        // accounts for. Counting the whole ledger bare reads low on a resumed
        // session and double-counts everything a compaction already dropped.
        : countSessionRecordsTokens(getRecordsAfterLastCompact([...records]), this.systemPromptForEstimate())
      this.contextUsedMemo = { anchor, size, base, tokens }
      return tokens
    }
    return memo.tokens
  }

  /**
   * Restores both halves of the usage from the metrics sidecar for a session
   * that was not started in this process.
   *
   * `lastRequest` is the context readout; the total is what the hit rate and the
   * cost are computed over, and leaving it at zero made a resumed session read
   * as a cold one — the first request after a resume is mostly cache writes, so
   * the rate beside it collapsed until enough warm turns had run to outweigh it.
   *
   * Deliberately fire-and-forget: this is a readout, and neither the
   * constructor nor `retarget` may become async for it. Every guard matters —
   * the session can move again before a read lands, and a real request can beat
   * it, and a stale disk number must never overwrite either.
   */
  private seedUsageFromMetrics(sessionId: string): void {
    try {
      void this.store.loadLastRequestUsage(sessionId).then((usage) => {
        if (!usage || this.disposed) return
        if (this.session.id !== sessionId || this.usage.lastRequest) return
        this.usage = { lastRequest: usage, total: this.usage.total }
        this.publish()
      }).catch(() => {
        // Best-effort, exactly like the metrics that back it.
      })
      void this.store.loadSessionTotals(sessionId).then((total) => {
        if (!total || this.disposed) return
        // `isEmptyUsage` rather than a "did anything arrive" flag: a request
        // that landed while this was in flight has already counted itself into
        // the total, and adding the session's history to it would double every
        // turn that ran in this process.
        if (this.session.id !== sessionId || !isEmptyUsage(this.usage.total)) return
        this.usage = { lastRequest: this.usage.lastRequest, total }
        this.publish()
      }).catch(() => {
        // Best-effort, exactly like the metrics that back it.
      })
    } catch {
      // A store that cannot answer at all (a stub in a test) must not take the
      // constructor down with it.
    }
  }

  private handleRecord = (record: SessionRecord): void => {
    let approvalToolUseId: string | undefined
    let subagentProgress: string | undefined

    // The context readout grows with the transcript, not just with responses,
    // so a turn that reads ten files shows it while the tools are still running.
    if (this.ledger.track(record)) this.publish()

    this.noteDerivedTitle(record)
    this.noteQueuedSubmissionAccepted(record)

    if (record.type === 'tool_use') {
      this.lastToolUseIdByTool.set(record.tool, record.id)
    } else if (record.type === 'tool_approval') {
      approvalToolUseId = this.lastToolUseIdByTool.get(record.tool)
    } else if (record.type === 'tool_result') {
      this.subagentActivity.delete(record.toolUseId)
      if (record.display?.taskSnapshot) {
        this.taskSnapshot = record.display.taskSnapshot
        if (this.activeToolProgress.size === 0) this.spinnerSubText = undefined
        this.publish()
      }
    } else if (record.type === 'subagent_task') {
      subagentProgress = this.subagentProgress.get(record.agentId)
    }

    this.emit({
      type: 'record',
      record,
      ...(approvalToolUseId !== undefined ? { approvalToolUseId } : {}),
      ...(subagentProgress !== undefined ? { subagentProgress } : {}),
    })
  }

  private handleProgress = (event: ToolProgressEvent): void => {
    if (event.phase === 'started') {
      this.activeToolProgress.set(event.call.id, event)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        this.subagentProgress.set(event.source.agentId, formatSingleToolProgress(event))
      }
      const parentToolUseId = event.source?.parentToolUseId
      if (parentToolUseId) {
        this.subagentActivity.set(parentToolUseId, {
          toolUseId: parentToolUseId,
          tool: event.call.name,
          summary: subagentStepSummary(event.call.name, event.call.input),
          toolCount: (this.subagentActivity.get(parentToolUseId)?.toolCount ?? 0) + 1,
          ...(event.source?.agentId ? { agentId: event.source.agentId } : {}),
        })
      }
    } else {
      this.activeToolProgress.delete(event.call.id)
      if (event.source?.type === 'subagent' && event.source.agentId) {
        this.subagentProgress.delete(event.source.agentId)
      }
    }

    const activeEvents = [...this.activeToolProgress.values()]
    const foregroundEvents = activeEvents.filter((candidate) => candidate.source?.type !== 'subagent')
    const backgroundEvents = activeEvents.filter((candidate) => candidate.source?.type === 'subagent')
    const content = foregroundEvents.length > 0
      ? formatToolProgress(foregroundEvents)
      : formatSubagentSpinnerProgress(backgroundEvents)

    this.spinnerSubText = content
    this.publish()
    this.emit({
      type: 'tool-progress',
      ...(foregroundEvents.length > 1 && content !== undefined ? { listContent: content } : {}),
      ...(this.subagentActivity.size > 0 ? { subagents: [...this.subagentActivity.values()] } : {}),
    })
  }

  private handleStreamEvent = (event: ModelStreamEvent): void => {
    this.emit({ type: 'stream', event })
  }

  /**
   * Picks up the title the store just derived, for a session that had none.
   *
   * The store names a session from its first user message, inside
   * `appendRecord` — but nothing used to tell the *pane* about it. A pane's
   * session meta is the source every window projection reads
   * (`ProjectDirectory.describe` → `WireLaneInfo.sessionTitle`), so the canvas
   * header showed 「未命名会话」 for the whole first turn and the sidebar only
   * caught up when something else re-listed the store from disk.
   *
   * Derived rather than re-read: `AgentLoop.appendRecord` awaits the append
   * before it announces the record, so the index already holds this exact
   * string — `deriveSessionTitle` is the store's own rule — and a disk read here
   * would buy a race and a round trip for a value we have.
   */
  private noteDerivedTitle(record: SessionRecord): void {
    if (this.session.title !== undefined) return
    const title = deriveSessionTitle(record)
    if (title === undefined) return
    this.session = { ...this.session, title }
    this.publish()
    this.emit({ type: 'session-meta', session: this.session })
    void this.generateTitle(record, title)
  }

  /**
   * Replaces the first-message fallback with a model-written name, in the
   * background. Only lands if the title is still the fallback — a rename the
   * user made meanwhile, or a session switch, wins. Failure keeps the fallback.
   */
  private async generateTitle(record: SessionRecord, fallback: string): Promise<void> {
    if (record.type !== 'message') return
    const sessionId = this.session.id
    try {
      const text = (record.displayContent ?? record.content).trim()
      if (!text) return
      const generated = await generateSessionTitle({
        runtime: this.getSession().loop.getSideModel(),
        text,
        cwd: this.cwd,
      })
      if (!generated || generated === fallback) return
      if (this.disposed || this.session.id !== sessionId || this.session.title !== fallback) return
      await this.store.rename(sessionId, generated)
      if (this.disposed || this.session.id !== sessionId || this.session.title !== fallback) return
      this.session = { ...this.session, title: generated }
      this.publish()
      this.emit({ type: 'session-meta', session: this.session })
    } catch {
      // Best-effort: the fallback title stays.
    }
  }

  /**
   * Tells the queue its message has been accepted, the moment the user record
   * exists.
   *
   * Read off the record stream rather than announced by the loop because that
   * is precisely the event the queue's guarantee is written against: the record
   * has been appended — `AgentLoop.appendRecord` awaits the append before it
   * publishes — so from here on the message is in the conversation and must not
   * be sent a second time. Fires once; the turn's own records that follow (and
   * the synthetic user messages a turn appends) do not match the id.
   */
  private noteQueuedSubmissionAccepted(record: SessionRecord): void {
    const pending = this.pendingAcceptance
    if (!pending) return
    if (record.type !== 'message' || record.id !== pending.messageId) return
    this.pendingAcceptance = undefined
    pending.notify()
  }

  // --- internals ------------------------------------------------------------

  /**
   * A user-cancelled turn that produced nothing but synthetic interruption
   * records is rolled back entirely, so the prompt returns to the composer.
   *
   * The restore carries the input's images with its text, in their original
   * order: the rollback removed the user message that held them, and a
   * text-only restore would silently drop attachments the user still means to
   * send. The receiving shell owns what a restored draft looks like; this
   * method only guarantees the refs survive the round trip.
   */
  private async tryRestoreInterruptedPrompt(
    signal: AbortSignal,
    userMessageId: string,
    input: UserInput,
  ): Promise<boolean> {
    // A wake turn's reminders are not a draft to hand back, and dropping them
    // would lose the result they report.
    if (signal.reason !== 'user-cancel' || isSystemReminderBlock(input.text)) return false

    try {
      const records = await rollbackInterruptedPromptIfSynthetic({
        store: this.store,
        sessionId: this.session.id,
        userMessageId,
      })
      if (!records) return false

      this.getSession().loop.invalidateRecordsCache()
      this.ledger.rebase(records)
      this.taskSnapshot = findLatestTaskSnapshot(records)
      this.publish()
      // Rebuilt from scratch, but without bumping the generation: this is a
      // rollback of the current turn, not a new conversation view.
      this.emit({ type: 'transcript-reset', records, systemMessages: [], bumpGeneration: false })
      this.emit({
        type: 'restore-input',
        text: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Opens the turn's snapshot. Every tracked file is carried forward at its
   * current version, so the edits this turn is about to make have something to
   * be undone back to.
   *
   * There is no "checkpoints are off for this session" state to report any
   * more: the cost is proportional to what the agent edited, not to the size of
   * the worktree, so no root is too large to snapshot.
   */
  private async snapshotFileHistory(messageId: string): Promise<void> {
    if (!this.fileHistoryReady) return
    try {
      await this.fileHistory.makeSnapshot(messageId)
    } catch (err) {
      // Graceful degradation: log and run the turn without a snapshot.
      debugFileHistory(`Error creating snapshot: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private initFileHistory(service: FileHistoryService): void {
    void service.init().then(() => {
      // A later retarget may have already replaced it; only the live one counts.
      if (this.fileHistory === service && !this.disposed) this.fileHistoryReady = true
    }).catch((err) => {
      if (this.fileHistory === service) this.fileHistoryReady = false
      debugFileHistory(`Failed to initialize FileHistoryService: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  private buildSnapshot(): SessionControllerSnapshot {
    return Object.freeze({
      isStreaming: this.streaming,
      usage: this.usage,
      taskSnapshot: this.taskSnapshot,
      spinnerSubText: this.spinnerSubText,
      contextUsedTokens: this.contextUsed(),
      turnOutputTokens: this.turnOutputTokens,
    })
  }

  /** Swaps in a new snapshot and notifies, but only when something actually changed. */
  private publish(): void {
    const next = this.buildSnapshot()
    const previous = this.snapshot
    if (
      next.isStreaming === previous.isStreaming
      && next.usage === previous.usage
      && next.taskSnapshot === previous.taskSnapshot
      && next.spinnerSubText === previous.spinnerSubText
      && next.contextUsedTokens === previous.contextUsedTokens
      && next.turnOutputTokens === previous.turnOutputTokens
    ) return

    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }

  private emit(event: SessionEvent): void {
    for (const listener of [...this.eventListeners]) listener(event)
  }
}

function debugFileHistory(message: string): void {
  if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
    console.error(`[hanekawa][file-history] ${message}`)
  }
}

/** One line naming what a subagent's tool call targets. Searches show the bare
 * pattern: their shared summary spells out `pattern: "…"`, which is noise in a
 * one-line progress caption. */
function subagentStepSummary(tool: string, input: unknown): string {
  if ((tool === 'Grep' || tool === 'Glob') && typeof input === 'object' && input !== null) {
    const pattern = (input as { pattern?: unknown }).pattern
    if (typeof pattern === 'string') return truncateMiddle(pattern, 80)
  }
  return getToolDisplay(tool, input).summary
}
