import test from 'node:test'
import assert from 'node:assert/strict'
import { CODEX_ORIGINATOR, CODEX_USER_AGENT, USER_AGENT } from '../src/utils/userAgent.js'
import { AnthropicProvider } from '../src/config/providers/anthropicProvider.js'
import { ResponsesProvider } from '../src/config/providers/responsesProvider.js'

test('USER_AGENT identifies requests as claude-cli/2.1.161 (external, cli)', () => {
  assert.equal(USER_AGENT, 'claude-cli/2.1.161 (external, cli)')
})

test('Anthropic provider sends USER_AGENT as the request User-Agent header', () => {
  const provider = new AnthropicProvider({
    provider: 'anthropic',
    model: 'claude-sonnet',
    apiKey: 'test-key',
  })
  const defaultHeaders = (provider as unknown as {
    client: { _options: { defaultHeaders: Record<string, string> } }
  }).client._options.defaultHeaders
  assert.equal(defaultHeaders['User-Agent'], USER_AGENT)
})

test('Responses provider presents as Codex CLI', () => {
  const provider = new ResponsesProvider({ provider: 'openai-responses', model: 'gpt-x', apiKey: 'test-key' })
  const defaultHeaders = (provider as unknown as {
    client: { _options: { defaultHeaders: Record<string, string> } }
  }).client._options.defaultHeaders
  assert.equal(defaultHeaders['User-Agent'], CODEX_USER_AGENT)
  assert.equal(defaultHeaders.originator, CODEX_ORIGINATOR)
})
