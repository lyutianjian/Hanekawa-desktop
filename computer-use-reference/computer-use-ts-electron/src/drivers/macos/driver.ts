import type { Driver, DriverObservation } from '../../automation/driver';
import type { Action, ActionReceipt } from '../../shared/contracts';
import { PROTOCOL } from '../../shared/contracts';
import { AutomationError } from '../../shared/errors';
import { record, integer, string, parseNodes } from '../../shared/validation';
import { JsonlClient } from './jsonl-client';
export class MacOSDriver implements Driver {
  readonly target = { driver: 'macos' as const, bundleId: 'com.apple.calculator', displayName: 'Calculator (macOS)' };
  private client: JsonlClient;
  private processId?: number;
  constructor(executable: string) { this.client = new JsonlClient(executable, this.target.bundleId); }
  async open(signal: AbortSignal): Promise<void> {
    this.client.start();
    const hello = record(await this.client.request('hello', {}, signal), ['protocol', 'bundleId', 'processId']);
    if (hello.protocol !== PROTOCOL || hello.bundleId !== this.target.bundleId) throw new AutomationError('DRIVER_LOST', 'Native handshake mismatch');
    this.processId = integer(hello.processId);
  }
  async observe(signal: AbortSignal): Promise<DriverObservation> {
    const v = record(await this.client.request('observe', {}, signal), ['revision', 'processId', 'text', 'nodes', 'truncated']);
    if (integer(v.processId) !== this.processId) throw new AutomationError('TARGET_CHANGED', 'Target process changed');
    if (typeof v.truncated !== 'boolean') throw new AutomationError('DRIVER_LOST', 'Invalid native observation');
    return { nativeRevision: integer(v.revision), processId: this.processId!, text: string(v.text, 800_000, true),
      nodes: parseNodes(v.nodes), truncated: v.truncated };
  }
  async act(action: Action, revision: number, signal: AbortSignal): Promise<ActionReceipt> {
    const v = record(await this.client.request(action.kind, {
      revision, index: action.ref.index, ...(action.kind === 'setValue' ? { value: action.value } : {})
    }, signal), ['performed', 'observeRequired']);
    if (v.performed !== true || v.observeRequired !== true) throw new AutomationError('DRIVER_LOST', 'Invalid native action receipt', 'unknown');
    return { performed: true, observeRequired: true };
  }
  close(): Promise<void> { return this.client.close(); }
}
