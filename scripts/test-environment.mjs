import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const exitCleanups = new Set()
let installed = false

/** Synchronous and LIFO: stop child processes before removing their files. */
export function onTestExit(cleanup) {
  if (!installed) {
    installed = true
    process.once('exit', () => {
      for (const cleanup of [...exitCleanups].reverse()) {
        try {
          cleanup()
        } catch (error) {
          console.error('Test cleanup failed:', error)
          process.exitCode = 2
        }
      }
    })
    for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) {
      process.once(signal, () => process.exit(code))
    }
  }
  exitCleanups.add(cleanup)
  return () => exitCleanups.delete(cleanup)
}

/** Only children launched in their own process group may be passed here. */
export function killTestProcess(pid) {
  if (!Number.isInteger(pid)) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', shell: false })
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try { process.kill(pid, 'SIGKILL') } catch { /* Already exited. */ }
  }
}

/** A private home and temp root, inherited only by the test's child processes. */
export function createTestEnvironment(prefix = 'hanekawa-test-', { keep = false } = {}) {
  // macOS's temp path is a symlink; runtime project keys use its real path.
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  const cleanup = () => {
    if (!keep) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
  const unregister = onTestExit(cleanup)
  const testHome = join(root, 'home')
  const temp = join(root, 'tmp')
  mkdirSync(testHome)
  mkdirSync(temp)
  return {
    root,
    home: testHome,
    // `HANEKAWA_TEST_HOME` is what `userHome()` looks for before it lets a test near `~/.hanekawa`.
    env: { ...process.env, HOME: testHome, USERPROFILE: testHome, TMPDIR: temp, TMP: temp, TEMP: temp, HANEKAWA_TEST_HOME: testHome },
    cleanup() {
      try {
        cleanup()
        unregister()
      } catch (error) {
        return error instanceof Error ? error.message : String(error)
      }
    },
  }
}
