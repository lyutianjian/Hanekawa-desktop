import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { z } from 'zod/v3'
import { buildAnthropicPayload } from '../src/config/providers.js'
import { buildResponsesPayload } from '../src/config/providers/responsesPayload.js'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import { resetCacheTTLEvaluation, SYSTEM_PROMPT_DYNAMIC_BOUNDARY } from '../src/harness/cacheControl.js'
import type { SessionRecord, Tool } from '../src/harness/types.js'

const tool: Tool = {
  name: 'Read',
  description: 'Read a file from disk',
  inputSchema: z.object({ filePath: z.string() }).strict(),
  riskLevel: 'safe',
  execute: async () => ({ ok: true, content: '' }),
}

const at = '2026-05-10T00:00:00.000Z'

/** A turn of `toolTurns` assistant/tool_use/tool_result triples after one user message. */
function records(toolTurns: number): SessionRecord[] {
  const list: SessionRecord[] = [
    { type: 'message', id: 'u1', role: 'user', content: 'read the files', createdAt: at },
  ]
  for (let i = 0; i < toolTurns; i++) {
    list.push(
      { type: 'message', id: `a${i}`, role: 'assistant', content: `reading file ${i}`, createdAt: at },
      { type: 'tool_use', id: `call-${i}`, tool: 'Read', input: { filePath: `f${i}.ts` }, riskLevel: 'safe', createdAt: at },
      { type: 'tool_result', id: `res-${i}`, toolUseId: `call-${i}`, tool: 'Read', ok: true, content: `contents of f${i}.ts`, createdAt: at },
    )
  }
  return list
}

/** Hash a message with `cache_control` removed — the marker itself is not a content difference. */
function hashMessage(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content)
    ? message.content.map((block) => {
        if (!block || typeof block !== 'object') return block
        const { cache_control: _marker, ...rest } = block as Record<string, unknown>
        return rest
      })
    : message.content
  return createHash('sha256').update(JSON.stringify({ role: message.role, content })).digest('hex').slice(0, 12)
}

function breakpointIndex(messages: Array<Record<string, unknown>>): number {
  return messages.findIndex((message) =>
    Array.isArray(message.content)
      && message.content.some((block) => Boolean((block as Record<string, unknown>)?.cache_control)),
  )
}

/** Each tool turn followed by a coordination_update, as the coordinator records one at a step boundary. */
function coordinatorRecords(toolTurns: number): SessionRecord[] {
  return records(toolTurns).flatMap((record): SessionRecord[] => record.type === 'tool_result'
    ? [record, { type: 'coordination_update' as const, id: `upd-${record.id}`, content: `Thread note after ${record.id}`, turnId: 't1', createdAt: at }]
    : [record])
}

async function payloadMessages(
  toolTurns: number,
  build: (n: number) => SessionRecord[] = records,
): Promise<Array<Record<string, unknown>>> {
  const builder = new ContextBuilder(undefined, { contextWindow: 200_000, summaryOutputTokens: 0 })
  const built = await builder.build({
    records: build(toolTurns),
    tools: [tool],
    system: 'system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })
  const payload = buildAnthropicPayload({
    cacheSource: 'agent:test',
    model: 'claude-sonnet-test',
    messages: [],
    contextItems: built.contextItems,
    systemBlocks: built.systemBlocks,
    tools: [tool],
    cacheRuntime: { env: { MYAGENT_PROMPT_CACHE_1H: '0' } },
  }) as unknown as { messages: Array<Record<string, unknown>> }
  return payload.messages
}

function assertBreakpointInCommonPrefix(turnN: Array<Record<string, unknown>>, turnNext: Array<Record<string, unknown>>): void {
  let commonPrefix = 0
  while (
    commonPrefix < turnN.length
    && commonPrefix < turnNext.length
    && hashMessage(turnN[commonPrefix]) === hashMessage(turnNext[commonPrefix])
  ) commonPrefix++

  const index = breakpointIndex(turnN)
  assert.ok(index >= 0, 'expected a message-level cache breakpoint')
  assert.ok(
    index < commonPrefix,
    `breakpoint at ${index} must fall inside the common prefix of ${commonPrefix} messages`,
  )
}

test('cache breakpoint stays inside the prefix two consecutive turns share', async () => {
  resetCacheTTLEvaluation()
  assertBreakpointInCommonPrefix(await payloadMessages(2), await payloadMessages(3))
})

test('a coordination_update in the history keeps the breakpoint inside the common prefix', async () => {
  resetCacheTTLEvaluation()
  const turnN = await payloadMessages(2, coordinatorRecords)
  assert.ok(JSON.stringify(turnN).includes('Thread note after res-1'), 'the update is part of the history')
  assertBreakpointInCommonPrefix(turnN, await payloadMessages(3, coordinatorRecords))
})

test('Responses reuses the previous history boundary through thread updates and changing reminders', async () => {
  const builder = new ContextBuilder(undefined, { contextWindow: 200_000, summaryOutputTokens: 0 })
  const payload = async (toolTurns: number) => {
    const built = await builder.build({
      records: coordinatorRecords(toolTurns),
      tools: [tool],
      rolePrompt: 'Coordinate threads',
      projectContext: 'Stable project instructions',
      permissionMode: toolTurns === 2 ? 'auto' : 'plan',
      transientUserContext: [`Pending requests: ${toolTurns}`],
      now: new Date(`2026-05-${toolTurns === 2 ? '10' : '11'}T12:00:00.000Z`),
    })
    return buildResponsesPayload({
      cacheSource: 'agent:coordinator-cache-test',
      promptCacheKey: 'coordinator-session',
      model: 'gpt-6.1-sol',
      messages: built.messages,
      contextItems: built.contextItems,
      system: built.system,
      tools: [tool],
    }, { cacheBreakpoints: true, cacheKey: true })
  }
  const first = await payload(2)
  const next = await payload(3)
  const marked = (value: unknown): boolean => {
    if (!value || typeof value !== 'object') return false
    if (Object.hasOwn(value, 'prompt_cache_breakpoint')) return true
    return Object.values(value).some(marked)
  }
  const endpoint = first.input.reduce((last, item, index) => marked(item) ? index : last, -1)
  assert.ok(endpoint >= 0 && endpoint < first.input.length - 1, 'the rebuilt suffix is outside the cache write')
  assert.ok(JSON.stringify(first.input[endpoint]).includes('Thread note after res-1'), 'the durable thread update is cached')
  assert.deepEqual(next.input.slice(0, endpoint + 1), first.input.slice(0, endpoint + 1), 'the complete previously cached prefix survives')
  assert.deepEqual(next.instructions, first.instructions)
  assert.deepEqual(next.tools, first.tools)
  assert.equal(next.prompt_cache_key, first.prompt_cache_key)
  assert.ok(first.input.slice(endpoint + 1).every((item) => !marked(item)))
  assert.notDeepEqual(next.input.slice(endpoint + 1), first.input.slice(endpoint + 1))
})

test('the role prompt is static: identical across builds and ahead of the dynamic boundary', async () => {
  const build = async () => new ContextBuilder(undefined, { contextWindow: 200_000, summaryOutputTokens: 0 }).build({
    records: records(1),
    tools: [tool],
    system: 'system',
    rolePrompt: 'ROLE-PROMPT you coordinate threads',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })
  const first = (await build()).systemBlocks!
  const second = (await build()).systemBlocks!
  assert.deepEqual(first, second)
  const role = first.findIndex((block) => block.includes('ROLE-PROMPT'))
  const boundary = first.indexOf(SYSTEM_PROMPT_DYNAMIC_BOUNDARY)
  assert.ok(role >= 0 && boundary > role, `role section at ${role} must precede the boundary at ${boundary}`)
})

test('the built payload carries no transient marker field', async () => {
  resetCacheTTLEvaluation()
  const messages = await payloadMessages(2)
  const keys = new Set(messages.flatMap((message) => Object.keys(message)))
  assert.deepEqual([...keys].sort(), ['content', 'role'])
})
