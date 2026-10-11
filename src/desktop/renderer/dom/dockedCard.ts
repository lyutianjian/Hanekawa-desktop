import { PRESENCE_FALLBACK_MS } from '../model/presence.js'
import { replace } from './dom.js'
import { motionPolicy } from './motion.js'
import { createPresence } from './presence.js'

/**
 * The composer-docked card shell: a blocking request drawn **into the composer**
 * instead of over the lane.
 *
 * The capsule the user's hand is already on keeps its frame and width while its
 * height follows the card. The textarea and action bar stay mounted, with
 * `.request-open` controlling availability; closing restores them immediately
 * while the inert card finishes its visual exit, so nothing typed into the
 * restored input is consumed. One dock serves every card kind — permission,
 * question — because only one blocking request is ever on screen.
 */
export interface DockedCard {
  /**
   * Runs `fill` against the container, then opens (or keeps open) the card.
   * Returns whether focus should move into it: on first open, or when it
   * already sat inside the card being replaced.
   */
  show(fill: () => void): boolean
  hide(immediate?: boolean): void
  finishMotion(): void
}

export function createDockedCard(
  /** `#composer`; it carries `.request-open` while a card is on screen. */
  composer: HTMLElement,
  /** `#composer-request`, the card's own container inside the capsule. */
  container: HTMLElement,
  actions: { onLayoutChange?: () => void; onReturnFocus?: () => void } = {},
): DockedCard {
  container.setAttribute('role', 'group')
  const presence = createPresence(container, { kind: 'panel', direction: 'none', onClosed: () => replace(container) })
  let open = false
  let heightTimer: ReturnType<typeof setTimeout> | undefined

  const finishHeight = (): void => {
    clearTimeout(heightTimer)
    heightTimer = undefined
    composer.style.height = ''
    composer.classList.remove('request-changing', 'request-measuring')
  }
  composer.addEventListener('transitionend', (event) => {
    if (event.target === composer && event.propertyName === 'height') finishHeight()
  })
  const beginHeight = (): void => {
    actions.onLayoutChange?.()
    clearTimeout(heightTimer)
    if (!motionPolicy().animate) { finishHeight(); return }
    const height = composer.getBoundingClientRect().height
    if (!Number.isFinite(height) || height <= 0) return
    // Freeze without starting auto → px: otherwise px → auto in this same
    // paint is a zero-progress reversal and Chromium shortens it to nothing.
    composer.classList.add('request-measuring')
    composer.style.height = `${height}px`
    composer.classList.add('request-changing')
    composer.getBoundingClientRect()
    composer.classList.remove('request-measuring')
  }
  const endHeight = (): void => {
    if (!motionPolicy().animate) { finishHeight(); return }
    composer.style.height = 'auto'
    heightTimer = setTimeout(finishHeight, PRESENCE_FALLBACK_MS.layout)
    ;(heightTimer as unknown as { unref?: () => void }).unref?.()
  }

  return {
    finishMotion() { presence.finish(); finishHeight() },

    show(fill) {
      const focusWanted = !open || container.contains(document.activeElement)
      beginHeight()
      open = true
      container.classList.remove('tone-normal', 'tone-caution', 'tone-danger')
      fill()
      composer.classList.add('request-open')
      presence.set(true)
      endHeight()
      return focusWanted
    },

    hide(immediate = false) {
      if (!open) {
        if (immediate) { presence.set(false, true); finishHeight() }
        return
      }
      if (!immediate) beginHeight()
      open = false
      composer.classList.remove('request-open')
      // The bridge reply has already happened. The old card is now absolute
      // and inert; the textarea is immediately available even during exit.
      presence.set(false, immediate)
      if (immediate) finishHeight()
      else { endHeight(); actions.onReturnFocus?.() }
    },
  }
}
