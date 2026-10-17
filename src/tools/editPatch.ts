import { createTwoFilesPatch } from 'diff'

/**
 * The unified patch every editing tool ships in `metadata.display.detail`.
 *
 * The transcript cannot rebuild a diff from a tool result on its own: the
 * permission request's `preview` is the only other place the two sides of an
 * edit exist, and in `auto` / `bypass` mode there is no permission
 * request at all. So the tools emit the patch themselves, in one shared format,
 * at the moment they still hold both texts.
 *
 * The text is standard unified diff (`--- a/…` / `+++ b/…` / `@@` hunks) with
 * one deliberate deviation: when the patch is capped it ends with a bare
 * elision line (see `ELISION_PREFIX`) that carries no diff prefix, so a reader
 * that only knows `+`/`-`/` `/`@@` can tell it apart from real content. The
 * line also carries the whole patch's added/deleted counts, which a reader
 * could not recover from the kept rows alone.
 */

export interface UnifiedPatchLimits {
  /** Hard ceiling on emitted lines, including the two header lines. */
  maxLines: number
  /** Hard ceiling on emitted characters. */
  maxChars: number
}

/**
 * Bounds what a patch costs to persist: `display.detail` is written into the
 * session's append-only JSONL and shipped over the wire on every replay, so a
 * whole-file rewrite must not carry the whole file twice.
 */
export const PATCH_LIMITS: UnifiedPatchLimits = {
  maxLines: 400,
  maxChars: 32_000,
}

export const PATCH_CONTEXT_LINES = 3

const ELISION_PREFIX = '… '

/**
 * A unified patch for one file, or `undefined` when there is nothing to show
 * (identical texts). Callers put the result straight into `display.detail`.
 */
export function buildUnifiedPatch(
  filePath: string,
  oldText: string,
  newText: string,
  limits: UnifiedPatchLimits = PATCH_LIMITS,
): string | undefined {
  if (oldText === newText) return undefined

  const label = patchLabel(filePath)
  const raw = createTwoFilesPatch(
    `a/${label}`,
    `b/${label}`,
    oldText,
    newText,
    undefined,
    undefined,
    { context: PATCH_CONTEXT_LINES },
  )

  const lines = raw.split('\n')
  // `createTwoFilesPatch` opens with an index separator rule that carries no
  // information once the two file headers are right below it.
  while (lines.length > 0 && lines[0]!.startsWith('===')) lines.shift()
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  if (lines.length <= 2) return undefined

  return capPatchLines(lines, limits)
}

/**
 * Spread into a `display` object: contributes `detail` only when there is a
 * patch, so a no-op edit does not ship an empty field into the record.
 */
export function patchDetail(
  filePath: string,
  oldText: string,
  newText: string,
): { detail?: string } {
  const detail = buildUnifiedPatch(filePath, oldText, newText)
  return detail ? { detail } : {}
}

/** Forward slashes so a Windows path and a POSIX one read the same in a diff. */
function patchLabel(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

function capPatchLines(lines: string[], limits: UnifiedPatchLimits): string {
  const whole = lines.join('\n')
  if (lines.length <= limits.maxLines && whole.length <= limits.maxChars) {
    return whole
  }

  // Header lines are never counted out: a patch without them is not a patch.
  const kept: string[] = lines.slice(0, 2)
  let chars = kept.join('\n').length
  let index = 2
  for (; index < lines.length; index++) {
    const line = lines[index]!
    const next = chars + line.length + 1
    if (kept.length >= limits.maxLines || next > limits.maxChars) break
    kept.push(line)
    chars = next
  }

  // Prefer cutting on a hunk boundary — half a hunk is a lie about its own
  // line numbers. Unless the cut already landed on one, or the first hunk alone
  // blew the budget, in which case a truncated hunk still beats an empty patch.
  const cutOnBoundary = index >= lines.length || lines[index]!.startsWith('@@')
  if (!cutOnBoundary) {
    const lastHunk = findLastHunkStart(kept)
    if (lastHunk > 2) kept.length = lastHunk
  }

  const dropped = lines.length - kept.length
  const body = lines.slice(2)
  const added = body.filter((line) => line.startsWith('+')).length
  const deleted = body.filter((line) => line.startsWith('-')).length
  kept.push(`${ELISION_PREFIX}${dropped} more line${dropped === 1 ? '' : 's'} not shown (+${added} -${deleted})`)
  return kept.join('\n')
}

function findLastHunkStart(lines: string[]): number {
  for (let i = lines.length - 1; i >= 2; i--) {
    if (lines[i]!.startsWith('@@')) return i
  }
  return -1
}
