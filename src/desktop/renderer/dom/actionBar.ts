import type { DialogAction, OverlayAction } from '../model/dialogActions.js'
import { button } from './controls.js'
import { el } from './dom.js'

/**
 * The button bar a dialog ends with.
 *
 * Built through `controls.ts`'s `button()` for the same reasons everything else
 * is: the click handler stops propagation, the title doubles as the accessible
 * name, and `rendererStyleTokens.test.ts`'s scan of `button('…')` call sites is
 * what guarantees the class has a resting-state rule rather than falling back to
 * the user agent's grey box.
 *
 * `selectedIndex` marks the keyboard cursor on a bar whose buttons are slots —
 * it is the safe default Enter is about to hit, and on a destructive permission
 * request that default is *deny*, so it has to be visible.
 */
export function actionBar(
  actions: readonly DialogAction[],
  onSelect: (action: OverlayAction) => void,
  selectedIndex?: number,
): HTMLElement {
  const bar = el('div', 'dialog-actions')
  for (const action of actions) {
    const focused = action.slot !== undefined && action.slot === selectedIndex
    const classes = [
      'dialog-btn',
      action.role,
      ...(action.tone === 'danger' ? ['danger'] : []),
      ...(focused ? ['selected'] : []),
    ].join(' ')
    const node = button(classes, action.label, action.label, () => {
      onSelect(action.slot === undefined ? { kind: action.role } : { kind: 'slot', index: action.slot })
    })
    if (action.shortcut) node.appendChild(el('span', 'kbd', action.shortcut))
    bar.appendChild(node)
  }
  return bar
}
