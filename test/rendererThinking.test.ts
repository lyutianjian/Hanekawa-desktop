import test from 'node:test'
import assert from 'node:assert/strict'

import {
  NO_DISCLOSURE,
  THINKING_DONE_FALLBACK,
  THINKING_LIVE_LABEL,
  failureLabel,
  isExpanded,
  pruneDisclosure,
  runHasTools,
  summarizeRun,
  thoughtFirstSentence,
  thoughtLabel,
  thoughtLiveLabel,
  toggleDisclosure,
} from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type {
  ActivityRun,
  ActivityStep,
  ToolStepStatus,
  TranscriptEntry,
} from '../src/desktop/renderer/model/transcript.js'

/**
 * What an activity line says and which of them are open, as pure decisions.
 */

test('a thought reads as its first sentence, live or sealed, and never as a half-written one', () => {
  const text = '先确认目录是否为空。再看本机有哪些运行时，然后定技术栈。\n设计上只用一个强调色。'
  assert.equal(thoughtFirstSentence(text), '先确认目录是否为空。')
  assert.equal(thoughtLabel(text), '先确认目录是否为空。')
  assert.equal(thoughtLiveLabel(text), '先确认目录是否为空。')
  // The first sentence still being written: the line waits rather than following it.
  assert.equal(thoughtLiveLabel('先确认目录是'), THINKING_LIVE_LABEL)
  // A dot inside a name is not a sentence end; one before a space is.
  assert.equal(thoughtFirstSentence('open design-directions.md first. Then read'), 'open design-directions.md first.')
  // Nothing said yet.
  assert.equal(thoughtLabel(''), THINKING_DONE_FALLBACK)
  assert.equal(thoughtLiveLabel('  \n'), THINKING_LIVE_LABEL)
})

const tool = (id: string, toolName: string, extra: Partial<Extract<ActivityStep, { kind: 'tool' }>> & { useSummary?: string; detail?: string } = {}): ActivityStep => {
  const { useSummary, detail, ...rest } = extra
  return {
    kind: 'tool',
    id,
    text: id,
    toolName,
    status: 'done' as ToolStepStatus,
    tool: { displayName: toolName, useSummary: useSummary ?? id, ...(detail === undefined ? {} : { detail }) },
    ...rest,
  }
}
const thinking = (id: string): ActivityStep => ({ kind: 'thinking', id, text: '想想' })

const run = (steps: readonly ActivityStep[], status: ActivityRun['status'] = 'done'): ActivityRun => ({
  id: `run:${steps[0]!.id}`,
  steps,
  status,
  failedCount: steps.filter((step) => 'status' in step && step.status === 'failed').length,
})

test('a run folds to one line of counts, in the order each kind first appears', () => {
  const summary = summarizeRun(run([
    tool('b1', 'Bash'), tool('b2', 'Bash'), thinking('t'), tool('r1', 'Read'), tool('r2', 'Read'),
    tool('g', 'Grep'), tool('w', 'WebFetch'), tool('mcp', 'mcp__x__y'),
  ]))
  assert.equal(summary.text, '已运行 2 个命令，读取 2 个文件，搜索 1 次，浏览 1 个网页，已使用 1 个工具')
  assert.equal(summary.failed, 0)
  assert.equal(summary.aborted, false)
  assert.equal(summarizeRun(run([tool('a', 'Agent')])).text, '运行 1 个子代理')
  assert.equal(
    summarizeRun(run([{ ...tool('todo', 'TodoWrite'), kind: 'task' } as ActivityStep, tool('r', 'Read')])).text,
    '更新了待办，读取 1 个文件',
  )
  assert.equal(runHasTools(run([thinking('t')])), false)
  assert.equal(runHasTools(run([thinking('t'), tool('r', 'Read')])), true)
})

test('an edit counts files, not calls, and carries the patch counts when every patch parses', () => {
  const patch = (added: number): string => `--- a\n+++ b\n@@ -1,1 +1,${added} @@\n${Array.from({ length: added }, (_, i) => `+line ${i}`).join('\n')}\n-old`
  const edits = run([
    tool('e1', 'Edit', { useSummary: 'src/a.ts', detail: patch(2) }),
    tool('e2', 'Edit', { useSummary: 'src/a.ts', detail: patch(3) }),
    tool('w', 'Write', { useSummary: 'src/b.ts', detail: patch(1) }),
  ])
  const summary = summarizeRun(edits)
  assert.equal(summary.text, '编辑 2 个文件')
  assert.deepEqual(summary.diff, { added: 6, deleted: 3 })
  // One edit with no patch to read: the counts would be partial, so there are none.
  assert.equal(summarizeRun(run([tool('e', 'Edit')])).diff, undefined)
})

test('a failure or an interruption is said beside the counts, not in them', () => {
  const failed = run([tool('a', 'Read', { status: 'failed', failed: true }), tool('b', 'Read')])
  assert.equal(summarizeRun(failed).text, '读取 2 个文件')
  assert.equal(summarizeRun(failed).failed, 1)
  assert.equal(failureLabel(1), '1 个失败')
  assert.equal(summarizeRun(run([tool('a', 'Read')], 'aborted')).aborted, true)
})

test('everything is folded until the user opens it, and the answer is absolute', () => {
  assert.equal(isExpanded(NO_DISCLOSURE, 'a'), false)
  const opened = toggleDisclosure(NO_DISCLOSURE, 'a', false)
  assert.equal(isExpanded(opened, 'a'), true)
  const closed = toggleDisclosure(opened, 'a', true)
  assert.equal(isExpanded(closed, 'a'), false)
  assert.equal(closed.get('a'), false, 'recorded, not forgotten')
})

test('pruning keeps only the runs and steps that exist', () => {
  const entries: TranscriptEntry[] = [
    { kind: 'item', item: { id: 'm1', kind: 'user', text: 'hi' } },
    { kind: 'run', run: run([thinking('t1'), tool('a', 'Read')]) },
  ]
  const state: DisclosureState = new Map([['t1', true], ['a', true], ['m1', true], ['gone', true]])

  assert.deepEqual([...pruneDisclosure(entries, state)], [['t1', true], ['a', true]])
  // A `transcript-reset` restarts the id counter, so nothing may survive it.
  assert.deepEqual([...pruneDisclosure([], state)], [])
})
