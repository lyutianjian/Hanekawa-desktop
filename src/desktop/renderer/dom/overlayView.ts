import type { DialogAction, OverlayAction } from '../model/dialogActions.js'
import type { EnterPlanViewModel, ExitPlanViewModel } from '../model/planDialogs.js'
import type { PermissionViewModel } from '../model/permissionDialog.js'
import { button } from './controls.js'
import { previewNode } from './diffView.js'
import { el, replace } from './dom.js'
import { createModalPresence } from './presence.js'
import { markdownNode } from './markdownView.js'

/**
 * The modal blocking requests, drawn into one panel.
 *
 * Every decision — which options exist, which is focused, what the tone is —
 * arrives already made in the view model. This file only turns that into nodes,
 * which is what keeps the interesting parts testable without a DOM.
 *
 * Two shapes, decided in `model/`: an option that *is* an action (allow, deny,
 * enter plan mode) is drawn as a button in the bar at the bottom, and an option
 * that is content (a plan decision that grows a feedback field) stays a row above it. Both hand back an `OverlayAction`, which
 * each dialog's model turns into the same intent its key produces.
 *
 * The backdrop is deliberately **not** clickable: every one of these
 * requests is holding the agent loop, so there is no dismissing them — see
 * `paneSession.ts`'s `enqueue`.
 */
export interface OverlayView {
  permission(view: PermissionViewModel): void
  enterPlan(view: EnterPlanViewModel): void
  exitPlan(view: ExitPlanViewModel): void
  hide(): void
}

/** What the panel reports when something is picked. */
export type OverlaySelect = (action: OverlayAction) => void

export function createOverlayView(
  container: HTMLElement,
  panel: HTMLElement,
  onSelect: OverlaySelect,
): OverlayView {
  const presence = createModalPresence(container, panel, () => replace(panel))
  const optionList = (rows: OptionRow[]) => optionListNode(rows, onSelect)
  const actions = (list: readonly DialogAction[], selectedIndex?: number) =>
    actionBar(list, onSelect, selectedIndex)
  const open = (tone: 'danger' | 'caution' | 'normal', ...children: Array<Node | string | false>) => {
    panel.classList.remove('tone-danger', 'tone-caution', 'tone-normal')
    panel.classList.add(`tone-${tone}`)
    replace(panel, ...children)
    presence.set(true)
  }

  return {
    permission(view) {
      open(
        view.tone,
        el('div', 'title', view.title),
        el('div', 'subtitle', view.subtitle),
        el('div', 'reason', view.reason),
        view.denialStreakNote !== undefined && el('div', 'streak', view.denialStreakNote),
        ...view.warnings.map((warning) => el('div', 'warning', `- ${warning.message}`)),
        view.inputBlock.kind !== 'none' && el(
          'div',
          undefined,
          el('div', 'block-label', view.inputBlock.label),
          el('div', 'block', view.inputBlock.content),
        ),
        view.preview !== undefined && previewNode(view.preview),
        view.alsoWaiting.length > 0
          && el('div', 'also-waiting', `还在等待：${view.alsoWaiting.join('、')}`),
        actions(view.actions, view.selectedIndex),
      )
    },

    enterPlan(view) {
      open(
        'caution',
        el('div', 'title', view.title),
        el('div', 'reason', view.body),
        el('div', 'bullets', view.bullets.map((bullet) => ` · ${bullet}`).join('\n')),
        el('div', 'subtitle', view.reassurance),
        actions(view.actions, view.selectedIndex),
      )
    },

    exitPlan(view) {
      open(
        'caution',
        el('div', 'title', view.title),
        // The plan is markdown the model just wrote; the permission dialog's
        // `.block` and diff below stay literal, because those are the exact
        // command and the exact bytes the user is being asked to approve.
        markdownNode(view.planPreview, 'plan md'),
        el('div', 'subtitle', view.planFilePath),
        optionList(view.options.map((option, index) => ({
          label: option.label,
          hotkey: String(index + 1),
          selected: index === view.selectedIndex,
          // The reject slot grows a feedback field once it is focused.
          extra: option.kind === 'reject'
            ? el('div', `feedback${view.feedbackFocused ? ' focused' : ''}`, view.feedback)
            : undefined,
        }))),
        actions(view.actions),
      )
    },

    hide() {
      // The request queue and bridge have already settled in the caller.
      // Closing is a non-interactive visual, never a blocking request.
      presence.set(false)
    },
  }
}

interface OptionRow {
  label: string
  selected: boolean
  hotkey?: string
  extra?: HTMLElement | undefined
}

function optionListNode(rows: OptionRow[], onSelect: OverlaySelect): HTMLElement {
  const list = el('div', 'options')
  list.setAttribute('role', 'listbox')
  rows.forEach((row, index) => {
    const line = el('div', `option${row.selected ? ' selected' : ''}`)
    line.setAttribute('role', 'option')
    line.setAttribute('aria-selected', String(row.selected))
    line.appendChild(el('span', 'option-label', row.label))
    if (row.hotkey) line.appendChild(el('span', 'kbd', row.hotkey))
    line.addEventListener('click', () => onSelect({ kind: 'slot', index }))
    list.appendChild(line)
    // The feedback field belongs to the row above it but is not part of it: a
    // click there is aimed at the text, not at picking the option again.
    if (row.extra) list.appendChild(row.extra)
  })
  return list
}

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
  onSelect: OverlaySelect,
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
