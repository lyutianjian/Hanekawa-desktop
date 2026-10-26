import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createSubagentPanelView } from '../src/desktop/renderer/dom/subagentPanelView.js'
import type { SubagentEntry } from '../src/desktop/renderer/model/subagentPanel.js'
import type { SessionRecord } from '../src/harness/types.js'

/**
 * The subagent page's read failure. It used to be swallowed: a finished run
 * whose transcript could not be read sat on its task/reply fallback with no
 * word why, and nothing to press. It now says so, with 重试.
 *
 * Not in the base TypeScript program (its `lib` has no DOM): excluded there,
 * checked by `tsconfig.domtest.json`.
 */

const entry: SubagentEntry = {
  id: 'call-1',
  agentId: 'agent-1',
  name: 'Explore',
  description: 'look around',
  status: 'done',
  finished: true,
  notes: [],
}

function find(view: StubView, name: string): StubView | undefined {
  if (view.classes.includes(name)) return view
  for (const child of view.children) {
    const hit = find(child, name)
    if (hit) return hit
  }
  return undefined
}

test('agent headings use the short task description, with the type on the detail meta line', () => {
  const stub = installDomStub()
  try {
    const container = stub.createContainer('subagents')
    const selected: Array<string | undefined> = []
    const view = createSubagentPanelView(container, {
      onSelect: (id) => selected.push(id), loadTranscript: async () => [], onOpenPath: () => {},
    })
    const run = { ...entry, name: '子代理', description: '核对工具权限', agentType: 'explore' }
    view.render({ entries: [run], selected: undefined })
    assert.equal(find(stub.inspect(container), 'subagent-name')?.text, '核对工具权限')
    assert.equal(stub.inspect(container).text.includes('子代理'), false)
    view.render({ entries: [run], selected: run.id })
    assert.equal(find(stub.inspect(container), 'subagent-name')?.text, '核对工具权限')
    assert.equal(find(stub.inspect(container), 'subagent-meta')?.text, 'explore · 完成')
    // Stopping belongs to the task list's rows, not to the run's own page.
    assert.equal(find(stub.inspect(container), 'subagent-stop'), undefined)
    stub.click(find(stub.inspect(container), 'subagent-back')!.node)
    assert.deepEqual(selected, [undefined])
  } finally {
    stub.uninstall()
  }
})

test('a transcript that cannot be read says so, and 重试 reads it again', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('subagents')
  let fail = true
  let reads = 0
  const view = createSubagentPanelView(container, {
    onSelect: () => {},
    loadTranscript: async () => {
      reads += 1
      if (fail) throw new Error('file gone')
      return []
    },
    onOpenPath: () => {},
  })
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  view.render({ entries: [entry], selected: 'call-1' })
  await settle()
  const failure = find(stub.inspect(container), 'load-error')!
  assert.equal(failure.hidden, false)
  assert.ok(failure.text.includes('无法读取子代理对话：file gone'))
  assert.equal(failure.attributes.get('role'), 'alert')

  fail = false
  stub.click(find(failure, 'load-retry')!.node)
  await settle()
  assert.equal(reads, 2)
  assert.equal(find(stub.inspect(container), 'load-error')!.hidden, true, 'a good read withdraws it')
})

/**
 * The page's liveness. It re-reads the run's transcript once a second and ticks
 * its clock, and used to do both for as long as the page existed — including for
 * hours after the user had switched the side panel to another tab, since nothing
 * told the panel it was gone. Time is faked here so a "hidden for five seconds"
 * is a tick and not a sleep.
 */

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

const running: SubagentEntry = {
  id: 'call-2',
  agentId: 'agent-2',
  name: 'Explore',
  description: 'keep looking',
  status: 'running',
  finished: false,
  startedAt: 0,
  notes: [],
}

function text(view: StubView, name: string): string {
  const node = find(view, name)
  return node === undefined ? '' : `${node.text}${node.children.map((child) => child.text).join('')}`
}

test('a hidden page stops reading and stops its clock, and comes back in one read', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('subagents')
  let reads = 0
  const view = createSubagentPanelView(container, {
    onSelect: () => {},
    loadTranscript: async () => {
      reads += 1
      return []
    },
    onOpenPath: () => {},
  })

  const startedAt = Date.now()
  view.setVisible(true)
  view.render({ entries: [{ ...running, startedAt }], selected: 'call-2' })
  await flush()
  assert.equal(reads, 1, 'the page it just opened reads once')

  t.mock.timers.tick(1000)
  await flush()
  assert.equal(reads, 2, 'and once a second while it runs')
  assert.equal(text(stub.inspect(container), 'subagent-time'), '1 秒')

  container.scrollTop = 120
  view.setVisible(false)
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(reads, 2, 'nothing is read for a page nobody can see')
  assert.equal(text(stub.inspect(container), 'subagent-time'), '1 秒', 'the clock stops too')

  view.setVisible(true)
  await flush()
  assert.equal(reads, 3, 'showing again catches up in one read, not five')
  assert.equal(text(stub.inspect(container), 'subagent-time'), '6 秒', 'and the clock reads the time that passed')
  assert.equal(stub.inspect(container).scrollTop, 120, 'and the reader is left where they were')

  for (let second = 0; second < 3; second++) {
    t.mock.timers.tick(1000)
    await flush()
  }
  assert.equal(reads, 6, 'exactly one poll is running, not one per show')
})

test('a read that lands after the page was hidden does not paint over it', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('subagents')
  const records: SessionRecord[] = [{ type: 'message', id: 'm1', role: 'user', content: 'hello', createdAt: 'now' }]
  let release = (_: readonly SessionRecord[]) => {}
  let reads = 0
  const view = createSubagentPanelView(container, {
    onSelect: () => {},
    loadTranscript: () => {
      reads += 1
      if (reads === 1) return new Promise((resolve) => { release = resolve })
      return Promise.resolve(records)
    },
    onOpenPath: () => {},
  })
  const timeline = () => find(stub.inspect(container), 'subagent-transcript')!

  view.setVisible(true)
  view.render({ entries: [running], selected: 'call-2' })
  await flush()
  assert.equal(reads, 1)
  assert.equal(timeline().hidden, true, 'the fallback shows until the transcript arrives')

  view.setVisible(false)
  release(records)
  await flush()
  assert.equal(timeline().hidden, true, 'a read for a page that left the screen paints nothing')

  view.setVisible(true)
  await flush()
  assert.equal(reads, 2, 'coming back asks again rather than waiting on the dropped read')
  assert.equal(timeline().hidden, false, 'and this one is on screen, so it lands')
})

/**
 * The page's turns. It used to render its transcript with no activity at all, so
 * every assistant message drew a meta row of its own — time, 复制 and the model
 * under each sentence, as if each one had settled a turn on its own. One turn has
 * one end, and the row belongs there; a turn still running has none, and says it is
 * running instead.
 */

const turnRecords: SessionRecord[] = [
  { type: 'message', id: 'u1', role: 'user', content: '看一下', turnId: 't1', createdAt: '2026-10-10T00:00:00.000Z' },
  { type: 'message', id: 'a1', role: 'assistant', content: '先看目录', turnId: 't1', createdAt: '2026-10-10T00:00:01.000Z' },
  {
    type: 'message',
    id: 'a2',
    role: 'assistant',
    content: '看完了',
    turnId: 't1',
    createdAt: '2026-10-10T00:00:02.000Z',
    model: 'claude-opus-4-1',
  },
]

function descendants(view: StubView): StubView[] {
  return [view, ...view.children.flatMap(descendants)]
}

function metasIn(node: StubView): StubView[] {
  return node.children.filter((child) => child.classes.includes('item-meta'))
}

test('a turn draws one meta row, at its end, and only once the run has settled', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('subagents')
  const view = createSubagentPanelView(container, {
    onSelect: () => {},
    loadTranscript: async () => turnRecords,
    onOpenPath: () => {},
  })
  const answers = (node: StubView): StubView[] => descendants(node).filter((child) => child.classes.includes('assistant'))

  view.render({ entries: [running], selected: 'call-2' })
  await flush()
  const live = find(stub.inspect(container), 'subagent-transcript')!
  assert.equal(live.hidden, false, 'the transcript is the page')
  assert.deepEqual(answers(live).map((node) => metasIn(node).length), [0, 0], 'no meta row under the turn\'s prose while it runs')
  assert.equal(text(live, 'waiting').includes('处理中'), true, 'the open turn says what it is doing, once, at its end')

  // The records do not change when the run ends: the flag is the news, and the page
  // has to repaint on it rather than wait for a read that will not come.
  view.render({ entries: [{ ...running, finished: true, status: 'done' }], selected: 'call-2' })
  assert.equal(text(stub.inspect(container), 'waiting'), '', 'a settled turn has no status line')
  const settled = find(stub.inspect(container), 'subagent-transcript')!
  assert.deepEqual(answers(settled).map((node) => metasIn(node).length), [0, 1], 'only the turn\'s last message ends it')
  const footer = metasIn(answers(settled)[1]!)[0]!
  assert.equal(find(footer, 'item-copy') !== undefined, true, 'and that end offers its copy')
  assert.equal(find(footer, 'item-time') !== undefined, true, 'and its time')
})

test('closing the page stops its poll as well', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('subagents')
  let reads = 0
  const view = createSubagentPanelView(container, {
    onSelect: () => {},
    loadTranscript: async () => {
      reads += 1
      return []
    },
    onOpenPath: () => {},
  })
  view.setVisible(true)
  view.render({ entries: [running], selected: 'call-2' })
  await flush()
  // Two ticks in a row, one read: a tick that lands while a read is still on the
  // wire is dropped rather than queued behind it.
  t.mock.timers.tick(2000)
  await flush()
  assert.equal(reads, 2)
  t.mock.timers.tick(1000)
  await flush()
  assert.equal(reads, 3)

  view.render({ entries: [running], selected: undefined })
  t.mock.timers.tick(5000)
  await flush()
  assert.equal(reads, 3, 'the list has no page to keep fresh')
})
