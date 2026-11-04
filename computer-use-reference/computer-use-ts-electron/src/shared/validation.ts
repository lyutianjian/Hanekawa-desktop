import type { Action, ActInput, StartInput, SessionInput, ElementNode } from './contracts';
import { AutomationError } from './errors';
function invalid(): never { throw new AutomationError('INVALID_INPUT', 'Message does not match the v1 contract'); }
export function record(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || required.some(k => !Object.hasOwn(descriptors, k))) return invalid();
  const out: Record<string, unknown> = {};
  for (const [key, d] of Object.entries(descriptors)) {
    if (!required.includes(key) && !optional.includes(key) || !('value' in d)) return invalid();
    Object.defineProperty(out, key, { value: d.value, enumerable: true });
  }
  return out;
}
export function string(value: unknown, max = 256, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length)) return invalid();
  return value;
}
export function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max) return invalid();
  return value;
}
export function parseStart(value: unknown): StartInput {
  const v = record(value, ['driver', 'bundleId']);
  if (v.driver !== 'mock' && v.driver !== 'macos') return invalid();
  return Object.freeze({ driver: v.driver, bundleId: string(v.bundleId) });
}
export function parseSession(value: unknown): SessionInput {
  const v = record(value, ['sessionId']);
  return Object.freeze({ sessionId: string(v.sessionId, 80) });
}
export function parseAction(value: unknown): Action {
  // Inspect descriptors before reading kind, including direct model-adapter use.
  const v = record(value, ['kind', 'ref'], ['value']);
  const r = record(v.ref, ['snapshotId', 'index']);
  const ref = Object.freeze({ snapshotId: string(r.snapshotId, 80), index: integer(r.index, 999) });
  if (v.kind === 'press' && !Object.hasOwn(v, 'value')) return Object.freeze({ kind: 'press', ref });
  if (v.kind === 'setValue' && Object.hasOwn(v, 'value')) return Object.freeze({ kind: 'setValue', ref, value: string(v.value, 4096, true) });
  return invalid();
}
export function parseAct(value: unknown): ActInput {
  const v = record(value, ['sessionId', 'action']);
  return Object.freeze({ sessionId: string(v.sessionId, 80), action: parseAction(v.action) });
}
export function parseNodes(value: unknown): ElementNode[] {
  if (!Array.isArray(value) || value.length > 1000) return invalid();
  const seen = new Set<number>();
  return value.map(raw => {
    const n = record(raw, ['index', 'depth', 'role', 'label', 'actions'], ['value']);
    const index = integer(n.index, 999);
    if (seen.has(index) || !Array.isArray(n.actions) || n.actions.length > 32) return invalid();
    seen.add(index);
    return { index, depth: integer(n.depth, 24), role: string(n.role, 400, true), label: string(n.label, 1200, true),
      actions: n.actions.map(a => string(a, 100)), ...(n.value === undefined ? {} : { value: string(n.value, 400, true) }) };
  });
}
