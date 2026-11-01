import test from 'node:test'
import assert from 'node:assert/strict'
import { InteractionAttention } from '../src/desktop/interactionAttention.js'
import { interactionNotificationEnabled, type InteractionNotificationKind, type NotificationSettings } from '../src/config/notifications.js'

function harness(supported = true) {
  let hidden = false, shown = 0, closed = 0
  const queue: Array<() => void> = []
  const notices: Array<{ click(): void; close(): void }> = []
  let settings: NotificationSettings = {}
  let sequence = 0
  const kindsShown: InteractionNotificationKind[][] = []
  const attention = new InteractionAttention({
    unfocused: () => hidden,
    enabled: (kind) => interactionNotificationEnabled(settings, kind),
    show: () => { shown++; hidden = false },
    schedule: (callback) => { queue.push(callback) },
    notify(kinds, _title, click, done) {
      if (!supported) return undefined
      kindsShown.push([...kinds])
      const notice = { click, close() { closed++; done() } }
      notices.push(notice)
      return notice
    },
  })
  const source = (kind: InteractionNotificationKind = 'permission') => {
    let pending = false, activated = 0
    let id = ''
    const listeners = new Set<() => void>()
    const key = {}
    const off = attention.watch(key, {
      pending: () => pending ? [{ id, kind }] : [],
      subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      activate: () => { activated++ },
    })
    return { off, listeners, activated: () => activated, set(value: boolean) { if (value && !pending) id = `${++sequence}`; pending = value; for (const listener of listeners) listener() } }
  }
  return {
    attention, notices, source, kindsShown, stats: () => ({ shown, closed }),
    preferences(value: NotificationSettings) { settings = value; attention.refresh() },
    hide() { hidden = true; attention.refresh() },
    focus() { hidden = false; attention.refresh() },
    flush() { while (queue.length) queue.shift()!() },
  }
}

test('hiding an existing prompt and concurrent new prompts produces one notice', () => {
  const h = harness(), a = h.source(), b = h.source()
  a.set(true)
  h.flush()
  assert.equal(h.notices.length, 0)
  h.hide()
  b.set(true)
  h.flush()
  assert.equal(h.notices.length, 1)
  a.set(true)
  h.flush()
  assert.equal(h.notices.length, 1)
  a.set(false)
  h.notices[0]!.click()
  assert.equal(a.activated(), 0)
  assert.equal(b.activated(), 1, 'click resolves the current pending lane')
  assert.equal(h.stats().shown, 1)
  h.attention.dispose()
  assert.equal(a.listeners.size, 0)
})

test('closed lanes and completed prompts do not get activated by an old notice', () => {
  const h = harness(), a = h.source()
  h.hide()
  a.set(true)
  h.flush()
  const notice = h.notices[0]!
  a.off()
  h.flush()
  notice.click()
  assert.equal(a.activated(), 0)
  assert.equal(h.stats().shown, 1)
  h.attention.dispose()
  notice.click()
  assert.equal(h.stats().shown, 1)
})

test('unsupported notifications keep prompts intact and dispose cancels queued work', () => {
  const h = harness(false), a = h.source()
  h.hide()
  a.set(true)
  h.flush()
  assert.equal(h.notices.length, 0)
  assert.equal(a.activated(), 0)
  h.attention.refresh()
  h.attention.dispose()
  h.flush()
  assert.equal(a.listeners.size, 0)
})

test('permission and question preferences filter independently and close disabled notices', () => {
  const h = harness(), permission = h.source(), question = h.source('question')
  h.preferences({ permissions: false })
  h.hide()
  permission.set(true)
  h.flush()
  assert.equal(h.notices.length, 0)
  question.set(true)
  h.flush()
  assert.deepEqual(h.kindsShown, [['question']])
  h.preferences({ permissions: false, questions: false })
  h.flush()
  assert.equal(h.stats().closed, 1)
  h.preferences({ questions: false })
  h.flush()
  assert.deepEqual(h.kindsShown, [['question'], ['permission']])
  h.notices.at(-1)!.click()
  assert.equal(permission.activated(), 1)
  assert.equal(question.activated(), 0)
  h.attention.dispose()
})

test('returning to focus closes reminders without repeating the same request on blur', () => {
  const h = harness(), a = h.source()
  h.hide()
  a.set(true)
  h.flush()
  h.focus()
  h.flush()
  assert.equal(h.stats().closed, 1)
  h.hide()
  h.flush()
  assert.equal(h.notices.length, 1)
  a.set(false)
  a.set(true)
  h.flush()
  assert.equal(h.notices.length, 2, 'a new request is distinct even between scheduled refreshes')
  a.set(false)
  h.flush()
  assert.equal(h.stats().closed, 2)
  h.attention.dispose()
})
