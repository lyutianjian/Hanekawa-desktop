import { parseUnifiedPatch } from './diffRows.js'
import { formatWorkedDuration } from './transcript.js'
import type { ActivityRun, ActivityStep, TranscriptEntry } from './transcript.js'

/**
 * What the transcript's activity lines say, and which of them are open — as pure
 * decisions.
 *
 * Disclosure is the user's alone: everything is folded by default (a failure and
 * an edit's diff included — the summary line says how many failed), and a click
 * records `expanded: true | false` as an absolute answer that nothing recomputes.
 *
 * DOM-free, like everything in `model/`.
 */

/** While the thought is still arriving. */
export const THINKING_LIVE_LABEL = '正在思考'
/** A sealed thought that said nothing; its elapsed time, when measured, sits beside it. */
export const THINKING_DONE_FALLBACK = '思考过程'

/** What the user decided by hand, by run id or step id. Absent = folded. */
export type DisclosureState = ReadonlyMap<string, boolean>

export const NO_DISCLOSURE: DisclosureState = new Map()

export function isExpanded(state: DisclosureState, id: string): boolean {
  return state.get(id) === true
}

/**
 * Records the user's answer for `id` as an absolute value.
 *
 * `expanded` is what the row shows **now**, so the first click always does the
 * visible thing.
 */
export function toggleDisclosure(state: DisclosureState, id: string, expanded: boolean): DisclosureState {
  const next = new Map(state)
  next.set(id, !expanded)
  return next
}

/**
 * Drops answers for runs and steps that no longer exist: a `transcript-reset`
 * rebuilds the state with the thinking counter back at zero, so the next block
 * reuses `thinking-0` and would inherit a *different* block's answer.
 */
export function pruneDisclosure(entries: readonly TranscriptEntry[], state: DisclosureState): DisclosureState {
  const live = new Set<string>()
  for (const entry of entries) {
    if (entry.kind !== 'run') continue
    live.add(entry.run.id)
    for (const step of entry.run.steps) live.add(step.id)
  }
  const next = new Map<string, boolean>()
  for (const [id, expanded] of state) {
    if (live.has(id)) next.set(id, expanded)
  }
  return next
}

/**
 * The tools whose body is a diff. Their summary carries the line counts, and the
 * patch is the body of their row.
 */
export const EDIT_TOOLS: ReadonlySet<string> = new Set(['Edit', 'MultiEdit', 'Write', 'NotebookEdit'])

// --- thoughts ----------------------------------------------------------------

/** The sentences of a thought: split after 。！？, after `.!?` and a space, and at line breaks. */
function sentences(text: string): string[] {
  return text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n+/).map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The first sentence of a thought — what its sealed line says. */
export function thoughtFirstSentence(text: string): string {
  return sentences(text)[0] ?? ''
}

/** The sealed line: the first sentence, or the generic name when nothing was said. */
export function thoughtLabel(text: string): string {
  return thoughtFirstSentence(text) || THINKING_DONE_FALLBACK
}

/** The live line: 「正在思考 · 最新一句」, the newest sentence being the one just written. */
export function thoughtLiveLabel(text: string): string {
  const latest = sentences(text).at(-1)
  return latest === undefined ? THINKING_LIVE_LABEL : `${THINKING_LIVE_LABEL} · ${latest}`
}

/**
 * 「12s」 beside a sealed thought, or nothing: one still arriving has no total
 * yet, and a replayed one was never timed, so a guess would be a number nobody
 * measured.
 */
export function thinkingDurationLabel(block: { readonly pending?: boolean; readonly durationMs?: number }): string | undefined {
  if (block.pending === true || block.durationMs === undefined) return undefined
  return formatWorkedDuration(block.durationMs)
}

// --- run summary -------------------------------------------------------------

export interface RunSummary {
  /** 「已运行 2 个命令，读取 2 个文件」; empty for a run with no tool in it. */
  readonly text: string
  /** The edits' line counts, when every patch could be read. */
  readonly diff?: { readonly added: number; readonly deleted: number }
  readonly failed: number
  readonly aborted: boolean
}

type Category = 'cmd' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'todo' | 'other'

const CATEGORY_OF: Readonly<Record<string, Category>> = {
  Bash: 'cmd', BashOutput: 'cmd', KillShell: 'cmd',
  Read: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Delete: 'edit',
  Grep: 'search', Glob: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
}

const CATEGORY_TEXT: Readonly<Record<Exclude<Category, 'todo'>, (count: number) => string>> = {
  cmd: (count) => `已运行 ${count} 个命令`,
  read: (count) => `读取 ${count} 个文件`,
  edit: (count) => `编辑 ${count} 个文件`,
  search: (count) => `搜索 ${count} 次`,
  web: (count) => `浏览 ${count} 个网页`,
  agent: (count) => `运行 ${count} 个子代理`,
  other: (count) => `已使用 ${count} 个工具`,
}

function categoryOf(step: ActivityStep): Category | undefined {
  if (step.kind === 'thinking') return undefined
  if (step.kind === 'subagent') return 'agent'
  if (step.kind === 'task') return 'todo'
  return (step.toolName === undefined ? undefined : CATEGORY_OF[step.toolName]) ?? 'other'
}

/**
 * The line a run folds to. Counts are per category, in the order each category
 * first appears; a file edited five times is still one file. Thinking is not
 * counted. A failure or an interruption is appended by the view in its own colour.
 */
export function summarizeRun(run: ActivityRun): RunSummary {
  const counts = new Map<Category, Set<string>>()
  let added = 0
  let deleted = 0
  let readable = true
  for (const step of run.steps) {
    const category = categoryOf(step)
    if (category === undefined) continue
    const keys = counts.get(category) ?? new Set<string>()
    counts.set(category, keys)
    // An edit counts files, not calls: the same path again is not another file.
    keys.add(category === 'edit' && step.kind === 'tool' && step.tool.useSummary ? step.tool.useSummary : step.id)
    if (category === 'edit' && step.kind === 'tool' && step.status === 'done') {
      const patch = step.tool.detail === undefined ? undefined : parseUnifiedPatch(step.tool.detail)
      if (patch === undefined || patch.capped) readable = false
      else {
        added += patch.added
        deleted += patch.deleted
      }
    }
  }
  const text = [...counts].map(([category, keys]) => (
    category === 'todo' ? '更新了待办' : CATEGORY_TEXT[category](keys.size)
  )).join('，')
  return {
    text,
    ...(counts.has('edit') && readable && added + deleted > 0 ? { diff: { added, deleted } } : {}),
    failed: run.failedCount,
    aborted: run.status === 'aborted',
  }
}

/** A run with at least one thing that is not a thought: it folds to a summary line. */
export function runHasTools(run: ActivityRun): boolean {
  return run.steps.some((step) => step.kind !== 'thinking')
}

/** 「2 个失败」, drawn apart from the summary so it can take the danger colour. */
export function failureLabel(count: number): string {
  return `${count} 个失败`
}
