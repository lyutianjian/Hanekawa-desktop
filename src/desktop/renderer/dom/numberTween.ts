import { motionPolicy } from './motion.js'

export const NUMBER_TWEEN_MS = 400

export interface NumberTween {
  set(value: number): void
  finish(): void
}

/** Retarget from the displayed integer, without replaying an interrupted segment. */
export function createNumberTween(paint: (value: number) => void): NumberTween {
  let shown: number | undefined
  let target: number | undefined
  let frame: number | undefined

  function write(value: number): void {
    if (shown === value) return
    shown = value
    paint(value)
  }

  function cancel(): void {
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
  }

  function finish(): void {
    cancel()
    if (target !== undefined) write(target)
  }

  return {
    finish,
    set(value) {
      if (!motionPolicy().animate) finish()
      if (target === value) return
      cancel()
      target = value
      const from = shown
      if (from === undefined || from === 0 || Math.abs(value - from) > Math.abs(from) * 0.5
        || !motionPolicy().animate || typeof requestAnimationFrame !== 'function' || typeof cancelAnimationFrame !== 'function') {
        finish()
        return
      }
      if (from === value) return
      const startedAt = performance.now()
      const tick = (now: number): void => {
        frame = undefined
        if (!motionPolicy().animate) {
          finish()
          return
        }
        const progress = Math.min(1, Math.max(0, (now - startedAt) / NUMBER_TWEEN_MS))
        write(Math.round(from + (value - from) * (1 - (1 - progress) ** 3)))
        if (progress < 1) frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
    },
  }
}
