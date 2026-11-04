import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { DesktopComputerHost } from '../src/desktop/computer/host.js'
import { ComputerClient } from '../src/desktop/computer/client.js'
import type { ComputerOperation } from '../src/runtime/protocol/computerHost.js'
const nativeTest = process.platform === 'win32' ? test.skip : test
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const bounds = { x: -200, y: 20, width: 800, height: 600 }
const windows = [{ id: 'w1', title: 'Example', bounds }]
const node = { index: 0, depth: 0, role: 'AXButton', label: '增加 😀', value: '0', actions: ['AXPress'], settable: false, enabled: true, bounds }

async function fixture(t: test.TestContext, options: { prelude?: string; hooks?: string; windows?: unknown[]; laneForSession?: (sessionId: string) => string | undefined } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'computer-host-'))
  const executable = join(root, 'helper')
  const log = join(root, 'events')
  const png = (await sharp({ create: { width: 8, height: 6, channels: 3, background: 'white' } }).png().toBuffer()).toString('base64')
  const source = `const fs=require('node:fs'),rl=require('node:readline');
const log=${JSON.stringify(log)}, png=${JSON.stringify(png)}, bounds=${JSON.stringify(bounds)}, windows=${JSON.stringify(options.windows ?? windows)};
let revision=0, value=0, bundleId='example.app';
${options.prelude ?? ''}
rl.createInterface({input:process.stdin}).on('line',async line=>{
const q=JSON.parse(line);fs.appendFileSync(log,JSON.stringify({pid:process.pid,...q})+'\\n');
const send=result=>process.stdout.write(JSON.stringify({id:q.id,result})+'\\n');
const fail=(code,delivery='not_delivered')=>process.stdout.write(JSON.stringify({id:q.id,error:{code,message:code,delivery}})+'\\n');
${options.hooks ?? ''}
if(q.method==='bind'){bundleId=q.app;send({protocol:'hanekawa-computer/1',bundleId,name:'Example',processId:q.app==='other'?456:123,windows});}
else if(q.method==='list_windows')send(windows);
else if(q.method==='observe'){send({revision:++revision,processId:bundleId==='other'?456:123,windowId:q.windowId,windows,bounds,nodes:[{...${JSON.stringify(node)},value:String(value)}],truncated:false});}
else if(q.method==='screenshot')send({revision:++revision,processId:123,windowId:q.windowId,bounds,windowNumber:9,width:8,height:6,png});
else if(q.method==='status')send({protocol:'hanekawa-computer/1',accessibility:true,screenRecording:true,screenshotSupported:true});
else if(q.method==='list_apps')send([{bundleId:'example.app',name:'Example',processId:123}]);
else {value++;send({performed:true,observeRequired:true});}
});`
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  const host = new DesktopComputerHost({ executable, platform: 'darwin', laneForSession: options.laneForSession })
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }) })
  const run = async (input: ComputerOperation, sessionId = 'chat-1', extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => host.run({ sessionId, input, timeoutMs: 5000, ...extra })
  const events = async (): Promise<Array<{ pid: number; method: string; index?: number; revision?: number }>> => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const bind = async (app = 'example.app', sessionId = 'chat-1') => (await run({ operation: 'bind', app }, sessionId)).envelope.data as { appId: string; snapshotId: string; text: string; windowId: string }
  return { root, executable, host, run, events, bind }
}
const data = (r: { envelope: { [key: string]: unknown } }) => r.envelope.data as { appId: string; snapshotId: string; text: string; action?: unknown; complete: boolean }

nativeTest('app binding persists, action returns fresh diff, and old refs never replay', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  assert.match(first.text, /增加 😀/)
  const next = data(await f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }))
  assert.match(next.text, /Diff:/)
  assert.match(next.text, /value="1"/)
  assert.notEqual(next.snapshotId, first.snapshotId)
  assert.deepEqual(next.action, { performed: true, delivery: 'delivered_unverified', verified: false })
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${next.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' }, 'failed attempt consumed current snapshot too')
  const fresh = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.match(fresh.text, /No AX tree changes/)
  await f.run({ operation: 'click', appId: first.appId, ref: `${fresh.snapshotId}:e0` })
  const events = await f.events()
  assert.equal(new Set(events.map(e => e.pid)).size, 1, 'one persistent helper')
  assert.equal(events.filter(e => e.method === 'click').length, 2)
})
nativeTest('bindings cannot cross chats; app lease releases without quitting target', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }, 'chat-2'), { code: 'SESSION_CLOSED' })
  await assert.rejects(f.bind('example.app', 'chat-2'), { code: 'TARGET_BUSY' })
  const rebound = await f.bind()
  assert.equal(first.appId, rebound.appId)
  await f.run({ operation: 'release', appId: first.appId })
  await f.bind('example.app', 'chat-2')
  assert.ok(!(await f.events()).some(e => e.method.includes('quit')))
})
nativeTest('multiple windows require explicit selection and retain it across observations', async t => {
  const f = await fixture(t, { windows: [...windows, { ...windows[0], id: 'w2', title: 'Second' }] })
  const first = await f.bind()
  assert.equal(first.snapshotId, undefined)
  const selected = data(await f.run({ operation: 'get_state', appId: first.appId, windowId: 'w2' }))
  assert.match(selected.snapshotId, /^s/)
  assert.equal((await f.run({ operation: 'get_state', appId: first.appId })).envelope.ok, true)
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${selected.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})
nativeTest('subtree observation validates the current root and forces a full tree', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  const subtree = data(await f.run({ operation: 'get_state', appId: first.appId, rootRef: `${first.snapshotId}:e0` }))
  assert.match(subtree.text, /Full AX tree/)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId, rootRef: `${first.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})
nativeTest('screenshot invalidates AX refs, returns bounded bytes and only pixel metadata in envelope', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  const shot = await f.run({ operation: 'screenshot', appId: first.appId })
  assert.ok(shot.image?.bytes.length)
  assert.doesNotMatch(JSON.stringify(shot.envelope), /png|base64/)
  const s = data(shot)
  await f.run({ operation: 'click_at', appId: first.appId, snapshotId: s.snapshotId, x: 10, y: 20 })
  await f.run({ operation: 'screenshot', appId: first.appId })
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})
nativeTest('failure after delivered input preserves unknown outcome and never repeats input', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){fail('NATIVE_ERROR','unknown');return;}" })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { delivery: 'delivered_unverified' })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
})
nativeTest('invalid native schema tears down the binding rather than trusting partial data', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){send({revision:2,nodes:[]});return;}" })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'DRIVER_LOST', delivery: 'delivered_unverified' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})
nativeTest('global queue includes waiting deadline and cancelling a waiter never overtakes active input', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='status')await new Promise(r=>setTimeout(r,200));" })
  const first = f.run({ operation: 'status' })
  await assert.rejects(f.run({ operation: 'list_apps' }, 'chat-1', { timeoutMs: 30 }), { code: 'ETIMEDOUT', delivery: 'not_delivered' })
  const third = f.run({ operation: 'list_apps' })
  await Promise.all([first, third])
  assert.deepEqual((await f.events()).map(e => e.method), ['status', 'list_apps'])
})
nativeTest('active cancellation kills even a stubborn helper before the next desktop call', async t => {
  const f = await fixture(t, { prelude: "process.on('SIGTERM',()=>{});", hooks: "if(q.method==='click'){await new Promise(r=>setTimeout(r,30000));return;}" })
  const first = await f.bind()
  const abort = new AbortController()
  const running = f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }, 'chat-1', { signal: abort.signal })
  const rejected = assert.rejects(running, { code: 'ABORTED', delivery: 'unknown' })
  while (!(await f.events()).some(e => e.method === 'click')) await sleep(5)
  abort.abort()
  await rejected
  await f.run({ operation: 'list_apps' })
  const event = (await f.events()).find(e => e.method === 'click')!
  assert.throws(() => process.kill(event.pid, 0), { code: 'ESRCH' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})
nativeTest('lane teardown kills all owned helpers and late requests cannot resurrect them', async t => {
  let alive = true
  const f = await fixture(t, { laneForSession: () => alive ? 'lane-1' : undefined })
  const first = await f.bind()
  alive = false; f.host.closeLane('lane-1')
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  await f.host.dispose()
  const pid = (await f.events())[0]!.pid
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})
nativeTest('an idle helper fully exits before a released app is bound by another chat', async t => {
  const f = await fixture(t, { prelude: "process.on('SIGTERM',()=>{});" })
  await f.bind()
  const pid = (await f.events())[0]!.pid
  f.host.closeLane('chat-1')
  await f.bind('example.app', 'chat-2')
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
})

nativeTest('session switch reaps an old lease while keeping the lane alive', async t => {
  let activeSession = 'chat-1'
  const f = await fixture(t, { laneForSession: sessionId => sessionId === activeSession ? 'lane-1' : undefined })
  const first = await f.bind()
  activeSession = 'chat-2'
  await f.host.reapClosedSessions()
  const second = await f.bind('example.app', 'chat-2')
  assert.notEqual(first.appId, second.appId)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }, 'chat-2'), { code: 'SESSION_CLOSED' })
})

nativeTest('native transport rejects bad IDs, malformed envelopes, EOF and invalid UTF-8', async t => {
  for (const output of ["process.stdout.write('{bad\\n')", "send=1", "process.stdout.write(JSON.stringify({id:999,result:{}})+'\\n')", "process.stdout.write(Buffer.from([0xff,10]))", "process.exit(0)"]) {
    const f = await fixture(t, { hooks: output === 'send=1' ? "process.stdout.write(JSON.stringify({id:q.id,result:{},error:{}})+'\\n');return;" : `${output};return;` })
    const client = new ComputerClient(f.executable)
    try { await assert.rejects(client.request('status', {}, AbortSignal.timeout(2000))) }
    finally { await client.close() }
  }
})
nativeTest('transport decodes a multibyte code point split across pipe reads', async t => {
  const f = await fixture(t, { hooks: `const bytes=Buffer.from(JSON.stringify({id:q.id,result:{text:'汉😀'}})+'\\n');
const at=bytes.indexOf(Buffer.from('汉'));
process.stdout.write(bytes.subarray(0,at+1));
setTimeout(()=>process.stdout.write(bytes.subarray(at+1)),20);return;` })
  const client = new ComputerClient(f.executable)
  try { assert.deepEqual(await client.request('status', {}, AbortSignal.timeout(2000)), { text: '汉😀' }) }
  finally { await client.close() }
})

nativeTest('a truncated text tree cannot become an empty complete diff on the next read', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe') {
const nodes=Array.from({length:300},(_,index)=>({...${JSON.stringify(node)},index,label:'A'.repeat(400)}));
send({revision:++revision,processId:123,windowId:q.windowId,windows,bounds,nodes,truncated:false});return;
}` })
  const first = await f.bind()
  assert.match(first.text, /Output truncated/)
  const next = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.equal(next.complete, false)
  assert.match(next.text, /Full AX tree/)
  assert.doesNotMatch(next.text, /No AX tree changes/)
})

test('unsupported platforms return an explicit capability error without spawning', async () => {
  const host = new DesktopComputerHost({ executable: '/does/not/exist', platform: 'linux' })
  await assert.rejects(host.run({ sessionId: 'chat', input: { operation: 'status' }, timeoutMs: 500 }), { code: 'UNSUPPORTED' })
  await host.dispose()
})
