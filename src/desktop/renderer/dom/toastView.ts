import { dismissToast, emptyToasts, pushToast, TOAST_LIFETIME_MS, type Toast, type ToastLevel } from '../model/toasts.js'
import { button } from './controls.js'
import { el } from './dom.js'
import { icon } from './icons.js'
import { createPresence, type Presence } from './presence.js'

/**
 * The window's toast stack.
 *
 * One host per window, a child of `#canvas`: the browser panel is a native view
 * beside the canvas, so nothing drawn here can end up under it. Each toast is
 * its own presence — it arrives and leaves continuously, and a dismissal
 * (button, Escape on a focused toast, or the clock) settles at once whatever
 * the animation is doing.
 *
 * The clock stops while the pointer or focus is inside a toast, so a message
 * being read or aimed at does not vanish under the reader.
 */

export interface ToastHost {
  push(level: ToastLevel, text: string): void
  dispose(): void
}

interface Entry {
  readonly node: HTMLElement
  readonly presence: Presence
  readonly textNode: HTMLElement
  readonly repeatsNode: HTMLElement
  toast: Toast
  timer: ReturnType<typeof setTimeout> | undefined
  startedAt: number
  remaining: number
  pointerInside: boolean
  focusInside: boolean
}

export function createToastHost(container: HTMLElement): ToastHost {
  let state = emptyToasts()
  const entries = new Map<number, Entry>()

  function dismiss(id: number): void {
    state = dismissToast(state, id)
    sync()
  }

  function arm(entry: Entry, ms: number): void {
    clearTimeout(entry.timer)
    entry.remaining = ms
    entry.startedAt = Date.now()
    entry.timer = setTimeout(() => dismiss(entry.toast.id), ms)
  }

  function hold(entry: Entry): void {
    if (entry.timer === undefined) return
    clearTimeout(entry.timer)
    entry.timer = undefined
    entry.remaining = Math.max(0, entry.remaining - (Date.now() - entry.startedAt))
  }

  function release(entry: Entry): void {
    if (entry.pointerInside || entry.focusInside || entry.timer !== undefined) return
    arm(entry, entry.remaining)
  }

  function create(toast: Toast): Entry {
    const textNode = el('span', 'toast-text', toast.text)
    const repeatsNode = el('span', 'toast-repeats')
    const close = button('toast-close', '', '关闭', () => dismiss(toast.id), { icon: 'close' })
    const node = el('div', `toast ${toast.level}`, textNode, repeatsNode, close)
    node.setAttribute('role', toast.level === 'error' ? 'alert' : 'status')
    const presence = createPresence(node, { direction: 'drop', onClosed: () => node.remove() })
    const entry: Entry = {
      node, presence, textNode, repeatsNode, toast,
      timer: undefined, startedAt: 0, remaining: TOAST_LIFETIME_MS[toast.level],
      pointerInside: false, focusInside: false,
    }
    node.addEventListener('pointerenter', () => { entry.pointerInside = true; hold(entry) })
    node.addEventListener('pointerleave', () => { entry.pointerInside = false; release(entry) })
    node.addEventListener('focusin', () => { entry.focusInside = true; hold(entry) })
    node.addEventListener('focusout', (event) => {
      // Focus moving between the toast's own controls is still inside it.
      if (event.relatedTarget !== null && node.contains(event.relatedTarget as Node)) return
      entry.focusInside = false
      release(entry)
    })
    node.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return
      // The key closes the toast it is on; it must not also stop the turn behind it.
      event.stopPropagation()
      dismiss(entry.toast.id)
    })
    container.appendChild(node)
    return entry
  }

  function sync(): void {
    const live = new Set(state.toasts.map((toast) => toast.id))
    for (const [id, entry] of entries) {
      if (live.has(id)) continue
      entries.delete(id)
      clearTimeout(entry.timer)
      entry.timer = undefined
      entry.presence.set(false)
    }
    for (const toast of state.toasts) {
      let entry = entries.get(toast.id)
      if (entry === undefined) {
        entry = create(toast)
        entries.set(toast.id, entry)
        entry.presence.set(true)
        arm(entry, TOAST_LIFETIME_MS[toast.level])
        continue
      }
      if (toast.repeats !== entry.toast.repeats) {
        entry.repeatsNode.textContent = `×${toast.repeats}`
        // The message came again: it is news again, so its clock starts over.
        if (!entry.pointerInside && !entry.focusInside) arm(entry, TOAST_LIFETIME_MS[toast.level])
        else entry.remaining = TOAST_LIFETIME_MS[toast.level]
      }
      entry.toast = toast
    }
  }

  return {
    push(level, text) {
      state = pushToast(state, level, text)
      sync()
    },
    dispose() {
      state = emptyToasts()
      for (const entry of entries.values()) {
        clearTimeout(entry.timer)
        entry.presence.dispose()
        entry.node.remove()
      }
      entries.clear()
    },
  }
}
