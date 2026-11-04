/** Independent v1 protocol. It is intentionally incompatible with Codex IPC. */
export const PROTOCOL = 'cu-reference/1' as const;
export type DriverKind = 'mock' | 'macos';
export type ActionKind = 'press' | 'setValue';
export interface Target { driver: DriverKind; bundleId: string; displayName: string }
export interface Capabilities {
  observation: 'ax-full'; actions: readonly ActionKind[];
  diff: false; screenshot: false; coordinates: false; backgroundInput: false;
}
export interface ElementNode {
  index: number; depth: number; role: string; label: string;
  value?: string; actions: string[];
}
export interface Observation {
  protocol: typeof PROTOCOL; sessionId: string; snapshotId: string;
  revision: number; target: Target; processId: number; capturedAt: number;
  text: string; nodes: ElementNode[]; truncated: boolean;
}
/** References are scoped to one session AND one immutable snapshot. */
export interface ElementRef { snapshotId: string; index: number }
export type Action = { kind: 'press'; ref: ElementRef } | { kind: 'setValue'; ref: ElementRef; value: string };
export type ErrorCode = 'INVALID_INPUT' | 'NOT_AUTHORIZED' | 'UNSUPPORTED' | 'BUSY' |
  'STALE_SNAPSHOT' | 'CANCELLED' | 'DEADLINE_EXCEEDED' | 'DRIVER_LOST' |
  'PERMISSION_REQUIRED' | 'TARGET_CHANGED' | 'NATIVE_ERROR' | 'INTERNAL';
export interface Failure { code: ErrorCode; message: string; outcome: 'not-started' | 'unknown' }
export type Result<T> = { ok: true; value: T } | { ok: false; error: Failure };
export type SessionState = 'ready' | 'busy' | 'cancelling' | 'closed' | 'failed';
export interface SessionInfo { id: string; target: Target; state: SessionState; capabilities: Capabilities }
export interface ActionReceipt { performed: true; observeRequired: true }
export interface StartInput { driver: DriverKind; bundleId: string }
export interface SessionInput { sessionId: string }
export interface ActInput extends SessionInput { action: Action }
export interface AutomationAPI {
  targets(): Promise<Result<Target[]>>;
  start(input: StartInput): Promise<Result<SessionInfo>>;
  observe(input: SessionInput): Promise<Result<Observation>>;
  act(input: ActInput): Promise<Result<ActionReceipt>>;
  cancel(input: SessionInput): Promise<Result<{ closed: true }>>;
}
export const CHANNELS = {
  targets: 'cu:targets', start: 'cu:start', observe: 'cu:observe', act: 'cu:act', cancel: 'cu:cancel'
} as const;
export const CAPABILITIES: Capabilities = Object.freeze({
  observation: 'ax-full', actions: Object.freeze(['press', 'setValue'] as const),
  diff: false, screenshot: false, coordinates: false, backgroundInput: false
});
