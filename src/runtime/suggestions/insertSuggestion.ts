/** Inserts a completed token and places the caret after its separating space. */
export function insertSuggestion(
  input: string,
  start: number,
  end: number,
  replacement: string,
  trailingSpace = true,
): { text: string; cursorPos: number } {
  const insertion = trailingSpace ? `${replacement} ` : replacement
  const after = input.slice(end)
  const suffix = trailingSpace && after.startsWith(' ') ? after.slice(1) : after
  return {
    text: input.slice(0, start) + insertion + suffix,
    cursorPos: start + insertion.length,
  }
}
