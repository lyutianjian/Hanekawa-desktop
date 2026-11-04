import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import sharp from 'sharp'
import { DesktopComputerHost } from '../src/desktop/computer/host.js'
import { ComputerClient } from '../src/desktop/computer/client.js'
import { watchComputerDesktop } from '../src/desktop/computer/lifecycle.js'
import type { ComputerOperation } from '../src/runtime/protocol/computerHost.js'
const nativeTest = process.platform === 'win32' ? test.skip : test
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const bounds = { x: -200, y: 20, width: 800, height: 600 }
const windows = [{ id: 'w1', title: 'Example', role: 'AXWindow', bounds }]
const node = { index: 0, identity: 'n1', depth: 0, role: 'AXButton', label: '增加 😀', value: '0', actions: ['AXPress'], settable: false, writableAttributes: [], enabled: true, bounds }
interface ComputerState {
  appId: string; snapshotId: string; revision: number; baseRevision: number | null; mode: 'full' | 'diff'
  text: string; action?: unknown; complete: boolean; windowId?: string; wait?: { status: string; elapsedMs: number }
}

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
if(q.method==='bind'){bundleId=q.app;send({protocol:'hanekawa-computer/4',bundleId,name:'Example',processId:q.app==='other'?456:123,windows});}
else if(q.method==='list_windows')send(windows);
else if(q.method==='observe'){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:bundleId==='other'?456:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[{...${JSON.stringify(node)},value:String(value)}],truncated:false});}
else if(q.method==='screenshot')send({revision:++revision,sampledAt:Date.now(),processId:123,windowId:q.windowId,bounds,windowNumber:9,width:8,height:6,png});
else if(q.method==='status')send({protocol:'hanekawa-computer/4',accessibility:true,screenRecording:true,screenshotSupported:true});
else if(q.method==='list_apps')send([{bundleId:'example.app',name:'Example',processId:123}]);
else {value++;send({performed:true,observeRequired:true});}
});`
  await writeFile(executable, `#!${process.execPath}\n${source}`, { mode: 0o755 })
  const host = new DesktopComputerHost({ executable, platform: 'darwin', laneForSession: options.laneForSession })
  t.after(async () => { await host.dispose(); await rm(root, { recursive: true, force: true }) })
  const run = async (input: ComputerOperation, sessionId = 'chat-1', extra: { signal?: AbortSignal; timeoutMs?: number } = {}) => host.run({ sessionId, input, timeoutMs: 5000, ...extra })
  const events = async (): Promise<Array<{ pid: number; method: string; index?: number; revision?: number }>> => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const bind = async (app = 'example.app', sessionId = 'chat-1') => (await run({ operation: 'bind', app }, sessionId)).envelope.data as ComputerState
  return { root, executable, host, run, events, bind }
}
const data = (r: { envelope: { [key: string]: unknown } }) => r.envelope.data as ComputerState

function desktop(t: test.TestContext, host: DesktopComputerHost, initialState = 'active') {
  let state = initialState
  const monitor = Object.assign(new EventEmitter(), { getSystemIdleState: () => state })
  const off = watchComputerDesktop(host, monitor)
  t.after(off)
  return { monitor, off, setState: (next: string) => { state = next } }
}

nativeTest('lock cancels active and queued calls across chats, and recovery waits for stubborn helpers to exit', async t => {
  const f = await fixture(t, { prelude: "process.on('SIGTERM',()=>{});", hooks: "if(q.method==='click'){await new Promise(r=>setTimeout(r,30000));return;}" })
  const { monitor } = desktop(t, f.host)
  const first = await f.bind()
  const other = await f.bind('other', 'chat-2')
  const oldPids = new Set((await f.events()).map(e => e.pid))
  const running = assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'DESKTOP_UNAVAILABLE', delivery: 'unknown' })
  const end = Date.now() + 3000
  while (!(await f.events()).some(e => e.method === 'click')) {
    assert.ok(Date.now() < end, 'active input reached helper')
    await sleep(5)
  }
  const queued = assert.rejects(f.run({ operation: 'click', appId: other.appId, ref: `${other.snapshotId}:e0` }, 'chat-2'), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
  const queuedBind = assert.rejects(f.bind('third', 'chat-3'), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
  monitor.emit('lock-screen')
  await Promise.all([running, queued, queuedBind])
  await assert.rejects(f.run({ operation: 'list_apps' }), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
  monitor.emit('unlock-screen')
  await f.run({ operation: 'list_apps' })
  for (const pid of oldPids) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  await assert.rejects(f.run({ operation: 'get_state', appId: other.appId }, 'chat-2'), { code: 'SESSION_CLOSED' })
  const fresh = await f.bind()
  assert.notEqual(fresh.appId, first.appId)
  const events = await f.events()
  assert.equal(events.filter(e => e.method === 'click').length, 1, 'no replay or queued input')
  assert.equal(events.filter(e => e.method === 'bind').length, 3, 'only explicit fresh bind after recovery')
})

nativeTest('suspending during post-action observation preserves acknowledged delivery', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){await new Promise(r=>setTimeout(r,30000));return;}" })
  const { monitor } = desktop(t, f.host)
  const first = await f.bind()
  const running = assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'DESKTOP_UNAVAILABLE', delivery: 'delivered_unverified' })
  const end = Date.now() + 3000
  while ((await f.events()).filter(e => e.method === 'observe').length < 2) {
    assert.ok(Date.now() < end, 'post-action observation started')
    await sleep(5)
  }
  monitor.emit('suspend')
  await running
  monitor.emit('resume')
  await f.run({ operation: 'status' })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})

nativeTest('startup lock and sleep are independent; resuming alone cannot unlock desktop input', async t => {
  const f = await fixture(t)
  const { monitor, off, setState } = desktop(t, f.host, 'locked')
  await assert.rejects(f.bind(), { code: 'DESKTOP_UNAVAILABLE', delivery: 'not_delivered' })
  await assert.rejects(readFile(join(f.root, 'events')), { code: 'ENOENT' }, 'blocked desktop never spawns helper')
  monitor.emit('suspend')
  monitor.emit('resume')
  await assert.rejects(f.bind(), { code: 'DESKTOP_UNAVAILABLE' })
  setState('active')
  monitor.emit('unlock-screen')
  const first = await f.bind()
  monitor.emit('suspend')
  monitor.emit('unlock-screen')
  await assert.rejects(f.bind(), { code: 'DESKTOP_UNAVAILABLE' })
  monitor.emit('resume')
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  await f.bind()
  off()
  assert.deepEqual(monitor.eventNames(), [], 'teardown removes all lifecycle listeners')
  monitor.emit('lock-screen')
  assert.equal((await f.run({ operation: 'status' })).envelope.ok, true)
})

nativeTest('resume rechecks screen lock and preserves a known lock when the OS state is unknown', async t => {
  const f = await fixture(t)
  const { monitor, setState } = desktop(t, f.host)
  await f.bind()
  monitor.emit('suspend')
  setState('locked')
  monitor.emit('resume')
  await assert.rejects(f.bind(), { code: 'DESKTOP_UNAVAILABLE' }, 'lock event can arrive while Electron is asleep')
  setState('unknown')
  monitor.emit('resume')
  await assert.rejects(f.bind(), { code: 'DESKTOP_UNAVAILABLE' }, 'unknown does not override a known lock')
  setState('active')
  monitor.emit('resume')
  await f.bind()
})

nativeTest('helper failure during input drops the binding, rejects queued old calls and never replays', async t => {
  const faults = {
    crash: "process.kill(process.pid,'SIGKILL')",
    eof: "process.stdout.end();setInterval(()=>{},1000)",
    malformed: "process.stdout.write('{invalid\\n')",
  }
  for (const [name, fault] of Object.entries(faults)) await t.test(name, async t => {
    const f = await fixture(t, { hooks: `if(q.method==='click'){${fault};return;}` })
    const first = await f.bind()
    const pid = (await f.events())[0]!.pid
    const action = { operation: 'click' as const, appId: first.appId, ref: `${first.snapshotId}:e0` }
    await Promise.all([
      assert.rejects(f.run(action), { code: 'DRIVER_LOST', delivery: 'unknown' }),
      assert.rejects(f.run(action), { code: 'SESSION_CLOSED', delivery: 'not_delivered' }),
    ])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
    const fresh = await f.bind('example.app', 'chat-2')
    assert.notEqual(fresh.appId, first.appId)
  })
})

nativeTest('helper startup failure settles without delivery and host disposal does not hang', async () => {
  const host = new DesktopComputerHost({ executable: '/does/not/exist/hanekawa-computer', platform: 'darwin' })
  try {
    await assert.rejects(host.run({ sessionId: 'startup', input: { operation: 'status' }, timeoutMs: 1000 }), { code: 'DRIVER_LOST', delivery: 'not_delivered' })
  } finally { await host.dispose() }
})

nativeTest('an idle helper crash cannot leave an app lease blocking another chat', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  const pid = (await f.events())[0]!.pid
  process.kill(pid, 'SIGKILL')
  // A separate successful round trip lets the old transport receive EOF/close.
  await f.run({ operation: 'status' })
  const next = await f.bind('example.app', 'chat-2')
  assert.notEqual(next.appId, first.appId)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})

nativeTest('revoked permissions close the helper, reject queued old calls and release the app lease', async t => {
  for (const method of ['observe', 'screenshot', 'click', 'observe_with_screenshot']) await t.test(method, async t => {
    const f = await fixture(t, { hooks: `if(q.method===${JSON.stringify(method)} && fs.existsSync(log+'.revoked')){await new Promise(r=>setTimeout(r,30));fail('PERMISSION_REQUIRED');return;}` })
    const first = await f.bind()
    const pid = (await f.events())[0]!.pid
    const before = (await f.events()).length
    await writeFile(join(f.root, 'events.revoked'), '')
    const input: ComputerOperation = method === 'click' ? { operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }
      : method === 'screenshot' ? { operation: 'screenshot', appId: first.appId }
      : { operation: 'get_state', appId: first.appId, ...(method === 'observe_with_screenshot' ? { includeScreenshot: true } : {}) }
    await Promise.all([
      assert.rejects(f.run(input), { code: 'PERMISSION_REQUIRED', delivery: 'not_delivered' }),
      assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED', delivery: 'not_delivered' }),
    ])
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
    assert.equal((await f.events()).slice(before).filter(e => e.method === method).length, 1)
    await rm(join(f.root, 'events.revoked'))
    const fresh = await f.bind('example.app', 'chat-2')
    assert.notEqual(fresh.appId, first.appId)
    assert.equal(fresh.mode, 'full')
  })
})

nativeTest('permissions lost after action delivery preserve the receipt and do not replay input', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){fail('PERMISSION_REQUIRED');return;}" })
  const first = await f.bind()
  const pid = (await f.events())[0]!.pid
  await Promise.all([
    assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'PERMISSION_REQUIRED', delivery: 'delivered_unverified' }),
    assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED', delivery: 'not_delivered' }),
  ])
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  const fresh = await f.bind('example.app', 'chat-2')
  assert.notEqual(fresh.appId, first.appId)
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
})

nativeTest('an editor closing between post-action window listing and observation keeps its delivery receipt', async t => {
  const f = await fixture(t, { prelude: 'let closed=false;', hooks: `
if(q.method==='observe' && value>0){closed=true;fail('TARGET_CHANGED');return;}
if(q.method==='list_windows' && closed){send([]);return;}` })
  const first = await f.bind()
  const after = data(await f.run({ operation: 'press_key', appId: first.appId, snapshotId: first.snapshotId, key: 'return' }))
  assert.deepEqual(after.action, { performed: true, delivery: 'delivered_unverified', verified: false })
  assert.equal(after.wait?.status, 'unsupported')
  assert.equal(after.snapshotId, undefined, 'closed editor cannot authorize subsequent input')
  assert.equal(after.windowId, undefined)
  await assert.rejects(f.run({ operation: 'type_text', appId: first.appId, snapshotId: first.snapshotId, text: 'must not be sent' }), { code: 'STALE_SNAPSHOT' })
  await f.run({ operation: 'release', appId: first.appId })
  const events = await f.events()
  assert.equal(events.filter(e => e.method === 'press_key').length, 1)
  assert.equal(events.filter(e => e.method === 'type_text').length, 0)
})

nativeTest('post-action target changes with a surviving window still invalidate the binding', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){fail('TARGET_CHANGED');return;}" })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'press_key', appId: first.appId, snapshotId: first.snapshotId, key: 'return' }), { code: 'TARGET_CHANGED', delivery: 'delivered_unverified' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  assert.equal((await f.events()).filter(e => e.method === 'press_key').length, 1)
})

nativeTest('top-level AX surface roles reach the caller without being inferred from titles', async t => {
  const f = await fixture(t, { windows: [{ ...windows[0], role: 'AXTextField', title: '' }] })
  const first = await f.bind()
  const response = await f.run({ operation: 'get_state', appId: first.appId })
  assert.deepEqual((response.envelope.data as { windows: unknown }).windows, [{ ...windows[0], role: 'AXTextField', title: '' }])
})

nativeTest('a temporarily unreadable surface role does not discard an acknowledged action', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='list_windows' && value>0){send([...windows,{id:'w2',title:'',role:'',bounds}]);return;}` })
  const first = await f.bind()
  const after = await f.run({ operation: 'press_key', appId: first.appId, snapshotId: first.snapshotId, key: 'return' })
  assert.deepEqual(data(after).action, { performed: true, delivery: 'delivered_unverified', verified: false })
  assert.equal((await f.events()).filter(e => e.method === 'press_key').length, 1)
})

nativeTest('a process failure during closure confirmation never becomes a successful action result', async t => {
  const f = await fixture(t, { prelude: 'let changed=false;', hooks: `
if(q.method==='observe' && value>0){changed=true;fail('TARGET_CHANGED');return;}
if(q.method==='list_windows' && changed){fail('TARGET_CHANGED');return;}` })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'press_key', appId: first.appId, snapshotId: first.snapshotId, key: 'return' }), { code: 'TARGET_CHANGED', delivery: 'delivered_unverified' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  assert.equal((await f.events()).filter(e => e.method === 'press_key').length, 1)
})

nativeTest('resume without a suspend event still invalidates idle bindings and leases', async t => {
  const f = await fixture(t)
  const { monitor } = desktop(t, f.host)
  const first = await f.bind()
  const pid = (await f.events())[0]!.pid
  monitor.emit('resume')
  const next = await f.bind('example.app', 'chat-2')
  assert.notEqual(next.appId, first.appId)
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'SESSION_CLOSED' })
})

nativeTest('keyboard focus changes preserve partial delivery, drop the binding and stop queued old input', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='type_text'){await new Promise(r=>setTimeout(r,50));fail('TARGET_CHANGED','unknown');return;}" })
  const first = await f.bind()
  const input = { operation: 'type_text' as const, appId: first.appId, snapshotId: first.snapshotId, text: '中文😀' }
  const results = await Promise.allSettled([f.run(input), f.run(input)])
  assert.equal(results[0]!.status, 'rejected')
  assert.equal(results[1]!.status, 'rejected')
  if (results[0]!.status === 'rejected') {
    assert.equal(results[0]!.reason.code, 'TARGET_CHANGED')
    assert.equal(results[0]!.reason.delivery, 'unknown')
  }
  if (results[1]!.status === 'rejected') assert.equal(results[1]!.reason.code, 'SESSION_CLOSED')
  assert.equal((await f.events()).filter(event => event.method === 'type_text').length, 1)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  const fresh = await f.bind()
  assert.notEqual(fresh.appId, first.appId)
})

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
nativeTest('cancelling post-action observation preserves the acknowledged delivery receipt', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){await new Promise(r=>setTimeout(r,30000));return;}" })
  const first = await f.bind()
  const abort = new AbortController()
  const running = f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }, 'chat-1', { signal: abort.signal })
  const rejected = assert.rejects(running, { code: 'ABORTED', delivery: 'delivered_unverified' })
  const end = Date.now() + 2000
  while ((await f.events()).filter(e => e.method === 'observe').length < 2) {
    assert.ok(Date.now() < end, 'post-action observation started')
    await sleep(5)
  }
  abort.abort()
  await rejected
  await f.run({ operation: 'list_apps' })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})
nativeTest('post-action observation timeout preserves the acknowledged delivery receipt', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && value>0){await new Promise(r=>setTimeout(r,30000));return;}" })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }, 'chat-1', { timeoutMs: 1000 }),
    { code: 'ETIMEDOUT', delivery: 'delivered_unverified' })
  await f.run({ operation: 'list_apps' })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
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
const nodes=Array.from({length:300},(_,index)=>({...${JSON.stringify(node)},index,identity:'n'+(index+1),label:'A'.repeat(400)}));
send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds,nodes,truncated:false});return;
}` })
  const first = await f.bind()
  assert.match(first.text, /Output truncated/)
  const next = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.equal(next.complete, false)
  assert.match(next.text, /Full AX tree/)
  assert.doesNotMatch(next.text, /No AX tree changes/)
})

nativeTest('a natively truncated tree cannot become the next diff baseline', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe') {
send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[${JSON.stringify(node)}],truncated:revision===1});return;
}` })
  const first = data(await f.run({ operation: 'bind', app: 'example.app' }))
  assert.equal(first.complete, false)
  const next = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.equal(next.complete, true)
  assert.match(next.text, /Full AX tree/)
  assert.match(next.text, /增加 😀/)
  assert.doesNotMatch(next.text, /No AX tree changes/)
  const unchanged = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.match(unchanged.text, /No AX tree changes/)
})

nativeTest('returning from a subtree to the window starts a full observation', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe') {
const nodes=q.rootIndex===undefined
  ? [{...${JSON.stringify(node)},role:'AXWindow',label:'Window'}, {...${JSON.stringify(node)},index:1,identity:'n2',depth:1,label:'Sibling'}, {...${JSON.stringify(node)},index:2,identity:'n3',depth:1}]
  : [${JSON.stringify(node)}];
send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds,nodes,truncated:false});return;
}` })
  const first = await f.bind()
  const subtree = data(await f.run({ operation: 'get_state', appId: first.appId, rootRef: `${first.snapshotId}:e2` }))
  assert.match(subtree.text, /Full AX tree/)
  assert.doesNotMatch(subtree.text, /Sibling/)
  const next = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.match(next.text, /Full AX tree/)
  assert.match(next.text, /Sibling/)
  assert.match(next.text, /增加 😀/)
  assert.doesNotMatch(next.text, /No AX tree changes/)
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${subtree.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})

nativeTest('native truncation never reports omitted nodes as removed', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe') {
const nodes=revision===0 ? [${JSON.stringify(node)}, {...${JSON.stringify(node)},index:1,identity:'n2',label:'Still present outside the read budget'}] : [${JSON.stringify(node)}];
send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds,nodes,truncated:revision>1});return;
}` })
  const first = await f.bind()
  assert.match(first.text, /Still present outside the read budget/)
  const next = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.equal(next.complete, false)
  assert.match(next.text, /Full AX tree/)
  assert.doesNotMatch(next.text, /- e1|No AX tree changes/)
})

nativeTest('delayed conditions use fresh samples while intermediate reads preserve the published diff baseline', async t => {
  const f = await fixture(t, { prelude: 'let readyAt=Infinity;', hooks: `
if(q.method==='click')readyAt=Date.now()+650;
if(q.method==='observe' && value>0){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[{...${JSON.stringify(node)},value:Date.now()>=readyAt?'ready':'pending'}],truncated:false});return;}` })
  const first = await f.bind()
  assert.equal(first.mode, 'full')
  assert.equal(first.baseRevision, null)
  const action = data(await f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }))
  assert.equal(action.wait?.status, 'settled', 'a quiet AX tree can still have a pending business update')
  assert.match(action.text, /value="pending"/)
  assert.equal(action.baseRevision, first.revision)
  assert.ok(action.revision > first.revision + 1, 'intermediate samples advance native revisions but are not published baselines')
  const result = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 2000,
    condition: { kind: 'element', state: 'present', valueIncludes: 'ready' } }))
  assert.equal(result.wait?.status, 'matched')
  assert.match(result.text, /~ .*value="ready"/)
  assert.equal(result.baseRevision, action.revision)
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${action.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
})

nativeTest('local condition timeout retains the final usable snapshot and does not lose intermediate changes', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe'){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[{...${JSON.stringify(node)},value:String(revision)}],truncated:false});return;}` })
  const first = await f.bind()
  const result = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 350,
    condition: { kind: 'element', state: 'present', labelIncludes: 'never appears' } }))
  assert.equal(result.wait?.status, 'timed_out')
  assert.equal(result.complete, true)
  assert.match(result.text, /Diff:/)
  assert.match(result.text, /~ .*value="[2-9][0-9]*"/)
  assert.notEqual(result.snapshotId, first.snapshotId)
  await f.run({ operation: 'click', appId: first.appId, ref: `${result.snapshotId}:e0` })
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
})

nativeTest('continuously changing AX state exhausts settling without replaying the action', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe'){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[{...${JSON.stringify(node)},value:String(revision)}],truncated:false});return;}` })
  const first = await f.bind()
  const result = data(await f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }))
  assert.equal(result.wait?.status, 'timed_out')
  assert.deepEqual(result.action, { performed: true, delivery: 'delivered_unverified', verified: false })
  assert.match(result.text, /~ .*value=/)
  assert.equal((await f.events()).filter(e => e.method === 'click').length, 1)
})

nativeTest('truncation makes element waiting and automatic settling unsupported rather than proving absence', async t => {
  const f = await fixture(t, { hooks: `if(q.method==='observe'){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[${JSON.stringify(node)}],truncated:revision>1});return;}` })
  const first = await f.bind()
  const result = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 1000,
    condition: { kind: 'element', state: 'absent', labelIncludes: 'omitted' } }))
  assert.equal(result.wait?.status, 'unsupported')
  assert.equal(result.complete, false)
  const action = data(await f.run({ operation: 'click', appId: first.appId, ref: `${result.snapshotId}:e0` }))
  assert.equal(action.wait?.status, 'unsupported')
})

nativeTest('window waits detect opening without selecting the match, and closing without retaining stale refs', async t => {
  const f = await fixture(t, { prelude: 'let listings=0,liveWindows=windows;', hooks: `
if(q.method==='list_windows'){listings++;liveWindows=listings<3?windows:listings<6?[...windows,{...windows[0],id:'w2',title:'Dialog'}]:[];send(liveWindows);return;}
if(q.method==='observe'){send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows:liveWindows,bounds,nodes:[${JSON.stringify(node)}],truncated:false});return;}` })
  const first = await f.bind()
  const opened = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 2000,
    condition: { kind: 'window', state: 'present', titleIncludes: 'Dialog' } }))
  assert.equal(opened.wait?.status, 'matched')
  assert.equal(opened.windowId, 'w1')
  const closed = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 2000,
    condition: { kind: 'window', state: 'absent', windowId: 'w1' } }))
  assert.equal(closed.wait?.status, 'matched')
  assert.equal(closed.snapshotId, undefined)
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${opened.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})

nativeTest('cancelling polling drops the binding, stops further reads and never dispatches input', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  const abort = new AbortController()
  const waiting = f.run({ operation: 'wait_for', appId: first.appId, waitMs: 5000,
    condition: { kind: 'element', state: 'present', valueIncludes: 'never' } }, 'chat-1', { signal: abort.signal })
  const rejected = assert.rejects(waiting, { code: 'ABORTED' })
  const end = Date.now() + 2000
  while ((await f.events()).filter(e => e.method === 'observe').length < 2) {
    assert.ok(Date.now() < end)
    await sleep(5)
  }
  abort.abort()
  await rejected
  await f.run({ operation: 'list_apps' })
  const count = (await f.events()).length
  await sleep(150)
  assert.equal((await f.events()).length, count)
  assert.equal((await f.events()).some(e => e.method === 'click'), false)
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})

nativeTest('window conditions do not depend on a successful AX tree read in the selected window', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='observe' && revision>0){fail('NATIVE_ERROR');return;}" })
  const first = await f.bind()
  const result = data(await f.run({ operation: 'wait_for', appId: first.appId, waitMs: 1000,
    condition: { kind: 'window', state: 'present', windowId: 'w1' } }))
  assert.equal(result.wait?.status, 'matched')
  assert.equal(result.snapshotId, undefined, 'window-only evidence does not supply AX refs')
  assert.equal((await f.events()).filter(e => e.method === 'observe').length, 1)
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${first.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
})

nativeTest('wait_for shares the total deadline with queueing instead of renewing it for each sample', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='status')await new Promise(r=>setTimeout(r,250));" })
  const first = await f.bind()
  const start = performance.now()
  const occupying = f.run({ operation: 'status' })
  await assert.rejects(f.run({ operation: 'wait_for', appId: first.appId, waitMs: 5000,
    condition: { kind: 'element', state: 'present', valueIncludes: 'never' } }, 'chat-1', { timeoutMs: 500 }), { code: 'ETIMEDOUT' })
  await occupying
  assert.ok(performance.now() - start < 1500, 'polling did not acquire a fresh 5000ms deadline')
  await f.run({ operation: 'list_apps' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})

test('unsupported platforms return an explicit capability error without spawning', async () => {
  const host = new DesktopComputerHost({ executable: '/does/not/exist', platform: 'linux' })
  await assert.rejects(host.run({ sessionId: 'chat', input: { operation: 'status' }, timeoutMs: 500 }), { code: 'UNSUPPORTED' })
  await host.dispose()
})

nativeTest('full refresh, subtree, window change and screenshot declare the right diff baseline', async t => {
  const f = await fixture(t, { windows: [...windows, { ...windows[0], id: 'w2', title: 'Second' }] })
  const bound = await f.bind()
  const first = data(await f.run({ operation: 'get_state', appId: bound.appId, windowId: 'w1' }))
  assert.equal(first.mode, 'full')
  assert.equal(first.baseRevision, null)
  const diff = data(await f.run({ operation: 'get_state', appId: bound.appId }))
  assert.equal(diff.mode, 'diff')
  assert.equal(diff.baseRevision, first.revision)
  const full = data(await f.run({ operation: 'get_state', appId: bound.appId, disableDiffing: true }))
  assert.equal(full.mode, 'full')
  assert.equal(full.baseRevision, null)
  await assert.rejects(f.run({ operation: 'click', appId: bound.appId, ref: `${diff.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  const root = data(await f.run({ operation: 'get_state', appId: bound.appId }))
  const subtree = data(await f.run({ operation: 'get_state', appId: bound.appId, rootRef: `${root.snapshotId}:e0` }))
  assert.equal(subtree.mode, 'full')
  assert.equal(subtree.baseRevision, null)
  const restored = data(await f.run({ operation: 'get_state', appId: bound.appId }))
  assert.equal(restored.mode, 'full')
  const switched = data(await f.run({ operation: 'get_state', appId: bound.appId, windowId: 'w2' }))
  assert.equal(switched.mode, 'full')
  assert.equal(switched.baseRevision, null)
  await f.run({ operation: 'screenshot', appId: bound.appId })
  const afterShot = data(await f.run({ operation: 'get_state', appId: bound.appId }))
  assert.equal(afterShot.mode, 'full')
  assert.equal(afterShot.baseRevision, null)
  assert.ok(afterShot.revision > switched.revision)
})

nativeTest('old protocol, duplicate identities and non-advancing revisions are rejected', async t => {
  const old = await fixture(t, { hooks: "if(q.method==='status'){send({protocol:'hanekawa-computer/3',accessibility:true,screenRecording:true,screenshotSupported:true});return;}" })
  await assert.rejects(old.run({ operation: 'status' }), /Incompatible Computer helper.*npm run build:desktop/)
  for (const invalid of [
    `send({revision:++revision,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[${JSON.stringify(node)},{...${JSON.stringify(node)},index:1}],truncated:false});return;`,
    `send({revision:1,sampledAt:Date.now(),scope:q.scope??'window',processId:123,windowId:q.windowId,windows,bounds:q.scope==='application'?undefined:bounds,nodes:[${JSON.stringify(node)}],truncated:false});return;`,
  ]) {
    const f = await fixture(t, { hooks: `if(q.method==='observe' && revision>0){${invalid}}` })
    const first = await f.bind()
    await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'DRIVER_LOST' })
    await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  }
})

nativeTest('screenshot window identity is checked before creating a usable coordinate snapshot', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='screenshot'){send({revision:++revision,sampledAt:Date.now(),processId:123,windowId:'w2',bounds,windowNumber:9,width:8,height:6,png});return;}" })
  const first = await f.bind()
  await assert.rejects(f.run({ operation: 'screenshot', appId: first.appId }), { code: 'TARGET_CHANGED' })
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
})

nativeTest('application scope works without a window, preserves semantic actions and rejects physical input', async t => {
  const f = await fixture(t, { windows: [] })
  const bound = await f.bind()
  assert.equal(bound.snapshotId, undefined)
  const app = data(await f.run({ operation: 'get_state', appId: bound.appId, scope: 'application' }))
  assert.match(app.text, /AXButton/)
  assert.equal(app.windowId, undefined)
  assert.equal((app as unknown as Record<string, unknown>).boundsInPoints, undefined)
  const clicked = data(await f.run({ operation: 'click', appId: app.appId, ref: `${app.snapshotId}:e0` }))
  assert.equal(clicked.wait?.status, 'settled')
  await assert.rejects(f.run({ operation: 'press_key', appId: app.appId, snapshotId: clicked.snapshotId, key: 'cmd+s' }), { code: 'UNSUPPORTED', delivery: 'not_delivered' })
  assert.equal((await f.events()).filter(e => e.method === 'press_key').length, 0)
  await assert.rejects(f.run({ operation: 'click', appId: app.appId, ref: `${clicked.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  const waited = data(await f.run({ operation: 'wait_for', appId: app.appId, scope: 'application', waitMs: 100,
    condition: { kind: 'element', state: 'present', role: 'AXButton' } }))
  assert.equal(waited.wait?.status, 'matched')
})
nativeTest('switching observation scope forces full output and subtree refs cannot cross scopes', async t => {
  const f = await fixture(t)
  const first = await f.bind()
  const app = data(await f.run({ operation: 'get_state', appId: first.appId, scope: 'application' }))
  assert.equal(app.mode, 'full')
  const subtree = data(await f.run({ operation: 'get_state', appId: first.appId, rootRef: `${app.snapshotId}:e0` }))
  assert.equal((subtree as unknown as { scope: string }).scope, 'application')
  await assert.rejects(f.run({ operation: 'get_state', appId: first.appId, scope: 'window', rootRef: `${subtree.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  const window = data(await f.run({ operation: 'get_state', appId: first.appId }))
  assert.equal(window.mode, 'full')
})

const combinedHook = (change = '') => `if(q.method==='observe_with_screenshot'){
  const screenshot={revision:++revision,sampledAt:Date.now(),processId:123,windowId:q.windowId,bounds,windowNumber:9,width:8,height:6,png};
  const observation={revision:++revision,sampledAt:Date.now(),scope:'window',processId:123,windowId:q.windowId,windows,bounds,nodes:[${JSON.stringify(node)}],truncated:false};
  ${change}
  send({screenshot,observation});return;
}`
nativeTest('combined AX and screenshot have one usable snapshot and independent sample provenance', async t => {
  const f = await fixture(t, { hooks: combinedHook() })
  const first = await f.bind()
  const response = await f.run({ operation: 'get_state', appId: first.appId, includeScreenshot: true })
  const current = response.envelope.data as ComputerState & { screenshot: { revision: number; sampledAt: number }; sampledAt: number; atomic: boolean }
  assert.ok(response.image?.bytes.length)
  assert.doesNotMatch(JSON.stringify(response.envelope), /base64|"png"/)
  assert.equal(current.mode, 'full')
  assert.equal(current.atomic, false)
  assert.ok(current.revision > current.screenshot.revision && current.screenshot.sampledAt <= current.sampledAt)
  await f.run({ operation: 'click', appId: first.appId, ref: `${current.snapshotId}:e0` })
  const next = data(await f.run({ operation: 'get_state', appId: first.appId, includeScreenshot: true }))
  await f.run({ operation: 'click_at', appId: first.appId, snapshotId: next.snapshotId, x: 10, y: 10 })
})
nativeTest('combined reads reject changed windows, process, geometry and revision without publishing references', async t => {
  for (const [change, code] of [
    ["screenshot.windowId='w2';", 'TARGET_CHANGED'],
    ["observation.processId=456;", 'TARGET_CHANGED'],
    ["observation.bounds={...bounds,x:bounds.x+20};", 'TARGET_CHANGED'],
    ["observation.revision=screenshot.revision;", 'DRIVER_LOST'],
  ]) {
    const f = await fixture(t, { hooks: combinedHook(change) })
    const first = await f.bind()
    await assert.rejects(f.run({ operation: 'get_state', appId: first.appId, includeScreenshot: true }), { code })
    await assert.rejects(f.run({ operation: 'get_state', appId: first.appId }), { code: 'SESSION_CLOSED' })
  }
})

nativeTest('focus and text selection consume fresh refs and never fall back to physical input', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='select_text'){fail('UNSUPPORTED');return;}" })
  const first = await f.bind()
  const focused = data(await f.run({ operation: 'focus', appId: first.appId, ref: `${first.snapshotId}:e0` }))
  await assert.rejects(f.run({ operation: 'select_text', appId: first.appId, ref: `${focused.snapshotId}:e0`, selection: { text: 'same', prefix: '/ ' } }), { code: 'UNSUPPORTED', delivery: 'not_delivered' })
  await assert.rejects(f.run({ operation: 'click', appId: first.appId, ref: `${focused.snapshotId}:e0` }), { code: 'STALE_SNAPSHOT' })
  const events = await f.events()
  assert.equal(events.filter(e => e.method === 'select_text').length, 1)
  assert.equal(events.some(e => ['click_at', 'press_key', 'type_text'].includes(e.method)), false)
})
nativeTest('diagnostics record numeric stages, observation cost and failure disposition without application text', async t => {
  const f = await fixture(t, { hooks: "if(q.method==='set_value'){fail('UNSUPPORTED');return;}" })
  const bound = await f.run({ operation: 'bind', app: 'example.app' })
  const first = data(bound)
  assert.ok(bound.diagnostics?.nativeRequests && bound.diagnostics.nativeRequests >= 3)
  assert.equal(bound.diagnostics?.observations, 1)
  assert.equal(bound.diagnostics?.mode, 'full')
  assert.equal(bound.diagnostics?.textChars, first.text.length)
  assert.ok(bound.diagnostics?.stages.bind)
  assert.ok(bound.diagnostics?.stages.observe)
  const secret = 'DO_NOT_RECORD_TYPED_CONTENT_9X'
  await assert.rejects(f.run({ operation: 'set_value', appId: first.appId, ref: `${first.snapshotId}:e0`, value: secret }), (error: unknown) => {
    const e = error as { diagnostics: { errorCode: string; delivery: string; appId: string } }
    assert.equal(e.diagnostics.errorCode, 'UNSUPPORTED')
    assert.equal(e.diagnostics.delivery, 'not_delivered')
    assert.equal(e.diagnostics.appId, first.appId)
    assert.doesNotMatch(JSON.stringify(e.diagnostics), /DO_NOT_RECORD|增加|AXButton/)
    return true
  })
  const other = await f.run({ operation: 'list_apps' }, 'chat-2')
  assert.notEqual(other.diagnostics?.requestId, bound.diagnostics?.requestId)
  assert.equal(other.diagnostics?.sessionId, 'chat-2')
  assert.equal(other.diagnostics?.appId, undefined)
})
