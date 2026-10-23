import assert from 'node:assert/strict'
import test from 'node:test'

import { describeError, errorDetailText, errorPlace, errorText, type ErrorPlace } from '../src/desktop/renderer/model/errorReport.js'
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

/**
 * The main process and the host throw in English. Left alone, 「打开会话失败：」
 * was followed by `ENOENT: no such file or directory, open '…'`. The system's
 * own messages are worded in Chinese, keeping the path; anything unrecognised
 * passes through rather than being guessed at.
 */
test('the system’s own English errors read in Chinese, keeping the path they name', () => {
  assert.equal(errorDetailText("ENOENT: no such file or directory, open '/w/a.json'"), '文件或目录不存在：/w/a.json')
  assert.equal(errorDetailText("EACCES: permission denied, mkdir '/root/x'"), '没有权限：/root/x')
  assert.equal(errorDetailText('ENOSPC: no space left on device'), '磁盘空间不足')
  assert.equal(errorDetailText('spawn code ENOENT'), '找不到命令 code')
  assert.equal(errorDetailText('The shell host disconnected.'), '与应用后台的连接已断开')
  assert.equal(errorDetailText('EWHATEVER: odd'), 'EWHATEVER: odd', 'an unknown code is left alone')
  assert.equal(errorDetailText('模型不存在'), '模型不存在')
  assert.equal(errorText({ action: '打开会话' }, "ENOENT: no such file or directory, open '/s.jsonl'"), '打开会话失败：文件或目录不存在：/s.jsonl')
})

test('a toast can carry one action, and a repeat rebinds it to the latest attempt', () => {
  const first = () => {}
  const second = () => {}
  let state = pushToast(emptyToasts(), 'error', 'a', { label: '重试', run: first })
  state = pushToast(state, 'error', 'a', { label: '重试', run: second })
  assert.equal(state.toasts.length, 1)
  assert.equal(state.toasts[0]!.action?.run, second)
  assert.equal(pushToast(emptyToasts(), 'info', 'b').toasts[0]!.action, undefined)
})
