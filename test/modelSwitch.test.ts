import test from 'node:test'
import assert from 'node:assert/strict'
import { activateModelKey, switchModel, type ModelSwitchDeps } from '../src/runtime/modelSwitch.js'
import type { ConfigService } from '../src/config/service.js'
import type { SessionRecord } from '../src/harness/types.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { AgentSession } from '../src/runtime/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

/**
 * `/model` is a superset of the `set-model` host command: it also writes the
 * chosen model back to config. That difference had no coverage while this lived
 * inline in `App.tsx`, and it is the whole reason the two are separate functions
 * -- a fallback activation or a picker preview must not rewrite the user's
 * default.
 */

interface Calls {
  created: Array<{ modelKey: string; sessionId: string; recordCount: number }>
  clearedCachedSections: number
  replaced: string[]
  reappliedEffort: number
  defaultModels: string[]
  saves: number
}

function createDeps(overrides: {
  availableModelKeys?: string[]
  resolveModelInput?: (input: string) => string | undefined
  createRuntimeThrows?: string
  /** Capability of the runtime `createRuntime` hands back, per model key. */
  supportsImageInput?: (modelKey: string) => boolean
  records?: SessionRecord[]
} = {}): { deps: ModelSwitchDeps; calls: Calls } {
  const calls: Calls = {
    created: [],
    clearedCachedSections: 0,
    replaced: [],
    reappliedEffort: 0,
    defaultModels: [],
    saves: 0,
  }

  const session = { id: 'session-1' } as SessionMeta
  const records: SessionRecord[] = overrides.records ?? [
    { type: 'message', id: 'm1', role: 'user', content: 'a', createdAt: 'now' },
    { type: 'message', id: 'm2', role: 'assistant', content: 'b', createdAt: 'now' },
  ]

  const runtimeSlot = {
    current: {
      modelKey: 'current',
      modelConfig: { model: 'current-model', supportedEfforts: ['low', 'medium', 'high'] },
      providerName: 'anthropic',
      loop: { clearCachedSections: () => { calls.clearedCachedSections += 1 } },
    },
    replace: (next: AgentSession) => { calls.replaced.push(next.modelKey) },
    reapplyEffort: () => { calls.reappliedEffort += 1; return 'high' },
  } as unknown as RuntimeSlot

  const config = {
    resolveModelInput: overrides.resolveModelInput
      ? (input: string) => overrides.resolveModelInput!(input)
      : (input: string) => (input === 'nope' ? undefined : input),
    setDefaultModel: (name: string) => { calls.defaultModels.push(name) },
    save: async () => { calls.saves += 1 },
  } as unknown as ConfigService

  return {
    calls,
    deps: {
      config,
      runtimeSlot,
      availableModelKeys: overrides.availableModelKeys ?? ['current', 'other', 'fastModel'],
      createRuntime: (modelKey, target, recordList) => {
        if (overrides.createRuntimeThrows) throw new Error(overrides.createRuntimeThrows)
        calls.created.push({ modelKey, sessionId: target.id, recordCount: recordList.length })
        return {
          modelKey,
          modelConfig: { model: `${modelKey}-model` },
          providerName: 'anthropic',
          // The switch reads image capability off the new runtime's loop --
          // the same resolution the request path uses, never the model name.
          loop: {
            getActiveModel: () => ({
              model: `${modelKey}-model`,
              supportsImageInput: overrides.supportsImageInput?.(modelKey) ?? false,
            }),
          },
        } as unknown as AgentSession
      },
      getSession: () => session,
      getRecords: () => records,
    },
  }
}

test('activateModelKey replaces the runtime and reports the new model', () => {
  const { deps, calls } = createDeps()

  const result = activateModelKey(deps, 'other')

  assert.ok(result.ok)
  assert.deepEqual(result.model, { key: 'other', model: 'other-model', providerName: 'anthropic' })
  assert.deepEqual(calls.created, [{ modelKey: 'other', sessionId: 'session-1', recordCount: 2 }])
  assert.equal(calls.clearedCachedSections, 1,
    'the cached Environment section embeds the model name, so a stale prefix would survive')
  assert.deepEqual(calls.replaced, ['other'])
  assert.equal(calls.reappliedEffort, 1, 'effort has to be re-clamped to the new model supportedEfforts')
})

test('activateModelKey leaves the runtime alone for a key that is not configured', () => {
  const { deps, calls } = createDeps()

  const result = activateModelKey(deps, 'ghost')

  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('未知模型：ghost'))
  // Only configured keys are offerable; the tier names are gone.
  assert.deepEqual(!result.ok && result.availableModels, ['current', 'other', 'fastModel'])
  assert.deepEqual(calls.replaced, [])
  assert.equal(calls.clearedCachedSections, 0, 'a refused switch must not invalidate the prompt cache')
})

test('activateModelKey turns a construction failure into a message, not a throw', () => {
  const { deps, calls } = createDeps({ createRuntimeThrows: 'no API key for endpoint "x"' })

  const result = activateModelKey(deps, 'other')

  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('no API key'))
  assert.deepEqual(calls.replaced, [])
})

test('switchModel persists the resolved model key, not the raw input', () => {
  const { deps, calls } = createDeps({
    resolveModelInput: (input) => (input === 'Other' ? 'other' : input),
  })

  const result = switchModel(deps, 'Other')

  assert.ok(result.ok)
  assert.equal(result.model.key, 'other')
  assert.deepEqual(calls.defaultModels, ['other'], 'this is what set-model deliberately does not do')
  assert.equal(calls.saves, 1)
})

test('switchModel persists every successful switch', () => {
  const { deps, calls } = createDeps()

  assert.ok(switchModel(deps, 'other').ok)
  // With no tiers there is no "belongs to no tier" case left: naming a model is
  // always a preference worth remembering.
  assert.deepEqual(calls.defaultModels, ['other'])
  assert.equal(calls.saves, 1)
})

test('switchModel does not persist a model for a switch that failed', () => {
  const { deps, calls } = createDeps({ createRuntimeThrows: 'boom' })

  assert.equal(switchModel(deps, 'other').ok, false)
  assert.deepEqual(calls.defaultModels, [], 'persisting here would leave config pointing at a model that failed')
  assert.equal(calls.saves, 0)
})

test('switchModel explains inherit rather than calling it unknown', () => {
  const { deps } = createDeps({ resolveModelInput: () => undefined })

  const result = switchModel(deps, 'inherit')
  assert.equal(result.ok, false)
  assert.ok(!result.ok && result.message.includes('only valid in routing/subagent settings'))

  const other = switchModel(deps, 'sonnet-9')
  assert.ok(!other.ok && other.message.includes('未知模型：sonnet-9'))
})

// --- image impact of a manual switch (S21, design §9.1) ----------------------

/** A conversation carrying one image, as the switch sees it. */
function recordsWithImage(): SessionRecord[] {
  return [
    {
      type: 'message',
      id: 'm1',
      role: 'user',
      content: 'what is this',
      images: [makeImageAttachmentRef({ id: 'img-1', ownerSessionId: 'session-1', name: 'shot.png' })],
      createdAt: 'now',
    },
    { type: 'message', id: 'm2', role: 'assistant', content: 'a screenshot', createdAt: 'now' },
  ]
}

test('switching to a text-only model is allowed and reports what happens to the history', () => {
  const { deps, calls } = createDeps({ records: recordsWithImage() })

  const result = activateModelKey(deps, 'other')

  // History never refuses a manual switch -- it only changes the next request.
  assert.ok(result.ok)
  assert.deepEqual(calls.replaced, ['other'])
  assert.ok(result.notice)
  assert.match(result.notice, /other-model does not accept images/)
  assert.match(result.notice, /1 image in this conversation/)
  assert.match(result.notice, /sent as file paths/)
  assert.match(result.notice, /originals are kept/)
})

test('switching back to an image-capable model says the history is sent again', () => {
  const { deps } = createDeps({
    records: recordsWithImage(),
    supportsImageInput: (modelKey) => modelKey === 'other',
  })

  const result = activateModelKey(deps, 'other')

  assert.ok(result.ok && result.notice)
  assert.match(result.notice, /will be sent again/)
  // Old turns a summary already replaced are not re-expanded, and saying so
  // is the difference between "restored" and "restored where it still exists".
  assert.match(result.notice, /not re-expanded/)
})

test('a conversation with no images gets no image notice', () => {
  const { deps } = createDeps()

  const result = switchModel(deps, 'other')

  assert.ok(result.ok)
  assert.equal(result.notice, undefined)
})

test('a failed config save does not turn a live switch into a failure', async () => {
  const { deps, calls } = createDeps()
  ;(deps.config as unknown as { save: () => Promise<void> }).save = async () => {
    calls.saves += 1
    throw new Error('disk full')
  }

  // The slot already took the change; a preference that did not persist is not
  // a failed switch, and the rejection must not surface as an unhandled one.
  assert.ok(switchModel(deps, 'other').ok)
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(calls.saves, 1)
})
