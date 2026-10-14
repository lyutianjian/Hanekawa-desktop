import assert from 'node:assert/strict'
import test from 'node:test'

import { describeError, errorPlace, errorText, type ErrorPlace } from '../src/desktop/renderer/model/errorReport.js'
import { dismissToast, emptyToasts, MAX_TOASTS, pushToast, TOAST_LIFETIME_MS } from '../src/desktop/renderer/model/toasts.js'

const none: ReadonlySet<ErrorPlace> = new Set()

test('a failure says what was being attempted, unless the host already did', () => {
  assert.equal(errorText({ action: '删除会话' }, '磁盘已满'), '删除会话失败：磁盘已满')
  assert.equal(errorText({ action: '合并线程', bare: true }, '项目目录里有未提交的改动。'), '项目目录里有未提交的改动。')
})

test('an error goes to its own place when that place is on screen, else to a toast', () => {
  const site = { action: '打开项目调度', place: 'projects-page' } as const
  assert.equal(errorPlace(site, new Set<ErrorPlace>(['projects-page'])), 'projects-page')
  assert.equal(errorPlace(site, new Set<ErrorPlace>(['merge-bar'])), 'toast', 'another place does not stand in')
  assert.equal(errorPlace(site, none), 'toast')
  assert.equal(errorPlace({ action: '读取会话列表' }, new Set<ErrorPlace>(['projects-page', 'merge-bar'])), 'toast', 'no place of its own')
})

test('errors read as their message, whatever was thrown', () => {
  assert.equal(describeError(new Error('boom')), 'boom')
  assert.equal(describeError('plain'), 'plain')
})

test('the same toast again counts up instead of stacking, and a full stack drops its oldest', () => {
  let state = pushToast(emptyToasts(), 'error', 'a')
  state = pushToast(state, 'error', 'a')
  assert.deepEqual(state.toasts.map((toast) => [toast.text, toast.repeats]), [['a', 2]])
  assert.equal(pushToast(state, 'info', 'a').toasts.length, 2, 'a note and an error are not twins')

  for (let i = 0; i < MAX_TOASTS; i += 1) state = pushToast(state, 'error', `b${i}`)
  assert.equal(state.toasts.length, MAX_TOASTS)
  assert.deepEqual(state.toasts.map((toast) => toast.text), ['b0', 'b1', 'b2'])
})

test('dismissing an id that is gone changes nothing; an error outlives a note', () => {
  const state = pushToast(emptyToasts(), 'info', 'a')
  assert.equal(dismissToast(state, 99), state)
  assert.deepEqual(dismissToast(state, state.toasts[0]!.id).toasts, [])
  assert.ok(TOAST_LIFETIME_MS.error > TOAST_LIFETIME_MS.info)
})
