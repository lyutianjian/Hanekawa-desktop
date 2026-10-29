import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { Buffer } from 'node:buffer'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../../harness/types.js'
import {
  BackgroundTaskRegistry,
  defaultBackgroundTaskRegistry,
  type BackgroundTaskSnapshot,
} from '../../services/backgroundTasks/registry.js'
import { terminateProcessTree } from '../processTree.js'
import {
  DEFAULT_BASH_TIMEOUT_MS,
  SLEEP_BLOCK_THRESHOLD_SECONDS,
  resolveBashTimeoutMs,
} from './constants.js'
import { buildBashDescription } from './prompt.js'
import { extractBashWritePaths } from './writeTargets.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { getToolResultSpillDir } from '../../utils/paths.js'

// Re-exported so existing importers of these names keep working; the values
// live in bashConstants.ts because bashPrompt.ts quotes them.
export {
  DEFAULT_BASH_TIMEOUT_MS,
  SLEEP_BLOCK_THRESHOLD_SECONDS,
  resolveBashTimeoutMs,
} from './constants.js'

interface BashInput {
  command: string
  timeout?: number
  run_in_background?: boolean
  env?: Record<string, string | number | boolean>
  description?: string
}

/**
 * Sensitive environment variables scrubbed from child shell processes to prevent
 * prompt injection from exfiltrating credentials. Off by default: locally the same
 * credentials are what legitimate CLIs (`aws`) read, and deleting them silently
 * breaks them. Turn it on for untrusted contexts (CI running foreign code).
 */
export const SUBPROCESS_ENV_SCRUB_VAR = 'HANEKAWA_SUBPROCESS_ENV_SCRUB'

export const SENSITIVE_ENV_VARS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'MISTRAL_API_KEY',
  'COHERE_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
])

const IPV4_FIRST_FLAG = '--dns-result-order=ipv4first'

export function buildSubprocessEnv(
  customEnv?: Record<string, string | number | boolean>,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv }

  const scrubFlag = env[SUBPROCESS_ENV_SCRUB_VAR]
  if (scrubFlag && scrubFlag !== '0' && scrubFlag !== 'false') {
    for (const key of SENSITIVE_ENV_VARS) {
      delete env[key]
    }
  }

  // Prevent git from launching an interactive editor (which hangs on closed stdin)
  env.GIT_EDITOR = 'true'
  env.GIT_SEQUENCE_EDITOR = 'true'

  if (customEnv) {
    for (const [key, value] of Object.entries(customEnv)) {
      if (value !== undefined && value !== null) {
        env[key] = String(value)
      }
    }
  }

  // Windows resolves `localhost` to ::1 first (Node's verbatim default), so a node
  // dev server binds an address the machine's own loopback may not carry. Prefer
  // IPv4 without clobbering whatever NODE_OPTIONS the user or caller already set.
  if (platform === 'win32' && !(env.NODE_OPTIONS ?? '').includes(IPV4_FIRST_FLAG)) {
    env.NODE_OPTIONS = [env.NODE_OPTIONS, IPV4_FIRST_FLAG].filter(Boolean).join(' ')
  }

  return env
}

interface ShellInfo {
  shell: string
  args: (cmd: string) => string[]
}

function detectShell(): ShellInfo {
  if (process.platform !== 'win32') {
    return { shell: process.env.SHELL ?? 'bash', args: (cmd) => ['-c', cmd] }
  }

  // 0. Explicit override always wins on every platform.
  const overridePath = process.env.MYAGENT_BASH_PATH
  if (overridePath && existsSync(overridePath)) {
    return { shell: overridePath, args: (cmd) => ['-c', cmd] }
  }

  // Windows: prefer bash (Git for Windows / WSL) over PowerShell
  // 1. Check SHELL env var
  const envShell = process.env.SHELL
  if (envShell && envShell !== 'powershell' && envShell !== 'cmd') {
    return { shell: envShell, args: (cmd) => ['-c', cmd] }
  }

  // 2. Check common Git for Windows bash location
  const gitBashPaths = [
    'C:/Program Files/Git/bin/bash.exe',
    'C:/Program Files (x86)/Git/bin/bash.exe',
    `${process.env.ProgramFiles ?? ''}/Git/bin/bash.exe`,
    `${process.env['ProgramFiles(x86)'] ?? ''}/Git/bin/bash.exe`,
  ]
  for (const p of gitBashPaths) {
    if (p && existsSync(p)) {
      return { shell: p, args: (cmd) => ['-c', cmd] }
    }
  }

  // 3. Check if bash is on PATH. spawnSync can block the event loop, but we
  //    only ever run this lazily on the first bash tool execution, never at
  //    module load, so it cannot stall TUI startup.
  try {
    const result = spawnSync('bash', ['--version'], { timeout: 3000, stdio: 'pipe', windowsHide: true })
    if (result.status === 0) {
      return { shell: 'bash', args: (cmd) => ['-c', cmd] }
    }
  } catch { /* bash not available */ }

  // 4. Fall back to PowerShell
  return { shell: 'powershell', args: (cmd) => ['-Command', cmd] }
}

// Lazily resolved shell info. Detection is deferred until the first bash
// tool execution so we never run synchronous probes (existsSync chain or
// spawnSync) during module load and block TUI startup.
let cachedShell: ShellInfo | undefined

export function getShell(): ShellInfo {
  if (!cachedShell) {
    cachedShell = detectShell()
  }
  return cachedShell
}

// Test-only hook: lets tests reset the cache between runs without leaking
// detection state across cases. Not part of the public Tool surface.
export function _resetCachedShellForTests(): void {
  cachedShell = undefined
}

/**
 * The shell the `Bash` tool will actually use, named for the prompt's
 * `# Environment` block.
 *
 * The environment block used to derive its own answer (`process.env.SHELL ??
 * (win32 ? 'powershell' : 'bash')`) and on Windows that was simply false: the
 * tool prefers Git for Windows' `bash.exe` and only falls back to PowerShell
 * when no bash exists, so the model was told `powershell` and wrote `NUL`,
 * `%VAR%` and backslash paths into a POSIX shell. One detection, one answer.
 *
 * It runs `getShell()`, so the first prompt build pays the same lazy probe the
 * first tool call would have — never at module load.
 */
export function describeShell(platform: NodeJS.Platform = process.platform): string {
  const lower = getShell().shell.toLowerCase().replace(/\\/g, '/')
  if (lower.includes('powershell')) return 'powershell'
  if (lower.endsWith('cmd') || lower.endsWith('cmd.exe')) return 'cmd'
  const base = lower.split('/').pop() ?? lower
  const name = base.endsWith('.exe') ? base.slice(0, -4) : base
  // A POSIX shell on a Windows filesystem is the one combination worth spelling
  // out: the platform line right above this one says `win32`, and on its own
  // that reads as "use Windows syntax" — `NUL`, `%VAR%`, backslash paths. The
  // path is no help in saying so (Git Bash exports `SHELL=/bin/bash.exe`), so
  // the pairing is what names it.
  // Anything reaching here is spawned with `-c`, so it *is* a POSIX shell.
  if (platform === 'win32') return `${name} (POSIX shell on Windows)`
  // The tool calls itself Bash, so bash-only test syntax is the usual slip.
  if (name === 'zsh') return 'zsh (not bash: `[ a == b ]` is an error in zsh, use `=`)'
  return name
}

/**
 * Detect a standalone blocking sleep pattern at the start of a command.
 * Returns the sleep duration in seconds if found, or null otherwise.
 *
 * Matches:
 *   - `sleep N` (standalone)
 *   - `sleep N && ...` (sleep as the first command in a chain)
 *   - `sleep N || ...` (sleep as the first command in an OR chain)
 *   - `sleep N; ...` (sleep followed by semicolon)
 *   - `sleep N | ...` (sleep as the first command in a pipe)
 *   - `sleep N # comment` (sleep with shell comment)
 *
 * Does NOT match:
 *   - `sleep 0.5` (below threshold)
 *   - `for i in 1 2; do sleep 1; done` (sleep inside compound command)
 *   - `echo hello && sleep 5` (sleep not at the start)
 */
export function detectSleepPattern(command: string): number | null {
  const trimmed = command.trim()
  // Match: "sleep", whitespace, number (int or float),
  // then end-of-string or whitespace followed by shell operators (&&, ||, ;, |) or comment (#)
  const match = trimmed.match(/^sleep\s+(\d+(?:\.\d+)?)\s*(?:$|&&|\|\||[;|#])/)
  if (!match) return null

  const seconds = parseFloat(match[1]!)
  if (isNaN(seconds) || seconds < SLEEP_BLOCK_THRESHOLD_SECONDS) return null
  return seconds
}

const DEV_SERVER_PATTERN = /(?:^|[\s;&|])(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:dev|preview)|(?:npx\s+)?vite|(?:next|nuxt|astro)\s+dev)(?:$|[\s;&|])/

/**
 * A dev server bound to a fixed port refuses to share it: a second one silently
 * hops to the next port and the user's bookmarked URL stops answering. Detect
 * the usual suspects so an identical re-run can retire its predecessor first.
 */
export function isDevServerCommand(command: string): boolean {
  return DEV_SERVER_PATTERN.test(command.trim())
}

/**
 * Commands that should hard-timeout instead of auto-backgrounding.
 * Aligns with Claude Code: only bare leading `sleep` is excluded from auto-bg.
 * Explicit run_in_background still allowed for sleep via the pre-check path.
 */
export function isAutobackgroundingAllowed(command: string): boolean {
  const trimmed = command.trim()
  // First shell word is sleep (path-qualified ok: /bin/sleep)
  const first = trimmed.split(/[\s;|&]/)[0] ?? ''
  const base = first.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? ''
  return base !== 'sleep'
}

function formatBackgroundStartMessage(
  task: BackgroundTaskSnapshot,
  kind: 'explicit' | 'timeout' | 'user',
  blockedMs?: number,
): string {
  const header = {
    explicit: 'Shell started in background.',
    timeout: `Command was still running after ${blockedMs}ms and was moved to the background.`,
    user: 'The user sent a message while this command was running, so it was moved to the background.',
  }[kind]
  return [
    header,
    `Task ID: ${task.id}`,
    ...(task.pid ? [`PID: ${task.pid}`] : []),
    ...(task.outputPath ? [`Output is being written to ${task.outputPath}; Read it to check progress.`] : []),
    'You will be notified when it finishes, with the last lines of its output. Do not poll: continue with other work, or end your turn if nothing else is left.',
    `Stop it with KillShell (task_id "${task.id}").`,
  ].join('\n')
}

export function attachBackgroundLifecycle(options: {
  proc: ChildProcess
  backgroundTasks: BackgroundTaskRegistry
  sessionId: string
  taskId: string
  /** Optional hard-kill timeout for background shells (explicit BG only). */
  killAfterMs?: number
  /** Stdout lines are also the task's monitor events. */
  monitor?: boolean
}): void {
  const { proc, backgroundTasks, sessionId, taskId, killAfterMs, monitor } = options
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  if (killAfterMs !== undefined) {
    timeoutId = setTimeout(() => {
      void backgroundTasks.killShell(
        sessionId,
        taskId,
        `Command timed out after ${killAfterMs}ms`,
        true,
      )
    }, killAfterMs)
  }

  const onData = (data: Buffer) => backgroundTasks.appendOutput(sessionId, taskId, data)
  proc.stdout?.on('data', onData)
  proc.stderr?.on('data', onData)
  if (monitor) proc.stdout?.on('data', (data: Buffer) => backgroundTasks.appendMonitorStdout(sessionId, taskId, data))

  // Use 'exit' not 'close': 'close' waits for stdio to close, which can
  // include grandchild processes that inherit file descriptors.
  // Grandchildren inheriting the pipes can hold 'close' off indefinitely, so
  // 'exit' ends the task, after a short wait for the last lines still in the pipes.
  proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
    if (timeoutId) clearTimeout(timeoutId)
    const finish = () => {
      clearTimeout(grace)
      backgroundTasks.finishShell(sessionId, taskId, code, signal)
    }
    const grace = setTimeout(finish, 250)
    proc.once('close', finish)
  })
  proc.once('close', () => backgroundTasks.closeOutput(sessionId, taskId))
  proc.once('error', (error: Error) => {
    if (timeoutId) clearTimeout(timeoutId)
    backgroundTasks.fail(sessionId, taskId, error.message)
  })
}

export function createBashTool(backgroundTasks: BackgroundTaskRegistry = defaultBackgroundTaskRegistry): Tool {
  return {
  name: 'Bash',
  description: buildBashDescription(),
  searchHint: 'run shell commands terminal',
  inputSchema: z.object({
    command: z.string().min(1).describe('The shell command to execute. Chain dependent steps with && rather than newlines.'),
    timeout: z.number().min(1).optional()
      .describe(`Optional timeout in milliseconds (default ${DEFAULT_BASH_TIMEOUT_MS}, no maximum). On timeout, non-sleep commands are moved to the background.`),
    run_in_background: z.boolean().optional()
      .describe('Set to true to run this command in the background immediately. Its output goes to a file you can Read, and you are notified when it finishes.'),
    env: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
      .describe('Optional environment variables to set for this command execution.'),
    description: z.string().optional()
      .describe('Clear, concise description of what this command does, in active voice. Shown to the user when approving the command.'),
  }).strict(),
  riskLevel: 'dangerous',
  isDestructive: true,
  concurrentWhenReadonly: true,
  maxResultSizeChars: 100_000,
  userFacingName: () => 'Bash',
  getToolUseSummary(input) {
    const command = typeof input === 'object' && input !== null
      ? (input as { command?: unknown }).command
      : undefined
    return typeof command === 'string' ? summarizeCommand(command) : null
  },
  getActivityDescription(input) {
    const { command, description } = typeof input === 'object' && input !== null
      ? input as { command?: unknown; description?: unknown }
      : {}
    if (typeof description === 'string' && description.trim()) return description
    return typeof command === 'string' ? `Running ${summarizeCommand(command)}` : 'Running command'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as BashInput
    const timeout = resolveBashTimeoutMs(options.timeout)

    // Block standalone sleep commands unless run_in_background is set.
    const sleepSeconds = detectSleepPattern(options.command)
    if (sleepSeconds !== null && !options.run_in_background) {
      return {
        ok: false,
        content: `Blocking sleep command (${sleepSeconds}s) detected. Use \`run_in_background: true\` for long-running commands, or restructure to avoid blocking the conversation.`,
        errorCode: 'precondition_failed',
        errorDetails: { sleepSeconds },
      }
    }

    const { shell, args: shellArgs } = getShell()
    const spawnEnv = buildSubprocessEnv(options.env)

    // Back up the files this command is about to overwrite, before it runs.
    // Parsing is best effort and never gates execution: an unrecognised
    // command runs exactly as before, only without file-history coverage.
    for (const target of extractBashWritePaths(options.command, context.cwd)) {
      await trackFileEdit(context, target)
    }

    if (options.run_in_background) {
      if (isDevServerCommand(options.command)) {
        await backgroundTasks.killShellsByCommand(context.sessionId, options.command, 'Restarted by a newer dev server run')
      }
      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      })
      const task = backgroundTasks.registerShell({
        sessionId: context.sessionId,
        command: options.command,
        proc,
        outputDir: getToolResultSpillDir(context.projectDir ?? context.cwd, context.sessionId),
      })
      // Explicit BG: only install a kill timer when the caller set timeout.
      attachBackgroundLifecycle({
        proc,
        backgroundTasks,
        sessionId: context.sessionId,
        taskId: task.id,
        ...(options.timeout !== undefined ? { killAfterMs: resolveBashTimeoutMs(options.timeout) } : {}),
      })
      return {
        ok: true,
        content: formatBackgroundStartMessage(task, 'explicit'),
        metadata: {
          display: {
            summary: `background shell ${task.id} started`,
            detail: task.pid ? `PID: ${task.pid}` : undefined,
          },
        },
      }
    }

    return new Promise<ToolResult>((resolve) => {
      // Do not pass abortSignal to spawn: after timeout auto-background we must
      // keep the process alive when the tool call is aborted/settled. We handle
      // abort manually while still in foreground mode.
      const proc = spawn(shell, shellArgs(options.command), {
        cwd: context.cwd,
        // detached: true creates a new process group so we can kill all
        // child processes on timeout, not just the direct child.
        detached: process.platform !== 'win32',
        windowsHide: true,
        // Ignore stdin so interactive readers (cat/read/rg) do not hang waiting
        // for input that will never arrive.
        stdio: ['ignore', 'pipe', 'pipe'],
        env: spawnEnv,
      })

      const MAX_OUTPUT_BYTES = 1_000_000
      const stdoutChunks: Buffer[] = []
      const stderrChunks: Buffer[] = []
      let stdoutBytes = 0
      let stderrBytes = 0
      let truncated = false
      let timedOut = false
      let settled = false
      let mode: 'foreground' | 'backgrounded' = 'foreground'
      let timeoutId: ReturnType<typeof setTimeout> | undefined
      const autoBgAllowed = isAutobackgroundingAllowed(options.command)
      let unregisterForeground: (() => void) | undefined

      const buildOutput = (extra?: string): string => {
        // Decode accumulated Buffer chunks as UTF-8 in one shot to avoid
        // multi-byte character corruption at chunk boundaries.
        const stdout = Buffer.concat(stdoutChunks).toString('utf8')
        const stderr = Buffer.concat(stderrChunks).toString('utf8')
        const output = [stdout, stderr, extra].filter(Boolean).join('\n')
        const suffix = truncated ? '\n\n[Output truncated: exceeded 1MB limit]' : ''
        return (output || '(no output)') + suffix
      }

      const destroyStdio = () => {
        try { proc.stdout?.destroy() } catch { /* already closed */ }
        try { proc.stderr?.destroy() } catch { /* already closed */ }
      }

      const finish = (result: ToolResult, options?: { keepStdio?: boolean }) => {
        if (settled) return
        settled = true
        if (timeoutId !== undefined) clearTimeout(timeoutId)
        unregisterForeground?.()
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', onAbort)
        }
        if (!options?.keepStdio) destroyStdio()
        resolve(result)
      }

      const onAbort = () => {
        if (mode !== 'foreground' || settled) return
        void terminateProcessTree(proc).finally(() => {
          finish({
            ok: false,
            content: 'Operation cancelled by user',
            errorCode: 'aborted',
          })
        })
      }

      const onStdout = (data: Buffer) => {
        if (mode !== 'foreground') return
        if (stdoutBytes < MAX_OUTPUT_BYTES) {
          stdoutChunks.push(data)
          stdoutBytes += data.length
          if (stdoutBytes > MAX_OUTPUT_BYTES) truncated = true
        }
      }

      const onStderr = (data: Buffer) => {
        if (mode !== 'foreground') return
        if (stderrBytes < MAX_OUTPUT_BYTES) {
          stderrChunks.push(data)
          stderrBytes += data.length
          if (stderrBytes > MAX_OUTPUT_BYTES) truncated = true
        }
      }

      const promoteToBackground = (kind: 'timeout' | 'user'): void => {
        if (settled || mode !== 'foreground') return
        mode = 'backgrounded'
        // Stop foreground abort from killing the promoted process.
        if (context.abortSignal) {
          context.abortSignal.removeEventListener('abort', onAbort)
        }
        proc.stdout?.removeListener('data', onStdout)
        proc.stderr?.removeListener('data', onStderr)

        const task = backgroundTasks.registerShell({
          sessionId: context.sessionId,
          command: options.command,
          proc,
          outputDir: getToolResultSpillDir(context.projectDir ?? context.cwd, context.sessionId),
        })

        // The output file starts with what the foreground call already collected.
        if (stdoutChunks.length > 0) {
          backgroundTasks.appendOutput(context.sessionId, task.id, Buffer.concat(stdoutChunks))
        }
        if (stderrChunks.length > 0) {
          backgroundTasks.appendOutput(context.sessionId, task.id, Buffer.concat(stderrChunks))
        }

        // No kill timer on auto-bg — process may run until KillShell / session stop.
        attachBackgroundLifecycle({
          proc,
          backgroundTasks,
          sessionId: context.sessionId,
          taskId: task.id,
        })

        finish({
          ok: true,
          content: formatBackgroundStartMessage(task, kind, timeout),
          metadata: {
            display: {
              summary: `background shell ${task.id} (${kind === 'user' ? 'moved by user' : 'timeout'})`,
              detail: task.pid ? `PID: ${task.pid}` : undefined,
            },
          },
        }, { keepStdio: true })
      }

      timeoutId = setTimeout(() => {
        if (settled || mode !== 'foreground') return
        timedOut = true

        if (autoBgAllowed) {
          // Same process keeps running; only the tool call returns early.
          promoteToBackground('timeout')
          return
        }

        // Hard timeout (e.g. leading sleep that slipped past the pre-check).
        void terminateProcessTree(proc).finally(() => {
          finish({
            ok: false,
            content: buildOutput(),
            errorCode: 'timeout',
            errorDetails: { timeoutMs: timeout },
          })
        })
      }, timeout)
      unregisterForeground = backgroundTasks.registerForeground(
        context.sessionId,
        () => promoteToBackground('user'),
      )

      if (context.abortSignal) {
        if (context.abortSignal.aborted) {
          onAbort()
        } else {
          context.abortSignal.addEventListener('abort', onAbort, { once: true })
        }
      }

      proc.stdout?.on('data', onStdout)
      proc.stderr?.on('data', onStderr)

      // Use 'exit' not 'close': 'close' waits for stdio to close, which includes
      // grandchild processes that inherit file descriptors (e.g. nested sleep).
      // 'exit' fires when the shell itself exits, returning control immediately.
      proc.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
        if (mode === 'backgrounded') {
          // Lifecycle is owned by the registry after promote.
          return
        }

        const content = buildOutput()

        if (timedOut) {
          finish({
            ok: false,
            content,
            errorCode: 'timeout',
            errorDetails: { timeoutMs: timeout, signal },
          })
          return
        }

        if (code !== 0) {
          finish({
            ok: false,
            content,
            errorCode: 'command_failed',
            errorDetails: { exitCode: code, signal },
          })
          return
        }

        finish({ ok: true, content })
      })

      proc.once('error', (err: Error) => {
        if (mode === 'backgrounded') return
        if (err.name === 'AbortError') {
          finish({ ok: false, content: 'Operation cancelled by user', errorCode: 'aborted' })
        } else {
          finish({
            ok: false,
            content: buildOutput(err.message),
            errorCode: 'execution_failed',
          })
        }
      })
    })
  },
  }
}

export const bashTool: Tool = createBashTool()

function summarizeCommand(command: string): string {
  const trimmed = command.trim()
  const lines = trimmed.split(/\r?\n/)
  const visible = lines.slice(0, 2).join('\n')
  const suffix = lines.length > 2 ? '...' : ''
  return truncateMiddle(`${visible}${suffix}`, 120)
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
