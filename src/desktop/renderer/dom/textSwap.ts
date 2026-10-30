import { el } from './dom.js'
import { motionPolicy } from './motion.js'

export const TEXT_SWAP_MS = 420
export const TEXT_SWAP_EASING = 'cubic-bezier(.22,1,.36,1)'

export interface TextSwap {
  set(text: string): void
  finish(): void
}

/** One readable face in flow, with the departing face overlaid only during a swap. */
export function createTextSwap(host: HTMLElement, className: string): TextSwap {
  host.classList.add('text-swap')
  let current: HTMLElement | undefined
  let active: { leaving: HTMLElement; animations: Animation[] } | undefined

  function finish(): void {
    const swap = active
    active = undefined
    if (!swap) return
    for (const animation of swap.animations) animation.cancel()
    swap.leaving.remove()
  }

  return {
    finish,
    set(text) {
      if (!motionPolicy().animate) finish()
      if (current?.textContent === text) return
      const leaving = current
      const animate = leaving !== undefined && motionPolicy().animate && typeof host.animate === 'function'
      // Read the presented width before cancelling an interrupted transition.
      const from = animate ? host.getBoundingClientRect().width : 0
      finish()
      current = el('span', className, text)
      host.replaceChildren(current)
      if (!animate) return
      const to = host.getBoundingClientRect().width
      if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0) return

      leaving.classList.add('text-swap-leaving')
      leaving.setAttribute('aria-hidden', 'true')
      host.appendChild(leaving)
      const options = { duration: TEXT_SWAP_MS, easing: TEXT_SWAP_EASING, fill: 'both' as const }
      const swap = {
        leaving,
        animations: [
          leaving.animate([{ opacity: 1, transform: 'translateY(0)' }, { opacity: 0, transform: 'translateY(-3px)' }], options),
          current.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'translateY(0)' }], options),
          host.animate([{ width: `${from}px` }, { width: `${to}px` }], options),
        ],
      }
      active = swap
      Promise.all(swap.animations.map((animation) => animation.finished)).then(() => {
        if (active === swap) finish()
      }, () => {})
    },
  }
}

export interface WidthTween {
  update(): void
  finish(): void
}

/**
 * The content keeps its natural width; its seat glides between the widths it
 * has held. No final inline width is written: cancelling the animation leaves the
 * seat on the content's own width, so a digit added mid-glide can retarget from
 * the width actually on screen.
 */
export function createWidthTween(host: HTMLElement, content: HTMLElement): WidthTween {
  let animation: Animation | undefined

  function finish(): void {
    animation?.cancel()
    animation = undefined
  }

  return {
    finish,
    update() {
      const from = host.getBoundingClientRect().width
      const to = content.getBoundingClientRect().width
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0 || Math.abs(from - to) < 0.5
        || !motionPolicy().animate || typeof host.animate !== 'function') {
        finish()
        return
      }
      finish()
      const next = host.animate([{ width: `${from}px` }, { width: `${to}px` }], {
        duration: TEXT_SWAP_MS, easing: TEXT_SWAP_EASING,
      })
      animation = next
      next.finished.then(() => {
        if (animation === next) finish()
      }, () => {})
    },
  }
}
