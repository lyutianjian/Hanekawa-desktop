import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createBackgroundTasksView, type BackgroundTasksHandlers } from '../src/desktop/renderer/dom/backgroundTasksView.js'
import type { BackgroundTaskRow, TaskGroup } from '../src/desktop/renderer/model/backgroundTasks.js'
import { COPY_RECEIPT_MS } from '../src/desktop/renderer/dom/copyButton.js'

const live: BackgroundTaskRow = { id: 't1', kind: 'shell', title: 'npm run dev', command: 'npm run dev', tone: 'running', running: true, status: '运行中', startedAt: 0 }
const done: BackgroundTaskRow = { id: 't2', kind: 'shell', title: '验证任务面板并检查类型', command: 'npm test -- test/rendererCommandsPanelView.test.ts &&\n  npm run typecheck', tone: 'muted', running: false, status: '已完成 · exit 0', startedAt: 0, durationMs: 75_000 }
const agent: BackgroundTaskRow = { id: 'a1', kind: 'agent', title: '核对工具权限', tone: 'running', running: true, status: '执行中', startedAt: 0, model: 'deepseek' }

function find(view: StubView | undefined, name: string): StubView | undefined {
  if (view?.classes.includes(name)) return view
  return view?.children.map((child) => find(child, name)).find((child) => child !== undefined)
}

function fixture(t: TestContext, handlers: Partial<BackgroundTasksHandlers> = {}) {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const containers = { running: stub.createContainer('running'), finished: stub.createContainer('finished') }
  const view = createBackgroundTasksView(containers, { loadOutput: async () => '', onSelectAgent: () => {}, onStop: () => {}, onClearFinished: () => {}, ...handlers })
  t.after(() => view.render(undefined))
  return {
    stub, view,
    rows: (group: TaskGroup) => stub.inspect(containers[group]).children,
    render(rows: readonly BackgroundTaskRow[], open: readonly TaskGroup[] = ['running', 'finished'], sessionId = 's1') {
      view.render({ sessionId, groups: { running: rows.filter((row) => row.running), finished: rows.filter((row) => !row.running) }, open: new Set(open) })
    },
  }
}

test('clearing finished tasks only hides the click-time set, even when folded; new completions still appear', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let cleared = 0
  const serviceCalls: string[] = []
  const f = fixture(t, {
    onClearFinished: () => { cleared += 1 },
    loadOutput: async (id) => { serviceCalls.push(`load:${id}`); return '' },
    onStop: (row) => serviceCalls.push(`stop:${row.id}`),
    onSelectAgent: (id) => serviceCalls.push(`agent:${id}`),
  })
  const clear = f.view.clearButton
  f.render([live])
  assert.equal(f.stub.inspect(clear).attributes.get('aria-disabled'), 'true')
  assert.equal(f.stub.inspect(clear).disabled, false, 'the ghost button remains keyboard reachable')
  f.stub.click(clear)
  assert.equal(cleared, 0)

  const sameIdAgent = { ...agent, id: done.id }
  const failedAgent: BackgroundTaskRow = { ...agent, id: 'a2', running: false, tone: 'danger', status: '失败' }
  const source = [live, sameIdAgent, done, failedAgent]
  f.render(source, ['running'])
  assert.equal(f.rows('finished').length, 0, 'finished is folded before clearing')
  assert.equal(f.stub.inspect(clear).attributes.get('aria-disabled'), 'false')
  assert.match(f.stub.inspect(clear).attributes.get('aria-label') ?? '', /清空已完成任务/)
  f.stub.click(clear)
  assert.equal(cleared, 1)
  assert.equal(f.stub.inspect(clear).attributes.get('aria-disabled'), 'true')
  assert.equal(f.rows('running').length, 2, 'running tasks are untouched')
  const groups = { running: [live, sameIdAgent], finished: [done, failedAgent] }
  assert.deepEqual(f.view.visibleGroups('s1', groups).finished, [])
  assert.equal(f.view.visibleGroups('s1', groups).running, groups.running)
  assert.deepEqual(groups.finished, [done, failedAgent], 'the real task snapshot is not mutated')
  f.render(source)
  assert.equal(f.rows('finished').length, 0, 'unfolding cannot restore cleared rows')
  assert.deepEqual(serviceCalls, [], 'clearing never loads, stops, or opens a real task')

  const newlyFinished: BackgroundTaskRow = { ...live, running: false, tone: 'muted', status: '已完成 · exit 0' }
  const newlyFinishedAgent: BackgroundTaskRow = { ...sameIdAgent, running: false, tone: 'muted', status: '完成' }
  f.render([newlyFinished, newlyFinishedAgent, done, failedAgent])
  assert.deepEqual(f.rows('finished').map((row) => find(row, 'bt-text')?.text), [live.title, agent.title], 'kind plus id keeps a new agent completion separate from the cleared shell')
  assert.equal(f.stub.inspect(clear).attributes.get('aria-disabled'), 'false')
  f.view.render(undefined)
  f.stub.click(clear)
  assert.equal(cleared, 1, 'a hidden panel cannot clear a stale session')
  f.render([newlyFinished, newlyFinishedAgent, done, failedAgent])
  assert.equal(f.rows('finished').length, 2, 'closing the panel retains its cleared set')
  f.stub.click(clear)
  assert.equal(f.rows('finished').length, 0)
})

test('cleared tasks are remembered per session in this view, but a fresh view restores them', (t) => {
  const f = fixture(t)
  f.render([done])
  f.stub.click(f.view.clearButton)
  assert.equal(f.rows('finished').length, 0)
  f.render([done], ['finished'], 's2')
  assert.equal(f.rows('finished').length, 1, 'the same task id in another session is not cleared')
  f.render([done], ['finished'], 's1')
  assert.equal(f.rows('finished').length, 0, 'switching back remembers the first session')
  f.render([done], ['finished'], 's2')
  f.stub.click(f.view.clearButton)
  const later: BackgroundTaskRow = { ...done, id: 'later' }
  f.render([done, later], ['finished'], 's1')
  assert.equal(f.rows('finished').length, 1)
  f.render([done], ['finished'], 's2')
  assert.equal(f.rows('finished').length, 0)

  const containers = { running: f.stub.createContainer('restart-running'), finished: f.stub.createContainer('restart-finished') }
  const restarted = createBackgroundTasksView(containers, { loadOutput: async () => '', onSelectAgent: () => {}, onStop: () => {}, onClearFinished: () => {} })
  t.after(() => restarted.render(undefined))
  restarted.render({ sessionId: 's1', groups: { running: [], finished: [done] }, open: new Set(['finished']) })
  assert.equal(f.stub.inspect(containers.finished).children.length, 1, 'dismissal is not persisted across renderer restarts')
})

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
  assert.deepEqual(f.rows('running').map((row) => find(row, 'bt-text')?.text), ['npm run dev', '核对工具权限'])
  assert.equal(find(f.rows('running')[1], 'bt-model')?.text, 'deepseek')
  assert.equal(f.rows('running')[1]?.text.includes('子代理'), false)
  assert.equal(find(f.rows('running')[0], 'bt-chevron'), undefined, 'the command title itself is the disclosure')
  assert.equal(find(f.rows('running')[0], 'bt-head')?.attributes.get('aria-expanded'), 'false')
  assert.equal(find(f.rows('running')[0], 'bt-meta'), undefined, 'collapsed commands keep a single title line')
  assert.equal(find(f.rows('running')[1], 'bt-chevron'), undefined, 'an agent opens a detail page, not an inline disclosure')
  assert.equal(find(f.rows('finished')[0], 'bt-time'), undefined, 'elapsed time belongs in command details')
  assert.equal(find(f.rows('finished')[0], 'bt-text')?.text, done.title)
  assert.equal(find(f.rows('finished')[0], 'bt-command'), undefined)
  assert.ok(find(f.rows('finished')[0], 'bt-chevron'), 'finished commands show a detail arrow')
  assert.equal(f.rows('finished')[0]?.text.includes(done.command!), false, 'the collapsed card only shows its description')
  assert.equal(find(f.rows('finished')[0], 'bt-stop'), undefined)
  f.stub.click(find(f.rows('running')[0], 'bt-stop')!.node)
  f.stub.click(find(f.rows('running')[1], 'bt-stop')!.node)
  assert.deepEqual(stopped, ['shell:t1', 'agent:a1'])
  f.stub.click(find(f.rows('running')[1], 'bt-head')!.node)
  assert.deepEqual(selected, ['a1'])
  assert.equal(asked.length, 0, 'viewing an agent never asks for shell output')

  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  await settle()
  assert.ok(asked.includes('t2'))
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'ok 12 tests')
  assert.equal(find(f.rows('finished')[0], 'bt-head')?.attributes.get('aria-expanded'), 'true')
  assert.equal(find(f.rows('finished')[0], 'bt-chevron')?.classes.includes('open'), true)
  assert.equal(find(f.rows('finished')[0], 'bt-output-status'), undefined)
  assert.equal(find(f.rows('finished')[0], 'bt-command-text')?.text, done.command)
  assert.ok(find(f.rows('finished')[0], 'syn-function'), 'expanded shell commands reuse syntax highlighting')
  assert.equal(find(f.rows('finished')[0], 'bt-command-prompt')?.attributes.get('aria-hidden'), 'true')
  assert.equal(find(find(f.rows('finished')[0], 'bt-meta'), 'bt-status')?.text, done.status)
  assert.equal(find(f.rows('finished')[0], 'bt-time')?.text, '1 分 15 秒')
  assert.deepEqual(f.rows('finished')[0]?.children.map((child) => child.classes[0]), ['bt-head', 'bt-command', 'bt-output', 'bt-meta'])
  assert.deepEqual(find(f.rows('finished')[0], 'bt-output')?.children.map((child) => child.classes[0]), ['command-output', 'step-output-copy'])
  assert.equal(find(f.rows('finished')[0], 'command-output')?.classes.includes('step-terminal'), true)
  assert.equal(find(f.rows('finished')[0], 'command-output')?.attributes.get('tabindex'), '0')
  const before = find(f.rows('finished')[0], 'command-output')!.node
  f.render([live, agent, done])
  assert.equal(find(f.rows('finished')[0], 'command-output')?.node, before)
  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  assert.equal(find(f.rows('finished')[0], 'bt-command'), undefined)
  assert.equal(find(f.rows('finished')[0], 'command-output'), undefined)
})

test('failed tasks keep a visible failure label beside the title and still open their own details', async (t) => {
  const selected: string[] = []
  const failed: BackgroundTaskRow = { ...done, tone: 'danger', status: '失败 · exit 1' }
  const failedAgent: BackgroundTaskRow = { ...agent, running: false, tone: 'danger', status: '失败', tokens: 12_300 }
  const f = fixture(t, { loadOutput: async () => 'build failed', onSelectAgent: (id) => selected.push(id) })
  f.render([failed, failedAgent])
  for (const row of f.rows('finished')) {
    assert.equal(find(find(row, 'bt-title'), 'bt-failure')?.text, '失败')
    assert.ok(find(row, 'bt-chevron'))
    assert.equal(find(row, 'bt-stop'), undefined)
  }
  assert.equal(find(f.rows('finished')[0], 'bt-text')?.text, done.title)
  assert.equal(find(f.rows('finished')[1], 'bt-tokens')?.text, '12k token')
  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  await settle()
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'build failed')
  assert.equal(find(f.rows('finished')[0], 'bt-status')?.text, failed.status)
  f.stub.click(find(f.rows('finished')[1], 'bt-head')!.node)
  assert.deepEqual(selected, [agent.id])
})

test('command output copies the entire latest text, not the empty placeholder, with the shared receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const copied: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: async (text: string) => { copied.push(text) } } },
  })
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  })
  let output = ''
  const f = fixture(t, { loadOutput: async () => output })
  f.render([live])
  f.stub.click(find(f.rows('running')[0], 'bt-head')!.node)
  await settle()
  const copy = find(f.rows('running')[0], 'step-output-copy')!.node
  f.stub.click(copy)
  await settle()
  assert.deepEqual(copied, [''], 'the placeholder is not command output')
  assert.equal(f.stub.inspect(copy).attributes.get('aria-label'), '已复制')
  t.mock.timers.tick(COPY_RECEIPT_MS)
  await settle()
  assert.equal(f.stub.inspect(copy).attributes.get('aria-label'), '复制输出')

  output = Array.from({ length: 400 }, (_, i) => `line ${i}: 完整输出`).join('\n') + '\n'
  t.mock.timers.tick(1000)
  await settle()
  assert.equal(find(f.rows('running')[0], 'command-output')?.text, output)
  f.stub.click(copy)
  await settle()
  assert.equal(copied.at(-1), output, 'copy reads new output without truncating it to the visible scroll window')
})

test('a failed output read says so and offers a retry', async (t) => {
  let fail = true
  const f = fixture(t, { loadOutput: async () => { if (fail) throw new Error('host gone'); return 'ok' } })
  f.render([done])
  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, '还没有输出')
  await settle()
  const failure = find(f.rows('finished')[0], 'load-error')
  assert.equal(failure?.text.includes('无法读取输出：host gone'), true)
  fail = false
  f.stub.click(find(failure, 'load-retry')!.node)
  await settle()
  assert.equal(find(f.rows('finished')[0], 'load-error'), undefined)
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'ok')
})

test('agent previews show model and tokens without a live or settled clock', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const f = fixture(t)
  const finished = { ...agent, id: 'a2', tone: 'muted' as const, running: false, status: '完成', tokens: 12_300, durationMs: 75_000 }
  f.render([agent, finished])
  assert.equal(find(f.rows('running')[0], 'bt-time'), undefined)
  assert.equal(find(f.rows('running')[0], 'bt-tokens'), undefined, 'missing usage is not reported as zero')
  assert.equal(find(f.rows('finished')[0], 'bt-tokens')?.text, '12k token')
  assert.equal(find(find(f.rows('finished')[0], 'bt-head'), 'bt-model')?.text, 'deepseek')
  assert.equal(find(find(f.rows('finished')[0], 'bt-head'), 'bt-tokens')?.text, '12k token', 'usage stays outside the detail page')
  assert.ok(find(f.rows('finished')[0], 'bt-chevron'), 'finished agents show a detail affordance instead of a stop button')
  assert.equal(find(f.rows('finished')[0], 'bt-stop'), undefined)
  assert.equal(find(f.rows('finished')[0], 'bt-time'), undefined)
  t.mock.timers.tick(5_000)
  assert.equal(find(f.rows('running')[0], 'bt-time'), undefined)
  assert.equal(find(f.rows('finished')[0], 'bt-tokens')?.text, '12k token')
})

test('folded or hidden groups stop polling; a finished command keeps its output disclosure when moved', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  let reads = 0
  const f = fixture(t, { loadOutput: async () => `read ${++reads}` })
  f.render([live, agent, done], ['running'])
  assert.equal(f.rows('finished').length, 0)
  f.stub.click(find(f.rows('running')[0], 'bt-head')!.node)
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
  assert.deepEqual(f.rows('running').map((row) => find(row, 'bt-text')?.text), ['核对工具权限'])
  assert.equal(f.rows('finished').length, 0, 'finishing a task never opens the finished group')
  f.render([finished, agent, done])
  await settle()
  assert.equal(find(f.rows('finished')[0], 'bt-head')?.attributes.get('aria-expanded'), 'true')
  assert.equal(find(f.rows('finished')[0], 'bt-stop'), undefined)
  assert.equal(find(f.rows('finished')[0], 'bt-time')?.text, '10 秒')
})

test('a session switch clears command disclosures and ignores an old output read with the same task id', async (t) => {
  let resolveOld!: (value: string) => void
  let calls = 0
  const f = fixture(t, { loadOutput: async () => {
    calls += 1
    return calls === 1 ? new Promise<string>((resolve) => { resolveOld = resolve }) : 'new output'
  } })
  f.render([done])
  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  f.render([done], ['finished'], 's2')
  assert.equal(find(f.rows('finished')[0], 'command-output'), undefined)
  f.stub.click(find(f.rows('finished')[0], 'bt-head')!.node)
  await settle()
  resolveOld('old output')
  await settle()
  assert.equal(find(f.rows('finished')[0], 'command-output')?.text, 'new output')
})
