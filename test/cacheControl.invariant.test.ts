import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import {
  ANTHROPIC_CACHE_CONTROL_LIMIT,
  buildAnthropicMessages,
  buildAnthropicPayload,
  buildAnthropicTools,
  collectCacheControlTelemetry,
} from '../src/config/providers.js'
import { resetCacheTTLEvaluation, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/harness/cacheControl.js'
import type { ModelContextItem, ModelRequest, Tool } from '../src/harness/types.js'

const createdAt = '2026-05-24T00:00:00.000Z'

const tools: Tool[] = [
  {
    name: 'Read',
    description: 'Read a file',
    inputSchema: z.object({ filePath: z.string() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  },
  {
    name: 'Grep',
    description: 'Search files',
    inputSchema: z.object({ pattern: z.string() }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '' }),
  },
]

const transcript: ModelContextItem[] = [
  {
    kind: 'message',
    message: {
      id: 'u1',
      role: 'user',
      content: 'Find the cache control code.',
      createdAt,
    },
  },
  {
    kind: 'message',
    message: {
      id: 'a1',
      role: 'assistant',
      content: 'I will inspect the provider payload builder.',
      createdAt,
    },
  },
  {
    kind: 'tool_use',
    id: 'call-1',
    tool: 'Grep',
    input: { pattern: 'cache_control' },
  },
  {
    kind: 'tool_result',
    toolUseId: 'call-1',
    tool: 'Grep',
    ok: true,
    content: 'src/config/providers/anthropicPayload.ts: cache_control',
  },
  {
    kind: 'message',
    message: {
      id: 'u2',
      role: 'user',
      content: 'Now summarize what keeps the cache warm.',
      createdAt,
    },
  },
]

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    cacheSource: 'agent:test',
    model: 'claude-sonnet-test',
    messages: [],
    contextItems: transcript,
    systemBlocks: [
      'static identity',
      'static instructions',
      SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
      'dynamic session state',
    ],
    tools,
    cacheRuntime: {
      env: {
        HANEKAWA_PROMPT_CACHE_1H: '0',
      },
    },
    ...overrides,
  }
}

function assertCacheControlDistribution(
  modelRequest: ModelRequest,
  expected: { system: number; tools: number; messages: number; other?: number },
) {
  resetCacheTTLEvaluation()

  const payload = buildAnthropicPayload(modelRequest)
  const telemetry = collectCacheControlTelemetry(payload)

  assert.ok(
    telemetry.total <= ANTHROPIC_CACHE_CONTROL_LIMIT,
    `expected no more than ${ANTHROPIC_CACHE_CONTROL_LIMIT} cache_control markers, got ${telemetry.total}: ${telemetry.paths.join(', ')}`,
  )
  assert.deepEqual(telemetry.byLocation, {
    system: expected.system,
    tools: expected.tools,
    messages: expected.messages,
    other: expected.other ?? 0,
  })
  assert.equal(telemetry.total, expected.system + expected.tools + expected.messages + (expected.other ?? 0))
}

test('buildAnthropicPayload keeps cache_control markers within Anthropic limit for a full request', () => {
  assertCacheControlDistribution(request(), {
    system: 1,
    tools: 1,
    messages: 2,
  })
})

test('buildAnthropicPayload cache_control distribution follows available request sections', () => {
  assertCacheControlDistribution(request({ systemBlocks: undefined, system: undefined }), {
    system: 0,
    tools: 1,
    messages: 2,
  })

  assertCacheControlDistribution(request({ tools: [] }), {
    system: 1,
    tools: 0,
    messages: 2,
  })

  assertCacheControlDistribution(request({
    contextItems: [],
    messages: [],
    tools: [],
  }), {
    system: 1,
    tools: 0,
    messages: 1,
  })
})

test('buildAnthropicTools anchors the marker to the last stable tool and trails volatile ones', () => {
  resetCacheTTLEvaluation()

  const mcpTool: Tool = {
    name: 'mcp__server__query',
    description: 'Query an MCP server',
    inputSchema: z.object({ q: z.string() }).strict(),
    riskLevel: 'safe',
    isMcp: true,
    execute: async () => ({ ok: true, content: '' }),
  }

  const built = buildAnthropicTools([tools[0]!, mcpTool, tools[1]!], true, { env: {} })

  assert.deepEqual(built.map((tool) => (tool as { name: string }).name), [
    'Read',
    'Grep',
    'mcp__server__query',
  ])
  assert.equal((built[0] as { cache_control?: unknown }).cache_control, undefined)
  assert.deepEqual((built[1] as { cache_control?: unknown }).cache_control, { type: 'ephemeral', ttl: '1h' })
  assert.equal((built[2] as { cache_control?: unknown }).cache_control, undefined)
})

test('buildAnthropicTools falls back to the last tool when every tool is volatile', () => {
  resetCacheTTLEvaluation()

  const deferred = new Set(['Read', 'Grep'])
  const built = buildAnthropicTools(tools, true, { env: {} }, deferred)

  assert.equal((built[0] as { cache_control?: unknown }).cache_control, undefined)
  assert.deepEqual((built[1] as { cache_control?: unknown }).cache_control, { type: 'ephemeral', ttl: '1h' })
})

test('buildAnthropicMessages keeps injected subagent summary after Agent tool_result valid', () => {
  const messages = buildAnthropicMessages(request({
    contextItems: [
      {
        kind: 'message',
        message: {
          id: 'u1',
          role: 'user',
          content: 'Explore the codebase.',
          createdAt,
        },
      },
      {
        kind: 'message',
        message: {
          id: 'a1',
          role: 'assistant',
          content: 'I will run an explore sub-agent.',
          createdAt,
        },
      },
      {
        kind: 'tool_use',
        id: 'agent-call-1',
        tool: 'Agent',
        input: { task: 'map the codebase', subagent_type: 'explore' },
      },
      {
        kind: 'tool_result',
        toolUseId: 'agent-call-1',
        tool: 'Agent',
        ok: true,
        content: 'Found 5 relevant files.',
      },
      {
        kind: 'message',
        message: {
          id: 'subagent-summary-1',
          role: 'assistant',
          content: '<subagent-summary type="explore" />',
          createdAt,
        },
      },
      {
        kind: 'message',
        message: {
          id: 'u2',
          role: 'user',
          content: 'Thanks.',
          createdAt,
        },
      },
    ],
  }))

  assert.deepEqual(messages.map((message) => message.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.deepEqual(messages[2], {
    role: 'user',
    content: [{
      type: 'tool_result',
      tool_use_id: 'agent-call-1',
      content: 'Found 5 relevant files.',
      is_error: false,
    }],
  })
  assert.deepEqual(messages[3], {
    role: 'assistant',
    content: [{ type: 'text', text: '<subagent-summary type="explore" />' }],
  })
})
