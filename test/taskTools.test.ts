import test from 'node:test'
import assert from 'node:assert/strict'
import { taskCreateTool } from '../src/tools/TaskCreateTool/TaskCreateTool.js'
import { taskGetTool } from '../src/tools/TaskGetTool/TaskGetTool.js'
import { taskListTool } from '../src/tools/TaskListTool/TaskListTool.js'
import { taskUpdateTool } from '../src/tools/TaskUpdateTool/TaskUpdateTool.js'
import { restoreTaskStateFromRecords } from '../src/tools/taskState.js'
import { AgentLoop } from '../src/harness/loop.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'
import { z } from 'zod/v3'
import type { ModelProvider, SessionRecord, Tool, ToolContext } from '../src/harness/types.js'

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

// --- one list per request ------------------------------------------------------

test('the first TaskCreate of a new request replaces the list; within a request it adds', async () => {
  const ctx = makeContext()
  ctx.requestTurnId = 't1'
  await taskCreateTool.execute({ tasks: [{ subject: 'Old A', description: 'a' }, { subject: 'Old B', description: 'b' }] }, ctx)
  await taskCreateTool.execute({ tasks: [{ subject: 'Old C', description: 'c' }] }, ctx)
  assert.deepEqual([...ctx.taskState!.keys()], ['1', '2', '3'])

  ctx.requestTurnId = 't2'
  const created = await taskCreateTool.execute({ tasks: [{ subject: 'New', description: 'n' }] }, ctx)
  assert.equal(created.content, 'Created task #1: New')
  assert.deepEqual([...ctx.taskState!.values()].map((task) => task.subject), ['New'])
  assert.deepEqual(created.metadata?.display?.taskSnapshot?.tasks.map((task) => task.subject), ['New'])
})

test('a TaskUpdate in a new request carries the list over, so TaskCreate adds to it', async () => {
  const ctx = makeContext()
  ctx.requestTurnId = 't1'
  await taskCreateTool.execute({ tasks: [{ subject: 'Old A', description: 'a' }, { subject: 'Old B', description: 'b' }] }, ctx)

  ctx.requestTurnId = 't2'
  await taskUpdateTool.execute({ taskId: '99', status: 'completed' }, ctx)
  await taskUpdateTool.execute({ taskId: '1', status: 'deleted' }, ctx)
  await taskCreateTool.execute({ tasks: [{ subject: 'More', description: 'm' }] }, ctx)
  assert.deepEqual([...ctx.taskState!.values()].map((task) => task.subject), ['Old B', 'More'])
})

test('a TaskUpdate that finds nothing does not carry the list over', async () => {
  const ctx = makeContext()
  ctx.requestTurnId = 't1'
  await taskCreateTool.execute({ tasks: [{ subject: 'Old', description: 'o' }] }, ctx)
  ctx.requestTurnId = 't2'
  await taskUpdateTool.execute({ taskId: '99', status: 'completed' }, ctx)
  await taskCreateTool.execute({ tasks: [{ subject: 'New', description: 'n' }] }, ctx)
  assert.deepEqual([...ctx.taskState!.values()].map((task) => task.subject), ['New'])
})

test('the loop marks a request per user turn, and a replay lands on the live list', async () => {
  const records: SessionRecord[] = []
  const script: Array<{ subject: string } | undefined> = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      const next = script.shift()
      return next
        ? { content: '', toolCalls: [{ id: `create-${records.length}`, name: 'TaskCreate', input: { tasks: [{ subject: next.subject, description: 'd' }] } }] }
        : { content: 'done', toolCalls: [] }
    },
  }
  const toolContext = makeContext()
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools: [taskCreateTool, taskUpdateTool],
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner([taskCreateTool, taskUpdateTool], new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext,
    recordStream: { load: async () => records, append: async (record) => { records.push(record) } },
  })
  const subjects = () => [...toolContext.taskState!.values()].map((task) => task.subject)

  script.push({ subject: 'First' }, undefined)
  await loop.run({ text: 'build it' })
  script.push({ subject: 'After the wake' }, undefined)
  await loop.run({ text: wrapInSystemReminder('background task finished') })
  assert.deepEqual(subjects(), ['First', 'After the wake'], 'a notification turn is no new request')
  script.push({ subject: 'Second' }, undefined)
  await loop.run({ text: 'now something else' })
  assert.deepEqual(subjects(), ['Second'])

  assert.deepEqual(restoreTaskStateFromRecords(records), toolContext.taskState)
})

test('TaskUpdate reports where the list stands after a status change', async () => {
  const ctx = makeContext()
  await taskCreateTool.execute({ tasks: [
    { subject: 'Base', description: 'd' },
    { subject: 'Blocked', description: 'd' },
    { subject: 'Free', description: 'd' },
  ] }, ctx)
  await taskUpdateTool.execute({ taskId: '2', addBlockedBy: ['1'] }, ctx)

  const started = await taskUpdateTool.execute({ taskId: '1', status: 'in_progress' }, ctx)
  assert.equal(started.content, 'Updated task #1 status.')
  const second = await taskUpdateTool.execute({ taskId: '3', status: 'in_progress' }, ctx)
  assert.equal(second.content, 'Updated task #3 status. #1 is also in_progress; keep only one.')
  await taskUpdateTool.execute({ taskId: '3', status: 'pending' }, ctx)

  const done = await taskUpdateTool.execute({ taskId: '1', status: 'completed' }, ctx)
  assert.equal(done.content, 'Updated task #1 status. 2 tasks remain; next pending: #2 Blocked.')
  await taskUpdateTool.execute({ taskId: '3', status: 'in_progress' }, ctx)
  const skipped = await taskUpdateTool.execute({ taskId: '2', status: 'completed' }, ctx)
  assert.equal(skipped.content, 'Updated task #2 status. 1 task remains; in progress: #3 Free.')
  const last = await taskUpdateTool.execute({ taskId: '3', status: 'completed' }, ctx)
  assert.equal(last.content, 'Updated task #3 status. All tasks are completed.')
})

test('the loop reminds of open tasks after ten responses without a task tool', async () => {
  const records: SessionRecord[] = []
  const calls: string[] = []
  const provider: ModelProvider = {
    name: 'fake',
    async createMessage() {
      const name = calls.shift()
      return name
        ? { content: '', toolCalls: [{ id: `call-${records.length}`, name, input: name === 'TaskCreate' ? { tasks: [{ subject: 'Open', description: 'd' }] } : {} }] }
        : { content: 'done', toolCalls: [] }
    },
  }
  const work: Tool = { name: 'Work', description: 'w', inputSchema: z.object({}), riskLevel: 'safe', execute: async () => ({ ok: true, content: 'ok' }) }
  const tools = [taskCreateTool, taskListTool, work]
  const loop = new AgentLoop({
    provider,
    model: 'fake-model',
    tools,
    contextBuilder: new ContextBuilder(),
    toolRunner: new ToolRunner(tools, new PermissionGate(async () => true), {
      onRecord: async (record) => { records.push(record) },
    }),
    toolContext: makeContext(),
    recordStream: { load: async () => records, append: async (record) => { records.push(record) } },
  })
  const reminders = () => records.flatMap((record) => record.type === 'message' && /No task tool call in your last 10 responses/.test(record.content) ? [record.content] : [])
  const other = (count: number) => Array.from({ length: count }, () => 'Work')

  calls.push(...other(10))
  await loop.run({ text: 'no list yet' })
  assert.equal(reminders().length, 0, 'nothing open, nothing to remind of')

  calls.push('TaskCreate', ...other(9), 'TaskList', ...other(9))
  await loop.run({ text: 'plan it' })
  assert.equal(reminders().length, 0, 'any task tool restarts the count')

  calls.push('Work')
  await loop.run({ text: 'keep going' })
  assert.equal(reminders().length, 1, 'the count carries across turns')
  assert.match(reminders()[0]!, /#1 \[pending\] Open/)

  calls.push(...other(9))
  await loop.run({ text: 'more' })
  assert.equal(reminders().length, 1)
  calls.push('Work')
  await loop.run({ text: 'one more' })
  assert.equal(reminders().length, 2, 'due again ten responses after the last reminder')
})
