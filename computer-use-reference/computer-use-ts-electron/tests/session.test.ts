import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Session } from '../src/automation/session';
import { MockDriver } from '../src/drivers/mock';
import { AutomationError } from '../src/shared/errors';
import { Manager } from '../src/main/manager';
const code = (expected: string) => (error: unknown) => error instanceof AutomationError && error.code === expected;
function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

test('mock observe -> press -> observe verifies business result and invalidates old reference', async () => {
  const driver = new MockDriver(); const session = new Session(driver);
  try {
    await session.open(); const first = await session.observe();
    await session.act({ kind: 'press', ref: { snapshotId: first.snapshotId, index: 1 } });
    await assert.rejects(async () => session.act({ kind: 'press', ref: { snapshotId: first.snapshotId, index: 1 } }), code('STALE_SNAPSHOT'));
    const next = await session.observe();
    assert.equal(next.nodes.find(n => n.label === 'Count')?.value, '1');
    assert.notEqual(first.snapshotId, next.snapshotId);
  } finally { await session.cancel(); }
});
test('snapshot mutation by caller cannot alter the actionable internal snapshot', async () => {
  const session = new Session(new MockDriver());
  try {
    const first = await session.observe(); first.nodes.push({ index: 999, depth: 0, role: '', label: '', actions: [] });
    await assert.rejects(async () => session.act({ kind: 'press', ref: { snapshotId: first.snapshotId, index: 999 } }), code('STALE_SNAPSHOT'));
  } finally { await session.cancel(); }
});
test('cross-session snapshot and a replaced full snapshot are rejected', async () => {
  const a = new Session(new MockDriver()); const b = new Session(new MockDriver());
  try {
    const old = await a.observe(); await b.observe();
    const action = { kind: 'press', ref: { snapshotId: old.snapshotId, index: 1 } };
    await assert.rejects(async () => b.act(action), code('STALE_SNAPSHOT'));
    await a.observe(); await assert.rejects(async () => a.act(action), code('STALE_SNAPSHOT'));
  } finally { await a.cancel(); await b.cancel(); }
});
test('concurrent duplicate actions serialize; only the first can execute', async () => {
  const driver = new MockDriver(); const session = new Session(driver);
  try {
    const snapshot = await session.observe(); const action = { kind: 'press', ref: { snapshotId: snapshot.snapshotId, index: 1 } };
    const results = await Promise.allSettled([session.act(action), session.act(action)]);
    assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected']); assert.equal(driver.count, 1);
  } finally { await session.cancel(); }
});
test('cancel bypasses a hung request, closes the driver, and stops queued work', async () => {
  class Hung extends MockDriver {
    entered = gate(); shutdown = gate(); reads = 0;
    override async observe(signal: AbortSignal) { ++this.reads; this.entered.release(); await this.shutdown.promise; return super.observe(signal); }
    override async close() { await super.close(); this.shutdown.release(); }
  }
  const driver = new Hung(); const session = new Session(driver);
  const first = session.observe(); const queued = session.observe();
  const settled = Promise.allSettled([first, queued]); await driver.entered.promise;
  await session.cancel(); const results = await settled;
  assert(results.every(r => r.status === 'rejected')); assert.equal(driver.reads, 1); assert.equal(session.info().state, 'closed');
});
test('timeout terminates driver and never automatically retries an action', async () => {
  class HungAction extends MockDriver {
    attempts = 0; terminated = false;
    override async act(): Promise<never> { ++this.attempts; return new Promise(() => {}); }
    override async close() { this.terminated = true; await super.close(); }
  }
  const driver = new HungAction(); const session = new Session(driver, 30);
  const observed = await session.observe();
  await assert.rejects(async () => session.act({ kind: 'press', ref: { snapshotId: observed.snapshotId, index: 1 } }), code('DEADLINE_EXCEEDED'));
  assert.equal(driver.attempts, 1); assert(driver.terminated); assert.equal(session.info().state, 'failed');
  await session.cancel();
});
test('nonterminal native failure invalidates refs while allowing a new observation', async () => {
  class Fails extends MockDriver { override async act(): Promise<never> { throw new AutomationError('NATIVE_ERROR', 'AX rejected the action', 'unknown'); } }
  const session = new Session(new Fails());
  try {
    const first = await session.observe(); const action = { kind: 'press', ref: { snapshotId: first.snapshotId, index: 1 } };
    await assert.rejects(async () => session.act(action), code('NATIVE_ERROR'));
    await assert.rejects(async () => session.act(action), code('STALE_SNAPSHOT'));
    assert.equal((await session.observe()).revision, 2);
  } finally { await session.cancel(); }
});
test('manager enforces app lease and session owner, releases only after close', async () => {
  const manager = new Manager('/unused', async () => true);
  const first = await manager.start(1, { driver: 'mock', bundleId: 'demo.counter' });
  await assert.rejects(manager.start(2, { driver: 'mock', bundleId: 'demo.counter' }), code('BUSY'));
  assert.throws(() => manager.get(2, first.id), code('NOT_AUTHORIZED'));
  await manager.cancel(1, first.id);
  const next = await manager.start(2, { driver: 'mock', bundleId: 'demo.counter' });
  await manager.cancel(2, next.id);
});
test('manager rejects arbitrary apps and target drivers', async () => {
  const manager = new Manager('/unused', async () => true);
  await assert.rejects(manager.start(1, { driver: 'macos', bundleId: 'com.example.anything' }), code('NOT_AUTHORIZED'));
});
