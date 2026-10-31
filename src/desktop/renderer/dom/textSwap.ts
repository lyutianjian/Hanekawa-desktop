import { el } from './dom.js'
import { motionPolicy } from './motion.js'

export const TEXT_SWAP_MS = 200
export const TEXT_SWAP_EASING = 'ease-out'
const RESIZE_MS = 140

export interface TextSwap {
  set(text: string, fromWidth?: number): void
  finish(): void
}

/** Replace the whole label; only its following siblings glide to their new positions. */
export function createTextSwap(host: HTMLElement, className: string): TextSwap {
  host.classList.add('text-swap')
  let current: HTMLElement | undefined
  let leaving: HTMLElement | undefined
  let animations: Animation[] = []

  function finish(): void {
    for (const animation of animations) animation.cancel()
    animations = []
    leaving?.remove()
    leaving = undefined
  }

  return {
    finish,
    set(text, fromWidth) {
      if (!motionPolicy().animate) finish()
      if (current?.textContent === text && host.contains(current)) return
      const width = host.getBoundingClientRect().width
      const siblings = Array.from(host.parentElement?.children ?? [])
      const following = siblings.slice(siblings.indexOf(host) + 1) as HTMLElement[]
      const offset = fromWidth === undefined ? 0 : fromWidth - width
      const positions = following.map((node) => node.getBoundingClientRect().left + offset)
      finish()
      const replacing = current !== undefined || fromWidth !== undefined
      const previous = current && host.contains(current) ? current : undefined
      current = el('span', className, text)
      host.replaceChildren(current)
      if (!replacing || !motionPolicy().animate || typeof host.animate !== 'function') return
      const options = { duration: TEXT_SWAP_MS, easing: TEXT_SWAP_EASING }
      const next = [current.animate([{ opacity: 0 }, { opacity: 1 }], options)]
      if (previous) {
        leaving = previous
        leaving.classList.add('text-swap-leaving')
        leaving.setAttribute('aria-hidden', 'true')
        host.appendChild(leaving)
        next.push(leaving.animate([
          { opacity: 1, width: `${width}px` },
          { opacity: 0, width: `${width}px` },
        ], options))
      }
      for (const [index, node] of following.entries()) {
        const distance = positions[index]! - node.getBoundingClientRect().left
        if (Number.isFinite(distance) && Math.abs(distance) > 0.5) {
          next.push(node.animate([{ translate: `${distance}px 0` }, { translate: '0px 0' }], {
            duration: RESIZE_MS, easing: TEXT_SWAP_EASING,
          }))
        }
      }
      animations = next
      Promise.all(next.map((animation) => animation.finished)).then(() => { if (animations === next) finish() }, () => {})
    },
  }
}

export interface WidthTween {
  update(change: () => void): void
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
  let target: number | undefined

  function finish(): void {
    animation?.cancel()
    animation = undefined
    target = undefined
  }

  return {
    finish,
    update(change) {
      const from = host.getBoundingClientRect().width
      change()
      const to = content.getBoundingClientRect().width
      if (motionPolicy().animate && animation && target === to) return
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= 0 || Math.abs(from - to) < 0.5
        || !motionPolicy().animate || typeof host.animate !== 'function') {
        finish()
        return
      }
      finish()
      const next = host.animate([{ width: `${from}px` }, { width: `${to}px` }], {
        duration: RESIZE_MS, easing: TEXT_SWAP_EASING,
      })
      animation = next
      target = to
      next.finished.then(() => {
        if (animation === next) finish()
      }, () => {})
    },
  }
}
