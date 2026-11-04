import { strict as assert } from 'node:assert';
import { Session } from './automation/session';
import { MockDriver } from './drivers/mock';
async function main() {
  const session = new Session(new MockDriver());
  try {
    await session.open();
    const before = await session.observe();
    const button = before.nodes.find(n => n.label === 'Increment');
    assert(button);
    await session.act({ kind: 'press', ref: { snapshotId: before.snapshotId, index: button.index } });
    const after = await session.observe();
    assert.equal(after.nodes.find(n => n.label === 'Count')?.value, '1');
    console.log(JSON.stringify({ passed: true, scope: 'mock session loop only', before: before.text, after: after.text }, null, 2));
  } finally { await session.cancel(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
