import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type StubView } from './helpers/domStub.js'
import { createSubagentPanelView } from '../src/desktop/renderer/dom/subagentPanelView.js'
import type { SubagentEntry } from '../src/desktop/renderer/model/subagentPanel.js'

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
    onStop: () => {},
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
