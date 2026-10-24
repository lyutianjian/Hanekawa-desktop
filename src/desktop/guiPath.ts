/**
 * macOS GUI PATH repair.
 *
 * A Finder/Dock launch inherits launchd's bare PATH, and every child we start
 * (Bash, MCP servers, the editor) inherits `process.env`. One probe before the
 * first project bootstraps anything is therefore the whole fix.
 *
 * The probe prints PATH between marker lines and reads it with `/usr/bin/printenv`:
 * rc files print whatever they like, `$PATH` expansion differs per shell (fish
 * keeps a list), and only the value between the markers is a PATH to adopt.
 * `detached` makes the shell a group leader so a timeout can reap exactly the
 * processes this probe started. A leader can exit while a grandchild still
 * holds the pipe, so the reaper signals the whole process group rather than
 * waiting on the leader (which is why `terminateProcessTree` is not used here).
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

export const GUI_PATH_BEGIN_MARKER = '__HANEKAWA_GUI_PATH_BEGIN__'
export const GUI_PATH_END_MARKER = '__HANEKAWA_GUI_PATH_END__'

/** The rc files run too; a shell that is still waiting at this point is stuck. */
export const GUI_PATH_TIMEOUT_MS = 5_000

/** rc files can be noisy; past this much output the probe is not worth reading. */
export const GUI_PATH_MAX_OUTPUT_BYTES = 64 * 1024

/** Real macOS PATHs are a few hundred bytes. */
export const GUI_PATH_MAX_LENGTH = 16 * 1024

export type GuiPathFailure =
  | 'spawn-failed'
  | 'timeout'
  | 'output-too-long'
  | 'invalid-output'
  | 'shell-failed'

export type GuiPathResult =
  | { status: 'not-applicable' }
  | { status: 'applied'; path: string }
  | { status: 'failed'; reason: GuiPathFailure; detail?: string }

export type SpawnProbe = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess

export interface RestoreGuiPathOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  /** Test seams; production uses the login shell and the real group reaper. */
  shell?: string
  spawnProbe?: SpawnProbe
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * `TERM`/`TERM_PROGRAM` are the only in-process evidence of a terminal launch.
 * Guessing "GUI" wrongly only costs one login shell whose PATH is already the
 * terminal's; guessing "terminal" wrongly leaves the bug in place.
 */
export function isGuiLaunch(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'darwin' && env.TERM === undefined && env.TERM_PROGRAM === undefined
}

/** Resolves the GUI PATH and, on success, writes it to `env.PATH`. Never rejects. */
export function restoreGuiPath(options: RestoreGuiPathOptions = {}): Promise<GuiPathResult> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (!isGuiLaunch(platform, env)) return Promise.resolve({ status: 'not-applicable' })

  const shell = options.shell ?? loginShell(env)
  if (shell === undefined) {
    return Promise.resolve({ status: 'failed', reason: 'spawn-failed', detail: '找不到可用的登录 shell' })
  }

  const spawnProbe = options.spawnProbe ?? (nodeSpawn as unknown as SpawnProbe)
  const timeoutMs = options.timeoutMs ?? GUI_PATH_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? GUI_PATH_MAX_OUTPUT_BYTES

  return new Promise<GuiPathResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let bytes = 0
    let output = ''
    const decoder = new StringDecoder('utf8')

    const finish = (result: GuiPathResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (result.status === 'applied') env.PATH = result.path
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawnProbe(shell, ['-l', '-i', '-c', PROBE_COMMAND], {
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env,
      })
    } catch (error) {
      resolve({ status: 'failed', reason: 'spawn-failed', detail: describeError(error) })
      return
    }

    const stdout = child.stdout
    let cleaned = false
    let reaping: Promise<boolean> | undefined

    const cleanup = (): void => {
      if (cleaned) return
      cleaned = true
      stdout?.removeListener('data', onData)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      if (stdout !== null && typeof (stdout as { destroy?: unknown }).destroy === 'function' && !stdout.destroyed) {
        stdout.destroy()
      }
      if (typeof child.unref === 'function') child.unref()
    }

    const reap = (): void => {
      reaping ??= reapProbeGroup(child).finally(cleanup)
      void reaping.catch(() => undefined)
    }

    const onData = (chunk: Buffer | string): void => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      if (bytes + buffer.length > maxOutputBytes) {
        finish({ status: 'failed', reason: 'output-too-long' })
        reap()
        return
      }
      bytes += buffer.length
      output += decoder.write(buffer)
    }

    const onError = (error: unknown): void => {
      finish({ status: 'failed', reason: 'spawn-failed', detail: describeError(error) })
      reap()
    }

    const onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) {
        reap()
        return
      }
      output += decoder.end()
      if (code !== 0 || signal !== null) {
        finish({ status: 'failed', reason: 'shell-failed', detail: describeExit(code, signal) })
      } else {
        const path = parseProbeOutput(output)
        finish(
          path === undefined
            ? { status: 'failed', reason: 'invalid-output' }
            : { status: 'applied', path },
        )
      }
      // Whatever the login shell left behind belongs to this probe, not the app.
      reap()
    }

    timer = setTimeout(() => {
      finish({ status: 'failed', reason: 'timeout' })
      reap()
    }, timeoutMs)

    stdout?.on('data', onData)
    child.once('error', onError)
    child.once('close', onClose)
  })
}

/**
 * Kills the probe's process group, bounded. Returns whether the group is gone.
 *
 * `process.kill(-pgid, 0)` is the liveness test: the leader may already have
 * exited while a grandchild still belongs to the group, and `ChildProcess`'s
 * own exit state cannot see that. TERM gets a grace period for well-behaved
 * descendants, then KILL; both are scoped to this probe's group.
 */
export async function reapProbeGroup(
  child: ChildProcess,
  options: { graceMs?: number; pollMs?: number } = {},
): Promise<boolean> {
  const pid = child.pid
  if (process.platform === 'win32' || pid === undefined) {
    try {
      child.kill('SIGKILL')
    } catch {
      // Already gone.
    }
    return true
  }
  const graceMs = options.graceMs ?? 250
  const pollMs = options.pollMs ?? 25
  if (!groupAlive(pid)) return true
  signalGroup(pid, 'SIGTERM')
  if (await waitGroupGone(pid, graceMs, pollMs)) return true
  signalGroup(pid, 'SIGKILL')
  return waitGroupGone(pid, graceMs, pollMs)
}

function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal)
  } catch {
    // The group exited between the liveness check and the signal.
  }
}

async function waitGroupGone(pgid: number, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (groupAlive(pgid)) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return true
}

/** `printenv` on an exported PATH, because each shell joins `$PATH` its own way. */
const PROBE_COMMAND =
  `printf '\\n%s\\n' '${GUI_PATH_BEGIN_MARKER}'; `
  + `/usr/bin/printenv PATH; `
  + `printf '%s\\n' '${GUI_PATH_END_MARKER}'`

function loginShell(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.SHELL?.trim()
  if (configured) return configured
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => existsSync(candidate))
}

/** One non-empty line between the markers; anything else is rc noise. */
function parseProbeOutput(output: string): string | undefined {
  const lines = output.split(/\r?\n/)
  const start = lines.indexOf(GUI_PATH_BEGIN_MARKER)
  if (start < 0) return undefined
  const end = lines.indexOf(GUI_PATH_END_MARKER, start + 1)
  if (end !== start + 2) return undefined
  const value = lines[start + 1] ?? ''
  if (value.length === 0 || value.length > GUI_PATH_MAX_LENGTH || value.includes('\0')) return undefined
  return value
}

function describeExit(code: number | null, signal: NodeJS.Signals | null): string {
  return code !== null ? `exit ${code}` : `signal ${signal ?? 'unknown'}`
}

function describeError(error: unknown): string {
  const text = error instanceof Error
    ? [(error as NodeJS.ErrnoException).code, error.message].filter(Boolean).join(': ')
    : String(error)
  return text.slice(0, 200)
}
