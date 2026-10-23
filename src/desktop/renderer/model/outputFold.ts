/**
 * How much of a tool's output the transcript draws before 「显示全部 N 行」.
 *
 * The block already scrolls inside a fixed height, so this is not about space:
 * a 50 000-line build log was laid out in full the moment its row opened, and
 * held the frame while it did. Two hundred lines is more than the block shows
 * without scrolling and far less than the layout cost that mattered.
 */
export const OUTPUT_FOLD_LINES = 200

/** The first `limit` lines and the total, or `undefined` when nothing is held back. */
export function foldOutput(text: string, limit = OUTPUT_FOLD_LINES): { readonly head: string; readonly total: number } | undefined {
  const lines = text.split('\n')
  // A trailing newline is not a line of its own to the reader.
  const total = lines.at(-1) === '' ? lines.length - 1 : lines.length
  if (total <= limit) return undefined
  return { head: lines.slice(0, limit).join('\n'), total }
}
