import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { EXIT_PLAN_MODE_TOOL_NAME } from '../toolNames.js'
import { DESCRIPTION } from './prompt.js'

const exitPlanModeInputSchema = z.object({
  plan: z.string().optional().describe('Plan content, only needed when you did not write the plan file.'),
}).strict()

/**
 * ExitPlanMode is a thin request-emitting tool. It does NOT change the
 * permission mode itself; instead it appends a `plan_mode_request`
 * (kind='exit') record to the parent record stream, which the
 * PlanModeManager drains at the start of the next turn. The manager
 * then opens the exit dialog, and on approve
 * transitions the gate via `gate.restoreFromPlanMode()`.
 *
 * If `plan` is provided inline, it is attached to the request record
 * so the manager can persist it directly. If absent, the manager falls
 * back to reading the plan file from disk.
 *
 * Sub-agent isolation: plan mode is a main-thread abstraction. If the
 * tool is invoked from a sub-agent context (planModeBridge.parentSessionId
 * !== context.sessionId), it returns precondition_failed without
 * emitting a record.
 */
export const exitPlanModeTool: Tool = {
  name: EXIT_PLAN_MODE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema: exitPlanModeInputSchema,
  riskLevel: 'safe',
  isReadOnly: true,
  userFacingName: () => 'Plan',
  getToolUseSummary: () => 'submit plan',
  getActivityDescription: () => 'Submitting plan',
  async execute(input, context) {
    if (context.getPermissionMode?.() !== 'plan') {
      return {
        ok: false,
        content: 'ExitPlanMode can only be called in plan mode.',
        errorCode: 'precondition_failed',
      }
    }

    if (!context.planModeBridge) {
      return {
        ok: false,
        content: 'Plan mode is not available in this context.',
        errorCode: 'precondition_failed',
      }
    }

    if (context.planModeBridge.parentSessionId !== context.sessionId) {
      return {
        ok: false,
        content: 'Sub-agents cannot exit plan mode directly. Ask the parent agent to exit plan mode.',
        errorCode: 'precondition_failed',
      }
    }

    const parsed = exitPlanModeInputSchema.parse(input)
    const inlinePlan = parsed.plan?.trim() || undefined

    // Aligned with CC: plan content is optional. The manager reads from disk
    // first, falling back to inline content. If neither is available, the
    // exit dialog still opens — the user sees an empty plan and can reject.
    await context.planModeBridge.parentAppendRecord({
      id: randomUUID(),
      type: 'plan_mode_request',
      kind: 'exit',
      submittedFromSessionId: context.sessionId,
      ...(inlinePlan ? { planContent: inlinePlan } : {}),
      ...(context.currentToolUseId ? { toolUseId: context.currentToolUseId } : {}),
      createdAt: new Date().toISOString(),
      ...(context.currentTurnId ? { turnId: context.currentTurnId } : {}),
    })

    return {
      ok: true,
      content: 'Plan submitted for review. The user will be shown the plan with options to approve, reject, or edit it.',
    }
  },
}
