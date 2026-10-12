import type { ModelStreamEvent, PersistedQueuedMessage, SessionRecord, SubagentTaskStatus, ToolErrorCode, ToolResultDisplay } from '../../../harness/types.js'
import type { SessionEvent, SubagentActivity } from '../../../runtime/sessionController.js'
import type { ImageAttachmentRef } from '../../../media/types.js'
import type { ToolDisplayDto } from '../../../runtime/protocol/wire.js'
import { parseCoordinationUpdate, parseThreadNoteMessage, type ThreadNotesData } from './threadNotes.js'

/**
 * The transcript as data: a list of items plus whatever is still in flight.
 *
 * This is the DOM counterpart of `src/tui/transcript.ts`, and it is much
 * smaller for one reason — Ink's `<Static>` output cannot be retracted once a
 * later sibling is emitted, so the terminal has to partition items into
 * static/live and promote them in a strict order. A DOM node can simply be
 * replaced, so a streaming draft is just an item flagged `pending` that a later
 * record overwrites.
 *
 * `applySessionEvent` is exhaustive over `SessionEvent` with an `assertNever`
 * tail, so a new variant on the controller is a compile error here rather than
 * an event the desktop silently drops (which is exactly what shipped before:
 * six of the ten were ignored).
 *
 * DOM-free on purpose — `test/` imports this, and that puts it in the base
 * tsconfig program, which has no DOM lib.
 *
 * ## Activity runs
 *
 * **`items` stays the single authoritative list, and the activity runs are a pure
 * derivation over it** (`groupTranscript`). It is not a second structure the fold
 * has to keep in step.
 *
 * That is what makes the live/replay symmetry cheap rather than a standing risk:
 * the two agree on the runs exactly when they agree on `items`, which is one
 * property to test instead of two code paths to keep aligned. Every fact a run
 * needs therefore rides on an item — `turnId`, `createdAt` (the span a replayed
 * turn is timed by), `durationMs` on the turn's `duration` item (the authoritative
 * elapsed time), `interrupt` (an aborted turn).
 *
 * ## Live and replay produce the *same* items (§4.2, T3)
 *
 * Two rules buy that equality, and both are load-bearing:
 *
 * 1. **A thinking segment is one model request.** `message_start` closes the open
 *    segment and the next `thinking_delta` opens a new one, which is the shape
 *    `thinkingBlocks` replays into. (Before T3 a whole turn appended into one
 *    block, so the segment count itself differed between the two paths.)
 * 2. **The assistant record supersedes what streamed, in place.** The draft text
 *    and the open thinking segment are the same reasoning the record persists, so
 *    the record's items overwrite them at their existing positions — same order,
 *    and the same *ids*, which is what lets an open/closed toggle survive the
 *    commit and what makes the two trees compare field-for-field.
 *
 * Live items are stamped with `turnId` from the records already seen this turn, so
 * a streaming segment belongs to its turn before the turn ends.
 *
 * ## A tool is one step, not two rows (§4.5, T4)
 *
 * `tool_use` and `tool_result` share one item, keyed by the call's id, and the
 * result *merges into* the call rather than replacing it — the caption, the
 * arguments and the start time all live on the call side and are still what the
 * collapsed head reads after the result lands. The elapsed time falls out of the
 * two `createdAt`s, so no record gained a field for it.
 *
 * The caption itself is not guessed here any more: `ToolDisplayDto` is projected
 * host-side from `src/tools/display.ts` (T1), which is the same source the TUI
 * reads, and a lookup is handed in by the caller. Without one — an older host —
 * the previous key-guessing (`toolCallSummary` / `toolResultSummary`) still runs,
 * so an old client degrades rather than showing raw JSON.
 */

export type TranscriptItemKind =
  | 'user'
  | 'assistant'
  | 'thinking'
  | 'tool'
  | 'notice'
  | 'error'
  | 'subagent'
  | 'duration'
  | 'thread-notes'
  | 'receipt'

/**
 * How the host captions a `tool_use` record, by record id.
 *
 * A function rather than the map itself: `SessionClient` accumulates captions as
 * payloads arrive and a `tool_result` ten seconds later is drawn under the same
 * header, so the fold has to ask at the moment it builds the item.
 */
export type ToolDisplayLookup = (recordId: string) => ToolDisplayDto | undefined

/** §3's four states. The colour is never the only carrier; see `toolStatusLabel`. */
export type ToolStepStatus = 'awaiting-approval' | 'running' | 'done' | 'failed'

/**
 * The sub-agent run behind an `Agent` call (§6.2 Agent): the facts its own
 * `subagent_transcript` record carries. The record is appended to the parent
 * session beside the call's `tool_result`, so these land on the step rather
 * than painting a second row for the same run.
 */
export interface SubagentRun {
  readonly subagentType: string
  /** The run's own id, which names its transcript file. */
  readonly agentId?: string
  /** The model the run used — the same string the result's `headerSuffix` carries. */
  readonly model?: string
  /** How many tool calls the sub-agent made. */
  readonly toolUseCount?: number
  /** The run's persisted transcript: its final report. */
  readonly summary?: string
}

/** A running sub-agent's latest tool, from `tool-progress`'s `subagents`. */
export interface SubagentLive {
  readonly tool: string
  readonly summary: string
  readonly toolCount: number
  readonly agentId?: string
}

/** One task-tool call, as the row's phrase counts it. */
export type TaskOp =
  | { readonly kind: 'create'; readonly count: number }
  | { readonly kind: 'start' | 'complete' | 'delete' | 'update'; readonly id: string }
  | { readonly kind: 'view' }

/**
 * Everything a tool step's head and body need, gathered from both records.
 *
 * The call side (`displayName`, `useSummary`, `startedAt`) survives the result
 * merging in; the result side adds `headerSuffix`, the body, and the elapsed time.
 */
export interface ToolStepDetail {
  /** `Tool.userFacingName(input)` via the DTO, else the raw tool name. */
  readonly displayName: string
  /** `Tool.getToolUseSummary(input)` via the DTO, else the guessed argument. */
  readonly useSummary: string
  /** `ToolResultDisplay.headerSuffix` — the result's own trailing note. */
  readonly headerSuffix?: string
  /** `ToolResultDisplay.summary` — the expanded body's own header (§6.2 兜底). */
  readonly resultSummary?: string
  /** `ToolResultDisplay.detail`; the body prefers it over `content`. */
  readonly detail?: string
  /** The raw `tool_result.content`, the body's fallback. */
  readonly content?: string
  /**
   * `ToolResultRecord.errorCode`, carried only by a failed result. §6.2's
   * common body rule — the failure's code on a line of its own — is drawn by
   * each family from this.
   */
  readonly errorCode?: ToolErrorCode
  /** `tool_use.createdAt`, kept so a late result can still measure the span. */
  readonly startedAt?: string
  /** `tool_result.createdAt − tool_use.createdAt`; absent if either is unparseable. */
  readonly durationMs?: number
  /** The call has a `tool_use` record but no approval yet (§3). */
  readonly awaitingApproval?: boolean
  /** `Bash` only: the model's own words for what the command does (`input.description`). */
  readonly description?: string
  /** `Bash` only: the full command (`input.command`), untruncated, for the body and its copy button. */
  readonly command?: string
  /** The Agent family: the task the parent handed the sub-agent (`input.task`). */
  readonly task?: string
  /** The Agent family: the sub-agent run's own facts (§6.2 Agent). */
  readonly subagent?: SubagentRun
  /** The Agent family: `input.subagent_type`, drawn as a quiet tag beside the name. */
  readonly agentType?: string
  /** The Agent family, while the run is going: the tool it started last and how many so far. */
  readonly live?: SubagentLive
  /** The task tools: what each call did, in order — several once consecutive calls fold into one row. */
  readonly taskOps?: readonly TaskOp[]
  /** `TodoWrite` only: the `3/6` the head shows (§4.4). */
  readonly progress?: { readonly completed: number; readonly total: number }
  /** `AskUserQuestion`: the questions asked (`input.questions[].question`), in order. */
  readonly questions?: readonly string[]
  /** `AskUserQuestion`: what the user answered, by question text (`display.answers`). */
  readonly answers?: Readonly<Record<string, string>>
  /** `ExitPlanMode`: how the user settled the plan, from its `plan_mode_outcome` record. */
  readonly plan?: PlanOutcome
  /**
   * The caption came from the host DTO rather than from guessing at `input`.
   *
   * It decides whether the result may rewrite the collapsed line: a captioned
   * step keeps the call's head and puts the result in its body, while a DTO-less
   * one falls back to the old `Read → contents` single line.
   */
  readonly captioned?: boolean
}

export type PlanDecision = 'approve_restore_keep' | 'approve_auto_keep' | 'approve_bypass_keep' | 'reject'

export interface PlanOutcome {
  readonly decision: PlanDecision
  /** A rejection's feedback; absent when the user declined without a word. */
  readonly feedback?: string
  readonly planContent?: string
}

/** What a settled AskUserQuestion or ExitPlanMode leaves in the conversation. */
export type Receipt =
  | { readonly kind: 'question'; readonly rows: readonly { readonly question: string; readonly answer?: string }[] }
  | { readonly kind: 'plan'; readonly accepted: boolean; readonly text: string; readonly planContent?: string }

export interface TranscriptItem {
  /** Stable within a state: a record id, or a synthetic key for live items. */
  readonly id: string
  readonly kind: TranscriptItemKind
  readonly text: string
  /**
   * The image refs a user message was submitted with (S12): line facts for the
   * row under the bubble — `[图片 1：name，W×H]`, the TUI's own wording. Absent
   * on every other kind, and on records from before images existed.
   */
  readonly images?: readonly ImageAttachmentRef[]
  /** Still arriving: a streaming draft, or a tool with no result yet. */
  readonly pending?: boolean
  readonly failed?: boolean
  readonly toolName?: string
  /** The turn this item belongs to. Absent = outside every turn. */
  readonly turnId?: string
  /** The originating record's timestamp; the fallback source of a group's duration. */
  readonly createdAt?: string
  /**
   * On a `duration` item: the turn's measured elapsed time, in ms. On a thinking
   * block: how long the model reasoned, from its first delta to its last
   * `thinking_stop` — measured live only, so a replayed block has none.
   */
  readonly durationMs?: number
  /** On a thinking block still being measured: its first delta's wall clock. */
  readonly startedAt?: number
  /** On the notice minted by a `turn_interruption`: this turn was aborted. */
  readonly interrupt?: boolean
  /** On a `tool` item: both records' worth of head and body (§4.5). */
  readonly tool?: ToolStepDetail
  /**
   * The model that wrote this message — `ChatMessage.model`, assistant records
   * only. A streaming draft has none: the field arrives with the record that
   * supersedes it, which is also why the view may not treat its absence as a
   * fault.
   */
  readonly model?: string
  /**
   * On a user message sent through the host's queue: that queued message's id,
   * so {@link withQueuedMessages} stops drawing it once it is in the transcript.
   */
  readonly queuedMessageId?: string
  /** On a `thread-notes` item: the wake message's / update's notes, drawn as cards. */
  readonly threadNotes?: ThreadNotesData
  /** On a `receipt` item, which `groupTranscript` derives from a settled tool step. */
  readonly receipt?: Receipt
}

/** One step inside an activity run. `text` is the body; heads are the view's job. */
export type ActivityStep =
  | { readonly kind: 'thinking'; readonly id: string; readonly text: string; readonly pending?: boolean; readonly durationMs?: number; readonly startedAt?: number }
  | {
      readonly kind: 'tool'
      readonly id: string
      readonly text: string
      readonly toolName?: string
      readonly pending?: boolean
      readonly failed?: boolean
      readonly status: ToolStepStatus
      readonly tool: ToolStepDetail
    }
  | { readonly kind: 'subagent'; readonly id: string; readonly text: string; readonly pending?: boolean }
  // `TodoWrite`: a single line that never expands — the list itself lives in the
  // task panel above the composer.
  | {
      readonly kind: 'task'
      readonly id: string
      readonly text: string
      readonly toolName?: string
      readonly pending?: boolean
      readonly failed?: boolean
      readonly status: ToolStepStatus
      readonly tool: ToolStepDetail
    }

/**
 * A stretch of work between two pieces of prose: consecutive thinking, tools,
 * to-do writes and sub-agent runs. It is drawn as one summary line that opens
 * into a card with a row per step.
 */
export interface ActivityRun {
  /** `run:` plus the first step's id: stable, and apart from the step's own disclosure id. */
  readonly id: string
  readonly turnId?: string
  readonly steps: readonly ActivityStep[]
  /** `aborted`: the turn was interrupted right after this run. */
  readonly status: 'running' | 'done' | 'aborted'
  readonly failedCount: number
}

/**
 * The transcript as the view reads it, in order: loose items (messages, notices,
 * the turn's elapsed line) interleaved with activity runs.
 */
export type TranscriptEntry =
  | { readonly kind: 'item'; readonly item: TranscriptItem }
  | { readonly kind: 'run'; readonly run: ActivityRun }

export interface TranscriptState {
  readonly items: readonly TranscriptItem[]
  /** Bumped by a `transcript-reset` that asked for one; a view may use it as a key. */
  readonly generation: number
  /** In-flight tool summary line, from `tool-progress`. */
  readonly toolProgress: string | undefined
  readonly isThinking: boolean
  /**
   * How many thinking blocks this state has ever minted, and the source of their
   * ids. **Not** `items.length`: `turn-end` drops the draft, so the list shrinks
   * and two blocks could be minted at the same length — one toggle would then
   * fold both.
   */
  readonly thinkingCount: number
  /** Per-session presentation identities survive a streamed item's commit.
   * Canonical record ids stay in items for replay and protocol comparisons. */
  readonly presentationIds?: ReadonlyMap<string, string>
  readonly draftCount?: number
  /**
   * The turn whose records are arriving — the stamp live items inherit so they
   * join their activity group before `turn-end` (§4.1). Learned from the records
   * themselves; cleared when the turn ends.
   */
  readonly turnId?: string
  /**
   * The thinking segment `thinking_delta` extends. `message_start` closes it and
   * the assistant record replaces it, so «which segment is open» is explicit
   * rather than inferred from `pending` — the last *sealed* block would otherwise
   * be reopened by the next request's first delta (§4.2).
   */
  readonly liveThinkingId?: string
  /** A wait the loop announced that no record shows: a compaction or a retry backoff (`model/waiting.ts`). */
  readonly phase?: TurnPhase
  /** The tool call whose arguments are streaming in, before its record exists. */
  readonly draftCall?: DraftCall
}

export interface DraftCall {
  readonly name: string
  readonly index?: number
  /** The arguments' JSON so far, kept only up to `DRAFT_CALL_PEEK` characters. */
  readonly input: string
}

/** Enough of the arguments to find a leading `filePath` or `description`. */
const DRAFT_CALL_PEEK = 1024

export type TurnPhase =
  | { readonly kind: 'compacting' }
  | { readonly kind: 'retrying'; readonly attempt: number; readonly reason: RetryReason }

export type RetryReason = Extract<ModelStreamEvent, { type: 'retry' }>['reason']

/** What the caller must act on outside the transcript itself. */
export interface TranscriptOutcome {
  readonly state: TranscriptState
  /**
   * An interrupted prompt the controller rolled back. The composer has to take
   * this back or the user's message is destroyed — the record is already gone
   * from disk by the time this arrives.
   */
  readonly restoreInput?: string
  /**
   * The images the same rollback returned: the drafts to rebuild beside the
   * restored text (S11). Same `applySessionEvent` edge, same once-only rule.
   */
  readonly restoreImages?: readonly ImageAttachmentRef[]
  /** A model switch the loop performed by itself (fallback activation). */
  readonly activeModel?: string
}

const DRAFT_ID = '__draft__'

export function createTranscriptState(
  records: readonly SessionRecord[] = [],
  toolDisplays?: ToolDisplayLookup,
): TranscriptState {
  // Approvals are matched over the *records*, in order, not over the items: the
  // approval record names no `tool_use`, so the only honest link is «the earliest
  // unanswered call of that tool». Matching over collapsed items would let a
  // finished call's approval clear a later, still-waiting one of the same name.
  const context: ItemContext = { toolDisplays, approved: approvedToolUseIds(records) }
  return {
    items: mergeAdjacentThinking(collapseById(records.flatMap((record) => recordItems(record, context)))),
    generation: 0,
    toolProgress: undefined,
    isThinking: false,
    thinkingCount: 0,
  }
}

/** The DOM and disclosure state share these ids; records keep their own ids.
 * Aliases belong to this session and disappear with transcript-reset. */
export function presentationTranscript(state: TranscriptState): TranscriptState {
  if (!state.presentationIds?.size) return state
  return {
    ...state,
    items: state.items.map((item) => {
      const id = state.presentationIds?.get(item.id)
      return id === undefined ? item : { ...item, id }
    }),
  }
}

/**
 * The transcript with the host's queued messages drawn as user bubbles at its
 * tail: a message sent mid-turn shows the moment it is sent, and joins the turn
 * at its next step. One the transcript already carries is not drawn twice.
 */
export function withQueuedMessages(
  state: TranscriptState,
  queued: readonly PersistedQueuedMessage[],
): TranscriptState {
  if (queued.length === 0) return state
  const shown = new Set(state.items.flatMap((item) => item.queuedMessageId ? [item.queuedMessageId] : []))
  const waiting = queued.filter((message) => !shown.has(message.id))
  if (waiting.length === 0) return state
  return {
    ...state,
    items: [...state.items, ...waiting.map((message): TranscriptItem => ({
      id: `queued:${message.id}`,
      kind: 'user',
      text: message.content,
      ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
      queuedMessageId: message.id,
    }))],
  }
}

export function applySessionEvent(
  state: TranscriptState,
  event: SessionEvent,
  toolDisplays?: ToolDisplayLookup,
  /** The wall clock at delivery. Absent = thinking goes unmeasured (tests, replays). */
  now?: number,
): TranscriptOutcome {
  switch (event.type) {
    case 'turn-start':
      // A wake turn's input is reminders for the model, hidden on replay too.
      if (isSystemReminderBlock(event.displayInput)) return { state: { ...state, isThinking: false } }
      // The user message arrives as a record too, but only after the turn has
      // done its first I/O; showing it now is what makes Enter feel immediate.
      return {
        state: {
          ...state,
          items: [...state.items, parseThreadNoteMessage(event.displayInput) ? {
            id: event.messageId,
            kind: 'thread-notes',
            text: event.displayInput,
            threadNotes: parseThreadNoteMessage(event.displayInput)!,
          } : {
            id: event.messageId,
            kind: 'user',
            text: event.displayInput,
            ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
            ...(event.queuedMessageId ? { queuedMessageId: event.queuedMessageId } : {}),
          }],
          isThinking: false,
        },
      }

    case 'record': {
      // The assistant message carries the call the arguments were streaming for.
      const committed = event.record.type === 'message' && event.record.role !== 'user' && state.draftCall !== undefined
      return { state: applyRecord(committed ? { ...state, draftCall: undefined } : state, event.record, toolDisplays) }
    }

    case 'stream':
      return { state: applyStream(state, event.event, now) }

    case 'tool-progress':
      return { state: {
        ...state,
        toolProgress: event.listContent,
        items: withSubagentActivity(state.items, event.subagents ?? []),
      } }

    case 'notice':
      return {
        state: {
          ...state,
          items: [...state.items, {
            id: `notice-${state.items.length}`,
            kind: event.level === 'error' ? 'error' : 'notice',
            text: event.content,
          }],
        },
      }

    case 'transcript-reset': {
      const base = createTranscriptState(event.records, toolDisplays)
      return {
        state: {
          ...base,
          items: [
            ...base.items,
            ...event.systemMessages.map((text, index) => ({
              id: `reset-notice-${index}`,
              kind: 'notice' as const,
              text,
            })),
          ],
          generation: event.bumpGeneration ? state.generation + 1 : state.generation,
        },
      }
    }

    case 'session-meta':
      // The window's chrome names the session, not the transcript: the header
      // and the sidebar read it off `WireLaneInfo`, which the host rebroadcasts
      // for this event. Nothing to add to the conversation.
      return { state }

    case 'restore-input':
      return {
        state,
        restoreInput: event.text,
        ...(event.images && event.images.length > 0 ? { restoreImages: event.images } : {}),
      }

    case 'active-model':
      return { state, activeModel: event.model.model }

    case 'turn-end': {
      // Drop a draft that never became a record (an aborted or failed turn), or
      // it would sit there looking like it was still arriving. Thinking is *not*
      // dropped: it is this turn's reasoning, and it stays as steps.
      //
      // The measured elapsed time rides on a `duration` item stamped with the
      // turn, which `groupTranscript` folds into the group head rather than
      // drawing as a row (§5.3). It is minted unconditionally now — before T3 a
      // turn that thought suppressed it and handed the total to the last thinking
      // block instead, which under §4.2's segmentation would pin a whole turn's
      // time to whichever request happened to reason last.
      const items = closeThinkingSegments(state.items.filter((item) => item.id !== DRAFT_ID))
      const summary = formatTurnSummary(event)
      return {
        state: {
          ...state,
          items: summary
            ? [...items, {
                id: `duration-${items.length}`,
                kind: 'duration',
                text: summary,
                durationMs: event.durationMs,
                ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
              }]
            : items,
          toolProgress: undefined,
          isThinking: false,
          turnId: undefined,
          liveThinkingId: undefined,
          phase: undefined,
          draftCall: undefined,
        },
      }
    }
  }

  // Not a `default` branch, and it must not become one: this is what makes a new
  // `SessionEvent` variant a compile error instead of a silently dropped event.
  return assertNever(event)
}

/**
 * `aborted` is the signal's state, not "did it throw" — a *failed* turn is not
 * aborted and still gets its duration line, matching the TUI.
 */
export function formatTurnSummary(event: Extract<SessionEvent, { type: 'turn-end' }>): string | undefined {
  if (event.aborted) return undefined
  return `已处理 ${formatWorkedDuration(event.durationMs)}`
}

/**
 * `7m 38s`, the shape `design_guidance.md` asks the collapsed thinking header for,
 * and the same one the TUI's own elapsed line uses.
 *
 * Sub-second turns keep a tenth, because `已处理 0s` reads as a broken clock. Above
 * a second the fraction is noise, so it floors.
 */
export function formatWorkedDuration(ms: number): string {
  const total = Math.max(0, ms) / 1000
  if (total < 1) return `${Math.round(total * 10) / 10}s`
  const seconds = Math.floor(total)
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

/**
 * The wall-clock time a message settled at, as `14:32` — the right-hand end of a
 * message's meta row.
 *
 * Local time, and formatted by hand rather than through `toLocaleTimeString`: the
 * shell is a fixed 24-hour layout, and a locale that decides to render `下午2:32`
 * changes the row's width once per message. `undefined` for anything unparseable
 * (an old record with no stamp, a live draft), which is the view's cue to draw no
 * time at all rather than a placeholder.
 */
export function formatMessageTime(createdAt: string | undefined): string | undefined {
  if (createdAt === undefined) return undefined
  const at = new Date(createdAt)
  if (Number.isNaN(at.getTime())) return undefined
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Closes every open thinking segment: clears `pending`, which is what the view
 * reads as "stop breathing, collapse me".
 *
 * Written as a sweep rather than a lookup of the open one, so a segment that
 * somehow missed its `message_start` is closed by the next `turn-end` instead of
 * breathing forever.
 */
function closeThinkingSegments(items: readonly TranscriptItem[]): TranscriptItem[] {
  return items.map((item) => (item.kind === 'thinking' && (item.pending === true || item.startedAt !== undefined) ? closeSegment(item) : item))
}

function closeSegment(item: TranscriptItem): TranscriptItem {
  const { pending: _pending, startedAt: _startedAt, ...closed } = item
  return closed
}

function applyStream(state: TranscriptState, event: Extract<SessionEvent, { type: 'stream' }>['event'], now?: number): TranscriptState {
  switch (event.type) {
    case 'text_delta': {
      const fresh = indexOfItem(state.items, DRAFT_ID) === -1
      let presentationIds = state.presentationIds
      if (fresh) {
        const next = new Map(presentationIds)
        next.set(DRAFT_ID, `__streamed-text-${state.draftCount ?? 0}`)
        presentationIds = next
      }
      return {
        ...state,
        isThinking: false,
        items: appendToLive(state.items, DRAFT_ID, 'assistant', event.text, state.turnId),
        presentationIds,
        draftCount: (state.draftCount ?? 0) + (fresh ? 1 : 0),
      }
    }
    case 'tool_input_delta': {
      // The text has stopped; the model is now writing a tool call's arguments,
      // which can take as long as the file it is writing. The draft is no longer
      // arriving, so the status row comes back (`model/waiting.ts`).
      const settled = settleDraft(state)
      if (event.name === undefined) return settled
      const prior = state.draftCall?.name === event.name && state.draftCall.index === event.index ? state.draftCall : undefined
      if (prior && prior.input.length >= DRAFT_CALL_PEEK) return settled
      const input = ((prior?.input ?? '') + event.partialJson).slice(0, DRAFT_CALL_PEEK)
      return { ...settled, draftCall: { name: event.name, ...(event.index === undefined ? {} : { index: event.index }), input } }
    }
    case 'retry':
      // A stream that failed partway leaves its draft pending; settled, so the
      // row can say the request is being sent again.
      return { ...settleDraft(state), draftCall: undefined, phase: { kind: 'retrying', attempt: event.attempt, reason: event.reason } }
    case 'compact': {
      if (event.phase === 'start') return { ...state, phase: { kind: 'compacting' } }
      const { phase: _phase, ...rest } = state
      return rest
    }
    case 'thinking_delta':
      return appendThinking(state, event.thinking, now)
    case 'thinking_stop':
      return { ...state, isThinking: false, items: pauseThinking(state, stampThinkingDuration(state, now)) }
    case 'message_start': {
      // One model request is one thinking segment (§4.2): a second request within
      // the turn — a tool round trip — closes the open segment and the next delta
      // opens a fresh one, which is exactly what replaying `thinkingBlocks` per
      // record produces. The previous draft has already been replaced by its
      // record; the filter only catches a request that produced no message at all.
      // The response has begun, so a retry that was waiting for it is over.
      const { phase, ...rest } = state
      return {
        ...rest,
        ...(phase?.kind === 'compacting' ? { phase } : {}),
        items: closeThinkingSegments(state.items.filter((item) => item.id !== DRAFT_ID)),
        liveThinkingId: undefined,
        draftCall: undefined,
      }
    }
    default:
      return state
  }
}

function settleDraft(state: TranscriptState): TranscriptState {
  const index = indexOfItem(state.items, DRAFT_ID)
  if (index === -1 || state.items[index]!.pending !== true) return state
  const items = [...state.items]
  const { pending: _pending, ...settled } = items[index]!
  items[index] = settled
  return { ...state, items }
}

/**
 * The item's slot, checking the tail first.
 *
 * Both callers are looking for the block a *delta* extends, which is the last
 * item in all but the rare case where a record landed after it — and a delta
 * arrives per streamed token, so a full scan here is a walk of the whole
 * conversation per token.
 */
function indexOfItem(items: readonly TranscriptItem[], id: string): number {
  const last = items.length - 1
  if (last >= 0 && items[last]!.id === id) return last
  return items.findIndex((item) => item.id === id)
}

/**
 * Appends to the live item of that id, creating it if absent.
 */
function appendToLive(
  items: readonly TranscriptItem[],
  id: string,
  kind: TranscriptItemKind,
  text: string,
  turnId: string | undefined,
): TranscriptItem[] {
  const index = indexOfItem(items, id)
  if (index === -1) {
    return [...items, { id, kind, text, pending: true, ...(turnId === undefined ? {} : { turnId }) }]
  }
  const next = [...items]
  const existing = next[index]!
  next[index] = { ...existing, text: existing.text + text }
  return next
}

/**
 * A delta extends the segment `liveThinkingId` names, and mints a new one when
 * there is none open — which is the state `message_start`, the committing record
 * and `turn-end` all leave behind. Keying on an explicit id rather than on "the
 * last pending block" is what makes a *closed* segment stay closed: a delta after
 * a tool round trip has to start a second segment, not reopen the first (§4.2).
 *
 * A `transcript-reset` rebuilds the state, so the id cannot outlive the items it
 * points at.
 */
function appendThinking(state: TranscriptState, text: string, now?: number): TranscriptState {
  const index = state.liveThinkingId === undefined
    ? -1
    : indexOfItem(state.items, state.liveThinkingId)
  if (index === -1) {
    const id = `thinking-${state.thinkingCount}`
    return {
      ...state,
      isThinking: true,
      thinkingCount: state.thinkingCount + 1,
      liveThinkingId: id,
      items: [...state.items, {
        id,
        kind: 'thinking',
        text,
        pending: true,
        ...(now === undefined ? {} : { startedAt: now }),
        ...(state.turnId === undefined ? {} : { turnId: state.turnId }),
      }],
    }
  }
  const items = [...state.items]
  const existing = items[index]!
  items[index] = { ...existing, text: existing.text + text, pending: true }
  return { ...state, isThinking: true, items }
}

/**
 * A stop pauses the open segment: it is no longer arriving, but it stays the one
 * the next delta of the same request extends — and resumes.
 */
function pauseThinking(state: TranscriptState, items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  const index = state.liveThinkingId === undefined ? -1 : indexOfItem(items, state.liveThinkingId)
  if (index === -1 || items[index]!.pending !== true) return items
  const { pending: _pending, ...paused } = items[index]!
  const next = [...items]
  next[index] = paused
  return next
}

/**
 * The open segment's elapsed time so far, rewritten at every `thinking_stop`: a
 * request may reason in more than one block, and the segment spans them all.
 */
function stampThinkingDuration(state: TranscriptState, now: number | undefined): readonly TranscriptItem[] {
  if (now === undefined || state.liveThinkingId === undefined) return state.items
  const index = indexOfItem(state.items, state.liveThinkingId)
  const open = index === -1 ? undefined : state.items[index]!
  if (open?.startedAt === undefined) return state.items
  const items = [...state.items]
  items[index] = { ...open, durationMs: Math.max(0, now - open.startedAt) }
  return items
}

function applyRecord(
  state: TranscriptState,
  record: SessionRecord,
  toolDisplays: ToolDisplayLookup | undefined,
): TranscriptState {
  // Live items inherit the turn from the records already seen, so a streaming
  // segment is inside its group before `turn-end` names the turn (§4.1).
  const turnId = recordStamp(record).turnId ?? state.turnId

  // The approval is bookkeeping — it draws nothing — but it is what moves a call
  // out of 「等待授权」. Live it needs no queue: the call it belongs to is simply
  // the earliest one of that tool still waiting, because a second call of the
  // same tool cannot be recorded while this one holds the gate.
  if (record.type === 'tool_approval') {
    return { ...state, turnId, items: clearAwaitingApproval(state.items, record) }
  }

  const produced = recordItems(record, { toolDisplays })
  if (produced.length === 0) return { ...state, turnId }

  // An assistant message *replaces* what streamed rather than following it.
  // Appending both is the duplicate-bubble bug the terminal avoids by never
  // committing a live message twice.
  const commits = record.type === 'message' && record.role !== 'user'
  const next = commits ? state.items.filter((item) => item.id !== DRAFT_ID) : [...state.items]
  const pending = [...produced]
  let liveThinkingId = state.liveThinkingId
  const presentationIds = commits ? new Map(state.presentationIds) : undefined

  if (commits) {
    const draftId = presentationIds?.get(DRAFT_ID)
    if (draftId !== undefined) presentationIds!.set(record.id, draftId)
    presentationIds?.delete(DRAFT_ID)
    // The open segment and this record's `thinkingBlocks` are the same reasoning.
    // Overwriting in place keeps the position *and* the id it replays under, which
    // is what makes the live tree and the replayed tree comparable field by field
    // — and what keeps a toggle the user set mid-stream pointing at the same step.
    const open = liveThinkingId === undefined ? -1 : next.findIndex((item) => item.id === liveThinkingId)
    if (open !== -1) {
      const replayed = pending.findIndex((item) => item.kind === 'thinking')
      // No persisted blocks (thinking off, or an older provider): keep what
      // streamed and merely close it, rather than deleting reasoning that is real.
      if (replayed === -1) next[open] = closeSegment(next[open]!)
      else {
        const committed = pending.splice(replayed, 1)[0]!
        presentationIds!.set(committed.id, state.presentationIds?.get(next[open]!.id) ?? next[open]!.id)
        // The record knows the reasoning, not how long it took; only the live
        // segment was there to time it.
        const { durationMs } = next[open]!
        next[open] = durationMs === undefined ? committed : { ...committed, durationMs }
      }
    }
    liveThinkingId = undefined
  }

  // A tool_result *merges into* the call row it answers — it does not replace it
  // (§4.5). The caption and the start time only exist on the call side. The
  // sub-agent run's transcript takes the same in-place merge, keyed by the
  // record's own pointer at its parent call (§6.2 Agent).
  const mergeKey = record.type === 'tool_result'
    ? record.toolUseId
    : record.type === 'subagent_transcript'
      ? record.parentToolUseId
      : record.type === 'plan_mode_outcome'
        ? record.toolUseId
        : undefined
  if (mergeKey !== undefined) {
    const answered = next.findIndex((item) => item.id === mergeKey)
    if (answered !== -1) {
      next[answered] = mergeToolItems(next[answered]!, pending[0]!)
      return { ...state, turnId, liveThinkingId, items: next }
    }
  }

  // Idempotent by id. The user's message is already on screen: `turn-start`
  // placed it there under `event.messageId`, and that id *is* the record id
  // (`SessionController.submit` mints it and `AgentLoop.runInternal` uses it
  // verbatim), so appending the record would draw the same bubble twice — the
  // duplicate the desktop smoke test found. Replacing rather than dropping,
  // because the record carries `displayContent`, which is the authoritative
  // text (a skill command's `displayInput` arrives only this way).
  for (const item of pending) {
    const index = next.findIndex((existing) => existing.id === item.id)
    if (index === -1) next.push(item)
    else next[index] = item
  }
  // §4.3 again, on the live path: two requests in a row that called nothing are
  // one segment, and replay merges them, so this path has to as well.
  const items = mergeAdjacentThinking(next)
  if (presentationIds) {
    const ids = new Set(items.map((item) => item.id))
    for (const id of presentationIds.keys()) if (!ids.has(id)) presentationIds.delete(id)
  }
  return { ...state, turnId, liveThinkingId, items,
    ...(presentationIds ? { presentationIds } : {}) }
}

/** Mirror of `wrapInSystemReminder`'s output (`src/harness/systemReminder.ts`).
 * The renderer may not import `harness/`, so the format check is duplicated here. */
function isSystemReminderBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<system-reminder>') && trimmed.endsWith('</system-reminder>')
}

/** Mirror of `formatSubagentSummary`'s output (`src/harness/toolRunner.ts`). */
function isSubagentSummaryBlock(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.startsWith('<subagent-summary ')
    && (trimmed.endsWith('/>') || trimmed.endsWith('</subagent-summary>'))
}

interface ItemContext {
  readonly toolDisplays?: ToolDisplayLookup
  /** Replay only: `tool_use` ids an approval record has already answered. */
  readonly approved?: ReadonlySet<string>
}

/** One record to zero or more items. Records with no visual meaning yield none. */
function recordItems(record: SessionRecord, context: ItemContext = {}): TranscriptItem[] {
  const stamp = recordStamp(record)
  switch (record.type) {
    case 'message': {
      // A `<system-reminder>` user record is a model-facing nudge, not user input;
      // it must not surface as a bubble, so it yields no item.
      if (record.role === 'user' && isSystemReminderBlock(messageText(record))) return []
      // Likewise the `<subagent-summary>` the tool runner appends after an Agent
      // result: context for the model, whose facts the Agent step already shows.
      if (record.role === 'assistant' && isSubagentSummaryBlock(messageText(record))) return []
      // The automatic wake is a user record the app wrote: its notes are cards.
      if (record.role === 'user') {
        const threadNotes = parseThreadNoteMessage(messageText(record))
        if (threadNotes?.opening) return []
        if (threadNotes) return [{ id: record.id, kind: 'thread-notes', text: messageText(record), threadNotes, ...stamp }]
      }
      const text: TranscriptItem = {
        id: record.id,
        kind: record.role === 'user' ? 'user' : 'assistant',
        text: messageText(record),
        // The images a user message was submitted with (S12): line facts for
        // the row under the bubble. `displayContent ?? content`-shaped text is
        // kept for copy/search; the refs ride beside it.
        ...(record.role === 'user' && record.images && record.images.length > 0
          ? { images: record.images }
          : {}),
        // Who wrote it. Only the assistant side: the user's own message has no
        // model, and an old record that predates the field simply has none.
        ...(record.role !== 'user' && typeof record.model === 'string' && record.model.length > 0
          ? { model: record.model }
          : {}),
        ...(record.role === 'user' && record.sourceQueuedMessageId ? { queuedMessageId: record.sourceQueuedMessageId } : {}),
        ...stamp,
      }
      // One model request = one thinking segment ahead of its text (§4.2). Old
      // sessions have no `thinkingBlocks`, and that degrades silently (§10).
      const thinking = replayedThinking(record)
      return thinking ? [{ ...thinking, ...stamp }, text] : [text]
    }

    case 'tool_use': {
      const dto = context.toolDisplays?.(record.id)
      const search = searchCaption(record.tool, record.input)
      const tool: ToolStepDetail = {
        // The Agent family names the run in words; its type rides as a tag.
        displayName: record.tool === AGENT_TOOL ? AGENT_LABEL : search?.displayName ?? dto?.displayName ?? record.tool,
        useSummary: search?.useSummary ?? dto?.useSummary ?? toolCallDetail(record.input),
        ...(record.createdAt === undefined ? {} : { startedAt: record.createdAt }),
        // Recorded, not yet approved. The approval record clears it; a call the
        // gate waved through clears it just as fast, so the state is only ever
        // visible for as long as the user is actually being asked.
        ...(context.approved?.has(record.id) === true ? {} : { awaitingApproval: true }),
        ...(dto ? { captioned: true } : {}),
        ...(record.tool === AGENT_TOOL ? agentTask(record.input) : {}),
        ...(record.tool === 'Bash' ? bashInput(record.input) : {}),
        ...(record.tool === ASK_TOOL ? askedQuestions(record.input) : {}),
        ...(TASK_TOOLS.has(record.tool) ? { taskOps: [taskOp(record.tool, record.input)] } : {}),
      }
      return [{
        id: record.id,
        kind: 'tool',
        // The DTO-less fallback keeps the shape older clients drew, `Read(a.txt)`.
        text: dto ? toolHeaderText(tool) : toolCallSummary(record.tool, record.input),
        toolName: record.tool,
        pending: true,
        tool,
        ...stamp,
      }]
    }

    case 'tool_result': {
      // Keyed by the call it answers, so it merges into that row in place.
      const tool = resultDetail(
        record.tool,
        record.display,
        record.content,
        // A code the result *succeeded* with is not a failure's code; the field
        // means 「why this call went wrong」, and the body only draws it then.
        record.ok ? undefined : record.errorCode,
      )
      return [{
        id: record.toolUseId,
        kind: 'tool',
        text: toolResultSummary(record.tool, record.ok, record.content),
        toolName: record.tool,
        ...(record.ok ? {} : { failed: true }),
        tool,
        ...stamp,
      }]
    }

    case 'subagent_task':
      return [{
        id: record.id,
        kind: 'subagent',
        text: [`后台子代理 · ${record.subagentType}`, SUBAGENT_STATUS_LABELS[record.status], record.description]
          .filter((part) => part !== undefined && part.length > 0)
          .join(' · '),
        ...stamp,
      }]

    case 'subagent_transcript': {
      // The run's own transcript belongs to the call that started it (§6.2
      // Agent): keyed by `parentToolUseId` it merges into that step exactly as
      // a `tool_result` merges by `toolUseId`, so the head gains the run's
      // model and tool count, the body its report, and the duplicate row the
      // record used to paint never exists. A record with no parent to merge
      // into (a truncated log) keeps a row of its own.
      const run: SubagentRun = {
        subagentType: record.subagentType,
        agentId: record.agentId,
        ...(record.model === undefined ? {} : { model: record.model }),
        ...(record.toolUseCount === undefined ? {} : { toolUseCount: record.toolUseCount }),
        ...(record.summary === undefined ? {} : { summary: record.summary }),
      }
      if (record.parentToolUseId !== undefined) {
        return [{
          id: record.parentToolUseId,
          kind: 'tool',
          text: record.subagentType,
          toolName: AGENT_TOOL,
          tool: { displayName: record.subagentType, useSummary: '', subagent: run },
          ...stamp,
        }]
      }
      return [{
        id: record.id,
        kind: 'subagent',
        text: `${AGENT_LABEL} · ${record.subagentType} 已完成${record.summary ? `：${record.summary}` : ''}`,
        ...stamp,
      }]
    }

    case 'plan_mode_outcome': {
      // Only an exit the host could name a call for: the outcome belongs to that
      // call's step and merges into it, as a sub-agent's transcript does.
      if (record.toolUseId === undefined || (record.kind !== 'exit_approved' && record.kind !== 'exit_rejected')) return []
      const decision = record.kind === 'exit_rejected' ? 'reject' : record.detail as PlanDecision
      const feedback = record.kind === 'exit_rejected' ? record.detail?.trim() : undefined
      return [{
        id: record.toolUseId,
        kind: 'tool',
        text: '',
        toolName: EXIT_PLAN_TOOL,
        tool: {
          displayName: EXIT_PLAN_TOOL,
          useSummary: '',
          plan: {
            decision,
            ...(feedback ? { feedback } : {}),
            ...(record.planContent === undefined ? {} : { planContent: record.planContent }),
          },
        },
        ...stamp,
      }]
    }

    case 'coordination_update': {
      const threadNotes = parseCoordinationUpdate(record.content)
      return threadNotes ? [{ id: record.id, kind: 'thread-notes', text: record.content, threadNotes, ...stamp }] : []
    }

    case 'turn_interruption':
      return [{ id: record.id, kind: 'notice', text: 'Interrupted.', interrupt: true, ...stamp }]

    case 'compact_boundary':
      return [{ id: record.id, kind: 'notice', text: 'Context compacted.', ...stamp }]

    case 'compact_attempt_failed':
      return [{ id: record.id, kind: 'error', text: `Compaction failed: ${record.error}`, ...stamp }]

    default:
      // tool_approval, at_mention_context, tool_use_summary, tool_result_trim,
      // background_task, plan_mode_* and message_queue are bookkeeping, not
      // transcript.
      return []
  }
}

/** The head as one line: `Read src/a.ts`. Either half may be empty. */
function toolHeaderText(tool: ToolStepDetail): string {
  return [tool.displayName, tool.useSummary].filter((part) => part.length > 0).join(' ')
}

/**
 * The result half of a step. Deliberately carries no `displayName` /
 * `useSummary`: those belong to the call and `mergeToolItems` must not lose them
 * to a spread. A result with no call to merge into (a truncated log) still needs
 * *some* name, so it falls back to the raw tool name there.
 */
function resultDetail(
  toolName: string,
  display: ToolResultDisplay | undefined,
  content: string,
  errorCode: ToolErrorCode | undefined,
): ToolStepDetail {
  return {
    displayName: toolName,
    useSummary: '',
    content,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(display?.headerSuffix === undefined ? {} : { headerSuffix: display.headerSuffix }),
    ...(display?.summary === undefined ? {} : { resultSummary: display.summary }),
    ...(display?.detail === undefined ? {} : { detail: display.detail }),
    ...(display?.taskSnapshot === undefined ? {} : {
      progress: {
        completed: display.taskSnapshot.counts.completed,
        total: display.taskSnapshot.counts.total,
      },
    }),
    ...(display?.answers === undefined ? {} : { answers: display.answers }),
  }
}

/**
 * Call + result as one item (§4.5).
 *
 * The result's fields win *except* the caption and the start time, which only
 * the call has, and `awaitingApproval`, which a result settles by existing. The
 * head line survives only for a captioned step; without a DTO the old
 * `Read → contents` line is still the best single row available.
 */
function mergeToolItems(call: TranscriptItem, result: TranscriptItem): TranscriptItem {
  const callTool = call.tool
  const resultTool = result.tool
  if (callTool === undefined || resultTool === undefined) return result
  // The sub-agent run's record is the third partner a step can take (§6.2
  // Agent): it settles nothing about the *call*, so it must not displace the
  // caption, the span or the outcome the way a result does — it only hands
  // over the run's own facts.
  if (resultTool.subagent !== undefined) {
    return { ...call, tool: { ...callTool, subagent: resultTool.subagent } }
  }
  if (resultTool.plan !== undefined) {
    return { ...call, tool: { ...callTool, plan: resultTool.plan } }
  }
  const { awaitingApproval: _awaiting, ...settled } = callTool
  const tool: ToolStepDetail = {
    ...settled,
    ...resultTool,
    displayName: callTool.displayName,
    useSummary: callTool.useSummary,
    ...spanBetween(callTool.startedAt, result.createdAt),
  }
  return {
    ...result,
    tool,
    ...(callTool.captioned === true ? { text: call.text } : {}),
  }
}

/** The tool's own elapsed time. Unparseable stamps (an old log, a test) yield none. */
function spanBetween(startedAt: string | undefined, finishedAt: string | undefined): { durationMs?: number } {
  const start = startedAt === undefined ? NaN : Date.parse(startedAt)
  const end = finishedAt === undefined ? NaN : Date.parse(finishedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return {}
  return { durationMs: Math.max(0, end - start) }
}

/**
 * Which `tool_use` records an approval has already answered (replay).
 *
 * `ToolApprovalRecord` names no call, so calls of the same tool are matched in
 * order — which is exact, because `ToolRunner` records the approval before the
 * next call of that tool can reach the gate. A host that does name the call
 * (`toolUseId`) is believed instead.
 */
function approvedToolUseIds(records: readonly SessionRecord[]): Set<string> {
  const approved = new Set<string>()
  const waiting = new Map<string, string[]>()
  for (const record of records) {
    if (record.type === 'tool_use') {
      const queue = waiting.get(record.tool)
      if (queue) queue.push(record.id)
      else waiting.set(record.tool, [record.id])
      continue
    }
    if (record.type !== 'tool_approval') continue
    const named = (record as { toolUseId?: unknown }).toolUseId
    if (typeof named === 'string') {
      approved.add(named)
      const queue = waiting.get(record.tool)
      if (queue) waiting.set(record.tool, queue.filter((id) => id !== named))
      continue
    }
    const next = waiting.get(record.tool)?.shift()
    if (next !== undefined) approved.add(next)
  }
  return approved
}

/** The live counterpart of `approvedToolUseIds`, one record at a time. */
function clearAwaitingApproval(
  items: readonly TranscriptItem[],
  record: Extract<SessionRecord, { type: 'tool_approval' }>,
): readonly TranscriptItem[] {
  const named = (record as { toolUseId?: unknown }).toolUseId
  const index = items.findIndex((item) => (
    item.kind === 'tool'
    && item.tool?.awaitingApproval === true
    && (typeof named === 'string' ? item.id === named : item.toolName === record.tool)
  ))
  if (index === -1) return items
  const next = [...items]
  const { awaitingApproval: _awaiting, ...tool } = next[index]!.tool!
  next[index] = { ...next[index]!, tool }
  return next
}

/** Not every record variant declares `turnId`, and a few carry no clock either. */
function recordStamp(record: SessionRecord): { turnId?: string; createdAt?: string } {
  const fields = record as { turnId?: unknown; createdAt?: unknown }
  return {
    ...(typeof fields.turnId === 'string' ? { turnId: fields.turnId } : {}),
    ...(typeof fields.createdAt === 'string' ? { createdAt: fields.createdAt } : {}),
  }
}

/**
 * The persisted reasoning of one model request, as one thinking item.
 *
 * All of a request's blocks become a single segment: they are adjacent with no
 * tool between them, and §4.3 says that is one segment, not several.
 * `redacted_thinking` carries no readable text and drops out.
 */
function replayedThinking(record: Extract<SessionRecord, { type: 'message' }>): TranscriptItem | undefined {
  const text = (record.thinkingBlocks ?? [])
    .map((block) => (typeof block.thinking === 'string' ? block.thinking : ''))
    .filter((value) => value.trim().length > 0)
    .join('\n\n')
  if (text.length === 0) return undefined
  return { id: `${record.id}-thinking`, kind: 'thinking', text }
}

/**
 * A `tool_result` keys itself by the call it answers, so replaying both records
 * yields two items under one id. The live fold merges the two in place
 * (`applyRecord`); replay has to do the same, or the same call draws twice — and
 * with the same *merge*, or replay would drop the caption the call carries.
 */
function collapseById(items: readonly TranscriptItem[]): TranscriptItem[] {
  const collapsed: TranscriptItem[] = []
  const seen = new Map<string, number>()
  for (const item of items) {
    const index = seen.get(item.id)
    if (index === undefined) {
      seen.set(item.id, collapsed.length)
      collapsed.push(item)
    } else {
      const previous = collapsed[index]!
      collapsed[index] = previous.kind === 'tool' && item.kind === 'tool'
        ? mergeToolItems(previous, item)
        : item
    }
  }
  return collapsed
}

/**
 * §4.3: adjacent thinking with no tool between it is one segment. Within a
 * request that is already true; this closes the case of two requests in a row
 * that called nothing (a retry, a continuation).
 *
 * An empty assistant text is the shape of a tool-only request and is not a
 * separator — nothing is drawn for it (§4.6), so thinking on either side of one
 * is still adjacent.
 *
 * A segment still streaming is left out of it: `liveThinkingId` names that one
 * item, and absorbing it into a neighbour would strand the id mid-stream. Replay
 * has nothing pending, so the rule costs it nothing.
 */
function mergeAdjacentThinking(items: readonly TranscriptItem[]): TranscriptItem[] {
  const merged: TranscriptItem[] = []
  for (const item of items) {
    const previous = item.kind === 'thinking' && item.pending !== true ? lastVisible(merged) : -1
    const target = previous === -1 ? undefined : merged[previous]!
    if (target && target.kind === 'thinking' && target.pending !== true && target.turnId === item.turnId) {
      // A sum only when both were timed: half a measurement would understate it.
      const { durationMs: _durationMs, ...rest } = target
      merged[previous] = target.durationMs !== undefined && item.durationMs !== undefined
        ? { ...rest, text: `${target.text}\n\n${item.text}`, durationMs: target.durationMs + item.durationMs }
        : { ...rest, text: `${target.text}\n\n${item.text}` }
    } else {
      merged.push(item)
    }
  }
  return merged
}

function lastVisible(items: readonly TranscriptItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]!
    if (item.kind === 'assistant' && item.text.trim().length === 0) continue
    return index
  }
  return -1
}

/** Text blocks only; an image block has no textual form to show here. */
export function messageText(record: Extract<SessionRecord, { type: 'message' }>): string {
  const content: unknown = record.displayContent ?? record.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: unknown) => {
        if (typeof block !== 'object' || block === null) return ''
        const typed = block as { type?: string; text?: string }
        return typed.type === 'text' && typeof typed.text === 'string' ? typed.text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return content === undefined ? '' : JSON.stringify(content)
}

/** `Tool(the most identifying argument)`, the way a transcript line reads best. */
export function toolCallSummary(tool: string, input: unknown): string {
  const detail = toolCallDetail(input)
  return detail ? `${tool}(${detail})` : tool
}

/**
 * Grep and Glob share the TUI's `Search` name and its `pattern: "…"` caption.
 * The desktop head names the tool itself and shows the bare values — the pattern,
 * then the glob and path it was narrowed to — leaving the shared display alone.
 */
function searchCaption(tool: string, input: unknown): { displayName: string; useSummary: string } | undefined {
  if (tool !== 'Grep' && tool !== 'Glob') return undefined
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  if (typeof record.pattern !== 'string') return undefined
  const parts = [truncate(record.pattern, 100)]
  for (const key of ['glob', 'path']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim().length > 0 && value.trim() !== '.') parts.push(truncate(value.trim(), 60))
  }
  return { displayName: tool, useSummary: parts.join(' · ') }
}

const TASK_TOOLS: ReadonlySet<string> = new Set(['TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet'])

const STATUS_OPS: Readonly<Record<string, 'start' | 'complete' | 'delete'>> = {
  in_progress: 'start',
  completed: 'complete',
  deleted: 'delete',
}

function taskOp(tool: string, input: unknown): TaskOp {
  const value = typeof input === 'object' && input !== null ? input as { tasks?: unknown; taskId?: unknown; status?: unknown } : {}
  // A session recorded before the batch shape holds one task at the top level.
  if (tool === 'TaskCreate') return { kind: 'create', count: Array.isArray(value.tasks) ? value.tasks.length : 1 }
  if (tool !== 'TaskUpdate') return { kind: 'view' }
  const id = typeof value.taskId === 'string' ? value.taskId : ''
  return { kind: (typeof value.status === 'string' ? STATUS_OPS[value.status] : undefined) ?? 'update', id }
}

function isTaskCall(item: TranscriptItem): boolean {
  return item.kind === 'tool' && item.tool?.taskOps !== undefined
}

/** Two consecutive task calls as one row: the later call's result, both calls' ops. */
function foldTaskCalls(first: TranscriptItem, next: TranscriptItem): TranscriptItem {
  const { pending: _pending, failed: _failed, ...rest } = first
  return {
    ...rest,
    ...(first.pending === true || next.pending === true ? { pending: true } : {}),
    ...(first.failed === true || next.failed === true ? { failed: true } : {}),
    tool: { ...first.tool!, ...next.tool!, taskOps: [...first.tool!.taskOps!, ...next.tool!.taskOps!] },
  }
}

function bashInput(input: unknown): { description?: string; command?: string } {
  const { description, command } = typeof input === 'object' && input !== null
    ? input as { description?: unknown; command?: unknown }
    : {}
  return {
    ...(typeof description === 'string' && description.trim().length > 0 ? { description: description.trim() } : {}),
    ...(typeof command === 'string' && command.trim().length > 0 ? { command: command.trim() } : {}),
  }
}

function toolCallDetail(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const record = input as Record<string, unknown>
  for (const key of ['command', 'filePath', 'pattern', 'path', 'url', 'description', 'prompt']) {
    const value = record[key]
    if (typeof value === 'string' && value.length > 0) return truncate(value, 120)
  }
  return ''
}

function toolResultSummary(tool: string, ok: boolean, content: string): string {
  const firstLine = content.split('\n').find((line) => line.trim().length > 0) ?? ''
  const detail = truncate(firstLine.trim(), 160)
  if (!ok) return `${tool} failed${detail ? `: ${detail}` : ''}`
  return detail ? `${tool} → ${detail}` : `${tool} → done`
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value
}

/**
 * Items to «loose item | activity run», in order.
 *
 * Thinking, tool calls, to-do writes and sub-agent runs that follow one another
 * make one run; anything else — a user message, prose, a notice, a thread card, the
 * turn's elapsed line — is a loose item and ends the run. A notice therefore cuts a
 * run in two, and an interruption marks the run it cut off as `aborted`.
 *
 * A turn that was replayed has no measured `duration` item, so one is made from the
 * span of its records. The view hides it while that turn is still streaming.
 *
 * Memoised on the *identity* of the item list, one slot deep. Two callers ask
 * for the same projection on every paint — `paneSession.ts` for
 * `pruneDisclosure`, and `dom/transcriptView.ts` for the paint itself — and
 * `TranscriptState.items` is replaced wholesale by every event, never mutated
 * in place, so the reference is an exact answer to 「is this the same
 * transcript」. The result is `readonly` because it is now shared: nothing may
 * sort or splice what another caller is still reading.
 */
let lastGrouped: { items: readonly TranscriptItem[]; entries: readonly TranscriptEntry[] } | undefined

export function groupTranscript(input: readonly TranscriptItem[]): readonly TranscriptEntry[] {
  if (lastGrouped?.items === input) return lastGrouped.entries
  const entries = buildTranscriptEntries(input)
  lastGrouped = { items: input, entries }
  return entries
}

/** An `Agent` tool call: standalone in the transcript rather than a step of a run. */
export function isAgentCall(item: TranscriptItem): boolean {
  return item.kind === 'tool' && item.toolName === AGENT_TOOL && item.tool !== undefined
}

function isRunItem(item: TranscriptItem): boolean {
  return item.kind === 'thinking' || item.kind === 'tool' || item.kind === 'subagent'
}

function buildTranscriptEntries(input: readonly TranscriptItem[]): TranscriptEntry[] {
  const items = hoistDurations(input)
  const entries: TranscriptEntry[] = []
  const interruptedTurns = new Set(items.filter((item) => item.interrupt === true).map((item) => item.turnId))
  let segment: TranscriptItem[] = []
  let turn: { id: string; first: number; last: number; settled: boolean } | undefined

  const flush = (aborted: boolean): void => {
    if (segment.length > 0) entries.push({ kind: 'run', run: makeRun(segment, aborted, interruptedTurns) })
    segment = []
  }
  const closeTurn = (): void => {
    if (turn && !turn.settled && turn.last > turn.first) {
      const durationMs = turn.last - turn.first
      entries.push({
        kind: 'item',
        item: { id: `duration-span-${turn.id}`, kind: 'duration', text: `已处理 ${formatWorkedDuration(durationMs)}`, durationMs, turnId: turn.id },
      })
    }
    turn = undefined
  }

  for (const item of items) {
    if (item.turnId !== undefined && item.turnId !== turn?.id) {
      flush(false)
      closeTurn()
      turn = { id: item.turnId, first: Infinity, last: -Infinity, settled: false }
    }
    if (turn && item.turnId !== undefined) {
      const stamp = item.createdAt === undefined ? NaN : Date.parse(item.createdAt)
      if (Number.isFinite(stamp)) {
        turn.first = Math.min(turn.first, stamp)
        turn.last = Math.max(turn.last, stamp)
      }
    }
    if (turn && (item.kind === 'duration' || item.interrupt === true)) turn.settled = true
    // An empty assistant record is the shape of a tool-only request: no bubble,
    // and no reason to end the run around it.
    if (item.kind === 'assistant' && item.text.trim().length === 0) continue
    // A settled question is its own card, not a row: it cuts the segment like prose.
    const asked = item.toolName === ASK_TOOL ? receiptOf(item) : undefined
    if (asked) {
      flush(false)
      entries.push({ kind: 'item', item: receiptItem(item.id, item, asked) })
      continue
    }
    // A sub-agent is its own line, not a row of the work around it: that work
    // splits into a run on either side.
    if (isAgentCall(item)) {
      flush(false)
      entries.push({ kind: 'item', item })
      continue
    }
    // A thought is a line of its own, never a row of the work around it.
    if (item.kind === 'thinking') {
      flush(false)
      entries.push({ kind: 'run', run: makeRun([item], false, interruptedTurns) })
      continue
    }
    if (isRunItem(item)) {
      const last = segment[segment.length - 1]
      if (last !== undefined && isTaskCall(last) && isTaskCall(item)) {
        segment[segment.length - 1] = foldTaskCalls(last, item)
        continue
      }
      segment.push(item)
      // The plan's row stays in the segment; its decision follows as a card.
      const decided = item.toolName === EXIT_PLAN_TOOL ? receiptOf(item) : undefined
      if (decided) {
        flush(false)
        entries.push({ kind: 'item', item: receiptItem(`receipt:${item.id}`, item, decided) })
      }
      continue
    }
    flush(item.interrupt === true)
    entries.push({ kind: 'item', item })
  }
  flush(false)
  closeTurn()
  return entries
}

function makeRun(items: readonly TranscriptItem[], cutByInterrupt: boolean, interruptedTurns: ReadonlySet<string | undefined>): ActivityRun {
  const steps = items.map(toStep)
  const turnId = items[0]!.turnId
  const pending = steps.some((step) => 'pending' in step && step.pending === true)
  // A notice can stand between the run and the interruption, so a run that is
  // still waiting on a call is aborted by an interruption anywhere in its turn.
  const aborted = cutByInterrupt || (pending && interruptedTurns.has(turnId))
  return {
    id: `run:${items[0]!.id}`,
    ...(turnId === undefined ? {} : { turnId }),
    steps,
    // An interruption outranks a step still marked pending: the tool call the abort
    // cut off never gets a result, so "running" would be permanent.
    status: aborted ? 'aborted' : pending ? 'running' : 'done',
    failedCount: steps.filter((step) => (
      ('status' in step && step.status === 'failed') || ('failed' in step && step.failed === true)
    )).length,
  }
}

/**
 * Moves each `duration` item back beside the turn it measures.
 *
 * A notice minted between a turn's last record and its `turn-end` — an
 * interruption, a turn-level error — carries no `turnId`, so it separates the
 * turn's items and the duration would land after it, away from the answer. Order-preserving otherwise — the item only ever moves *earlier*, to just after
 * the last item of its own turn.
 */
function hoistDurations(items: readonly TranscriptItem[]): readonly TranscriptItem[] {
  // The *input* is handed back when nothing moved, which is the common case.
  let moved = false
  const list = [...items]
  for (let index = 0; index < list.length; index += 1) {
    const item = list[index]!
    if (item.kind !== 'duration' || item.turnId === undefined) continue
    let home = -1
    for (let back = index - 1; back >= 0; back -= 1) {
      if (list[back]!.turnId === item.turnId) { home = back; break }
    }
    // Already contiguous (or a turn with nothing else left to attach to).
    if (home === -1 || home === index - 1) continue
    list.splice(index, 1)
    list.splice(home + 1, 0, item)
    moved = true
  }
  return moved ? list : items
}

const TASK_TOOL = 'TodoWrite'
const ASK_TOOL = 'AskUserQuestion'
const EXIT_PLAN_TOOL = 'ExitPlanMode'
const AGENT_TOOL = 'Agent'
const AGENT_LABEL = '子代理'

const SUBAGENT_STATUS_LABELS: Readonly<Record<SubagentTaskStatus, string>> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  interrupted: '已中断',
}

/**
 * `input.task` — the prompt the parent handed the sub-agent (§6.2 Agent).
 * Agent calls only: another tool whose input happens to carry a `task` key
 * must not pose as one.
 */
function askedQuestions(input: unknown): { questions?: readonly string[] } {
  const asked = typeof input === 'object' && input !== null ? (input as { questions?: unknown }).questions : undefined
  if (!Array.isArray(asked)) return {}
  const questions = asked
    .map((one) => (typeof one === 'object' && one !== null ? (one as { question?: unknown }).question : undefined))
    .filter((question): question is string => typeof question === 'string')
  return questions.length > 0 ? { questions } : {}
}

const PLAN_MODE_LABELS: Readonly<Record<Exclude<PlanDecision, 'reject'>, string>> = {
  approve_restore_keep: '逐条确认修改',
  approve_auto_keep: '自动执行',
  approve_bypass_keep: '绕过权限',
}

/**
 * The receipt a settled step leaves behind, or nothing when it has none yet (a
 * question still open, a plan not decided, a question answered before the host
 * recorded the answers).
 */
function receiptOf(item: TranscriptItem): Receipt | undefined {
  const tool = item.tool
  if (tool === undefined || item.pending === true) return undefined
  if (item.toolName === ASK_TOOL) {
    if (tool.answers === undefined && item.failed !== true) return undefined
    const questions = tool.questions ?? Object.keys(tool.answers ?? {})
    return { kind: 'question', rows: questions.map((question) => {
      const answer = tool.answers?.[question]
      return answer === undefined || answer.trim().length === 0 ? { question } : { question, answer }
    }) }
  }
  const plan = tool.plan
  if (item.toolName !== EXIT_PLAN_TOOL || plan === undefined) return undefined
  const text = plan.decision === 'reject'
    ? plan.feedback ? `已拒绝 · 你的反馈：${plan.feedback}` : '已拒绝'
    : `已接受计划 · ${PLAN_MODE_LABELS[plan.decision]}`
  return { kind: 'plan', accepted: plan.decision !== 'reject', text, ...(plan.planContent === undefined ? {} : { planContent: plan.planContent }) }
}

function receiptItem(id: string, item: TranscriptItem, receipt: Receipt): TranscriptItem {
  return {
    id,
    kind: 'receipt',
    text: receipt.kind === 'plan' ? receipt.text : receipt.rows.map((row) => `${row.question} ${row.answer ?? '未回答'}`).join('\n'),
    receipt,
    ...(item.turnId === undefined ? {} : { turnId: item.turnId }),
    ...(item.createdAt === undefined ? {} : { createdAt: item.createdAt }),
  }
}

function agentTask(input: unknown): { task?: string; agentType?: string } {
  if (typeof input !== 'object' || input === null) return {}
  const { task, subagent_type: agentType } = input as { task?: unknown; subagent_type?: unknown }
  return {
    ...(typeof task === 'string' && task.length > 0 ? { task } : {}),
    ...(typeof agentType === 'string' && agentType.length > 0 ? { agentType } : {}),
  }
}

/**
 * Lays each running `Agent` step's latest sub-agent tool onto it. The list is
 * the controller's whole current set, so a step missing from it loses its line.
 * Unchanged steps keep their identity, and so does the array when nothing moved:
 * progress fires on every tool start and stop.
 */
function withSubagentActivity(
  items: readonly TranscriptItem[],
  activity: readonly SubagentActivity[],
): readonly TranscriptItem[] {
  const byCall = new Map(activity.map((entry) => [entry.toolUseId, entry]))
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool' || item.toolName !== AGENT_TOOL || item.tool === undefined) return item
    const entry = item.pending === true ? byCall.get(item.id) : undefined
    const current = item.tool.live
    if (entry === undefined) {
      if (current === undefined) return item
      changed = true
      const { live: _dropped, ...tool } = item.tool
      return { ...item, tool }
    }
    if (current?.tool === entry.tool && current.summary === entry.summary && current.toolCount === entry.toolCount
      && current.agentId === entry.agentId) {
      return item
    }
    changed = true
    const live = { tool: entry.tool, summary: entry.summary, toolCount: entry.toolCount, ...(entry.agentId ? { agentId: entry.agentId } : {}) }
    return { ...item, tool: { ...item.tool, live } }
  })
  return changed ? next : items
}

/**
 * §3's four states, in precedence order: a settled call is what it settled as,
 * and only an unsettled one distinguishes waiting for the user from running.
 */
export function toolStepStatus(item: TranscriptItem): ToolStepStatus {
  if (item.failed === true) return 'failed'
  if (item.pending !== true) return 'done'
  return item.tool?.awaitingApproval === true ? 'awaiting-approval' : 'running'
}

/**
 * The state in words.
 *
 * §3 makes the bead the tool's only *visual* status vocabulary, which is exactly
 * why the state also has to exist as text: the bead is `aria-hidden`, so this is
 * what reaches a screen reader (T17), and it is not a colour anyone has to decode.
 */
export function toolStatusLabel(status: ToolStepStatus): string {
  switch (status) {
    case 'awaiting-approval': return '等待授权'
    case 'running': return '执行中'
    case 'done': return '完成'
    case 'failed': return '失败'
  }
}

export function toStep(item: TranscriptItem): ActivityStep {
  switch (item.kind) {
    case 'thinking':
      return {
        kind: 'thinking',
        id: item.id,
        text: item.text,
        ...(item.pending === true ? { pending: true } : {}),
        ...(item.durationMs === undefined ? {} : { durationMs: item.durationMs }),
        ...(item.startedAt === undefined ? {} : { startedAt: item.startedAt }),
      }
    case 'tool': {
      const tool = item.tool ?? { displayName: item.toolName ?? '', useSummary: '' }
      return {
        // `TodoWrite` is the one tool whose body lives elsewhere: the task panel
        // above the composer owns the list, so the step is a single line (§4.4).
        kind: item.toolName === TASK_TOOL ? 'task' : 'tool',
        id: item.id,
        text: item.text,
        status: toolStepStatus(item),
        tool,
        ...(item.toolName === undefined ? {} : { toolName: item.toolName }),
        ...(item.pending === true ? { pending: true } : {}),
        ...(item.failed === true ? { failed: true } : {}),
      }
    }
    case 'subagent':
      return {
        kind: 'subagent',
        id: item.id,
        text: item.text,
        ...(item.pending === true ? { pending: true } : {}),
      }
    default:
      throw new Error(`Not a run item: ${item.kind}`)
  }
}

function assertNever(value: never): never {
  throw new Error(`Unhandled session event: ${JSON.stringify(value)}`)
}
