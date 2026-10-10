import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WELCOME_GLOBAL_LOCATION,
  WELCOME_GLOBAL_TITLE,
  WELCOME_PROJECT_FALLBACK,
  WELCOME_HINTS,
  WELCOME_TITLE_AFTER,
  WELCOME_TITLE_BEFORE,
  WELCOME_WORDMARK,
  coordinatorWelcome,
  createWelcomeState,
  isTranscriptEmpty,
  welcomeRenderSignature,
  welcomeView,
  type WelcomeState,
} from '../src/desktop/renderer/model/welcome.js'
import {
  createProjectPickerState,
  type ProjectPickerState,
} from '../src/desktop/renderer/model/projectPicker.js'
import type { TranscriptItem, TranscriptItemKind, TranscriptState } from '../src/desktop/renderer/model/transcript.js'

/**
 * The empty-state screen's model.
 *
 * The load-bearing case is「只有启动通知」: a fresh draft already carries `notice`
 * items, so a naive `items.length === 0` would mean this screen never appeared at
 * all. That is the assertion the rest of 5c hangs off.
 */

function item(kind: TranscriptItemKind, id: string = kind): TranscriptItem {
  return { id, kind, text: 'x' }
}

function transcript(overrides: Partial<TranscriptState> = {}): TranscriptState {
  return { items: [], generation: 0, toolProgress: undefined, isThinking: false, thinkingCount: 0, ...overrides }
}

function stateWith(overrides: Partial<WelcomeState> = {}): WelcomeState {
  return createWelcomeState({ projectName: 'Hanekawa-main', canSwitchBranch: true, ...overrides })
}

/** Two added projects, this pane sitting in the first — the switchable case. */
function projects(overrides: Partial<ProjectPickerState> = {}): ProjectPickerState {
  return createProjectPickerState({
    projects: [
      { root: '/repos/hanekawa', name: 'Hanekawa-main' },
      { root: '/repos/side', name: 'side' },
    ],
    current: '/repos/hanekawa',
    ...overrides,
  })
}

// --- constants ---------------------------------------------------------------

test('the constants are the agreed values', () => {
  assert.equal(WELCOME_TITLE_BEFORE, '你想让我们在 ')
  assert.equal(WELCOME_TITLE_AFTER, ' 中构建什么？')
  assert.equal(WELCOME_GLOBAL_TITLE, '你想让我们构建什么？')
  assert.equal(WELCOME_GLOBAL_LOCATION, '~/.myagent')
  assert.equal(WELCOME_PROJECT_FALLBACK, '当前项目')
  // Lower case is the decision, not a typo: upper case in a CJK interface reads
  // as a system banner rather than as the signature this is.
  assert.equal(WELCOME_WORDMARK, 'hanekawa')
})

test('the hint row names the three affordances a first run cannot guess', () => {
  // The row that replaced the three guidance cards. Restating what a coding
  // agent is for taught nothing; these are the keys that are not discoverable.
  assert.deepEqual(WELCOME_HINTS, [
    { keys: ['/'], label: '命令' },
    { keys: ['@'], label: '引用文件' },
    { keys: ['Shift', 'Tab'], label: '切换权限模式' },
  ])
  assert.deepEqual(welcomeView(stateWith()).hints, WELCOME_HINTS)
  assert.equal(welcomeView(stateWith()).wordmark, WELCOME_WORDMARK)
})

// --- emptiness ---------------------------------------------------------------

test('a transcript with nothing in it is empty', () => {
  assert.equal(isTranscriptEmpty(transcript()), true)
  assert.equal(welcomeView(stateWith()).visible, true)
})

test('startup notices do not count as a conversation', () => {
  // The whole feature depends on this: `paneSession.start()` folds every startup
  // notice into the transcript before the first paint.
  const state = transcript({ items: [item('notice', 'n1'), item('error', 'e1')] })
  assert.equal(isTranscriptEmpty(state), true)
  assert.equal(welcomeView(stateWith({ transcript: state })).visible, true)
})

test('one message of either side ends the empty state', () => {
  assert.equal(isTranscriptEmpty(transcript({ items: [item('user')] })), false)
  assert.equal(isTranscriptEmpty(transcript({ items: [item('assistant')] })), false)
  assert.equal(welcomeView(stateWith({ transcript: transcript({ items: [item('user')] }) })).visible, false)
})

test('a turn that has started hides the screen even before an item lands', () => {
  assert.equal(isTranscriptEmpty(transcript({ toolProgress: 'Reading file' })), false)
  assert.equal(isTranscriptEmpty(transcript({ isThinking: true })), false)
})

test('every transcript item kind is classified, and only two are not conversation', () => {
  // Typed as the union, so a new `TranscriptItemKind` is a compile error here
  // rather than an item kind that silently keeps the Hero on screen.
  const verdicts: ReadonlyArray<[TranscriptItemKind, boolean]> = [
    ['user', false],
    ['assistant', false],
    ['thinking', false],
    ['tool', false],
    ['subagent', false],
    ['duration', false],
    ['notice', true],
    ['error', true],
  ]
  for (const [kind, stillEmpty] of verdicts) {
    assert.equal(isTranscriptEmpty(transcript({ items: [item(kind)] })), stillEmpty, kind)
  }
})

// --- the hero ----------------------------------------------------------------

test('the hero names the project, and falls back before hello answers', () => {
  assert.equal(welcomeView(stateWith()).projectLabel, 'Hanekawa-main')
  assert.equal(welcomeView(stateWith({ projectName: undefined })).projectLabel, WELCOME_PROJECT_FALLBACK)
})

test('the global workspace drops the project segment from the hero', () => {
  // No project is loaded: nothing to name, nothing to switch to — the whole
  // hero is the ask, and the pill says where the records land instead.
  const view = welcomeView(stateWith({ global: true }))
  assert.equal(view.titleBefore, WELCOME_GLOBAL_TITLE)
  assert.equal(view.titleAfter, '')
  assert.equal(view.projectLabel, '')
  assert.equal(view.pills[0]?.label, WELCOME_GLOBAL_LOCATION)
  assert.equal(view.pills[0]?.kind, 'project')
})

// --- pills -------------------------------------------------------------------

test('the branch pill is absent, not blank, outside a repository', () => {
  const view = welcomeView(stateWith({ branch: undefined }))
  assert.deepEqual(view.pills.map((pill) => pill.kind), ['project'])
})

test('a known branch adds a second pill carrying its name', () => {
  const view = welcomeView(stateWith({ branch: 'master' }))
  assert.deepEqual(view.pills.map((pill) => pill.kind), ['project', 'branch'])
  assert.equal(view.pills[0]?.label, 'Hanekawa-main')
  assert.equal(view.pills[1]?.label, 'master')
})

test('a pill is a control exactly when its switcher has somewhere to go', () => {
  // No other project known yet, so only the branch pill is a control.
  const view = welcomeView(stateWith({ branch: 'master' }))
  assert.deepEqual(view.pills.map((pill) => pill.interactive), [false, true])
  // Nothing to switch in the home workspace, and a pane may not have been given
  // the popover at all — either way the pill goes back to being plain text.
  const fixed = welcomeView(stateWith({ branch: 'master', canSwitchBranch: false }))
  assert.deepEqual(fixed.pills.map((pill) => pill.interactive), [false, false])
  const switchable = welcomeView(stateWith({ branch: 'master', projectPicker: projects() }))
  assert.deepEqual(switchable.pills.map((pill) => pill.interactive), [true, true])
})

test('a project list holding only the current project is not a switcher', () => {
  // One row, ticked, and picking it would close the popover it opened. The pill
  // stays a span rather than a button that cannot go anywhere.
  const alone = projects({ projects: [{ root: '/repos/hanekawa', name: 'Hanekawa-main' }] })
  assert.equal(welcomeView(stateWith({ projectPicker: alone })).pills[0]?.interactive, false)
  // …and a popover left open in that state is forced shut, the way an invisible
  // screen's is: there is no control on screen that could have opened it.
  const open = { ...alone, open: true }
  assert.equal(welcomeView(stateWith({ projectPicker: open })).projectPicker.open, false)
})

test('the project popover cannot outlive the screen it hangs off', () => {
  const open = { ...projects(), open: true }
  const started = stateWith({ projectPicker: open, transcript: transcript({ items: [item('user')] }) })
  assert.equal(welcomeView(started).projectPicker.open, false)
  assert.equal(welcomeView(stateWith({ projectPicker: open })).projectPicker.open, true)
})

test('the global workspace still leads into the added projects', () => {
  // 最近 is not a project, but the projects are still where a session started
  // from here would belong — so the pill naming `~/.myagent` is a control.
  const view = welcomeView(stateWith({ global: true, projectPicker: projects({ current: undefined }) }))
  assert.equal(view.pills[0]?.label, WELCOME_GLOBAL_LOCATION)
  assert.equal(view.pills[0]?.interactive, true)
})

test('the branch popover cannot outlive the screen it hangs off', () => {
  // A turn starting takes the empty state away; a popover left `open` in the
  // state would be drawn again the moment the conversation was cleared.
  const open = { ...createWelcomeState().branchPicker, open: true, branches: ['master'] }
  const started = stateWith({ branch: 'master', branchPicker: open, transcript: transcript({ items: [item('user')] }) })
  assert.equal(welcomeView(started).visible, false)
  assert.equal(welcomeView(started).branchPicker.open, false)
  assert.equal(welcomeView(stateWith({ branch: 'master', branchPicker: open })).branchPicker.open, true)
})

// --- the render signature ----------------------------------------------------

const of = (state: WelcomeState): string => welcomeRenderSignature(welcomeView(state))

test('the global hero moves the signature', () => {
  // Different text on screen; the guard must not swallow the repaint.
  assert.notEqual(of(stateWith({ global: true })), of(stateWith()))
})

test('the same state signs the same way', () => {
  assert.equal(of(stateWith({ branch: 'master' })), of(stateWith({ branch: 'master' })))
})

test('everything the DOM draws moves the signature', () => {
  const reference = of(stateWith({ branch: 'master' }))
  const mutations: ReadonlyArray<[string, WelcomeState]> = [
    ['visible', stateWith({ branch: 'master', transcript: transcript({ items: [item('user')] }) })],
    ['project label', stateWith({ branch: 'master', projectName: 'other' })],
    ['switchable', stateWith({ branch: 'master', canSwitchBranch: false })],
    ['branch', stateWith({ branch: 'topic' })],
    ['branch absent', stateWith({ branch: undefined })],
    // Or the render guard swallows the click that opens the popover.
    [
      'popover open',
      stateWith({
        branch: 'master',
        branchPicker: { ...createWelcomeState().branchPicker, open: true, loading: true },
      }),
    ],
    // The project switcher signs for the same reason, both as a list and as an
    // open/closed state.
    ['project list', stateWith({ branch: 'master', projectPicker: projects() })],
    [
      'project popover open',
      stateWith({ branch: 'master', projectPicker: { ...projects(), open: true } }),
    ],
  ]
  for (const [what, state] of mutations) {
    assert.notEqual(of(state), reference, what)
  }
})

test('a notice arriving while the screen is up does not move the signature', () => {
  // The converse half: this view repaints from the pane's per-token transcript
  // paint, so anything it does not draw has to be invisible to the guard.
  const before = of(stateWith({ branch: 'master' }))
  const after = of(stateWith({
    branch: 'master',
    transcript: transcript({ items: [item('notice', 'n1'), item('notice', 'n2')] }),
  }))
  assert.equal(after, before)
})

test('the coordinator welcome exists only for a coordinator and links 概览', () => {
  assert.equal(coordinatorWelcome(false), undefined)
  const paragraphs = coordinatorWelcome(true)!
  assert.ok(paragraphs.flat().some((segment) => typeof segment === 'object' && segment.link === 'overview' && segment.label === '概览'))
})

test('a coordinator session shows its own welcome, never the Hero, empty or not', () => {
  assert.equal(welcomeView(stateWith({ transcript: transcript() })).visible, true)
  assert.equal(welcomeView(stateWith({ coordinator: true, transcript: transcript() })).visible, false)
})
