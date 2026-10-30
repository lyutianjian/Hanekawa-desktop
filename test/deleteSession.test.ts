import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  deleteSessionArtifacts,
  removeSubagentTranscripts,
} from '../src/runtime/deleteSession.js'
import { getSubagentTranscriptDir } from '../src/harness/sidechainRecordStream.js'
import { sessionAttachmentsDir } from '../src/services/imageAttachments/imageAttachmentService.js'
import { getProjectDataDir, getToolResultSpillDir } from '../src/utils/paths.js'

/**
 * `deleteSessionArtifacts` — the one place that knows what a session leaves on
 * disk.
 *
 * The reason it exists is the reason these cases matter: the list used to be
 * spelled inline in `ShellHost.deleteSession` with two of the four entries, so
 * `sessions/subagents/<id>/` (and later `tool-results/<id>/`) outlived every other
 * trace of a deleted session. A test per artifact is what makes the fifth one
 * someone adds get noticed.
 */

const SESSION = '00000000-0000-4000-8000-000000000000'
const OTHER = '11111111-1111-4111-8111-111111111111'

async function makeCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-delete-session-'))
}

/**
 * Every project-local artifact for one session, so a removal can be checked to
 * be complete. The file history is deliberately absent: it lives under the
 * global `~/.hanekawa`, and `test/fileHistoryService.test.ts` covers it there.
 */
async function seed(cwd: string, sessionId: string): Promise<string[]> {
  const subagents = getSubagentTranscriptDir(cwd, sessionId)
  const attachments = sessionAttachmentsDir(cwd, sessionId)
  const spill = getToolResultSpillDir(cwd, sessionId)

  await mkdir(subagents, { recursive: true })
  await writeFile(path.join(subagents, 'agent-1.jsonl'), '{}\n', 'utf8')
  await mkdir(path.join(attachments, 'img-1'), { recursive: true })
  await writeFile(path.join(attachments, 'img-1', 'metadata.json'), '{}', 'utf8')
  await mkdir(spill, { recursive: true })
  await writeFile(path.join(spill, 'toolu_1.txt'), 'long output', 'utf8')

  return [subagents, attachments, spill]
}

class RecordingStore {
  readonly deleted: string[] = []
  async delete(idOrPrefix: string): Promise<void> {
    this.deleted.push(idOrPrefix)
  }
}

test('every artifact of a session is removed, not just the store files', async () => {
  const cwd = await makeCwd()
  try {
    const mine = await seed(cwd, SESSION)
    const theirs = await seed(cwd, OTHER)
    const store = new RecordingStore()

    await deleteSessionArtifacts(cwd, store, SESSION)

    assert.deepEqual(store.deleted, [SESSION])
    for (const target of mine) {
      assert.equal(existsSync(target), false, `expected ${path.basename(target)} to be gone`)
    }
    for (const target of theirs) {
      assert.equal(existsSync(target), true, `expected another session's ${path.basename(target)} to survive`)
    }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deleting a session removes its cached attachments but never the imported source file', async () => {
  // Design §12.3, last row: the cached copies under `.hanekawa/attachments/`
  // are the session's; the file the user pointed at is theirs.
  const cwd = await makeCwd()
  try {
    await seed(cwd, SESSION)
    const source = path.join(cwd, 'screenshot.png')
    await writeFile(source, 'not really a png', 'utf8')

    await deleteSessionArtifacts(cwd, new RecordingStore(), SESSION)

    assert.equal(existsSync(sessionAttachmentsDir(cwd, SESSION)), false)
    assert.equal(existsSync(source), true)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a session that wrote nothing beyond its store files deletes cleanly', async () => {
  const cwd = await makeCwd()
  try {
    const store = new RecordingStore()
    await deleteSessionArtifacts(cwd, store, SESSION)
    assert.deepEqual(store.deleted, [SESSION])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the store goes first, so a later failure leaves an orphan rather than a half-deleted row', async () => {
  const cwd = await makeCwd()
  try {
    const order: string[] = []
    const store = {
      async delete(id: string): Promise<void> {
        order.push(`store:${id}`)
      },
    }
    await seed(cwd, SESSION)
    await deleteSessionArtifacts(cwd, store, SESSION)
    assert.deepEqual(order, [`store:${SESSION}`])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a malformed id is refused before anything is deleted', async () => {
  // The id reaches here from the shell's `delete-session`, and two of the four
  // removals are `recursive` — `''` and `'.'` both collapse to the directory
  // holding every session's copy of that artifact.
  const cwd = await makeCwd()
  try {
    await seed(cwd, SESSION)
    const store = new RecordingStore()
    const roots = [
      path.join(getProjectDataDir(cwd), 'sessions', 'subagents'),
    ]

    for (const bad of ['', '.', '..', 'a/b', 'a\\b', `${SESSION}/..`]) {
      await assert.rejects(
        () => deleteSessionArtifacts(cwd, store, bad),
        /Invalid session ID/,
        `expected ${JSON.stringify(bad)} to be refused`,
      )
      await assert.rejects(() => removeSubagentTranscripts(cwd, bad), /Invalid session ID/)
    }

    assert.deepEqual(store.deleted, [], 'and the store was never asked')
    for (const root of roots) assert.equal(existsSync(root), true, `${root} survived`)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
