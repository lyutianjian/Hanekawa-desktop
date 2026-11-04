import type { Driver, DriverObservation } from '../automation/driver';
import type { Action, ActionReceipt } from '../shared/contracts';
import { AutomationError } from '../shared/errors';
export class MockDriver implements Driver {
  readonly target = { driver: 'mock' as const, bundleId: 'demo.counter', displayName: 'Mock Counter' };
  count = 0;
  private revision = 0;
  private valid = false;
  private closed = false;
  async open(signal: AbortSignal) { this.check(signal); }
  async observe(signal: AbortSignal): Promise<DriverObservation> {
    this.check(signal); this.valid = true;
    return { nativeRevision: ++this.revision, processId: 1, truncated: false,
      text: `0 AXWindow Mock Counter\n  1 AXButton Increment\n  2 AXTextField Count ${this.count}`,
      nodes: [
        { index: 0, depth: 0, role: 'AXWindow', label: 'Mock Counter', actions: [] },
        { index: 1, depth: 1, role: 'AXButton', label: 'Increment', actions: ['AXPress'] },
        { index: 2, depth: 1, role: 'AXTextField', label: 'Count', value: String(this.count), actions: [] }
      ] };
  }
  async act(action: Action, revision: number, signal: AbortSignal): Promise<ActionReceipt> {
    this.check(signal);
    if (!this.valid || revision !== this.revision) throw new AutomationError('STALE_SNAPSHOT', 'Mock reference expired');
    this.valid = false;
    if (action.kind === 'press' && action.ref.index === 1) ++this.count;
    else if (action.kind === 'setValue' && action.ref.index === 2 && /^\d{1,8}$/.test(action.value)) this.count = Number(action.value);
    else throw new AutomationError('UNSUPPORTED', 'This mock element does not support the requested action');
    return { performed: true, observeRequired: true };
  }
  async close() { this.closed = true; this.valid = false; }
  private check(signal: AbortSignal) {
    if (signal.aborted) throw signal.reason;
    if (this.closed) throw new AutomationError('DRIVER_LOST', 'Mock driver is closed');
  }
}
