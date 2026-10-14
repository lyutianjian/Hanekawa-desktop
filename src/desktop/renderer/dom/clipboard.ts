/**
 * Writes to the clipboard. `false` when there is none or it refuses (the window
 * lacks focus, or permission): a copy button must say so rather than look done.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
