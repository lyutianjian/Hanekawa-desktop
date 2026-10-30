import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildFullPlanModeReminder,
  buildPlanFileReferenceReminder,
  buildPlanModeExitReminder,
  buildPlanModeReentryReminder,
  shouldInjectPlanAttachment,
  type AttachmentDecisionState,
} from '../src/harness/planModeAttachments.js'

function emptyState(overrides: Partial<AttachmentDecisionState> = {}): AttachmentDecisionState {
  return {
    active: false,
    hasExitedThisSession: false,
    needsExitAttachment: false,
    toolUseTurnsSinceEntry: 0,
    attachmentInjections: 0,
    ...overrides,
  }
}

test('shouldInjectPlanAttachment returns full on entry (turn 0, first injection)', () => {
  const decision = shouldInjectPlanAttachment(emptyState({ active: true }))
  assert.equal(decision, 'full')
})

test('shouldInjectPlanAttachment returns reentry when session has previously exited', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    active: true,
    hasExitedThisSession: true,
  }))
  assert.equal(decision, 'reentry')
})

test('shouldInjectPlanAttachment returns undefined for non-active state', () => {
  const decision = shouldInjectPlanAttachment(emptyState())
  assert.equal(decision, undefined)
})

test('shouldInjectPlanAttachment stays silent once the entry attachment has been injected', () => {
  for (const turn of [1, 4, 5, 25, 100]) {
    const decision = shouldInjectPlanAttachment(emptyState({
      active: true,
      toolUseTurnsSinceEntry: turn,
      attachmentInjections: 1,
    }))
    assert.equal(decision, undefined, `turn ${turn} should be silent`)
  }
})

test('shouldInjectPlanAttachment returns exit when needsExitAttachment is set, regardless of active', () => {
  const decision = shouldInjectPlanAttachment(emptyState({
    needsExitAttachment: true,
  }))
  assert.equal(decision, 'exit')
})

test('a 30-turn plan-mode session injects the entry attachment once and nothing after', () => {
  const state = emptyState({ active: true })
  const sequence: Array<{ turn: number; kind: string | undefined }> = []
  for (let turn = 0; turn <= 30; turn += 1) {
    state.toolUseTurnsSinceEntry = turn
    const decision = shouldInjectPlanAttachment(state)
    sequence.push({ turn, kind: decision })
    if (decision && decision !== 'exit') {
      state.attachmentInjections += 1
    }
  }

  const expected: Record<number, string | undefined> = {
    0: 'full',
  }
  for (const [turnStr, expectedKind] of Object.entries(expected)) {
    const turn = Number(turnStr)
    const got = sequence[turn]?.kind
    assert.equal(got, expectedKind, `turn ${turn}: expected ${expectedKind}, got ${got}`)
  }
  for (const entry of sequence) {
    if (Object.prototype.hasOwnProperty.call(expected, entry.turn)) continue
    assert.equal(entry.kind, undefined, `turn ${entry.turn} should be silent, got ${entry.kind}`)
  }
})

test('reminders contain expected anchor text', () => {
  const planPath = '/abs/.hanekawa/plans/crimson-tiger-abc.md'
  const full = buildFullPlanModeReminder(planPath)
  // Aligned with Claude Code's getPlanModeV2Instructions wording.
  assert.match(full, /Plan mode is active/)
  assert.match(full, /supercedes any other instructions/)
  assert.match(full, /Phase 1: Initial Understanding/)
  assert.match(full, /Phase 4: Final Plan/)
  assert.match(full, /Phase 5: Call ExitPlanMode/)
  assert.match(full, new RegExp(planPath))
  // The plan-approval rule has a single home: PLAN_MODE_SYSTEM_REMINDER, which
  // is in the dynamic system block on every plan-mode turn.
  assert.doesNotMatch(full, /AskUserQuestion ONLY to clarify/)
  // Fan-out width is the model's call, not a fixed count.
  assert.doesNotMatch(full, /up to 3 (explore|plan) agent/)
  assert.doesNotMatch(full, /Ordinary assistant-text plans are invalid/)
  assert.match(full, /Call ExitPlanMode/)
  assert.doesNotMatch(full, /Tools you must NOT call in plan mode/)

  assert.match(buildPlanModeReentryReminder(planPath), /Re-entering Plan Mode/)
  assert.match(buildPlanModeReentryReminder(planPath), new RegExp(planPath))
  assert.match(buildPlanModeExitReminder('# Approved\n'), /Exited Plan Mode/)
  assert.match(buildPlanModeExitReminder('# Approved\n'), /# Approved/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), /Plan mode is active/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), /test-slug/)
  assert.match(buildPlanFileReferenceReminder('test-slug', planPath), new RegExp(planPath.replace(/\\/g, '\\\\')))
})

test('post-exit reminder nudges the model to update its task list', () => {
  // Mirrors Claude Code's ExitPlanModeV2Tool tool_result body:
  //   "User has approved your plan. You can now start coding. Start with
  //    updating your task list if applicable"
  // This is the moment in the workflow where TaskCreate/TaskUpdate is the natural next
  // action — paired with the in-plan-mode disallow, the boundary is clear.
  const reminder = buildPlanModeExitReminder('# Approved plan content\n')
  assert.match(reminder, /User has approved your plan/)
  assert.match(reminder, /Start with updating your task list/)
  assert.match(reminder, /TaskCreate\/TaskUpdate/)
  assert.match(reminder, /# Approved plan content/)
})

test('post-exit reminder still works when plan content is empty', () => {
  // The clear-context approval flow passes the plan as the new user prompt
  // and emits an exit reminder with no embedded plan body. The task nudge
  // must still appear so the model knows to start with TaskCreate/TaskUpdate.
  const reminder = buildPlanModeExitReminder('')
  assert.match(reminder, /User has approved exiting plan mode/)
  assert.match(reminder, /You can now proceed/)
  assert.doesNotMatch(reminder, /Approved plan content:/)
})
