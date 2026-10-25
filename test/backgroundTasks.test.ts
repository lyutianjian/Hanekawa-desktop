import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  BackgroundTaskRegistry,
  MAX_BACKGROUND_OUTPUT_BYTES,
  MAX_BACKGROUND_OUTPUT_FILE_BYTES,
} from '../src/services/backgroundTasks/registry.js'
import { createBashTool, isDevServerCommand } from '../src/tools/BashTool/BashTool.js'
import { createKillShellTool } from '../src/tools/KillShellTool/KillShellTool.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import type { SessionRecord } from '../src/harness/types.js'

function context() {
  return { cwd: process.cwd(), sessionId: 'session-1', readFiles: new Set<string>() }
}

test('background Bash writes its output to a file and notifies with the last lines', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  try {
    await bash.execute({ command: 'echo warmup' }, context())
    const startedAt = Date.now()
    // Windows shell detection prefers Git Bash, where PowerShell's `& ` call
    // operator is a syntax error; bare `node` from PATH works in both shells.
    const executable = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)
    const command = `${executable} -e "console.log('first'); setTimeout(() => console.log('second'), 400)"`
    const result = await bash.execute({
      command,
      run_in_background: true,
    }, context())
    assert.equal(result.ok, true)
    assert.ok(Date.now() - startedAt < 350)
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)
    const outputPath = registry.getTask('session-1', taskId)?.outputPath
    assert.ok(outputPath)
    assert.ok(result.content.includes(`Output is being written to ${outputPath}`))

    await waitFor(() => registry.hasParentNotifications('session-1'))
    const [note] = registry.consumeParentNotifications('session-1')
    assert.match(note ?? '', new RegExp(`Background shell ${taskId} completed`))
    assert.ok(note?.includes(`Full output: ${outputPath}`))
    assert.match(note ?? '', /first\r?\nsecond/)
    assert.match(await readFile(outputPath, 'utf8'), /^first\r?\nsecond/)
    const read = await readFileTool.execute({ filePath: outputPath }, context())
    assert.equal(read.ok, true)
    assert.match(read.content, /second/)
  } finally {
    await registry.stopAll()
  }
})

test('KillShell terminates a running task and is idempotent for terminal tasks', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  const kill = createKillShellTool(registry)
  try {
    // node one-liner keeps the task alive in both Git Bash and PowerShell.
    const command = `${process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)} -e "setTimeout(() => {}, 30000)"`
    const result = await bash.execute({ command, run_in_background: true }, context())
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)
    const killed = await kill.execute({ task_id: taskId }, context())
    assert.equal(killed.ok, true)
    assert.equal(registry.getTask('session-1', taskId)?.status, 'killed')
    const again = await kill.execute({ task_id: taskId }, context())
    assert.equal(again.ok, true)
    assert.match(again.content, /already killed/)
  } finally {
    await registry.stopAll()
  }
})

test('an explicit background timeout terminates the task as failed', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  try {
    const command = process.platform === 'win32' ? 'node -e "setTimeout(() => {}, 30000)"' : 'sleep 30'
    const result = await bash.execute({ command, run_in_background: true, timeout: 100 }, context())
    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(taskId)
    await waitFor(() => registry.getTask('session-1', taskId)?.status === 'failed')
    assert.match(registry.getTask('session-1', taskId)?.reason ?? '', /timed out/)
  } finally {
    await registry.stopAll()
  }
})

test('an output file past its cap keeps the head and the newest tail', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-bg-output-'))
  const registry = new BackgroundTaskRegistry()
  const proc = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    kill: () => true,
  }) as unknown as ChildProcess
  try {
    const task = registry.registerShell({ sessionId: 'session-1', command: 'fake', proc, outputDir: dir })
    const chunk = 64 * 1024
    const total = MAX_BACKGROUND_OUTPUT_FILE_BYTES + 2 * MAX_BACKGROUND_OUTPUT_BYTES
    for (let written = 0; written < total; written += chunk) {
      registry.appendOutput('session-1', task.id, Buffer.alloc(chunk, written < total - chunk ? 97 : 98))
    }
    registry.closeOutput('session-1', task.id)
    const content = await readFile(task.outputPath!, 'utf8')
    const head = MAX_BACKGROUND_OUTPUT_FILE_BYTES - MAX_BACKGROUND_OUTPUT_BYTES
    assert.equal(content.slice(0, head), 'a'.repeat(head))
    assert.match(content.slice(head), /^\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/)
    assert.ok(content.endsWith('b'.repeat(chunk)))
    assert.ok(content.length < MAX_BACKGROUND_OUTPUT_FILE_BYTES + 100)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('restore marks running persisted tasks orphaned and preserves terminal tasks', async () => {
  const persisted: SessionRecord[] = []
  const registry = new BackgroundTaskRegistry(async (_sessionId, record) => { persisted.push(record) })
  const records: SessionRecord[] = [
    backgroundRecord('bash_3', 'shell', 'running'),
    backgroundRecord('agent_2', 'agent', 'completed'),
  ]
  await registry.restoreSession('session-1', records)
  assert.equal(registry.getTask('session-1', 'bash_3')?.status, 'orphaned')
  assert.equal(registry.getTask('session-1', 'agent_2')?.status, 'completed')
  assert.ok(persisted.some((record) => record.type === 'background_task' && record.taskId === 'bash_3' && record.status === 'orphaned'))
})

test('agent tasks share registry status and subscriptions with shell tasks', () => {
  const registry = new BackgroundTaskRegistry()
  let notifications = 0
  const unsubscribe = registry.subscribe(() => { notifications++ })
  const task = registry.registerAgent({
    sessionId: 'session-1',
    agentId: 'agent-uuid',
    agentType: 'general',
    description: 'research',
  })
  registry.completeAgent('session-1', 'agent-uuid', 'completed')
  unsubscribe()
  assert.equal(task.id, 'agent_1')
  assert.equal(registry.getTask('session-1', task.id)?.status, 'completed')
  assert.ok(notifications >= 2)
})

test('stopAll settles every task even when one stop rejects', async () => {
  // Shutdown calls stopAll before it closes anything else (MCP clients among
  // them), so a single failing stop must not become a short-circuit that skips
  // the rest — this is the reverse evidence for the claim that it does.
  const registry = new BackgroundTaskRegistry()
  const stopped: string[] = []
  registry.registerAgent({
    sessionId: 'session-1',
    agentId: 'bad',
    agentType: 'general',
    description: 'refuses to stop',
    stop: async () => {
      stopped.push('bad')
      throw new Error('stop failed')
    },
  })
  registry.registerAgent({
    sessionId: 'session-1',
    agentId: 'good',
    agentType: 'general',
    description: 'stops fine',
    stop: async () => { stopped.push('good') },
  })

  await registry.stopAll('session-1', 'test cleanup')

  assert.deepEqual(stopped.sort(), ['bad', 'good'], 'both stops were attempted')
  // The healthy task finishes its own stop. The failing one keeps whatever
  // state its own stop left it in — deliberately unchanged here: this test
  // pins the no-short-circuit property, not a fault-tolerance policy.
  assert.equal(registry.getTask('session-1', 'agent_1')?.status, 'running')
  assert.equal(registry.getTask('session-1', 'agent_2')?.status, 'killed')
})

test('restored short agent ids seed the next per-type id', async () => {
  const registry = new BackgroundTaskRegistry()
  const record = backgroundRecord('agent_2', 'agent', 'completed')
  record.agentId = 'explore-4'
  await registry.restoreSession('session-1', [record])
  assert.equal(registry.allocateAgentId('session-1', 'explore'), 'explore-5')
})

function backgroundRecord(
  taskId: string,
  kind: 'shell' | 'agent',
  status: 'running' | 'completed',
): Extract<SessionRecord, { type: 'background_task' }> {
  return {
    id: `${taskId}-record`,
    type: 'background_task',
    taskId,
    sessionId: 'session-1',
    kind,
    status,
    ...(kind === 'agent' ? { agentId: 'agent-uuid', agentType: 'general' } : { command: 'sleep 1' }),
    startedAt: 1,
    createdAt: new Date().toISOString(),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for background task state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

test('re-running a dev server in background retires the identical previous shell', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  try {
    const executable = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)
    const devCommand = `${executable} -e "setTimeout(() => {}, 30000)" # npm run dev`
    const otherCommand = `${executable} -e "setTimeout(() => {}, 30000)" # npm run test:watch`

    const other = await bash.execute({ command: otherCommand, run_in_background: true }, context())
    const first = await bash.execute({ command: devCommand, run_in_background: true }, context())
    const firstId = first.content.match(/Task ID: (bash_\d+)/)?.[1]
    const otherId = other.content.match(/Task ID: (bash_\d+)/)?.[1]
    assert.ok(firstId && otherId)

    await bash.execute({ command: devCommand, run_in_background: true }, context())

    assert.equal(registry.getTask('session-1', firstId)?.status, 'killed')
    assert.match(registry.getTask('session-1', firstId)?.reason ?? '', /newer dev server/)
    assert.equal(registry.getTask('session-1', otherId)?.status, 'running')
  } finally {
    await registry.stopAll()
  }
})

test('isDevServerCommand matches the usual dev servers and leaves other commands alone', () => {
  for (const command of ['npm run dev', 'pnpm dev', 'yarn run preview', 'bun run dev', 'vite --port 5173', 'npx vite', 'next dev', 'cd app && astro dev']) {
    assert.equal(isDevServerCommand(command), true, command)
  }
  for (const command of ['npm run build', 'npm test', 'git log --oneline', 'node scripts/devtool.js']) {
    assert.equal(isDevServerCommand(command), false, command)
  }
})

test('a running Bash call moved to the background by the user notifies the parent when it exits', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  const ctx = { ...context(), sessionId: 'manual-bg', currentToolUseId: 'call-1' }
  try {
    const executable = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)
    const running = bash.execute({ command: `${executable} -e "setTimeout(() => {}, 300)"` }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(registry.backgroundForeground('manual-bg', 'call-1'), true)
    const result = await running
    assert.equal(result.ok, true)
    assert.match(result.content, /The user moved this command to the background/)
    assert.equal(registry.backgroundForeground('manual-bg', 'call-1'), false)

    const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
    for (let i = 0; i < 100 && !registry.hasParentNotifications('manual-bg'); i++) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    const [note] = registry.consumeParentNotifications('manual-bg')
    assert.match(note ?? '', new RegExp(`Background shell ${taskId} completed`))
  } finally {
    await registry.stopAll('manual-bg', 'test cleanup')
  }
})

test('a background shell stopped on request does not notify the parent', async () => {
  const registry = new BackgroundTaskRegistry()
  const bash = createBashTool(registry)
  const ctx = { ...context(), sessionId: 'killed-bg' }
  const executable = process.platform === 'win32' ? 'node' : JSON.stringify(process.execPath)
  const result = await bash.execute({ command: `${executable} -e "setTimeout(() => {}, 5000)"`, run_in_background: true }, ctx)
  const taskId = result.content.match(/Task ID: (bash_\d+)/)?.[1]
  await registry.killShell('killed-bg', taskId!)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(registry.hasParentNotifications('killed-bg'), false)
})
