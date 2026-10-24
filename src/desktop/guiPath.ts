/**
 * The macOS GUI PATH repair.
 *
 * A Finder/Dock launch inherits launchd's bare PATH (`/usr/bin:/bin:/usr/sbin:/sbin`),
 * so `npx`, `rg`, `brew`, `node` and the editor's `code` command are all missing
 * from every child the app starts. Nothing else in the app can fix that per
 * call: `Bash` already runs `$SHELL -c`, MCP spawns its own servers, and the
 * editor is a detached `code`. So the repair happens once, before the first
 * project bootstraps any of them, and every later child inherits the result
 * through `process.env.PATH`.
 *
 * The probe runs the user's own login *and* interactive shell — `.zprofile` and
 * `.zshrc` both matter on macOS — and reads PATH back with `/usr/bin/printenv`.
 * Echoing `$PATH` from the shell itself would be wrong for fish (a list) and
 * binds the probe to one shell's expansion rules; the exported value is exactly
 * what every child will receive.
 *
 * Three properties keep this from becoming a startup hazard:
 *  - boundaries: the value is printed between two marker lines, and anything an
 *    rc file prints outside them is ignored rather than parsed as PATH;
 *  - limits: output is capped by bytes and the parsed value by length;
 *  - a deadline: the probe is its own process-group leader, so a shell waiting
 *    for input can be reaped together with what its rc started, and nothing
 *    else. Failure always leaves the original PATH in place.
 *
 * macOS only, and only for a launch with no terminal behind it. Windows and
 * Linux already get their PATH from the launcher, and a terminal launch always
 * has the right one.
 */
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { terminateProcessTree } from '../services/backgroundTasks/processTree.js'

/** Line markers the probe prints around the value; rc noise outside is ignored. */
export const GUI_PATH_BEGIN_MARKER = '__HANEKAWA_GUI_PATH_BEGIN__'
export const GUI_PATH_END_MARKER = '__HANEKAWA_GUI_PATH_END__'

/** The whole probe — rc files included — gets this long before it is reaped. */
export const GUI_PATH_TIMEOUT_MS = 5_000

/** A shell that writes more than this is not a PATH probe worth waiting for. */
export const GUI_PATH_MAX_OUTPUT_BYTES = 64 * 1024

/** macOS PATHs are a few hundred bytes; a megabyte of them is something else. */
export const GUI_PATH_MAX_LENGTH = 16 * 1024

export type GuiPathFailure = 'spawn-failed' | 'timeout' | 'output-too-long' | 'invalid-output'

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
  /** The environment to read from and, on success, to update. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
  /** Test seams; production uses the real login shell and process-tree killer. */
  shell?: string
  spawnProbe?: SpawnProbe
  terminateTree?: (child: ChildProcess) => Promise<void>
  timeoutMs?: number
  maxOutputBytes?: number
}

/**
 * `TERM`/`TERM_PROGRAM` are the only in-process evidence of a terminal launch:
 * Electron exposes no "launched by launchd" flag. A wrong "GUI" guess only
 * costs one login shell whose PATH is the same one the terminal already had;
 * a wrong "terminal" guess is the bug, so the test errs towards GUI.
 */
export function isGuiLaunch(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return platform === 'darwin' && env.TERM === undefined && env.TERM_PROGRAM === undefined
}

/**
 * Resolves the GUI PATH and, on success, writes it to `env.PATH`.
 *
 * Never rejects: a failure is a result, so a startup that cannot repair PATH
 * continues on the launch environment instead of failing to open a window.
 */
export function restoreGuiPath(options: RestoreGuiPathOptions = {}): Promise<GuiPathResult> {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (!isGuiLaunch(platform, env)) return Promise.resolve({ status: 'not-applicable' })

  const shell = options.shell ?? loginShell(env)
  if (shell === undefined) {
    return Promise.resolve({ status: 'failed', reason: 'spawn-failed', detail: '找不到可用的登录 shell' })
  }

  const spawnProbe = options.spawnProbe ?? (nodeSpawn as unknown as SpawnProbe)
  const terminateTree = options.terminateTree ?? terminateProcessTree
  const timeoutMs = options.timeoutMs ?? GUI_PATH_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? GUI_PATH_MAX_OUTPUT_BYTES

  return new Promise<GuiPathResult>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let output = ''

    const finish = (result: GuiPathResult): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      // The one write the whole module exists for: every tool, MCP server and
      // editor spawned afterwards inherits it.
      if (result.status === 'applied') env.PATH = result.path
      resolve(result)
    }

    let child: ChildProcess
    try {
      child = spawnProbe(shell, ['-l', '-i', '-c', PROBE_COMMAND], {
        // Its own group, so the timeout can reap the shell and its rc children
        // without reaching into the app's other children.
        detached: platform !== 'win32',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
        env,
      })
    } catch (error) {
      resolve({ status: 'failed', reason: 'spawn-failed', detail: describeError(error) })
      return
    }

    const reap = (): void => {
      try {
        void terminateTree(child).catch(() => undefined)
      } catch {
        // It exited between the state check and the signal.
      }
    }

    timer = setTimeout(() => {
      finish({ status: 'failed', reason: 'timeout' })
      reap()
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (settled) return
      output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)
      if (Buffer.byteLength(output) > maxOutputBytes) {
        finish({ status: 'failed', reason: 'output-too-long' })
        reap()
      }
    })

    child.once('error', (error) => {
      finish({ status: 'failed', reason: 'spawn-failed', detail: describeError(error) })
    })

    child.once('close', () => {
      const path = parseProbeOutput(output)
      finish(
        path === undefined
          ? { status: 'failed', reason: 'invalid-output' }
          : { status: 'applied', path },
      )
    })
  })
}

/**
 * `printenv` rather than `$PATH`, and absolute rather than looked up: the
 * launch PATH is exactly what may be missing `/usr/bin`. The leading newline
 * splits the marker from an rc line that did not end with one.
 */
const PROBE_COMMAND =
  `printf '\\n%s\\n' '${GUI_PATH_BEGIN_MARKER}'; `
  + `/usr/bin/printenv PATH; `
  + `printf '%s\\n' '${GUI_PATH_END_MARKER}'`

/** The login shell to probe: `$SHELL`, then the macOS defaults. */
function loginShell(env: NodeJS.ProcessEnv): string | undefined {
  const configured = env.SHELL?.trim()
  if (configured) return configured
  return ['/bin/zsh', '/bin/bash', '/bin/sh'].find((candidate) => existsSync(candidate))
}

/**
 * The value between the markers, and only a value that is one non-empty line.
 * Anything else — no markers, a missing value, rc noise inside the markers — is
 * not a PATH this app is willing to adopt.
 */
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

function describeError(error: unknown): string {
  const text = error instanceof Error
    ? [(error as NodeJS.ErrnoException).code, error.message].filter(Boolean).join(': ')
    : String(error)
  return text.slice(0, 200)
}