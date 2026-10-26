import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CONTEXT_SAFETY_BUFFER_TOKENS,
  countMessageTokens,
  countMessagesTokens,
  countSessionRecordTokens,
  countTextTokens,
  countToolSchemasTokens,
  getAutoCompactThreshold,
  getAvailableTokensForOverhead,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  getManualCompactThreshold,
  getMicroCompactThreshold,
  planContextItems,
  requestOverhead,
  selectContextItemsForContext,
  selectMessagesForContext,
} from '../src/prompts/budget.js'
import { PromptComposer } from '../src/prompts/composer.js'
import type { ChatMessage, ModelContextItem } from '../src/harness/types.js'

test('context management counts tokens', () => {
  const msg: ChatMessage = {
    id: '1',
    role: 'user',
    content: 'Hello world',
    createdAt: new Date().toISOString(),
  }
  const tokens = countMessageTokens(msg)
  assert.ok(tokens > 0)

  const multiTokens = countMessagesTokens([msg, msg])
  assert.equal(multiTokens.messages.length, 2)
  assert.ok(multiTokens.total > tokens)
})

test('an assistant message counts signed thinking and Chat Completions reasoning as before', () => {
  const base: ChatMessage = { id: 'a', role: 'assistant', content: 'ok', createdAt: new Date().toISOString() }
  const reasoning = 'x'.repeat(3000)
  const plain = countMessageTokens(base)
  assert.ok(countMessageTokens({ ...base, reasoningContent: reasoning }) >= plain + 1000)
  assert.ok(countMessageTokens({ ...base, thinkingBlocks: [{ type: 'thinking', thinking: reasoning }] }) >= plain + 1000)
  const details = [{ type: 'reasoning.encrypted', data: reasoning }]
  assert.equal(countMessageTokens({ ...base, reasoningContent: reasoning, reasoningDetails: details }), plain + countTextTokens(JSON.stringify(details)))
})

test('Responses encrypted reasoning uses the Codex decoded-length estimate', () => {
  const base: ChatMessage = { id: 'a', role: 'assistant', content: 'ok', createdAt: '2026-10-26T00:00:00.000Z' }
  const plain = countMessageTokens(base)
  // Codex: floor(encoded length * 3 / 4), subtract 650 bytes, then ceil(bytes / 4).
  for (const [length, tokens] of [[0, 0], [800, 0], [867, 0], [868, 1], [900, 7], [1000, 25], [2000, 213]]) {
    assert.equal(countMessageTokens({ ...base, responseItems: [
      { type: 'reasoning', encrypted_content: 'a'.repeat(length) },
    ] }), plain + tokens, `encoded length ${length}`)
  }
  assert.equal(countMessageTokens({ ...base, responseItems: [
    { type: 'reasoning', encrypted_content: 'a'.repeat(900) },
    { type: 'reasoning', encrypted_content: 'a'.repeat(1000) },
  ] }), plain + 32, 'each reasoning item has its own envelope and rounding')
})

test('Responses reasoning estimates exclude summaries and transport metadata', () => {
  const base: ChatMessage = { id: 'a', role: 'assistant', content: 'ok', createdAt: '2026-10-26T00:00:00.000Z' }
  const reasoning = 'x'.repeat(3000)
  const items = [
    { type: 'reasoning', id: reasoning, encrypted_content: 'a'.repeat(1000), summary: [{ type: 'summary_text', text: reasoning }] },
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] },
    { type: 'function_call', arguments: 'y'.repeat(3000) },
    { type: 'message', content: [{ type: 'output_text', text: base.content }] },
  ]
  assert.equal(countMessageTokens({ ...base, reasoningContent: reasoning, responseItems: items }), countMessageTokens(base) + 25)
  assert.equal(countMessageTokens({ ...base, reasoningContent: reasoning, responseItems: [items[1]] }), countMessageTokens(base), 'plaintext Responses reasoning is excluded from replay accounting')
})

test('context management thresholds follow the defaults', () => {
  assert.equal(getEffectiveContextWindowSize(), 252_000)
  assert.equal(getMicroCompactThreshold(), 226_800)
  // 8.3% of 272k reserved.
  assert.equal(getAutoCompactThreshold(), 249_424)
  assert.equal(getManualCompactThreshold(), 249_000)
})

test('the autocompact reserve never drops below the summary output plus the compact prompt', () => {
  // 8.3% of 200k is 16.6k, less than the 20k summary plus 2k prompt.
  assert.equal(getAutoCompactThreshold({ contextWindow: 200_000 }), 178_000)
  assert.equal(getAutoCompactThreshold({ contextWindow: 272_000, autoCompactReserveRatio: 0.2 }), 217_600)
})

test('context management uses an explicitly configured context window', () => {
  const contextManagement = { contextWindow: 1_000_000, summaryOutputTokens: 20_000 }

  assert.equal(getContextWindowForModel(contextManagement), 1_000_000)
  assert.equal(getEffectiveContextWindowSize(contextManagement), 980_000)
  assert.equal(getMicroCompactThreshold(contextManagement), 882_000)
  assert.equal(getAutoCompactThreshold(contextManagement), 917_000)
  assert.equal(getManualCompactThreshold(contextManagement), 977_000)
})

test('an approval record costs nothing: it never reaches the model', () => {
  assert.equal(countSessionRecordTokens({
    type: 'tool_approval',
    id: 'approval',
    tool: 'Write',
    input: { file_path: '/tmp/a.ts', content: 'x'.repeat(30_000) },
    approved: true,
    riskLevel: 'safe',
    createdAt: new Date().toISOString(),
  }), 0)
})

test('context management defaults to 272k without an explicit context window', () => {
  assert.equal(getContextWindowForModel(), 272_000)
})

test('context management selects messages within configured window', () => {
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Short', createdAt: new Date().toISOString() },
    { id: '2', role: 'user', content: 'A'.repeat(500), createdAt: new Date().toISOString() },
    { id: '3', role: 'user', content: 'Should be truncated', createdAt: new Date().toISOString() },
  ]

  const truncated = selectMessagesForContext(messages, { contextWindow: 100, summaryOutputTokens: 0 })
  assert.ok(truncated.length < messages.length)
})

test('context management keeps newest context items and repairs tool pairing', () => {
  const items: ModelContextItem[] = [
    {
      kind: 'message',
      message: { id: 'old', role: 'user', content: 'old '.repeat(2000), createdAt: new Date().toISOString() },
    },
    {
      kind: 'message',
      message: { id: 'new', role: 'user', content: 'read file', createdAt: new Date().toISOString() },
    },
    {
      kind: 'tool_use',
      id: 'call-1',
      tool: 'Read',
      input: { filePath: 'a.txt' },
    },
    {
      kind: 'tool_result',
      toolUseId: 'call-1',
      tool: 'Read',
      ok: true,
      content: 'file body',
    },
  ]

  const truncated = selectContextItemsForContext(items, { contextWindow: 1100, summaryOutputTokens: 0 })
  assert.ok(!truncated.some((item) => item.kind === 'message' && item.message.id === 'old'))
  assert.ok(truncated.some((item) => item.kind === 'message' && item.message.id === 'new'))
  assert.ok(truncated.some((item) => item.kind === 'tool_use' && item.id === 'call-1'))
  assert.ok(truncated.some((item) => item.kind === 'tool_result' && item.toolUseId === 'call-1'))
})

test('a plan names what it dropped, by record id', () => {
  // The budget diagnostic answers "what did this request leave behind?"; the
  // count alone cannot say which old result or message went missing.
  const now = new Date().toISOString()
  const items: ModelContextItem[] = [
    { kind: 'message', message: { id: 'old-user', role: 'user', content: 'old '.repeat(2000), createdAt: now } },
    { kind: 'tool_use', id: 'call-9', tool: 'Read', input: { filePath: 'a.txt' } },
    { kind: 'tool_result', toolUseId: 'call-9', tool: 'Read', ok: true, content: 'body '.repeat(2000) },
    { kind: 'message', message: { id: 'new-user', role: 'user', content: 'read file', createdAt: now } },
  ]

  const plan = planContextItems(items, { contextWindow: 1100, summaryOutputTokens: 0 })
  assert.ok(plan.trimmed.count > 0)
  assert.ok(plan.trimmed.ids.includes('message:user:old-user'))
  assert.ok(!plan.trimmed.ids.some((id) => id.endsWith('new-user')))
  // A tool pair goes together, so the drop names both halves, never a dangling use.
  if (plan.trimmed.ids.includes('tool_use:call-9')) assert.ok(plan.trimmed.ids.includes('tool_result:call-9'))
})

test('a request\'s tool schemas come out of the window its history may use', () => {
  const config = { contextWindow: 10_000, summaryOutputTokens: 0 }
  const tools = [
    { name: 'Read', description: 'Read a file from disk', inputSchema: { type: 'object', properties: { filePath: { type: 'string' } } } },
    { name: 'Bash', description: 'Run a shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } } } },
  ]
  const bare = requestOverhead({})
  assert.deepEqual(bare, { systemTokens: 0, toolSchemaTokens: 0, total: 0 })

  const withTools = requestOverhead({ tools })
  assert.equal(withTools.systemTokens, 0)
  assert.equal(withTools.toolSchemaTokens, countToolSchemasTokens(tools))
  assert.ok(withTools.toolSchemaTokens > 0)

  // Same window, same history: only the declared schemas differ, and they are
  // money the history cannot spend.
  assert.equal(getAvailableTokensForOverhead(config, 0), 10_000 - CONTEXT_SAFETY_BUFFER_TOKENS)
  assert.equal(
    getAvailableTokensForOverhead(config, withTools.total),
    getAvailableTokensForOverhead(config, 0) - withTools.toolSchemaTokens,
  )
})

test('the fixed cost of a request is system prompt plus tool schemas, measured once', () => {
  const system = '# System\n' + 'Be careful. '.repeat(100)
  const tools = [{ name: 'Read', description: 'Read a file', inputSchema: { type: 'object' } }]
  const measured = requestOverhead({ system, tools })
  assert.equal(measured.systemTokens, countTextTokens(system))
  assert.equal(measured.total, measured.systemTokens + measured.toolSchemaTokens)
  // Two measurements of one request agree: the prefix the model caches is the
  // same request, so nothing here may vary between calls.
  assert.deepEqual(requestOverhead({ system, tools }), measured)
})

test('selecting history subtracts the tool schemas the request will carry', () => {
  const config = { contextWindow: 3_500, summaryOutputTokens: 0 }
  const messages: ChatMessage[] = [
    { id: 'long', role: 'user', content: 'old '.repeat(1_700), createdAt: new Date().toISOString() },
  ]
  // ~600 tokens of schema: the window fits the message without them, and no
  // longer does once they are paid for.
  const tools = [{ name: 'Read', description: 'd'.repeat(1_800), inputSchema: { type: 'object' } }]

  assert.deepEqual(selectMessagesForContext(messages, config).map((message) => message.id), ['long'])
  assert.deepEqual(selectMessagesForContext(messages, config, undefined, tools), [])
})

test('planning context items counts the system prompt the request carries', () => {
  const now = new Date().toISOString()
  const items: ModelContextItem[] = [
    { kind: 'message', message: { id: 'old', role: 'user', content: 'old '.repeat(600), createdAt: now } },
    { kind: 'message', message: { id: 'new', role: 'user', content: 'now', createdAt: now } },
  ]
  const config = { contextWindow: 4_000, summaryOutputTokens: 0 }

  assert.deepEqual(planContextItems(items, config).trimmed.ids, [])
  // A system prompt large enough to pay for the old message keeps it out, even
  // though the records themselves are unchanged.
  const plan = planContextItems(items, config, '# System\n' + 'Be careful. '.repeat(550))
  assert.deepEqual(plan.trimmed.ids, ['message:user:old'])
})

test('PromptComposer builds request messages', () => {
  const composer = new PromptComposer()
  const contextManagement = { contextWindow: 2000, summaryOutputTokens: 0 }

  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'Hello', createdAt: new Date().toISOString() },
  ]

  const result = composer.compose(messages, { contextManagement, includeHistory: true })
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].content, 'Hello')

  const noHistory = composer.compose(messages, { contextManagement, includeHistory: false })
  assert.equal(noHistory.messages.length, 0)
})

test('PromptComposer uses the configured context window when selecting history', () => {
  const composer = new PromptComposer()
  const contextManagement = { contextWindow: 2000, summaryOutputTokens: 0 }
  const messages: ChatMessage[] = [
    { id: '1', role: 'user', content: 'A'.repeat(2000), createdAt: new Date().toISOString() },
    { id: '2', role: 'assistant', content: 'B'.repeat(2000), createdAt: new Date().toISOString() },
  ]

  const defaultWindow = composer.compose(messages, {
    contextManagement,
    includeHistory: true,
  })
  const oneMillionWindow = composer.compose(messages, {
    contextManagement: { ...contextManagement, contextWindow: 1_000_000 },
    includeHistory: true,
  })

  assert.equal(defaultWindow.messages.length, 1)
  assert.equal(oneMillionWindow.messages.length, 2)
})

test('PromptComposer builds request context items', () => {
  const composer = new PromptComposer()
  const contextManagement = { contextWindow: 2000, summaryOutputTokens: 0 }
  const message: ChatMessage = {
    id: '1',
    role: 'user',
    content: 'Hello',
    createdAt: new Date().toISOString(),
  }

  const result = composer.composeContextItems([{ kind: 'message', message }], { contextManagement, includeHistory: true })
  assert.equal(result.messages.length, 1)
  assert.equal(result.contextItems.length, 1)

  const noHistory = composer.composeContextItems([{ kind: 'message', message }], { contextManagement, includeHistory: false })
  assert.equal(noHistory.messages.length, 0)
  assert.equal(noHistory.contextItems.length, 0)
})

test('coordinator role prompt covers routing, evidence and reporting', async () => {
  const { COORDINATOR_ROLE_PROMPT } = await import('../src/prompts/coordinatorPrompt.js')
  assert.match(COORDINATOR_ROLE_PROMPT, /^# Coordinator role/)
  for (const name of ['StartThread', 'MessageThread', 'FetchThread', 'ResolveThread']) {
    assert.ok(COORDINATOR_ROLE_PROMPT.includes(name), name)
  }
  assert.match(COORDINATOR_ROLE_PROMPT, /git diff HEAD\.\.\.<branch>/)
  assert.match(COORDINATOR_ROLE_PROMPT, /locked in read-only mode/)
  assert.match(COORDINATOR_ROLE_PROMPT, /merge bar/)
  assert.match(COORDINATOR_ROLE_PROMPT, /not proof/)
  const words = COORDINATOR_ROLE_PROMPT.split(/\s+/).length
  assert.ok(words >= 300 && words <= 650, `words=${words}`)
})
