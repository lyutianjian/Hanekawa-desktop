import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_SESSION_LOCK,
  THREAD_FINISHED_LOCK,
  UNTITLED_SESSION,
  canvasHeaderView,
  canvasIsEmpty,
  composerLockReason,
  renameCommit,
} from '../src/desktop/renderer/model/canvasHeader.js'
import type { WireLaneInfo } from '../src/desktop/shellProtocol.js'

/**
 * The canvas header's decisions, with no DOM in sight — the `model/` half of the
 * renderer's split, same as `test/rendererSidebar.test.ts`.
 */

function lane(overrides: Partial<WireLaneInfo> = {}): WireLaneInfo {
  return {
    lane: '1',
    paneId: 's1',
    sessionId: 's1',
    projectRoot: 'c:\\repo\\alpha',
    projectName: 'alpha',
    ...overrides,
  }
}

test('no active lane means no header at all', () => {
  const view = canvasHeaderView({
    lane: undefined,
    menuOpen: true,
    renaming: true,
    pendingDelete: 's1',
    hasConversation: true,
  })
  assert.equal(view.visible, false)
  assert.deepEqual(view.menuItems, [], 'an empty window has no session to act on')
})

test('a session with nothing in it draws no header either', () => {
  // The welcome screen already names the project, and rename/delete are about a
  // session that has yet to say anything — so the bar would be 34px spent on a
  // placeholder title. It arrives with the first message.
  const view = canvasHeaderView({
    lane: lane(),
    menuOpen: true,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: false,
  })
  assert.equal(view.visible, false)
  assert.deepEqual(view.menuItems, [])
})

test('the header names the session, falling back the way a sidebar row does', () => {
  const titled = canvasHeaderView({
    lane: lane({ sessionTitle: '重构缓存层' }),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
  })
  assert.equal(titled.visible, true)
  assert.equal(titled.title, '重构缓存层')
  assert.equal(titled.titlePending, false)

  const pending = canvasHeaderView({
    lane: lane({ sessionTitle: '帮我重构缓存层', titlePending: true }),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
  })
  assert.equal(pending.titlePending, true, 'a fallback title waiting on the generated one is a placeholder')

  const draft = canvasHeaderView({
    lane: lane(),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
  })
  // One session, one name: the sidebar shows the same string for the same draft.
  assert.equal(draft.title, UNTITLED_SESSION)
})

test('the menu offers rename and delete, and delete asks a second time', () => {
  const first = canvasHeaderView({
    lane: lane(),
    menuOpen: true,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
  })
  assert.deepEqual(first.menuItems.map((item) => item.id), ['rename', 'delete'])

  const confirming = canvasHeaderView({
    lane: lane(),
    menuOpen: true,
    renaming: false,
    pendingDelete: 's1',
    hasConversation: true,
  })
  assert.deepEqual(confirming.menuItems.map((item) => item.id), ['confirm-delete', 'cancel-delete'])
  assert.equal(confirming.menuItems[0]?.danger, true)
})

test('a pending delete belongs to its session, not to the header', () => {
  // The header redraws from whichever lane is active. A bare boolean would carry
  // a confirmation onto the next session the user switched to — and that click
  // would delete a session nobody asked about.
  const view = canvasHeaderView({
    lane: lane({ sessionId: 's2', paneId: 's2' }),
    menuOpen: true,
    renaming: false,
    pendingDelete: 's1',
    hasConversation: true,
  })
  assert.deepEqual(view.menuItems.map((item) => item.id), ['rename', 'delete'])
})

test('renaming closes the menu, because Escape cannot mean two things', () => {
  const view = canvasHeaderView({
    lane: lane(),
    menuOpen: true,
    renaming: true,
    pendingDelete: undefined,
    hasConversation: true,
  })
  assert.equal(view.renaming, true)
  assert.equal(view.menuOpen, false)
})

test('a rename that changes nothing is not sent', () => {
  // `rename-session` writes the index and broadcasts to every lane; blurring the
  // field without typing must not cost that.
  assert.equal(renameCommit('old', 'old'), undefined)
  assert.equal(renameCommit('old', '  old  '), undefined)
  assert.equal(renameCommit('old', '   '), undefined)
  assert.equal(renameCommit('old', ''), undefined)
})

test('a real rename is trimmed before it is sent', () => {
  assert.equal(renameCommit('old', '  new title '), 'new title')
  assert.equal(renameCommit('', 'first name'), 'first name')
})

test('a thread session gets a breadcrumb in place of the title', () => {
  const view = canvasHeaderView({
    lane: lane({ sessionTitle: '重构缓存层' }),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
    role: 'thread',
    thread: { title: '缓存迁移', statusLabel: '运行中', tone: 'running', canStop: true },
  })
  assert.deepEqual(view.breadcrumb, {
    backLabel: '← 协调',
    threadTitle: '缓存迁移',
    statusLabel: '运行中',
    tone: 'running',
    canStop: true,
  })
  assert.equal(view.title, '重构缓存层', 'the session title is still what rename edits')
})

test('the coordinator has no breadcrumb', () => {
  const view = canvasHeaderView({
    lane: lane(),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
    role: 'coordinator',
    thread: { title: 'ignored', statusLabel: '运行中', tone: 'running', canStop: true },
  })
  assert.equal(view.breadcrumb, undefined)
})

test('an ordinary session shows no breadcrumb', () => {
  const view = canvasHeaderView({
    lane: lane(),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
  })
  assert.equal(view.breadcrumb, undefined)
})

test('a thread role without its thread falls back to the plain title', () => {
  const view = canvasHeaderView({
    lane: lane(),
    menuOpen: false,
    renaming: false,
    pendingDelete: undefined,
    hasConversation: true,
    role: 'thread',
  })
  assert.equal(view.breadcrumb, undefined)
})

test('the canvas is empty only once a pane has come and gone, and then the composer is shut', () => {
  // macOS keeps the window when its last lane closes. That canvas used to be a
  // blank page above an open composer that took a message and sent it nowhere.
  // Before the first pane attaches the window is starting up, not empty: an
  // empty state there would flash on every launch.
  assert.equal(canvasIsEmpty({ hadPane: false, hasActivePane: false }), false)
  assert.equal(canvasIsEmpty({ hadPane: true, hasActivePane: true }), false)
  assert.equal(canvasIsEmpty({ hadPane: true, hasActivePane: false }), true)

  assert.equal(composerLockReason({ empty: true, threadFinished: false }), NO_SESSION_LOCK)
  assert.equal(composerLockReason({ empty: false, threadFinished: true }), THREAD_FINISHED_LOCK)
  assert.equal(composerLockReason({ empty: false, threadFinished: false }), undefined)
})
