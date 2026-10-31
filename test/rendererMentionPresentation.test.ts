import test from 'node:test'
import assert from 'node:assert/strict'
import { mentionPresentation } from '../src/desktop/renderer/model/mentionPresentation.js'

const present = (path: string, kind: 'file' | 'directory' = 'file') => mentionPresentation({ id: path, displayText: path, metadata: { path, kind, replacementText: `@${path}` } })

test('mention rows show basename, relative parent, neutral file type and full hover', () => {
  assert.deepEqual(present('src/test.mjs'), { name: 'test.mjs', detail: 'src', icon: 'JS', title: 'src/test.mjs', accessibleName: '文件 test.mjs src' })
  assert.equal(present('test/loop.test.ts').icon, 'TS')
  assert.equal(present('fixtures/animated.gif').icon, 'file-image')
  assert.equal(present('README.md').detail, '.')
  assert.equal(present('test/', 'directory').detail, '')
  assert.equal(present('test/helpers/', 'directory').detail, 'test')
  assert.equal(present('main.rs').icon, 'file-code')
})
