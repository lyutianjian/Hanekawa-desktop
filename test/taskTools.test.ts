import test from 'node:test'
import assert from 'node:assert/strict'
import { taskCreateTool } from '../src/tools/TaskCreateTool/TaskCreateTool.js'
import { taskGetTool } from '../src/tools/TaskGetTool/TaskGetTool.js'
import { taskListTool } from '../src/tools/TaskListTool/TaskListTool.js'
import { taskUpdateTool } from '../src/tools/TaskUpdateTool/TaskUpdateTool.js'
import { restoreTaskStateFromRecords } from '../src/tools/taskState.js'
import type { SessionRecord, ToolContext } from '../src/harness/types.js'

function makeContext(): ToolContext {
  return {
    cwd: process.cwd(),
    sessionId: 'test-session',
    readFiles: new Set(),
    taskState: new Map(),
  }
}

test('TaskCreate/List/Get/Update share task state and summarize remaining/completed tasks', async () => {
  const ctx = makeContext()

  const created = await taskCreateTool.execute({ tasks: [{
    subject: 'Inspect plan mode',
    description: 'Compare behavior with Claude Code',
    activeForm: 'Inspecting plan mode',
  }] }, ctx)
  assert.equal(created.ok, true)
  assert.equal(ctx.taskState!.size, 1)

  const update = await taskUpdateTool.execute({
    taskId: '1',
    status: 'completed',
  }, ctx)
  assert.equal(update.ok, true)
  assert.match(update.metadata?.display?.summary ?? '', /0 remaining, 1 completed/)
  assert.equal(update.metadata?.display?.taskSnapshot?.counts.completed, 1)
  assert.equal(update.metadata?.display?.taskSnapshot?.tasks[0]?.subject, 'Inspect plan mode')

  const get = await taskGetTool.execute({ taskId: '1' }, ctx)
  assert.equal(get.ok, true)
  assert.match(get.content, /Task #1: Inspect plan mode/)
  assert.match(get.content, /Status: completed/)

  const listed = await taskListTool.execute({}, ctx)
  assert.equal(listed.ok, true)
  assert.match(listed.content, /Completed tasks \(1\)/)
  assert.match(listed.metadata?.display?.detail ?? '', /#1 \[completed\]/)
})

test('TaskUpdate tracks owner metadata dependencies and cleans dependencies on delete', async () => {
  const ctx = makeContext()
  const created = await taskCreateTool.execute({ tasks: [
    { subject: 'Prepare base', description: 'Create the base task' },
    { subject: 'Run dependent work', description: 'Depends on the base task' },
  ] }, ctx)
  assert.equal(created.content, 'Created tasks #1: Prepare base, #2: Run dependent work')

  const updated = await taskUpdateTool.execute({
    taskId: '2',
    status: 'in_progress',
    activeForm: 'Running dependent work',
    owner: 'agent-a',
    addBlockedBy: ['1'],
    metadata: { phase: 'implementation' },
  }, ctx)

  assert.equal(updated.ok, true)
  assert.equal(ctx.taskState!.get('2')!.owner, 'agent-a')
  assert.deepEqual(ctx.taskState!.get('2')!.blockedBy, ['1'])
  assert.deepEqual(ctx.taskState!.get('1')!.blocks, ['2'])
  assert.deepEqual(ctx.taskState!.get('2')!.metadata, { phase: 'implementation' })
  assert.equal(updated.metadata?.display?.taskSnapshot?.activeTaskId, '2')
  assert.equal(updated.metadata?.display?.taskSnapshot?.tasks.find((task) => task.id === '2')?.activeForm, 'Running dependent work')

  const listed = await taskListTool.execute({}, ctx)
  assert.match(listed.content, /#2 \[in_progress\] Run dependent work \(agent-a\) \[blocked by #1\]/)

  await taskUpdateTool.execute({ taskId: '1', status: 'deleted' }, ctx)
  assert.equal(ctx.taskState!.has('1'), false)
  assert.deepEqual(ctx.taskState!.get('2')!.blockedBy, [])
})

test('restoreTaskStateFromRecords replays successful task tool calls', () => {
  const records: SessionRecord[] = [
    {
      id: 'create-1',
      type: 'tool_use',
      tool: 'TaskCreate',
      input: { subject: 'Restore me', description: 'Persisted task' },
      riskLevel: 'safe',
      createdAt: '2026-06-01T00:00:00.000Z',
    },
    {
      id: 'result-1',
      type: 'tool_result',
      toolUseId: 'create-1',
      tool: 'TaskCreate',
      ok: true,
      content: 'created',
      createdAt: '2026-06-01T00:00:01.000Z',
    },
    {
      id: 'update-1',
      type: 'tool_use',
      tool: 'TaskUpdate',
      input: { taskId: '1', status: 'in_progress', activeForm: 'Restoring me', metadata: { restored: true } },
      riskLevel: 'safe',
      createdAt: '2026-06-01T00:00:02.000Z',
    },
    {
      id: 'result-2',
      type: 'tool_result',
      toolUseId: 'update-1',
      tool: 'TaskUpdate',
      ok: true,
      content: 'updated',
      createdAt: '2026-06-01T00:00:03.000Z',
    },
  ]

  const state = restoreTaskStateFromRecords(records)
  assert.equal(state.get('1')?.status, 'in_progress')
  assert.equal(state.get('1')?.activeForm, 'Restoring me')
  assert.deepEqual(state.get('1')?.metadata, { restored: true })
})
