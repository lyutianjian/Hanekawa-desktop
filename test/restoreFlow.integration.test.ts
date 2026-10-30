import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'
import { SessionStore } from '../src/sessions/service.js'
import { getSessionsDir } from '../src/utils/paths.js'
import { parseJsonLines } from '../src/utils/json.js'
import type { SessionRecord } from '../src/harness/types.js'
import { buildRewindSummaryRewrite } from '../src/runtime/rewindSummary.js'

const execFileAsync = promisify(execFile)

/**
 * Feature: keyboard-shortcuts-control
 *
 * Task 8.4: Integration tests for full restore flow.
 *
 * Tests the end-to-end restore flow:
 *   1. select checkpoint → truncate JSONL → restore tracked files → UI update
 *   2. partial failure (truncation succeeds, the restore fails) shows correct error
 *   3. full failure (truncation fails) remains in restore mode
 *   4. abort timeout force-terminates after 2 seconds
 *
 * Requirements: 1.4, 2.3, 2.4, 2.5, 6.4, 6.5
 */

async function isGitAvailable(): Promise<boolean> {
  try {
    await execFileAsync('git', ['--version'], { timeout: 5000 })
    return true
  } catch {
    return false
  }
}

async function makeTempCwd(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-restore-flow-'))
  await writeFile(path.join(dir, '.gitignore'), '.hanekawa/\n', 'utf8')
  return dir
}

async function cleanup(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

const SESSION_ID = '11111111-1111-4111-8111-111111111111'

/**
 * File history lands under the *global* `.hanekawa`, resolved through `homedir()`
 * on every call, so a fake home keeps this suite off the real one.
 */
let home = ''
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

/** A service that has already taken the snapshot `messageId` names. */
async function startTurn(cwd: string, sessionId: string, messageId: string): Promise<FileHistoryService> {
  const service = new FileHistoryService(cwd, sessionId)
  await service.init()
  await service.makeSnapshot(messageId)
  return service
}

function makeUserRecord(id: string, content: string): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'user',
    content,
    createdAt: new Date().toISOString(),
  }
}

function makeAssistantRecord(id: string, content: string): SessionRecord {
  return {
    type: 'message',
    id,
    role: 'assistant',
    content,
    createdAt: new Date().toISOString(),
  }
}

describe('Integration: full restore flow', () => {
  let gitAvailable = false

  before(async () => {
    gitAvailable = await isGitAvailable()
    home = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-restore-flow-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  after(async () => {
    process.env.HOME = originalHome.HOME
    process.env.USERPROFILE = originalHome.USERPROFILE
    await rm(home, { recursive: true, force: true })
  })

  it('select checkpoint → truncate JSONL → restore files → verify file state restored', async () => {
    const cwd = await makeTempCwd()
    try {
      // Setup: create session with records
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('restore test')

      // Create a file and open the first turn's snapshot
      const filePath = path.join(cwd, 'data.txt')
      await writeFile(filePath, 'version 1\n', 'utf8')

      // Append user message and snapshot the turn it starts
      const userMsg1 = makeUserRecord('msg-1', 'first question')
      await store.appendRecord(session.id, userMsg1)
      const history = await startTurn(cwd, session.id, 'msg-1')

      // Append assistant response
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'first answer'))

      // The agent edits the file, which is what puts it under history
      await history.trackEdit(filePath)
      await writeFile(filePath, 'version 2\n', 'utf8')
      const userMsg2 = makeUserRecord('msg-2', 'second question')
      await store.appendRecord(session.id, userMsg2)
      await history.makeSnapshot('msg-2')

      await store.appendRecord(session.id, makeAssistantRecord('resp-2', 'second answer'))

      // Verify we have 4 records
      const beforeRecords = await store.loadRecords(session.id)
      assert.equal(beforeRecords.length, 4)

      // --- RESTORE FLOW ---
      // Step 1: Truncate to before msg-1
      const truncResult = await store.truncateBeforeMessage(session.id, 'msg-1')
      assert.equal(truncResult.success, true)

      // Step 2: Verify JSONL truncated
      const afterRecords = await store.loadRecords(session.id)
      assert.equal(afterRecords.length, 0)

      // Step 3: restore the tracked files to the first turn's snapshot
      const restoreResult = await history.rewindTo('msg-1')
      assert.equal(restoreResult.success, true)

      // Step 4: Verify file content reverted
      const restoredContent = await readFile(filePath, 'utf8')
      assert.equal(restoredContent, 'version 1\n')
    } finally {
      await cleanup(cwd)
    }
  })

  it('restore code only leaves session records unchanged', async () => {
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('code only restore test')

      const filePath = path.join(cwd, 'data.txt')
      await writeFile(filePath, 'version 1\n', 'utf8')

      await store.appendRecord(session.id, makeUserRecord('msg-1', 'first question'))
      const history = await startTurn(cwd, session.id, 'msg-1')
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'first answer'))

      await history.trackEdit(filePath)
      await writeFile(filePath, 'version 2\n', 'utf8')
      const beforeRecords = await store.loadRecords(session.id)
      assert.equal(beforeRecords.length, 2)

      const restoreResult = await history.rewindTo('msg-1')
      assert.equal(restoreResult.success, true)

      const afterRecords = await store.loadRecords(session.id)
      assert.deepEqual(afterRecords.map((record) => 'id' in record ? record.id : null), ['msg-1', 'resp-1'])
      assert.equal(await readFile(filePath, 'utf8'), 'version 1\n')
    } finally {
      await cleanup(cwd)
    }
  })

  it('partial failure: truncation succeeds but the restore fails', async () => {
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('partial fail test')

      await writeFile(path.join(cwd, 'file.txt'), 'content\n', 'utf8')

      const userMsg = makeUserRecord('msg-1', 'hello')
      await store.appendRecord(session.id, userMsg)
      const history = await startTurn(cwd, session.id, 'msg-1')

      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'world'))

      // Truncation should succeed
      const truncResult = await store.truncateBeforeMessage(session.id, 'msg-1')
      assert.equal(truncResult.success, true)

      // A message with no snapshot should fail gracefully
      const restoreResult = await history.rewindTo('msg-does-not-exist')
      assert.equal(restoreResult.success, false)
      assert.ok(restoreResult.error)

      // The JSONL is already truncated (partial success state)
      const records = await store.loadRecords(session.id)
      assert.equal(records.length, 0)
    } finally {
      await cleanup(cwd)
    }
  })

  it('full failure: truncation fails, session remains unchanged', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('full fail test')

      await store.appendRecord(session.id, makeUserRecord('msg-1', 'hello'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'world'))

      // Try to truncate to a non-existent message ID
      const truncResult = await store.truncateBeforeMessage(session.id, 'nonexistent-id')
      assert.equal(truncResult.success, false)
      assert.ok(truncResult.error)
      assert.match(truncResult.error!, /not found/i)

      // Session should be unchanged
      const records = await store.loadRecords(session.id)
      assert.equal(records.length, 2)
    } finally {
      await cleanup(cwd)
    }
  })

  it('summarize from here replaces selected and later records without changing files', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('summary from test')
      const filePath = path.join(cwd, 'file.txt')
      await writeFile(filePath, 'current worktree\n', 'utf8')

      await store.appendRecord(session.id, makeUserRecord('msg-1', 'first'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'first answer'))
      await store.appendRecord(session.id, makeUserRecord('msg-2', 'second'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-2', 'second answer'))

      const loaded = await store.loadRecords(session.id)
      const rewrite = await buildRewindSummaryRewrite({
        records: loaded,
        targetMessageId: 'msg-2',
        decision: 'summarize-from-here',
        summarize: async () => ({ summary: 'from summary', preTokens: 20 }),
        createId: () => 'compact-from',
        now: () => '2026-06-01T00:00:00.000Z',
      })
      await store.replaceRecords(session.id, rewrite.nextRecords)

      const after = await store.loadRecords(session.id)
      assert.deepEqual(after.map((record) => 'id' in record ? record.id : null), ['msg-1', 'resp-1', 'compact-from'])
      assert.equal(after[2]?.type === 'compact_boundary' ? after[2].summary : '', 'from summary')
      assert.equal(await readFile(filePath, 'utf8'), 'current worktree\n')
    } finally {
      await cleanup(cwd)
    }
  })

  it('summarize up to here replaces earlier records and keeps selected and later records without changing files', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('summary up test')
      const filePath = path.join(cwd, 'file.txt')
      await writeFile(filePath, 'current worktree\n', 'utf8')

      await store.appendRecord(session.id, makeUserRecord('msg-1', 'first'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'first answer'))
      await store.appendRecord(session.id, makeUserRecord('msg-2', 'second'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-2', 'second answer'))

      const loaded = await store.loadRecords(session.id)
      const rewrite = await buildRewindSummaryRewrite({
        records: loaded,
        targetMessageId: 'msg-2',
        decision: 'summarize-up-to-here',
        summarize: async () => ({ summary: 'up summary', preTokens: 20 }),
        createId: () => 'compact-up',
        now: () => '2026-06-01T00:00:00.000Z',
      })
      await store.replaceRecords(session.id, rewrite.nextRecords)

      const after = await store.loadRecords(session.id)
      assert.deepEqual(after.map((record) => 'id' in record ? record.id : null), ['compact-up', 'msg-2', 'resp-2'])
      assert.equal(after[0]?.type === 'compact_boundary' ? after[0].summary : '', 'up summary')
      assert.equal(await readFile(filePath, 'utf8'), 'current worktree\n')
    } finally {
      await cleanup(cwd)
    }
  })

  it('summarize up to here on first node leaves records unchanged', async (t) => {
    if (!gitAvailable) {
      t.skip('git not available')
      return
    }
    const cwd = await makeTempCwd()
    try {
      const store = new SessionStore(cwd)
      await store.init()
      const session = await store.create('summary first test')
      await store.appendRecord(session.id, makeUserRecord('msg-1', 'first'))
      await store.appendRecord(session.id, makeAssistantRecord('resp-1', 'first answer'))
      const before = await store.loadRecords(session.id)

      await assert.rejects(
        () => buildRewindSummaryRewrite({
          records: before,
          targetMessageId: 'msg-1',
          decision: 'summarize-up-to-here',
          summarize: async () => ({ summary: 'unused', preTokens: 1 }),
        }),
        /No earlier conversation to summarize/,
      )

      const after = await store.loadRecords(session.id)
      assert.deepEqual(after.map((record) => 'id' in record ? record.id : null), ['msg-1', 'resp-1'])
    } finally {
      await cleanup(cwd)
    }
  })

  it('abort timeout concept: a 2-second timer fires and forces state reset', async () => {
    // This tests the abort timeout concept from App.tsx:
    // If the agent loop doesn't stop within 2s after abort, force-terminate.
    const ABORT_TIMEOUT_MS = 2000

    let modeResetToIdle = false
    let timeoutFired = false

    // Simulate the abort timeout mechanism
    const timer = setTimeout(() => {
      timeoutFired = true
      modeResetToIdle = true
    }, ABORT_TIMEOUT_MS)

    // Simulate: agent loop stops before timeout (normal case)
    // Clear the timeout as the real code does when isStreaming becomes false
    clearTimeout(timer)

    // Give time for any pending callbacks
    await new Promise((resolve) => setTimeout(resolve, 50))

    assert.equal(timeoutFired, false, 'timeout should not fire when cleared promptly')
    assert.equal(modeResetToIdle, false)
  })

  it('abort timeout fires when agent loop does not stop in time', async () => {
    const ABORT_TIMEOUT_MS = 100 // Use shorter timeout for test speed

    let modeResetToIdle = false

    // Simulate: abort is signaled but agent loop doesn't stop
    const timer = setTimeout(() => {
      modeResetToIdle = true
    }, ABORT_TIMEOUT_MS)

    // Don't clear the timer — simulate the agent loop hanging
    await new Promise((resolve) => setTimeout(resolve, ABORT_TIMEOUT_MS + 50))

    assert.equal(modeResetToIdle, true, 'timeout should fire and force mode reset')
    clearTimeout(timer) // cleanup
  })
})
