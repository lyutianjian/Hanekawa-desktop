import { EditorState } from '@codemirror/state'
import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { HighlightStyle, syntaxHighlighting, bracketMatching } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { html } from '@codemirror/lang-html'
import { css } from '@codemirror/lang-css'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { createTwoFilesPatch } from 'diff'
import { FileEditorBuffer, FILE_SAVE_LABELS, type TextDocument } from '../model/fileEditor.js'
import type { WorkspaceFile, WorkspaceSaveResult } from '../../../runtime/protocol/workspaceFiles.js'
import { el, replace } from './dom.js'
import { button } from './controls.js'
import { fileMarkdownNode } from './markdownView.js'

const theme = EditorView.theme({
  '&': { height: '100%', color: 'var(--text-primary)', backgroundColor: 'var(--surface-card)', fontSize: 'var(--type-code)' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', overflow: 'auto' },
  '.cm-content': { caretColor: 'var(--text-primary)', padding: '12px 0' },
  '.cm-gutters': { backgroundColor: 'var(--surface-card)', color: 'var(--text-tertiary)', border: 'none' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'var(--surface-hover)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--text-primary)' },
  '.cm-panels': { color: 'var(--text-primary)', backgroundColor: 'var(--surface-card)' },
})
const highlighting = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--syntax-comment)' },
  { tag: [tags.keyword, tags.modifier], color: 'var(--syntax-keyword)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syntax-string)' },
  { tag: [tags.number, tags.bool, tags.null], color: 'var(--syntax-number)' },
  { tag: tags.propertyName, color: 'var(--syntax-property)' },
  { tag: tags.function(tags.variableName), color: 'var(--syntax-function)' },
  { tag: [tags.typeName, tags.className], color: 'var(--syntax-variable)' },
  { tag: [tags.tagName, tags.attributeName], color: 'var(--syntax-attr)' },
])

function language(path: string) {
  if (/\.[cm]?[jt]sx?$/.test(path)) return javascript({ typescript: /tsx?$/.test(path), jsx: /[jt]sx$/.test(path) })
  if (/\.jsonc?$/.test(path)) return json()
  if (/\.html?$/.test(path)) return html()
  if (/\.css$/.test(path)) return css()
  if (/\.(md|markdown)$/i.test(path)) return markdown()
  if (/\.py$/.test(path)) return python()
  return []
}

export class FileEditorView {
  readonly element = el('div', 'file-document')
  readonly buffer: FileEditorBuffer
  private readonly toolbar = el('div', 'file-document-toolbar')
  private readonly status = el('span', 'file-save-status')
  private readonly notice = el('div', 'file-conflict')
  private readonly code = el('div', 'file-code')
  private readonly preview = el('div', 'file-markdown md')
  private readonly difference = el('pre', 'file-difference')
  private readonly editor: EditorView
  private previewing: boolean
  private updating = false
  private lastPreview = ''
  private lastNotice = ''
  private disposed = false

  constructor(file: TextDocument, save: (content: string, revision: string) => Promise<WorkspaceSaveResult>, changed: () => void, private readonly decorateMarkdown: (node: HTMLElement, content: string) => void) {
    this.previewing = /\.(md|markdown)$/i.test(file.path)
    this.buffer = new FileEditorBuffer(file, save, () => { this.render(); changed() })
    this.editor = new EditorView({ parent: this.code, state: EditorState.create({ doc: file.content, extensions: [
      theme, lineNumbers(), drawSelection(), highlightActiveLine(), history(), bracketMatching(),
      search(), highlightSelectionMatches(), syntaxHighlighting(highlighting), language(file.path),
      keymap.of([{ key: 'Mod-s', run: () => { void this.buffer.flush(); return true } }, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
      EditorView.domEventHandlers({ compositionstart: () => { this.buffer.composition(true) }, compositionend: () => { this.buffer.composition(false) } }),
      EditorView.updateListener.of((update) => { if (update.docChanged && !this.updating) this.buffer.edit(update.state.doc.toString()) }),
    ] }) })
    const toggle = button('file-button', '源码', '切换 Markdown 预览与源码', () => {
      this.previewing = !this.previewing
      toggle.textContent = this.previewing ? '源码' : '预览'
      this.render()
      if (!this.previewing) this.editor.focus()
    })
    toggle.hidden = !/\.(md|markdown)$/i.test(file.path)
    this.toolbar.append(toggle, button('file-button', '保存', '立即保存（⌘S / Ctrl+S）', () => { void this.buffer.flush() }), this.status)
    this.difference.hidden = true
    this.element.append(this.toolbar, this.notice, this.difference, this.code, this.preview)
    this.render()
  }

  private render(): void {
    if (this.disposed) return
    const buffer = this.buffer
    this.status.textContent = FILE_SAVE_LABELS[buffer.status]
    this.status.dataset.state = buffer.status
    this.code.hidden = this.previewing
    this.preview.hidden = !this.previewing
    if (this.previewing && this.lastPreview !== buffer.content) {
      this.lastPreview = buffer.content
      replace(this.preview, fileMarkdownNode(buffer.content))
      this.decorateMarkdown(this.preview, buffer.content)
    }
    if (this.editor.state.doc.toString() !== buffer.content) {
      this.updating = true
      this.editor.dispatch({ changes: { from: 0, to: this.editor.state.doc.length, insert: buffer.content }, selection: { anchor: Math.min(this.editor.state.selection.main.head, buffer.content.length) } })
      this.updating = false
    }
    const notice = `${buffer.status}:${buffer.error}:${buffer.disk?.kind === 'text' ? buffer.disk.revision : buffer.disk?.kind ?? ''}`
    if (notice === this.lastNotice) return
    this.lastNotice = notice
    this.notice.hidden = buffer.status !== 'conflict' && buffer.status !== 'error'
    if (buffer.status === 'conflict') {
      const disk = buffer.disk
      replace(this.notice, el('span', undefined, disk?.kind === 'text' ? '文件已在外部修改，自动保存已暂停。' : '文件已删除、无法读取或不再是文本，当前编辑已保留。'),
        button('file-button', '查看差异', '比较磁盘版本与当前编辑', () => {
          this.difference.hidden = !this.difference.hidden
          this.difference.textContent = createTwoFilesPatch('磁盘版本', '当前编辑', disk?.kind === 'text' ? disk.content : '', buffer.content)
        }))
      if (disk?.kind === 'text') this.notice.append(
        button('file-button', '采用磁盘版本', '放弃当前修改，采用磁盘内容', () => { buffer.accept(disk); this.difference.hidden = true }),
        button('file-button', '用我的版本覆盖', '用当前编辑覆盖刚显示的磁盘版本', () => { void buffer.overwrite(); this.difference.hidden = true }))
    } else if (buffer.status === 'error') replace(this.notice, el('span', undefined, buffer.error), button('file-button', '重试保存', '重新尝试保存', () => { void buffer.flush() }))
    else { replace(this.notice); this.difference.hidden = true }
  }

  refresh(read: () => Promise<WorkspaceFile>): Promise<void> { return this.buffer.refresh(read) }
  focus(): void { if (!this.previewing) this.editor.focus(); this.editor.requestMeasure() }
  dispose(): void { this.disposed = true; this.buffer.dispose(); this.editor.destroy(); this.element.remove() }
}
