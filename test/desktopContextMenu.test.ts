import assert from 'node:assert/strict'
import test from 'node:test'
import type { MenuItemConstructorOptions } from 'electron'
import { contextMenuTemplate, type ContextMenuActions, type ContextMenuInput } from '../src/desktop/contextMenu.js'

const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true }

function input(overrides: Partial<ContextMenuInput> = {}): ContextMenuInput {
  return {
    x: 10,
    y: 20,
    isEditable: false,
    selectionText: '',
    misspelledWord: '',
    dictionarySuggestions: [],
    linkURL: '',
    mediaType: 'none',
    hasImageContents: false,
    editFlags: ALL_FLAGS,
    ...overrides,
  }
}

function recorder(): { actions: ContextMenuActions; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    actions: {
      replaceMisspelling: (word) => calls.push(`replace:${word}`),
      addToDictionary: (word) => calls.push(`add:${word}`),
      copyText: (text) => calls.push(`copy:${text}`),
      copyImageAt: (x, y) => calls.push(`image:${x},${y}`),
    },
  }
}

const labels = (template: MenuItemConstructorOptions[]) => template.map((item) => item.type === 'separator' ? '—' : item.label)

test('nothing to act on is no menu at all, never an empty popup', () => {
  assert.deepEqual(contextMenuTemplate(input(), 'darwin', recorder().actions), [])
  assert.deepEqual(contextMenuTemplate(input({ selectionText: '   ' }), 'win32', recorder().actions), [])
})

test('an editable field gets the four editing commands, enabled as the field reports', () => {
  const template = contextMenuTemplate(
    input({ isEditable: true, editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true } }),
    'win32',
    recorder().actions,
  )
  assert.deepEqual(labels(template), ['剪切', '复制', '粘贴', '—', '全选'])
  assert.deepEqual(template.filter((item) => item.role).map((item) => item.enabled), [false, false, true, true])
})

test('each platform says copy in its own word', () => {
  // macOS's own menus say 拷贝; Windows and Linux say 复制.
  assert.deepEqual(labels(contextMenuTemplate(input({ selectionText: 'path' }), 'darwin', recorder().actions)), ['拷贝'])
  assert.deepEqual(labels(contextMenuTemplate(input({ selectionText: 'path' }), 'win32', recorder().actions)), ['复制'])
  assert.deepEqual(labels(contextMenuTemplate(input({ selectionText: 'path' }), 'linux', recorder().actions)), ['复制'])
})

test('a misspelling leads with at most five suggestions and 添加到词典', () => {
  const { actions, calls } = recorder()
  const template = contextMenuTemplate(
    input({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['the', 'ten', 'tea', 'tech', 'tel', 'tee'] }),
    'darwin',
    actions,
  )
  assert.deepEqual(labels(template), ['the', 'ten', 'tea', 'tech', 'tel', '添加到词典', '—', '剪切', '拷贝', '粘贴', '—', '全选'])
  ;(template[0]!.click as () => void)()
  ;(template[5]!.click as () => void)()
  assert.deepEqual(calls, ['replace:the', 'add:teh'])

  const none = contextMenuTemplate(input({ isEditable: true, misspelledWord: 'qzx' }), 'win32', actions)
  assert.equal(none[0]!.label, '没有拼写建议')
  assert.equal(none[0]!.enabled, false)
})

test('links and images add their own groups, separated from the rest', () => {
  const { actions, calls } = recorder()
  const template = contextMenuTemplate(
    input({ selectionText: 'see', linkURL: 'https://example.com/', mediaType: 'image', hasImageContents: true }),
    'win32',
    actions,
  )
  assert.deepEqual(labels(template), ['复制', '—', '复制链接地址', '—', '复制图片'])
  ;(template[2]!.click as () => void)()
  ;(template[4]!.click as () => void)()
  assert.deepEqual(calls, ['copy:https://example.com/', 'image:10,20'])
  // An image with nothing loaded has nothing to copy.
  assert.deepEqual(contextMenuTemplate(input({ mediaType: 'image' }), 'win32', actions), [])
})
