import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { PermissionGate } from '../src/harness/permissions.js'
import {
  PlanModeManager,
  type ExitDialogInput,
  type ExitPlanDecision,
  type PlanModeManagerDeps,
} from '../src/harness/planModeManager.js'
import { SessionStore } from '../src/sessions/service.js'
import { clearAllPlanSlugs, readPlan, writePlan } from '../src/utils/plans.js'
import type { SessionRecord } from '../src/harness/types.js'
import { getProjectPlansDir } from '../src/utils/paths.js'

async function withTempCwd<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-pm-int-'))
  try {
    clearAllPlanSlugs()
    return await fn(dir)
  } finally {
    clearAllPlanSlugs()
    await rm(dir, { recursive: true, force: true })
  }
}

interface Harness {
  manager: PlanModeManager
  gate: PermissionGate
  records: SessionRecord[]
  meta: { id: string; shortId: string }
  dialogInputs: ExitDialogInput[]
  dialogResponses: ExitPlanDecision[]
  chatMessages: string[]
}

async function buildHarness(cwd: string, options: {
  dialogResponses?: ExitPlanDecision[]
  enterApproved?: boolean
} = {}): Promise<Harness> {
  const store = new SessionStore(cwd)
  await store.init()
  const meta = await store.create()
  const records: SessionRecord[] = []
  const chatMessages: string[] = []
  const dialogResponses = options.dialogResponses ?? []
  const dialogInputs: ExitDialogInput[] = []
  const gate = new PermissionGate(async () => true, undefined, { mode: 'default', cwd })

  const deps: PlanModeManagerDeps = {
    cwd,
    sessionMeta: meta,
    store,
    gate,
    appendRecord: async (record) => { records.push(record) },
    loadRecords: async () => [...records],
    emitChatMessage: async (content) => { chatMessages.push(content) },
    openExitDialog: async (input) => {
      dialogInputs.push(input)
      const idx = dialogInputs.length - 1
      return dialogResponses[idx] ?? { kind: 'reject', feedback: '' }
    },
    openEnterPrompt: async () => options.enterApproved ?? true,
  }

  const manager = new PlanModeManager(deps)
  gate.setPlanSlugProvider(() => manager.getSlug())

  return { manager, gate, records, meta, dialogInputs, dialogResponses, chatMessages }
}

function emitEnterRequest(records: SessionRecord[], sessionId: string): string {
  const id = randomUUID()
  records.push({
    id,
    type: 'plan_mode_request',
    kind: 'enter',
    submittedFromSessionId: sessionId,
    createdAt: new Date().toISOString(),
  })
  return id
}

function emitExitRequest(
  records: SessionRecord[],
  sessionId: string,
  options: { kind?: 'exit' | 'subagent_exit'; planContent?: string; toolUseId?: string } = {},
): string {
  const id = randomUUID()
  records.push({
    id,
    type: 'plan_mode_request',
    kind: options.kind ?? 'exit',
    submittedFromSessionId: sessionId,
    ...(options.planContent !== undefined ? { planContent: options.planContent } : {}),
    ...(options.toolUseId !== undefined ? { toolUseId: options.toolUseId } : {}),
    createdAt: new Date().toISOString(),
  })
  return id
}

// Scenario A: Happy path — enter via tool → write plan to disk → exit
// (no inline plan) → dialog → approve restore.
test('Integration A: enter approved → write plan → exit (disk fallback) → approve restore', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd, {
      dialogResponses: [{ kind: 'approve_restore_keep' }],
    })

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()
    assert.equal(h.manager.isActive(), true)

    const planPath = h.manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan A\n')

    emitExitRequest(h.records, h.meta.id, { toolUseId: 'call-1' }) // no inline plan -> disk fallback
    await h.manager.beforeTurn()

    assert.equal(h.dialogInputs.length, 1)
    assert.equal(h.dialogInputs[0]?.planContent, '# Plan A\n')
    assert.equal(h.manager.isActive(), false)
    const approved = h.records.find((r) => r.type === 'plan_mode_outcome' && r.kind === 'exit_approved')
    assert.ok(approved)
    // The outcome names the call and carries the plan, so a replayed transcript can show it.
    assert.equal((approved as { toolUseId?: string }).toolUseId, 'call-1')
    assert.equal((approved as { planContent?: string }).planContent, '# Plan A\n')
  })
})

// Scenario B: Plan on disk — manager reads from file and opens dialog.
test('Integration B: exit reads plan from disk and opens dialog', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd, {
      dialogResponses: [{ kind: 'approve_restore_keep' }],
    })

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()

    // Write plan to disk before emitting exit request.
    const planPath = h.manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Disk plan body\n')

    emitExitRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()

    assert.equal(h.dialogInputs.length, 1)
    assert.equal(h.dialogInputs[0]?.planContent, '# Disk plan body\n')
    // Disk still has the plan.
    const onDisk = await readPlan(h.dialogInputs[0]!.planFilePath)
    assert.equal(onDisk, '# Disk plan body\n')
  })
})

// Scenario C: Empty plan still surfaces the approval dialog.
test('Integration C: empty plan opens approval dialog and can exit', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd, {
      dialogResponses: [{ kind: 'approve_restore_keep' }],
    })

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()

    emitExitRequest(h.records, h.meta.id) // no inline, no file written
    await h.manager.beforeTurn()

    assert.equal(h.dialogInputs.length, 1, 'dialog should open for empty plan')
    assert.equal(h.dialogInputs[0]?.planContent, '')
    const approved = h.records.find(
      (r) => r.type === 'plan_mode_outcome' && r.kind === 'exit_approved',
    )
    assert.ok(approved)
    assert.equal(h.chatMessages.length, 0)
  })
})

// Scenario D: Reject with feedback — mode stays plan, reminder injected.
test('Integration D: dialog reject with feedback → mode stays plan + reminder injected', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd, {
      dialogResponses: [{ kind: 'reject', feedback: 'add error handling' }],
    })

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()
    const planPath = h.manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Draft\n')

    emitExitRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()

    assert.equal(h.manager.isActive(), true, 'still in plan mode after reject')
    assert.equal(h.gate.getMode(), 'plan')
    const rejected = h.records.find(
      (r): r is Extract<SessionRecord, { type: 'plan_mode_outcome' }> =>
        r.type === 'plan_mode_outcome' && r.kind === 'exit_rejected',
    )
    assert.ok(rejected)
    assert.equal(rejected!.detail, 'add error handling')
    assert.ok(h.chatMessages.some((m) => /add error handling/.test(m)))
  })
})

// Scenario E: Sub-agent exit routing — kind='subagent_exit' processes
// identically to 'exit'. Approve flips main session out of plan mode.
test('Integration E: subagent_exit routes identically; approve_auto_keep flips gate to acceptEdits', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd, {
      dialogResponses: [{ kind: 'approve_auto_keep' }],
    })

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()
    const planPath = h.manager.resolvePlanFilePathLazy()
    await writePlan(planPath, '# Plan from sub-agent\n')

    emitExitRequest(h.records, 'sub-agent-session-id', { kind: 'subagent_exit' })
    await h.manager.beforeTurn()

    assert.equal(h.dialogInputs.length, 1, 'subagent_exit opens main dialog')
    assert.equal(h.gate.getMode(), 'auto')
    assert.equal(h.manager.isActive(), false)
  })
})

// Scenario G: Plan-file write exception via prefix match — main and
// sub-agent paths both pass; non-matching .myagent/plans path falls
// through to the prompt.
test('Integration G: plan-file prefix match allows main + sub-agent paths; non-matching is denied', async () => {
  await withTempCwd(async (cwd) => {
    const h = await buildHarness(cwd)

    emitEnterRequest(h.records, h.meta.id)
    await h.manager.beforeTurn()

    // Force slug generation so the gate has a slug to match against.
    const mainPath = h.manager.resolvePlanFilePathLazy()
    const slug = h.manager.getSlug()!
    const subPath = path.join(getProjectPlansDir(cwd), `${slug}-agent-x.md`)
    const otherPath = path.join(getProjectPlansDir(cwd), 'other-slug.md')

    let promptCount = 0
    const gateWithSpy = new PermissionGate(
      async () => { promptCount += 1; return false },
      undefined,
      { mode: 'plan', cwd },
    )
    gateWithSpy.setPlanSlugProvider(() => slug)

    const writeTool = {
      name: 'Write',
      description: 'w',
      inputSchema: { type: 'object' } as any,
      riskLevel: 'confirm' as const,
      execute: async () => ({ ok: true, content: '' }),
    }

    // Main plan path: auto-allowed by prefix exception (matches slug).
    const r1 = await gateWithSpy.approve(writeTool as any, { path: mainPath, content: 'x' })
    assert.equal(r1, true)
    // Sub-agent plan path: also auto-allowed (same prefix, different suffix).
    const r2 = await gateWithSpy.approve(writeTool as any, { path: subPath, content: 'x' })
    assert.equal(r2, true)
    // Any other write, even in the plans dir, is refused outright.
    const r3 = await gateWithSpy.approve(writeTool as any, { path: otherPath, content: 'x' })
    assert.equal(r3, false, 'non-matching plans-dir path is denied')
    assert.equal(promptCount, 0, 'plan mode denies writes without asking')
  })
})
