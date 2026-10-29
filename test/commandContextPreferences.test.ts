import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  createHostCommandContext,
  type HostCommandContextDeps,
} from '../src/runtime/protocol/commandContext.js'
import type { CommandContext, SetModelResult } from '../src/commands/types.js'
import type { ConfigService } from '../src/config/service.js'
import type { MyAgentSettings } from '../src/config/settings.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import { getGlobalMyAgentDir } from '../src/utils/paths.js'

/**
 * The two host commands whose pick is also a *preference*: `/model` and
 * `/effort`.
 *
 * A normal session's pick is remembered in the user layer, so the next session
 * in any project starts on it. A coordination lane is the exception — its model
 * and effort are its own `modelOverride` / `effortOverride`, and remembering one
 * there would retarget every project's next main session.
 *
 * Everything else in the context is a fake: these two commands only reach the
 * runtime slot, the config, and the session meta.
 */

beforeEach(async () => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
  await mkdir(path.join(testHome, '.myagent'), { recursive: true })
})

const userSettingsFile = (): string => path.join(getGlobalMyAgentDir(), 'settings.json')

async function readUserSettings(): Promise<MyAgentSettings> {
  return JSON.parse(await readFile(userSettingsFile(), 'utf8')) as MyAgentSettings
}

const normalSession = (): SessionMeta => ({ id: 'session-1' }) as SessionMeta

const threadSession = (): SessionMeta =>
  ({
    id: 'thread-1',
    coordination: { role: 'thread', threadId: 'thread-1', workingDir: '/tmp/worktree' },
  }) as SessionMeta

interface Calls {
  efforts: string[]
  defaultModels: string[]
}

function createContext(options: {
  session: SessionMeta
  /** What the slot reports as the level it actually applied. */
  applied?: string
  modelKeys?: string[]
}): { context: CommandContext; calls: Calls } {
  const calls: Calls = { efforts: [], defaultModels: [] }
  const applied = options.applied ?? 'high'

  const runtimeSlot = {
    current: undefined,
    getEffort: () => applied,
    setEffort: (level: string) => {
      calls.efforts.push(level)
      return applied
    },
    replace: () => {},
    reapplyEffort: () => applied,
  } as unknown as RuntimeSlot

  const config = {
    get: () => ({
      models: Object.fromEntries((options.modelKeys ?? []).map((key) => [key, { model: key }])),
    }),
    resolveModelInput: (input: string) => input,
    setDefaultModel: (name: string) => { calls.defaultModels.push(name) },
    getRouting: () => ({ main: 'inherit' }),
    setRouting: () => {},
    save: async () => {},
  } as unknown as ConfigService

  const scope = {
    createRuntime: (modelKey: string) => ({
      modelKey,
      modelConfig: { model: modelKey },
      providerName: 'anthropic',
      loop: {
        clearCachedSections: () => {},
        getActiveModel: () => ({ supportsImageInput: false }),
      },
    }),
  } as unknown as SessionScope

  const deps = {
    project: { cwd: '/tmp/command-context', config } as unknown as ProjectRuntime,
    scope,
    runtimeSlot,
    controller: {} as HostCommandContextDeps['controller'],
    getSession: () => options.session,
    getRecords: () => [],
    startNewSession: async () => {},
    emit: () => {},
  } satisfies HostCommandContextDeps

  return { context: createHostCommandContext(deps), calls }
}

function setModelResult(context: CommandContext, input: string): SetModelResult {
  const result = context.setModel!(input)
  // A promise only appears for a shell that made the member async; the host
  // factory is synchronous, and a test that awaited one would hide a change.
  assert.ok(result && typeof result === 'object' && 'ok' in result)
  return result
}

test('an effort pick in an ordinary session is remembered globally', async () => {
  const { context } = createContext({ session: normalSession(), applied: 'low' })

  await context.setEffort!('low')

  assert.equal((await readUserSettings()).effortLevel, 'low')
})

test('a coordination lane remembers no effort: its override is its own', async () => {
  const { context, calls } = createContext({ session: threadSession(), applied: 'low' })

  await context.setEffort!('low')

  assert.deepEqual(calls.efforts, ['low'], 'the live level still moved')
  assert.equal(existsSync(userSettingsFile()), false)
})

test('a raw numeric budget is not a level, so nothing is remembered', async () => {
  const { context } = createContext({ session: normalSession(), applied: '8192' })

  await context.setEffort!('8192')

  assert.equal(existsSync(userSettingsFile()), false)
})

test('a model pick in an ordinary session becomes the global default', () => {
  const { context, calls } = createContext({
    session: normalSession(),
    modelKeys: ['current', 'other'],
  })

  assert.ok(setModelResult(context, 'other').ok)

  assert.deepEqual(calls.defaultModels, ['other'])
})

test('a model pick in a coordination lane does not rewrite the global default', () => {
  const { context, calls } = createContext({
    session: threadSession(),
    modelKeys: ['current', 'other'],
  })

  assert.ok(setModelResult(context, 'other').ok)

  assert.deepEqual(calls.defaultModels, [])
})

test('a remembered effort survives as its own key rather than rewriting the file', async () => {
  await writeFile(userSettingsFile(), JSON.stringify({ thinking: false }), 'utf8')
  const { context } = createContext({ session: normalSession(), applied: 'max' })

  await context.setEffort!('max')

  const stored = await readUserSettings()
  assert.equal(stored.effortLevel, 'max')
  assert.equal(stored.thinking, false, 'the untouched key is still there')
})