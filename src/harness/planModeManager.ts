/**
 * PlanModeManager — Hanekawa plan-mode orchestrator.
 *
 * Aligned with Claude Code's real model (verified against
 * ClaudeCode/src/tools/EnterPlanModeTool + ExitPlanModeV2Tool):
 *
 *   - Entering plan mode does NOT create a file. The slug is generated
 *     lazily on first call to getPlanFilePath / getOrCreatePlanSlug.
 *   - Plan files live at <plansDir>/<slug>.md (main) or
 *     <plansDir>/<slug>-agent-<agentId>.md (sub-agent). The model writes
 *     the file itself via Write/Edit; the permission gate auto-allows any
 *     path matching the prefix.
 *   - ExitPlanMode receives `{plan?: string}`. Inline plan content is the
 *     preferred Claude Code-style path and is mirrored to disk only so the
 *     review dialog/editor has a backing file. If absent, the manager reads
 *     the optional draft file for compatibility.
 *   - The exit dialog opens directly. No convergence loop.
 */

import { existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import {
  clearPlanSlug,
  getOrCreatePlanSlug,
  getPlanFilePath,
  getPlanSlug,
  readPlan,
  writePlan,
} from '../utils/plans.js'
import {
  buildFullPlanModeReminder,
  buildPlanFileReferenceReminder,
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  shouldInjectPlanAttachment,
} from './planModeAttachments.js'
import type { PermissionGate } from './permissions.js'
import type { SessionStore, SessionMeta } from '../sessions/service.js'
import type { PlanModeBridge, SessionRecord } from './types.js'
import { wrapInSystemReminder } from './systemReminder.js'

/** Plan-mode state. Slug now lives in the in-memory cache in utils/plans.ts —
 *  this state only carries flags and counters that don't need to persist. */
export interface PlanModeState {
  /** True while gate is in plan mode. Set by onEnterPlanMode, cleared by
   *  onExitPlanMode. */
  active: boolean
  /** True if this session has exited plan mode at least once. Used by the
   *  attachment system to choose 'reentry' vs 'full' reminder. */
  hasExitedThisSession: boolean
  /** True between exit and next beforeTurn; signals attachment system to
   *  emit a one-shot exit reminder. Cleared after consumption. */
  needsExitAttachment: boolean
  /** Tool-use turns completed since this entry into plan mode. */
  toolUseTurnsSinceEntry: number
  /** Total attachment injections. Guards the one-shot entry attachment. */
  attachmentInjections: number
  /** Plan content captured on the most recent approve dispatch — embedded
   *  by buildPlanModeExitReminder. */
  lastApprovedPlanContent?: string
}

/** Input passed to openExitDialog. */
export interface ExitDialogInput {
  planContent: string
  planFilePath: string
  /**
   * True when the dialog should expose the `bypassPermissions` exit
   * options. Mirrors Claude Code's `isBypassPermissionsModeAvailable` —
   * shown when the user originally entered plan mode from bypass, since
   * surfacing bypass to a user who never opted in could downgrade safety.
   */
  isBypassAvailable?: boolean
}

/** Decision returned by the dialog. */
export type ExitPlanDecision =
  | { kind: 'approve_restore_keep', planContent?: string }
  | { kind: 'approve_auto_keep', planContent?: string }
  | { kind: 'approve_bypass_keep', planContent?: string }
  | { kind: 'reject', feedback: string }

export interface PlanModeManagerDeps {
  cwd: string
  sessionMeta: SessionMeta
  store: SessionStore
  gate: PermissionGate
  /** Append a record to the main session's record stream. */
  appendRecord(record: SessionRecord): Promise<void>
  /** Read records from the session record stream — used by drainRequests
   *  to find unhandled plan_mode_request entries. */
  loadRecords?: () => Promise<SessionRecord[]>
  /** UI-side hooks late-bound by App.tsx via setUiDeps. */
  emitChatMessage?(content: string): Promise<void>
  openExitDialog?(input: ExitDialogInput): Promise<ExitPlanDecision>
  openEnterPrompt?(): Promise<boolean>
}

export class PlanModeManager {
  private state: PlanModeState = {
    active: false,
    hasExitedThisSession: false,
    needsExitAttachment: false,
    toolUseTurnsSinceEntry: 0,
    attachmentInjections: 0,
  }
  constructor(private deps: PlanModeManagerDeps) {}

  /**
   * Late-bind the UI-side dependencies once React has mounted.
   */
  setUiDeps(uiDeps: Pick<PlanModeManagerDeps,
    | 'emitChatMessage'
    | 'openExitDialog'
    | 'openEnterPrompt'
  >): void {
    this.deps = { ...this.deps, ...uiDeps }
  }

  /**
   * No-op since plan-mode state is now in-memory and not persisted across
   * process restarts. Kept for call-site compatibility with TUI startup.
   * Plan mode resumes as inactive — re-enter via Shift+Tab if desired.
   */
  async onSessionLoaded(): Promise<void> {
    // Intentionally empty.
  }

  /**
   * Activate plan mode. Sets state.active=true; the gate transition is
   * handled separately by gate.prepareContextForPlanMode. Does NOT
   * generate a slug or create a file — that happens lazily when
   * getPlanFilePath is first called (by the attachment system or by the
   * model's Write tool).
   *
   * Idempotent: re-entry is a no-op except for resetting turn/attachment
   * counters so the next attachment is a 'reentry' reminder.
   *
   * Synchronous so callers can flip state in the same tick as the gate
   * transition. Returning a Promise is preserved for backward compat
   * with the previous async-based API.
   */
  onEnterPlanMode(): void {
    if (this.state.active) return
    this.state.active = true
    this.state.toolUseTurnsSinceEntry = 0
    this.state.attachmentInjections = 0
  }

  /**
   * Deactivate plan mode. Sets state.active=false, marks hasExitedThisSession,
   * and queues a one-shot exit reminder for the next turn. Synchronous.
   */
  onExitPlanMode(): void {
    if (!this.state.active) return
    this.state.active = false
    this.state.hasExitedThisSession = true
    this.state.needsExitAttachment = true
    this.state.toolUseTurnsSinceEntry = 0
    this.state.attachmentInjections = 0
  }

  /**
   * Build the bridge that sub-agent ToolContexts receive. The bridge has
   * stable references and a live getter for activePlanFilePath so a
   * sub-agent that captured it earlier still resolves the current path
   * after lazy slug generation.
   */
  buildBridge(): PlanModeBridge {
    const sessionId = this.deps.sessionMeta.id
    const cwd = this.deps.cwd
    return {
      parentSessionId: sessionId,
      parentAppendRecord: this.deps.appendRecord,
      get activePlanFilePath(): string | undefined {
        // Resolve lazily — only return a path if plan mode is active AND
        // a slug has already been generated. Don't trigger slug creation
        // from the bridge itself.
        const slug = getPlanSlug(sessionId)
        if (!slug) return undefined
        return getPlanFilePath(cwd, sessionId)
      },
    }
  }

  /** Whether plan mode is currently active. */
  isActive(): boolean {
    return this.state.active
  }

  /** Current slug (read-only — does not trigger lazy creation). */
  getSlug(): string | undefined {
    return getPlanSlug(this.deps.sessionMeta.id)
  }

  /**
   * Resolve the active plan file path WITHOUT triggering slug generation.
   * Returns undefined if plan mode is not active or no slug has been
   * generated yet (i.e., the model has not yet written a plan file).
   */
  getActivePlanFilePath(): string | undefined {
    if (!this.state.active) return undefined
    const slug = getPlanSlug(this.deps.sessionMeta.id)
    if (!slug) return undefined
    return getPlanFilePath(this.deps.cwd, this.deps.sessionMeta.id)
  }

  /**
   * Force slug generation and return the resulting path. Used by the
   * attachment system so the reminder always carries a concrete path
   * (matches Claude Code: the path appears in the first plan_mode
   * attachment, before any plan file exists).
   */
  resolvePlanFilePathLazy(): string {
    return getPlanFilePath(this.deps.cwd, this.deps.sessionMeta.id)
  }

  /**
   * Compaction integration: returns a lightweight reminder with the plan
   * slug and file path so the model can Read it if needed. Returns
   * undefined if plan mode isn't active or no slug exists yet.
   */
  async getPlanFileReferenceForCompaction(): Promise<string | undefined> {
    if (!this.state.active) return undefined
    const slug = getPlanSlug(this.deps.sessionMeta.id)
    if (!slug) return undefined
    const planPath = getPlanFilePath(this.deps.cwd, this.deps.sessionMeta.id)
    return buildPlanFileReferenceReminder(slug, planPath)
  }

  /**
   * Returns the attachment text to inject this turn, or undefined.
   * Mutates counters on injection. The attachment carries the lazy plan
   * file path so the model knows where to write/edit.
   */
  getActivePlanAttachment(): string | undefined {
    const decision = shouldInjectPlanAttachment(this.state)
    if (!decision) return undefined

    if (decision === 'exit') {
      this.state.needsExitAttachment = false
      const planContent = this.state.lastApprovedPlanContent ?? ''
      this.state.lastApprovedPlanContent = undefined
      return buildPlanModeExitReminder(planContent)
    }

    // For full/reentry: bump counter so the entry attachment stays one-shot.
    this.state.attachmentInjections += 1

    if (decision === 'reentry') {
      // Re-entry: file may exist from prior plan in same session.
      const path = this.resolvePlanFilePathLazy()
      const planExists = existsSync(path)
      return buildPlanModeReentryReminder(path, planExists)
    }
    // Default: full reminder. Always carries the plan file path.
    const path = this.resolvePlanFilePathLazy()
    const planExists = existsSync(path)
    return buildFullPlanModeReminder(path, planExists)
  }

  /**
   * Called by AgentLoop at the top of each iteration. Drains unhandled
   * plan_mode_request records and processes them.
   */
  async beforeTurn(): Promise<void> {
    await this.drainRequests()
  }

  /** Called after each tool batch completes — bumps the tool-use counter. */
  noteToolUseTurn(): void {
    if (!this.state.active) return
    this.state.toolUseTurnsSinceEntry += 1
  }


  /**
   * Read records and process any unhandled plan_mode_request entries.
   * Idempotency: a request is "handled" when a plan_mode_outcome record
   * with matching requestId already exists in the stream.
   */
  private async drainRequests(): Promise<void> {
    if (!this.deps.loadRecords) return
    let records: SessionRecord[]
    try {
      records = await this.deps.loadRecords()
    } catch {
      return
    }

    const handledRequestIds = new Set<string>()
    for (const r of records) {
      if (r.type === 'plan_mode_outcome' && r.requestId) {
        handledRequestIds.add(r.requestId)
      }
    }

    const requests = records.filter(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_request' }> =>
        r.type === 'plan_mode_request' && !handledRequestIds.has(r.id),
    )

    for (const req of requests) {
      if (req.kind === 'enter') {
        await this.processEnterRequest(req)
      } else {
        await this.processExitRequest(req)
      }
    }
  }

  private async processEnterRequest(req: Extract<SessionRecord, { type: 'plan_mode_request' }>): Promise<void> {
    const approved = this.deps.openEnterPrompt
      ? await this.deps.openEnterPrompt()
      : true

    if (approved) {
      this.deps.gate.prepareContextForPlanMode()
      await this.onEnterPlanMode()
      await this.deps.appendRecord({
        id: randomUUID(),
        type: 'plan_mode_outcome',
        kind: 'enter_approved',
        requestId: req.id,
        createdAt: new Date().toISOString(),
      })
    } else {
      await this.deps.appendRecord({
        id: randomUUID(),
        type: 'plan_mode_outcome',
        kind: 'enter_rejected',
        requestId: req.id,
        createdAt: new Date().toISOString(),
      })
      if (this.deps.emitChatMessage) {
        await this.deps.emitChatMessage(
          wrapInSystemReminder('The user declined to enter plan mode. Continue with the existing approach.'),
        )
      }
    }
  }

  private async processExitRequest(req: Extract<SessionRecord, { type: 'plan_mode_request' }>): Promise<void> {
    // Plan content is provided either inline on the request record
    // (model passed it via ExitPlanMode {plan: ...}) or read from the
    // plan file on disk. Inline is the primary path; disk is the fallback.
    let planContent = req.planContent
    const planFilePath = getPlanFilePath(this.deps.cwd, this.deps.sessionMeta.id)

    if (planContent !== undefined) {
      // Inline plan is the primary path. Persist it to disk so the review
      // dialog's external-editor path and subsequent Read calls see the same
      // approved source text.
      try {
        await writePlan(planFilePath, planContent)
      } catch {
        // Disk write failed but we still have the content — proceed.
      }
    } else {
      // Disk fallback.
      try {
        planContent = (await readPlan(planFilePath)) ?? ''
      } catch {
        planContent = ''
      }
    }

    await this.openDialogAndDispatch(req, planContent, planFilePath)
  }

  private async openDialogAndDispatch(
    req: Extract<SessionRecord, { type: 'plan_mode_request' }>,
    planContent: string,
    planFilePath: string,
  ): Promise<void> {
    if (!this.deps.openExitDialog) {
      // Without a dialog hook there's no way to make a decision; emit
      // exit_rejected so the request isn't replayed.
      await this.deps.appendRecord({
        id: randomUUID(),
        type: 'plan_mode_outcome',
        kind: 'exit_rejected',
        requestId: req.id,
        detail: 'no-dialog',
        createdAt: new Date().toISOString(),
      })
      return
    }

    const decision = await this.deps.openExitDialog({
      planContent,
      planFilePath,
      isBypassAvailable: this.deps.gate.isBypassAvailable(),
    })
    await this.dispatchExitDecision(req, planContent, planFilePath, decision)
  }

  private async dispatchExitDecision(
    req: Extract<SessionRecord, { type: 'plan_mode_request' }>,
    planContent: string,
    planFilePath: string,
    decision: ExitPlanDecision,
  ): Promise<void> {
    if (decision.kind === 'reject') {
      await this.deps.appendRecord({
        id: randomUUID(),
        type: 'plan_mode_outcome',
        kind: 'exit_rejected',
        requestId: req.id,
        detail: decision.feedback,
        ...exitOutcomeFields(req, planContent),
        createdAt: new Date().toISOString(),
      })
      if (this.deps.emitChatMessage) {
        const fb = decision.feedback.trim().length > 0
          ? decision.feedback.trim()
          : '(no specific feedback)'
        await this.deps.emitChatMessage(
          wrapInSystemReminder(`The user rejected the plan with the following feedback: ${fb}\n\nRevise the plan and call ExitPlanMode again.`),
        )
      }
      return
    }

    // All approve_* variants: use the content returned from the dialog when
    // the user edited the plan externally, persist it, then use that same
    // content for the exit attachment and clear-context prompt.
    const approvedPlanContent = decision.planContent ?? planContent
    try {
      await writePlan(planFilePath, approvedPlanContent)
    } catch {
      // The approval can still proceed because the content is in memory.
    }
    this.state.lastApprovedPlanContent = approvedPlanContent
    this.deps.gate.restoreFromPlanMode()
    await this.onExitPlanMode()

    // Force the post-plan permission mode based on the dialog choice. This
    // matches Claude Code's `buildPermissionUpdates(mode)` — the dialog
    // selection is the source of truth for the post-plan mode, NOT the
    // pre-plan mode that gate.restoreFromPlanMode() restored to. Without
    // this, a user who entered plan mode from `bypass` and then chose
    // "manually approve edits" would end up back in `bypass` instead of
    // `default`.
    if (decision.kind === 'approve_restore_keep') {
      this.deps.gate.setMode('default')
    }
    if (decision.kind === 'approve_auto_keep') {
      this.deps.gate.setMode('auto')
    }
    if (decision.kind === 'approve_bypass_keep') {
      this.deps.gate.setMode('bypass')
    }

    await this.deps.appendRecord({
      id: randomUUID(),
      type: 'plan_mode_outcome',
      kind: 'exit_approved',
      requestId: req.id,
      detail: decision.kind,
      ...exitOutcomeFields(req, approvedPlanContent),
      createdAt: new Date().toISOString(),
    })
  }
}

function exitOutcomeFields(
  req: Extract<SessionRecord, { type: 'plan_mode_request' }>,
  planContent: string,
): { toolUseId?: string; planContent?: string } {
  return {
    ...(req.toolUseId ? { toolUseId: req.toolUseId } : {}),
    ...(planContent.trim().length > 0 ? { planContent } : {}),
  }
}

/**
 * Convenience: clear plan slug for a session. Called by /clear so the
 * next plan-mode entry generates a fresh slug.
 */
export function clearSessionPlanSlug(sessionId: string): void {
  clearPlanSlug(sessionId)
}
