import test from 'node:test'
import assert from 'node:assert/strict'
import {
  advanceTaskList,
  pausedTaskCard,
  staleTaskList,
  taskCard,
  taskListAtTurnStart,
  taskListState,
  TASK_CARD_ROWS,
  type TaskListState,
} from '../src/desktop/renderer/model/tasks.js'
import type { SessionRecord, TaskDisplayItem, TaskDisplaySnapshot } from '../src/harness/types.js'
import { wrapInSystemReminder } from '../src/harness/systemReminder.js'

/**
 * The task card's view model. Everything the list knows comes from folding the
 * records forward — at once on a pane switch or `/resume`, one at a time live.
 */
function task(id: string, status: TaskDisplayItem['status'], subject: string, activeForm?: string): TaskDisplayItem {
  return {
    id,
    status,
    subject,
    description: subject,
    ...(activeForm ? { activeForm } : {}),
    blocks: [],
    blockedBy: [],
  }
}

function snapshot(tasks: TaskDisplayItem[], activeTaskId?: string): TaskDisplaySnapshot {
  const pending = tasks.filter((t) => t.status === 'pending').length
  const inProgress = tasks.filter((t) => t.status === 'in_progress').length
  const completed = tasks.filter((t) => t.status === 'completed').length
  return {
    tasks,
    counts: { total: tasks.length, remaining: pending + inProgress, pending, inProgress, completed },
    ...(activeTaskId ? { activeTaskId } : {}),
  }
}

function todoWrite(id: string, snap: TaskDisplaySnapshot, turnId?: string): SessionRecord {
  return {
    type: 'tool_result',
    id,
    toolUseId: `use-${id}`,
    tool: 'TodoWrite',
    ok: true,
    content: 'updated',
    createdAt: 'now',
    display: { summary: '更新任务清单', taskSnapshot: snap },
    ...(turnId ? { turnId } : {}),
  }
}

function message(id: string, role: 'user' | 'assistant', content: string, turnId?: string): SessionRecord {
  return { type: 'message', id, role, content, createdAt: 'now', ...(turnId ? { turnId } : {}) }
}

const THREE_OF_SIX = snapshot([
  task('1', 'completed', 'Read the design'),
  task('2', 'completed', 'Sketch the model'),
  task('3', 'completed', 'Write the fold'),
  task('4', 'in_progress', 'Wire the card', 'Wiring the card'),
  task('5', 'pending', 'Style the strip'),
  task('6', 'pending', 'Regression pass'),
], '4')

test('no records, no tool_result and no snapshot each mean no list at all', () => {
  assert.equal(taskListState([]), undefined)
  assert.equal(taskListState([message('u1', 'user', 'go')]), undefined)
  assert.equal(
    taskListState([{
      type: 'tool_result', id: 'r1', toolUseId: 'u1', tool: 'Read', ok: true, content: 'x', createdAt: 'now',
      display: { summary: 'Read a.ts' },
    }]),
    undefined,
    'a display without a snapshot is not a checklist',
  )
  assert.equal(taskListState([todoWrite('r1', snapshot([]))]), undefined, 'nor is an empty one')
})

test('the newest snapshot wins outright — snapshots replace, they do not accumulate', () => {
  const state = taskListState([
    message('u1', 'user', 'go'),
    todoWrite('r1', snapshot([task('1', 'pending', 'Read the design')])),
    todoWrite('r2', THREE_OF_SIX),
  ])
  assert.ok(state)
  assert.equal(state.tasks.length, 6)
  assert.deepEqual(state.counts, { total: 6, remaining: 3, pending: 2, inProgress: 1, completed: 3 })
  assert.equal(state.stale, false)
  assert.equal(state.tasks[3]?.label, 'Wiring the card', 'a running task reads as its activeForm')
  assert.equal(state.tasks[4]?.label, 'Style the strip', 'everything else reads as its subject')
})

test('deleted tasks leave the list and its counts, so a list can finish', () => {
  const state = taskListState([todoWrite('r1', snapshot([task('1', 'completed', 'Kept'), task('2', 'deleted', 'Dropped')]))])
  assert.ok(state)
  assert.deepEqual(state.tasks.map((t) => t.id), ['1'])
  assert.equal(state.counts.total, 1, 'the snapshot counted the deleted row; the list does not')
  assert.equal(state.allDone, true)
})

test('the next user message retires a finished list and makes an unfinished one stale', () => {
  const done = snapshot([task('1', 'completed', 'Kept')])
  assert.equal(taskListState([todoWrite('r1', done), message('u2', 'user', 'next thing')]), undefined)
  assert.ok(taskListState([todoWrite('r1', done), message('a1', 'assistant', 'all done')]), 'an answer is not the user moving on')
  const carried = taskListState([todoWrite('r1', THREE_OF_SIX), message('u2', 'user', 'keep going')])
  assert.equal(carried?.stale, true)
  assert.equal(carried?.counts.remaining, 3)
  assert.equal(
    taskListState([todoWrite('r1', THREE_OF_SIX), message('u2', 'user', 'go'), todoWrite('r3', THREE_OF_SIX)])?.stale,
    false,
    'a list rewritten this turn is current again',
  )
})

test('a system-reminder user record is not the user starting something new', () => {
  const state = taskListState([
    todoWrite('r1', snapshot([task('1', 'completed', 'Kept')])),
    message('u2', 'user', wrapInSystemReminder('background nudge')),
  ])
  assert.equal(state?.stale, false)
})

// --- request boundaries --------------------------------------------------------

test('only a new turn is a new request: steering amends it and a notification turn carries it on', () => {
  const steered = taskListState([
    message('u1', 'user', 'build it', 't1'),
    todoWrite('r1', THREE_OF_SIX, 't1'),
    message('u2', 'user', 'also check the docs', 't1'),
  ])
  assert.equal(steered?.stale, false, 'a message steered into the turn is part of its request')
  const woken = taskListState([
    todoWrite('r1', THREE_OF_SIX, 't1'),
    message('u2', 'user', wrapInSystemReminder('task done'), 't2'),
    message('u3', 'user', 'and the docs', 't2'),
  ])
  assert.equal(woken?.stale, false, 'a turn woken by notifications, steering included, is no new request')
  const next = taskListState([todoWrite('r1', THREE_OF_SIX, 't1'), message('u2', 'user', 'something else', 't2')])
  assert.equal(next?.stale, true)
})

test('turn-start stales the list only for a turn the user started', () => {
  const state = taskListState([todoWrite('r1', THREE_OF_SIX, 't1')])
  assert.equal(taskListAtTurnStart(state, wrapInSystemReminder('task done')), state)
  assert.equal(taskListAtTurnStart(state, 'something else')?.stale, true)
})

test('a tool_result without a snapshot leaves the list alone', () => {
  const state = taskListState([
    todoWrite('r1', THREE_OF_SIX),
    { type: 'tool_result', id: 'r2', toolUseId: 'u2', tool: 'Read', ok: true, content: 'x', createdAt: 'now' },
  ])
  assert.equal(state?.counts.completed, 3)
})

test('turn-start staling is idempotent with the user record that follows it', () => {
  const current = taskListState([todoWrite('r1', THREE_OF_SIX)])
  const staled = staleTaskList(current)
  assert.equal(staled?.stale, true)
  assert.equal(staleTaskList(staled), staled)
  assert.equal(advanceTaskList(staled, message('u2', 'user', 'go')), staled)
  assert.equal(staleTaskList(taskListState([todoWrite('r1', snapshot([task('1', 'completed', 'Kept')]))])), undefined)
  assert.equal(staleTaskList(undefined), undefined)
})

// --- the card ----------------------------------------------------------------

function list(count: number, running: number): TaskListState {
  const tasks = Array.from({ length: count }, (_, index) => task(
    String(index + 1),
    index < running ? 'completed' : index === running ? 'in_progress' : 'pending',
    `Step ${index + 1}`,
  ))
  return taskListState([todoWrite('r1', snapshot(tasks))])!
}

test('the card is drawn only while a turn runs', () => {
  const state = taskListState([todoWrite('r1', THREE_OF_SIX)])
  assert.equal(taskCard(state, false), undefined)
  assert.equal(taskCard(undefined, true), undefined)
  assert.deepEqual(taskCard(state, true), { rows: state!.tasks, hiddenBefore: 0, openAfter: 0 })
})

test('a long list opens its window one row before the current one', () => {
  const card = taskCard(list(30, 10), true)!
  assert.equal(card.rows.length, TASK_CARD_ROWS)
  assert.equal(card.hiddenBefore, 9, 'the step just finished stays in view')
  assert.equal(card.rows[1]?.status, 'in_progress')
  assert.equal(card.openAfter, 30 - 9 - TASK_CARD_ROWS)
})

test('the window never runs past the end or before the start', () => {
  const nearEnd = taskCard(list(20, 19), true)!
  assert.equal(nearEnd.hiddenBefore, 20 - TASK_CARD_ROWS)
  assert.equal(nearEnd.openAfter, 0)
  const first = taskCard(list(20, 0), true)!
  assert.equal(first.hiddenBefore, 0)
  assert.equal(first.openAfter, 20 - TASK_CARD_ROWS)
})

test('with nothing running, the first unfinished row anchors the window', () => {
  const tasks = Array.from({ length: 20 }, (_, index) => task(String(index), index < 15 ? 'completed' : 'pending', `Step ${index}`))
  const card = taskCard(taskListState([todoWrite('r1', snapshot(tasks))]), true)!
  assert.equal(card.hiddenBefore, 20 - TASK_CARD_ROWS)
  const done = Array.from({ length: 20 }, (_, index) => task(String(index), 'completed', `Step ${index}`))
  assert.equal(taskCard(taskListState([todoWrite('r1', snapshot(done))]), true)!.hiddenBefore, 20 - TASK_CARD_ROWS)
})

test('with nothing marked running, a live card draws the first unfinished row as running', () => {
  const tasks = [task('1', 'completed', 'Done'), task('2', 'pending', 'Next'), task('3', 'pending', 'Later')]
  const live = taskListState([todoWrite('r1', snapshot(tasks))])
  assert.deepEqual(taskCard(live, true)!.rows.map((row) => row.status), ['completed', 'in_progress', 'pending'])
  assert.equal(live!.tasks[1]?.status, 'pending', 'the list itself keeps what the model wrote')
})

test('a plan a new request superseded shows its current step paused', () => {
  const state = taskListState([todoWrite('r1', THREE_OF_SIX), message('u2', 'user', 'something else')])
  assert.deepEqual(
    taskCard(state, true)!.rows.map((row) => row.status),
    ['completed', 'completed', 'completed', 'paused', 'pending', 'pending'],
  )
  const tasks = [task('1', 'completed', 'Done'), task('2', 'pending', 'Next')]
  const unmarked = taskListState([todoWrite('r1', snapshot(tasks)), message('u2', 'user', 'something else')])
  assert.deepEqual(taskCard(unmarked, true)!.rows.map((row) => row.status), ['completed', 'paused'], 'the stand-in current row too')
})

test('waiting on the user pauses the running step and nothing else', () => {
  const card = pausedTaskCard(taskCard(taskListState([todoWrite('r1', THREE_OF_SIX)]), true)!)
  assert.deepEqual(card.rows.map((row) => row.status), ['completed', 'completed', 'completed', 'paused', 'pending', 'pending'])
  assert.equal(card.rows[3]?.label, 'Wiring the card')
})
