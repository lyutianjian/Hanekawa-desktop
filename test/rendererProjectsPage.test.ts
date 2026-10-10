import assert from 'node:assert/strict'
import test from 'node:test'

import { isCoordinationProject } from '../src/desktop/renderer/model/coordinationStatus.js'
import { projectCards } from '../src/desktop/renderer/model/projectsPage.js'
import type { SidebarProjectSessions } from '../src/desktop/renderer/model/sidebar.js'
import type { WireCoordinationThreads, WireThreadInfo, WireThreadStatus } from '../src/desktop/shellProtocol.js'

const NOW = Date.parse('2026-10-10T12:00:00Z')
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString()

function thread(status: WireThreadStatus, lastActivityAt = hoursAgo(1)): WireThreadInfo {
  return { threadId: `t-${status}`, sessionId: `s-${status}`, title: 'T', status, lastActivityAt }
}

function project(root: string, overrides: Partial<SidebarProjectSessions> = {}): SidebarProjectSessions {
  return { projectRoot: root, projectName: root.slice(1), projectPath: `/Users/me${root}`, sessions: [], ...overrides }
}

function table(root: string, overrides: Partial<WireCoordinationThreads> = {}): [string, WireCoordinationThreads] {
  return [root, { projectRoot: root, threads: [], ...overrides }]
}

const none = new Set<string>()

test('a project is a coordination project once it has a coordinator, had one, or has threads', () => {
  const cases: Array<[Partial<WireCoordinationThreads>, boolean]> = [
    [{}, false],
    [{ coordinatorSessionId: 'c' }, true],
    [{ started: true }, true],
    [{ threads: [thread('idle')] }, true],
  ]
  for (const [overrides, expected] of cases) {
    assert.equal(isCoordinationProject(table('/a', overrides)[1]), expected, JSON.stringify(overrides))
  }
})

test('cards: one per coordination project, with the counts the sidebar shows', () => {
  const cards = projectCards(
    [project('/a'), project('/b')],
    new Map([
      table('/a', { coordinatorSessionId: 'c', threads: [thread('running'), thread('needs-you'), thread('awaiting-coordinator'), thread('idle')] }),
      table('/b', { started: true }),
    ]),
    none,
    NOW,
  )
  assert.deepEqual(cards.map((card) => [card.name, card.path, card.counts]), [
    ['a', '/Users/me/a', '1 运行中 · 2 需要你'],
    ['b', '/Users/me/b', '空闲'],
  ])
})

test('cards are sorted by newest activity, ties keep registry order, and activity reads the coordinator and threads', () => {
  const cards = projectCards(
    [
      project('/a'),
      project('/b', { sessions: [{ id: 'cb', updatedAt: hoursAgo(5), messageCount: 1 }] }),
      project('/c'),
      project('/d'),
    ],
    new Map([
      table('/a', { threads: [thread('idle', hoursAgo(30))] }),
      table('/b', { coordinatorSessionId: 'cb', threads: [thread('idle', hoursAgo(50))] }),
      table('/c', { threads: [thread('running', hoursAgo(2))] }),
      table('/d', { started: true }),
    ]),
    none,
    NOW,
  )
  assert.deepEqual(cards.map((card) => [card.name, card.lastActivity]), [
    ['c', '2 小时前'],
    ['b', '5 小时前'],
    ['a', '1 天前'],
    ['d', ''],
  ])
})

test('cards skip the global workspace, projects being removed, and projects with no coordination', () => {
  const cards = projectCards(
    [project('/a'), project('/b'), project('/home', { isGlobal: true }), project('/d')],
    new Map([table('/a', { started: true }), table('/b', { started: true }), table('/home', { started: true }), table('/d')]),
    new Set(['/a']),
    NOW,
  )
  assert.deepEqual(cards.map((card) => card.projectRoot), ['/b'])
})

test('no coordination projects gives no cards, and a missing path falls back to the root', () => {
  assert.deepEqual(projectCards([project('/a')], new Map(), none, NOW), [])
  const [card] = projectCards([project('/a', { projectPath: undefined })], new Map([table('/a', { started: true })]), none, NOW)
  assert.equal(card!.path, '/a')
})
