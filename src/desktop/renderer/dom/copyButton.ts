import { button } from './controls.js'
import { icon } from './icons.js'

/**
 * The one copy button: the glyph turns into a tick named 已复制 for a moment,
 * or into a cross named 复制失败 when nothing reached the clipboard, then goes
 * back to what it was.
 *
 * There used to be two. The code block's showed a cross on failure and reset
 * after 1.2s; the message row's said nothing on failure, kept its tick for 5s
 * (long enough to read as a state rather than an answer) and only changed its
 * `title`, so a screen reader heard the old name. Both receipts now change the
 * accessible name too, and both last as long as a glance.
 *
 * `write` performs the copy and says whether it happened. It's passed in, not
 * built here, because the transcript routes through its pane's `onCopy`.
 */
export function copyButton(className: string, label: string, write: () => Promise<boolean>): HTMLButtonElement {
  let reset: ReturnType<typeof setTimeout> | undefined
  const name = (text: string): void => {
    node.setAttribute('aria-label', text)
    node.title = text
  }
  const node = button(className, '', label, () => {
    void write().then((ok) => {
      node.replaceChildren(icon(ok ? 'check' : 'close'))
      name(ok ? '已复制' : '复制失败')
      node.classList.toggle('failed', !ok)
      clearTimeout(reset)
      reset = setTimeout(() => {
        node.replaceChildren(icon('copy'))
        name(label)
        node.classList.remove('failed')
      }, COPY_RECEIPT_MS)
    })
  }, { icon: 'copy' })
  return node
}

/** How long the tick or cross stays: one glance, not a state to read. */
export const COPY_RECEIPT_MS = 1200
