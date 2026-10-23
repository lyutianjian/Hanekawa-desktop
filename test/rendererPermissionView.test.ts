import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ALSO_WAITING_LIMIT,
  initialPermissionIndex,
  permissionIndexToIntent,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
} from '../src/desktop/renderer/model/permissionDialog.js'
import {
  addUiRequest,
  activeIndex,
  activeRequest,
  createUiQueue,
  cycleActive,
  permissionRequests,
  removeUiRequest,
  settleAllFallbacks,
} from '../src/desktop/renderer/model/uiQueue.js'
import type { PermissionRequestDto, UiRequest } from '../src/runtime/protocol/wire.js'
import type { PermissionRule } from '../src/harness/permissions.js'

function rule(toolName: string, contentPattern?: string): PermissionRule {
  return {
    toolName,
    ...(contentPattern !== undefined ? { contentPattern } : {}),
    behavior: 'allow',
    source: 'session',
  }
}

/**
 * The permission dialog and the queue it is drawn from.
 *
 * The renderer that shipped answered every request with one `window.confirm`, so
 * these pin the decisions it could not express: which options exist, which one
 * starts focused, and that nothing in the queue can be dropped without an answer
 * (an unanswered request parks the agent loop outright).
 */

function dto(overrides: Partial<PermissionRequestDto> = {}): PermissionRequestDto {
  return {
    toolName: 'Bash',
    riskLevel: 'confirm',
    input: { command: 'ls -la' },
    reason: 'shell command',
    source: 'mode',
    denialStreak: 0,
    canAlwaysAllow: false,
    destructiveWarnings: [],
    ...overrides,
  }
}

function permissionRequest(requestId: string, payload = dto()): UiRequest {
  return { kind: 'permission', requestId, payload }
}

test('always-allow appears only when the gate offered a rule and nothing is destructive', () => {
  const plain = permissionViewModel({ request: dto(), selectedIndex: 0 })
  assert.deepEqual(plain.options.map((option) => option.action), ['allow', 'deny'])

  const offered = permissionViewModel({
    request: dto({ canAlwaysAllow: true, alwaysAllowRule: rule('Bash', 'ls:*') }),
    selectedIndex: 0,
  })
  assert.deepEqual(offered.options.map((option) => option.action), ['allow', 'deny', 'always'])
  assert.match(offered.options[2]!.label, /Bash\(ls:\*\)/)

  // A flag without a rule must not offer an affordance that does nothing.
  const flagOnly = permissionViewModel({ request: dto({ canAlwaysAllow: true }), selectedIndex: 0 })
  assert.deepEqual(flagOnly.options.map((option) => option.action), ['allow', 'deny'])
})

test('a destructive request suppresses always-allow and starts on deny', () => {
  const request = dto({
    input: { command: 'rm -rf /tmp/x' },
    canAlwaysAllow: true,
    alwaysAllowRule: rule('Bash', 'rm:*'),
    destructiveWarnings: [{ kind: 'recursive-delete', detail: 'rm -rf' } as never],
  })

  const view = permissionViewModel({ request, selectedIndex: initialPermissionIndex(request) })

  assert.deepEqual(view.options.map((option) => option.action), ['allow', 'deny'])
  assert.equal(view.selectedIndex, 1, 'deny is pre-selected for a destructive command')
  assert.equal(view.tone, 'danger')
  assert.equal(view.warnings.length, 1)
})

test('tone is danger, caution or normal', () => {
  assert.equal(permissionViewModel({ request: dto(), selectedIndex: 0 }).tone, 'normal')
  assert.equal(
    permissionViewModel({ request: dto({ riskLevel: 'dangerous' }), selectedIndex: 0 }).tone,
    'caution',
  )
  assert.equal(
    permissionViewModel({
      request: dto({ destructiveWarnings: [{ kind: 'x', detail: 'y' } as never] }),
      selectedIndex: 0,
    }).tone,
    'danger',
  )
})

test('the view carries the input block, reason, streak note and diff preview', () => {
  const view = permissionViewModel({
    request: dto({
      toolName: 'Write',
      input: { filePath: 'a.txt' },
      source: 'ask rule',
      matchedRule: rule('Write'),
      denialStreak: 2,
      preview: { kind: 'diff', title: 'Create file', filePath: 'a.txt', oldText: '', newText: 'hi\n', summary: '+1' },
    }),
    selectedIndex: 0,
  })

  assert.equal(view.title, '新建文件', 'a Write whose preview found no file creates one')
  assert.equal(view.inputBlock.kind, 'file')
  assert.equal(view.inputBlock.content, 'a.txt')
  assert.match(view.reason, /要求确认/)
  assert.equal(view.denialStreakNote, '已拒绝过 2 次。')
  assert.equal(view.preview?.kind, 'diff')
  assert.ok(view.preview?.kind === 'diff' && view.preview.rows.length === 1)
})

test('the subtitle is the only place the pending counter appears', () => {
  const single = permissionViewModel({ request: dto(), selectedIndex: 0 })
  assert.equal(single.subtitle.includes('待处理'), false)

  const third = permissionViewModel({ request: dto(), selectedIndex: 0, activeIndex: 2, total: 4 })
  assert.match(third.subtitle, /第 3\/4 条待处理/)
})

test('the options are the buttons, and denying is never the loud one', () => {
  const plain = permissionViewModel({
    request: dto({ canAlwaysAllow: true, alwaysAllowRule: rule('Bash') }),
    selectedIndex: 0,
  })
  // One button per option, in the same order and addressing the same slot: the
  // mouse and the number key resolve through `resolvePermissionOption` alike.
  assert.deepEqual(plain.actions.map((action) => action.slot), plain.options.map((_, i) => i))
  assert.deepEqual(plain.actions.map((action) => action.label), plain.options.map((o) => o.label))
  assert.deepEqual(plain.actions.map((action) => action.shortcut), ['Y', 'N', 'A'])
  // Exactly one primary: 始终允许 writes a rule that outlives this request, so it
  // does not get to look like the recommended answer either.
  assert.deepEqual(plain.actions.map((action) => action.role), ['primary', 'secondary', 'secondary'])
  // Nothing is danger on an ordinary request.
  assert.deepEqual(plain.actions.map((action) => action.tone), [undefined, undefined, undefined])

  const destructive = permissionViewModel({
    request: dto({ destructiveWarnings: [{ kind: 'x', detail: 'y' } as never] }),
    selectedIndex: initialPermissionIndex(dto({ destructiveWarnings: [{ kind: 'x', detail: 'y' } as never] })),
  })
  // Approving a destructive command is drawn as danger — an outline, per
  // design_guidance 七.4 — and deny stays the secondary *and* the focused one.
  assert.deepEqual(destructive.actions.map((action) => action.tone), ['danger', undefined])
  assert.equal(destructive.actions[1]?.role, 'secondary')
  assert.equal(destructive.selectedIndex, 1)
})

test('also-waiting names a few and counts the rest', () => {
  const others = Array.from({ length: ALSO_WAITING_LIMIT + 2 }, (_, i) =>
    dto({ toolName: i === 0 ? 'Agent' : 'Read', input: i === 0 ? { subagent_type: 'explore' } : {} }))

  const view = permissionViewModel({ request: dto(), selectedIndex: 0, others })

  assert.equal(view.alsoWaiting.length, ALSO_WAITING_LIMIT + 1)
  assert.equal(view.alsoWaiting[0], 'Agent:explore')
  // The overflow is counted in Chinese like the names before it, not 「+2 more」.
  assert.equal(view.alsoWaiting.at(-1), '另有 2 项')
})

test('keys map to movement, answers and request cycling', () => {
  const options = permissionViewModel({
    request: dto({ canAlwaysAllow: true, alwaysAllowRule: rule('Bash') }),
    selectedIndex: 0,
  }).options
  const state = { selectedIndex: 0, options }

  assert.deepEqual(permissionKeyToIntent({ key: 'ArrowDown' }, state), { kind: 'move', selectedIndex: 1 })
  assert.deepEqual(permissionKeyToIntent({ key: 'ArrowUp' }, state), { kind: 'move', selectedIndex: 0 })
  assert.deepEqual(permissionKeyToIntent({ key: 'y' }, state), { kind: 'answer', action: 'allow' })
  assert.deepEqual(permissionKeyToIntent({ key: 'N' }, state), { kind: 'answer', action: 'deny' })
  assert.deepEqual(permissionKeyToIntent({ key: 'a' }, state), { kind: 'answer', action: 'always' })
  assert.deepEqual(permissionKeyToIntent({ key: '2' }, state), { kind: 'answer', action: 'deny' })
  assert.deepEqual(permissionKeyToIntent({ key: 'Enter' }, state), { kind: 'answer', action: 'allow' })
  assert.deepEqual(permissionKeyToIntent({ key: 'Escape' }, state), { kind: 'answer', action: 'deny' })
  assert.deepEqual(permissionKeyToIntent({ key: 'Tab' }, state), { kind: 'cycle', direction: 'next' })
  assert.deepEqual(
    permissionKeyToIntent({ key: 'Tab', shiftKey: true }, state),
    { kind: 'cycle', direction: 'prev' },
  )
  assert.deepEqual(permissionKeyToIntent({ key: 'q' }, state), { kind: 'none' })
  // Ctrl/Cmd combinations belong to the browser, not the dialog.
  assert.deepEqual(permissionKeyToIntent({ key: 'a', ctrlKey: true }, state), { kind: 'none' })
})

test('a hotkey the current request does not offer is inert', () => {
  const options = permissionViewModel({ request: dto(), selectedIndex: 0 }).options
  assert.deepEqual(permissionKeyToIntent({ key: 'a' }, { selectedIndex: 0, options }), { kind: 'none' })
  assert.deepEqual(permissionKeyToIntent({ key: '3' }, { selectedIndex: 0, options }), { kind: 'none' })
})

test('only the always action asks the host to persist a rule', () => {
  assert.deepEqual(permissionResponseFor('allow'), { kind: 'permission', approved: true })
  assert.deepEqual(permissionResponseFor('deny'), { kind: 'permission', approved: false })
  assert.deepEqual(permissionResponseFor('always'), { kind: 'permission', approved: true, alwaysAllow: true })
})

test('the queue is FIFO and the first arrival is active', () => {
  let state = createUiQueue()
  state = addUiRequest(state, permissionRequest('r1'))
  state = addUiRequest(state, { kind: 'enter-plan', requestId: 'r2' })
  state = addUiRequest(state, permissionRequest('r3'))

  assert.equal(state.activeId, 'r1')
  assert.equal(activeIndex(state), 0)
  assert.deepEqual(state.entries.map((entry) => entry.requestId), ['r1', 'r2', 'r3'])
  assert.deepEqual(permissionRequests(state).map((entry) => entry.requestId), ['r1', 'r3'])
})

test('answering the active entry promotes the one in its place', () => {
  let state = createUiQueue()
  for (const id of ['r1', 'r2', 'r3']) state = addUiRequest(state, permissionRequest(id))
  state = cycleActive(state, 'next')
  assert.equal(state.activeId, 'r2')

  state = removeUiRequest(state, 'r2')
  assert.equal(state.activeId, 'r3', 'focus moves down, not back to the top')

  state = removeUiRequest(state, 'r3')
  assert.equal(state.activeId, 'r1')
  state = removeUiRequest(state, 'r1')
  assert.equal(state.activeId, undefined)
  assert.equal(activeRequest(state), undefined)
})

test('answering a non-active entry leaves focus alone', () => {
  let state = createUiQueue()
  for (const id of ['r1', 'r2']) state = addUiRequest(state, permissionRequest(id))

  state = removeUiRequest(state, 'r2')
  assert.equal(state.activeId, 'r1')
  assert.equal(state.entries.length, 1)
})

test('cycling wraps and is a no-op for a single request', () => {
  let state = addUiRequest(createUiQueue(), permissionRequest('only'))
  assert.equal(cycleActive(state, 'next'), state)

  state = addUiRequest(state, permissionRequest('second'))
  assert.equal(cycleActive(state, 'prev').activeId, 'second', 'prev from the first wraps to the last')
  assert.equal(cycleActive(cycleActive(state, 'next'), 'next').activeId, 'only')
})

test('a duplicate requestId replaces its entry instead of doubling it', () => {
  let state = addUiRequest(createUiQueue(), permissionRequest('r1', dto({ reason: 'first' })))
  state = addUiRequest(state, permissionRequest('r1', dto({ reason: 'second' })))

  assert.equal(state.entries.length, 1)
  const active = activeRequest(state)
  assert.ok(active?.kind === 'permission')
  assert.equal(active.payload.reason, 'second')
})

test('the teardown answers keep the asymmetry the bridges have', () => {
  let state = createUiQueue()
  state = addUiRequest(state, permissionRequest('r1'))
  state = addUiRequest(state, { kind: 'enter-plan', requestId: 'r2' })
  state = addUiRequest(state, { kind: 'exit-plan', requestId: 'r3', payload: { planContent: 'p', planFilePath: 'f' } })
  state = addUiRequest(state, { kind: 'ask-user-question', requestId: 'r4', payload: { questions: [] } as never })

  const settled = settleAllFallbacks(state)

  assert.deepEqual(settled.map((entry) => entry.requestId), ['r1', 'r2', 'r3', 'r4'])
  assert.deepEqual(settled[0]?.response, { kind: 'permission', approved: false })
  // Entering plan mode only restricts the agent, so a lost view approves it.
  assert.deepEqual(settled[1]?.response, { kind: 'enter-plan', approved: true })
  assert.equal(settled[2]?.response.kind, 'exit-plan')
  assert.ok(settled[2]?.response.kind === 'exit-plan' && settled[2].response.decision.kind === 'reject')
  assert.ok(settled[3]?.response.kind === 'ask-user-question'
    && settled[3].response.result.kind === 'rejected')
})

test('a click on a row answers exactly what its number key answers', () => {
  const view = permissionViewModel({
    request: dto({ canAlwaysAllow: true, alwaysAllowRule: rule('Bash') }),
    selectedIndex: 0,
  })
  assert.ok(view.options.length >= 2)

  view.options.forEach((option, index) => {
    const clicked = permissionIndexToIntent(index, view.options)
    const typed = permissionKeyToIntent({ key: String(index + 1) }, { selectedIndex: 0, options: view.options })
    assert.deepEqual(clicked, typed, `slot ${index + 1} agrees between mouse and keyboard`)
    assert.deepEqual(clicked, { kind: 'answer', action: option.action })
  })
})

test('a click outside the offered options answers nothing', () => {
  const view = permissionViewModel({ request: dto(), selectedIndex: 0 })
  assert.deepEqual(permissionIndexToIntent(view.options.length, view.options), { kind: 'none' })
  assert.deepEqual(permissionIndexToIntent(-1, view.options), { kind: 'none' })
})
