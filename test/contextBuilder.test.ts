import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod/v3'
import { ContextBuilder, INSTRUCTIONS_MESSAGE_ID, type BuildContextInput } from '../src/harness/contextBuilder.js'
import {
  countTextTokens,
  getAvailableTokensForOverhead,
  requestOverhead,
} from '../src/prompts/budget.js'
import type { ReadFileState, SessionRecord, Tool } from '../src/harness/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

const contextWindow = (contextWindow: number) => ({ contextWindow, summaryOutputTokens: 0 })

const tool: Tool = {
  name: 'Read',
  description: 'Read a file from disk',
  inputSchema: z.object({}).strict(),
  riskLevel: 'safe',
  execute: async () => ({ ok: true, content: '' }),
}

test('ContextBuilder injects layered system and user context', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'u1',
    role: 'user',
    content: 'hello',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]

  const built = await builder.build({
    records,
    tools: [tool],
    system: 'custom system',
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  assert.match(built.system ?? '', /custom system/)
  assert.match(built.system ?? '', /You are Hanekawa/)
  assert.match(built.system ?? '', /lyutianjian/)
  assert.match(built.system ?? '', /# Doing tasks/)
  assert.match(built.system ?? '', /# Using your tools/)
  assert.match(built.system ?? '', /Prefer dedicated tools over Bash/)
  assert.deepEqual(built.systemBlocks?.map((block) => block.slice(0, 40)), [
    'You are Hanekawa, an interactive coding ',
    '# System\n - All text you output outside ',
    '# Doing tasks\n - The user will request s',
    '# Executing actions with care\n\nConsider ',
    '# Using your tools\n - Prefer dedicated t',
    '# Tone and style\n - Only use emojis if t',
    '# Text output (does not apply to tool ca',
    '__MYAGENT_SYSTEM_PROMPT_DYNAMIC_BOUNDARY',
    'custom system',
  ])
  // The turn-varying block sits at the tail, behind the history it must not
  // invalidate (spec §6.2).
  const last = built.contextItems[built.contextItems.length - 1]
  assert.equal(last?.kind, 'message')
  assert.equal(last.message.id, 'meta:user-context')
  assert.match(last.message.content, /Today's date is 2026\/05\/10/)
  assert.doesNotMatch(last.message.content, /Read: Read a file from disk/)
  assert.doesNotMatch(built.system ?? '', /Read: Read a file from disk/)
})

test('ContextBuilder excludes message queue records from model context', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const records: SessionRecord[] = [{
    id: 'queue-event-1',
    type: 'message_queue',
    operation: 'enqueue',
    message: {
      id: 'queued-1',
      content: 'not submitted yet',
      priority: 'next',
      createdAt: '2026-07-14T00:00:00.000Z',
    },
    createdAt: '2026-07-14T00:00:00.000Z',
  }]

  const built = await builder.build({ records, tools: [], system: 'system' })
  assert.doesNotMatch(JSON.stringify(built.contextItems), /not submitted yet/)
})

test('the trailing user context never splits a tool_use from its tool_result', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'read it',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Read',
      input: {},
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:00:01.000Z',
    },
    {
      type: 'tool_result',
      id: 'result-1',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'file body',
      createdAt: '2026-05-10T00:00:02.000Z',
    },
  ]

  const built = await builder.build({ records, tools: [], system: 'system' })
  const ids = built.contextItems.map((item) => {
    if (item.kind === 'message') return item.message.id
    return item.kind === 'tool_use' ? item.id : `result:${item.toolUseId}`
  })

  assert.ok(ids.indexOf('call-1') < ids.indexOf('result:call-1'))
  assert.equal(ids.at(-1), 'meta:user-context', 'the varying block belongs after the pair, not inside it')
})

test('ContextBuilder can build a reduced system prompt from enabled sections', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000), undefined, ['intro', 'doing-tasks'])

  const built = await builder.build({
    records: [],
    tools: [],
    includeUserContext: false,
  })

  assert.match(built.system ?? '', /You are Hanekawa/)
  assert.match(built.system ?? '', /# Doing tasks/)
  assert.doesNotMatch(built.system ?? '', /# Using your tools/)
  assert.doesNotMatch(built.system ?? '', /# Tone and style/)
  assert.deepEqual(built.systemBlocks?.map((block) => block.slice(0, 40)), [
    'You are Hanekawa, an interactive coding ',
    '# Doing tasks\n - The user will request s',
  ])
})

test('ContextBuilder carries image refs onto message and tool_result context items', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  const userImage = makeImageAttachmentRef({ id: 'img-u1', name: 'prompt.png' })
  const resultImage = makeImageAttachmentRef({ id: 'img-t1', name: 'screenshot.png' })
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'look at this',
      createdAt: '2026-09-08T00:00:00.000Z',
      images: [userImage],
    },
    {
      type: 'at_mention_context',
      id: 'at1',
      userMessageId: 'u1',
      turnId: 't1',
      createdAt: '2026-09-08T00:00:01.000Z',
      files: [],
      content: '<system-reminder>code text only</system-reminder>',
    },
    {
      id: 't1',
      type: 'tool_use',
      tool: 'Read',
      input: { filePath: 'screenshot.png' },
      riskLevel: 'safe',
      createdAt: '2026-09-08T00:00:02.000Z',
      turnId: 't1',
    },
    {
      id: 'r1',
      type: 'tool_result',
      toolUseId: 't1',
      tool: 'Read',
      ok: true,
      content: '[Image 1: screenshot.png; …]',
      createdAt: '2026-09-08T00:00:03.000Z',
      turnId: 't1',
      images: [resultImage],
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  const userItem = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'u1')
  assert.ok(userItem?.kind === 'message')
  assert.deepEqual(userItem.message.images, [userImage])

  const resultItem = built.contextItems.find((item) => item.kind === 'tool_result' && item.toolUseId === 't1')
  assert.ok(resultItem?.kind === 'tool_result')
  assert.deepEqual(resultItem.images, [resultImage])

  // The at-mention record stays code-text-only: images belong to the user
  // message, never to the mention expansion (design doc §5.1).
  const mentionItem = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'at1')
  assert.ok(mentionItem?.kind === 'message')
  assert.equal('images' in mentionItem.message, false)

  // The message projection preserves the refs too — providers read both shapes.
  assert.deepEqual(built.messages.find((message) => message.id === 'u1')?.images, [userImage])
})

test('ContextBuilder injects at-mention context records as hidden user context', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'u1',
      role: 'user',
      content: 'explain @src/a.py',
      createdAt: '2026-06-02T00:00:00.000Z',
    },
    {
      type: 'at_mention_context',
      id: 'at1',
      userMessageId: 'u1',
      turnId: 't1',
      createdAt: '2026-06-02T00:00:01.000Z',
      files: [{
        path: '/repo/src/a.py',
        displayPath: 'src/a.py',
        lineStart: 1,
        lineEnd: 1,
        truncated: false,
      }],
      content: '<system-reminder>\n<file path="src/a.py" lines="1-1">\nprint(1)\n</file>\n</system-reminder>',
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  const context = built.contextItems.filter((item) => item.kind === 'message').map((item) => item.message.content).join('\n')
  assert.match(context, /<file path="src\/a.py" lines="1-1">/)
  assert.match(context, /print\(1\)/)
})

test('ContextBuilder build input can override enabled system sections', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000), undefined, ['intro', 'system'])

  const built = await builder.build({
    records: [],
    tools: [],
    includeUserContext: false,
    enabledSections: ['using-tools'],
  })

  assert.doesNotMatch(built.system ?? '', /You are Hanekawa/)
  assert.doesNotMatch(built.system ?? '', /# System/)
  assert.match(built.system ?? '', /# Using your tools/)
})

test('ContextBuilder puts the permission mode reminder on the tail, not in the system prompt', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const build = (permissionMode: 'plan' | 'auto' | 'default') => builder.build({
    records: [{ type: 'message', id: 'u1', role: 'user', content: 'hi', createdAt: '2026-05-10T00:00:00.000Z' }],
    tools: [],
    includeUserContext: false,
    permissionMode,
  })

  const plan = await build('plan')
  const tail = plan.contextItems.at(-1)
  assert.equal(tail?.kind === 'message' ? tail.message.transient : undefined, true)
  const reminder = tail?.kind === 'message' ? tail.message.content : ''
  assert.match(reminder, /Plan mode is active/)
  assert.match(reminder, /AskUserQuestion for unresolved requirements/)
  assert.match(reminder, /always use ExitPlanMode/)
  assert.doesNotMatch(plan.system ?? '', /Plan mode/)

  const auto = await build('auto')
  const normal = await build('default')
  assert.equal(auto.system, plan.system)
  assert.equal(normal.system, plan.system)
  assert.equal(normal.contextItems.length, 1)
})

test('ContextBuilder injects available skills as system reminder', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
    records: [],
    tools: [{
      ...tool,
      name: 'Skill',
      description: 'Execute a skill within the main conversation',
    }],
    skills: [
      { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
      { name: 'tdd', description: 'Test-driven development', content: 'TDD content' },
    ],
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /The following skills are available for use with the Skill tool/)
  assert.match(built.system ?? '', /The following skills are available for use with the Skill tool/)
  assert.match(built.system ?? '', /- debugging: Use when diagnosing bugs/)
  assert.match(built.system ?? '', /- tdd: Test-driven development/)
  assert.doesNotMatch(built.system ?? '', /Skill: Execute a skill within the main conversation/)
  assert.doesNotMatch(built.system ?? '', /skill_debugging/)
})

test('ContextBuilder invalidates cached skills section when skills change', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const first = await builder.build({
    records: [],
    tools: [],
    skills: [
      { name: 'debugging', description: 'Use when diagnosing bugs', content: 'Debug content' },
    ],
    includeUserContext: false,
  })
  const second = await builder.build({
    records: [],
    tools: [],
    skills: [
      { name: 'review', description: 'Use when reviewing code', content: 'Review content' },
    ],
    includeUserContext: false,
  })

  assert.match(first.system ?? '', /- debugging: Use when diagnosing bugs/)
  assert.match(second.system ?? '', /- review: Use when reviewing code/)
  assert.doesNotMatch(second.system ?? '', /debugging/)
})

test('ContextBuilder activates file-matched skills from read files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  try {
    const file = path.join(dir, 'src', 'App.tsx')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>([file]),
      invokedSkills: new Map<string, { content: string; timestamp: number }>(),
    }

    const built = await builder.build({
      records: [],
      tools: [],
      skills: [
        {
          name: 'react',
          description: 'React guidance',
          content: 'Prefer small components.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.tsx'],
        },
        {
          name: 'sql',
          description: 'SQL guidance',
          content: 'Use parameterized queries.',
          inclusion: 'fileMatch',
          paths: ['src/**/*.sql'],
        },
      ],
      toolContext,
      now: new Date('2026-05-10T12:00:00.000Z'),
    })

    const userContext = built.contextItems[0]
    assert.equal(userContext?.kind, 'message')
    assert.match(userContext.message.content, /# activeSkills/)
    assert.match(userContext.message.content, /## react/)
    assert.match(userContext.message.content, /Prefer small components\./)
    assert.doesNotMatch(userContext.message.content, /Use parameterized queries/)
    assert.doesNotMatch(built.system ?? '', /react: React guidance/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder keeps always and invoked skills out of the uncached tail', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const built = await builder.build({
    records: [],
    tools: [],
    skills: [{ name: 'house-style', description: 'House style', content: 'Always use tabs.', inclusion: 'always' }],
    toolContext: {
      cwd: process.cwd(),
      sessionId: 's1',
      readFiles: new Set(),
      invokedSkills: new Map([['debugging', { content: 'Debug skill body', timestamp: 1 }]]),
    },
  })

  assert.match(built.system ?? '', /## house-style\nAlways use tabs\./)
  const tail = built.contextItems.at(-1)
  assert.equal(tail?.kind === 'message' ? tail.message.id : undefined, 'meta:user-context')
  assert.doesNotMatch(tail?.kind === 'message' ? tail.message.content : '', /Always use tabs|Debug skill body|activeSkills/)
})
test('ContextBuilder budgets messages and tool records together', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(7000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old',
      role: 'user',
      content: 'old '.repeat(8000),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'new',
      role: 'user',
      content: 'read it',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'tool_use',
      id: 'call-1',
      tool: 'Read',
      input: { filePath: 'a.txt' },
      riskLevel: 'safe',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
    {
      type: 'tool_result',
      id: 'result-1',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'file body',
      createdAt: '2026-05-10T00:03:00.000Z',
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'))
  assert.ok(built.contextItems.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
  assert.ok(built.contextItems.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1'))
})

test('the build reports the fixed cost it handed the budget', async () => {
  // The system prompt, the instruction files folded into it and the declared
  // tool schemas are what the request carries before any history; the budget
  // and the compaction check both read this one number.
  const apiInputSchema = {
    type: 'object',
    properties: { path: { type: 'string' }, body: { type: 'string', description: 'b'.repeat(900) } },
    required: ['path'],
  }
  const wideTool: Tool = {
    name: 'Write',
    description: 'Write a file',
    inputSchema: z.object({ path: z.string() }),
    apiInputSchema,
    riskLevel: 'confirm',
    execute: async () => ({ ok: true, content: '' }),
  }
  const builder = new ContextBuilder(undefined, contextWindow(9000))
  const instructions = '# AGENTS.md\n' + 'Always run the tests. '.repeat(100)

  const built = await builder.build({
    records: [{ type: 'message', id: 'u1', role: 'user', content: 'hi', createdAt: '2026-05-10T00:00:00.000Z' }],
    tools: [wideTool],
    projectContext: instructions,
    includeUserContext: false,
  })

  const instructionsMessage = built.messages.find((message) => message.id === INSTRUCTIONS_MESSAGE_ID)
  assert.ok(instructionsMessage)
  assert.equal(
    built.overhead.systemTokens,
    countTextTokens(`${built.system}\n\n${instructionsMessage.content}`),
  )
  // Measured from the schema the payload builder sends, not from the zod input.
  assert.equal(
    built.overhead.toolSchemaTokens,
    countTextTokens(`${wideTool.name}\n${wideTool.description}\n${JSON.stringify(apiInputSchema)}`),
  )
  assert.equal(built.overhead.total, built.overhead.systemTokens + built.overhead.toolSchemaTokens)
  // And the history this build selected was sized against exactly that:
  assert.equal(
    built.selection.availableTokens,
    getAvailableTokensForOverhead(contextWindow(9000), built.overhead.total),
  )
})

test('a long instruction file and a wide tool schema take budget from the oldest history', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(9000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old',
      role: 'user',
      content: 'old '.repeat(2_500),
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'message',
      id: 'new',
      role: 'user',
      content: 'now',
      createdAt: '2026-05-10T00:01:00.000Z',
    },
  ]

  const plain = await builder.build({ records, tools: [], includeUserContext: false })
  assert.ok(!plain.selection.trimmed.ids.includes('message:user:old'))

  const loaded = await builder.build({
    records,
    tools: [{
      name: 'Write',
      description: 'Write a file',
      inputSchema: z.object({ path: z.string() }),
      apiInputSchema: { type: 'object', properties: { body: { type: 'string', description: 'b'.repeat(4_000) } } },
      riskLevel: 'confirm',
      execute: async () => ({ ok: true, content: '' }),
    }],
    projectContext: '# AGENTS.md\n' + 'Always run the tests. '.repeat(300),
    includeUserContext: false,
  })

  assert.ok(loaded.selection.trimmed.ids.includes('message:user:old'))
  // The difference the record sees is exactly the difference in fixed cost.
  assert.equal(
    plain.selection.availableTokens - loaded.selection.availableTokens,
    loaded.overhead.total - plain.overhead.total,
  )
})

test('two builds of the same conversation measure the same fixed cost', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(9000))
  const input: BuildContextInput = {
    records: [{ type: 'message', id: 'u1', role: 'user', content: 'hi', createdAt: '2026-05-10T00:00:00.000Z' }],
    tools: [tool],
    includeUserContext: false,
  }

  const first = await builder.build(input)
  const second = await builder.build(input)

  assert.deepEqual(second.overhead, first.overhead)
  assert.equal(second.system, first.system)
  assert.equal(second.selection.availableTokens, first.selection.availableTokens)
})

test('ContextBuilder prepends preloaded history before child records', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const preloadRecords: SessionRecord[] = [{
    type: 'message',
    id: 'parent-message',
    role: 'user',
    content: 'parent context',
    createdAt: '2026-05-10T00:00:00.000Z',
  }]
  const records: SessionRecord[] = [{
    type: 'message',
    id: 'child-directive',
    role: 'user',
    content: 'child directive',
    createdAt: '2026-05-10T00:01:00.000Z',
  }]

  const originalPreload = [...preloadRecords]
  const built = await builder.build({
    preloadRecords,
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.deepEqual(preloadRecords, originalPreload)
  assert.deepEqual(
    built.contextItems
      .filter((item) => item.kind === 'message')
      .map((item) => item.message.id),
    ['parent-message', 'child-directive'],
  )
})

test('full request estimates use the serving model image strategy for preload and inherited history', async () => {
  const image = makeImageAttachmentRef({ width: 2000, height: 1125 })
  const parent = { id: 'inherited', role: 'user' as const, content: 'parent', createdAt: '', images: [image] }
  const input: BuildContextInput = {
    inheritedRequest: { model: 'model', system: '', messages: [parent], contextItems: [{ kind: 'message', message: parent }], cacheSource: 'agent:test' },
    preloadRecords: [{ type: 'message', ...parent, id: 'preload' }],
    records: [{ type: 'message', id: 'latest', role: 'user', content: 'continue', createdAt: '' }],
    tools: [], includeUserContext: false,
  }
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const text = await builder.build({ ...input, imageTokenStrategy: 'none' })
  const anthropic = await builder.build({ ...input, imageTokenStrategy: 'anthropic' })
  const openai = await builder.build({ ...input, imageTokenStrategy: 'openai' })
  assert.equal(anthropic.inputTokens - text.inputTokens, 6000, 'both images cost 3000 tokens before trimming')
  assert.equal(openai.inputTokens - text.inputTokens, 2210, 'both images cost 1105 tokens for OpenAI')
  assert.equal(anthropic.overhead.total - text.overhead.total, 3000, 'the inherited image reserves prefix space')
  assert.ok(anthropic.selection.trimmed.ids.includes('message:user:preload'))
  assert.equal(openai.selection.trimmed.count, 0)
  assert.deepEqual(anthropic.messages.map((message) => message.id), ['latest'])
})

test('an oversized latest instruction stays pinned instead of being replaced by older history', async () => {
  const built = await new ContextBuilder(undefined, contextWindow(4000)).build({
    inheritedRequest: { model: 'model', system: 's'.repeat(10_500), messages: [], cacheSource: 'agent:test' },
    records: [
      { type: 'message', id: 'old', role: 'user', content: 'old', createdAt: '' },
      { type: 'message', id: 'latest', role: 'user', content: 'latest instruction '.repeat(2000), createdAt: '' },
    ],
    transientUserContext: ['transient reminder'], tools: [], includeUserContext: false,
  })
  assert.ok(built.messages.some((message) => message.id === 'latest'))
  assert.ok(built.selection.overflowTokens > 0, 'an exhausted history budget must still report pinned overflow')
})

test('ContextBuilder uses latest compact boundary as prior context summary', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(8000))
  const records: SessionRecord[] = [
    {
      type: 'message',
      id: 'old',
      role: 'user',
      content: 'old detail',
      createdAt: '2026-05-10T00:00:00.000Z',
    },
    {
      type: 'compact_boundary',
      id: 'compact-1',
      summary: 'summary of old detail',
      preTokens: 1234,
      createdAt: '2026-05-10T00:01:00.000Z',
    },
    {
      type: 'message',
      id: 'new',
      role: 'user',
      content: 'new detail',
      createdAt: '2026-05-10T00:02:00.000Z',
    },
  ]

  const built = await builder.build({
    records,
    tools: [],
    includeUserContext: false,
  })

  assert.ok(!built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'old'))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'compact-1' && /summary of old detail/.test(item.message.content)))
  assert.ok(built.contextItems.some((item) => item.kind === 'message' && item.message.id === 'new'))
})

test('ContextBuilder builds the post-compact restore from recent files and skills', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'a.ts')
    await writeFile(file, 'export const a = 2', 'utf8')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>(),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
      invokedSkills: new Map([
        ['debugging', { content: 'Debug skill body', timestamp: 20 }],
      ]),
    }
    const restore = await builder.buildPostCompactRestore(toolContext)
    assert.ok(restore.files)
    assert.ok(restore.files.includes(`# restoredFile ${file}`))
    assert.match(restore.files, /export const a = 2/)
    assert.doesNotMatch(restore.files, /export const a = 1/)
    assert.equal(toolContext.readFileState.get(file)?.content, 'export const a = 2')
    assert.match(restore.files, /restoredSkill debugging/)
    assert.match(restore.files, /Debug skill body/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder renders a boundary\'s stored restore without rebuilding it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'a.ts')
    await writeFile(file, 'export const a = 2', 'utf8')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>(),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
    }

    const built = await builder.build({
      records: [{
        type: 'compact_boundary',
        id: 'compact-1',
        summary: 'summary',
        preTokens: 1234,
        postCompactRestore: 'consumed',
        restoredContext: 'stored restore',
        createdAt: '2026-05-10T00:01:00.000Z',
      }],
      tools: [],
      includeUserContext: false,
      toolContext,
    })

    const restore = built.contextItems.find((item) => item.kind === 'message' && item.message.id === 'compact-1:restore')
    assert.equal(restore?.kind === 'message' ? restore.message.content : undefined, 'stored restore')
    assert.equal(restore?.kind === 'message' ? restore.message.transient : undefined, undefined)
    assert.equal(toolContext.readFileState.get(file)?.content, 'export const a = 1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder limits restored files by recency and budget', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const readFileState = new Map<string, ReadFileState>()
    for (let index = 0; index < 7; index++) {
      const file = path.join(dir, `file-${index}.ts`)
      await writeFile(file, `file ${index}`, 'utf8')
      readFileState.set(file, {
        content: `stale ${index}`,
        timestamp: index,
        mtimeMs: index,
        size: 6,
      })
    }

    const restore = await builder.buildPostCompactRestore({
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set(),
      readFileState,
    })
    assert.ok(restore.files)
    assert.equal((restore.files.match(/# restoredFile/g) ?? []).length, 5)
    assert.match(restore.files, /file-6/)
    assert.doesNotMatch(restore.files, /file-0/)
    assert.doesNotMatch(restore.files, /stale 6/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder applies restore file budget after refreshing from disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'large.ts')
    await writeFile(file, 'x'.repeat(30_000), 'utf8')

    const restore = await builder.buildPostCompactRestore({
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set(),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'small cached content', timestamp: 1, mtimeMs: 1, size: 20 }],
      ]),
    })
    assert.ok(restore.files)
    assert.match(restore.files, /\[\.\.\. restored content truncated for context budget \.\.\.\]/)
    assert.ok(restore.files.length < 30_000)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder notes restored files that are no longer accessible', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-context-'))
  const builder = new ContextBuilder(undefined, contextWindow(50_000))
  try {
    const file = path.join(dir, 'missing.ts')
    const toolContext = {
      cwd: dir,
      sessionId: 's1',
      readFiles: new Set<string>([file]),
      readFileState: new Map<string, ReadFileState>([
        [file, { content: 'export const a = 1', timestamp: 10, mtimeMs: 10, size: 18 }],
      ]),
    }

    const restore = await builder.buildPostCompactRestore(toolContext)
    assert.ok(restore.files)
    assert.match(restore.files, new RegExp(`previously read file ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is no longer accessible`))
    assert.equal(toolContext.readFiles.has(file), false)
    assert.equal(toolContext.readFileState.has(file), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('ContextBuilder injects environment context when env is provided', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
    records: [],
    tools: [tool],
    env: {
      cwd: '/home/user/project',
      platform: 'linux',
      shell: 'bash',
      osVersion: 'Linux 6.1.0',
      isGitRepo: true,
      model: 'claude-opus-4-7',
    },
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /# Environment/)
  assert.match(built.system ?? '', /# Environment/)
  assert.match(built.system ?? '', /Primary working directory: \/home\/user\/project/)
  assert.match(built.system ?? '', /Is a git repository: true/)
  assert.match(built.system ?? '', /Platform: linux/)
  assert.match(built.system ?? '', /Shell: bash/)
  assert.match(built.system ?? '', /OS Version: Linux 6\.1\.0/)
  assert.match(built.system ?? '', /powered by the model claude-opus-4-7/)
})

test('ContextBuilder omits environment context when env is not provided', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const built = await builder.build({
    records: [],
    tools: [tool],
    now: new Date('2026-05-10T12:00:00.000Z'),
  })

  const first = built.contextItems[0]
  assert.equal(first?.kind, 'message')
  assert.doesNotMatch(first.message.content, /# Environment/)
  assert.doesNotMatch(first.message.content, /Primary working directory/)
})

test('ContextBuilder keeps currentDate dynamic across midnight boundary', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))

  const beforeMidnight = await builder.build({
    records: [],
    tools: [tool],
    now: new Date(2026, 4, 10, 23, 59),
  })
  const afterMidnight = await builder.build({
    records: [],
    tools: [tool],
    now: new Date(2026, 4, 11, 0, 1),
  })

  const before = beforeMidnight.contextItems[0]
  const after = afterMidnight.contextItems[0]
  assert.equal(before?.kind, 'message')
  assert.equal(after?.kind, 'message')
  assert.match(before.message.content, /Today's date is 2026\/05\/10/)
  assert.match(after.message.content, /Today's date is 2026\/05\/11/)
  assert.doesNotMatch(before.message.content, /Read: Read a file from disk/)
  assert.doesNotMatch(after.message.content, /Read: Read a file from disk/)
  assert.doesNotMatch(beforeMidnight.system ?? '', /Read: Read a file from disk/)
  assert.doesNotMatch(afterMidnight.system ?? '', /Read: Read a file from disk/)
  assert.doesNotMatch(beforeMidnight.system ?? '', /2026\/05\/10/)
  assert.doesNotMatch(afterMidnight.system ?? '', /2026\/05\/11/)
})

test('project context reads AGENTS.md and CLAUDE.md, nearest last', async () => {
  const { loadProjectContext, clearProjectContextCache } =
    await import('../src/services/context/projectContext.js')

  const parent = await mkdtemp(path.join(os.tmpdir(), 'myagent-ctx-parent-'))
  const child = path.join(parent, 'child')
  clearProjectContextCache()

  try {
    await mkdir(child, { recursive: true })
    await writeFile(path.join(parent, 'CLAUDE.md'), 'from the parent', 'utf8')
    await writeFile(path.join(child, 'AGENTS.md'), 'from the child', 'utf8')
    // The name Hanekawa used to invent for itself; nothing writes it any more.
    await writeFile(path.join(child, 'MYAGENT.md'), 'from a name we dropped', 'utf8')
    // Local files and rules directories are not instruction sources.
    await writeFile(path.join(child, 'AGENTS.local.md'), 'from the local layer', 'utf8')
    await mkdir(path.join(child, '.myagent', 'rules'), { recursive: true })
    await writeFile(path.join(child, '.myagent', 'rules', 'style.md'), 'from a rules file', 'utf8')

    const context = await loadProjectContext(child)

    assert.doesNotMatch(context, /a name we dropped|from the local layer|from a rules file/)
    // AGENTS.md is read because the child has no CLAUDE.md of its own.
    assert.match(context, /from the child/)
    // The nearest file overrides its ancestors, so it has to be read after them.
    assert.ok(context.indexOf('from the parent') < context.indexOf('from the child'))
  } finally {
    clearProjectContextCache()
    await rm(parent, { recursive: true, force: true })
  }
})

test('one directory contributes one instruction file, CLAUDE.md first', async () => {
  const { loadProjectContext, clearProjectContextCache } =
    await import('../src/services/context/projectContext.js')

  const project = await mkdtemp(path.join(os.tmpdir(), 'myagent-ctx-pair-'))
  clearProjectContextCache()

  try {
    // Repos that keep the two in sync would otherwise pay for the guide twice.
    await writeFile(path.join(project, 'CLAUDE.md'), 'the claude copy', 'utf8')
    await writeFile(path.join(project, 'AGENTS.md'), 'the agents copy', 'utf8')

    const context = await loadProjectContext(project)

    assert.match(context, /the claude copy/)
    assert.doesNotMatch(context, /the agents copy/)
  } finally {
    clearProjectContextCache()
    await rm(project, { recursive: true, force: true })
  }
})

test('project context is cached per cwd and invalidated per cwd', async () => {
  const { getProjectEntries, clearProjectContextCache } =
    await import('../src/services/context/projectContext.js')

  const projectA = await mkdtemp(path.join(os.tmpdir(), 'myagent-ctx-a-'))
  const projectB = await mkdtemp(path.join(os.tmpdir(), 'myagent-ctx-b-'))
  clearProjectContextCache()

  try {
    await writeFile(path.join(projectA, 'CLAUDE.md'), 'instructions for A', 'utf8')
    await writeFile(path.join(projectB, 'CLAUDE.md'), 'instructions for B', 'utf8')

    assert.match((await getProjectEntries(projectA)).join('\n'), /instructions for A/)
    assert.match((await getProjectEntries(projectB)).join('\n'), /instructions for B/)
    // A single-slot cache would have evicted A when B was read.
    assert.match((await getProjectEntries(projectA)).join('\n'), /instructions for A/)

    await writeFile(path.join(projectA, 'CLAUDE.md'), 'rewritten A', 'utf8')
    clearProjectContextCache(projectA)

    assert.match((await getProjectEntries(projectA)).join('\n'), /rewritten A/)
    assert.match((await getProjectEntries(projectB)).join('\n'), /instructions for B/)
  } finally {
    clearProjectContextCache()
    await rm(projectA, { recursive: true, force: true })
    await rm(projectB, { recursive: true, force: true })
  }
})

test('ContextBuilder maps coordination_update to a durable system-reminder user message', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const records: SessionRecord[] = [
    { type: 'message', id: 'u1', role: 'user', content: 'hi', createdAt: '2026-06-02T00:00:00.000Z' },
    { id: 'cu1', type: 'coordination_update', content: 'board v1', createdAt: '2026-06-02T00:00:01.000Z' },
  ]
  const built = await builder.build({ records, tools: [], includeUserContext: false })
  const item = built.contextItems.find((i) => i.kind === 'message' && i.message.id === 'cu1')
  assert.ok(item && item.kind === 'message')
  assert.equal(item.message.role, 'user')
  assert.match(item.message.content, /^<system-reminder>\nboard v1\n<\/system-reminder>$/)
  assert.notEqual(item.message.transient, true)
})

test('ContextBuilder places rolePrompt before the dynamic boundary and omits it when absent', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  const base = await builder.build({ records: [], tools: [], system: 'dyn-text', memoryPrompt: 'MEM' })
  const withRole = await builder.build({ records: [], tools: [], system: 'dyn-text', memoryPrompt: 'MEM', rolePrompt: 'ROLE-TEXT' })
  assert.doesNotMatch(base.system ?? '', /ROLE-TEXT/)
  const sys = withRole.system ?? ''
  assert.ok(sys.indexOf('MEM') < sys.indexOf('ROLE-TEXT'))
  assert.ok(sys.indexOf('ROLE-TEXT') < sys.indexOf('dyn-text'))
  const blocks = withRole.systemBlocks
  if (blocks) {
    const boundary = blocks.findIndex((b) => b.includes('DYNAMIC'))
    const roleIdx = blocks.findIndex((b) => b.includes('ROLE-TEXT'))
    if (boundary >= 0) assert.ok(roleIdx < boundary)
  }
})

test('buildPostCompactRestore puts leading first and returns content with nothing else to restore', async () => {
  const builder = new ContextBuilder(undefined, contextWindow(5000))
  assert.deepEqual(await builder.buildPostCompactRestore(undefined), {})
  const restore = await builder.buildPostCompactRestore(undefined, 'LEADING-BLOCK')
  assert.ok(restore.continuity)
  assert.equal(restore.files, undefined)
  assert.match(restore.continuity, /^<system-reminder>\nLEADING-BLOCK\n\nPrior conversation was compacted/)
})
