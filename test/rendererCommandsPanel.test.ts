import assert from 'node:assert/strict'
import test from 'node:test'
import { commandRows, formatElapsed } from '../src/desktop/renderer/model/commandsPanel.js'
import type { BackgroundTaskSnapshot } from '../src/services/backgroundTasks/registry.js'

function task(overrides: Partial<BackgroundTaskSnapshot> & Pick<BackgroundTaskSnapshot, 'id' | 'status' | 'startedAt'>): BackgroundTaskSnapshot {
  return { sessionId: 's', kind: 'shell', outputBytes: 0, ...overrides }
}

test('commands list running processes first, then the finished ones newest first, without agents', () => {
  const rows = commandRows([
    task({ id: 'old', status: 'completed', command: 'npm run build', startedAt: 1_000, finishedAt: 4_000, exitCode: 0 }),
    task({ id: 'agent', kind: 'agent', status: 'running', agentType: 'explore', startedAt: 9_000 }),
    task({ id: 'new', status: 'failed', command: 'npm test', startedAt: 5_000, finishedAt: 6_000, exitCode: 1 }),
    task({ id: 'live', status: 'running', command: 'npm run dev', startedAt: 2_000 }),
    task({ id: 'gone', status: 'killed', command: 'sleep 9', startedAt: 3_000, finishedAt: 3_500, exitCode: null }),
  ])
  assert.deepEqual(rows.map((row) => [row.id, row.tone, row.running, row.status]), [
    ['live', 'running', true, '运行中'],
    ['new', 'failed', false, '失败 · exit 1'],
    ['gone', 'failed', false, '已停止'],
    ['old', 'done', false, '已完成 · exit 0'],
  ])
  assert.equal(rows[0]!.finishedAt, undefined)
  assert.equal(rows[3]!.command, 'npm run build')
})

test('elapsed time reads in seconds, minutes, then hours', () => {
  assert.deepEqual([formatElapsed(-5), formatElapsed(59_999), formatElapsed(75_000), formatElapsed(3_725_000)], ['0s', '59s', '1m15s', '1h2m'])
})
