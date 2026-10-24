import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import {
  GUI_PATH_BEGIN_MARKER,
  GUI_PATH_END_MARKER,
  isGuiLaunch,
  restoreGuiPath,
  type SpawnProbe,
} from '../src/desktop/guiPath.js'

/**
 * The macOS GUI PATH probe, without spawning a real login shell.
 *
 * The helper only ever talks to the shell through `spawn`: stdout, `close`,
 * `error`, and the timer. A fake child drives every branch deterministically,
 * and the installed shell is never consulted, so a test machine's rc files
 * cannot change the result.
 */

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
}

function fakeChild(pid = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.stdout = new EventEmitter()
  return child
}

interface Probe {
  spawnProbe: SpawnProbe
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>
}

function probe(child: FakeChild, onSpawn?: () => void): Probe {
  const calls: Probe['calls'] = []
  return {
    calls,
    spawnProbe: (command, args, options) => {
      calls.push({ command, args, options })
      onSpawn?.()
      return child as unknown as ChildProcess
    },
  }
}

function guiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', HOME: '/Users/test', KEEP: 'yes', ...overrides }
}

function output(path: string, noise = ''): string {
  return `${noise}\n${GUI_PATH_BEGIN_MARKER}\n${path}\n${GUI_PATH_END_MARKER}\n${noise}`
}

test('isGuiLaunch: only a macOS launch with no terminal behind it', () => {
  assert.equal(isGuiLaunch('darwin', {}), true)
  assert.equal(isGuiLaunch('darwin', { TERM: 'xterm-256color' }), false)
  assert.equal(isGuiLaunch('darwin', { TERM_PROGRAM: 'iTerm.app' }), false)
  assert.equal(isGuiLaunch('linux', {}), false)
  assert.equal(isGuiLaunch('win32', {}), false)
})

test('restoreGuiPath probes the login shell once and imports only PATH', async () => {
  const child = fakeChild()
  const { spawnProbe, calls } = probe(child)
  const env = guiEnv()

  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
  child.stdout.emit('data', output('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', 'nvm: loaded'))
  child.emit('close', 0)

  const result = await resultPromise
  assert.deepEqual(result, { status: 'applied', path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' })
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
  // Everything else in the process environment is left alone — the probe may
  // run the user's rc, but it may not rewrite the app's environment.
  assert.equal(env.KEEP, 'yes')
  assert.equal(env.SHELL, '/bin/zsh')
  assert.equal(env.HOME, '/Users/test')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.command, '/bin/zsh')
  assert.deepEqual(calls[0]!.args.slice(0, 3), ['-l', '-i', '-c'])
  assert.match(calls[0]!.args[3]!, /\/usr\/bin\/printenv PATH/)
  assert.equal(calls[0]!.options.detached, true)
  assert.deepEqual(calls[0]!.options.stdio, ['ignore', 'pipe', 'ignore'])
})

test('restoreGuiPath ignores rc stdout outside the markers', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()

  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
  child.stdout.emit('data', `${'welcome '.repeat(200)}\n`)
  child.stdout.emit('data', output('/usr/local/bin:/usr/bin:/bin'))
  child.emit('close', 0)

  const result = await resultPromise
  assert.equal(result.status, 'applied')
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin')
})

test('restoreGuiPath keeps the original PATH when the output has no usable markers', async () => {
  for (const [name, stdout] of [
    ['no markers', 'some rc output\n'],
    ['empty PATH', `${GUI_PATH_BEGIN_MARKER}\n\n${GUI_PATH_END_MARKER}\n`],
    ['two lines', `${GUI_PATH_BEGIN_MARKER}\n/usr/bin\n/bin\n${GUI_PATH_END_MARKER}\n`],
    ['unterminated', `${GUI_PATH_BEGIN_MARKER}\n/usr/bin:/bin\n`],
  ] as const) {
    const child = fakeChild()
    const { spawnProbe } = probe(child)
    const env = guiEnv()
    const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
    child.stdout.emit('data', stdout)
    child.emit('close', 0)

    const result = await resultPromise
    assert.deepEqual(result, { status: 'failed', reason: 'invalid-output' }, name)
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', `${name}: original PATH survives`)
  }
})

test('restoreGuiPath keeps the original PATH when the shell cannot be spawned', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()
  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
  child.emit('error', Object.assign(new Error('spawn /bin/zsh ENOENT'), { code: 'ENOENT' }))

  const result = await resultPromise
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.reason, 'spawn-failed')
  assert.match(result.detail ?? '', /ENOENT/)
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
})

test('restoreGuiPath reports a synchronous spawn failure without touching PATH', async () => {
  const env = guiEnv()
  const result = await restoreGuiPath({
    platform: 'darwin',
    env,
    spawnProbe: () => {
      throw new Error('bad executable')
    },
  })

  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.reason, 'spawn-failed')
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
})

test('a hung probe times out, reaps its process tree, and keeps the original PATH', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const terminated: ChildProcess[] = []
  const env = guiEnv()

  const result = await restoreGuiPath({
    platform: 'darwin',
    env,
    spawnProbe,
    timeoutMs: 10,
    terminateTree: async (proc) => {
      terminated.push(proc)
    },
  })

  assert.deepEqual(result, { status: 'failed', reason: 'timeout' })
  assert.equal(terminated.length, 1, 'the probe it started is the one reaped')
  assert.equal(terminated[0], child as unknown as ChildProcess)
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', 'a timeout never rewrites PATH')

  // A late close from the killed probe must not change the settled answer.
  child.stdout.emit('data', output('/hijacked:/bin'))
  child.emit('close', 0)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
})

test('a probe that floods stdout is cut off and reaped', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  let terminated = 0
  const env = guiEnv()

  const resultPromise = restoreGuiPath({
    platform: 'darwin',
    env,
    spawnProbe,
    maxOutputBytes: 32,
    terminateTree: async () => {
      terminated += 1
    },
  })
  child.stdout.emit('data', 'x'.repeat(64))

  const result = await resultPromise
  assert.deepEqual(result, { status: 'failed', reason: 'output-too-long' })
  assert.equal(terminated, 1)
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
})

test('restoreGuiPath does nothing off macOS or when launched from a terminal', async () => {
  for (const [name, platform, env] of [
    ['linux', 'linux', {}],
    ['windows', 'win32', {}],
    ['mac terminal', 'darwin', { TERM: 'xterm-256color' }],
    ['mac terminal program', 'darwin', { TERM_PROGRAM: 'vscode' }],
  ] as const) {
    let spawned = 0
    const result = await restoreGuiPath({
      platform,
      env,
      spawnProbe: () => {
        spawned += 1
        return fakeChild() as unknown as ChildProcess
      },
    })
    assert.deepEqual(result, { status: 'not-applicable' }, name)
    assert.equal(spawned, 0, `${name}: no shell is started`)
  }
})