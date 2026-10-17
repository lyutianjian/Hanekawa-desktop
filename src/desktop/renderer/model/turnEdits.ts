import { diffWordsWithSpace } from 'diff'
import { parseUnifiedPatch, patchPath, type DiffRow } from './diffRows.js'
import { EDIT_TOOLS } from './thinking.js'
import { groupTranscript, type TranscriptEntry, type TranscriptItem } from './transcript.js'

/**
 * The files one turn's editing tools changed, gathered from the unified patches
 * they ship in `display.detail` — the 已编辑 card under the turn reads one
 * turn's, the 改动 page of the side panel the whole session's. Pure, from
 * transcript entries only.
 */

/** A changed span inside a line, as `[start, end)` character offsets. */
export type LineMark = readonly [number, number]

export interface ChangeRow extends DiffRow {
  /** On a changed line paired with its counterpart: the words that differ. */
  readonly marks?: readonly LineMark[]
}

export interface EditedFile {
  readonly path: string
  readonly name: string
  /** Lines counted from every patch; absent when one of them was capped without its counts and the count would be short. */
  readonly added?: number
  readonly deleted?: number
  /** Each patch's rows in the order the tools ran. */
  readonly rows: readonly ChangeRow[]
}

export interface TurnEdits {
  /** Stable across repaints: the first editing step's id. */
  readonly key: string
  /** The message that opened the turn — the checkpoint 撤销 rewinds to. */
  readonly userMessageId?: string
  readonly files: readonly EditedFile[]
  readonly added?: number
  readonly deleted?: number
}

interface FileAcc {
  path: string
  rows: ChangeRow[]
  added: number
  deleted: number
  partial: boolean
}

/**
 * Each finished turn's edits, keyed by the index of the turn's last entry —
 * the same index `splitTurnFooters` keys its footers by, passed in as `ends`.
 * A turn that edited nothing has no entry.
 */
export function collectTurnEdits(entries: readonly TranscriptEntry[], ends: ReadonlySet<number>): Map<number, TurnEdits> {
  const result = new Map<number, TurnEdits>()
  let files = new Map<string, FileAcc>()
  let key: string | undefined
  let userMessageId: string | undefined
  entries.forEach((entry, index) => {
    if (entry.kind === 'item' && entry.item.kind === 'user') userMessageId ??= entry.item.id
    if (entry.kind === 'run') {
      for (const step of entry.run.steps) {
        if (step.kind !== 'tool' || step.status !== 'done' || step.toolName === undefined || !EDIT_TOOLS.has(step.toolName)) continue
        const detail = step.tool.detail
        const patch = detail === undefined ? undefined : parseUnifiedPatch(detail)
        const path = detail === undefined ? undefined : patchPath(detail)
        if (patch === undefined || path === undefined) continue
        key ??= step.id
        const file = files.get(path) ?? { path, rows: [], added: 0, deleted: 0, partial: false }
        files.set(path, file)
        file.rows.push(...markChangedWords(patch.rows).map((row, at, all) => (
          row.kind === 'elided' ? { ...row, text: elidedText(row.text, patch.capped && at === all.length - 1) } : row
        )))
        file.added += patch.added
        file.deleted += patch.deleted
        file.partial ||= patch.partial
      }
    }
    if (!ends.has(index)) return
    if (key !== undefined) result.set(index, turnEdits(key, userMessageId, [...files.values()]))
    files = new Map()
    key = undefined
    userMessageId = undefined
  })
  return result
}

/**
 * Every edit the session's own tools made, one file per path: a file edited in
 * several turns lists each turn's patch in order rather than one net diff.
 */
export function sessionEdits(items: readonly TranscriptItem[]): TurnEdits | undefined {
  const entries = groupTranscript(items)
  return collectTurnEdits(entries, new Set([entries.length - 1])).get(entries.length - 1)
}

function turnEdits(key: string, userMessageId: string | undefined, files: readonly FileAcc[]): TurnEdits {
  const counted = files.every((file) => !file.partial)
  return {
    key,
    ...(userMessageId === undefined ? {} : { userMessageId }),
    files: files.map((file) => ({
      path: file.path,
      name: baseName(file.path),
      rows: file.rows,
      ...(file.partial ? {} : { added: file.added, deleted: file.deleted }),
    })),
    ...(counted
      ? { added: files.reduce((sum, file) => sum + file.added, 0), deleted: files.reduce((sum, file) => sum + file.deleted, 0) }
      : {}),
  }
}

/** A hunk's gap is lines left alone; a capped patch's tail is lines the tool did not ship. */
function elidedText(text: string, cut: boolean): string {
  const count = /\d+/.exec(text)?.[0]
  if (count === undefined) return text
  return cut ? `另有 ${count} 行未显示` : `${count} 行未修改`
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/**
 * The folder a file sits in, said relative to the project when it is inside it.
 * `root` is the normalized project key, which may differ from the path in case
 * only; outside the project the full folder is the honest answer.
 */
export function folderOf(path: string, root: string | undefined): string {
  const folder = path.slice(0, Math.max(0, path.lastIndexOf('/')))
  if (root === undefined) return folder
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (folder.toLowerCase() === root.toLowerCase().replace(/\/$/, '')) return ''
  return folder.toLowerCase().startsWith(prefix.toLowerCase()) ? folder.slice(prefix.length) : folder
}

/** `TS`, `CSS`, `MD`: the extension a file badge prints, at most four letters. */
export function fileBadge(name: string): string {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1) : ''
  return ext.length > 0 && ext.length <= 4 ? ext.toUpperCase() : ''
}

/** Lines longer than this are left unmarked: the word diff is quadratic and the mark unreadable anyway. */
const MARK_MAX_LINE = 400

/**
 * A run of deleted lines followed by as many added ones is read as those lines
 * rewritten in place: each pair gets the words that differ marked. A pair that
 * shares too little is a replacement, not an edit, and stays unmarked.
 */
export function markChangedWords(rows: readonly DiffRow[]): ChangeRow[] {
  const out: ChangeRow[] = [...rows]
  let index = 0
  while (index < rows.length) {
    if (rows[index]!.kind !== 'del') {
      index += 1
      continue
    }
    let dels = index
    while (dels < rows.length && rows[dels]!.kind === 'del') dels += 1
    let adds = dels
    while (adds < rows.length && rows[adds]!.kind === 'add') adds += 1
    const count = dels - index
    if (adds - dels === count) {
      for (let pair = 0; pair < count; pair += 1) {
        const del = rows[index + pair]!
        const add = rows[dels + pair]!
        const marks = pairMarks(del.text, add.text)
        if (marks === undefined) continue
        out[index + pair] = { ...del, marks: marks.del }
        out[dels + pair] = { ...add, marks: marks.add }
      }
    }
    index = adds
  }
  return out
}

function pairMarks(before: string, after: string): { del: LineMark[]; add: LineMark[] } | undefined {
  if (before.length > MARK_MAX_LINE || after.length > MARK_MAX_LINE) return undefined
  const del: LineMark[] = []
  const add: LineMark[] = []
  let oldAt = 0
  let newAt = 0
  let kept = 0
  for (const part of diffWordsWithSpace(before, after)) {
    const length = part.value.length
    if (part.removed) {
      del.push([oldAt, oldAt + length])
      oldAt += length
    } else if (part.added) {
      add.push([newAt, newAt + length])
      newAt += length
    } else {
      kept += part.value.trim().length
      oldAt += length
      newAt += length
    }
  }
  // Mostly rewritten: marking nearly the whole line says nothing the row colour does not.
  if (kept * 2 < Math.max(before.trim().length, after.trim().length)) return undefined
  return { del: merge(del), add: merge(add) }
}

/** Adjacent marks drawn as one span, so a run of changed words reads as one change. */
function merge(marks: readonly LineMark[]): LineMark[] {
  const out: [number, number][] = []
  for (const [start, end] of marks) {
    const last = out.at(-1)
    if (last !== undefined && last[1] === start) last[1] = end
    else out.push([start, end])
  }
  return out
}
