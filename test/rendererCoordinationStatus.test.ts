import test from 'node:test'
import assert from 'node:assert/strict'
import {
  THREAD_STATUS_LABEL,
  coordinationCounts,
  formatLastActivity,
  threadBySession,
  threadTone,
} from '../src/desktop/renderer/model/coordinationStatus.js'
import type { WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

const STATUSES = Object.keys(THREAD_STATUS_LABEL) as WireThreadStatus[]

function thread(threadId: string, status: WireThreadStatus, sessionId = `s-${threadId}`): WireThreadInfo {
  return { threadId, sessionId, title: threadId, status, lastActivityAt: '2026-10-10T00:00:00.000Z' }
}

test('every status has a label and a tone', () => {
  assert.equal(STATUSES.length, 9)
  for (const status of STATUSES) {
    assert.ok(THREAD_STATUS_LABEL[status])
    assert.ok(threadTone(status))
  }
  assert.equal(threadTone('needs-you'), 'attention')
  assert.equal(threadTone('awaiting-coordinator'), 'attention')
  assert.equal(threadTone('failed'), 'danger', 'a failed thread is not drawn like an idle one')
  assert.equal(threadTone('interrupted'), 'neutral')
  assert.deepEqual(new Set(Object.values(THREAD_STATUS_LABEL)), new Set(['运行中', '阻塞', '空闲', '失败', '已完成']))
})

test('coordinationCounts counts running and blocked threads', () => {
  const threads = [thread('a', 'running'), thread('b', 'running'), thread('c', 'needs-you'), thread('e', 'awaiting-coordinator'), thread('d', 'idle')]
  assert.deepEqual(coordinationCounts(threads), { running: 2, blocked: 2 })
})

test('formatLastActivity speaks the window\'s one time label', () => {
  // It used to count hours and days (「3 小时前」, 「2 天前」) while the transcript
  // said 「今天 09:00」; both now read through `timeLabel.ts`.
  const now = new Date(2026, 9, 10, 12, 0).getTime()
  assert.equal(formatLastActivity(new Date(now - 30_000).toISOString(), now), '刚刚')
  assert.equal(formatLastActivity(new Date(now - 5 * 60_000).toISOString(), now), '5 分钟前')
  assert.equal(formatLastActivity(new Date(2026, 9, 10, 9, 0).toISOString(), now), '今天 09:00')
  assert.equal(formatLastActivity(new Date(2026, 9, 8, 12, 0).toISOString(), now), '10月8日')
  assert.equal(formatLastActivity(new Date(now + 5 * 60_000).toISOString(), now), '刚刚', 'clock skew reads as just now')
  assert.equal(formatLastActivity('', now), '')
})

test('threadBySession finds the thread behind a session', () => {
  const state = { projectRoot: 'r', threads: [thread('a', 'idle', 's1'), thread('b', 'running', 's2')] }
  assert.equal(threadBySession(state, 's2')?.threadId, 'b')
  assert.equal(threadBySession(state, 'nope'), undefined)
  assert.equal(threadBySession(undefined, 's1'), undefined)
})
