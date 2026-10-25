import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { connectMcpServers } from '../src/runtime/mcp.js'
import { ToolRegistry } from '../src/runtime/toolRegistry.js'
import { wrapMcpTool } from '../src/services/mcp/index.js'
import type { ManagedMcpClient, McpServerConfig } from '../src/services/mcp/index.js'
import type { MyAgentSettings } from '../src/config/settings.js'

/**
 * Startup ownership of MCP connections (B21).
 *
 * `clients` is the only list the shutdown path closes, so a server that
 * connects and then fails to list its tools must be closed here — otherwise the
 * child process outlives the runtime and its half-registered tools keep being
 * offered. The real connection spawns a process, so these tests substitute the
 * connection and keep everything else (registry, ownership, reporting) real.
 */

const SERVERS: Record<string, McpServerConfig> = {
  alpha: { transport: 'stdio', command: 'node', args: ['alpha.js'] },
  beta: { transport: 'stdio', command: 'node', args: ['beta.js'] },
}

function settingsFor(names: string[]): MyAgentSettings {
  return {
    mcpServers: Object.fromEntries(names.map((name) => [name, SERVERS[name]!])),
    mcp: { trustedServers: names },
  }
}

interface FakeManager {
  listTools: (params?: unknown, options?: unknown) => Promise<{ tools: Array<{ name: string; description: string; inputSchema: unknown }> }>
  callTool: (params: unknown) => Promise<unknown>
  close: () => Promise<void>
  closed: number
}

function fakeManager(behaviour: {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
  listError?: Error
  closeError?: Error
}): FakeManager {
  const manager: FakeManager = {
    closed: 0,
    listTools: async () => {
      if (behaviour.listError) throw behaviour.listError
      return { tools: (behaviour.tools ?? []).map((tool) => ({ name: tool.name, description: tool.description ?? '', inputSchema: tool.inputSchema ?? { type: 'object' } })) }
    },
    callTool: async () => ({ content: [] }),
    close: async () => {
      manager.closed += 1
      if (behaviour.closeError) throw behaviour.closeError
    },
  }
  return manager
}

interface Run {
  clients: ManagedMcpClient[]
  status: { connected: Array<{ name: string; toolCount: number }>; failed: Array<{ name: string; error: string }> }
  failures: Array<{ name: string; error: string }>
}

async function runStartup(
  names: string[],
  connect: (config: McpServerConfig) => Promise<FakeManager>,
  options: { registry?: ToolRegistry } = {},
): Promise<Run & { registry: ToolRegistry }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-mcp-startup-'))
  const registry = options.registry ?? new ToolRegistry([])
  const failures: Run['failures'] = []
  try {
    const result = await connectMcpServers({
      cwd,
      settings: settingsFor(names),
      registry,
      confirmTrust: async () => true,
      onConnectFailure: async (name, error) => { failures.push({ name, error }) },
      connect: async (config) => await connect(config) as unknown as ManagedMcpClient,
    })
    return { ...result, failures, registry }
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

test('a server that connects but cannot list its tools is closed and reported', async () => {
  const alpha = fakeManager({ listError: new Error('tools/list failed: boom') })
  const run = await runStartup(['alpha'], async () => alpha)

  assert.equal(alpha.closed, 1, 'the abandoned connection must be closed')
  assert.deepEqual(run.clients, [], 'it never becomes a long-lived client')
  assert.deepEqual(run.status.connected, [])
  assert.deepEqual(run.failures, [{ name: 'alpha', error: 'tools/list failed: boom' }])
  assert.deepEqual(run.status.failed, [{ name: 'alpha', error: 'tools/list failed: boom' }])
  assert.equal(run.registry.serverToolCount('alpha'), 0)
})

test('a failure part-way through registration withdraws what was already published', async () => {
  const registry = new ToolRegistry([])
  const removed: string[] = []
  // Publishes the tools, then throws: the state the loop must roll back.
  const tampered = {
    setServerTools: (name: string, tools: Parameters<ToolRegistry['setServerTools']>[1]) => {
      registry.setServerTools(name, tools)
      throw new Error('registry exploded mid-registration')
    },
    removeServerTools: (name: string) => {
      removed.push(name)
      registry.removeServerTools(name)
    },
  } as unknown as ToolRegistry
  const alpha = fakeManager({ tools: [{ name: 'ping' }] })

  const run = await runStartup(['alpha'], async () => alpha, { registry: tampered })

  assert.equal(alpha.closed, 1)
  assert.deepEqual(removed, ['alpha'], 'the half-registered server is withdrawn')
  assert.equal(registry.serverToolCount('alpha'), 0)
  assert.deepEqual(run.clients, [])
  assert.deepEqual(run.failures, [{ name: 'alpha', error: 'registry exploded mid-registration' }])
})

test('a cleanup failure is reported on its own and never hides the original error', async () => {
  const alpha = fakeManager({ listError: new Error('tools/list failed: boom'), closeError: new Error('close failed: EBUSY') })
  const run = await runStartup(['alpha'], async () => alpha)

  assert.equal(alpha.closed, 1)
  assert.deepEqual(run.status.failed, [
    { name: 'alpha', error: 'failed to close after a startup error: close failed: EBUSY' },
    { name: 'alpha', error: 'tools/list failed: boom' },
  ])
  assert.deepEqual(run.failures, [{ name: 'alpha', error: 'tools/list failed: boom' }], 'the metric carries the real failure')
  // Even a failed close must not leave the server registered.
  assert.equal(run.registry.serverToolCount('alpha'), 0)
})

test('a healthy server transfers ownership once and is not closed at startup', async () => {
  const alpha = fakeManager({ tools: [{ name: 'ping' }] })
  const run = await runStartup(['alpha'], async () => alpha)

  assert.equal(run.clients.length, 1, 'the shutdown path owns it from here')
  assert.equal(alpha.closed, 0, 'startup must not close what it handed over')
  assert.deepEqual(run.status.connected, [{ name: 'alpha', toolCount: 1 }])
  assert.deepEqual(run.status.failed, [])
  // The registered tools invoke through the same manager that was handed over.
  const tools = run.registry.buildRuntimeTools()
  assert.ok(tools.some((tool) => tool.name.startsWith('mcp__alpha__')))
})

test('one server failing does not stop the next one, and only the failure is closed', async () => {
  const alpha = fakeManager({ listError: new Error('boom') })
  const beta = fakeManager({ tools: [{ name: 'ping' }] })
  const run = await runStartup(['alpha', 'beta'], async (config) => (config === SERVERS.alpha ? alpha : beta))

  assert.equal(alpha.closed, 1)
  assert.equal(beta.closed, 0)
  assert.deepEqual(run.clients.length, 1)
  assert.deepEqual(run.status.connected, [{ name: 'beta', toolCount: 1 }])
  assert.deepEqual(run.status.failed, [{ name: 'alpha', error: 'boom' }])
  assert.equal(run.registry.serverToolCount('alpha'), 0)
  assert.equal(run.registry.serverToolCount('beta'), 1)
})

test('a server that never connects is never closed', async () => {
  const run = await runStartup(['alpha'], async () => { throw new Error('spawn failed: ENOENT') })

  assert.deepEqual(run.clients, [])
  assert.deepEqual(run.status.failed, [{ name: 'alpha', error: 'spawn failed: ENOENT' }])
})

test('an untrusted server is refused before any connection', async () => {
  let attempted = 0
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-mcp-startup-'))
  try {
    const result = await connectMcpServers({
      cwd,
      settings: { mcpServers: { alpha: SERVERS.alpha! }, mcp: { trustedServers: [] } },
      registry: new ToolRegistry([]),
      confirmTrust: async () => false,
      onConnectFailure: async () => {},
      connect: async () => {
        attempted += 1
        return fakeManager({}) as unknown as ManagedMcpClient
      },
    })
    assert.equal(attempted, 0)
    assert.deepEqual(result.clients, [])
    assert.deepEqual(result.status.failed, [{ name: 'alpha', error: 'not trusted' }])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a wrapped MCP tool survives a reconnect that replaces the client', async () => {
  // The wrapper invokes through the stable manager, never the listed client:
  // a reconnect swaps the underlying client, so the tool must keep working.
  const calls: string[] = []
  const manager = Object.assign(fakeManager({ tools: [{ name: 'ping' }] }), {
    callTool: async (params: unknown) => {
      calls.push(JSON.stringify(params))
      return { content: [{ type: 'text', text: 'pong' }] }
    },
  }) as unknown as ManagedMcpClient
  const registry = new ToolRegistry([])
  registry.setServerTools('alpha', [wrapMcpTool('alpha', { name: 'ping', description: 'pings', inputSchema: { type: 'object' } }, manager)])

  const tool = registry.buildRuntimeTools().find((candidate) => candidate.name === 'mcp__alpha__ping')
  assert.ok(tool, 'the wrapped tool is registered under its server prefix')
  const result = await tool.execute({}, { cwd: os.tmpdir(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.ok, true)
  assert.match(result.content, /pong/)
  assert.equal(calls.length, 1)
})