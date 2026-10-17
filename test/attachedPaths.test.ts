import test from 'node:test'
import assert from 'node:assert/strict'
import { appendAttachedPaths, attachedPathBadge, splitAttachedPaths } from '../src/media/attachedPaths.js'
import { deriveSessionTitle } from '../src/sessions/service.js'
import type { SessionRecord } from '../src/harness/types.js'

const paths = [
  { kind: 'file' as const, path: '/Users/a/pi-main/tsconfig.base.json' },
  { kind: 'folder' as const, path: '/Users/a/pi-main' },
]

test('attached paths round-trip through the message text', () => {
  for (const text of ['', '看看这两个', '多行\n\n文本']) {
    assert.deepEqual(splitAttachedPaths(appendAttachedPaths(text, paths)), { text, paths })
  }
  assert.equal(appendAttachedPaths('hi', []), 'hi')
  assert.deepEqual(splitAttachedPaths('<attached-paths>\nnope\n</attached-paths>').paths, [])
})

test('badges name folders and extensions', () => {
  assert.deepEqual(paths.map(attachedPathBadge), ['JSON', '文件夹'])
  assert.equal(attachedPathBadge({ kind: 'file', path: '/a/Makefile' }), '文件')
})

test('the session title leaves the path block out', () => {
  const record = (content: string) => ({ type: 'message', role: 'user', content }) as SessionRecord
  assert.equal(deriveSessionTitle(record(appendAttachedPaths('看看', paths))), '看看')
  assert.equal(deriveSessionTitle(record(appendAttachedPaths('', paths))), '文件：tsconfig.base.json')
})
