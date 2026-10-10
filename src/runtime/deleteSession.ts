import { rm } from 'node:fs/promises'
import { getToolResultSpillDir } from '../utils/paths.js'
import { getSubagentTranscriptDir } from '../harness/sidechainRecordStream.js'
import { GitSubagentWorktreeManager } from '../services/agents/subagentWorktree.js'
import { CoordinationStore } from '../services/coordination/threadStore.js'
import { removeThreadWorktree } from '../services/coordination/threadWorktree.js'
import { removeFileHistory } from '../services/fileHistory/fileHistoryService.js'
import { removeSessionAttachmentsAt } from '../services/imageAttachments/imageAttachmentService.js'
import { assertSafeSessionId, type SessionMeta } from '../sessions/service.js'

/**
 * Everything one session leaves on disk, deleted in one place.
 *
 * This exists because "delete a session" had no owner. `SessionStore.delete`
 * removes three files and an index entry — which is all it can, since the other
 * artifacts belong to modules that sit *above* `sessions/` in the layering and
 * calling back down would be a cycle. So the composition has to live somewhere,
 * and until this module it lived in the Electron shell: `ShellHost.deleteSession`
 * called the store and then removed the session's snapshots, which left two more
 * directories behind, and any second deletion path (a `/delete` command, a TUI
 * list, a cleanup job) would have started from zero and leaked all three.
 *
 * `runtime/` is the layer that already depends on both `harness/` and
 * `services/`, so it is the only place the full list can be named.
 *
 * **Adding an artifact goes here.** If a feature starts writing
 * `.myagent/<something>/<sessionId>`, this function is what makes it removable.
 */

/** The slice of `SessionStore` this needs. Structural so a test fakes it without casting. */
export interface SessionArtifactStore {
  delete(idOrPrefix: string): Promise<void>
}

/**
 * Deletes every artifact of one session.
 *
 * `sessionId` must be the id the store **resolved**, not a prefix: `store.delete`
 * accepts a prefix but every path below turns the string into a directory or
 * filename, so a prefix would delete the right index entry and miss (or worse,
 * mis-target) the rest. The guard is the store's own, and it rejects `''`, `'.'`,
 * `'..'` and anything carrying a separator — two of the removals below are
 * `recursive`, and `path.join(dir, '')` is `dir`.
 *
 * Best-effort per artifact and sequential: the store goes first because its index
 * entry is what makes the session *visible*, so a failure later leaves an
 * orphaned directory rather than a row pointing at a half-deleted session.
 */
export async function deleteSessionArtifacts(
  cwd: string,
  store: SessionArtifactStore,
  sessionId: string,
): Promise<void> {
  assertSafeSessionId(sessionId)
  await store.delete(sessionId)
  // Unlike every other artifact here, the file history lives under the global
  // `~/.myagent`, not the project — deleting the project would not take it.
  await removeFileHistory(sessionId)
  await removeSubagentTranscripts(cwd, sessionId)
  await rm(getToolResultSpillDir(cwd, sessionId), { recursive: true, force: true })
  // The session's imported images, including the ones its subagents imported —
  // those are stored under the parent session on purpose (design §12.3), so
  // this one removal covers the whole transcript's images. Only the copies in
  // `attachments/`: the files the user imported *from* are theirs and
  // are never touched.
  await removeSessionAttachmentsAt(cwd, sessionId)
  await cleanupCoordination(cwd, store, sessionId)
  // Last: the only removal here that runs git, so the one most likely to throw.
  await new GitSubagentWorktreeManager().cleanupSession({ cwd, parentSessionId: sessionId })
}

/**
 * The session's subagent transcripts — one file per background agent it ran.
 *
 * Separate export because `/agents cleanup` removes subagent git worktrees and
 * not these, so a future caller may want one without the other.
 */
export async function removeSubagentTranscripts(cwd: string, sessionId: string): Promise<void> {
  assertSafeSessionId(sessionId)
  await rm(getSubagentTranscriptDir(cwd, sessionId), { recursive: true, force: true })
}

/** Re-exported so a caller resolving before deleting has the type to hand. */
export type { SessionMeta }

/**
 * The thread sessions deleting `sessionId` takes with it: none unless it is the
 * project's coordinator. The shell detaches their lanes before deleting.
 */
export async function coordinatedThreadSessionIds(cwd: string, sessionId: string): Promise<string[]> {
  const file = await new CoordinationStore(cwd).read()
  if (file.coordinator?.sessionId !== sessionId) return []
  return file.threads.flatMap((t) => (t.sessionId && t.status !== 'stale' ? [t.sessionId] : []))
}

/**
 * A deleted thread session stays in the table as `stale` so `message_thread`
 * can say why it is gone. A deleted coordinator ends the project's
 * coordination: the file goes first, so the thread deletions below find no
 * table to patch, then every thread's worktree and session. A project without
 * a coordination file is left untouched — `read()` does not create it.
 */
async function cleanupCoordination(cwd: string, store: SessionArtifactStore, sessionId: string): Promise<void> {
  const coordination = new CoordinationStore(cwd)
  const file = await coordination.read()
  if (file.coordinator?.sessionId === sessionId) {
    await coordination.removeAll()
    for (const thread of file.threads) {
      if (thread.worktree) await removeThreadWorktree(cwd, thread.worktree)
      if (thread.sessionId && thread.status !== 'stale') await deleteSessionArtifacts(cwd, store, thread.sessionId)
    }
    return
  }
  const thread = file.threads.find((t) => t.sessionId === sessionId)
  if (!thread) return
  await coordination.patchThread(thread.threadId, { status: 'stale', statusLine: 'session deleted' })
  if (thread.worktree) await removeThreadWorktree(cwd, thread.worktree)
}
