/**
 * The side panel's 「线程」 tab: a project's coordination threads as a list.
 *
 * Folds are disclosures drawn inline, not popovers, so nothing here dismisses
 * on press-outside or Escape. The whole panel is rebuilt only when its model
 * output changed: it repaints on every coordination push, and a button rebuilt
 * under the pointer would swallow the click that is on its way.
 */

import type { ThreadFold, ThreadPanelFold, ThreadPanelIntent, ThreadPanelRow, ThreadPanelView } from '../model/threadPanel.js'
import { button } from './controls.js'
import { icon } from './icons.js'
import { el, replace, type Child } from './dom.js'

export interface ThreadPanelDom {
  render(view: ThreadPanelView): void
}

const FOLD_LABEL: Readonly<Record<ThreadFold, string>> = {
  quiet: '安静',
  resolved: '已完成',
}

export function createThreadPanelView(root: HTMLElement, onIntent: (intent: ThreadPanelIntent) => void): ThreadPanelDom {
  let drawn: string | undefined

  function status(item: ThreadPanelRow): HTMLElement {
    // Running spins, as the sidebar's running badge does.
    return el('span', `thread-status tone-${item.tone}`, item.tone === 'running' ? icon('spinner') : undefined, item.statusLabel)
  }

  function row(item: ThreadPanelRow): HTMLElement {
    const actions: Child[] = [
      button('thread-row-open', '打开', '在主画布打开这个线程', () => onIntent({ kind: 'open', sessionId: item.sessionId })),
    ]
    if (item.canStop) {
      actions.push(button('thread-row-stop', '停止', '停止这个线程', () => onIntent({ kind: 'stop', threadId: item.threadId }), { enabled: !item.pending }))
    }
    if (item.canResolve) {
      actions.push(button('thread-row-resolve', '完成', '把这个线程标为已完成（之后不能再发消息）', () => onIntent({ kind: 'resolve', threadId: item.threadId }), { enabled: !item.pending }))
    }
    const title = button('thread-row-title', item.title, `查看线程 ${item.title}`, () => onIntent({ kind: 'view', threadId: item.threadId }))
    if (item.current) title.setAttribute('aria-current', 'true')
    const className = ['thread-row', item.current ? 'current' : '', item.pending ? 'pending' : ''].filter(Boolean).join(' ')
    return el(
      'div',
      className,
      el('div', 'thread-row-head', title, status(item), el('span', 'thread-row-time', item.lastActivity)),
      item.statusLine === undefined ? undefined : el('div', 'thread-row-line', item.statusLine),
      el('div', 'thread-row-actions', ...actions),
    )
  }

  function fold(key: ThreadFold, section: ThreadPanelFold): HTMLElement | undefined {
    if (section.count === 0) return undefined
    const label = `${FOLD_LABEL[key]} · ${section.count}`
    const head = button('thread-fold-head', label, `${label}（${section.expanded ? '收起' : '展开'}）`, () => onIntent({ kind: 'toggle-fold', fold: key }))
    head.setAttribute('aria-expanded', section.expanded ? 'true' : 'false')
    return el(
      'section',
      `thread-fold ${key}`,
      head,
      section.expanded ? el('div', 'thread-fold-body', ...section.rows.map(row)) : undefined,
    )
  }

  function panel(view: ThreadPanelView): HTMLElement {
    const stopAll = button('thread-panel-stop-all', '全部停止', '停止所有运行中的线程', () => onIntent({ kind: 'stop-all' }), {
      enabled: view.active.some((item) => item.canStop),
    })
    return el(
      'div',
      'thread-panel',
      view.notice === undefined ? undefined : el('div', 'thread-panel-notice', view.notice),
      el('div', 'thread-panel-head', stopAll),
      el('div', 'thread-panel-active', ...view.active.map(row)),
      fold('quiet', view.quiet),
      fold('resolved', view.resolved),
    )
  }

  return {
    render(view) {
      const signature = JSON.stringify(view)
      if (signature === drawn) return
      drawn = signature
      if (!view.available) replace(root, view.notice === undefined ? undefined : el('div', 'thread-panel-notice', view.notice), el('p', 'thread-panel-empty', '当前项目还没有线程'))
      else replace(root, panel(view))
    },
  }
}
