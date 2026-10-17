import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createCommandsPanelView } from '../src/desktop/renderer/dom/commandsPanelView.js'
import type { CommandRow } from '../src/desktop/renderer/model/commandsPanel.js'

const live: CommandRow = { id: 't1', command: 'npm run dev', tone: 'running', running: true, status: '运行中', startedAt: Date.now() }
const done: CommandRow = { id: 't2', command: 'npm test', tone: 'done', running: false, status: '已完成 · exit 0', startedAt: 0, finishedAt: 75_000 }

const byClass = (view: StubView | undefined, name: string): StubView | undefined =>
  view?.children.find((child) => child.classes.includes(name))

test('a row unfolds into its output and only a running one can be stopped', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('commands')
  const asked: string[] = []
  const stopped: string[] = []
  const view = createCommandsPanelView(container, {
    loadOutput: async (id) => {
      asked.push(id)
      return id === 't2' ? 'ok 12 tests' : ''
    },
    onStop: (id) => stopped.push(id),
  })
  t.after(() => view.render(undefined))
  view.render([live, done])

  const rows = () => stub.inspect(container).children
  assert.equal(rows().length, 2)
  assert.equal(byClass(byClass(byClass(rows()[1], 'command-head'), 'command-meta'), 'command-time')?.text, '1m15s')
  assert.equal(byClass(rows()[1], 'command-stop'), undefined, 'a finished process has nothing to stop')
  stub.click(byClass(rows()[0], 'command-stop')!.node)
  assert.deepEqual(stopped, ['t1'])

  stub.click(byClass(rows()[1], 'command-head')!.node)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(asked.includes('t2'))
  assert.equal(byClass(rows()[1], 'command-output')?.text, 'ok 12 tests')
  assert.equal(byClass(rows()[1], 'command-head')?.attributes.get('aria-expanded'), 'true')

  // The same rows again rebuild nothing, so the unfolded output stays.
  const before = byClass(rows()[1], 'command-output')!.node
  view.render([live, done])
  assert.equal(byClass(rows()[1], 'command-output')?.node, before)
})
