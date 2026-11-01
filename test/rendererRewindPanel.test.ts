import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRewindIntent,
  beginRewindRun,
  createRewindState,
  failRewindRun,
  rewindActionToIntent,
  rewindKeyToIntent,
  rewindViewModel,
  runRewind,
  selectedCheckpoint,
  type RewindClient,
  type RewindState,
} from '../src/desktop/renderer/model/rewindPanel.js'
import type {
  CheckpointDiffSummary,
  CheckpointWithDiff,
} from '../src/services/fileHistory/types.js'
import type { RewindSummaryDecision } from '../src/runtime/rewindSummary.js'

/**
 * The desktop `/rewind` panel: its state machine, its key map and the executor
 * that turns a decision into wire calls.
 *
 * The DOM half (`dom/rewindView.ts`) is not covered here and cannot be — there is
 * no jsdom in this runner. That is exactly why every decision lives in `model/`:
 * which options appear, where the cursor starts, what Escape means, and which
 * client calls happen in which order are all answerable without a document.
 */

const noChanges: CheckpointDiffSummary = {
  fileCount: 0,
  additions: 0,
  deletions: 0,
  hasChanges: false,
}

const withChanges: CheckpointDiffSummary = {
  fileCount: 2,
  additions: 12,
  deletions: 3,
  hasChanges: true,
  firstFile: 'src/parser.ts',
}

function checkpoint(overrides: Partial<CheckpointWithDiff> = {}): CheckpointWithDiff {
  return {
    messageId: 'm1',
    messageContent: 'add the parser',
    timestamp: '2026-05-19T10:00:00.000Z',
    turnDiff: noChanges,
    restoreDiff: noChanges,
    isCurrent: false,
    ...overrides,
  }
}

/** Two checkpoints, the later one having produced code changes. */
function twoCheckpoints(): CheckpointWithDiff[] {
  return [
    checkpoint({ messageId: 'm1', timestamp: '2026-05-19T10:00:00.000Z', messageContent: 'first' }),
    checkpoint({
      messageId: 'm2',
      timestamp: '2026-05-19T11:00:00.000Z',
      messageContent: 'second',
      turnDiff: withChanges,
      restoreDiff: withChanges,
    }),
  ]
}

function stubClient(overrides: Partial<RewindClient> = {}): {
  client: RewindClient
  calls: string[]
} {
  const calls: string[] = []
  const client: RewindClient = {
    truncateSession: async (messageId) => {
      calls.push(`truncate:${messageId}`)
      return []
    },
    restoreCode: async (messageId) => {
      calls.push(`restore-code:${messageId}`)
      return { success: true }
    },
    summarizeRewind: async (messageId, decision) => {
      calls.push(`summarize:${messageId}:${decision}`)
      return []
    },
    ...overrides,
  }
  return { client, calls }
}

// --- opening ----------------------------------------------------------------

test('a freshly opened panel sorts chronologically and sits on "(current)"', () => {
  // Handed to it newest-first, the way a caller might.
  const state = createRewindState([...twoCheckpoints()].reverse())
  assert.deepEqual(state.checkpoints.map((entry) => entry.messageId), ['m1', 'm2'])
  assert.equal(state.checkpointIndex, 2, 'the cursor starts past the last checkpoint')
  assert.equal(selectedCheckpoint(state), undefined)
  assert.equal(state.screen, 'select')
  assert.equal(state.busy, false)
})

test('Enter on "(current)" closes rather than arming a rewind', () => {
  // The starting position, so a reflexive Enter can never destroy anything.
  const state = createRewindState(twoCheckpoints())
  const outcome = applyRewindIntent(state, { kind: 'open-confirm' })
  assert.ok('close' in outcome)
  assert.ok(!('run' in outcome))
})

test('an empty session draws an explanation instead of a list', () => {
  const view = rewindViewModel(createRewindState([]))
  assert.equal(view.emptyMessage, '没有可用的检查点')
  assert.deepEqual(view.rows, [])
  assert.deepEqual(view.actions, [{ label: '关闭', shortcut: 'Esc', role: 'secondary' }])
})

test('the confirm screen separates range selection from its one confirmation action', () => {
  const state = confirmOn('m2')
  const view = rewindViewModel(state)
  assert.deepEqual(view.actions, [
    { label: '取消', role: 'secondary' },
    { label: '确认回退', role: 'primary', slot: 0 },
  ])
  assert.deepEqual(rewindActionToIntent({ kind: 'slot', index: 0 }, view), {
    kind: 'choose', decision: 'restore-code-and-conversation',
  })
  const changed = applyRewindIntent(state, { kind: 'focus-option', decision: 'summarize-from-here' })
  assert.ok(!('run' in changed), 'changing range never executes it')
  const summary = rewindViewModel(changed.state)
  assert.equal(summary.actions[1]?.label, '确认摘要')
  assert.equal(summary.codeEffect, '代码不会改动。')
  assert.equal(summary.warning, undefined)
  assert.equal(summary.codeChanges, undefined)
  assert.deepEqual(rewindActionToIntent({ kind: 'slot', index: summary.actions[1]!.slot! }, summary), {
    kind: 'choose', decision: 'summarize-from-here',
  })
  assert.deepEqual(rewindActionToIntent({ kind: 'secondary' }, view), { kind: 'close' })
  assert.deepEqual(rewindActionToIntent({ kind: 'slot', index: 99 }, view), { kind: 'none' })
})

test('a running decision withdraws the buttons along with the options', () => {
  const state = beginRewindRun({
    ...createRewindState(twoCheckpoints()),
    checkpointIndex: 0,
    screen: 'confirm' as const,
  })
  const view = rewindViewModel(state)
  assert.ok(view.busyLabel !== undefined)
  // Not disabled — absent. The panel is taking no input at all.
  assert.deepEqual(view.actions, [])
})

test('a failed checkpoint read still shows the reason', () => {
  // `app.ts` opens the panel empty rather than swallowing the failure.
  const view = rewindViewModel(failRewindRun(createRewindState([]), 'the snapshot was not found'))
  assert.equal(view.error, 'the snapshot was not found')
  assert.equal(view.emptyMessage, '没有可用的检查点')
})

// --- the select screen ------------------------------------------------------

test('the list ends with "(current)" and marks the cursor row', () => {
  const state = createRewindState(twoCheckpoints())
  const view = rewindViewModel(state)
  assert.equal(view.rows.length, 3)
  assert.deepEqual(view.rows.map((row) => row.id), ['m1', 'm2', 'current'])
  assert.equal(view.rows[2]?.isCurrent, true)
  assert.equal(view.rows[2]?.selected, true, 'the cursor starts on "(current)"')
  // Turn diffs are summarized per row so a user can see which turn touched code.
  assert.equal(view.rows[0]?.detail, '无代码改动')
  assert.equal(view.rows[1]?.detail, '2 个文件有改动 +12 -3')
})

test('moving clamps at both ends rather than wrapping', () => {
  let state = createRewindState(twoCheckpoints())
  state = applyRewindIntent(state, { kind: 'move', direction: 'up' }).state
  assert.equal(state.checkpointIndex, 1)
  state = applyRewindIntent(state, { kind: 'move', direction: 'up' }).state
  assert.equal(state.checkpointIndex, 0)
  // Wrapping from the oldest checkpoint to "(current)" would read as a glitch on
  // what is a timeline.
  state = applyRewindIntent(state, { kind: 'move', direction: 'up' }).state
  assert.equal(state.checkpointIndex, 0)
  state = applyRewindIntent(state, { kind: 'move', direction: 'down' }).state
  state = applyRewindIntent(state, { kind: 'move', direction: 'down' }).state
  assert.equal(state.checkpointIndex, 2)
  state = applyRewindIntent(state, { kind: 'move', direction: 'down' }).state
  assert.equal(state.checkpointIndex, 2)
})

test('a click addresses a row by id, and "(current)" still cancels', () => {
  const state = createRewindState(twoCheckpoints())
  const picked = applyRewindIntent(state, { kind: 'select-row', id: 'm2' })
  assert.equal(picked.state.screen, 'confirm')
  assert.equal(selectedCheckpoint(picked.state)?.messageId, 'm2')

  assert.ok('close' in applyRewindIntent(state, { kind: 'select-row', id: 'current' }))
  // A row id from a stale render is ignored rather than throwing.
  const stale = applyRewindIntent(state, { kind: 'select-row', id: 'gone' })
  assert.equal(stale.state.screen, 'select')
})

// --- the confirm screen -----------------------------------------------------

function confirmOn(messageId: string): RewindState {
  const state = createRewindState(twoCheckpoints())
  return applyRewindIntent(state, { kind: 'select-row', id: messageId }).state
}

test('the option list follows whether restoring would change files', () => {
  const noCode = rewindViewModel(confirmOn('m1'))
  assert.deepEqual(noCode.options.map((option) => option.decision), [
    'restore-conversation',
    'summarize-from-here',
    'summarize-up-to-here',
  ])
  assert.equal(noCode.codeEffect, '代码不会改动。')
  assert.equal(noCode.warning, undefined, 'no manual-edit warning when nothing is restored')

  const withCode = rewindViewModel(confirmOn('m2'))
  assert.deepEqual(withCode.options.map((option) => option.decision), [
    'restore-code-and-conversation',
    'restore-conversation',
    'restore-code',
    'summarize-from-here',
    'summarize-up-to-here',
  ])
  assert.equal(withCode.codeEffect, '将恢复 2 个文件')
  assert.deepEqual(withCode.codeChanges, { additions: 12, deletions: 3, files: 'src/parser.ts 及另外 1 个文件' })
  assert.match(withCode.warning ?? '', /未记录的手动或 Bash 改动/)
  // Digits select a range; Enter or the confirmation button runs it.
  assert.deepEqual(withCode.options.map((option) => option.hotkey), ['1', '2', '3', '4', '5'])
})

test('the confirm screen shows the message verbatim, not as markdown', () => {
  const state = createRewindState([checkpoint({ messageContent: '# heading **bold**' })])
  const confirm = applyRewindIntent(state, { kind: 'select-row', id: 'm1' }).state
  assert.equal(rewindViewModel(confirm).messagePreview, '# heading **bold**')
})

test('"Never mind" goes back and performs nothing', () => {
  const outcome = applyRewindIntent(confirmOn('m2'), { kind: 'choose', decision: 'nevermind' })
  assert.equal(outcome.state.screen, 'select')
  assert.ok(!('run' in outcome))
  assert.ok(!('close' in outcome))
})

test('choosing an acting option hands back the checkpoint to run against', () => {
  const outcome = applyRewindIntent(confirmOn('m2'), {
    kind: 'choose',
    decision: 'restore-code-and-conversation',
  })
  assert.ok('run' in outcome)
  if (!('run' in outcome)) return
  assert.equal(outcome.run.decision, 'restore-code-and-conversation')
  assert.equal(outcome.run.checkpoint.messageId, 'm2')
  // The cursor lands on the option that was chosen, so the busy label matches it.
  assert.equal(outcome.state.optionIndex, 0)
})

test('a stale error is cleared by the next transition', () => {
  const failed = failRewindRun(confirmOn('m2'), 'git checkout failed')
  assert.equal(rewindViewModel(failed).error, 'git checkout failed')
  const back = applyRewindIntent(failed, { kind: 'back' })
  assert.equal(back.state.error, undefined)
})

test('the busy label names the operation rather than a generic spinner', () => {
  const restoring = beginRewindRun(applyRewindIntent(confirmOn('m2'), {
    kind: 'choose',
    decision: 'restore-code',
  }).state)
  assert.equal(rewindViewModel(restoring).busyLabel, '正在回退……')

  const summarizing = beginRewindRun(applyRewindIntent(confirmOn('m2'), {
    kind: 'choose',
    decision: 'summarize-up-to-here',
  }).state)
  assert.equal(rewindViewModel(summarizing).busyLabel, '正在摘要……')
  // The options are withdrawn while it runs; a second choice would race the first.
  assert.equal(rewindKeyToIntent({ key: 'Enter' }, summarizing).kind, 'none')
  assert.equal(rewindKeyToIntent({ key: 'Escape' }, summarizing).kind, 'none')
})

// --- keys -------------------------------------------------------------------

test('Escape backs out one screen at a time', () => {
  assert.deepEqual(
    rewindKeyToIntent({ key: 'Escape' }, confirmOn('m2')),
    { kind: 'back' },
    'from the confirm screen Escape returns to the list',
  )
  assert.deepEqual(
    rewindKeyToIntent({ key: 'Escape' }, createRewindState(twoCheckpoints())),
    { kind: 'close' },
    'from the list Escape closes the panel',
  )
})

test('numeric hotkeys select a range and Enter confirms it', () => {
  const state = confirmOn('m2')
  assert.deepEqual(rewindKeyToIntent({ key: 'Enter' }, state), {
    kind: 'choose',
    decision: 'restore-code-and-conversation',
  })
  assert.deepEqual(rewindKeyToIntent({ key: '3' }, state), {
    kind: 'focus-option',
    decision: 'restore-code',
  })
  const selected = applyRewindIntent(state, rewindKeyToIntent({ key: '3' }, state)).state
  assert.deepEqual(rewindKeyToIntent({ key: 'Enter' }, selected), { kind: 'choose', decision: 'restore-code' })
  // Out of range, and a slot the three-option list does not have.
  assert.equal(rewindKeyToIntent({ key: '9' }, state).kind, 'none')
  assert.equal(rewindKeyToIntent({ key: '5' }, confirmOn('m1')).kind, 'none')
})

test('a modified chord is left alone so the sidebar chords keep working', () => {
  const state = createRewindState(twoCheckpoints())
  // Ctrl+W must reach `sidebarChordToIntent`, which is resolved before the keymap.
  assert.equal(rewindKeyToIntent({ key: 'w', ctrlKey: true }, state).kind, 'none')
  assert.equal(rewindKeyToIntent({ key: 't', metaKey: true }, state).kind, 'none')
})

test('typing into the panel does nothing rather than falling through', () => {
  // The panel is modal: a keystroke must not land in the composer behind it.
  const state = createRewindState(twoCheckpoints())
  assert.equal(rewindKeyToIntent({ key: 'a' }, state).kind, 'none')
  assert.equal(rewindKeyToIntent({ key: 'Tab' }, state).kind, 'none')
  assert.equal(rewindKeyToIntent({ key: 'Enter' }, state).kind, 'open-confirm')
})

// --- the executor -----------------------------------------------------------

test('restore-conversation truncates and nothing else', async () => {
  const { client, calls } = stubClient()
  const result = await runRewind(client, 'restore-conversation', checkpoint())
  assert.deepEqual(calls, ['truncate:m1'])
  assert.deepEqual(result, { message: '对话已回退到“add the parser”之前', partial: false })
})

test('restore-code reverts files and leaves the conversation alone', async () => {
  const { client, calls } = stubClient()
  const result = await runRewind(client, 'restore-code', checkpoint())
  assert.deepEqual(calls, ['restore-code:m1'])
  assert.equal(result.partial, false)
})

test('restore-code-and-conversation truncates before it reverts', async () => {
  const { client, calls } = stubClient()
  await runRewind(client, 'restore-code-and-conversation', checkpoint())
  assert.deepEqual(calls, ['truncate:m1', 'restore-code:m1'])
})

test('summarizing passes the direction through to the wire command', async () => {
  const { client, calls } = stubClient()
  await runRewind(client, 'summarize-up-to-here', checkpoint())
  await runRewind(client, 'summarize-from-here', checkpoint())
  assert.deepEqual(calls, [
    'summarize:m1:summarize-up-to-here',
    'summarize:m1:summarize-from-here',
  ])
})

test('never mind runs nothing at all', async () => {
  const { client, calls } = stubClient()
  const result = await runRewind(client, 'nevermind', checkpoint())
  assert.deepEqual(calls, [])
  assert.equal(result.message, '')
})

test('a reported restore failure becomes a throw when nothing was truncated', async () => {
  // `restore-code` reports rather than throws (unlike `truncate-session`), so a
  // caller that forgot to inspect `success` would read a failure as a success.
  const { client } = stubClient({
    restoreCode: async () => ({ success: false, error: 'dirty working tree' }),
  })
  await assert.rejects(
    () => runRewind(client, 'restore-code', checkpoint()),
    /dirty working tree/,
  )
})

test('a restore that fails after the truncate reports the half that landed', async () => {
  const { client, calls } = stubClient({
    restoreCode: async () => ({ success: false, error: 'dirty working tree' }),
  })
  const result = await runRewind(client, 'restore-code-and-conversation', checkpoint())
  assert.deepEqual(calls, ['truncate:m1'])
  assert.equal(result.partial, true)
  assert.match(result.message, /对话已回退到“add the parser”之前/)
  assert.match(result.message, /文件状态无法还原：dirty working tree/)
})

test('a missing error string still produces a reason', async () => {
  const { client } = stubClient({ restoreCode: async () => ({ success: false }) })
  const result = await runRewind(client, 'restore-code-and-conversation', checkpoint())
  assert.match(result.message, /文件状态恢复失败/)
})

test('a truncate rejection propagates, so a stale checkpoint list is visible', async () => {
  const { client } = stubClient({
    truncateSession: async () => {
      throw new Error('Message not found: m1')
    },
  })
  await assert.rejects(
    () => runRewind(client, 'restore-code-and-conversation', checkpoint()),
    /Message not found/,
  )
})

test('the executor accepts a SessionClient-shaped object', () => {
  // A compile-time check that the structural interface still matches what
  // `app.ts` passes: the real client's three methods, with their real signatures.
  const shaped: RewindClient = {
    truncateSession: async (messageId: string) => [messageId],
    restoreCode: async (_messageId: string) => ({ success: true }),
    summarizeRewind: async (_messageId: string, _decision: RewindSummaryDecision) => [],
  }
  assert.equal(typeof shaped.truncateSession, 'function')
})
