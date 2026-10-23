/**
 * The window's toast stack: short messages for outcomes that have no place of
 * their own on screen. Pure; `dom/toastView.ts` owns the nodes and the timers.
 */

export type ToastLevel = 'error' | 'info'

export interface Toast {
  readonly id: number
  readonly level: ToastLevel
  readonly text: string
  /** How many times the same message arrived while this one was up. */
  readonly repeats: number
  /** One button beside the text, such as 重试; pressing it also dismisses the toast. */
  readonly action?: ToastAction
}

export interface ToastAction {
  readonly label: string
  readonly run: () => void
}

export interface ToastState {
  readonly toasts: readonly Toast[]
  readonly nextId: number
}

/** More than this and the oldest makes room: a burst must not bury the window. */
export const MAX_TOASTS = 3

/** An error stays longer than a note: it is the one a reader may still be catching up with. */
export const TOAST_LIFETIME_MS: Readonly<Record<ToastLevel, number>> = { info: 4000, error: 9000 }

export function emptyToasts(): ToastState {
  return { toasts: [], nextId: 1 }
}

/** The same message again counts up on the toast already showing rather than stacking a twin. */
export function pushToast(state: ToastState, level: ToastLevel, text: string, action?: ToastAction): ToastState {
  const twin = state.toasts.find((toast) => toast.level === level && toast.text === text)
  if (twin) {
    // The latest action wins: it is the one bound to the attempt that just failed.
    return {
      ...state,
      toasts: state.toasts.map((toast) => (toast === twin ? { ...toast, repeats: toast.repeats + 1, ...(action ? { action } : {}) } : toast)),
    }
  }
  const toast: Toast = { id: state.nextId, level, text, repeats: 1, ...(action ? { action } : {}) }
  const toasts = [...state.toasts, toast]
  return { toasts: toasts.slice(-MAX_TOASTS), nextId: state.nextId + 1 }
}

export function dismissToast(state: ToastState, id: number): ToastState {
  return state.toasts.some((toast) => toast.id === id)
    ? { ...state, toasts: state.toasts.filter((toast) => toast.id !== id) }
    : state
}
