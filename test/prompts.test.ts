import test from 'node:test'
import assert from 'node:assert/strict'
import {
  countMessageTokens,
  countMessagesTokens,
  getAutoCompactThreshold,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  getManualCompactThreshold,
  getMicroCompactThreshold,
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

test('an assistant message counts the reasoning it replays to its provider', () => {
  const base: ChatMessage = { id: 'a', role: 'assistant', content: 'ok', createdAt: new Date().toISOString() }
  const reasoning = 'x'.repeat(3000)
  const plain = countMessageTokens(base)
  assert.ok(countMessageTokens({ ...base, reasoningContent: reasoning }) >= plain + 1000)
  assert.ok(countMessageTokens({ ...base, thinkingBlocks: [{ type: 'thinking', thinking: reasoning }] }) >= plain + 1000)
  // Only the reasoning items: the message and call items repeat what is counted elsewhere.
  const items = [
    { type: 'reasoning', content: [{ type: 'reasoning_text', text: reasoning }] },
    { type: 'function_call', arguments: 'y'.repeat(3000) },
  ]
  const withItems = countMessageTokens({ ...base, reasoningContent: reasoning, responseItems: items })
  assert.ok(withItems >= plain + 1000 && withItems < plain + 1100)
})

test('context management thresholds follow Claude Code style defaults', () => {
  assert.equal(getEffectiveContextWindowSize(), 180_000)
  assert.equal(getMicroCompactThreshold(), 162_000)
  assert.equal(getAutoCompactThreshold(), 167_000)
  assert.equal(getManualCompactThreshold(), 177_000)
})

test('context management uses an explicitly configured context window', () => {
  const contextManagement = { contextWindow: 1_000_000, summaryOutputTokens: 20_000 }

  assert.equal(getContextWindowForModel(contextManagement), 1_000_000)
  assert.equal(getEffectiveContextWindowSize(contextManagement), 980_000)
  assert.equal(getMicroCompactThreshold(contextManagement), 882_000)
  assert.equal(getAutoCompactThreshold(contextManagement), 911_400)
  assert.equal(getManualCompactThreshold(contextManagement), 977_000)
})

test('context management defaults to 200k without an explicit context window', () => {
  assert.equal(getContextWindowForModel(), 200_000)
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
