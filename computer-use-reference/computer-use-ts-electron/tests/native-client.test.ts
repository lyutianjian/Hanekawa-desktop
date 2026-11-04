import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlClient } from '../src/drivers/macos/jsonl-client';
import { AutomationError } from '../src/shared/errors';

/** Fixture child emulates transport failures; it never calls macOS APIs. */
async function withClient(mode: string, run: (client: JsonlClient) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'cu-reference-test-'));
  const file = join(dir, 'helper');
  const source = `#!${process.execPath}
const mode = ${JSON.stringify(mode)};
let text = '';
process.stdin.on('data', b => {
 text += b;
 if (!text.includes('\\n')) return;
 const req = JSON.parse(text.slice(0, text.indexOf('\\n'))); text = '';
 if(mode==='hang') return;
 if(mode==='crash') process.exit(2);
 if(mode==='oversize') { process.stdout.write('a'.repeat(1048577)); return; }
 if(mode==='malformed') { process.stdout.write('{bad}\\n'); return; }
 if(mode==='mismatch') { process.stdout.write(JSON.stringify({id:req.id+1,result:{}})+'\\n'); return; }
 const data=Buffer.from(JSON.stringify({id:req.id,result:{text:'中文 😀'}})+'\\n');
 let i=0;const timer=setInterval(()=>{if(i===data.length){clearInterval(timer);return;}process.stdout.write(data.subarray(i,i+1));i++;},1);
});
`;
  await writeFile(file, source, { mode: 0o700 });
  const client = new JsonlClient(file, 'com.apple.calculator');
  try { client.start(); await run(client); }
  finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
}
test('JSONL transport retains split UTF-8 bytes and correlates a response', async () => {
  await withClient('unicode', async client => {
    assert.deepEqual(await client.request('observe', {}, new AbortController().signal), { text: '中文 😀' });
  });
});
for (const mode of ['crash', 'oversize', 'malformed', 'mismatch']) {
  test(`JSONL transport rejects ${mode} and cannot reuse the broken channel`, async () => {
    await withClient(mode, async client => {
      await assert.rejects(client.request('observe', {}, new AbortController().signal), (error: unknown) => error instanceof AutomationError && error.code === 'DRIVER_LOST');
      await assert.rejects(client.request('observe', {}, new AbortController().signal));
    });
  });
}
test('abort rejects a pending native request and teardown waits for child exit', async () => {
  await withClient('hang', async client => {
    const abort = new AbortController();
    const pending = client.request('observe', {}, abort.signal);
    const rejected = assert.rejects(pending, (error: unknown) => error instanceof AutomationError && error.code === 'CANCELLED');
    abort.abort(new AutomationError('CANCELLED', 'Test cancel', 'unknown'));
    await rejected; await client.close();
  });
});
