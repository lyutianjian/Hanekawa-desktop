import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { openInEditor, type SpawnLike, type SpawnOptions } from '../src/desktop/openInEditor.js'

/**
 * The `code <cwd>` launcher.
 *
 * Its own module precisely so this file can exist: the platform branch is
 * invisible from the host it is not running on, and `main.ts` — where this code
 * would otherwise live — has no unit test at all.
 */

interface Launch {
  command: string
  args: readonly string[]
  options: SpawnOptions
}

/**
 * A child process that does nothing until the test says so.
 *
 * An `EventEmitter` with `unref`, which is the whole surface `openInEditor`
 * touches — `once('error')`, `once('exit')`, `unref()`. Recording `unref` is not
 * decoration: a referenced child keeps the Electron main process alive for as
 * long as the editor runs.
 */
class FakeChild extends EventEmitter {
  unrefs = 0
  unref(): void {
    this.unrefs += 1
  }
}

function fakeSpawn(): { spawn: SpawnLike; launches: Launch[]; children: FakeChild[] } {
  const launches: Launch[] = []
  const children: FakeChild[] = []
  const spawn: SpawnLike = (command, args, options) => {
    launches.push({ command, args, options })
    const child = new FakeChild()
    children.push(child)
    return child as unknown as ChildProcess
  }
  return { spawn, launches, children }
}

test('posix passes the path as one argv entry, unquoted', async () => {
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('/home/me/my project', undefined, { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches, [
    {
      command: 'code',
      args: ['/home/me/my project'],
      options: { detached: true, stdio: 'ignore' },
    },
  ])
  assert.equal(children[0]!.unrefs, 1, 'the child must not hold the app open')
})

test('windows goes through cmd.exe with the path quoted verbatim', async () => {
  // `code` on Windows is `code.cmd`, which Node refuses to spawn directly since
  // 18.20. The quoting is what makes `&` in a path data rather than a separator,
  // and it is safe because a Windows path cannot contain a double quote.
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('C:\\repo\\a&b', undefined, { spawn, platform: 'win32', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches[0]!.command, 'cmd.exe')
  assert.deepEqual(launches[0]!.args, ['/c', 'code', '"C:\\repo\\a&b"'])
  assert.equal(launches[0]!.options.windowsVerbatimArguments, true)
  // `cmd.exe` gets no console window of its own: it flashed black over the app.
  assert.equal(launches[0]!.options.windowsHide, true)
})

test('a nonzero exit is reported as "code is not installed"', async () => {
  // The Windows case this exists for: `cmd.exe` starts perfectly well and then
  // fails to find `code`, so `spawn` succeeding proves nothing.
  const { spawn, children } = fakeSpawn()
  const done = openInEditor('C:\\repo', undefined, { spawn, platform: 'win32', graceMs: 50 })
  children[0]!.emit('exit', 1)

  await assert.rejects(done, /code 命令/)
})

test('ENOENT is reported as "code is not installed" too, and other errors verbatim', async () => {
  const first = fakeSpawn()
  const missing = openInEditor('/repo', undefined, { spawn: first.spawn, platform: 'linux', graceMs: 50 })
  const enoent: NodeJS.ErrnoException = Object.assign(new Error('spawn code ENOENT'), { code: 'ENOENT' })
  first.children[0]!.emit('error', enoent)
  await assert.rejects(missing, /code 命令/)

  const second = fakeSpawn()
  const denied = openInEditor('/repo', undefined, { spawn: second.spawn, platform: 'linux', graceMs: 50 })
  second.children[0]!.emit('error', Object.assign(new Error('EACCES'), { code: 'EACCES' }))
  await assert.rejects(denied, /EACCES/)
})

test('a launcher that stays alive resolves rather than hanging the request', async () => {
  // An editor started in the foreground never exits. The renderer's promise must
  // not wait for it — the launch plainly worked.
  const { spawn, children } = fakeSpawn()
  await openInEditor('/repo', undefined, { spawn, platform: 'linux', graceMs: 1 })
  assert.equal(children[0]!.unrefs, 1)
})

test('the first outcome wins; a later event cannot settle it twice', async () => {
  // `exit` after `error` is the normal sequence for a failed spawn. A second
  // settle would be an unhandled rejection rather than a visible failure.
  const { spawn, children } = fakeSpawn()
  const done = openInEditor('/repo', undefined, { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }))
  children[0]!.emit('exit', 0)
  await assert.rejects(done, /boom/)
})

// --- a search hit's file at its line (T15) ----------------------------------

test('a target with a line goes through goto, as one argv entry on posix', async () => {
  // `-g` is `--goto`: `code -g file:line` lands the cursor on the line a Grep
  // hit named. The `file:line` is one argv entry — there is no shell to parse
  // it apart.
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('/repo', { path: '/repo/src/a b.ts', line: 12 }, { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches, [
    {
      command: 'code',
      args: ['-g', '/repo/src/a b.ts:12'],
      options: { detached: true, stdio: 'ignore' },
    },
  ])
})

test('a target without a line opens the file itself, with no goto flag', async () => {
  // A goto argument that never says where to go is the plain open spelled
  // oddly — the file itself is what a Glob row's click means.
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor('/repo', { path: '/repo/src/a.ts' }, { spawn, platform: 'linux', graceMs: 50 })
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches[0]!.args, ['/repo/src/a.ts'])
})

test('windows quotes the whole goto argument, flag and all', async () => {
  // Same hand-quoting as the directory open, over `file:line`: the closing
  // quote cannot be forged because a Windows path has no double quote, so the
  // colon that carries the line stays inside the argument.
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor(
    'C:\\repo\\alpha',
    { path: 'C:\\repo\\alpha\\src\\a&b.ts', line: 34 },
    { spawn, platform: 'win32', graceMs: 50 },
  )
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches[0]!.command, 'cmd.exe')
  assert.deepEqual(launches[0]!.args, ['/c', 'code', '-g', '"C:\\repo\\alpha\\src\\a&b.ts:34"'])
  assert.equal(launches[0]!.options.windowsVerbatimArguments, true)
})

test('a windows target without a line is the plain quoted open', async () => {
  const { spawn, launches, children } = fakeSpawn()
  const done = openInEditor(
    'C:\\repo\\alpha',
    { path: 'C:\\repo\\alpha\\a&b.ts' },
    { spawn, platform: 'win32', graceMs: 50 },
  )
  children[0]!.emit('exit', 0)
  await done

  assert.deepEqual(launches[0]!.args, ['/c', 'code', '"C:\\repo\\alpha\\a&b.ts"'])
})
