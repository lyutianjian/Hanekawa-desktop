import type { Action, ActionReceipt, ElementNode, Target } from '../shared/contracts';
export interface DriverObservation {
  nativeRevision: number; processId: number; text: string; nodes: ElementNode[]; truncated: boolean;
}
/** Driver is trusted code, invoked only by a policy-bound Session. */
export interface Driver {
  readonly target: Target;
  open(signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal): Promise<DriverObservation>;
  act(action: Action, nativeRevision: number, signal: AbortSignal): Promise<ActionReceipt>;
  /** Resolves only once the helper can no longer accept queued work. */
  close(): Promise<void>;
}
