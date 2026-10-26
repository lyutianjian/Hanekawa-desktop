import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createBackgroundTasksView, type BackgroundTasksHandlers } from '../src/desktop/renderer/dom/backgroundTasksView.js'
import type { BackgroundTaskRow, TaskGroup } from '../src/desktop/renderer/model/backgroundTasks.js'

const live: BackgroundTaskRow = { id: 't1', kind: 'shell', title: 'npm run dev', tone: 'running', running: true, status: '运行中', startedAt: 0 }
const done: BackgroundTaskRow = { id: 't2', kind: 'shell', title: 'npm test', tone: 'muted', running: false, status: '已完成 · exit 0', startedAt: 0, durationMs: 75_000 }
const agent: BackgroundTaskRow = { id: 'a1', kind: 'agent', title: '核对工具权限', tone: 'running', running: true, status: '执行中', startedAt: 0, model: 'deepseek' }

function find(view: StubView | undefined, name: string): StubView | undefined {
  if (view?.classes.includes(name)) return view
  return view?.children.map((child) => find(child, name)).find((child) => child !== undefined)
}

function fixture(t: TestContext, handlers: Partial<BackgroundTasksHandlers> = {}) {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const containers = { running: stub.createContainer('running'), finished: stub.createContainer('finished') }
  const view = createBackgroundTasksView(containers, { loadOutput: async () => '', onSelectAgent: () => {}, onStop: () => {}, ...handlers })
  t.after(() => view.render(undefined))
  return {
    stub, view,
    rows: (group: TaskGroup) => stub.inspect(containers[group]).children,
    render(rows: readonly BackgroundTaskRow[], open: readonly TaskGroup[] = ['running', 'finished'], sessionId = 's1') {
      view.render({ sessionId, groups: { running: rows.filter((row) => row.running), finished: rows.filter((row) => !row.running) }, open: new Set(open) })
    },
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

test('commands and agents share rows; each opens its own detail and only running tasks can stop', async (t) => {
  const asked: string[] = []
  const stopped: string[] = []
  const selected: string[] = []
  const f = fixture(t, {
    loadOutput: async (id) => { asked.push(id); return 'ok 12 tests' },
    onStop: (row) => stopped.push(`${row.kind}:${row.id}`),
    onSelectAgent: (id) => selected.push(id),
  })
  f.render([live, agent, done])
  assert.deepEqual(f.rows('running').map((row) => find(row, 'task-text')?.text), ['npm run dev', '核对工具权限'])
  assert.equal(find(f.rows('running')[1], 'task-model')?.text, 'deepseek')
  assert.equal(f.rows('running')[1]?.text.includes('子代理'), false)
  assert.equal(find(f.rows('finished')[0], 'task-time')?.text, '1 分 15 秒')
  assert.equal(find(f.rows('finished')[0], 'task-stop'), undefined)
  f.stub.click(find(f.rows('running')[0], 'task-stop')!.node)
  f.stub.click(find(f.rows('running')[1], 'task-stop')!.node)
  assert.deepEqual(stopped, ['shell:t1', 'agent:a1'])
  f.stub.click(find(f.rows('running')[1], 'task-head')!.node)
  assert.deepEqual(selected, ['a1'])
  assert.equal(asked.length, 0, 'viewing an agent never asks for shell output')

  f.stub.click(find(f.rows('finished')[0], 'task-head')!.node)
  await settle()
  assert.ok(asked.includes('t2'))
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'ok 12 tests')
  assert.equal(find(f.rows('finished')[0], 'task-head')?.attributes.get('aria-expanded'), 'true')
  assert.equal(find(f.rows('finished')[0], 'task-output-status')?.text, '已完成 · exit 0')
  const before = find(f.rows('finished')[0], 'command-output')!.node
  f.render([live, agent, done])
  assert.equal(find(f.rows('finished')[0], 'command-output')?.node, before)
})

test('a failed output read says so and offers a retry', async (t) => {
  let fail = true
  const f = fixture(t, { loadOutput: async () => { if (fail) throw new Error('host gone'); return 'ok' } })
  f.render([done])
  f.stub.click(find(f.rows('finished')[0], 'task-head')!.node)
  await settle()
  const failure = find(f.rows('finished')[0], 'load-error')
  assert.equal(failure?.text.includes('无法读取输出：host gone'), true)
  fail = false
  f.stub.click(find(failure, 'load-retry')!.node)
  await settle()
  assert.equal(find(f.rows('finished')[0], 'load-error'), undefined)
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'ok')
})

test('folded or hidden groups stop polling; a finished command keeps its output disclosure when moved', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let reads = 0
  const f = fixture(t, { loadOutput: async () => `read ${++reads}` })
  f.render([live, agent, done], ['running'])
  assert.equal(f.rows('finished').length, 0)
  f.stub.click(find(f.rows('running')[0], 'task-head')!.node)
  await settle()
  f.render([live, agent, done], [])
  const folded = reads
  t.mock.timers.tick(5_000)
  await settle()
  assert.equal(reads, folded)
  f.render([live, agent, done], ['running'])
  await settle()
  assert.ok(reads > folded, 'unfolding catches up the output')
  f.view.render(undefined)
  const hidden = reads
  t.mock.timers.tick(5_000)
  await settle()
  assert.equal(reads, hidden)

  const finished: BackgroundTaskRow = { ...live, running: false, tone: 'muted', status: '已完成 · exit 0', durationMs: 10_000 }
  f.render([finished, agent, done], ['running'])
  assert.deepEqual(f.rows('running').map((row) => find(row, 'task-text')?.text), ['核对工具权限'])
  assert.equal(f.rows('finished').length, 0, 'finishing a task never opens the finished group')
  f.render([finished, agent, done])
  await settle()
  assert.equal(find(f.rows('finished')[0], 'task-head')?.attributes.get('aria-expanded'), 'true')
  assert.equal(find(f.rows('finished')[0], 'task-stop'), undefined)
  assert.equal(find(f.rows('finished')[0], 'task-time')?.text, '10 秒')
})

test('a session switch clears command disclosures and ignores an old output read with the same task id', async (t) => {
  let resolveOld!: (value: string) => void
  let calls = 0
  const f = fixture(t, { loadOutput: async () => {
    calls += 1
    return calls === 1 ? new Promise<string>((resolve) => { resolveOld = resolve }) : 'new output'
  } })
  f.render([done])
  f.stub.click(find(f.rows('finished')[0], 'task-head')!.node)
  f.render([done], ['finished'], 's2')
  assert.equal(find(f.rows('finished')[0], 'command-output'), undefined)
  f.stub.click(find(f.rows('finished')[0], 'task-head')!.node)
  await settle()
  resolveOld('old output')
  await settle()
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'new output')
})
