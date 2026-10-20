import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BackgroundTaskRegistry,
  MONITOR_MAX_PENDING_LINES,
} from '../src/services/backgroundTasks/registry.js'
import { createMonitorTool } from '../src/tools/MonitorTool/MonitorTool.js'
import { classifyToolCall, createRiskContext } from '../src/harness/risk/index.js'

const SESSION = 'monitor-session'
const node = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)

function context() {
  return { cwd: process.cwd(), sessionId: SESSION, readFiles: new Set<string>() }
}

function fakeMonitor(registry: BackgroundTaskRegistry) {
  const emitter = new EventEmitter()
  const kill = () => {
    setImmediate(() => emitter.emit('close'))
    return true
  }
  const proc = Object.assign(emitter, { pid: undefined, exitCode: null, signalCode: null, kill }) as unknown as ChildProcess
  return registry.registerShell({ sessionId: SESSION, command: 'fake', proc, monitor: { description: 'errors in dev.log' } })
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('monitor stdout lines are delivered as one quiet note per monitor, stderr left out', async () => {
  const registry = new BackgroundTaskRegistry()
  const monitor = createMonitorTool(registry)
  const script = "console.log('ERROR one'); console.error('noise'); setTimeout(() => console.log('ERROR two'), 200)"
  const result = await monitor.execute({ command: `${node} -e "${script}"`, description: 'errors in dev.log' }, context())
  assert.equal(result.ok, true)
  const taskId = result.content.match(/Monitor started \(task (bash_\d+)/)?.[1]
  assert.ok(taskId)

  await waitFor(() => registry.getTask(SESSION, taskId)?.status !== 'running')
  // Monitor events never wake an idle session.
  assert.equal(registry.hasParentNotifications(SESSION), false)
  const notes = registry.consumeParentNotifications(SESSION)
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, new RegExp(`Monitor ${taskId} \\(errors in dev.log\\) events`))
  assert.match(notes[0]!, /ERROR one\nERROR two\n/)
  assert.doesNotMatch(notes[0]!, /noise/)
  assert.match(notes[0]!, /ended: the script exited with code 0/)
  assert.deepEqual(registry.consumeParentNotifications(SESSION), [])
})

test('a monitor past its deadline ends with a notice', async () => {
  const registry = new BackgroundTaskRegistry()
  const monitor = createMonitorTool(registry)
  const result = await monitor.execute({
    command: `${node} -e "setInterval(() => {}, 1000)"`,
    description: 'nothing',
    timeout_ms: 1_000,
  }, context())
  const taskId = result.content.match(/task (bash_\d+)/)?.[1]
  await waitFor(() => registry.getTask(SESSION, taskId!)?.status === 'failed')
  const [note] = registry.consumeParentNotifications(SESSION)
  assert.match(note ?? '', /ended: Command timed out after 1000ms/)
})

test('monitor lines split across chunks are joined, and the last unterminated line flushed at exit', () => {
  const registry = new BackgroundTaskRegistry()
  const task = fakeMonitor(registry)
  registry.appendMonitorStdout(SESSION, task.id, Buffer.from('par'))
  assert.deepEqual(registry.consumeParentNotifications(SESSION), [])
  registry.appendMonitorStdout(SESSION, task.id, Buffer.from('tial\r\ntail'))
  assert.match(registry.consumeParentNotifications(SESSION)[0]!, /events[^\n]*\npartial\n/)
  registry.finishShell(SESSION, task.id, 1, null)
  assert.match(registry.consumeParentNotifications(SESSION)[0]!, /\ntail\nMonitor bash_1 ended: Command exited with code 1\./)
})

test('a monitor backlog keeps the newest lines; idle overflow only truncates, mid-turn overflow stops it', async () => {
  const registry = new BackgroundTaskRegistry()
  const task = fakeMonitor(registry)
  const flood = () => registry.appendMonitorStdout(
    SESSION,
    task.id,
    Buffer.from(Array.from({ length: MONITOR_MAX_PENDING_LINES + 5 }, (_, i) => `line ${i}`).join('\n') + '\n'),
  )

  flood()
  const [idle] = registry.consumeParentNotifications(SESSION, false)
  assert.match(idle!, /\[5 earlier lines omitted\]\nline 5\n/)
  assert.match(idle!, new RegExp(`line ${MONITOR_MAX_PENDING_LINES + 4}$`, 'm'))
  assert.equal(registry.getTask(SESSION, task.id)?.status, 'running')

  flood()
  const [busy] = registry.consumeParentNotifications(SESSION, true)
  assert.match(busy!, /was stopped: more than 50 lines arrived between two steps/)
  await waitFor(() => registry.getTask(SESSION, task.id)?.status === 'killed')
  assert.deepEqual(registry.consumeParentNotifications(SESSION), [])
})

test('Monitor commands are graded exactly as Bash commands', () => {
  const ctx = createRiskContext({ cwd: process.cwd() })
  for (const command of ['tail -f app.log | grep --line-buffered ERROR', 'rm -rf ~', 'git push --force']) {
    const bash = classifyToolCall({ name: 'Bash', riskLevel: 'dangerous' }, { command }, ctx)
    const monitor = classifyToolCall({ name: 'Monitor', riskLevel: 'dangerous' }, { command, description: 'x' }, ctx)
    assert.equal(monitor.level, bash.level, command)
  }
})
