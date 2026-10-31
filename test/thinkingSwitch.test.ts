import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAnthropicPayload } from '../src/config/providers/anthropicPayload.js'
import { loadMergedSettings, setThinkingForUser, validateSettings } from '../src/config/settings.js'
import { getGlobalHanekawaDir } from '../src/utils/paths.js'
import type { ModelRequest } from '../src/harness/types.js'

const baseRequest: ModelRequest = {
  model: 'claude-x',
  messages: [],
  cacheSource: 'repl_main_thread',
  maxOutputTokens: 4096,
}

/** A fresh temp home per test: the switch writes `~/.hanekawa/settings.json`. */
test.beforeEach(() => {
  const testHome = mkdtempSync(join(tmpdir(), 'thinking-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

async function scratchProject(): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'thinking-'))
  await mkdir(join(cwd, '.hanekawa'), { recursive: true })
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

test('thinking is one global boolean that merges and validates', async () => {
  assert.equal(validateSettings({ thinking: false }).valid, true)
  const invalid = validateSettings({ thinking: 'off' } as never)
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.some((error) => error.includes('thinking must be a boolean')))

  const cwd = await scratchProject()
  // A checked-in layer that pins thinking is ignored: the switch lives on the
  // 通用 page as one value for every project.
  await writeFile(
    join(cwd, '.hanekawa', 'settings.json'),
    JSON.stringify({ thinking: false }),
    'utf-8',
  )
  assert.equal('thinking' in await loadMergedSettings(cwd), false)

  await setThinkingForUser(true)
  // The write is a real boolean rather than a deleted key.
  const user = JSON.parse(await readFile(join(getGlobalHanekawaDir(), 'settings.json'), 'utf-8'))
  assert.equal(user.thinking, true)
  assert.equal((await loadMergedSettings(cwd)).thinking, true)

  await setThinkingForUser(false)
  assert.equal((await loadMergedSettings(cwd)).thinking, false)
})