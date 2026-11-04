import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { AutomationError } from '../../shared/errors';
import { record, integer } from '../../shared/validation';
const LIMIT = 1024 * 1024;
interface Pending { resolve(value: unknown): void; reject(error: unknown): void; detach(): void }
/** Private child stdio, never a public socket. A broken channel is terminal. */
export class JsonlClient {
  private child?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private broken = false;
  private stopping?: Promise<void>;
  private exited?: Promise<void>;
  constructor(private executable: string, private bundleId: string) {}
  start(): void {
    if (this.child || this.broken) throw new AutomationError('DRIVER_LOST', 'Native client is not restartable');
    const child = spawn(this.executable, [this.bundleId], {
      shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      // No model-supplied command, path, arguments or environment.
      env: { PATH: '/usr/bin:/bin', LANG: 'en_US.UTF-8' }
    });
    this.child = child;
    this.exited = new Promise(resolve => {
      child.once('exit', () => { this.fail(new AutomationError('DRIVER_LOST', 'Native helper exited', 'unknown')); resolve(); });
      child.once('error', () => { this.fail(new AutomationError('DRIVER_LOST', 'Native helper could not start')); resolve(); });
    });
    child.stdout.on('data', data => {
      try { this.receive(Buffer.from(data)); }
      catch { this.fail(new AutomationError('DRIVER_LOST', 'Invalid native response', 'unknown')); }
    });
    child.stdout.on('end', () => this.fail(new AutomationError('DRIVER_LOST', 'Native output closed', 'unknown')));
    child.stdin.on('error', () => this.fail(new AutomationError('DRIVER_LOST', 'Native input closed', 'unknown')));
    // Drain, but do not forward arbitrary stderr to renderer or unbounded logs.
    child.stderr.on('data', () => {});
  }
  request(method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (!this.child || this.broken) return Promise.reject(new AutomationError('DRIVER_LOST', 'Native helper unavailable'));
    if (this.pending.size) return Promise.reject(new AutomationError('BUSY', 'Native requests must be serialized'));
    const id = this.nextId++;
    const bytes = Buffer.from(JSON.stringify({ id, method, ...params }) + '\n');
    if (bytes.length > LIMIT) return Promise.reject(new AutomationError('INVALID_INPUT', 'Native request is too large'));
    return new Promise((resolve, reject) => {
      const aborted = () => this.fail(signal.reason);
      const detach = () => signal.removeEventListener('abort', aborted);
      this.pending.set(id, { resolve, reject, detach });
      signal.addEventListener('abort', aborted, { once: true });
      // Response size is bounded; backpressure does not cause an unbounded send queue (one pending request).
      this.child!.stdin.write(bytes, error => { if (error) this.fail(new AutomationError('DRIVER_LOST', 'Native write failed', 'unknown')); });
    });
  }
  private receive(chunk: Buffer): void {
    // Parse bytes first; converting each chunk to text would corrupt split UTF-8.
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline: number;
    while ((newline = this.buffer.indexOf(10)) >= 0) {
      if (newline > LIMIT) throw new Error('Oversized line');
      const raw = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw));
      const message = record(value, ['id'], ['result', 'error']);
      const id = integer(message.id);
      if (Object.hasOwn(message, 'result') === Object.hasOwn(message, 'error')) throw new Error('Bad envelope');
      const pending = this.pending.get(id);
      if (!pending) throw new Error('Unexpected response id');
      this.pending.delete(id); pending.detach();
      if (Object.hasOwn(message, 'error')) {
        // Never interpret arbitrary native text as a protocol error code.
        try {
          const e = record(message.error, ['code']);
          const codes = ['PERMISSION_REQUIRED', 'TARGET_CHANGED', 'STALE_SNAPSHOT', 'UNSUPPORTED', 'NATIVE_ERROR'] as const;
          if (!codes.includes(e.code as typeof codes[number])) throw new Error('Bad code');
          pending.reject(new AutomationError(e.code as typeof codes[number], `Native helper: ${String(e.code)}`, 'unknown'));
        } catch { pending.reject(new AutomationError('DRIVER_LOST', 'Invalid native error', 'unknown')); throw new Error('Bad native error'); }
      } else pending.resolve(message.result);
    }
    if (this.buffer.length > LIMIT) throw new Error('Oversized line');
  }
  private fail(error: unknown): void {
    if (this.broken) return;
    this.broken = true;
    for (const item of this.pending.values()) { item.detach(); item.reject(error); }
    this.pending.clear();
    this.child?.kill('SIGTERM');
  }
  close(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.fail(new AutomationError('CANCELLED', 'Native session closed', 'unknown'));
    this.stopping = (async () => {
      if (!this.child || !this.exited) return;
      const killTimer = setTimeout(() => this.child?.kill('SIGKILL'), 750);
      try { await this.exited; } finally { clearTimeout(killTimer); }
    })();
    return this.stopping;
  }
}
