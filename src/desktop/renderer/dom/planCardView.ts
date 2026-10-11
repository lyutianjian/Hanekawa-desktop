import type {
  EnterPlanIntent,
  EnterPlanViewModel,
  ExitPlanIntent,
  ExitPlanViewModel,
  PlanCardButton,
} from '../model/planDialogs.js'
import { button } from './controls.js'
import type { DockedCard } from './dockedCard.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

/**
 * The two plan requests, drawn into the docked card (`dockedCard.ts`): entering
 * plan mode is a one-line question like the permission card, and a proposed plan
 * adds 打开计划 (the full text lives in the side panel) and the 修改… field.
 *
 * Every decision arrives in the view model; a click reports the same intent its
 * key produces. The feedback input is built once and carried through repaints,
 * and a repaint that changes only what is typed touches nothing but 发送, so
 * typing (and IME composition) is never interrupted.
 */
export interface PlanCardView {
  showEnter(view: EnterPlanViewModel): void
  showExit(view: ExitPlanViewModel): void
}

export interface PlanCardHandlers {
  onEnterIntent(intent: EnterPlanIntent): void
  onExitIntent(intent: ExitPlanIntent): void
  onOpenPlan(): void
}

export function createPlanCardView(dock: DockedCard, container: HTMLElement, handlers: PlanCardHandlers): PlanCardView {
  const feedbackInput = el('input', 'plan-feedback-input')
  feedbackInput.type = 'text'
  feedbackInput.setAttribute('placeholder', '告诉助手要怎么改')
  feedbackInput.setAttribute('aria-label', '告诉助手要怎么改')
  feedbackInput.addEventListener('input', () => handlers.onExitIntent({ kind: 'feedback-set', text: feedbackInput.value }))

  let card: HTMLElement | undefined
  let send: HTMLButtonElement | undefined
  let lastKey = ''

  let primary: HTMLElement | undefined
  const primaryButton = (): HTMLElement | undefined => primary

  function bar<I>(buttons: readonly PlanCardButton<I>[], onIntent: (intent: I) => void): { node: HTMLElement; nodes: HTMLButtonElement[] } {
    const nodes = buttons.map((spec) => {
      const node = button(`dialog-btn${spec.primary ? ' primary' : ''}`, spec.label, spec.label, () => onIntent(spec.intent), { enabled: spec.enabled })
      if (spec.shortcut) node.appendChild(el('span', 'kbd', spec.shortcut))
      return node
    })
    primary = nodes.find((_, index) => buttons[index]!.primary)
    const group = (side: 'start' | 'end') => el('div', 'plan-actions-group', ...nodes.filter((_, index) => buttons[index]!.side === side))
    return { node: el('div', 'dialog-actions plan-actions', group('start'), group('end')), nodes }
  }

  function paint(key: string, build: () => HTMLElement, label: string, patch: () => void, focus: () => HTMLElement | undefined): void {
    let rebuilt = false
    const focusWanted = dock.show(() => {
      if (key !== lastKey || !card || !container.contains(card)) {
        rebuilt = true
        lastKey = key
        card = build()
        replace(container, card)
        container.setAttribute('aria-label', label)
      }
      patch()
    })
    if (focusWanted && rebuilt) focus()?.focus()
  }

  return {
    showEnter(view) {
      send = undefined
      paint(
        JSON.stringify(view),
        () => {
          const actions = bar(view.buttons, handlers.onEnterIntent)
          return el(
            'div',
            'plan-card',
            el('div', 'request-head', icon('file'), el('span', 'request-title', view.title)),
            el('div', 'request-question', view.body),
            actions.node,
          )
        },
        `${view.title}：${view.body}`,
        () => {},
        primaryButton,
      )
    },

    showExit(view) {
      paint(
        JSON.stringify({ ...view, feedback: '', buttons: view.buttons.map((spec) => ({ ...spec, enabled: true })) }),
        () => {
          const actions = bar(view.buttons, handlers.onExitIntent)
          send = actions.nodes.find((_, index) => view.buttons[index]!.intent.kind === 'send-feedback')
          const open = button('plan-open-link', '打开计划', '打开计划', handlers.onOpenPlan)
          return el(
            'div',
            'plan-card',
            el('div', 'request-head', icon('file'), el('span', 'request-title', view.title), el('span', 'plan-head-spacer'), open),
            view.modifying && feedbackInput,
            actions.node,
          )
        },
        view.title,
        () => {
          if (feedbackInput.value !== view.feedback) feedbackInput.value = view.feedback
          if (send) send.disabled = !(view.buttons.find((spec) => spec.intent.kind === 'send-feedback')?.enabled ?? true)
        },
        () => (view.modifying ? feedbackInput : primaryButton()),
      )
    },
  }
}
