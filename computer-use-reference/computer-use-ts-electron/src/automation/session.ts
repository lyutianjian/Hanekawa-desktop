import { randomUUID } from 'node:crypto';
import type { ActionReceipt, Observation, SessionInfo, SessionState } from '../shared/contracts';
import { CAPABILITIES, PROTOCOL } from '../shared/contracts';
import { AutomationError } from '../shared/errors';
import { parseAction } from '../shared/validation';
import type { Driver } from './driver';

export class Session {
  readonly id = randomUUID();
  private state: SessionState = 'ready';
  private queue: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private revision = 0;
  private current?: { snapshot: Observation; nativeRevision: number };
  private life = new AbortController();
  private closing?: Promise<void>;
  constructor(readonly driver: Driver, private timeoutMs = 10_000) {}
  info(): SessionInfo { return { id: this.id, target: this.driver.target, state: this.state, capabilities: CAPABILITIES }; }
  async open(): Promise<void> {
    await this.enqueue(async signal => { await this.driver.open(signal); });
  }
  observe(): Promise<Observation> {
    return this.enqueue(async signal => {
      this.current = undefined; // A failed read must not retain the previous actionable reference.
      const observed = await this.driver.observe(signal);
      const snapshot: Observation = {
        protocol: PROTOCOL, sessionId: this.id, snapshotId: randomUUID(), revision: ++this.revision,
        target: this.driver.target, processId: observed.processId, capturedAt: Date.now(),
        text: observed.text, nodes: observed.nodes, truncated: observed.truncated
      };
      this.check(signal);
      this.current = { snapshot, nativeRevision: observed.nativeRevision };
      // Never expose mutable internal state to an in-process model adapter.
      return structuredClone(snapshot);
    });
  }
  act(input: unknown): Promise<ActionReceipt> {
    const action = parseAction(input); // Copy/freeze before queueing; avoid mutation while awaiting authorization/queue.
    return this.enqueue(async signal => {
      const observed = this.current;
      if (!observed || action.ref.snapshotId !== observed.snapshot.snapshotId ||
          !observed.snapshot.nodes.some(n => n.index === action.ref.index)) {
        throw new AutomationError('STALE_SNAPSHOT', 'Observe again before selecting an element');
      }
      this.current = undefined; // Even a failed action can have changed UI. Never retry it implicitly.
      return this.driver.act(action, observed.nativeRevision, signal);
    });
  }
  cancel(): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === 'closed') return Promise.resolve();
    this.state = 'cancelling';
    this.current = undefined;
    this.life.abort(new AutomationError('CANCELLED', 'Session cancelled; re-observe in a new session', 'unknown'));
    // Bypass the serial queue so cancellation interrupts an in-flight RPC.
    this.closing = this.driver.close().then(() => { this.state = 'closed'; });
    return this.closing;
  }
  private check(signal: AbortSignal): void {
    if (signal.aborted) throw signal.reason;
    if (this.state === 'closed' || this.state === 'failed' || this.state === 'cancelling') {
      throw new AutomationError('CANCELLED', 'This session cannot accept work');
    }
  }
  private enqueue<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.check(this.life.signal);
    if (this.pending >= 32) return Promise.reject(new AutomationError('BUSY', 'Session queue is full'));
    ++this.pending;
    // End-to-end budget starts NOW, and includes time spent waiting in the queue.
    const deadline = Date.now() + this.timeoutMs;
    const operation = this.queue.then(async () => {
      this.check(this.life.signal);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AutomationError('DEADLINE_EXCEEDED', 'Deadline elapsed while queued');
      this.state = 'busy';
      const controller = new AbortController();
      const propagate = () => controller.abort(this.life.signal.reason);
      this.life.signal.addEventListener('abort', propagate, { once: true });
      const timer = setTimeout(() => controller.abort(new AutomationError('DEADLINE_EXCEEDED', 'Operation deadline elapsed; outcome may be unknown', 'unknown')), remaining);
      let onAbort: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', onAbort, { once: true });
        });
        const value = await Promise.race([run(controller.signal), aborted]);
        this.check(controller.signal); // Discard success that arrived after cancellation.
        return value;
      } catch (error) {
        const terminal = controller.signal.aborted || error instanceof AutomationError &&
          ['DRIVER_LOST', 'TARGET_CHANGED', 'INVALID_INPUT', 'INTERNAL'].includes(error.code);
        if (terminal) {
          this.current = undefined;
          if (this.state === 'busy') this.state = 'failed';
          this.life.abort(error);
          // Do not advance/release the lease until teardown has finished.
          await this.driver.close();
        }
        throw error;
      } finally {
        clearTimeout(timer);
        this.life.signal.removeEventListener('abort', propagate);
        if (onAbort) controller.signal.removeEventListener('abort', onAbort);
        if (this.state === 'busy') this.state = 'ready';
      }
    }).finally(() => { --this.pending; });
    this.queue = operation.catch(() => {});
    return operation;
  }
}
