import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { z } from 'zod/v3'
import { ComputerError } from './errors.js'

const LIMIT = 24 * 1024 * 1024
const errorSchema = z.object({ code: z.enum(['PERMISSION_REQUIRED', 'TARGET_CHANGED', 'STALE_SNAPSHOT', 'UNSUPPORTED', 'INVALID_INPUT', 'NATIVE_ERROR']), message: z.string().max(2000), delivery: z.enum(['not_delivered', 'unknown']) }).strict()
const envelopeSchema = z.union([
  z.object({ id: z.number().int().positive(), result: z.unknown() }).strict().refine(v => Object.hasOwn(v, 'result')),
  z.object({ id: z.number().int().positive(), error: errorSchema }).strict(),
])

/** Private stdio, one pending request. Cancellation poisons this channel forever. */
export class ComputerClient {
  private child: ChildProcessWithoutNullStreams
  private exited: Promise<void>
  private closing?: Promise<void>
  private killTimer?: ReturnType<typeof setTimeout>
  private broken = false
  private buffer: Buffer = Buffer.alloc(0)
  private nextId = 1
  private pending?: { id: number; resolve(value: unknown): void; reject(error: unknown): void; detach(): void }

  get isBroken(): boolean { return this.broken }

  constructor(executable: string, onSpawn?: (elapsedMs: number) => void) {
    const start = performance.now()
    this.child = spawn(executable, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' } })
    this.child.once('spawn', () => onSpawn?.(performance.now() - start))
    this.exited = new Promise(resolve => {
      // close follows both exit and stdio shutdown; a killed helper cannot race
      // the next physical desktop operation on the global host queue.
      this.child.once('close', () => {
        clearTimeout(this.killTimer)
        this.fail(new ComputerError('DRIVER_LOST', 'Native computer helper exited. Bind the app again.', 'unknown'))
        resolve()
      })
    })
    this.child.on('error', () => this.fail(new ComputerError('DRIVER_LOST', 'Cannot start computer helper. Run npm run build:desktop.')))
    this.child.stdout.on('data', (chunk: Buffer) => {
      try { this.receive(chunk) } catch { this.fail(new ComputerError('DRIVER_LOST', 'Invalid response from computer helper.', 'unknown')) }
    })
    this.child.stdout.on('end', () => this.fail(new ComputerError('DRIVER_LOST', 'Computer helper output closed.', 'unknown')))
    this.child.stdin.on('error', () => this.fail(new ComputerError('DRIVER_LOST', 'Computer helper input closed.', 'unknown')))
    this.child.stderr.on('data', () => {})
  }
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (this.broken) return Promise.reject(new ComputerError('DRIVER_LOST', 'Computer binding has closed. Bind the app again.'))
    if (this.pending) return Promise.reject(new ComputerError('TARGET_BUSY', 'Native requests must be serialized.'))
    const id = this.nextId++
    const bytes = Buffer.from(JSON.stringify({ ...params, id, method }) + '\n')
    if (bytes.length > 64 * 1024) return Promise.reject(new ComputerError('INVALID_INPUT', 'Computer request is too large.'))
    return new Promise((resolve, reject) => {
      const aborted = () => this.fail(signal.reason)
      this.pending = { id, resolve, reject, detach: () => signal.removeEventListener('abort', aborted) }
      signal.addEventListener('abort', aborted, { once: true })
      this.child.stdin.write(bytes, error => { if (error) this.fail(new ComputerError('DRIVER_LOST', 'Native write failed.', 'unknown')) })
    })
  }
  private receive(chunk: Buffer): void {
    if (this.broken) return
    // Never decode chunks separately: UTF-8 code points can span pipe reads.
    if (this.buffer.length + chunk.length > LIMIT) throw new Error('Oversized response')
    this.buffer = Buffer.concat([this.buffer, chunk])
    let newline: number
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      const line = this.buffer.subarray(0, newline)
      this.buffer = this.buffer.subarray(newline + 1)
      const message = envelopeSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line)))
      const pending = this.pending
      if (!pending || message.id !== pending.id) throw new Error('Unexpected response id')
      this.pending = undefined
      pending.detach()
      if ('error' in message) pending.reject(new ComputerError(message.error.code, message.error.message, message.error.delivery))
      else pending.resolve(message.result)
    }
  }
  private fail(error: unknown): void {
    if (this.broken) return
    this.broken = true
    const pending = this.pending
    this.pending = undefined
    pending?.detach()
    pending?.reject(error)
    this.child.kill('SIGTERM')
    // Escalation also covers protocol corruption without an explicit close().
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.killTimer = setTimeout(() => this.child.kill('SIGKILL'), 750)
      this.killTimer.unref()
    }
  }
  close(): Promise<void> {
    if (!this.closing) {
      this.fail(new ComputerError('ABORTED', 'Computer binding released.', 'unknown'))
      this.closing = this.exited
    }
    return this.closing
  }
}
