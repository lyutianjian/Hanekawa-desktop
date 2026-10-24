import type { OverlayAction } from '../model/dialogActions.js'
import type { PermissionViewModel } from '../model/permissionDialog.js'
import { previewNode } from './diffView.js'
import { el, replace } from './dom.js'
import { icon, type IconName } from './icons.js'
import { actionBar } from './actionBar.js'
import type { DockedCard } from './dockedCard.js'

/**
 * The permission request, drawn into the docked card (`dockedCard.ts`) rather
 * than over the lane: one sentence and two buttons that arrive many times a
 * turn, where a scrim would be the interruption the user is being asked about.
 *
 * What it draws comes from the same {@link PermissionViewModel} the modal used,
 * and the button bar is literally `actionBar.ts`'s `actionBar`. The keyboard
 * path goes through `hasOverlay` → `'overlay'` in `model/keymap.ts`.
 */
export interface PermissionRequestView {
  show(view: PermissionViewModel): void
  hide(immediate?: boolean): void
  finishMotion(): void
  /**
   * Put the caret on the card's chosen button now that it is on screen again —
   * `paneSession.ts` calls this when the layer that covered it has closed.
   *
   * A repaint cannot do it: `dock.show` only moves focus into a card it is
   * *opening*, and this one has been open, covering the composer, all along.
   */
  focus(): void
}

/** What the card reports when a button is pressed; the modal's shape. */
export type PermissionRequestSelect = (action: OverlayAction) => void

/**
 * The glyph beside the title, by what is being asked for.
 *
 * Read off the *input block*, not off a tool name: the block is already the
 * projection that knows a `Bash` request carries a command and a file tool
 * carries a path (`runtime/permissionPresentation.ts`), and matching tool names
 * here would be a second copy of that list to keep in step.
 */
export function permissionGlyphFor(kind: PermissionViewModel['inputBlock']['kind']): IconName {
  if (kind === 'bash') return 'terminal'
  if (kind === 'file') return 'file'
  return 'shield'
}

export function createPermissionRequestView(
  dock: DockedCard,
  /** `#composer-request`, the card's own container inside the capsule. */
  container: HTMLElement,
  onSelect: PermissionRequestSelect,
  /**
   * Whether the card is on screen right now (`model/overlayVisibility.ts`).
   *
   * A request can arrive while the settings screen, the projects page or the
   * image viewer covers the composer. The card is still painted — that paint is
   * what the next repaint shows — but it must not take the caret out of the
   * layer in front, mid-typing.
   */
  onScreen: () => boolean = () => true,
): PermissionRequestView {
  /** The painted bar, and the button that answers the request, for `focus()`. */
  let target: { readonly bar: HTMLElement; readonly index: number } | undefined

  function focusTarget(): void {
    if (!target || !onScreen()) return
    ;(target.bar.children[target.index] as HTMLButtonElement | undefined)?.focus()
  }

  return {
    finishMotion: () => dock.finishMotion(),
    hide: (immediate) => {
      target = undefined
      dock.hide(immediate)
    },
    focus: focusTarget,

    show(view) {
      const bar = actionBar(view.actions, onSelect, view.selectedIndex)
      target = { bar, index: Math.max(0, view.actions.findIndex((action) => action.slot === view.selectedIndex)) }
      const focusAction = dock.show(() => {
        // The tone lands on the card rather than on the capsule: the composer's
        // border is a focus affordance, and recolouring it would say "this field
        // is wrong" instead of "this request is dangerous".
        container.classList.add(`tone-${view.tone}`)
        replace(
          container,
          el(
            'div',
            'request-head',
            icon(permissionGlyphFor(view.inputBlock.kind)),
            el('span', 'request-title', view.title),
            el('span', 'request-subtitle', view.subtitle),
          ),
          el('div', 'request-question', view.reason),
          view.denialStreakNote !== undefined && el('div', 'request-streak', view.denialStreakNote),
          ...view.warnings.map((warning) => el('div', 'request-warning', warning.message)),
          view.inputBlock.kind === 'bash' && view.inputBlock.description !== undefined
            && el('div', 'request-description', view.inputBlock.description),
          view.inputBlock.kind !== 'none' && el('div', 'request-block', view.inputBlock.content),
          view.preview !== undefined && previewNode(view.preview),
          view.alsoWaiting.length > 0
            && el('div', 'request-waiting', `还在等待：${view.alsoWaiting.join('、')}`),
          bar,
        )
        container.setAttribute('aria-label', `${view.title}：${view.reason}`)
      })
      if (focusAction) focusTarget()
    },
  }
}
