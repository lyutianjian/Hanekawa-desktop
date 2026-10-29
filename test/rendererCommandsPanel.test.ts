import assert from 'node:assert/strict'
import test from 'node:test'
import { commandRows, formatElapsed } from '../src/desktop/renderer/model/commandsPanel.js'
import { backgroundTaskGroups } from '../src/desktop/renderer/model/backgroundTasks.js'
import type { SubagentEntry } from '../src/desktop/renderer/model/subagentPanel.js'
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
  assert.deepEqual([formatElapsed(-5), formatElapsed(59_999), formatElapsed(75_000), formatElapsed(3_725_000)], ['0 秒', '59 秒', '1 分 15 秒', '1 小时 2 分'])
})

test('shells and agents mix by time, without duplicating registered agents or treating failures as successes', () => {
  const agents: SubagentEntry[] = [
    { id: 'agent-live', name: '子代理', description: '核对权限', status: 'running', finished: false, notes: [], startedAt: 2_000 },
    { id: 'agent-done', name: '子代理', description: '阅读工具', status: 'done', finished: true, notes: [], startedAt: 100, durationMs: 100, tokens: 5_000 },
    { id: 'agent-wait', name: '子代理', description: '等待许可', status: 'awaiting-approval', finished: false, notes: [], startedAt: 1_500 },
    { id: 'agent-stopped', name: '子代理', description: '扫描目录', status: 'interrupted', finished: true, notes: [], startedAt: 2_000, durationMs: 1_500 },
  ]
  const groups = backgroundTaskGroups([
    task({ id: 'live', status: 'running', command: 'npm run dev', startedAt: 1_000 }),
    task({ id: 'fail', status: 'failed', command: 'npm test', startedAt: 500, finishedAt: 4_000, exitCode: 1 }),
    task({ id: 'registered-live', kind: 'agent', toolUseId: 'agent-live', status: 'running', startedAt: 2_000 }),
    task({ id: 'registered-done', kind: 'agent', toolUseId: 'agent-done', status: 'completed', startedAt: 1_000, finishedAt: 3_000 }),
  ], agents)
  assert.deepEqual(groups.running.map((row) => row.id), ['live', 'agent-wait', 'agent-live'])
  assert.deepEqual(groups.finished.map((row) => row.id), ['fail', 'agent-stopped', 'agent-done'])
  assert.equal(groups.running[1]?.tone, 'attention')
  assert.equal(groups.running[2]?.title, '核对权限')
  assert.equal(groups.finished[0]?.status, '失败 · exit 1')
  assert.equal(groups.finished[1]?.status, '已中断')
  assert.equal(groups.finished[2]?.durationMs, 2_000)
  assert.equal(groups.finished[2]?.tokens, 5_000)
})
