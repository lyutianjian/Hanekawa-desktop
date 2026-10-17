import { folderOf, type ChangeRow, type EditedFile, type TurnEdits } from '../model/turnEdits.js'
import { button } from './controls.js'
import { diffStatNode, fileBadgeNode } from './diffView.js'
import { append, el, replace } from './dom.js'
import { icon } from './icons.js'

export interface ChangesPanelInput {
  /** `undefined` while the session has edited nothing. */
  readonly edits: TurnEdits | undefined
  /** The project key, for saying each file's folder relative to it. */
  readonly root: string | undefined
  /** The file the card's row named; scrolled to whenever `focusSeq` moves. */
  readonly focus: string | undefined
  readonly focusSeq: number
}

export interface ChangesPanelView {
  render(input: ChangesPanelInput | undefined): void
}

/**
 * The side panel's 改动 page: the session's edited files, each a foldable
 * section with its rows under a head that sticks while the section scrolls by.
 */
export function createChangesPanelView(host: HTMLElement, handlers: { onOpenPath(path: string): void }): ChangesPanelView {
  const title = el('span', 'changes-title')
  const stat = el('span', 'changes-stat')
  const scroller = el('div', 'changes-scroll')
  append(host, [el('div', 'changes-head', title, stat), scroller])
  let drawn: string | undefined
  let focused = -1
  const folded = new Set<string>()
  const sections = new Map<string, HTMLElement>()

  function fileSection(file: EditedFile, root: string | undefined): HTMLElement {
    const section = el('section', 'changes-file')
    const folder = folderOf(file.path, root)
    const toggle = button('changes-file-toggle', '', `折叠或展开 ${file.name}`, () => {
      if (folded.has(file.path)) folded.delete(file.path)
      else folded.add(file.path)
      paintFold()
    })
    append(toggle, [
      icon('chevron-down'),
      fileBadgeNode(file.name),
      el('span', 'changes-file-name', file.name),
      folder.length > 0 ? el('span', 'changes-file-dir', folder) : undefined,
      diffStatNode(file.added, file.deleted),
    ])
    toggle.title = file.path
    const open = button('changes-file-open', '', '在编辑器中打开', () => handlers.onOpenPath(file.path), { icon: 'external' })
    const body = el('div', 'changes-diff')
    replace(body, ...file.rows.map(rowNode))
    function paintFold(): void {
      const isOpen = !folded.has(file.path)
      toggle.setAttribute('aria-expanded', String(isOpen))
      body.hidden = !isOpen
    }
    paintFold()
    append(section, [el('div', 'changes-file-head', toggle, open), body])
    return section
  }

  return {
    render(input) {
      if (input === undefined) return
      // The pane hands over a fresh object on every stream delta; only new rows rebuild the page.
      const signature = input.edits === undefined
        ? ''
        : `${input.edits.key}|${input.edits.files.map((file) => `${file.path}:${file.rows.length}`).join('|')}`
      if (signature !== drawn) {
        if (drawn?.split('|', 1)[0] !== signature.split('|', 1)[0]) {
          folded.clear()
          scroller.scrollTop = 0
        }
        drawn = signature
        const files = input.edits?.files ?? []
        title.textContent = files.length === 0 ? '本会话还没有改动' : `已编辑 ${files.length} 个文件`
        replace(stat, input.edits === undefined ? undefined : diffStatNode(input.edits.added, input.edits.deleted))
        sections.clear()
        replace(scroller, ...files.map((file) => {
          const section = fileSection(file, input.root)
          sections.set(file.path, section)
          return section
        }))
      }
      if (input.focusSeq === focused) return
      focused = input.focusSeq
      const target = input.focus === undefined ? undefined : sections.get(input.focus)
      if (target === undefined) return
      if (folded.delete(input.focus!)) {
        target.querySelector('.changes-file-toggle')?.setAttribute('aria-expanded', 'true')
        const body = target.querySelector<HTMLElement>('.changes-diff')
        if (body) body.hidden = false
      }
      // After the panel has its width, or the offset is measured against a hidden column.
      requestAnimationFrame(() => {
        scroller.scrollTop = target.offsetTop
        target.classList.remove('flash')
        void target.offsetWidth
        target.classList.add('flash')
      })
    },
  }
}

function rowNode(row: ChangeRow): HTMLElement {
  const node = el('div', `changes-row ${row.kind}`)
  // An elided row keeps the gutter's two empty columns, so its words line up with the code.
  const line = row.kind === 'elided' ? undefined : row.newLine ?? row.oldLine
  append(node, [
    el('span', 'changes-num', line === undefined ? '' : String(line)),
    el('span', 'changes-sign', row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''),
    textNode(row),
  ])
  return node
}

function textNode(row: ChangeRow): HTMLElement {
  const text = el('span', 'changes-text')
  if (row.marks === undefined || row.marks.length === 0) {
    text.textContent = row.text
    return text
  }
  let at = 0
  for (const [start, end] of row.marks) {
    if (start > at) text.appendChild(document.createTextNode(row.text.slice(at, start)))
    text.appendChild(el('span', 'changes-mark', row.text.slice(start, end)))
    at = end
  }
  if (at < row.text.length) text.appendChild(document.createTextNode(row.text.slice(at)))
  return text
}
