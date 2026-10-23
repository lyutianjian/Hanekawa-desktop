import type { MergeBarEntry, MergeBarIntent, MergeBarView } from '../model/mergeBar.js'
import { el, reconcile, show, type Child } from './dom.js'
import { button } from './controls.js'

/**
 * The merge reminder bar's nodes (stage 5, T5).
 *
 * The summary is an inline disclosure: its toggle carries `aria-expanded` and
 * the list sits in the flow beneath it, so there is no popover to dismiss.
 * Every paint is keyed on the view's JSON, because the bar is repainted on each
 * shell snapshot and a streaming turn produces many of those.
 */

export interface MergeBarDom {
  /** `error` is a failed action's message, drawn under the bar's rows. */
  render(view: MergeBarView, error?: string): void
}

export function createMergeBarView(
  container: HTMLElement,
  onIntent: (intent: MergeBarIntent) => void,
): MergeBarDom {
  let lastSignature: string | undefined

  /** Why an action is unavailable, as its tooltip. `running` wins: it is the reason the user can act on. */
  function disabledReason(entry: MergeBarEntry): string {
    return entry.running ? '线程运行中' : '合并中'
  }

  function actionButton(
    entry: MergeBarEntry,
    className: string,
    label: string,
    enabled: boolean,
    title: string,
    intent: MergeBarIntent,
  ): HTMLButtonElement {
    // A disabled button fires no click in a browser; the guard keeps that true for
    // any path that reaches the handler anyway, so an unavailable action never
    // reaches the host.
    return button(
      className,
      label,
      enabled ? title : disabledReason(entry),
      () => { if (enabled) onIntent(intent) },
      { enabled },
    )
  }

  function row(entry: MergeBarEntry): HTMLElement {
    const children: Child[] = [
      el('span', 'merge-bar-project', entry.projectName),
      el('span', 'merge-bar-branch', entry.branch),
    ]
    if (entry.conflict) {
      children.push(el('span', 'merge-bar-conflict', '有冲突'))
      children.push(actionButton(
        entry,
        'merge-bar-resolve',
        '让线程解决',
        entry.resolveEnabled,
        '让线程解决冲突',
        { kind: 'resolve', threadId: entry.threadId },
      ))
    } else {
      children.push(el('span', 'merge-bar-stat', entry.stat))
      children.push(actionButton(
        entry,
        'merge-bar-merge',
        '合并',
        entry.mergeEnabled,
        '合并此分支',
        { kind: 'merge', threadId: entry.threadId },
      ))
    }
    children.push(button('merge-bar-dismiss', '', '隐藏此提醒', () => onIntent({ kind: 'dismiss', threadId: entry.threadId }), { icon: 'close' }))
    const node = el('div', 'merge-bar-row', ...children)
    node.setAttribute('data-thread-id', entry.threadId)
    return node
  }

  function errorNode(message: string): HTMLElement {
    const node = el('div', 'merge-bar-error', message)
    node.setAttribute('role', 'alert')
    return node
  }

  return {
    render(view, error) {
      const signature = JSON.stringify([view, error])
      if (signature === lastSignature) return
      lastSignature = signature
      show(container, view.kind !== 'hidden')
      if (view.kind === 'hidden') {
        reconcile(container, [])
        return
      }
      const errorLine = error === undefined ? undefined : errorNode(error)
      if (view.kind === 'single') {
        reconcile(container, [row(view.entry), errorLine])
        return
      }
      const toggle = button(
        'merge-bar-toggle',
        view.label,
        view.label,
        () => onIntent({ kind: 'toggle-expanded' }),
      )
      toggle.setAttribute('aria-expanded', view.expanded ? 'true' : 'false')
      const list = view.expanded
        ? el('ul', 'merge-bar-list', ...view.entries.map((entry) => el('li', 'merge-bar-item', row(entry))))
        : undefined
      reconcile(container, [toggle, list, errorLine])
    },
  }
}
