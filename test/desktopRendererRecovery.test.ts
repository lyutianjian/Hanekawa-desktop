import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import test from 'node:test'
import { QuitCoordinator } from '../src/desktop/quitCoordinator.js'

import {
  RendererRecovery,
  RENDERER_RECOVERY_ATTEMPTS,
  type RendererGoneDetails,
  type RestorableLane,
} from '../src/desktop/rendererRecovery.js'

/**
 * The recovery state machine, driven through its ports.
 *
 * `main.ts` cannot be imported under plain node (it takes the single-instance
 * lock and builds windows at module scope), so the decisions live in
 * `rendererRecovery.ts` where they can be asked questions: who is asked, how
 * many times, and what happens to the flag when a rebuild throws.
 */

const crash: RendererGoneDetails = { reason: 'crashed', exitCode: 133 }

const lane: RestorableLane = { cwd: '/w/one', sessionId: 's-1', coordination: false }

function harness(options: {
  quitting?: boolean
  confirm?: (details: RendererGoneDetails) => Promise<boolean>
  lanes?: readonly RestorableLane[]
  captureError?: Error
  rebuild?: (lanes: readonly RestorableLane[]) => Promise<void>
  verdicts?: Array<'retry' | 'quit'>
} = {}): {
  recovery: RendererRecovery
  calls: {
    confirm: RendererGoneDetails[]
    rebuild: Array<readonly RestorableLane[]>
    failures: Array<{ error: unknown; attempt: number }>
    quit: number
    log: string[]
  }
} {
  const calls = {
    confirm: [] as RendererGoneDetails[],
    rebuild: [] as Array<readonly RestorableLane[]>,
    failures: [] as Array<{ error: unknown; attempt: number }>,
    quit: 0,
    log: [] as string[],
  }
  const verdicts = [...(options.verdicts ?? [])]
  const recovery = new RendererRecovery({
    isQuitting: () => options.quitting ?? false,
    confirm: (details) => {
      calls.confirm.push(details)
      return options.confirm ? options.confirm(details) : Promise.resolve(true)
    },
    captureLanes: async () => {
      if (options.captureError !== undefined) throw options.captureError
      return options.lanes ?? []
    },
    rebuild: async (lanes) => {
      calls.rebuild.push(lanes)
      await options.rebuild?.(lanes)
    },
    reportFailure: async (error, attempt) => {
      calls.failures.push({ error, attempt })
      return verdicts.shift() ?? 'quit'
    },
    quit: () => {
      calls.quit += 1
    },
    log: (message) => calls.log.push(message),
  })
  return { recovery, calls }
}

test('a crash while the app is quitting is only a log line', async () => {
  const { recovery, calls } = harness({ quitting: true, lanes: [lane] })
  await recovery.handle(crash)
  assert.deepEqual(calls.confirm, [], 'a dialog on the way out would be the app talking to itself')
  assert.deepEqual(calls.rebuild, [])
  assert.equal(calls.quit, 0)
  assert.match(calls.log.join('\n'), /crashed\/133/)
})

test('declining the recovery quits instead of leaving a white window', async () => {
  const { recovery, calls } = harness({ confirm: async () => false, lanes: [lane] })
  await recovery.handle(crash)
  assert.equal(calls.confirm.length, 1)
  assert.deepEqual(calls.rebuild, [], 'nothing may be rebuilt once the user said no')
  assert.equal(calls.quit, 1)
})

test('the dialog carries the reason and the exit code, so the report is actable', async () => {
  const { recovery, calls } = harness()
  await recovery.handle({ reason: 'oom', exitCode: 137 })
  assert.deepEqual(calls.confirm, [{ reason: 'oom', exitCode: 137 }])
})

test('a confirmed recovery rebuilds the window and reopens the captured lanes in order', async () => {
  const lanes: RestorableLane[] = [
    lane,
    { cwd: '/w/two', sessionId: 's-2', coordination: true },
  ]
  const { recovery, calls } = harness({ lanes })
  await recovery.handle(crash)
  assert.equal(calls.rebuild.length, 1)
  assert.deepEqual(calls.rebuild[0], lanes, 'the order the lanes were opened is the order they come back')
  assert.equal(calls.quit, 0)
  assert.match(calls.log.join('\n'), /恢复了 2 个会话/)
})

test('a window with nothing to restore is still rebuilt', async () => {
  const { recovery, calls } = harness({ lanes: [] })
  await recovery.handle(crash)
  assert.deepEqual(calls.rebuild, [[]], 'a window that paints with no lane beats no window')
  assert.match(calls.log.join('\n'), /没有可恢复的会话/)
})

test('a failed rebuild is offered exactly one retry, and the second attempt can succeed', async () => {
  let attempts = 0
  const { recovery, calls } = harness({
    rebuild: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('loadFile failed')
    },
    verdicts: ['retry'],
  })
  await recovery.handle(crash)
  assert.equal(calls.rebuild.length, 2, 'the retry is a real second rebuild, not a log line')
  assert.deepEqual(calls.failures.map((entry) => entry.attempt), [1])
  assert.match(String((calls.failures[0]?.error as Error).message), /loadFile failed/)
  assert.equal(calls.quit, 0)
})

test('a second consecutive failure ends the process instead of looping', async () => {
  const { recovery, calls } = harness({
    rebuild: async () => {
      throw new Error('no display')
    },
    // Even an endless "retry" cannot outlast the attempt cap.
    verdicts: ['retry', 'retry', 'retry'],
  })
  await recovery.handle(crash)
  assert.equal(calls.rebuild.length, RENDERER_RECOVERY_ATTEMPTS)
  assert.deepEqual(calls.failures.map((entry) => entry.attempt), [1, 2])
  assert.equal(calls.quit, 1)
  assert.match(calls.log.join('\n'), /放弃恢复/)
})

test('choosing to quit after a failed rebuild quits at once', async () => {
  const { recovery, calls } = harness({
    rebuild: async () => {
      throw new Error('boom')
    },
    verdicts: ['quit'],
  })
  await recovery.handle(crash)
  assert.equal(calls.rebuild.length, 1)
  assert.equal(calls.quit, 1)
})

test('a lane list that cannot be read does not block the window', async () => {
  const { recovery, calls } = harness({ captureError: new Error('store locked') })
  await recovery.handle(crash)
  assert.equal(calls.confirm.length, 1)
  assert.deepEqual(calls.rebuild, [[]])
  assert.match(calls.log.join('\n'), /store locked/)
})

test('a dialog that cannot be shown quits rather than hanging on a dead window', async () => {
  const { recovery, calls } = harness({
    confirm: async () => {
      throw new Error('no window server')
    },
  })
  await recovery.handle(crash)
  assert.deepEqual(calls.rebuild, [])
  assert.equal(calls.quit, 1)
})

test('a failure report that cannot be shown quits rather than retrying blind', async () => {
  const { recovery, calls } = harness({
    rebuild: async () => {
      throw new Error('boom')
    },
  })
  calls.failures.length = 0
  const hopeless = new RendererRecovery({
    isQuitting: () => false,
    confirm: async () => true,
    captureLanes: async () => [],
    rebuild: async () => {
      throw new Error('boom')
    },
    reportFailure: async () => {
      throw new Error('dialog failed')
    },
    quit: () => {
      calls.quit += 1
    },
    log: (message) => calls.log.push(message),
  })
  await hopeless.handle(crash)
  assert.equal(calls.quit, 1)
  assert.match(calls.log.join('\n'), /恢复失败提示无法显示/)
  void recovery
})

test('two crashes in a row run one recovery, not two windows', async () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const { recovery, calls } = harness({
    lanes: [lane],
    confirm: async () => {
      await gate
      return true
    },
  })
  const first = recovery.handle(crash)
  const second = recovery.handle({ reason: 'killed', exitCode: 9 })
  assert.equal(recovery.isRecovering(), true)
  // The run reaches the dialog only after its lane list resolves.
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls.confirm.length, 1, 'the second report waits for the first recovery')
  release()
  await Promise.all([first, second])
  assert.equal(calls.rebuild.length, 1)
  assert.match(calls.log.join('\n'), /上一次恢复尚未结束/)
})

test('the flag is cleared afterwards, so a later crash still gets an answer', async () => {
  const { recovery, calls } = harness({ lanes: [lane] })
  await recovery.handle(crash)
  assert.equal(recovery.isRecovering(), false)
  await recovery.handle({ reason: 'crashed', exitCode: 133 })
  assert.equal(calls.confirm.length, 2)
  assert.equal(calls.rebuild.length, 2)
})

test('the flag is cleared after a quit decision too', async () => {
  const { recovery } = harness({ confirm: async () => false })
  await recovery.handle(crash)
  assert.equal(recovery.isRecovering(), false)
})

test('the main window-all-closed callback skips quit drain during recovery and still handles normal closes', async () => {
  const main = await readFile(new URL('../src/desktop/main.ts', import.meta.url), 'utf8')
  const body = /app\.on\('window-all-closed', \(\) => \{([\s\S]*?)\n  \}\)/.exec(main)?.[1]
  assert.ok(body, 'exercise the callback registered by the real main entry')
  for (const platform of ['win32', 'linux', 'darwin']) {
    let drains = 0
    let exits = 0
    const quit = new QuitCoordinator({ teardown: async () => { drains++ }, release: () => { exits++ } })
    let onAllClosed!: () => void
    const { recovery } = harness({ rebuild: async () => {
      onAllClosed()
      assert.equal(quit.isQuitting(), false, `${platform}: replacing the dead last window is not a quit`)
    } })
    onAllClosed = vm.runInNewContext(`(() => {${body}\n})`, {
      process: { platform }, rendererRecovery: recovery,
      app: { quit: () => quit.onBeforeQuit() },
    }) as () => void
    await recovery.handle(crash)
    assert.equal(drains, 0)
    assert.equal(exits, 0)
    onAllClosed()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(drains, platform === 'darwin' ? 0 : 1)
    assert.equal(exits, platform === 'darwin' ? 0 : 1)
  }
})

test('an explicit quit while the recovery dialog is open drains once and never rebuilds', async () => {
  let confirm!: (value: boolean) => void
  const answer = new Promise<boolean>((resolve) => { confirm = resolve })
  let drains = 0
  let exits = 0
  let rebuilds = 0
  const quit = new QuitCoordinator({ teardown: async () => { drains++ }, release: () => { exits++ } })
  const recovery = new RendererRecovery({
    isQuitting: () => quit.isQuitting(), captureLanes: async () => [], confirm: () => answer,
    rebuild: async () => { rebuilds++ }, reportFailure: async () => 'quit', quit: () => quit.onBeforeQuit(),
  })
  const pending = recovery.handle(crash)
  await new Promise((resolve) => setImmediate(resolve))
  quit.onBeforeQuit()
  confirm(true)
  await pending
  assert.equal(rebuilds, 0)
  assert.equal(drains, 1)
  assert.equal(exits, 1)
})
