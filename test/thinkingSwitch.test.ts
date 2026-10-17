import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAnthropicPayload } from '../src/config/providers/anthropicPayload.js'
import { loadMergedSettings, localSettingsPath, setLocalThinking, validateSettings } from '../src/config/settings.js'
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
