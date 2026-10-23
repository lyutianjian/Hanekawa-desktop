import { diffLines } from 'diff'
import type { FileToolPreview } from '../../../services/fileToolPreview.js'

/**
 * A file-tool preview turned into rows a view can paint one per line.
 *
 * `PermissionRequestDto.preview` arrives as two whole strings (`oldText` /
 * `newText`) already bounded by `capFileToolPreview`; turning them into a diff
 * is the viewer's job, which is why `src/tui/diff.ts` stayed in the TUI. This is
 * the DOM half of that decision, kept pure and line-oriented because a browser
 * can afford real line numbers and a gutter.
 *
 * The same rows also carry the *editing tools'* own unified patches
 * (`parseUnifiedPatch`): the tool ships the patch in `display.detail` (T12), the
 * transcript parses it back (T13), and the permission dialog and a tool step
 * share one diff look.
 *
 * DOM-free on purpose: `test/` imports this module, and a test import drags a
 * file into the base tsconfig program, which has no DOM lib. See
 * `renderer/bridgeChannel.ts` for the same reason.
 */

export type DiffRowKind = 'add' | 'del' | 'ctx' | 'elided'

export interface DiffRow {
  readonly kind: DiffRowKind
  readonly text: string
  /** 1-based, present on the side the row exists in. */
  readonly oldLine?: number
  readonly newLine?: number
}

export interface DiffPreviewView {
  readonly kind: 'diff'
  readonly title: string
  readonly filePath?: string
  readonly summary: string
  readonly rows: readonly DiffRow[]
}

export interface MessagePreviewView {
  readonly kind: 'message'
  readonly title: string
  readonly filePath?: string
  readonly message: string
}

export type PreviewView = DiffPreviewView | MessagePreviewView

/** Rows beyond this are collapsed into one `elided` row. Display-only. */
export const DEFAULT_MAX_DIFF_ROWS = 240

/**
 * The stats a unified patch's own rows carry, for a head that reads
 * `Edit src/foo.ts · +12 −3` (§6.2).
 */
export interface PatchRows {
  readonly rows: readonly DiffRow[]
  /** Rows with a `+` prefix. */
  readonly added: number
  /** Rows with a `-` prefix. */
  readonly deleted: number
  /** The tool ran out of budget and dropped lines. */
  readonly capped: boolean
  /** Capped without the whole patch's counts (an older record): the counts above are short. */
  readonly partial: boolean
}

/**
 * The cap line `src/tools/editPatch.ts` appends when it runs out of budget,
 * verbatim, with the whole patch's `(+added -deleted)` (absent in older
 * records). A format contract, duplicated for the same reason
 * `isSystemReminderBlock` is: the renderer may not import `tools/`.
 */
const PATCH_ELISION = /^… (\d+) more lines? not shown(?: \(\+(\d+) -(\d+)\))?$/

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/** The file a unified patch names on its `+++ b/…` header, or `undefined` without one. */
export function patchPath(patch: string): string | undefined {
  const header = patch.split('\n', 3).find((line) => line.startsWith('+++ '))
  const path = header === undefined ? undefined : unquotePath(header.slice(4).trim()).replace(/^b\//, '')
  return path ? path : undefined
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 }

/**
 * A header name as `diff` writes it: C-quoted, with UTF-8 bytes as octal
 * escapes, whenever it holds anything but printable ASCII — a Chinese file
 * name among them.
 */
function unquotePath(name: string): string {
  if (name.length < 2 || !name.startsWith('"') || !name.endsWith('"')) return name
  const bytes: number[] = []
  const body = name.slice(1, -1)
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!
    if (char !== '\\') {
      bytes.push(...new TextEncoder().encode(char))
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(body.slice(index + 1))?.[0]
    if (octal !== undefined) {
      bytes.push(parseInt(octal, 8))
      index += octal.length
    } else {
      const next = body[index + 1] ?? ''
      bytes.push(C_ESCAPES[next] ?? next.charCodeAt(0))
      index += 1
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/**
 * The unified patch the editing tools ship in `ToolResultDisplay.detail` (T12),
 * turned into the same rows the permission preview paints — line gutters
 * included, because the hunk headers carry real line numbers.
 *
 * Returns `undefined` for anything that is not one of those patches — an older
 * session's record, a tool from another family, a truncated string — and the
 * caller falls back to the plain body rather than erroring (§10).
 *
 * Two kinds of line become `elided` rows, and both are drawn as the dashed rule
 * rather than as content: a hunk header names the unchanged lines it skipped
 * over (the count falls out of the header's own numbers), and the patch's own
 * cap line names what the tool dropped before shipping it.
 */
export function parseUnifiedPatch(patch: string): PatchRows | undefined {
  const lines = patch.split('\n')
  // `createTwoFilesPatch` opens with an `===` separator the tool strips; kept
  // here so a hand-written or host-raw patch parses too.
  while (lines.length > 0 && lines[0]!.startsWith('===')) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length < 3) return undefined
  if (!lines[0]!.startsWith('--- ') || !lines[1]!.startsWith('+++ ')) return undefined

  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  let added = 0
  let deleted = 0
  let opened = false

  for (let index = 2; index < lines.length; index += 1) {
    const line = lines[index]!

    const hunk = HUNK_HEADER.exec(line)
    if (hunk !== null) {
      const hunkOld = Number(hunk[1])
      const hunkNew = Number(hunk[3])
      // What this hunk skipped before it starts. The first hunk skips the file's
      // head; a later one skips the unchanged run since the last — the same lines
      // on both sides in a well-formed patch, and the larger count is the honest
      // single number if they are not.
      const skipped = Math.max(hunkOld - oldLine, hunkNew - newLine) - (opened ? 0 : 1)
      if (skipped > 0) rows.push(elidedRow(skipped))
      oldLine = hunkOld
      newLine = hunkNew
      opened = true
      continue
    }

    const cap = PATCH_ELISION.exec(line)
    if (cap !== null) {
      // Terminal by construction — `capPatchLines` appends it last — so nothing
      // after it is expected or parsed. A cap with no hunk before it is not a
      // shape the tool emits, and reading it as an empty diff would draw a body
      // that says nothing.
      if (!opened) return undefined
      rows.push(elidedRow(Number(cap[1])))
      return cap[2] === undefined
        ? { rows, added, deleted, capped: true, partial: true }
        : { rows, added: Number(cap[2]), deleted: Number(cap[3]), capped: true, partial: false }
    }

    if (!opened) return undefined
    const marker = line.charAt(0)
    const text = line.slice(1)
    if (marker === '+') {
      rows.push({ kind: 'add', text, newLine })
      newLine += 1
      added += 1
    } else if (marker === '-') {
      rows.push({ kind: 'del', text, oldLine })
      oldLine += 1
      deleted += 1
    } else if (marker === ' ' || line === '') {
      // A fully empty line is a context line some emitters ship without its
      // leading space; both mean one unchanged blank.
      rows.push({ kind: 'ctx', text, oldLine, newLine })
      oldLine += 1
      newLine += 1
    } else if (marker === '\\') {
      // `\ No newline at end of file` — file metadata, not a line of either side.
      rows.push({ kind: 'ctx', text: line })
    } else {
      return undefined
    }
  }

  return opened ? { rows, added, deleted, capped: false, partial: false } : undefined
}

/**
 * How many lines of unchanged text to keep either side of a change.
 *
 * Without this a one-line edit to a 200-line file renders 200 rows of context
 * and the change is invisible.
 */
export const DIFF_CONTEXT_LINES = 3

export function previewView(
  preview: FileToolPreview,
  options: { maxRows?: number; contextLines?: number } = {},
): PreviewView {
  // `capFileToolPreview` degrades a diff it cannot cut (a minified single line,
  // or a file too large to read) into this shape, so it is a normal outcome
  // rather than an error path.
  if (preview.kind === 'message') {
    return {
      kind: 'message',
      title: preview.title,
      ...(preview.filePath !== undefined ? { filePath: preview.filePath } : {}),
      message: preview.message,
    }
  }

  const all = diffRowsFor(preview.oldText, preview.newText, options.contextLines ?? DIFF_CONTEXT_LINES)
  const maxRows = options.maxRows ?? DEFAULT_MAX_DIFF_ROWS
  const rows = all.length > maxRows
    ? [...all.slice(0, maxRows), elidedRow(all.length - maxRows)]
    : all

  return {
    kind: 'diff',
    title: preview.title,
    ...(preview.filePath !== undefined ? { filePath: preview.filePath } : {}),
    summary: summaryFor(preview),
    rows: preview.elided ? [...rows, elidedRow(droppedLines(preview.elided))] : rows,
  }
}

/**
 * The host tells us how many lines it *dropped* per side, not how many it kept.
 * Reporting the larger side is the honest single number: a 300-line rewrite
 * elides ~300 on both, and summing would claim 600.
 */
export function droppedLines(elided: { oldLines: number; newLines: number }): number {
  return Math.max(elided.oldLines, elided.newLines)
}

function summaryFor(preview: Extract<FileToolPreview, { kind: 'diff' }>): string {
  return preview.elided
    ? `${preview.summary}（省略 ${droppedLines(preview.elided)} 行）`
    : preview.summary
}

function elidedRow(count: number): DiffRow {
  // Words, not glyphs: §3 replaces the `…` this used to start with — the rule is
  // the indicator now, and the count is what it is worth saying out loud.
  return { kind: 'elided', text: `省略 ${count} 行` }
}

/**
 * Line rows with a bounded window of context around each change.
 *
 * Exported for the test to drive directly; `previewView` is what a view calls.
 */
export function diffRowsFor(
  oldText: string,
  newText: string,
  contextLines: number = DIFF_CONTEXT_LINES,
): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 1
  let newLine = 1

  // Each part is a run of lines that was added, removed, or left alone.
  const parts = diffLines(oldText, newText).map((part) => ({
    added: part.added === true,
    removed: part.removed === true,
    lines: splitLines(part.value),
  }))

  parts.forEach((part, index) => {
    if (part.added) {
      for (const text of part.lines) {
        rows.push({ kind: 'add', text, newLine })
        newLine += 1
      }
      return
    }
    if (part.removed) {
      for (const text of part.lines) {
        rows.push({ kind: 'del', text, oldLine })
        oldLine += 1
      }
      return
    }

    // Unchanged: keep the tail of the run before a change and the head of the
    // run after one, and collapse whatever is left in the middle.
    const isFirst = index === 0
    const isLast = index === parts.length - 1
    const head = isFirst ? 0 : contextLines
    const tail = isLast ? 0 : contextLines

    if (part.lines.length <= head + tail) {
      for (const text of part.lines) {
        rows.push({ kind: 'ctx', text, oldLine, newLine })
        oldLine += 1
        newLine += 1
      }
      return
    }

    part.lines.forEach((text, lineIndex) => {
      const inHead = lineIndex < head
      const inTail = lineIndex >= part.lines.length - tail
      if (inHead || inTail) {
        rows.push({ kind: 'ctx', text, oldLine, newLine })
      } else if (lineIndex === head) {
        rows.push(elidedRow(part.lines.length - head - tail))
      }
      oldLine += 1
      newLine += 1
    })
  })

  return rows
}

/**
 * `diffLines` keeps the newline on each line, so the final split produces a
 * trailing empty entry for text that ends in one. Dropping it is what stops
 * every diff ending in a phantom blank row.
 */
function splitLines(value: string): string[] {
  const lines = value.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * Digits in the widest line number, so both columns line up on every row of a
 * diff. A fixed 3 pushed the text right by one column on each row past line 999
 * and left the rest where they were.
 */
export function gutterWidth(rows: readonly DiffRow[]): number {
  let widest = 1
  for (const row of rows) {
    if (row.kind === 'elided') continue
    widest = Math.max(widest, String(row.oldLine ?? '').length, String(row.newLine ?? '').length)
  }
  return widest
}
