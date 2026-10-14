import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAnthropicPayload } from '../src/config/providers/anthropicPayload.js'
import { loadMergedSettings, localSettingsPath, setLocalThinking, validateSettings } from '../src/config/settings.js'
import { thinkingCommand, parseThinkingArgument } from '../src/commands/thinking.js'
import type { CommandContext } from '../src/commands/types.js'
import type { ModelRequest } from '../src/harness/types.js'

const baseRequest: ModelRequest = {
  model: 'claude-x',
  messages: [],
  cacheSource: 'repl_main_thread',
  maxOutputTokens: 4096,
}

async function scratchProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'thinking-'))
  await mkdir(join(cwd, '.myagent'), { recursive: true })
  return cwd
}

function stubContext(overrides: Partial<CommandContext> = {}): {
  context: CommandContext
  lines: string[]
} {
  const lines: string[] = []
  return {
    lines,
    context: {
      cwd: '/tmp',
      sessionId: 's1',
      writeLine: (line) => lines.push(line),
      clearMessages: () => {},
      ...overrides,
    } as CommandContext,
  }
}

test('a disabled thinking config sends no thinking parameter', () => {
  const payload = buildAnthropicPayload({ ...baseRequest, thinking: { type: 'disabled' } }) as Record<string, unknown>
  assert.equal('thinking' in payload, false)
})

test('an absent thinking config still defaults to adaptive', () => {
  const payload = buildAnthropicPayload(baseRequest) as Record<string, unknown>
  assert.deepEqual(payload.thinking, { type: 'adaptive' })
})

test('thinking is a boolean setting that merges and validates', async () => {
  assert.equal(validateSettings({ thinking: false }).valid, true)
  const invalid = validateSettings({ thinking: 'off' } as never)
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.includes('thinking must be a boolean')))

  const cwd = await scratchProject()
  await writeFile(
    join(cwd, '.myagent', 'settings.json'),
    JSON.stringify({ thinking: true }),
    'utf-8',
  )
  await setLocalThinking(cwd, false)

  // The local layer wins over the project layer, and the write is a real
  // boolean rather than a deleted key.
  const local = JSON.parse(await readFile(localSettingsPath(cwd), 'utf-8'))
  assert.equal(local.thinking, false)
  const merged = await loadMergedSettings(cwd)
  assert.equal(merged.thinking, false)

  await setLocalThinking(cwd, true)
  assert.equal((await loadMergedSettings(cwd)).thinking, true)
})

test('/thinking reports the current state without an argument', async () => {
  const { context, lines } = stubContext({
    getThinking: () => false,
    setThinking: () => assert.fail('must not write without an argument'),
  })
  await thinkingCommand.run('', context)
  assert.match(lines.join('\n'), /Thinking: off/)
})

test('/thinking off turns the switch off, and a bad word changes nothing', async () => {
  const calls: boolean[] = []
  const { context, lines } = stubContext({
    getThinking: () => true,
    setThinking: (enabled) => { calls.push(enabled) },
  })

  await thinkingCommand.run('off', context)
  assert.deepEqual(calls, [false])

  await thinkingCommand.run('sometimes', context)
  assert.deepEqual(calls, [false])
  assert.match(lines.join('\n'), /无效的值/)
})

test('parseThinkingArgument accepts the usual spellings', () => {
  assert.equal(parseThinkingArgument('ON'), true)
  assert.equal(parseThinkingArgument(' disable '), false)
  assert.equal(parseThinkingArgument('maybe'), undefined)
})
