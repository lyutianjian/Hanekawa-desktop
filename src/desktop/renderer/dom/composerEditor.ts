import { sessionReferenceMarkdown } from '../../../runtime/sessionReferenceText.js'
import { composerAtomicOffset } from '../model/composerDocument.js'
import { splitUserMessage } from '../model/userMessage.js'
import type { WireCommandInfo } from '../../../runtime/protocol/wire.js'
import { el, replace } from './dom.js'
import { icon } from './icons.js'

interface EditState { text: string; start: number; end: number }
export interface ComposerEditor {
  render(commands: readonly WireCommandInfo[]): void
  insertText(text: string): void
  editValue(text: string, cursorPos: number): void
  placeCaretAtPoint(x: number, y: number): void
}

/** Installs the existing string/caret interface on the local contenteditable. */
export function installComposerEditor(input: HTMLTextAreaElement, actions: {
  onOpenSessionReference?: (ref: string) => void
  onResolveSessionReference?: (ref: string) => Promise<{ title: string; projectName: string } | undefined>
} = {}): ComposerEditor | undefined {
  if (input.getAttribute('contenteditable') !== 'true') return undefined
  const host = input as unknown as HTMLElement
  let commands: readonly WireCommandInfo[] = []
  let version = 0
  let composing = false
  let savedStart = 0
  let savedEnd = 0
  let placeholder = host.getAttribute('data-placeholder') ?? ''
  let locked = false
  let undo: EditState[] = []
  let redo: EditState[] = []
  let before: EditState | undefined
  const resolving = new Map<string, Promise<{ title: string; projectName: string } | undefined>>()

  function source(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
    if (node instanceof HTMLElement && node.dataset.composerSource !== undefined) return node.dataset.composerSource
    if (node instanceof HTMLElement && node.dataset.composerSentinel !== undefined) return ''
    // Chromium leaves a trailing caret placeholder after deleting text.
    // Explicit newlines are text nodes, with a separate marked sentinel.
    if (node.nodeName === 'BR') {
      let next = node.nextSibling
      while (next?.nodeType === Node.TEXT_NODE && next.textContent === '') next = next.nextSibling
      return next ? '\n' : ''
    }
    return Array.from(node.childNodes).map(source).join('')
  }
  const text = () => source(host)
  function offset(node: Node, at: number): number {
    if (node === host) return Array.from(host.childNodes).slice(0, at).reduce((sum, child) => sum + source(child).length, 0)
    let atom: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement
    while (atom && atom !== host && atom.dataset.composerSource === undefined) atom = atom.parentElement
    if (atom && atom !== host && atom.dataset.composerSource !== undefined) {
      const parent = atom.parentNode!
      const index = Array.from(parent.childNodes).indexOf(atom)
      return offset(parent, index + (at > 0 ? 1 : 0))
    }
    let result = node.nodeType === Node.TEXT_NODE ? at : Array.from(node.childNodes).slice(0, at).reduce((sum, child) => sum + source(child).length, 0)
    let current: Node = node
    while (current !== host && current.parentNode) {
      const parent = current.parentNode
      for (const child of Array.from(parent.childNodes)) {
        if (child === current) break
        result += source(child).length
      }
      current = parent
    }
    return result
  }
  function selection(): [number, number] {
    const selected = window.getSelection()
    if (!selected?.rangeCount || !selected.anchorNode || !selected.focusNode || !host.contains(selected.anchorNode) || !host.contains(selected.focusNode)) return [savedStart, savedEnd]
    const a = offset(selected.anchorNode, selected.anchorOffset)
    const b = offset(selected.focusNode, selected.focusOffset)
    savedStart = Math.min(a, b)
    savedEnd = Math.max(a, b)
    return [savedStart, savedEnd]
  }
  function point(at: number): [Node, number] {
    let remaining = Math.max(0, at)
    const children = Array.from(host.childNodes)
    for (let index = 0; index < children.length; index++) {
      const child = children[index]!
      const length = source(child).length
      if (remaining <= length) {
        if (child.nodeType === Node.TEXT_NODE) return [child, remaining]
        if (remaining === 0) return [host, index]
        if (remaining === length || child instanceof HTMLElement && child.contentEditable === 'false') return [host, index + 1]
        const walker = document.createTreeWalker(child, NodeFilter.SHOW_TEXT)
        let leaf: Node | null
        while ((leaf = walker.nextNode())) {
          const size = leaf.textContent?.length ?? 0
          if (remaining <= size) return [leaf, remaining]
          remaining -= size
        }
        return [host, index + 1]
      }
      remaining -= length
    }
    return [host, children.length]
  }
  function setSelection(start: number, end: number): void {
    const value = text()
    savedStart = composerAtomicOffset(value, start, 'before')
    savedEnd = composerAtomicOffset(value, end, start === end ? 'before' : 'after')
    const selected = window.getSelection()
    if (!selected) return
    const range = document.createRange()
    range.setStart(...point(savedStart))
    range.setEnd(...point(savedEnd))
    selected.removeAllRanges()
    selected.addRange(range)
  }
  const state = (): EditState => {
    const [start, end] = selection()
    return { text: text(), start, end }
  }
  function paint(value: string, start: number, end: number): void {
    const nodes = splitUserMessage(value, commands).map((segment): Node => {
      if (segment.kind === 'session-reference') {
        const node = el('span', 'session-reference', icon('message-circle'), segment.label)
        node.contentEditable = 'false'
        node.dataset.composerSource = segment.text
        node.dataset.sessionUri = segment.uri
        node.title = `${segment.label}\n${segment.uri}`
        if (actions.onResolveSessionReference) {
          const expectedVersion = version
          const expectedText = value
          const resolve = () => {
            let pending = resolving.get(segment.uri)
            if (!pending) {
              pending = actions.onResolveSessionReference!(segment.uri)
              resolving.set(segment.uri, pending)
              void pending.finally(() => resolving.delete(segment.uri)).catch(() => {})
            }
            void pending.then((resolved) => {
              if (version !== expectedVersion || text() !== expectedText || !node.isConnected) return
              if (!resolved) {
                node.title = `无法找到此会话：${segment.uri}`
                if (segment.text === segment.uri) node.textContent = segment.uri
                return
              }
              node.title = `${resolved.title} · ${resolved.projectName}`
              if (segment.text !== segment.uri) return
              const position = value.indexOf(segment.text)
              if (position < 0) return
              const current = state()
              const markdown = sessionReferenceMarkdown({ sessionId: segment.sessionId, title: resolved.title })
              const end = position + segment.text.length
              const shift = (at: number) => at >= end ? at + markdown.length - segment.text.length : at
              const next = value.slice(0, position) + markdown + value.slice(end)
              version++
              paint(next, shift(current.start), shift(current.end))
              synthetic = true
              notify()
              synthetic = false
            }).catch((error: unknown) => {
              if (version === expectedVersion && node.isConnected) node.title = `无法解析会话：${error instanceof Error ? error.message : segment.uri}`
            })
          }
          if (segment.text === segment.uri) resolve()
          else node.addEventListener('mouseenter', resolve, { once: true })
        }
        node.setAttribute('aria-label', `会话 ${segment.label}`)
        return node
      }
      if (segment.kind === 'command') {
        const node = el('span', 'user-command', segment.isSkill ? el('span', 'user-command-mark', icon('package')) : undefined, segment.label)
        node.dataset.composerSource = segment.text
        node.contentEditable = 'false'
        return node
      }
      return document.createTextNode(segment.text)
    })
    // A final empty text node gives the caret a position after a final atom.
    nodes.push(document.createTextNode(''))
    if (value.endsWith('\n')) {
      const sentinel = document.createElement('br')
      sentinel.dataset.composerSentinel = ''
      nodes.push(sentinel)
    }
    replace(host, ...nodes)
    if (document.activeElement === host) setSelection(start, end)
    else { savedStart = start; savedEnd = end }
  }
  function remember(previous: EditState): void {
    undo.push(previous)
    if (undo.length > 100) undo.shift()
    redo = []
  }
  function notify(): void { host.dispatchEvent(new Event('input', { bubbles: true })) }
  let synthetic = false
  function insertText(value: string): void {
    if (locked) return
    const previous = state()
    const next = previous.text.slice(0, previous.start) + value + previous.text.slice(previous.end)
    editValue(next, previous.start + value.length)
  }
  function editValue(value: string, cursorPos: number): void {
    if (locked) return
    remember(state())
    version++
    paint(value, cursorPos, cursorPos)
    synthetic = true
    notify()
    synthetic = false
  }
  function history(backward: boolean): void {
    const next = (backward ? undo : redo).pop()
    if (!next) return
    ;(backward ? redo : undo).push(state())
    version++
    paint(next.text, next.start, next.end)
    synthetic = true
    notify()
    synthetic = false
  }
  Object.defineProperties(host, {
    value: { configurable: true, get: text, set(value: string) {
      version++
      undo = []; redo = []; before = undefined
      const caret = Math.min(savedStart, value.length)
      paint(value, caret, caret)
    } },
    selectionStart: { configurable: true, get: () => selection()[0] },
    selectionEnd: { configurable: true, get: () => selection()[1] },
    disabled: { configurable: true, get: () => locked, set(value: boolean) {
      locked = value; host.contentEditable = value ? 'false' : 'true'; host.setAttribute('aria-disabled', String(value))
    } },
    placeholder: { configurable: true, get: () => placeholder, set(value: string) {
      placeholder = value; host.setAttribute('data-placeholder', value)
    } },
    setSelectionRange: { configurable: true, value: setSelection },
  })
  host.addEventListener('compositionstart', () => { before = state(); composing = true })
  host.addEventListener('compositionend', () => {
    composing = false
    version++
    if (before && before.text !== text()) remember(before)
    before = undefined
    const current = state()
    paint(current.text, current.start, current.end)
  })
  host.addEventListener('beforeinput', (event) => {
    if (composing) return
    if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
      event.preventDefault(); history(event.inputType === 'historyUndo'); return
    }
    if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak') {
      event.preventDefault(); insertText('\n'); return
    }
    before = state()
  })
  host.addEventListener('input', () => {
    if (synthetic || composing) return
    version++
    if (before && before.text !== text()) remember(before)
    before = undefined
    const current = state()
    paint(current.text, current.start, current.end)
  })
  host.addEventListener('keydown', (event) => {
    if (composing || event.isComposing) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
      event.preventDefault(); history(!event.shiftKey); return
    }
    if ((event.ctrlKey && !event.metaKey) && event.key.toLowerCase() === 'y') {
      event.preventDefault(); history(false); return
    }
    // Let Chromium extend selections and move by word/line around atomic nodes.
    if (event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return
    const current = state()
    if (current.start !== current.end) return
    const segments = splitUserMessage(current.text, commands)
    let at = 0
    for (const segment of segments) {
      const end = at + segment.text.length
      if (segment.kind === 'session-reference' || segment.kind === 'command') {
        const backward = event.key === 'Backspace' || event.key === 'ArrowLeft'
        const forward = event.key === 'Delete' || event.key === 'ArrowRight'
        if (backward && current.start === end || forward && current.start === at) {
          event.preventDefault()
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            if (event.shiftKey) setSelection(backward ? at : current.start, backward ? current.end : end)
            else setSelection(backward ? at : end, backward ? at : end)
          }
          else { setSelection(at, end); insertText('') }
          return
        }
      }
      at = end
    }
  })
  for (const type of ['copy', 'cut'] as const) host.addEventListener(type, (event) => {
    const current = state()
    if (current.start === current.end || !event.clipboardData) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', current.text.slice(current.start, current.end))
    if (type === 'cut') insertText('')
  })
  host.addEventListener('paste', (event) => {
    if (!event.clipboardData || Array.from(event.clipboardData.files).some((file) => file.type.startsWith('image/'))) return
    event.preventDefault()
    insertText(event.clipboardData.getData('text/plain'))
  })
  host.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-session-uri]') : null
    if (target) actions.onOpenSessionReference?.(target.dataset.sessionUri!)
  })
  host.addEventListener('blur', () => selection())
  host.contentEditable = 'true'
  host.setAttribute('data-placeholder', placeholder)
  return {
    editValue,
    insertText,
    placeCaretAtPoint(x, y) {
      const range = document.caretRangeFromPoint(x, y)
      if (!range || !host.contains(range.startContainer)) return
      host.focus()
      const at = offset(range.startContainer, range.startOffset)
      setSelection(at, at)
    },
    render(next) {
      if (composing) return
      if (commands === next) return
      commands = next
      const current = state()
      paint(current.text, current.start, current.end)
    },
  }
}
