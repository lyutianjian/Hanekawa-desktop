import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { createToastHost } from '../src/desktop/renderer/dom/toastView.js'
import { PRESENCE_FALLBACK_MS } from '../src/desktop/renderer/model/presence.js'
import { MAX_TOASTS, TOAST_LIFETIME_MS } from '../src/desktop/renderer/model/toasts.js'
import { installDomStub, type StubView } from './helpers/domStub.js'

/**
 * The toast stack's nodes and clocks. The stack's rules (dedupe, the cap) are
 * `model/toasts.ts`; what is checked here is what a reader sees and does.
 */

function mount(t: TestContext) {
  const stub = installDomStub()
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const container = stub.createContainer('toasts')
  const host = createToastHost(container)
  t.after(() => {
    host.dispose()
    stub.uninstall()
  })
  const toasts = (): StubView[] => stub.inspect(container).children.filter((child) => child.classes.includes('toast'))
  /** Past the exit animation, so a closed toast has left the DOM. */
  const settle = (): void => t.mock.timers.tick(PRESENCE_FALLBACK_MS.popover)
  return { stub, host, toasts, settle, tick: (ms: number) => t.mock.timers.tick(ms) }
}

test('an error toast says it as an alert; a note says it as a status', (t) => {
  const { host, toasts } = mount(t)
  host.push('error', '删除会话失败：磁盘已满')
  host.push('info', '已复制')

  assert.deepEqual(toasts().map((toast) => toast.attributes.get('role')), ['alert', 'status'])
  assert.deepEqual(toasts().map((toast) => toast.children[0]!.text), ['删除会话失败：磁盘已满', '已复制'])
})

test('the × closes it, and the toast leaves once its exit has run', (t) => {
  const { stub, host, toasts, settle } = mount(t)
  host.push('error', '出错了')
  const close = toasts()[0]!.children.find((child) => child.classes.includes('toast-close'))
  assert.ok(close, 'a close button')
  assert.equal(close.attributes.get('aria-label'), '关闭')

  stub.click(close.node)
  assert.equal(toasts()[0]!.attributes.get('inert'), '', 'a closing toast takes no more clicks')
  settle()
  assert.equal(toasts().length, 0)
})

test('Escape on a focused toast closes it and does not reach the window', (t) => {
  const { stub, host, toasts, settle } = mount(t)
  host.push('error', '出错了')
  const other = stub.dispatch(toasts()[0]!.node, 'keydown', { key: 'a' })
  assert.equal(other.propagationStopped, false, 'other keys are the window\'s')
  assert.equal(toasts().length, 1)

  const escape = stub.dispatch(toasts()[0]!.node, 'keydown', { key: 'Escape' })
  assert.equal(escape.propagationStopped, true, 'the turn behind it keeps running')
  settle()
  assert.equal(toasts().length, 0)
})

test('a note goes by itself sooner than an error does', (t) => {
  const { host, toasts, settle, tick } = mount(t)
  host.push('error', '出错了')
  host.push('info', '已复制')

  tick(TOAST_LIFETIME_MS.info)
  settle()
  assert.deepEqual(toasts().map((toast) => toast.classes.includes('error')), [true])
  tick(TOAST_LIFETIME_MS.error)
  settle()
  assert.equal(toasts().length, 0)
})

test('the clock waits while the pointer or focus is on the toast, then runs what was left', (t) => {
  const { stub, host, toasts, settle, tick } = mount(t)
  host.push('error', '出错了')
  const node = toasts()[0]!.node
  tick(TOAST_LIFETIME_MS.error - 1000)

  stub.dispatch(node, 'pointerenter')
  tick(60_000)
  settle()
  assert.equal(toasts().length, 1, 'held under the pointer')

  stub.dispatch(node, 'pointerleave')
  tick(999)
  assert.equal(toasts().length, 1, 'the second it had left is still owed')
  tick(1)
  settle()
  assert.equal(toasts().length, 0)

  host.push('info', '已复制')
  const note = toasts()[0]!.node
  stub.dispatch(note, 'focusin')
  tick(60_000)
  settle()
  assert.equal(toasts().length, 1, 'held by focus')
  stub.dispatch(note, 'focusout')
  tick(TOAST_LIFETIME_MS.info)
  settle()
  assert.equal(toasts().length, 0)
})

test('the same message again counts on the toast showing and starts its clock over', (t) => {
  const { host, toasts, tick } = mount(t)
  host.push('error', '出错了')
  tick(TOAST_LIFETIME_MS.error - 1)
  host.push('error', '出错了')

  assert.equal(toasts().length, 1)
  assert.equal(toasts()[0]!.children.find((child) => child.classes.includes('toast-repeats'))?.text, '×2')
  tick(TOAST_LIFETIME_MS.error - 1)
  assert.equal(toasts().length, 1, 'the second arrival bought a fresh lifetime')
})

test('a burst stacks at most a few; the oldest makes room', (t) => {
  const { host, toasts, settle } = mount(t)
  for (let i = 0; i < MAX_TOASTS + 2; i += 1) host.push('error', `错误 ${i}`)
  settle()

  assert.equal(toasts().length, MAX_TOASTS)
  assert.deepEqual(toasts().map((toast) => toast.children[0]!.text), ['错误 2', '错误 3', '错误 4'])
})
