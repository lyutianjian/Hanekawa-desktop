import { randomUUID } from 'node:crypto'
import type { SessionRecord } from '../harness/types.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { SessionDiagnostic, SessionMeta } from '../sessions/service.js'
import type { RuntimeSlot } from './runtimeSlot.js'
import type { SessionController } from './sessionController.js'
import type { RuntimeHost } from './types.js'

/**
 * Switching the session a runtime is bound to.
 *
 * Retargeting the controller is only half of it: the `AgentLoop` is built
 * around a session and its records, so a switch that skips `createRuntime` +
 * `RuntimeSlot.replace` leaves the loop writing into the session it just left.
 * Background tasks have to be reattached too, and agents that died with a
 * previous process have to be reconciled, or the transcript shows them running
 * forever.
 */
export interface SessionSwitchDeps {
  /**
   * Deliberately narrower than `RuntimeHost`: the TUI holds these two as
   * separate props and has no host object to hand over. Widening this back to
   * the whole host is what would force a shell to own members it does not use.
   */
  host: Pick<RuntimeHost, 'store' | 'createRuntime'>
  runtimeSlot: RuntimeSlot
  controller: SessionController
  backgroundTasks: BackgroundTaskRegistry
  /**
   * Runs once the records are loaded and before the runtime is swapped.
   *
   * The message queue is why this exists, and it has to be rebound *before* the
   * new runtime goes live: past `RuntimeSlot.replace` there is an await boundary
   * on which a queue still keyed to the previous session could pump into the new
   * one. A new session's id does not exist until `createDraft()`, so no caller
   * can do this ahead of the call.
   *
   * Which side owns that queue depends on the shell, so this hook does not care:
   * the terminal's belongs to `App.tsx`, while the desktop's lives in
   * `SessionHost` (it is persisted through `store.appendRecord`, and its pump
   * gate reads whether a blocking UI request is outstanding — neither of which a
   * renderer can see). Both pass a closure over their own instance.
   */
  beforeApply?: (session: SessionMeta, records: readonly SessionRecord[]) => Promise<void>
}

export interface SessionSwitchResult {
  session: SessionMeta
  records: SessionRecord[]
  /**
   * Raw rather than formatted. A terminal surfaces only these, while a host
   * folds them together with the MCP status into `StartupNotice`s — and doing
   * that here would need `mcp`, which puts the whole `RuntimeHost` back into the
   * deps above.
   */
  diagnostics: SessionDiagnostic[]
}

export async function switchToExistingSession(
  deps: SessionSwitchDeps,
  sessionId: string,
): Promise<SessionSwitchResult> {
  assertNotBusy(deps.controller)
  const meta = await deps.host.store.resolve(sessionId)
  if (!meta) throw new Error(`Unknown session: ${sessionId}`)

  const loaded = await deps.host.store.loadRecordsWithDiagnostics(meta.id)
  const records = [...loaded.records]

  // Already-registered tasks mean this session is live in-process; restoring it
  // again would double-register every one of them.
  const alreadyRegistered = deps.backgroundTasks.getSnapshot(meta.id).length > 0
  const orphanedAgentIds = alreadyRegistered
    ? []
    : await deps.backgroundTasks.restoreSession(meta.id, records)

  for (const record of reconcileOrphanedAgents(records, orphanedAgentIds)) {
    await deps.host.store.appendRecord(meta.id, record)
    records.push(record)
  }

  await applySwitch(deps, meta, records)

  return { session: meta, records, diagnostics: loaded.diagnostics }
}

export async function switchToNewSession(
  deps: SessionSwitchDeps,
  options: { previousSessionId: string; title?: string },
): Promise<SessionSwitchResult> {
  assertNotBusy(deps.controller)
  deps.runtimeSlot.current?.loop.clearCachedSections()
  await deps.backgroundTasks.stopAll(options.previousSessionId, 'Session cleared')

  const meta = options.title
    ? deps.host.store.createDraft(options.title)
    : deps.host.store.createDraft()

  await applySwitch(deps, meta, [])
  // The queue migration in beforeApply still writes to the outgoing draft.
  // Release it only after those records and the new binding have settled.
  deps.host.store.discardDraft(options.previousSessionId)

  return { session: meta, records: [], diagnostics: [] }
}

/**
 * Refuses a switch while the lane is still working.
 *
 * Placed before every other statement in both entry points, not merely before
 * the swap: a turn keeps appending through the controller and the loop, so a
 * switch that began first would still let the old turn land its failure,
 * rollback or usage in the new session. The check is synchronous and the turn's
 * busy flag is set before its first await, so no interleaving can slip past it.
 */
function assertNotBusy(controller: SessionController): void {
  const busy = controller.busyKind()
  if (busy === undefined) return
  throw new Error(busy === 'compaction'
    ? '上下文正在压缩，请等它结束再切换会话。'
    : '当前回合仍在进行，请先停止再切换会话。')
}

async function applySwitch(
  deps: SessionSwitchDeps,
  meta: SessionMeta,
  records: SessionRecord[],
): Promise<void> {
  await deps.beforeApply?.(meta, records)
  const current = deps.runtimeSlot.current
  const next = current ? deps.host.createRuntime(current.modelKey, meta, records) : undefined
  deps.controller.retarget(meta, records)
  // Last, and never an assignment: replace installs the new runtime before
  // disposing the old one, so a late dispose cannot tear down its successor.
  deps.runtimeSlot.replace(next, deps.runtimeSlot.getSnapshot().configurationIssue)
}

/**
 * Synthesizes `subagent_task` interruption records for agents that were still
 * marked running but did not survive into this process.
 *
 * Pure so the policy can be tested without a store: the caller persists and
 * appends whatever comes back.
 */
export function reconcileOrphanedAgents(
  records: readonly SessionRecord[],
  orphanedAgentIds: Iterable<string>,
  now: () => string = () => new Date().toISOString(),
  createId: () => string = randomUUID,
): SessionRecord[] {
  const orphaned = [...orphanedAgentIds]
  if (orphaned.length === 0) return []

  const latestTasks = new Map<string, Extract<SessionRecord, { type: 'subagent_task' }>>()
  for (const record of records) {
    if (record.type === 'subagent_task') latestTasks.set(record.agentId, record)
  }

  const interruptions: SessionRecord[] = []
  for (const agentId of orphaned) {
    const previous = latestTasks.get(agentId)
    if (!previous || previous.status !== 'running') continue
    interruptions.push({
      ...previous,
      id: createId(),
      status: 'interrupted',
      error: 'Background agent was not present when the session resumed',
      createdAt: now(),
    })
  }
  return interruptions
}
