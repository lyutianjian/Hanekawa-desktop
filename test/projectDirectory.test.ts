import test from 'node:test'
import assert from 'node:assert/strict'
import { resolve, sep } from 'node:path'
import {
  ProjectDirectory,
  projectDisplayName,
  projectRootKey,
  type DirectoryProject,
  type DirectoryWorkspace,
  type PaneLike,
} from '../src/runtime/projectDirectory.js'
import type { SessionMeta } from '../src/sessions/service.js'

/**
 * The project tier that `main.ts` cannot cover.
 *
 * Everything here used to be a module-level variable in the Electron main
 * process, which is unimportable under plain node (`app.requestSingleInstanceLock()`
 * runs at module top level). Pulling it into a class is what makes the ordering
 * rules — key normalization, close-then-shutdown, one projection — assertable.
 *
 * Note there is no `as unknown as` anywhere below: `ProjectDirectory` is generic
 * over its two halves, so the fakes are checked against the members the class
 * actually calls instead of being cast past the compiler.
 */

interface FakeProject extends DirectoryProject {
  shutdowns: string[]
}

interface FakeWorkspace extends DirectoryWorkspace {
  panes: PaneLike[]
  closeAllCalls: number
}

/** Records the interleaving, so "closed before shut down" is checkable. */
function fakeProject(cwd: string, log: string[] = []): FakeProject {
  const shutdowns: string[] = []
  return {
    cwd,
    shutdowns,
    shutdown: async (reason) => {
      shutdowns.push(reason)
      log.push(`shutdown:${cwd}`)
    },
  }
}

function fakeWorkspace(cwd: string, panes: PaneLike[] = [], log: string[] = []): FakeWorkspace {
  const workspace: FakeWorkspace = {
    panes,
    closeAllCalls: 0,
    list: () => workspace.panes,
    closeAll: () => {
      workspace.closeAllCalls += 1
      log.push(`closeAll:${cwd}`)
    },
  }
  return workspace
}

function fakePane(id: string, title?: string): PaneLike {
  const session = { id, ...(title !== undefined ? { title } : {}) } as SessionMeta
  return { getSession: () => session }
}

function directory(): ProjectDirectory<FakeProject, FakeWorkspace> {
  return new ProjectDirectory<FakeProject, FakeWorkspace>()
}

test('lifecycle callbacks cover closing projects and run once on shutdown failure', async () => {
  const seen: string[] = []
  const dir = new ProjectDirectory<FakeProject, FakeWorkspace>({
    onAdded: (entry) => { seen.push(`add:${entry.cwd}`) },
    onClosed: (entry) => { seen.push(`closed:${entry.cwd}`) },
  })
  let reject!: (error: Error) => void
  const closing = new Promise<void>((_resolve, fail) => { reject = fail })
  const entry = dir.add({ ...fakeProject('/tmp/lifecycle'), shutdown: () => closing }, fakeWorkspace('/tmp/lifecycle'))
  const run = dir.closeProject(entry, 'test')
  const failed = assert.rejects(run, /shutdown failed/)
  assert.equal(dir.size, 0)
  assert.deepEqual(seen, ['add:/tmp/lifecycle'])
  void dir.closeProject(entry, 'duplicate')
  reject(new Error('shutdown failed'))
  await failed
  await dir.whenClosed(entry.cwd)
  assert.deepEqual(seen, ['add:/tmp/lifecycle', 'closed:/tmp/lifecycle'])
})

test('a project is keyed by its resolved root, so the same directory is one project', () => {
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))

  // A trailing separator and a `.` hop are the same directory.
  assert.ok(dir.get(root + sep), 'a trailing separator must not mint a second project')
  assert.ok(dir.get(`${root}${sep}.`), 'a "." segment must resolve away')
  assert.equal(dir.size, 1)
})

test('on a case-insensitive filesystem, case does not mint a second project', () => {
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))

  const flipped = root.toUpperCase()
  const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin'
  // The point is that the directory agrees with `src/utils/paths.ts` about what
  // "the same directory" means, whichever way that platform answers.
  assert.equal(Boolean(dir.get(flipped)), caseInsensitive || flipped === root)
})

test('adding the same root twice throws instead of replacing', () => {
  // Two `ProjectRuntime`s over one `.hanekawa/` means two `SessionStore`s
  // appending to the same JSONL files; the shell is expected to `get()` first.
  const dir = directory()
  const root = process.cwd()
  dir.add(fakeProject(root), fakeWorkspace(root))
  assert.throws(() => dir.add(fakeProject(root), fakeWorkspace(root)), /already open/)
  assert.equal(dir.size, 1)
})

test('entries() keeps the order projects were opened', () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  dir.add(fakeProject(a), fakeWorkspace(a))
  dir.add(fakeProject(b), fakeWorkspace(b))
  assert.deepEqual(dir.entries().map((entry) => entry.cwd), [a, b])
})

test('entryForPane finds the owning project, and nothing for a stranger', () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const mine = fakePane('s1')
  const theirs = fakePane('s2')
  const entryA = dir.add(fakeProject(a), fakeWorkspace(a, [mine]))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b, [theirs]))

  assert.equal(dir.entryForPane(mine), entryA)
  assert.equal(dir.entryForPane(theirs), entryB)
  assert.equal(dir.entryForPane(fakePane('s3')), undefined)
})

test('describe projects the panes it is given, with the project fields filled in', () => {
  const dir = directory()
  const a = `${process.cwd()}${sep}src`
  const b = `${process.cwd()}${sep}test`
  const first = fakePane('s1', 'First')
  const second = fakePane('s2')
  const other = fakePane('s3', 'Other')
  dir.add(fakeProject(a), fakeWorkspace(a, [first, second]))
  dir.add(fakeProject(b), fakeWorkspace(b, [other]))

  assert.deepEqual(dir.describe([first, second, other]), [
    {
      paneId: 's1',
      sessionId: 's1',
      projectRoot: projectRootKey(a),
      projectName: 'src',
      sessionTitle: 'First',
    },
    // No `sessionTitle` key at all for an untitled draft, rather than undefined:
    // the wire is structured-cloned and the tab bar falls back on absence.
    { paneId: 's2', sessionId: 's2', projectRoot: projectRootKey(a), projectName: 'src' },
    {
      paneId: 's3',
      sessionId: 's3',
      projectRoot: projectRootKey(b),
      projectName: 'test',
      sessionTitle: 'Other',
    },
  ])
})

test('describe follows the order it is handed, not the project order', () => {
  // The shell passes its window map, and window order is what the user sees.
  const dir = directory()
  const a = `${process.cwd()}${sep}src`
  const b = `${process.cwd()}${sep}test`
  const mine = fakePane('s1')
  const theirs = fakePane('s2')
  dir.add(fakeProject(a), fakeWorkspace(a, [mine]))
  dir.add(fakeProject(b), fakeWorkspace(b, [theirs]))

  assert.deepEqual(dir.describe([theirs, mine]).map((info) => info.paneId), ['s2', 's1'])
})

test('describe projects the coordination role, and omits it for an ordinary session', () => {
  const dir = directory()
  const a = `${process.cwd()}${sep}src`
  const coordinator = {
    getSession: () => ({ id: 'c1', coordination: { role: 'coordinator', projectKey: 'k' } }) as SessionMeta,
  }
  const thread = {
    getSession: () => ({ id: 't1', coordination: { role: 'thread', projectKey: 'k', threadId: 'x' } }) as SessionMeta,
  }
  const plain = fakePane('p1')
  dir.add(fakeProject(a), fakeWorkspace(a, [coordinator, thread, plain]))

  const [c, t, p] = dir.describe([coordinator, thread, plain])
  assert.equal(c!.coordinationRole, 'coordinator')
  assert.equal(t!.coordinationRole, 'thread')
  assert.equal('coordinationRole' in p!, false)
})

test('describe drops a pane no open project owns', () => {
  // A pane whose project was just closed must not be advertised as a tab.
  const dir = directory()
  const a = process.cwd()
  dir.add(fakeProject(a), fakeWorkspace(a, []))
  assert.deepEqual(dir.describe([fakePane('ghost')]), [])
})

test('closeProject closes every pane before shutting the project down', () => {
  // The reverse order pulls the tools out from under panes that are still
  // draining: `shutdown()` stops background tasks and MCP clients, `closeAll()`
  // runs each pane's fixed four-step teardown.
  const log: string[] = []
  const dir = directory()
  const root = process.cwd()
  const entry = dir.add(fakeProject(root, log), fakeWorkspace(root, [fakePane('s1')], log))

  return dir.closeProject(entry, 'project-closed').then(() => {
    assert.deepEqual(log, [`closeAll:${root}`, `shutdown:${root}`])
    assert.deepEqual(entry.project.shutdowns, ['project-closed'])
    assert.equal(dir.size, 0)
    assert.equal(dir.get(root), undefined)
  })
})

test('closeProject is idempotent, so quit and last-window-closed can both arrive', async () => {
  const dir = directory()
  const root = process.cwd()
  const slow = fakeProject(root)
  let done = false
  slow.shutdown = async (reason) => {
    slow.shutdowns.push(reason)
    await new Promise<void>((resolve) => setTimeout(resolve, 10))
    done = true
  }
  const entry = dir.add(slow, fakeWorkspace(root))

  // The second caller is handed the first close, not a resolved promise: it is
  // waiting for "this project is down", and it has to actually be down.
  await Promise.all([
    dir.closeProject(entry, 'first'),
    dir.closeProject(entry, 'second'),
  ])
  assert.equal(done, true)
  await dir.closeProject(entry, 'third')

  assert.deepEqual(entry.project.shutdowns, ['first'])
  assert.equal(entry.workspace.closeAllCalls, 1)
})

test('shutdownAll closes every project and empties the directory', async () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const entryA = dir.add(fakeProject(a), fakeWorkspace(a, [fakePane('s1')]))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b, [fakePane('s2')]))

  await dir.shutdownAll('app-quit')

  assert.deepEqual(entryA.project.shutdowns, ['app-quit'])
  assert.deepEqual(entryB.project.shutdowns, ['app-quit'])
  assert.equal(dir.size, 0)
})

test('shutdownAll does not let one failing project keep the others open', async () => {
  // On the way out a misbehaving MCP server must not block the quit.
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const broken = fakeProject(a)
  broken.shutdown = async () => {
    throw new Error('server hung')
  }
  dir.add(broken, fakeWorkspace(a))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b))

  await dir.shutdownAll('app-quit')

  assert.deepEqual(entryB.project.shutdowns, ['app-quit'])
  assert.equal(dir.size, 0)
})

/**
 * The quit-vs-teardown race: `ShellHost.settleAfterLastLane` closes a project
 * with a bare `void closeProject(...)`, and the entry is out of the map before
 * the first await. A directory that only remembered *that* a root was closing
 * would let `shutdownAll` return while that project was still stopping child
 * processes — the app exits, the subprocesses outlive it.
 */
test('shutdownAll waits for a close that was already in flight', async () => {
  const dir = directory()
  const root = process.cwd()
  const slow = fakeProject(root)
  let release = (): void => {}
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  slow.shutdown = async (reason) => {
    slow.shutdowns.push(reason)
    await blocked
  }
  const entry = dir.add(slow, fakeWorkspace(root))

  void dir.closeProject(entry, 'last-lane')
  let settled = false
  const quitting = dir.shutdownAll('app-quit').then((outcome) => {
    settled = true
    return outcome
  })

  // Several turns of the microtask queue: enough for a `shutdownAll` that
  // skipped the in-flight close to have resolved by now.
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve()
  assert.equal(settled, false, 'the quit must not outrun a project that is still closing')

  release()
  assert.equal(await quitting, 'drained')
  // The in-flight close is the only shutdown: `shutdownAll` did not start a
  // second one behind it.
  assert.deepEqual(slow.shutdowns, ['last-lane'])
})

/**
 * The watchdog. `ProjectRuntime.shutdown()` awaits a subagent's `stop()` and
 * every `mcpClient.close()`, neither of which has a timeout, and `before-quit`
 * has already destroyed the window by the time it runs.
 */
test('shutdownAll gives up on a project that never drains and still reports the others', async () => {
  const dir = directory()
  const a = process.cwd()
  const b = `${process.cwd()}${sep}src`
  const stuck = fakeProject(a)
  stuck.shutdown = async (reason) => {
    stuck.shutdowns.push(reason)
    await new Promise<never>(() => {})
  }
  dir.add(stuck, fakeWorkspace(a))
  const entryB = dir.add(fakeProject(b), fakeWorkspace(b))

  const outcome = await dir.shutdownAll('app-quit', { timeoutMs: 20 })

  assert.equal(outcome, 'timed-out')
  assert.deepEqual(stuck.shutdowns, ['app-quit'], 'the hung project was asked, it just never answered')
  assert.deepEqual(entryB.project.shutdowns, ['app-quit'])
})

test('without a deadline shutdownAll still waits as long as it takes', async () => {
  const dir = directory()
  const root = process.cwd()
  const slow = fakeProject(root)
  let finished = false
  slow.shutdown = async (reason) => {
    slow.shutdowns.push(reason)
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    finished = true
  }
  dir.add(slow, fakeWorkspace(root))

  assert.equal(await dir.shutdownAll('app-quit'), 'drained')
  assert.equal(finished, true)
})

test('projectDisplayName is the basename, falling back to the path for a root', () => {
  assert.equal(projectDisplayName(`${process.cwd()}${sep}src`), 'src')
  // `basename('C:\\')` and `basename('/')` are both empty, and a nameless tab
  // group heading is worse than a long one.
  const filesystemRoot = process.platform === 'win32' ? 'C:\\' : '/'
  assert.equal(projectDisplayName(filesystemRoot), resolve(filesystemRoot))
})
