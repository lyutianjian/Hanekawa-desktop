import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GUI_PATH_BEGIN_MARKER,
  GUI_PATH_END_MARKER,
  isGuiLaunch,
  reapProbeGroup,
  restoreGuiPath,
  type SpawnProbe,
} from '../src/desktop/guiPath.js'

/**
 * The probe's shell is faked for deterministic branches. The process-tree
 * reaper is tested separately against real shells, because a fake `kill` call
 * would only prove that a function was called.
 */

interface FakeChild extends EventEmitter {
  pid?: number
  stdout: EventEmitter
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = new EventEmitter()
  return child
}

interface Probe {
  spawnProbe: SpawnProbe
  calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }>
}

function probe(child: FakeChild): Probe {
  const calls: Probe['calls'] = []
  return {
    calls,
    spawnProbe: (command, args, options) => {
      calls.push({ command, args, options })
      return child as unknown as ChildProcess
    },
  }
}

function guiEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/zsh', HOME: '/Users/test', KEEP: 'yes', ...overrides }
}

function probeOutput(path: string, noise = ''): string {
  return `${noise}\n${GUI_PATH_BEGIN_MARKER}\n${path}\n${GUI_PATH_END_MARKER}\n${noise}`
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('condition was not met before the timeout')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

async function waitForPid(file: string, timeoutMs = 3000): Promise<number> {
  let pid: number | undefined
  await waitUntil(() => {
    try {
      const value = Number(readFileSync(file, 'utf8').trim())
      if (Number.isInteger(value) && value > 0) {
        pid = value
        return true
      }
    } catch {
      // Not written yet.
    }
    return false
  }, timeoutMs)
  return pid!
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
  child.stdout.emit('data', probeOutput('/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin', 'nvm: loaded'))
  child.emit('close', 0, null)

  const result = await resultPromise
  assert.deepEqual(result, { status: 'applied', path: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' })
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin')
  assert.equal(env.KEEP, 'yes')
  assert.equal(env.SHELL, '/bin/zsh')
  assert.equal(env.HOME, '/Users/test')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.command, '/bin/zsh')
  assert.deepEqual(calls[0]!.args.slice(0, 3), ['-l', '-i', '-c'])
  assert.match(calls[0]!.args[3]!, /\/usr\/bin\/printenv PATH/)
  assert.equal(calls[0]!.options.detached, true)
  assert.deepEqual(calls[0]!.options.stdio, ['ignore', 'pipe', 'ignore'])

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(child.listenerCount('close'), 0, 'the probe listeners are removed')
  assert.equal(child.listenerCount('error'), 0)
  assert.equal(child.stdout.listenerCount('data'), 0)
})

test('restoreGuiPath ignores rc stdout outside the markers', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()

  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
  child.stdout.emit('data', `${'welcome '.repeat(200)}\n`)
  child.stdout.emit('data', probeOutput('/usr/local/bin:/usr/bin:/bin'))
  child.emit('close', 0, null)

  const result = await resultPromise
  assert.equal(result.status, 'applied')
  assert.equal(env.PATH, '/usr/local/bin:/usr/bin:/bin')
})

test('restoreGuiPath decodes a PATH split inside a multi-byte character', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()
  const path = '/Users/测试/bin:/usr/bin'

  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
  const bytes = Buffer.from(probeOutput(path))
  const splitAt = bytes.indexOf(Buffer.from('测')) + 1
  assert.ok(splitAt > 0, 'the split lands inside a multi-byte character')
  child.stdout.emit('data', bytes.subarray(0, splitAt))
  child.stdout.emit('data', bytes.subarray(splitAt))
  child.emit('close', 0, null)

  const result = await resultPromise
  assert.equal(result.status, 'applied')
  assert.equal(env.PATH, path)
})

test('the output cap is counted in raw bytes before the chunk is appended', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()

  const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe, maxOutputBytes: 4 })
  child.stdout.emit('data', Buffer.from('中文'))

  const result = await resultPromise
  assert.deepEqual(result, { status: 'failed', reason: 'output-too-long' })
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
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
    child.emit('close', 0, null)

    const result = await resultPromise
    assert.deepEqual(result, { status: 'failed', reason: 'invalid-output' }, name)
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin', `${name}: original PATH survives`)
  }
})

test('restoreGuiPath rejects a non-zero or signalled shell even with a valid PATH line', async () => {
  for (const [code, signal, detail] of [[2, null, 'exit 2'], [null, 'SIGTERM', 'signal SIGTERM']] as const) {
    const child = fakeChild()
    const { spawnProbe } = probe(child)
    const env = guiEnv()
    const resultPromise = restoreGuiPath({ platform: 'darwin', env, spawnProbe })
    child.stdout.emit('data', probeOutput('/bad:/usr/bin'))
    child.emit('close', code, signal)

    const result = await resultPromise
    assert.deepEqual(result, { status: 'failed', reason: 'shell-failed', detail })
    assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
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

test('a hung probe times out, reaps, cleans up, and keeps the original PATH', async () => {
  const child = fakeChild()
  const { spawnProbe } = probe(child)
  const env = guiEnv()

  const result = await restoreGuiPath({
    platform: 'darwin',
    env,
    spawnProbe,
    timeoutMs: 10,
  })

  assert.deepEqual(result, { status: 'failed', reason: 'timeout' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
  assert.equal(child.listenerCount('close'), 0)

  child.stdout.emit('data', probeOutput('/hijacked:/bin'))
  child.emit('close', 0, null)
  await new Promise((resolve) => setImmediate(resolve))
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

test('reapProbeGroup kills a TERM-ignoring grandchild after its leader exits', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hanekawa-reap-'))
  const pidFile = join(dir, 'grandchild.pid')
  const script = [
    `trap '' TERM`,
    `/bin/sh -c 'trap "" TERM; while :; do sleep 0.05; done' &`,
    `echo $! > '${pidFile}'`,
    `exit 0`,
  ].join('\n')
  const child = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))

  try {
    const grandchild = await waitForPid(pidFile)
    await exited
    assert.equal(groupAlive(child.pid!), true, 'the leader is gone but its group is not')
    assert.equal(await reapProbeGroup(child, { graceMs: 200, pollMs: 20 }), true)
    await waitUntil(() => !alive(grandchild), 2000)
    assert.equal(alive(grandchild), false)
    assert.equal(groupAlive(child.pid!), false)
  } finally {
    child.stdout?.destroy()
    try {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a timed-out probe reaps a real shell whose grandchild holds the pipe', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hanekawa-probe-'))
  const pidFile = join(dir, 'grandchild.pid')
  const script = [
    `trap '' TERM`,
    `/bin/sh -c 'trap "" TERM; while :; do sleep 0.05; done' &`,
    `echo $! > '${pidFile}'`,
    `exit 0`,
  ].join('\n')
  let spawned: ChildProcess | undefined

  try {
    const result = await restoreGuiPath({
      platform: 'darwin',
      env: guiEnv(),
      timeoutMs: 150,
      spawnProbe: () => {
        spawned = spawn('/bin/sh', ['-c', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] })
        return spawned
      },
    })
    assert.deepEqual(result, { status: 'failed', reason: 'timeout' })

    const grandchild = await waitForPid(pidFile)
    await waitUntil(() => !alive(grandchild), 3000)
    assert.equal(alive(grandchild), false, 'the grandchild the leader left behind is gone')
    await waitUntil(() => !groupAlive(spawned!.pid!), 2000)
    await waitUntil(() => spawned!.listenerCount('close') === 0, 2000)
    assert.equal(spawned!.stdout?.destroyed, true, 'the probe pipe is closed too')
  } finally {
    spawned?.stdout?.destroy()
    try {
      if (spawned?.pid !== undefined) process.kill(-spawned.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the repaired PATH is what a real child resolves; the launch PATH alone is not', { skip: process.platform === 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hanekawa-path-'))
  try {
    const bin = join(dir, 'bin')
    mkdirSync(bin)
    const tool = join(bin, 'hanekawa-path-probe')
    writeFileSync(tool, '#!/bin/sh\necho ok\n')
    chmodSync(tool, 0o755)

    const launchPath = '/usr/bin:/bin:/usr/sbin:/sbin'
    const missing = spawnSync('hanekawa-path-probe', [], { env: { PATH: launchPath } })
    assert.equal((missing.error as NodeJS.ErrnoException | undefined)?.code, 'ENOENT')

    const shell = join(dir, 'gui-shell')
    const fixedPath = `${bin}:${launchPath}`
    writeFileSync(shell, [
      '#!/bin/sh',
      `printf '\\n%s\\n' '${GUI_PATH_BEGIN_MARKER}'`,
      `printf '%s\\n' '${fixedPath}'`,
      `printf '%s\\n' '${GUI_PATH_END_MARKER}'`,
    ].join('\n'))
    chmodSync(shell, 0o755)

    const env: NodeJS.ProcessEnv = { PATH: launchPath, SHELL: shell, HOME: dir }
    const result = await restoreGuiPath({ platform: 'darwin', env, shell })
    assert.equal(result.status, 'applied')
    assert.equal(env.PATH, fixedPath)

    const found = spawnSync('hanekawa-path-probe', [], { env })
    assert.equal(found.status, 0)
    assert.equal(String(found.stdout).trim(), 'ok')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
