import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopComputerHost } from '../src/desktop/computer/host.js'
import type { ComputerRequest } from '../src/runtime/protocol/computerHost.js'

const nativeTest = process.platform === 'win32' ? test.skip : test

async function fixture(t: test.TestContext, source: string) {
  const root = await mkdtemp(join(tmpdir(), 'computer-host-'))
  const nativeDir = join(root, 'native')
  const stateDir = join(root, 'state')
  await mkdir(nativeDir)
  await writeFile(join(nativeDir, 'agent-desktop'), `#!${process.execPath}\n${source}`, { mode: 0o755 })
  const host = new DesktopComputerHost({ nativeDir, stateDir })
  t.after(async () => { host.dispose(); await rm(root, { recursive: true, force: true }) })
  const request = (overrides: Partial<ComputerRequest> = {}): ComputerRequest => ({
    sessionId: 'chat-one', command: 'status', args: [], headed: false, timeoutMs: 5_000, ...overrides,
  })
  return { host, request, stateDir }
}

nativeTest('native process receives an isolated stable namespace and owned state path', async (t) => {
  const { host, request, stateDir } = await fixture(t, `
console.log(JSON.stringify({ok:true, data:{args:process.argv.slice(2), home:process.env.AGENT_DESKTOP_HOME, agent:process.env.AGENT_DESKTOP_AGENT_ID}}));
`)
  const first = await host.run(request())
  const same = await host.run(request())
  const other = await host.run(request({ sessionId: 'chat-two', headed: true }))
  const data = first.envelope.data as { args: string[]; home: string }
  assert.equal(data.home, stateDir)
  assert.match(data.args[1]!, /^hanekawa-[a-f0-9]{48}$/)
  assert.ok(data.args[1]!.length <= 64, 'native session ids are limited to 64 characters')
  assert.deepEqual(first.envelope, same.envelope)
  assert.notDeepEqual(first.envelope, other.envelope)
  assert.equal((other.envelope.data as { args: string[] }).args[2], '--headed')
})

nativeTest('nonzero exit keeps native error envelope; help accepts text and malformed output fails', async (t) => {
  const { host, request } = await fixture(t, `
if (process.argv.includes('--help')) console.log('Usage: snapshot --app APP');
else if (process.argv.includes('broken')) console.log('invalid json');
else { console.log(JSON.stringify({ok:false,error:{code:'STALE_REF',disposition:{delivery:'not_delivered',retry:'safe'}}})); process.exitCode=1; }
`)
  const error = await host.run(request())
  assert.equal(error.envelope.ok, false)
  assert.deepEqual(error.envelope.error, { code: 'STALE_REF', disposition: { delivery: 'not_delivered', retry: 'safe' } })
  const help = await host.run(request({ command: 'snapshot', args: ['--help'] }))
  assert.match((help.envelope.data as { content: string }).content, /Usage:/)
  await assert.rejects(host.run(request({ command: 'broken' })), /invalid JSON/)
})

nativeTest('screenshot is written only to a private scratch path and removed after reading', async (t) => {
  const { host, request, stateDir } = await fixture(t, `
const fs=require('node:fs'); const path=process.argv.at(-1);
fs.writeFileSync(path, Buffer.from('PNG pixels'));
console.log(JSON.stringify({ok:true,data:{path}}));
`)
  const response = await host.run(request({ command: 'screenshot', args: ['--app=TextEdit'] }))
  assert.equal(response.image?.bytes.toString(), 'PNG pixels')
  const path = (response.envelope.data as { path: string }).path
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  assert.deepEqual(await readdir(stateDir), [])
})

nativeTest('literal --help typed into an app is not treated as a help request', async (t) => {
  const { host, request } = await fixture(t, `console.log(JSON.stringify({ok:false,error:{code:'ACTION_FAILED'}}));`)
  const response = await host.run(request({ command: 'type', args: ['--', '@s1:e1', '--help'] }))
  assert.equal(response.envelope.ok, false)
  assert.deepEqual(response.envelope.error, { code: 'ACTION_FAILED' })
})

nativeTest('desktop calls serialize; cancellation of a queued slot does not release later calls early', async (t) => {
  const { host, request, stateDir } = await fixture(t, `
const fs=require('node:fs'),path=require('node:path'); const command=process.argv.at(-1);
const log=path.join(process.env.AGENT_DESKTOP_HOME,'events');
fs.appendFileSync(log,command+' start\\n');
setTimeout(()=>{fs.appendFileSync(log,command+' end\\n'); console.log(JSON.stringify({ok:true}));}, command==='first'?200:5);
`)
  const abort = new AbortController()
  const first = host.run(request({ command: 'first' }))
  const queued = host.run(request({ command: 'cancelled', signal: abort.signal }))
  const third = host.run(request({ command: 'third' }))
  const rejected = assert.rejects(queued, { name: 'AbortError' })
  abort.abort()
  await rejected
  await Promise.all([first, third])
  assert.equal(await readFile(join(stateDir, 'events'), 'utf8'), 'first start\nfirst end\nthird start\nthird end\n')
})

nativeTest('deadline includes queueing; stopping active calls and disposing terminates execution', async (t) => {
  const { host, request } = await fixture(t, `setTimeout(()=>console.log(JSON.stringify({ok:true})), 30000);`)
  const abort = new AbortController()
  const running = host.run(request({ signal: abort.signal }))
  const stopped = assert.rejects(running, { name: 'AbortError' })
  await assert.rejects(host.run(request({ timeoutMs: 100 })), { code: 'ETIMEDOUT' })
  abort.abort()
  await stopped
  const next = host.run(request())
  const disposed = assert.rejects(next, /host has closed/)
  host.dispose()
  await disposed
  await assert.rejects(host.run(request()), /host has closed/)
})
