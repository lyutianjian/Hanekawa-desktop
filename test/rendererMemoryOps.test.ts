import test from 'node:test'
import assert from 'node:assert/strict'
import type { ActivityRun, ActivityStep, ToolStepStatus } from '../src/desktop/renderer/model/transcript.js'
import { drawnSteps, isMemoryIndex, memoryOp } from '../src/desktop/renderer/model/memoryOps.js'
import { callParts, type CallStep } from '../src/desktop/renderer/model/toolPhrases.js'
import { summarizeRun } from '../src/desktop/renderer/model/thinking.js'

const DIR = '/home/me/.myagent/projects/p/memory'

function step(id: string, toolName: string, useSummary: string, extra: { memory?: false; status?: ToolStepStatus; note?: string } = {}): CallStep {
  return {
    kind: 'tool',
    id,
    text: '',
    toolName,
    status: extra.status ?? 'done',
    tool: {
      displayName: toolName,
      useSummary,
      ...(extra.memory === false ? {} : { memory: true as const }),
      ...(extra.note ? { memoryNote: extra.note } : {}),
    },
  }
}

const run = (...steps: ActivityStep[]): ActivityRun => ({ id: 'run', steps, status: 'done', failedCount: 0 })

test('memoryOp by tool, and the index is told apart', () => {
  assert.equal(memoryOp(step('a', 'Read', `${DIR}/user-role.md`)), 'recall')
  assert.equal(memoryOp(step('a', 'Grep', `role · ${DIR}`)), 'search')
  assert.equal(memoryOp(step('a', 'Write', `${DIR}/user-role.md`)), 'save')
  assert.equal(memoryOp(step('a', 'MultiEdit', `${DIR}/user-role.md`)), 'update')
  assert.equal(memoryOp(step('a', 'Delete', `${DIR}/user-role.md`)), 'delete')
  assert.equal(memoryOp(step('a', 'Read', '/p/src/a.ts', { memory: false })), undefined)
  assert.equal(isMemoryIndex(step('a', 'Edit', `${DIR}/MEMORY.md`)), true)
  assert.equal(isMemoryIndex(step('a', 'Edit', `${DIR}/user-role.md`)), false)
})

test('rows read as memory work', () => {
  const parts = (s: CallStep) => { const { verb, target } = callParts(s); return `${verb}|${target}` }
  assert.equal(parts(step('a', 'Read', `${DIR}/user-role.md`)), '调取记忆|user-role')
  assert.equal(parts(step('a', 'Glob', `*.md · ${DIR}`)), '查找记忆|*.md')
  assert.equal(parts(step('a', 'Write', `${DIR}/user-role.md`)), '保存记忆|user-role')
  assert.equal(parts(step('a', 'Edit', `${DIR}/user-role.md`)), '更新记忆|user-role')
  assert.equal(parts(step('a', 'Delete', `${DIR}/user-role.md`)), '删除记忆|user-role')
  assert.equal(parts(step('a', 'Edit', `${DIR}/MEMORY.md`)), '整理记忆索引|')
  assert.equal(parts(step('a', 'Read', `${DIR}/MEMORY.md`)), '调取记忆索引|')
  assert.equal(parts(step('a', 'Read', '/p/src/a.ts', { memory: false })), '读取|a.ts')
})

test('the run summary counts memories, not files, and leaves the index out', () => {
  const summary = summarizeRun(run(
    step('r1', 'Read', `${DIR}/a.md`),
    step('r2', 'Read', `${DIR}/b.md`),
    step('w', 'Write', `${DIR}/c.md`),
    step('i1', 'Edit', `${DIR}/MEMORY.md`),
    step('e', 'Edit', `${DIR}/c.md`),
    step('i2', 'Edit', `${DIR}/MEMORY.md`),
  ))
  assert.equal(summary.text, '调取 2 条记忆，保存 1 条记忆')
  assert.equal(summary.diff, undefined)
  assert.equal(summarizeRun(run(step('i', 'Edit', `${DIR}/MEMORY.md`), step('j', 'Edit', `${DIR}/MEMORY.md`))).text, '整理记忆索引')
  assert.equal(summarizeRun(run(step('d', 'Delete', `${DIR}/c.md`), step('i', 'Edit', `${DIR}/MEMORY.md`))).text, '删除 1 条记忆')
})

test('a settled index write folds into the memory save beside it', () => {
  const save = step('w', 'Write', `${DIR}/c.md`)
  const index = step('i', 'Edit', `${DIR}/MEMORY.md`)
  assert.deepEqual(drawnSteps([save, index]).map((s) => s.id), ['w'])
  const failed = step('f', 'Edit', `${DIR}/MEMORY.md`, { status: 'failed' })
  assert.deepEqual(drawnSteps([save, failed]).map((s) => s.id), ['w', 'f'])
  const alone = [index]
  assert.equal(drawnSteps(alone), alone)
  const reads = [step('r', 'Read', `${DIR}/a.md`), index]
  assert.equal(drawnSteps(reads), reads)
})
