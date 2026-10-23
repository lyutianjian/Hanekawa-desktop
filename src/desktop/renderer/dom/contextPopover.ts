import type { ContextPopoverListItem, ContextPopoverView } from '../model/contextBreakdown.js'
import { button } from './controls.js'
import { el, reconcile, show } from './dom.js'
import { icon } from './icons.js'
import { createPresence, type Presence } from './presence.js'

export type ContextPopoverState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly view: ContextPopoverView }

export interface ContextPopover {
  readonly node: HTMLElement
  readonly presence: Presence
  paint(state: ContextPopoverState): void
}

type GroupKey = 'mcp' | 'memory'

/**
 * The context indicator's click-open card: what the context is made of. The
 * two lists at its foot keep their open state across repaints, and a toggle
 * flips them in place rather than rebuilding the card under the pointer.
 */
export function createContextPopover(options: { onCompact?: () => void } = {}): ContextPopover {
  const node = el('div', 'context-popover')
  node.setAttribute('role', 'dialog')
  node.setAttribute('aria-label', '上下文')
  const presence = createPresence(node)
  const expanded = new Set<GroupKey>()

  function group(key: GroupKey, label: string, items: readonly ContextPopoverListItem[]): HTMLElement[] {
    if (items.length === 0) return []
    const chevron = el('span', 'ctx-group-chevron')
    const list = el('ul', 'ctx-list', ...items.map((item) => {
      const name = el('span', 'ctx-list-name', item.label)
      name.title = item.full
      return el('li', item.muted ? 'ctx-list-item muted' : 'ctx-list-item', name, el('span', 'ctx-num', item.tokens))
    }))
    const toggle = el('button', 'ctx-group', chevron, el('span', 'ctx-group-label', label), el('span', 'ctx-num', String(items.length)))
    toggle.type = 'button'
    const sync = () => {
      const open = expanded.has(key)
      toggle.setAttribute('aria-expanded', String(open))
      chevron.replaceChildren(icon(open ? 'chevron-down' : 'chevron-right'))
      show(list, open)
    }
    toggle.addEventListener('click', () => {
      if (expanded.has(key)) expanded.delete(key)
      else expanded.add(key)
      sync()
    })
    sync()
    return [toggle, list]
  }

  function paint(state: ContextPopoverState): void {
    const title = el('div', 'ctx-title', '上下文')
    if (state.kind !== 'ready') {
      const text = state.kind === 'loading' ? '读取中…' : state.kind === 'empty' ? '暂无数据' : `读取失败：${state.message}`
      reconcile(node, [title, el('p', 'ctx-status', text)])
      return
    }
    const view = state.view
    const bar = el('div', 'ctx-bar', ...view.rows
      .filter((row) => row.key !== 'free' && row.ratio > 0)
      .map((row) => {
        const segment = el('span', `ctx-segment ctx-swatch-${row.key}`)
        segment.style.setProperty('--ctx-share', String(row.ratio))
        return segment
      }))
    // The free space is the track itself, so the segments must not stretch to fill it.
    const rest = el('span', 'ctx-segment-rest')
    rest.style.setProperty('--ctx-share', String(view.rows.find((row) => row.key === 'free')?.ratio ?? 0))
    bar.appendChild(rest)
    const rows = el('ul', 'ctx-rows', ...view.rows.map((row) => el('li', 'ctx-row',
      el('span', `ctx-swatch ctx-swatch-${row.key}`),
      el('span', 'ctx-row-label', row.label),
      el('span', 'ctx-num', row.tokens),
      el('span', 'ctx-num ctx-percent', row.percent),
    )))
    const deferred = view.deferred.length > 0
      ? [el('ul', 'ctx-rows ctx-deferred', ...view.deferred.map((row) => el('li', 'ctx-row',
          el('span', 'ctx-swatch ctx-swatch-deferred'),
          el('span', 'ctx-row-label', row.label),
          el('span', 'ctx-num', row.tokens),
          el('span', 'ctx-num ctx-percent', '—'),
        )))]
      : []
    const groups = [...group('mcp', 'MCP 工具', view.mcpTools), ...group('memory', '记忆文件', view.memoryFiles)]
    reconcile(node, [
      title,
      el('div', 'ctx-summary', el('span', 'ctx-lead', `已使用 ${view.percent}`), el('span', 'ctx-num', view.usage)),
      bar,
      rows,
      ...deferred,
      ...(groups.length > 0 ? [el('div', 'ctx-groups', ...groups)] : []),
      ...(view.note ? [el('p', 'ctx-note', view.note)] : []),
      // The card says how full the context is; this is the one thing to do
      // about it, where it used to take knowing `/compact` by name.
      ...(options.onCompact ? [el('div', 'ctx-actions', button('ctx-compact', '压缩上下文', '运行 /compact，把较早的对话压缩成摘要', options.onCompact))] : []),
    ])
  }

  return { node, presence, paint }
}
