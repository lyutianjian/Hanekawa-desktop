import { spawn } from 'node:child_process'

/**
 * A single line never grows past this in memory. Ripgrep caps content columns
 * itself (`--max-columns`), so only a pathological one-line file can reach it;
 * the line is kept with a trailing ellipsis rather than dropped, so nothing
 * that matched disappears from the result.
 */
const MAX_LINE_CHARS = 8 * 1024
/** stderr is only ever quoted in an error message. */
const MAX_STDERR_CHARS = 8 * 1024

export interface RipgrepStreamResult {
  /** The first `keepLimit` accepted lines, transformed. */
  readonly kept: string[]
  /** How many lines were accepted; the exact total, without holding them. */
  readonly total: number
}

export interface RipgrepStreamOptions {
  cwd: string
  args: string[]
  /** Lines retained for the caller. Everything past this is only counted. */
  keepLimit: number
  timeoutMs: number
  signal?: AbortSignal
  /** Decides whether a line counts at all (and may therefore be kept). */
  accept?: (line: string) => boolean
  /** Applied to kept lines only... i.e. to accepted lines before retention. */
  transform?: (line: string) => string
}

/**
 * Runs ripgrep and streams its stdout instead of buffering it whole. A search
 * that prints 10 MiB of matches used to fail outright (or hold every row in
 * memory); here the caller names how many rows it can use and the rest is
 * counted as it goes, so totals stay exact while memory stays bounded.
 *
 * Resolves `null` — and only `null` — when ripgrep could not be run at all,
 * which is the signal to fall back to the JavaScript scanner.
 */
export function streamRipgrepLines(options: RipgrepStreamOptions): Promise<RipgrepStreamResult | null> {
  const { cwd, args, keepLimit, timeoutMs, signal } = options
  const transform = options.transform ?? ((line: string) => line)
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortFailure(signal))
      return
    }

    const child = spawn('rg', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const kept: string[] = []
    let total = 0
    let settled = false
    let stderr = ''
    let buffer = ''
    let overlong = false
    let timedOut = false
    let abortError: Error | undefined

    const timer = setTimeout(() => {
      timedOut = true
      killChild()
    }, timeoutMs)
    const onAbort = () => {
      abortError = abortFailure(signal!)
      killChild()
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    function killChild(): void {
      child.stdout.destroy()
      child.stderr.destroy()
      try {
        child.kill('SIGKILL')
      } catch {
        // Already gone; the sibling handlers settle the promise.
      }
      // A killed process can leave a grandchild holding the pipes open, so the
      // wait for `close` is bounded rather than trusted.
      setTimeout(() => settleFailure(cancellationFailure()), 250).unref?.()
    }

    function cancellationFailure(): Error {
      if (abortError) return abortError
      if (timedOut) return new Error(`ripgrep timed out after ${timeoutMs}ms`)
      return new Error('ripgrep was cancelled')
    }

    function settleFailure(error: Error): void {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(error)
    }

    function deliver(line: string): void {
      if (line === '') return
      if (options.accept && !options.accept(line)) return
      total += 1
      if (kept.length < keepLimit) kept.push(transform(line))
    }

    function takeLine(tail: string): void {
      const line = buffer + tail
      const truncated = overlong
      buffer = ''
      overlong = false
      deliver(truncated ? `${line.slice(0, MAX_LINE_CHARS)}…` : line)
    }

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      if (settled || abortError || timedOut) return
      let start = 0
      for (;;) {
        const index = chunk.indexOf('\n', start)
        if (index === -1) break
        takeLine(chunk.slice(start, index))
        start = index + 1
      }
      if (start >= chunk.length || overlong) return
      buffer += chunk.slice(start)
      if (buffer.length > MAX_LINE_CHARS) {
        buffer = buffer.slice(0, MAX_LINE_CHARS)
        overlong = true
      }
    })
    child.stdout.on('error', () => {})

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < MAX_STDERR_CHARS) stderr += chunk
    })
    child.stderr.on('error', () => {})

    child.on('error', (error: NodeJS.ErrnoException) => {
      if (settled) return
      if (error.code === 'ENOENT') {
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve(null)
        return
      }
      settleFailure(error)
    })

    // ripgrep exits 1 when it simply found nothing; anything above 1 is a real
    // failure. A killed process reports `null`, handled before the code check.
    child.on('close', (code: number | null) => {
      if (settled) return
      if (abortError || timedOut) {
        settleFailure(cancellationFailure())
        return
      }
      if (code === 0 || code === 1) {
        if (buffer !== '' || overlong) takeLine('')
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        resolve({ kept, total })
        return
      }
      settleFailure(new Error(`ripgrep failed (exit ${code ?? 'signal'}): ${stderr.trim() || 'no stderr'}`))
    })
  })
}

function abortFailure(signal: AbortSignal): Error {
  const reason: unknown = signal.reason
  if (reason instanceof Error) return reason
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}