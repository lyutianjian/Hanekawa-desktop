import type { ActivityRun, DraftCall } from './transcript.js'
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

export type MarkBody = 'default' | 'think' | 'search' | 'read' | 'write' | 'compose' | 'code' | 'blocked'
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
  'compose.in': { frames: 16, speed: SPEED },
  'compose.loop': { frames: 62, speed: SPEED, rest: 49 },
  'compose.out': { frames: 12, speed: SPEED },
  'code.in': { frames: 16, speed: SPEED },
  'code.loop': { frames: 75, speed: SPEED, seams: [18, 37, 56], rest: 74 },
  'code.out': { frames: 9, speed: SPEED },
  'blocked.in': { frames: 16, speed: SPEED },
  'blocked.loop': { frames: 30, speed: SPEED, rest: 0 },
  'blocked.out': { frames: 16, speed: SPEED },
}

export const MARK_BODIES: readonly MarkBody[] = ['default', 'think', 'search', 'read', 'write', 'compose', 'code', 'blocked']

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

// Claude Desktop's lexicon for a call no table names: a Bash description's
// leading verb, or the words of a tool's name.
const READ_WORDS = new Set(['read', 'view', 'get', 'list', 'fetch', 'search', 'find', 'query', 'retrieve', 'lookup', 'load', 'open', 'ls'])
const WRITE_WORDS = new Set([
  'write', 'edit', 'create', 'update', 'delete', 'remove', 'append', 'insert', 'replace',
  'patch', 'send', 'post', 'add', 'save', 'upload', 'comment', 'artifacts',
])
const CODE_WORDS = new Set(['bash', 'exec', 'execute', 'run', 'shell', 'python', 'repl', 'script', 'eval', 'javascript'])

/** The first word and its likely stems: `Listing` → listing, list, liste; `Files` → files, file, fil. */
function verbForms(text: string): string[] {
  const word = /^\s*([A-Za-z]+)/.exec(text)?.[1]?.toLowerCase()
  if (word === undefined) return []
  if (word.endsWith('ing') && word.length > 5) {
    const stem = word.slice(0, -3)
    return [word, stem, `${stem}e`, stem.replace(/([b-df-hj-np-tv-z])\1$/, '$1')]
  }
  if (word.endsWith('ies')) return [word, `${word.slice(0, -3)}y`]
  return word.endsWith('s') && !word.endsWith('ss') && word.length > 3 ? [word, word.slice(0, -1), word.slice(0, -2)] : [word]
}

function bashBody(description: string | undefined): MarkBody {
  for (const form of verbForms(description ?? '')) {
    if (WRITE_WORDS.has(form)) return 'write'
    if (READ_WORDS.has(form)) return 'read'
  }
  return 'code'
}

/** An MCP tool is named by its action, not its server: `mcp__github__create_issue` → create, issue. */
function nameBody(name: string): MarkBody {
  const action = name.startsWith('mcp__') ? name.split('__').at(-1)! : name
  for (const word of action.replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().split(/[\s:_-]+/)) {
    if (WRITE_WORDS.has(word)) return 'write'
    if (CODE_WORDS.has(word)) return 'code'
    if (READ_WORDS.has(word)) return 'read'
  }
  return 'default'
}

const DOC_FILE = /\.(md|mdx|txt|rst|docx|pdf)$/i
/** Configuration and instructions are not documents being written. */
const NOT_A_DOC = /(^|[\\/])\.myagent[\\/]|(^|[\\/])(AGENTS|CLAUDE)(\.local)?\.md$/i

interface CallHints {
  readonly path?: string
  readonly description?: string
}

/** A running write to a document composes; settled, it is plain writing again. */
function callBody(name: string | undefined, hints: CallHints, running: boolean): MarkBody {
  if (!name) return 'default'
  if (name === 'Bash') return bashBody(hints.description)
  const body = TOOL_BODIES[name] ?? nameBody(name)
  const doc = hints.path !== undefined && DOC_FILE.test(hints.path) && !NOT_A_DOC.test(hints.path)
  return body === 'write' && running && doc ? 'compose' : body
}

function stepBody(step: CallStep, running: boolean): MarkBody {
  return callBody(step.toolName, { path: step.tool.useSummary, description: step.tool.description }, running)
}

/** A string field the arguments have already closed. */
function peekField(json: string, key: string): string | undefined {
  const raw = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(json)?.[1]
  if (raw === undefined) return undefined
  try {
    return JSON.parse(`"${raw}"`) as string
  } catch {
    return undefined
  }
}

/**
 * What the mark shows for the live run and the call whose arguments are still
 * streaming.
 *
 * A call waiting on the user's approval outranks the others, and is the same
 * call `runActivity` names; then the last running call, then the call being
 * written. With nothing running the mark holds the turn's latest step — the
 * last call's body, or `think` after a thought — and starts at `think`.
 */
export function markSpecFor(run: ActivityRun | undefined, draft?: DraftCall): MarkSpec {
  const running = (run?.steps ?? []).filter((step): step is CallStep => (step.kind === 'tool' || step.kind === 'task') && step.pending === true)
  const waiting = running.filter((step) => step.tool.awaitingApproval === true).at(-1)
  const call = waiting ?? running.at(-1)
  if (call !== undefined) return { body: stepBody(call, true), state: waiting ? 'blocked' : 'working' }
  if (draft !== undefined) {
    const path = peekField(draft.input, 'filePath') ?? peekField(draft.input, 'file_path')
    const hints = { path, description: peekField(draft.input, 'description') }
    return { body: callBody(draft.name, hints, true), state: 'working' }
  }
  for (const step of [...(run?.steps ?? [])].reverse()) {
    if (step.kind === 'thinking') return { body: 'think', state: 'working' }
    if (step.kind === 'tool' || step.kind === 'task') return { body: stepBody(step, false), state: 'working' }
    if (step.kind === 'subagent') return { body: 'default', state: 'working' }
  }
  return { body: 'think', state: 'working' }
}
