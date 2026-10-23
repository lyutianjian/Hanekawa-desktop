import type { DesktopPlatform } from '../../types.js'
import type { AskIntent, AskViewModel } from '../model/askUserQuestion.js'
import { enterChordLabel } from '../model/desktopShortcuts.js'
import { button } from './controls.js'
import type { DockedCard } from './dockedCard.js'
import { el, replace } from './dom.js'

/**
 * The AskUserQuestion request, drawn into the docked card (`dockedCard.ts`) so
 * the transcript stays readable — and scrollable — while the user answers.
 *
 * Every decision arrives in the {@link AskViewModel}; a click reports the same
 * {@link AskIntent} its key produces. The 「其他」 input is the one stateful
 * node: it is built once and carried through every repaint, and a repaint that
 * changes only what is typed touches nothing but the submit button, so typing
 * (and IME composition) is never interrupted.
 */
export interface QuestionCardView {
  show(view: AskViewModel): void
}

export function createQuestionCardView(
  dock: DockedCard,
  container: HTMLElement,
  onIntent: (intent: AskIntent) => void,
  /** The host OS: the submit hint reads `⌘⏎` on macOS and `Ctrl+Enter` elsewhere. */
  platform: DesktopPlatform,
): QuestionCardView {
  const otherInput = el('input', 'ask-other-input')
  otherInput.type = 'text'
  otherInput.setAttribute('placeholder', '输入你自己的答案')
  otherInput.setAttribute('aria-label', '其他')
  let otherIndex = 0
  let painting = false
  otherInput.addEventListener('input', () => onIntent({ kind: 'other-set', text: otherInput.value }))
  otherInput.addEventListener('click', (event) => event.stopPropagation())
  // A programmatic focus during a paint is the view's own doing, not the user's.
  otherInput.addEventListener('focus', () => {
    if (!painting) onIntent({ kind: 'select', index: otherIndex })
  })

  let card: HTMLElement | undefined
  let submit: HTMLButtonElement | undefined
  let lastKey = ''

  function build(view: AskViewModel): HTMLElement {
    const collapse = button(`ask-icon-btn ask-collapse${view.collapsed ? ' collapsed' : ''}`, '', view.collapsed ? '展开' : '收起',
      () => onIntent({ kind: 'toggle-collapse' }), { icon: 'chevron-down' })
    const close = button('ask-icon-btn', '', '跳过', () => onIntent({ kind: 'skip' }), { icon: 'close' })
    const head = el(
      'div',
      'ask-head',
      view.questionTotal > 1 && el('span', 'ask-chip', `${view.questionNumber}/${view.questionTotal}`),
      el('span', 'ask-title', view.question),
      collapse,
      close,
    )
    if (view.collapsed) {
      submit = undefined
      head.addEventListener('click', () => onIntent({ kind: 'toggle-collapse' }))
      return el('div', 'ask-card collapsed', head)
    }

    const rows = el('div', 'ask-options')
    rows.setAttribute('role', 'listbox')
    view.rows.forEach((row, index) => {
      const line = el('div', `ask-option${row.selected ? ' selected' : ''}`)
      line.setAttribute('role', 'option')
      line.setAttribute('aria-selected', String(row.selected))
      if (view.multiSelect && !row.isOther) {
        line.setAttribute('aria-checked', String(row.toggled))
        line.appendChild(el('span', `ask-tick${row.toggled ? ' on' : ''}`))
      }
      const text = el('div', 'ask-option-text', el('span', 'ask-option-label', row.label))
      if (row.description) text.appendChild(el('span', 'ask-option-desc', row.description))
      if (row.isOther) text.appendChild(otherInput)
      line.appendChild(text)
      line.appendChild(el('span', 'kbd', String(index + 1)))
      line.addEventListener('click', () => onIntent({ kind: 'select', index }))
      rows.appendChild(line)
    })

    submit = button('dialog-btn primary', view.isLast ? '提交' : '下一个', view.isLast ? '提交' : '下一个',
      () => onIntent({ kind: 'commit' }), { enabled: view.canSubmit })
    submit.appendChild(el('span', 'kbd', enterChordLabel(platform, { primary: true })))
    const back = view.questionTotal > 1 && view.canGoBack
      ? button('dialog-btn', '上一个', '上一个', () => onIntent({ kind: 'back' }))
      : false
    const footer = el(
      'div',
      'ask-footer',
      back,
      el('span', 'ask-spacer'),
      button('dialog-btn', '跳过', '跳过', () => onIntent({ kind: 'skip' })),
      submit,
    )
    return el('div', 'ask-card', head, rows, view.preview !== undefined && el('div', 'request-block', view.preview), footer)
  }

  return {
    show(view) {
      const key = JSON.stringify({ ...view, otherText: '', canSubmit: false })
      otherIndex = view.rows.length - 1
      painting = true
      dock.show(() => {
        if (key !== lastKey || !card || !container.contains(card)) {
          lastKey = key
          card = build(view)
          replace(container, card)
          container.setAttribute('aria-label', view.question)
        }
        if (otherInput.value !== view.otherText) otherInput.value = view.otherText
        if (submit) submit.disabled = !view.canSubmit
      })
      if (view.otherMode && !view.collapsed && document.activeElement !== otherInput) {
        otherInput.focus()
        const end = otherInput.value.length
        otherInput.setSelectionRange(end, end)
      }
      painting = false
    },
  }
}
