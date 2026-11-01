import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ComputerHost, ComputerRequest, ComputerResponse } from '../../runtime/protocol/computerHost.js'

export interface DesktopComputerOptions {
  nativeDir: string
  stateDir: string
}

/** One queue for the real desktop, with a separate native ref namespace per chat. */
export class DesktopComputerHost implements ComputerHost {
  private tail: Promise<unknown> = Promise.resolve()
  private readonly lifetime = new AbortController()

  constructor(private readonly options: DesktopComputerOptions) {}

  async run(request: ComputerRequest): Promise<ComputerResponse> {
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(Object.assign(new Error('Computer operation timed out.'), { code: 'ETIMEDOUT' })), request.timeoutMs)
    const signal = AbortSignal.any([
      this.lifetime.signal, deadline.signal,
      ...(request.signal === undefined ? [] : [request.signal]),
    ])
    const pending = this.tail.then(() => {
      signal.throwIfAborted()
      return this.execute(request, signal)
    })
    this.tail = pending.catch(() => {})
    // Reject queued calls promptly on stop/timeout, but keep their slot behind
    // the previous call so cancelling a waiter cannot let later calls overtake.
    try {
      return await abortable(pending, signal)
    } finally {
      clearTimeout(timer)
    }
  }

  dispose(): void {
    this.lifetime.abort(new Error('Computer host has closed.'))
  }

  private async execute(request: ComputerRequest, signal: AbortSignal): Promise<ComputerResponse> {
    const { nativeDir, stateDir } = this.options
    await mkdir(stateDir, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    const session = `hanekawa-${createHash('sha256').update(request.sessionId).digest('hex').slice(0, 48)}`
    const env = { ...process.env }
    // Do not inherit a user's CLI namespace, trace settings or helper override.
    for (const key of Object.keys(env)) if (key.startsWith('AGENT_DESKTOP_')) delete env[key]
    env.AGENT_DESKTOP_HOME = stateDir
    if (process.platform === 'darwin') env.AGENT_DESKTOP_MACOS_HELPER_PATH = join(nativeDir, 'agent-desktop-macos-helper')

    let captureDir: string | undefined
    try {
      const args = ['--session', session, ...(request.headed ? ['--headed'] : [])]
      if (request.command !== '') args.push(request.command)
      args.push(...request.args)
      if (request.command === 'screenshot') {
        captureDir = await mkdtemp(join(stateDir, 'capture-'))
        args.push(join(captureDir, 'screenshot.png'))
      }
      signal.throwIfAborted()
      const binary = join(nativeDir, process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop')
      const result = await runNative(binary, args, env, signal)
      if (request.args.length === 1 && request.args[0] === '--help') {
        return { envelope: { ok: true, command: 'help', data: { content: result.stdout } } }
      }
      let envelope: ComputerResponse['envelope']
      try {
        const parsed: unknown = JSON.parse(result.stdout)
        if (parsed === null || typeof parsed !== 'object' || typeof (parsed as { ok?: unknown }).ok !== 'boolean') {
          throw new Error('Missing ok field')
        }
        envelope = parsed as ComputerResponse['envelope']
      } catch {
        throw new Error(`The bundled agent-desktop returned invalid JSON${result.exitCode === undefined ? '' : ` (exit ${result.exitCode})`}.`)
      }
      if (captureDir && envelope.ok) {
        signal.throwIfAborted()
        const bytes = await readFile(join(captureDir, 'screenshot.png'))
        return { envelope, image: { bytes, name: 'desktop-screenshot.png' } }
      }
      return { envelope }
    } finally {
      if (captureDir) await rm(captureDir, { recursive: true, force: true })
    }
  }
}

function runNative(binary: string, args: string[], env: NodeJS.ProcessEnv, signal: AbortSignal): Promise<{ stdout: string; exitCode?: number }> {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { env, signal, encoding: 'utf8', windowsHide: true, maxBuffer: 8_000_000 }, (error, stdout) => {
      // Native errors use a nonzero exit status AND a JSON envelope. Keep that
      // envelope, especially its delivery evidence, instead of execFile's error.
      if (signal.aborted) { reject(signal.reason); return }
      if (error && typeof error.code !== 'number') { reject(error); return }
      resolve({ stdout, ...(typeof error?.code === 'number' ? { exitCode: error.code } : {}) })
    })
  })
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
