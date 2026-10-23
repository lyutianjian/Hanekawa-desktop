import { spawn } from 'node:child_process'
import picomatch from 'picomatch'
import type { Tool, ToolContext } from './types.js'

const DEFAULT_HOOK_TIMEOUT_MS = 30_000
const MAX_HOOK_OUTPUT_BYTES = 200_000

export interface HookCommand {
  matcher?: string
  command: string
  timeoutMs?: number
}

export interface Hooks {
  userPromptSubmit?: HookCommand[]
  preToolUse?: HookCommand[]
  /**
   * Fires for every emitted tool_result, regardless of result.ok. This includes
   * denied, invalid, and preToolUse-blocked calls; hooks can filter via result.
   */
  postToolUse?: HookCommand[]
  preCompact?: HookCommand[]
  postCompact?: HookCommand[]
  subagentStart?: HookCommand[]
  subagentStop?: HookCommand[]
  stop?: HookCommand[]
}

export type LifecycleHookName =
  | 'userPromptSubmit'
  | 'postToolUse'
  | 'preCompact'
  | 'postCompact'
  | 'subagentStart'
  | 'subagentStop'
  | 'stop'

export type PreToolUseHook = HookCommand
export type ToolHooks = Hooks

export interface PreToolUseHookResult {
  ok: boolean
  content?: string
  details?: unknown
  stdout?: string
}

export interface LifecycleHookOutput {
  stdout: string
  failures: string[]
  blockingErrors: string[]
  preventContinuation: boolean
}

export function mergeHooks(base: Hooks | undefined, extra: Hooks | undefined): Hooks | undefined {
  if (!base) return extra
  if (!extra) return base
  return {
    userPromptSubmit: mergeHookList(base.userPromptSubmit, extra.userPromptSubmit),
    preToolUse: mergeHookList(base.preToolUse, extra.preToolUse),
    postToolUse: mergeHookList(base.postToolUse, extra.postToolUse),
    preCompact: mergeHookList(base.preCompact, extra.preCompact),
    postCompact: mergeHookList(base.postCompact, extra.postCompact),
    subagentStart: mergeHookList(base.subagentStart, extra.subagentStart),
    subagentStop: mergeHookList(base.subagentStop, extra.subagentStop),
    stop: mergeHookList(base.stop, extra.stop),
  }
}

function mergeHookList<T>(base: readonly T[] | undefined, extra: readonly T[] | undefined): T[] | undefined {
  if (!base || base.length === 0) return extra ? [...extra] : undefined
  if (!extra || extra.length === 0) return [...base]
  return [...base, ...extra]
}

export async function runPreToolUseHooks(
  hooks: readonly HookCommand[] | undefined,
  tool: Tool,
  input: unknown,
  context: ToolContext,
  signal?: AbortSignal,
): Promise<PreToolUseHookResult> {
  if (!hooks || hooks.length === 0) return { ok: true }

  for (const hook of hooks) {
    if (!matchesHook(hook, tool.name)) continue
    const result = await runHookCommand({
      hook,
      hookName: 'preToolUse',
      context,
      signal,
      input: {
        tool: tool.name,
        riskLevel: tool.riskLevel,
        input,
        cwd: context.cwd,
        sessionId: context.sessionId,
        ...skillHookInput(context),
      },
      failurePrefix: `Pre-tool hook failed for ${tool.name}`,
      timeoutPrefix: `Pre-tool hook timed out for ${tool.name}`,
      blockedPrefix: `Pre-tool hook blocked ${tool.name}`,
    })
    if (!result.ok) return result
  }

  return { ok: true }
}

export async function runLifecycleHooks(
  hooks: readonly HookCommand[] | undefined,
  hookName: LifecycleHookName,
  input: Record<string, unknown>,
  context: ToolContext,
  signal?: AbortSignal,
  matcherValue?: string,
): Promise<LifecycleHookOutput> {
  if (!hooks || hooks.length === 0) {
    return { stdout: '', failures: [], blockingErrors: [], preventContinuation: false }
  }

  const outputs: string[] = []
  const failures: string[] = []
  const blockingErrors: string[] = []
  let preventContinuation = false
  for (const hook of hooks) {
    if (matcherValue !== undefined && !matchesHook(hook, matcherValue)) continue
    const result = await runHookCommand({
      hook,
      hookName,
      context,
      signal,
      input: {
        ...input,
        cwd: context.cwd,
        sessionId: context.sessionId,
        ...skillHookInput(context),
      },
      failurePrefix: `${hookName} hook failed`,
      timeoutPrefix: `${hookName} hook timed out`,
      blockedPrefix: `${hookName} hook failed`,
    })

    const control = parseLifecycleHookControl(result.stdout ?? '', result.stderr ?? '')
    if (control.stdout.trim()) outputs.push(control.stdout.trim())
    blockingErrors.push(...control.blockingErrors)
    preventContinuation ||= control.preventContinuation
    const hasControlSignal = control.preventContinuation || control.blockingErrors.length > 0

    if (result.ok) {
      continue
    } else if (hasControlSignal) {
      continue
    } else {
      failures.push(result.content ?? `${hookName} hook failed: ${hook.command}`)
    }
  }

  return {
    stdout: outputs.join('\n\n'),
    failures,
    blockingErrors,
    preventContinuation,
  }
}

function skillHookInput(context: ToolContext): Record<string, string> {
  if (!context.skillInvocation) return {}
  return {
    skillName: context.skillInvocation.skillName,
    skillArgs: context.skillInvocation.skillArgs,
    prompt: context.skillInvocation.prompt,
  }
}

function matchesHook(hook: HookCommand, toolName: string): boolean {
  return !hook.matcher || matchGlob(toolName, hook.matcher)
}

function matchGlob(content: string, pattern: string): boolean {
  // Use picomatch for safe, ReDoS-immune glob matching.
  return picomatch.isMatch(content, pattern, { nocase: true })
}

function runHookCommand(options: {
  hook: HookCommand
  hookName: string
  input: Record<string, unknown>
  context: ToolContext
  signal?: AbortSignal
  failurePrefix: string
  timeoutPrefix: string
  blockedPrefix: string
}): Promise<PreToolUseHookResult & { stdout?: string; stderr?: string }> {
  return new Promise((resolve) => {
    const { hook, hookName, input, context, signal, failurePrefix, timeoutPrefix, blockedPrefix } = options
    const timeoutMs = Math.max(1, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
    const proc = spawn(hook.command, [], {
      cwd: context.cwd,
      shell: true,
      signal,
      stdio: ['pipe', 'pipe', 'pipe'],
      // No console window per hook run on Windows; the output is piped anyway.
      windowsHide: true,
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (result: PreToolUseHookResult & { stdout?: string; stderr?: string }) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutId)
      resolve(result)
    }

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_HOOK_OUTPUT_BYTES) return current
      const next = current + chunk.toString()
      return next.length > MAX_HOOK_OUTPUT_BYTES ? next.slice(0, MAX_HOOK_OUTPUT_BYTES) : next
    }

    const timeoutId = setTimeout(() => {
      timedOut = true
      proc.kill()
    }, timeoutMs)

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout = append(stdout, chunk)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr = append(stderr, chunk)
    })

    proc.on('error', (error: Error) => {
      finish({
        ok: false,
        content: `${failurePrefix}: ${error.message}`,
        details: { command: hook.command, error: error.message },
      })
    })

    proc.on('close', (code: number | null, childSignal: NodeJS.Signals | null) => {
      if (timedOut) {
        finish({
          ok: false,
          content: `${timeoutPrefix}: ${hook.command}`,
          details: { command: hook.command, timeoutMs, stdout, stderr },
        })
        return
      }

      if (code === 0) {
        finish({ ok: true, stdout, stderr })
        return
      }

      const output = formatHookOutput(stdout, stderr)
      finish({
        ok: false,
        content: `${blockedPrefix}: ${hook.command} exited with code ${code ?? 'unknown'}.${output}`,
        details: { command: hook.command, exitCode: code, signal: childSignal, stdout, stderr },
        stdout,
        stderr,
      })
    })

    proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
      // EPIPE is expected when the hook process exits before we finish
      // writing stdin. Suppress it to avoid crashing the host process.
      if (err.code !== 'EPIPE') {
        finish({
          ok: false,
          content: `${failurePrefix}: stdin error: ${err.message}`,
          details: { command: hook.command, error: err.message },
        })
      }
    })
    proc.stdin.end(JSON.stringify({
      hook: hookName,
      ...input,
    }))
  })
}

function formatHookOutput(stdout: string, stderr: string): string {
  const parts: string[] = []
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trim()}`)
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trim()}`)
  return parts.length > 0 ? `\n${parts.join('\n')}` : ''
}

function parseLifecycleHookControl(stdout: string, stderr: string): LifecycleHookOutput {
  const visibleStdout: string[] = []
  const blockingErrors: string[] = []
  let preventContinuation = false
  const stdoutLines = stdout.split(/\r?\n/)

  for (let index = 0; index < stdoutLines.length; index += 1) {
    const line = stdoutLines[index] ?? ''
    if (line.trim() !== '__HANEKAWA_HOOK__') {
      visibleStdout.push(line)
      continue
    }

    const payload = stdoutLines[index + 1]
    if (payload === undefined) continue
    index += 1
    try {
      const parsed = JSON.parse(payload) as unknown
      if (!parsed || typeof parsed !== 'object') continue
      const control = parsed as {
        preventContinuation?: unknown
        blockingError?: unknown
        blockingErrors?: unknown
      }
      preventContinuation ||= control.preventContinuation === true
      if (typeof control.blockingError === 'string' && control.blockingError.trim()) {
        blockingErrors.push(control.blockingError.trim())
      }
      if (Array.isArray(control.blockingErrors)) {
        for (const item of control.blockingErrors) {
          if (typeof item === 'string' && item.trim()) blockingErrors.push(item.trim())
        }
      }
    } catch {
      visibleStdout.push(line, payload)
    }
  }

  for (const line of stderr.split(/\r?\n/)) {
    const match = /^BLOCKING:\s*(.+)$/i.exec(line.trim())
    if (match?.[1]) blockingErrors.push(match[1].trim())
  }

  return {
    stdout: visibleStdout.join('\n').trim(),
    failures: [],
    blockingErrors,
    preventContinuation,
  }
}
