import assert from 'node:assert/strict'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { createMergeBarView } from '../src/desktop/renderer/dom/mergeBarView.js'
import { mergeBarView, type MergeBarIntent, type MergeBarView } from '../src/desktop/renderer/model/mergeBar.js'
import type { WireThreadMerge } from '../src/desktop/shellProtocol.js'

/**
 * The merge bar's nodes. Not in the base TypeScript program (its `lib` has no
 * DOM): excluded there and checked by `tsconfig.domtest.json`.
 */

function merge(overrides: Partial<WireThreadMerge> = {}): WireThreadMerge {
  return { threadId: 't1', title: '修复登录', branch: 'thread/t1', added: 12, removed: 3, conflict: false, running: false, ...overrides }
}

function render(t: { after(fn: () => void): void }) {
  const stub: DomStub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('merge-bar')
  const intents: MergeBarIntent[] = []
  const bar = createMergeBarView(container, (intent) => intents.push(intent))
  const paint = (role: 'thread' | 'coordinator', merges: WireThreadMerge[], options: { expanded?: boolean; pending?: string[]; error?: string } = {}) => {
    const view: MergeBarView = mergeBarView({
      role,
      threadId: 't1',
      projectName: 'alpha',
      merges,
      expanded: options.expanded ?? false,
      pending: new Set(options.pending ?? []),
    })
    bar.render(view, options.error)
  }
  return { stub, container, intents, paint }
}

function rowOf(view: StubView): StubView {
  return view.children.find((child) => child.classes.includes('merge-bar-row'))!
}

function buttonIn(row: StubView, className: string): StubView {
  const found = row.children.find((child) => child.classes.includes(className))
  assert.ok(found, `expected a .${className} button`)
  return found
}

test('a single row reads project, branch, stat, merge and dismiss', (t) => {
  const r = render(t)
  r.paint('thread', [merge()])
  const row = rowOf(r.stub.inspect(r.container))
  assert.equal(r.stub.inspect(r.container).hidden, false)
  assert.equal(row.children.find((c) => c.classes.includes('merge-bar-project'))!.text, 'alpha')
  assert.equal(row.children.find((c) => c.classes.includes('merge-bar-branch'))!.text, 'thread/t1')
  assert.equal(row.children.find((c) => c.classes.includes('merge-bar-stat'))!.text, '+12 −3')
  assert.equal(buttonIn(row, 'merge-bar-merge').text, '合并')
  assert.equal(buttonIn(row, 'merge-bar-dismiss').text, '×')
})

test('a click on merge and on dismiss reports the thread', (t) => {
  const r = render(t)
  r.paint('thread', [merge()])
  const row = r.stub.inspect(r.container).children.find((c) => c.classes.includes('merge-bar-row'))!
  r.stub.click(buttonIn(row, 'merge-bar-merge').node)
  r.stub.click(buttonIn(row, 'merge-bar-dismiss').node)
  assert.deepEqual(r.intents, [
    { kind: 'merge', threadId: 't1' },
    { kind: 'dismiss', threadId: 't1' },
  ])
})

test('a conflict replaces merge with 有冲突 and 让线程解决', (t) => {
  const r = render(t)
  r.paint('thread', [merge({ conflict: true })])
  const row = rowOf(r.stub.inspect(r.container))
  assert.equal(row.children.find((c) => c.classes.includes('merge-bar-conflict'))!.text, '有冲突')
  assert.equal(row.children.some((c) => c.classes.includes('merge-bar-merge')), false)
  const resolve = buttonIn(row, 'merge-bar-resolve')
  assert.equal(resolve.text, '让线程解决')
  r.stub.click(resolve.node)
  assert.deepEqual(r.intents, [{ kind: 'resolve', threadId: 't1' }])
})

test('a running branch disables merge with the running reason as its title', (t) => {
  const r = render(t)
  r.paint('thread', [merge({ running: true })])
  const merged = buttonIn(rowOf(r.stub.inspect(r.container)), 'merge-bar-merge')
  assert.equal(merged.disabled, true)
  assert.equal((merged.node as { title: string }).title, '线程运行中')
  r.stub.click(merged.node)
  assert.deepEqual(r.intents, [])
})

test('a pending merge is disabled with the in-flight reason', (t) => {
  const r = render(t)
  r.paint('thread', [merge()], { pending: ['t1'] })
  const merged = buttonIn(rowOf(r.stub.inspect(r.container)), 'merge-bar-merge')
  assert.equal(merged.disabled, true)
  assert.equal((merged.node as { title: string }).title, '合并中')
})

test('the coordinator summary is a collapsed disclosure with aria-expanded', (t) => {
  const r = render(t)
  r.paint('coordinator', [merge(), merge({ threadId: 't2' })])
  const root = r.stub.inspect(r.container)
  const toggle = root.children.find((c) => c.classes.includes('merge-bar-toggle'))!
  assert.equal(toggle.text, '2 个线程分支待合并')
  assert.equal(toggle.attributes.get('aria-expanded'), 'false')
  assert.equal(root.children.some((c) => c.classes.includes('merge-bar-list')), false)
  r.stub.click(toggle.node)
  assert.deepEqual(r.intents, [{ kind: 'toggle-expanded' }])
})

test('an expanded summary lists each branch with its own actions', (t) => {
  const r = render(t)
  r.paint('coordinator', [merge(), merge({ threadId: 't2', conflict: true })], { expanded: true })
  const root = r.stub.inspect(r.container)
  assert.equal(root.children.find((c) => c.classes.includes('merge-bar-toggle'))!.attributes.get('aria-expanded'), 'true')
  const items = root.children.find((c) => c.classes.includes('merge-bar-list'))!.children
  assert.equal(items.length, 2)
  assert.equal(buttonIn(rowOf(items[0]!), 'merge-bar-merge').text, '合并')
  assert.equal(buttonIn(rowOf(items[1]!), 'merge-bar-resolve').text, '让线程解决')
})

test('an empty bar hides the container', (t) => {
  const r = render(t)
  r.paint('coordinator', [merge()])
  r.paint('coordinator', [])
  const root = r.stub.inspect(r.container)
  assert.equal(root.hidden, true)
  assert.equal(root.children.length, 0)
})

test('an unchanged view does not rebuild the rows', (t) => {
  const r = render(t)
  r.paint('thread', [merge()])
  const before = rowOf(r.stub.inspect(r.container)).node
  r.paint('thread', [merge()])
  assert.equal(rowOf(r.stub.inspect(r.container)).node, before)
})

test('a refused or failed merge is said under the row, and leaves with the next action', (t) => {
  const r = render(t)
  const errorLines = (): StubView[] => r.stub.inspect(r.container).children.filter((c) => c.classes.includes('merge-bar-error'))

  r.paint('thread', [merge()], { error: '项目目录里有未提交的改动。请先提交或暂存，再合并。' })
  assert.deepEqual(errorLines().map((line) => line.text), ['项目目录里有未提交的改动。请先提交或暂存，再合并。'])
  assert.equal(errorLines()[0]!.attributes.get('role'), 'alert')
  assert.equal(r.stub.inspect(r.container).children[0]!.classes.includes('merge-bar-row'), true, 'the row stays first')

  r.paint('thread', [merge()])
  assert.deepEqual(errorLines(), [])

  // The summary form carries it too, under its list.
  r.paint('coordinator', [merge(), merge({ threadId: 't2' })], { expanded: true, error: '合并失败' })
  assert.deepEqual(errorLines().map((line) => line.text), ['合并失败'])
})
