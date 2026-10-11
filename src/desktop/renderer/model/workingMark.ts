import type { ActivityRun } from './transcript.js'
import type { CallStep } from './toolPhrases.js'

/**
 * The working mark's decisions: the sprite sheets, the stage machine and which
 * body an activity shows. Ported from Claude Desktop's WorkingMark; the view
 * (`dom/workingMarkView.ts`) owns images, animations and timers.
 *
 * A body plays `in`, then `loop` until the activity changes, then `out` and the
 * next body's `in` — never a hard cut. `grow` is the placeholder dot shrinking
 * into the first `in` frame, played once per turn. `tail` is a long loop's last
 * `TAIL_FRAMES` frames, so a switch need not wait the whole loop out.
 */

export type MarkBody = 'default' | 'think' | 'search' | 'read' | 'write' | 'code' | 'blocked'
export type MarkState = 'working' | 'blocked'

export interface MarkSpec {
  readonly body: MarkBody
  readonly state: MarkState
}

export type MarkStage =
  | { readonly kind: 'grow' }
  | { readonly kind: 'in' | 'loop' | 'out' | 'tail'; readonly body: MarkBody }

export type MarkClip = 'grow' | `${MarkBody}.${'in' | 'loop' | 'out'}`

export interface SheetInfo {
  readonly frames: number
  /** ms per frame (30fps). */
  readonly speed: number
  /** The frame a still mark shows. */
  readonly rest?: number
  /** Loop frames where `out` can start without a visible jump. */
  readonly seams?: readonly number[]
}

const SPEED = 33.3333

/** Frame counts from Claude Desktop's sheet table; each sheet is a vertical 48px-frame strip. */
export const SHEETS: Readonly<Record<MarkClip, SheetInfo>> = {
  grow: { frames: 10, speed: SPEED },
  'default.in': { frames: 16, speed: SPEED },
  'default.loop': { frames: 40, speed: SPEED, rest: 38 },
  'default.out': { frames: 14, speed: SPEED },
  'think.in': { frames: 16, speed: SPEED },
  'think.loop': { frames: 110, speed: SPEED, seams: [54], rest: 95 },
  'think.out': { frames: 15, speed: SPEED },
  'search.in': { frames: 16, speed: SPEED },
  'search.loop': { frames: 20, speed: SPEED, rest: 4 },
  'search.out': { frames: 14, speed: SPEED },
  'read.in': { frames: 21, speed: SPEED },
  'read.loop': { frames: 60, speed: SPEED, rest: 44 },
  'read.out': { frames: 19, speed: SPEED },
  'write.in': { frames: 31, speed: SPEED },
  'write.loop': { frames: 60, speed: SPEED, rest: 36 },
  'write.out': { frames: 14, speed: SPEED },
  'code.in': { frames: 16, speed: SPEED },
  'code.loop': { frames: 75, speed: SPEED, seams: [18, 37, 56], rest: 74 },
  'code.out': { frames: 9, speed: SPEED },
  'blocked.in': { frames: 16, speed: SPEED },
  'blocked.loop': { frames: 30, speed: SPEED, rest: 0 },
  'blocked.out': { frames: 16, speed: SPEED },
}

export const MARK_BODIES: readonly MarkBody[] = ['default', 'think', 'search', 'read', 'write', 'code', 'blocked']

/** A switch out of a loop plays only its last this-many frames. */
export const TAIL_FRAMES = 20
/** A loop with more than this left is cut short through `tail`; less, and it plays out. */
export const LOOP_HANDOFF_MS = 1500
export const IDLE_TIMEOUT_MS = 200
export const IDLE_FALLBACK_MS = 32

/** The body to show: `blocked` outranks the activity, and a body whose sheets are not decoded yet falls back to `default`. */
export function wantBody(spec: MarkSpec, ready?: (body: MarkBody) => boolean): MarkBody {
  const body = spec.state === 'blocked' ? 'blocked' : spec.body
  return ready === undefined || ready(body) ? body : 'default'
}

export function clipOf(stage: MarkStage): MarkClip {
  return stage.kind === 'grow' ? 'grow' : `${stage.body}.${stage.kind === 'tail' ? 'loop' : stage.kind}`
}

/**
 * The stage after `cur` finishes, given the body wanted now. Unlike the original,
 * an `in` whose target changed while it played goes `out` rather than cutting to
 * the new body's first frame.
 */
export function nextStage(cur: MarkStage, want: MarkBody): MarkStage {
  switch (cur.kind) {
    case 'grow':
    case 'out':
      return { kind: 'in', body: want }
    case 'in':
    case 'tail':
    case 'loop':
      return cur.body === want ? { kind: 'loop', body: cur.body } : { kind: 'out', body: cur.body }
  }
}

/** Where a still mark (reduced motion) rests: the wanted body's loop, at its rest frame. */
export function restStage(want: MarkBody): { readonly stage: MarkStage; readonly frame: number } {
  const sheet = SHEETS[`${want}.loop`]
  return { stage: { kind: 'loop', body: want }, frame: sheet.rest ?? Math.floor(sheet.frames / 3) }
}

const TOOL_BODIES: Readonly<Record<string, MarkBody>> = {
  WebFetch: 'search',
  WebSearch: 'search',
  Browser: 'search',
  Read: 'read',
  Grep: 'read',
  Glob: 'read',
  BashOutput: 'read',
  Edit: 'write',
  MultiEdit: 'write',
  NotebookEdit: 'write',
  Write: 'write',
  Delete: 'write',
  TodoWrite: 'write',
  TaskCreate: 'write',
  TaskGet: 'write',
  TaskList: 'write',
  TaskUpdate: 'write',
  Config: 'write',
  EnterPlanMode: 'write',
  ExitPlanMode: 'write',
  Bash: 'code',
  KillShell: 'code',
}

/**
 * What the mark shows for the live run; `undefined` when there is no run to read
 * (a compaction or retry, a pending question, the status line of its own).
 *
 * A call waiting on the user's approval outranks the others, and is the same
 * call `runActivity` names; otherwise the last running call decides, else a
 * pending thought.
 */
export function markSpecFor(run: ActivityRun | undefined): MarkSpec {
  if (run === undefined) return { body: 'default', state: 'working' }
  const running = run.steps.filter((step): step is CallStep => (step.kind === 'tool' || step.kind === 'task') && step.pending === true)
  const waiting = running.filter((step) => step.tool.awaitingApproval === true).at(-1)
  const call = waiting ?? running.at(-1)
  if (call !== undefined) {
    return { body: (call.toolName && TOOL_BODIES[call.toolName]) || 'default', state: waiting ? 'blocked' : 'working' }
  }
  const last = run.steps.at(-1)
  return { body: last?.kind === 'thinking' && last.pending === true ? 'think' : 'default', state: 'working' }
}
