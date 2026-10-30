import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  cleanupSubagentWorktrees,
  getSubagentDetails,
  latestSubagentTasks,
  latestSubagentTranscripts,
  listLatestSubagentTasks,
  resolveAgentId,
} from '../src/runtime/subagentInspection.js'
import type { SessionRecord } from '../src/harness/types.js'
import { SessionStore } from '../src/sessions/service.js'

/**
 * These back `/agents list|show|cleanup`. They had no direct coverage while they
 * lived inside `useCommands.ts`, which is why they are tested here rather than
 * only through the command that calls them: the interesting behavior is the
 * last-write-wins collapse and the ambiguous-prefix refusal, neither of which a
 * command-level test distinguishes from "no agents".
 */

function task(overrides: Partial<Extract<SessionRecord, { type: 'subagent_task' }>>): SessionRecord {
  return {
    type: 'subagent_task',
    id: `r-${Math.random().toString(36).slice(2)}`,
    agentId: 'agent-1',
    subagentType: 'general',
    status: 'running',
    description: 'do a thing',
    task: 'the prompt',
    createdAt: 'now',
    ...overrides,
  } as SessionRecord
}

async function seed(records: SessionRecord[]): Promise<{ store: SessionStore; sessionId: string; cwd: string }> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-subagents-'))
  const store = new SessionStore(cwd)
  await store.init()
  const session = await store.create('inspection test')
  for (const record of records) await store.appendRecord(session.id, record)
  return { store, sessionId: session.id, cwd }
}

test('the latest record for an agent wins', () => {
  const collapsed = latestSubagentTasks([
    task({ agentId: 'a', status: 'running' }),
    task({ agentId: 'b', status: 'completed' }),
    task({ agentId: 'a', status: 'completed', summary: 'done' }),
  ])

  assert.equal(collapsed.length, 2)
  const a = collapsed.find((entry) => entry.agentId === 'a')
  assert.equal(a?.status, 'completed', 'a stale running status would show an agent working forever')
  assert.equal(a?.summary, 'done')
})

test('transcripts collapse the same way and ignore task records', () => {
  const transcripts = latestSubagentTranscripts([
    task({ agentId: 'a' }),
    { type: 'subagent_transcript', id: 't1', agentId: 'a', transcriptPath: '/one', createdAt: 'now' } as SessionRecord,
    { type: 'subagent_transcript', id: 't2', agentId: 'a', transcriptPath: '/two', createdAt: 'now' } as SessionRecord,
  ])

  assert.equal(transcripts.length, 1)
  assert.equal(transcripts[0]?.transcriptPath, '/two')
})

test('an exact id beats a prefix that would otherwise be ambiguous', () => {
  const tasks = [task({ agentId: 'abc' }), task({ agentId: 'abcdef' })].map((record) =>
    record as Extract<SessionRecord, { type: 'subagent_task' }>)

  assert.equal(resolveAgentId('abc', tasks, []), 'abc')
  assert.equal(resolveAgentId('abcd', tasks, []), 'abcdef')
  assert.equal(resolveAgentId('zzz', tasks, []), null)
})

test('an ambiguous prefix throws and names the candidates', () => {
  const tasks = [task({ agentId: 'abc111' }), task({ agentId: 'abc222' })].map((record) =>
    record as Extract<SessionRecord, { type: 'subagent_task' }>)

  assert.throws(() => resolveAgentId('abc', tasks, []), /Ambiguous subagent id abc: abc111, abc222/)
})

test('a prefix can resolve against a transcript with no surviving task record', () => {
  const transcripts = [
    { type: 'subagent_transcript', id: 't1', agentId: 'orphan-9', transcriptPath: '/p', createdAt: 'now' },
  ] as Array<Extract<SessionRecord, { type: 'subagent_transcript' }>>

  assert.equal(resolveAgentId('orph', [], transcripts), 'orphan-9')
})

test('listLatestSubagentTasks reads through the store', async () => {
  const { store, sessionId } = await seed([
    task({ agentId: 'a', status: 'running' }),
    task({ agentId: 'a', status: 'interrupted' }),
  ])

  const tasks = await listLatestSubagentTasks(store, sessionId)
  assert.deepEqual(tasks.map((entry) => entry.status), ['interrupted'])
})

test('getSubagentDetails loads the sidechain transcript when there is a path', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'hanekawa-sidechain-'))
  const transcriptPath = path.join(cwd, 'agent.jsonl')
  await writeFile(
    transcriptPath,
    `${JSON.stringify({ type: 'message', id: 'x1', role: 'assistant', content: 'hi', createdAt: 'now' })}\n`,
    'utf8',
  )

  const { store, sessionId } = await seed([task({ agentId: 'agent-7', status: 'completed', transcriptPath })])

  const details = await getSubagentDetails(store, sessionId, 'agent-7')
  assert.ok(details)
  assert.equal(details.task?.agentId, 'agent-7')
  assert.equal(details.transcriptRecords.length, 1)
})

test('getSubagentDetails returns null for an unknown agent rather than throwing', async () => {
  const { store, sessionId } = await seed([task({ agentId: 'agent-7' })])
  assert.equal(await getSubagentDetails(store, sessionId, 'nobody'), null)
})

test('getSubagentDetails yields an empty transcript when no path was recorded', async () => {
  const { store, sessionId } = await seed([task({ agentId: 'agent-7', status: 'completed' })])

  const details = await getSubagentDetails(store, sessionId, 'agent-7')
  assert.deepEqual(details?.transcriptRecords, [])
})

test('cleanup skips running agents and agents with no worktree', async () => {
  // Deliberately paths that were never created: `inspect` should report them
  // gone rather than throwing, and cleanup is skipped for anything absent.
  const gone = path.join(tmpdir(), 'hanekawa-worktree-that-never-existed')
  const { store, sessionId, cwd } = await seed([
    task({ agentId: 'running', status: 'running', worktreePath: `${gone}-running` }),
    task({ agentId: 'no-worktree', status: 'completed' }),
    task({ agentId: 'done', status: 'completed', worktreePath: `${gone}-done` }),
  ])

  const result = await cleanupSubagentWorktrees(store, sessionId, cwd, false)

  assert.equal(result.dryRun, true, 'apply: false must report itself as a dry run')
  assert.deepEqual(result.entries.map((entry) => entry.agentId), ['done'],
    'a running agent still owns its worktree, and one without a path has nothing to clean')
  assert.equal(result.entries[0]?.exists, false)
  assert.equal(result.entries[0]?.removed, undefined)
})
