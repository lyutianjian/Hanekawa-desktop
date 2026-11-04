import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseAction, parseStart, parseAct, parseNodes } from '../src/shared/validation';
import { assertSender } from '../src/main/sender';
import { result, AutomationError } from '../src/shared/errors';
test('validation rejects unknown fields, invalid indices, booleans, oversized input', () => {
  for (const index of [-1, 1.5, NaN, true, 1000]) assert.throws(() => parseAction({ kind: 'press', ref: { snapshotId: 'x', index } }));
  assert.throws(() => parseStart({ driver: 'mock', bundleId: 'demo.counter', command: 'sh' }));
  assert.throws(() => parseAction({ kind: 'press', ref: { snapshotId: 'x', index: 1 }, value: 'ignored' }));
  assert.throws(() => parseAction({ kind: 'setValue', ref: { snapshotId: 'x', index: 1 }, value: 'x'.repeat(4097) }));
  assert.throws(() => parseNodes([{ index: 1, depth: 0, role: '', label: '', actions: [] }, { index: 1, depth: 0, role: '', label: '', actions: [] }]));
});
test('accessors never execute and returned nested references cannot be mutated', () => {
  let calls = 0;
  assert.throws(() => parseStart({ get driver() { ++calls; return 'mock'; }, bundleId: 'demo.counter' }));
  assert.equal(calls, 0);
  const source = { sessionId: 'a', action: { kind: 'press', ref: { snapshotId: 'x', index: 1 } } };
  const parsed = parseAct(source); source.action.ref.index = 2;
  assert.equal(parsed.action.ref.index, 1); assert(Object.isFrozen(parsed.action.ref));
});
test('sender predicate rejects subframes, other windows and changed origins/paths', () => {
  const valid = { senderId: 3, ownerId: 3, isMainFrame: true, url: 'cu-app://ui/index.html' };
  assertSender(valid);
  for (const changed of [{ isMainFrame: false }, { senderId: 4 }, { url: 'https://example.com' }, { url: 'cu-app://ui/other.html' }]) {
    assert.throws(() => assertSender({ ...valid, ...changed }));
  }
});
test('typed result envelope preserves error code without exposing stacks', async () => {
  const response = await result(() => { throw new AutomationError('STALE_SNAPSHOT', 'Observe again'); });
  assert.deepEqual(response, { ok: false, error: { code: 'STALE_SNAPSHOT', message: 'Observe again', outcome: 'not-started' } });
  const unknown = await result(() => { throw new Error('/private/path'); });
  assert(!JSON.stringify(unknown).includes('/private/path'));
});
