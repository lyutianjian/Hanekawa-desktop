import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { ToolRegistry } from '../src/runtime/toolRegistry.js'
import type { Tool } from '../src/harness/types.js'

function testTool(name: string): Tool {
  return {
    name,
    description: `${name} description`,
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    isReadOnly: true,
    isConcurrencySafe: true,
    execute: async () => ({ ok: true, content: `${name} result` }),
  }
}

function toolNames(tools: readonly Tool[]): string[] {
  return tools.map((tool) => tool.name)
}

test('registered tool arrays keep their identity across MCP tool changes', () => {
  const registry = new ToolRegistry([testTool('Read'), testTool('Bash')])
  const runtimeTools = registry.buildRuntimeTools()
  registry.register(runtimeTools)

  // The Agent tool and ToolRunner both capture this exact array reference and
  // can never be re-pointed, so the registry must mutate it in place.
  const captured = runtimeTools

  registry.setServerTools('github', [testTool('mcp__github__search')])

  assert.equal(captured, runtimeTools)
  assert.deepEqual(toolNames(captured), ['Read', 'Bash', 'mcp__github__search'])
})

test('the per-runtime Agent tool survives a refresh and stays last', () => {
  const registry = new ToolRegistry([testTool('Read')])
  const runtimeTools = registry.buildRuntimeTools()
  const agentTool = testTool('Agent')
  runtimeTools.push(agentTool)
  registry.register(runtimeTools)

  registry.setServerTools('github', [testTool('mcp__github__search')])

  assert.deepEqual(toolNames(runtimeTools), ['Read', 'mcp__github__search', 'Agent'])
  assert.equal(runtimeTools.filter((tool) => tool.name === 'Agent').length, 1)
  assert.equal(runtimeTools.at(-1), agentTool)

  // A second refresh must not duplicate or drop it either.
  registry.setServerTools('github', [testTool('mcp__github__search'), testTool('mcp__github__issue')])
  assert.deepEqual(toolNames(runtimeTools), [
    'Read',
    'mcp__github__search',
    'mcp__github__issue',
    'Agent',
  ])
})

test('unregistered tool arrays stop tracking MCP changes', () => {
  const registry = new ToolRegistry([testTool('Read')])
  // App creates a throwaway runtime just to read model metadata, then
  // disposes it immediately; its array must not be touched afterwards.
  const disposed = registry.buildRuntimeTools()
  const live = registry.buildRuntimeTools()
  registry.register(disposed)
  registry.register(live)

  registry.unregister(disposed)
  registry.setServerTools('github', [testTool('mcp__github__search')])

  assert.deepEqual(toolNames(disposed), ['Read'])
  assert.deepEqual(toolNames(live), ['Read', 'mcp__github__search'])
})

test('setServerTools replaces one server without disturbing the others', () => {
  const registry = new ToolRegistry([testTool('Read')])
  const runtimeTools = registry.buildRuntimeTools()
  registry.register(runtimeTools)

  registry.setServerTools('a', [testTool('mcp__a__one'), testTool('mcp__a__two')])
  registry.setServerTools('b', [testTool('mcp__b__one')])
  assert.equal(registry.serverToolCount('a'), 2)

  // A reconnect that reports fewer tools drops the missing ones for that
  // server only.
  registry.setServerTools('a', [testTool('mcp__a__one')])

  assert.deepEqual(toolNames(runtimeTools), ['Read', 'mcp__a__one', 'mcp__b__one'])
  assert.equal(registry.serverToolCount('a'), 1)
  assert.equal(registry.serverToolCount('missing'), 0)
})

test('runtime tools built after a server connected include its tools', () => {
  const registry = new ToolRegistry([testTool('Read')])
  registry.setServerTools('github', [testTool('mcp__github__search')])

  assert.deepEqual(toolNames(registry.buildRuntimeTools()), ['Read', 'mcp__github__search'])
})

test('removeServerTools drops a server from every registered array, in place', () => {
  const registry = new ToolRegistry([testTool('Read')])
  const runtimeTools = registry.buildRuntimeTools()
  const agentTool = testTool('Agent')
  runtimeTools.push(agentTool)
  registry.register(runtimeTools)
  registry.setServerTools('a', [testTool('mcp__a__one')])
  registry.setServerTools('b', [testTool('mcp__b__one')])

  // What a reconnect does before reconnecting: a server the settings no longer
  // name is never mentioned again, so nothing else would ever take its tools
  // out of a live runtime's array.
  registry.removeServerTools('a')

  assert.deepEqual(toolNames(runtimeTools), ['Read', 'mcp__b__one', 'Agent'])
  assert.equal(registry.serverToolCount('a'), 0)
  assert.deepEqual(toolNames(registry.buildRuntimeTools()), ['Read', 'mcp__b__one'])

  // Removing what was never there is a no-op rather than a refresh, so it
  // cannot disturb the array either.
  registry.removeServerTools('a')
  assert.deepEqual(toolNames(runtimeTools), ['Read', 'mcp__b__one', 'Agent'])
})

test('role-filtered tool sets stay filtered across MCP refresh', () => {
  const roleTool = { ...testTool('Spawn'), sessionRoles: ['coordinator'] } as Tool
  const registry = new ToolRegistry([testTool('Read'), roleTool, testTool('EnterPlanMode'), testTool('ExitPlanMode')])
  const normal = registry.buildRuntimeTools()
  const coordinator = registry.buildRuntimeTools('coordinator')
  registry.register(normal)
  registry.register(coordinator, 'coordinator')
  assert.deepEqual(toolNames(normal), ['Read', 'EnterPlanMode', 'ExitPlanMode'])
  assert.deepEqual(toolNames(coordinator), ['Read', 'Spawn'])

  coordinator.push(testTool('Agent'))
  registry.setServerTools('github', [testTool('mcp__github__search')])
  assert.deepEqual(toolNames(normal), ['Read', 'EnterPlanMode', 'ExitPlanMode', 'mcp__github__search'])
  assert.deepEqual(toolNames(coordinator), ['Read', 'Spawn', 'mcp__github__search', 'Agent'])
})

test('MCP refresh preserves each runtime model catalog without changing shared tools', () => {
  const start = { ...testTool('StartThread'), sessionRoles: ['coordinator'] } as Tool
  const registry = new ToolRegistry([testTool('Read'), start])
  const runtimes = ['model-a', 'model-b'].map((model) => {
    const override = { ...start, description: `Available: ${model}` }
    const tools = registry.buildRuntimeTools('coordinator').map((tool) => tool === start ? override : tool)
    tools.push(testTool('Agent'))
    registry.register(tools, 'coordinator', [override])
    return { tools, override }
  })
  registry.setServerTools('test', [testTool('mcp__test__read')])
  registry.removeServerTools('test')
  for (const { tools, override } of runtimes) {
    assert.deepEqual(toolNames(tools), ['Read', 'StartThread', 'Agent'])
    assert.equal(tools[1], override)
  }
  assert.equal(registry.buildRuntimeTools('coordinator')[1], start)
  assert.deepEqual(toolNames(registry.buildRuntimeTools()), ['Read'])
})
