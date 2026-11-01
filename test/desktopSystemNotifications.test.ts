import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemNotifications } from '../src/desktop/systemNotifications.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'

const completed: SessionEvent = { type: 'turn-end', failed: false, aborted: false, rolledBack: false, durationMs: 100 }

function harness() {
  let focused = true, supported = true, throws = false, attention = 0, activated = 0
  const errors: unknown[] = []
  const notices: Array<{
    options: { title: string; body: string }
    shown: boolean; closed: boolean
    emit(event: string): void
    close(): void
  }> = []
  const notifications = new SystemNotifications({
    focused: () => focused, supported: () => supported,
    attention: () => { attention++ }, error: (error) => { errors.push(error) },
    create(options) {
      if (throws) throw new Error('native error')
      const events = new Map<string, () => void>()
      const notice = {
        options, shown: false, closed: false,
        on(event: string, listener: () => void) { events.set(event, listener) },
        show() { this.shown = true },
        close() { this.closed = true; this.emit('close') },
        emit(event: string) { events.get(event)?.() },
      }
      notices.push(notice)
      return notice
    },
  })
  return {
    notifications, notices, errors, activate: () => { activated++ },
    focus(value: boolean) { focused = value }, supported(value: boolean) { supported = value },
    throws(value: boolean) { throws = value }, stats: () => ({ attention, activated }),
  }
}

test('completion policies use the current window focus, defaulting to unfocused', () => {
  for (const mode of [undefined, 'never', 'always', 'unfocused'] as const) {
    for (const focused of [true, false]) {
      const h = harness()
      h.notifications.setPreferences(mode ? { turnCompletion: mode } : {})
      h.focus(focused)
      h.notifications.turnEnded(completed, '修复登录', h.activate)
      const expected = mode === 'always' || (mode !== 'never' && !focused)
      assert.equal(h.notices.length, expected ? 1 : 0, `${mode}/${focused}`)
      if (expected) {
        assert.deepEqual(h.notices[0]!.options, { title: 'Hanekawa · 轮次完成', body: '修复登录' })
        h.notices[0]!.emit('click')
        assert.equal(h.stats().activated, 1)
      }
      h.notifications.dispose()
    }
  }
})

test('failed, stopped, rolled-back turns and intermediate events never claim completion', () => {
  const h = harness()
  h.notifications.setPreferences({ turnCompletion: 'always' })
  for (const flags of [{ failed: true }, { aborted: true }, { rolledBack: true }]) {
    h.notifications.turnEnded({ ...completed, ...flags }, '会话', h.activate)
  }
  h.notifications.turnEnded({ type: 'tool-progress' }, '会话', h.activate)
  assert.equal(h.notices.length, 0)
})

test('turn notification callbacks preserve their own session target across multiple sessions', () => {
  const h = harness(), activated: string[] = []
  h.focus(false)
  for (const id of ['first', 'second']) h.notifications.turnEnded(completed, id, () => { activated.push(id) })
  h.notices[0]!.emit('click')
  assert.deepEqual(activated, ['first'])
  h.notices[1]!.emit('click')
  assert.deepEqual(activated, ['first', 'second'])
  assert.ok(h.notices.every((notice) => notice.closed))
})

test('turning completion notifications off dismisses delivered notices immediately', () => {
  const h = harness()
  h.focus(false)
  h.notifications.turnEnded(completed, '会话', h.activate)
  h.notifications.setPreferences({ turnCompletion: 'never' })
  assert.equal(h.notices[0]!.closed, true)
  h.notifications.turnEnded(completed, '会话', h.activate)
  assert.equal(h.notices.length, 1)
})

test('interaction notices name the session and release exactly once on failure or click', () => {
  const h = harness()
  let released = 0
  h.notifications.interaction(['question'], '修复登录', h.activate, () => { released++ })
  assert.match(h.notices[0]!.options.title, /回答/)
  assert.match(h.notices[0]!.options.body, /修复登录/)
  h.notices[0]!.emit('click')
  assert.equal(released, 1)
  assert.equal(h.stats().activated, 1)
  h.notifications.interaction(['permission', 'question'], '另一会话', h.activate, () => { released++ })
  h.notices[1]!.emit('failed')
  h.notices[1]!.emit('close')
  assert.equal(released, 2)
  assert.equal(h.errors.length, 1)
  assert.equal(h.stats().attention, 1)
})

test('unsupported OS and native errors do not break turns or block prompts', () => {
  const h = harness()
  h.focus(false)
  h.supported(false)
  h.notifications.turnEnded(completed, '会话', h.activate)
  h.notifications.interaction(['permission'], '会话', h.activate, () => {})
  assert.equal(h.notices.length, 0)
  assert.equal(h.stats().attention, 1)
  h.supported(true)
  h.throws(true)
  assert.doesNotThrow(() => h.notifications.turnEnded(completed, '会话', h.activate))
  assert.equal(h.errors.length, 1)
})

test('quitting closes native notices and makes old clicks inert', () => {
  const h = harness()
  h.focus(false)
  h.notifications.turnEnded(completed, '会话', h.activate)
  h.notifications.interaction(['permission'], '会话', h.activate, () => {})
  h.notifications.dispose()
  assert.ok(h.notices.every((notice) => notice.closed))
  for (const notice of h.notices) notice.emit('click')
  assert.equal(h.stats().activated, 0)
  h.notifications.turnEnded(completed, '会话', h.activate)
  assert.equal(h.notices.length, 2)
})
