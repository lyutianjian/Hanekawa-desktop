import { parseUnifiedPatch } from './diffRows.js'
import type { ActivityRun, ActivityStep, TranscriptEntry } from './transcript.js'
import { isMemoryIndex, memoryOp, memorySlug } from './memoryOps.js'

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

/** While the thought's first sentence is still being written. */
export const THINKING_LIVE_LABEL = '思考'
/** A sealed thought that said nothing; its elapsed time, when measured, sits beside it. */
export const THINKING_DONE_FALLBACK = '思考过程'

/** What the user decided by hand, by run, step or user-message id. Absent = folded. */
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
    if (entry.kind === 'item' && entry.item.kind === 'user') live.add(entry.item.id)
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

/** Where a thought's sentences end: after 。！？, after `.!?` and a space, and at line breaks. */
const SENTENCE_BREAK = /(?<=[。！？])|(?<=[.!?])\s+|\n+/

function sentences(text: string): string[] {
  return text.split(SENTENCE_BREAK).map((part) => part.trim()).filter((part) => part.length > 0)
}

/** The first sentence of a thought — what its sealed line says. */
export function thoughtFirstSentence(text: string): string {
  return sentences(text)[0] ?? ''
}

/** What follows the first sentence: an open thought's body, under the line that says the first. */
export function thoughtRest(text: string): string {
  const trimmed = text.trimStart()
  const boundary = SENTENCE_BREAK.exec(trimmed)
  return boundary === null ? '' : trimmed.slice(boundary.index + boundary[0].length).trim()
}

/** The sealed line: the first sentence, or the generic name when nothing was said. */
export function thoughtLabel(text: string): string {
  return thoughtFirstSentence(text) || THINKING_DONE_FALLBACK
}

/**
 * The live line: the first sentence once a second one has begun, so the line
 * settles once rather than following the stream; 「思考」 until then.
 */
export function thoughtLiveLabel(text: string): string {
  const parts = sentences(text)
  return parts.length > 1 ? parts[0]! : THINKING_LIVE_LABEL
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

type Category = 'cmd' | 'read' | 'edit' | 'search' | 'web' | 'agent' | 'todo' | 'plan' | 'memRecall' | 'memSave' | 'memDelete' | 'memIndex' | 'other'

const CATEGORY_OF: Readonly<Record<string, Category>> = {
  Bash: 'cmd', BashOutput: 'cmd', KillShell: 'cmd', Monitor: 'cmd',
  Read: 'read',
  Edit: 'edit', MultiEdit: 'edit', Write: 'edit', NotebookEdit: 'edit', Delete: 'edit',
  Grep: 'search', Glob: 'search',
  WebFetch: 'web', WebSearch: 'web',
  Agent: 'agent',
  ExitPlanMode: 'plan',
  TodoWrite: 'todo', TaskCreate: 'todo', TaskUpdate: 'todo', TaskList: 'todo', TaskGet: 'todo',
}

const CATEGORY_TEXT: Readonly<Record<Exclude<Category, 'todo'>, (count: number) => string>> = {
  cmd: (count) => `运行 ${count} 个命令`,
  read: (count) => `读取 ${count} 个文件`,
  edit: (count) => `编辑 ${count} 个文件`,
  search: (count) => `搜索 ${count} 次`,
  web: (count) => `浏览 ${count} 个网页`,
  agent: (count) => `运行 ${count} 个子代理`,
  plan: () => '提出计划',
  memRecall: (count) => `调取 ${count} 条记忆`,
  memSave: (count) => `保存 ${count} 条记忆`,
  memDelete: (count) => `删除 ${count} 条记忆`,
  memIndex: () => '整理记忆索引',
  other: (count) => `使用 ${count} 个工具`,
}

function categoryOf(step: ActivityStep): Category | undefined {
  if (step.kind === 'thinking') return undefined
  if (step.kind === 'subagent') return 'agent'
  if (step.kind === 'task') return 'todo'
  const memory = memoryOp(step)
  if (memory !== undefined) {
    if (isMemoryIndex(step)) return 'memIndex'
    return memory === 'recall' || memory === 'search' ? 'memRecall' : memory === 'delete' ? 'memDelete' : 'memSave'
  }
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
    keys.add(countKey(category, step))
    if (category === 'edit' && step.kind === 'tool' && step.status === 'done') {
      const patch = step.tool.detail === undefined ? undefined : parseUnifiedPatch(step.tool.detail)
      if (patch === undefined || patch.partial) readable = false
      else {
        added += patch.added
        deleted += patch.deleted
      }
    }
  }
  // The index only restates the memories beside it; alone, it is the run's whole story.
  if (counts.size > 1) counts.delete('memIndex')
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

/**
 * What makes two steps the same thing counted once: an edited file is one file
 * however many times it was edited, and a memory is one memory. A memory search
 * has no file, so each search counts.
 */
function countKey(category: Category, step: ActivityStep): string {
  if (step.kind !== 'tool') return step.id
  if (category === 'edit' && step.tool.useSummary) return step.tool.useSummary
  if ((category === 'memSave' || category === 'memDelete' || category === 'memRecall') && memoryOp(step) !== 'search') return memorySlug(step)
  return step.id
}

/** A run with at least one thing that is not a thought: it folds to a summary line. */
export function runHasTools(run: ActivityRun): boolean {
  return run.steps.some((step) => step.kind !== 'thinking')
}

/** 「2 个失败」, drawn apart from the summary so it can take the danger colour. */
export function failureLabel(count: number): string {
  return `${count} 个失败`
}
