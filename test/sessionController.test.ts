import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { SessionController, type SessionEvent } from '../src/runtime/sessionController.js'
import { createRecordProxy } from '../src/runtime/bridges.js'
import { SessionStore } from '../src/sessions/service.js'
import type { SessionMeta } from '../src/sessions/service.js'
import type { CoordinationRole } from '../src/harness/types.js'
import type {
  AgentRunResult,
  SessionRecord,
  ToolProgressEvent,
} from '../src/harness/types.js'
import type { AgentSession } from '../src/runtime/types.js'
import type { CompactCheckResult } from '../src/harness/compact.js'
import type { FileHistoryService } from '../src/services/fileHistory/fileHistoryService.js'
import type { UserInput } from '../src/media/types.js'
import { assertNewImagesAllowed, TurnImageBlockError } from '../src/harness/turnImages.js'
import { imageErrorCopy } from '../src/media/imageErrors.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

type LoopRun = (
  input: UserInput,
  signal?: AbortSignal,
  messageId?: string,
  overrides?: unknown,
) => Promise<AgentRunResult>

interface Counters {
  invalidateCalls: number
  snapshots: number
  fileHistoryDisposals: number
}

interface Harness {
  controller: SessionController
  events: SessionEvent[]
  store: SessionStore
  session: SessionMeta
  proxy: ReturnType<typeof createRecordProxy>
  snapshotCalls: string[]
  trackedFiles: string[]
  counters: Counters
}

function usage(inputTokens: number, outputTokens: number) {
  return { inputTokens, cacheReadInputTokens: 0, outputTokens }
}

function okResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return { content: 'ok', usage: usage(10, 5), ...overrides }
}

async function createHarness(options: {
  run?: LoopRun
  retry?: (failure: { id: string; userMessageId: string }) => Promise<AgentRunResult>
  /** The history cannot be read back, so the session runs without one. */
  fileHistoryInitFails?: boolean
  /** No title yet — the state a session is in until its first message. */
  untitled?: boolean
  /** The stub loop's image capability; defaults to capable. */
  imageCapable?: boolean
  /** Coordination role stamped on the session. */
  role?: CoordinationRole
  /** The stub loop's usable context window. */
  usableContextWindow?: number
  /** What the side model answers when asked to name the session. */
  titleReply?: string
  /** The model key the loop is on; differs from the runtime's after a fallback. */
  activeModelKey?: string
  /** Lets a test hold the turn in its prepare stage. */
  snapshotGate?: (messageId: string) => Promise<void>
  /** The stub compactor, when a test needs to hold or inspect it. */
  compact?: (instructions?: string, signal?: AbortSignal) => Promise<CompactCheckResult>
} = {}): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-controller-'))
  const store = new SessionStore(cwd)
  await store.init()
  let session = options.untitled ? await store.create() : await store.create('controller test')
  if (options.role) session = { ...session, coordination: { role: options.role, projectKey: 'p' } }

  const snapshotCalls: string[] = []
  const trackedFiles: string[] = []
  const events: SessionEvent[] = []
  const counters: Counters = { invalidateCalls: 0, snapshots: 0, fileHistoryDisposals: 0 }

  const loop = {
    run: options.run ?? (async () => okResult()),
    retry: options.retry ?? (async () => okResult()),
    getSideModel: () => ({
      model: 'side-model',
      provider: { name: 'stub', createMessage: async () => ({ content: options.titleReply ?? '' }) },
    }),
    getActiveModel: () => ({
      model: 'test-model',
      modelKey: options.activeModelKey ?? 'main',
      ...(options.imageCapable === false ? {} : { supportsImageInput: true }),
    }),
    // The real submission rule, so the pre-turn-start gate is exercised the
    // way production wires it — the loop owns the rule, the stub only mirrors.
    assertImagesAllowedForSubmission: (input: UserInput) =>
      assertNewImagesAllowed(input.images, options.imageCapable !== false, 'test-model'),
    invalidateRecordsCache: () => { counters.invalidateCalls += 1 },
    getContextBudget: () => ({ usableContextWindow: options.usableContextWindow ?? 1000 }),
    compact: options.compact ?? (async () => ({ compacted: false, usage: usage(0, 0) })),
  }

  const fileHistoryService = {
    init: async () => {
      if (options.fileHistoryInitFails) throw new Error('unreadable history')
    },
    dispose: () => { counters.fileHistoryDisposals += 1 },
    makeSnapshot: async (messageId: string) => {
      snapshotCalls.push(messageId)
      await options.snapshotGate?.(messageId)
    },
    trackEdit: async (filePath: string) => { trackedFiles.push(filePath) },
  } as unknown as FileHistoryService

  const proxy = createRecordProxy()
  const controller = new SessionController({
    cwd,
    store,
    session,
    existingRecords: [],
    recordProxy: proxy,
    getSession: () => ({
      loop,
      modelKey: 'main',
      modelConfig: { model: 'test-model', baseUrl: 'https://llm.example/v1' },
      providerName: 'stub',
    } as unknown as AgentSession),
    createFileHistoryService: () => fileHistoryService,
  })

  controller.onEvent((event) => events.push(event))
  controller.subscribe(() => { counters.snapshots += 1 })

  // init() is async; let it settle so the history is armed like in production.
  await Promise.resolve()
  await Promise.resolve()

  return { controller, store, session, proxy, events, snapshotCalls, trackedFiles, counters }
}

function abortError(): Error {
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

function types(events: SessionEvent[]): string[] {
  return events.map((event) => event.type)
}

test('a successful turn emits turn-start before the loop runs and turn-end after', async () => {
  const order: string[] = []
  let seenMessageId: string | undefined
  const harness = await createHarness({
    run: async (_input, _signal, messageId) => {
      order.push('loop.run')
      seenMessageId = messageId
      return okResult()
    },
  })
  harness.controller.onEvent((event) => order.push(event.type))

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(order, ['turn-start', 'loop.run', 'active-model', 'turn-end'])

  const start = harness.events[0]
  assert.equal(start?.type, 'turn-start')
  assert.equal(start.type === 'turn-start' ? start.displayInput : undefined, 'hello')
  // The same id threads through the snapshot, the loop run and any rollback.
  assert.equal(seenMessageId, start.type === 'turn-start' ? start.messageId : 'mismatch')
  assert.deepEqual(harness.snapshotCalls, [seenMessageId])

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  assert.equal(end.aborted, false)
  assert.equal(end.rolledBack, false)
  assert.deepEqual(end.usage, usage(10, 5))

  const snapshot = harness.controller.getSnapshot()
  assert.equal(snapshot.isStreaming, false)
  assert.deepEqual(snapshot.usage.total, usage(10, 5))
})

function failureRecord(harness: Harness) {
  const event = harness.events.find((candidate) => candidate.type === 'record' && candidate.record.type === 'turn_failure')
  return event?.type === 'record' && event.record.type === 'turn_failure' ? event.record : undefined
}

test('a failed turn persists why it stopped but is not aborted, so the duration summary still renders', async () => {
  const harness = await createHarness({
    run: async () => {
      throw Object.assign(new Error('provider exploded'), {
        status: 429,
        cause: { cause: { code: 'ECONNREFUSED' } },
      })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  const start = harness.events.find((event) => event.type === 'turn-start')
  const failure = failureRecord(harness)
  assert.equal(failure?.error, 'provider exploded')
  assert.equal(failure?.status, 429)
  assert.equal(failure?.code, 'ECONNREFUSED')
  assert.equal(failure?.model, 'test-model')
  assert.equal(failure?.baseUrl, 'https://llm.example/v1')
  assert.equal(failure?.userMessageId, start?.type === 'turn-start' ? start.messageId : undefined)
  assert.equal(harness.events.some((event) => event.type === 'notice'), false)
  // The record is on disk, so a reopened session still says why it stopped.
  const stored = await harness.store.loadRecords(harness.session.id)
  assert.deepEqual(stored.filter((record) => record.type === 'turn_failure').map((record) => record.id), [failure?.id])

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  // `aborted` mirrors the signal, not "did it throw" — this is what keeps the
  // "Worked for Xs" line on failed turns.
  assert.equal(end.aborted, false)
  assert.equal(end.failed, true)
  assert.equal(end.usage, undefined)
})

test('retrying a failed turn runs it again on its own message, and only the newest failure can be', async () => {
  const retried: unknown[] = []
  const harness = await createHarness({
    run: async () => { throw Object.assign(new Error('provider exploded'), { status: 500 }) },
    retry: async (failure) => {
      retried.push(failure)
      return okResult()
    },
  })
  await harness.controller.submit({ text: 'hello' })
  const failure = failureRecord(harness)!

  await harness.controller.retryTurn(failure.id)
  const start = harness.events.filter((event) => event.type === 'turn-start').at(-1)
  assert.equal(start?.type === 'turn-start' ? start.retryOf : undefined, failure.id)
  assert.equal(start?.type === 'turn-start' ? start.messageId : undefined, failure.userMessageId)
  assert.equal((retried[0] as { id: string }).id, failure.id)
  assert.equal(harness.events.at(-1)?.type, 'turn-end')

  await assert.rejects(harness.controller.retryTurn('unknown'), /newest failed turn/)
})

test('a stop that surfaces as a provider error of its own is an interruption, not a failure', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async () => {
      controller.interrupt()
      // What the OpenAI SDK throws for a cancelled request: not named `AbortError`.
      throw Object.assign(new Error('Request was aborted.'), { name: 'APIUserAbortError' })
    },
  })
  controller = harness.controller

  await controller.submit({ text: 'hello' })

  assert.equal(failureRecord(harness), undefined)
  const end = harness.events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.failed : 'missing', false)
})

test('a failure after the session fell back to another model does not blame the primary endpoint', async () => {
  const harness = await createHarness({
    run: async () => { throw new Error('fallback down') },
    activeModelKey: 'fallback',
  })

  await harness.controller.submit({ text: 'hello' })

  const failure = failureRecord(harness)
  assert.equal(failure?.baseUrl, undefined)
  assert.equal(failure?.providerName, undefined)
})

test('a failure that cannot be written still reaches the user as a notice', async () => {
  const harness = await createHarness({ run: async () => { throw new Error('provider exploded') } })
  mock.method(harness.store, 'appendRecord', async () => { throw new Error('disk full') })

  await harness.controller.submit({ text: 'hello' })

  const notice = harness.events.find((event) => event.type === 'notice')
  assert.equal(notice?.type === 'notice' ? notice.level : undefined, 'error')
  assert.equal(notice?.type === 'notice' ? notice.content : undefined, 'provider exploded')
})

test('a mid-turn image block reaches the record with its exit; other failures keep their words', async () => {
  // S24: a fallback or plan route onto a text-only model fails inside the run,
  // where the persisted failure is the only trace the user gets.
  const blocked = await createHarness({
    run: async () => {
      throw new TurnImageBlockError('model-not-capable', [], 'Model text-only does not accept image input.')
    },
  })
  await blocked.controller.submit({ text: 'look' })
  const content = failureRecord(blocked)?.error ?? ''
  assert.ok(content.startsWith('Model text-only does not accept image input.'), content)
  assert.ok(content.endsWith(imageErrorCopy('model-not-capable')!.action), content)

  // The previous test pins the other half: an ordinary provider failure — an
  // HTTP status, a bad endpoint — is reported word for word, never relabelled
  // as an image problem (design §13: 不谎称已避免).
})

test('submit hands the loop the full UserInput — text and image refs intact', async () => {
  const seen: UserInput[] = []
  const harness = await createHarness({
    run: async (input) => {
      seen.push(input)
      return okResult()
    },
  })

  const images = [
    makeImageAttachmentRef({ id: 'img-a', ownerSessionId: 's', name: 'first.png' }),
    makeImageAttachmentRef({ id: 'img-b', ownerSessionId: 's', name: 'second.png' }),
  ]
  await harness.controller.submit({ text: 'hello', images })

  assert.deepEqual(seen, [{ text: 'hello', images }])
})

test('a text-only model rejects an image-bearing submit before turn-start', async () => {
  const harness = await createHarness({ imageCapable: false })

  const images = [makeImageAttachmentRef({ id: 'img-x', ownerSessionId: 's', name: 'shot.png' })]
  await assert.rejects(
    harness.controller.submit({ text: 'look at this', images }),
    (error: unknown) =>
      error instanceof Error && /does not accept image input/.test(error.message),
  )

  // The turn never started: no turn-start, no snapshot, no records on disk.
  assert.equal(harness.events.filter((event) => event.type === 'turn-start').length, 0)
  assert.equal(harness.events.filter((event) => event.type === 'turn-end').length, 0)
  assert.equal(harness.snapshotCalls.length, 0)
  const stored = await harness.store.loadRecords(harness.session.id)
  assert.equal(stored.length, 0)
})

test('a rolled-back turn restores the input images with the text, in order', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input.text,
        ...(input.images && input.images.length > 0 ? { images: input.images } : {}),
        remainingTasks: [],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  const images = [
    makeImageAttachmentRef({ id: 'img-r1', ownerSessionId: 's', name: 'first.png' }),
    makeImageAttachmentRef({ id: 'img-r2', ownerSessionId: 's', name: 'second.png' }),
  ]
  await controller.submit({ text: 'rollback me', images })

  const restore = harness.events.find((event) => event.type === 'restore-input')
  assert.equal(restore?.type === 'restore-input' ? restore.text : undefined, 'rollback me')
  if (restore?.type !== 'restore-input') return
  assert.deepEqual(restore.images, images)

  // The rollback really removed the user message, so the refs exist only in
  // the restored draft — not as a leftover record.
  const remaining = await harness.store.loadRecords(harness.session.id)
  assert.equal(remaining.some((record) => record.type === 'message' && record.id !== undefined && record.role === 'user'), false)
})

test('a user cancel whose turn left only synthetic records rolls the prompt back', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input.text,
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input.text,
        remainingTasks: [],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  await controller.submit({ text: 'rollback me' })

  assert.deepEqual(
    types(harness.events),
    ['turn-start', 'transcript-reset', 'restore-input', 'active-model', 'turn-end'],
  )

  const reset = harness.events.find((event) => event.type === 'transcript-reset')
  assert.equal(reset?.type, 'transcript-reset')
  // Rolling back the current turn must not remount the transcript view.
  assert.equal(reset?.type === 'transcript-reset' ? reset.bumpGeneration : true, false)

  const restore = harness.events.find((event) => event.type === 'restore-input')
  assert.equal(restore?.type === 'restore-input' ? restore.text : undefined, 'rollback me')

  const end = harness.events.at(-1)
  assert.equal(end?.type, 'turn-end')
  if (end?.type !== 'turn-end') return
  assert.equal(end.aborted, true)
  assert.equal(end.rolledBack, true)
  assert.equal(harness.counters.invalidateCalls, 1)
})

test('a user cancel that produced real work reports the interruption instead of rolling back', async () => {
  let controller!: SessionController
  const harness = await createHarness({
    run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!,
        type: 'message',
        role: 'user',
        content: input.text,
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'tool_result',
        toolUseId: randomUUID(),
        tool: 'Bash',
        ok: true,
        content: 'done',
        createdAt: new Date().toISOString(),
      })
      await harness.store.appendRecord(harness.session.id, {
        id: randomUUID(),
        type: 'turn_interruption',
        userMessageId: messageId!,
        prompt: input.text,
        remainingTasks: [
          { id: '1', status: 'pending', subject: 'a', description: 'a' },
          { id: '2', status: 'pending', subject: 'b', description: 'b' },
        ],
        recoverable: true,
        createdAt: new Date().toISOString(),
      })
      controller.interrupt()
      throw abortError()
    },
  })
  controller = harness.controller

  await controller.submit({ text: 'keep me' })

  assert.deepEqual(types(harness.events), ['turn-start', 'notice', 'active-model', 'turn-end'])
  const notice = harness.events.find((event) => event.type === 'notice')
  assert.equal(notice?.type === 'notice' ? notice.level : undefined, 'system')
  assert.equal(notice?.type === 'notice' ? notice.content : undefined, 'Interrupted. 2 tasks remaining.')

  const end = harness.events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.aborted : undefined, true)
  assert.equal(end?.type === 'turn-end' ? end.rolledBack : undefined, false)
  assert.equal(harness.counters.invalidateCalls, 0)
})

test('token usage accumulates across turns and resets when the session is retargeted', async () => {
  let call = 0
  const harness = await createHarness({
    run: async () => {
      call += 1
      return okResult({ usage: usage(call * 100, call), statusUsage: usage(call * 100, call) })
    },
  })

  await harness.controller.submit({ text: 'one' })
  await harness.controller.submit({ text: 'two' })

  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(300, 3))
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(200, 2))

  harness.controller.retarget({ ...harness.session, id: 'other-session' }, [])
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(0, 0))
  assert.equal(harness.controller.getSnapshot().usage.lastRequest, null)
  assert.equal(harness.controller.getSessionId(), 'other-session')
})

test('the turn’s output tokens do not follow a retarget into another session', async () => {
  const harness = await createHarness({
    run: async () => {
      harness?.proxy.onRequestUsage(usage(100, 7))
      return okResult({ usage: usage(100, 7), statusUsage: usage(100, 7) })
    },
  })
  await harness.controller.submit({ text: 'one' })
  assert.equal(harness.controller.getSnapshot().turnOutputTokens, 7, 'kept after the turn, for its footer')

  harness.controller.retarget({ ...harness.session, id: 'other-session' }, [])
  assert.equal(harness.controller.getSnapshot().turnOutputTokens, undefined)
})

test('a request that lands mid-turn moves both lastRequest and the running total', async () => {
  let harness: Harness | undefined
  const seenMidTurn: Array<{ inputTokens: number; outputTokens: number } | null> = []
  const totalsMidTurn: Array<{ inputTokens: number; outputTokens: number }> = []
  harness = await createHarness({
    run: async () => {
      // Two requests inside one turn, the way a tool step produces them.
      harness?.proxy.onRequestUsage(usage(1000, 1))
      seenMidTurn.push(harness?.controller.getSnapshot().usage.lastRequest ?? null)
      totalsMidTurn.push(harness!.controller.getSnapshot().usage.total)
      harness?.proxy.onRequestUsage(usage(2000, 2))
      seenMidTurn.push(harness?.controller.getSnapshot().usage.lastRequest ?? null)
      totalsMidTurn.push(harness!.controller.getSnapshot().usage.total)
      return okResult({ usage: usage(3000, 3), statusUsage: usage(2000, 2) })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(seenMidTurn, [usage(1000, 1), usage(2000, 2)])
  // The readout counts up as the turn runs rather than jumping once at the end.
  assert.deepEqual(totalsMidTurn, [usage(1000, 1), usage(3000, 3)])
  // And the settle adds only what the mid-turn path could not have seen, so the
  // run's own figure is still the total — not twice it.
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(3000, 3))
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(2000, 2))
})

test('the turn output count adds up its requests, starts absent and clears on the next turn', async () => {
  let harness: Harness | undefined
  const seen: Array<number | undefined> = []
  let reports = [usage(1000, 5), usage(2000, 7)]
  harness = await createHarness({
    run: async () => {
      seen.push(harness!.controller.getSnapshot().turnOutputTokens)
      for (const report of reports) {
        harness!.proxy.onRequestUsage(report)
        seen.push(harness!.controller.getSnapshot().turnOutputTokens)
      }
      // Compaction and subagents never reach the count.
      return okResult({ usage: usage(9000, 99) })
    },
  })

  assert.equal(harness.controller.getSnapshot().turnOutputTokens, undefined)
  await harness.controller.submit({ text: 'hello' })
  assert.deepEqual(seen, [undefined, 5, 12])
  assert.equal(harness.controller.getSnapshot().turnOutputTokens, 12)

  seen.length = 0
  reports = []
  await harness.controller.submit({ text: 'again' })
  assert.deepEqual(seen, [undefined])
  assert.equal(harness.controller.getSnapshot().turnOutputTokens, undefined)
})

test('compaction and subagent usage still land on top of the reported requests', async () => {
  // `AgentRunResult.usage` is the foreground responses *plus* compaction and
  // subagent transcripts, which never come through `onRequestUsage` — the
  // difference is exactly what the settle has left to add.
  let harness: Harness | undefined
  harness = await createHarness({
    run: async () => {
      harness?.proxy.onRequestUsage(usage(1000, 1))
      return okResult({ usage: usage(1700, 5), statusUsage: usage(1000, 1) })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(1700, 5))
})

test('a failed run keeps the tokens its requests already spent', async () => {
  let harness: Harness | undefined
  let failing = true
  harness = await createHarness({
    run: async () => {
      if (!failing) return okResult({ usage: usage(100, 1) })
      harness?.proxy.onRequestUsage(usage(900, 7))
      throw new Error('provider exploded')
    },
  })

  await harness.controller.submit({ text: 'hello' })

  // The run never reached its settle, but the request was billed all the same.
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(900, 7))
  assert.equal(harness.controller.getSnapshot().turnOutputTokens, 7)
  // And the abandoned accumulator must not be subtracted from the next run.
  failing = false
  await harness.controller.submit({ text: 'again' })
  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(1000, 8))
})

test('a run that produced no response keeps the last request rather than falling back to an estimate', async () => {
  let harness: Harness | undefined
  harness = await createHarness({
    run: async () => {
      harness?.proxy.onRequestUsage(usage(1500, 4))
      return okResult({ usage: usage(0, 0) })
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, usage(1500, 4))
})

test('lastRequest is restored from the metrics sidecar for a session this process never ran', async () => {
  const harness = await createHarness()
  const resumed = await harness.store.create('resumed session')
  await harness.store.appendRecord(resumed.id, {
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: 'earlier',
    createdAt: new Date().toISOString(),
  })
  await harness.store.appendMetric(resumed.id, {
    event: 'turn',
    model: 'test-model',
    input_tokens: 19_000,
    response_tokens: 120,
    cache_read_tokens: 5_000,
    cache_hit_rate: null,
    tool_calls: 0,
    duration_ms: 10,
  })

  harness.controller.retarget(resumed, [])
  // The read is fire-and-forget — the switch does not wait on the disk.
  for (let attempt = 0; attempt < 50 && !harness.controller.getSnapshot().usage.lastRequest; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(
    harness.controller.getSnapshot().usage.lastRequest,
    { inputTokens: 19_000, cacheReadInputTokens: 5_000, outputTokens: 120 },
  )
})

test('the running total is restored from the sidecar too, not just the last request', async () => {
  // Left at zero, a resumed session's hit rate was computed over whatever had
  // been sent since the window opened — and the first request after a resume is
  // mostly cache writes, so a warm session read as a cold one.
  const harness = await createHarness()
  const resumed = await harness.store.create('resumed session')
  await harness.store.appendMetric(resumed.id, {
    event: 'turn',
    model: 'test-model',
    input_tokens: 1_000,
    cache_creation_tokens: 500,
    response_tokens: 100,
    cache_read_tokens: 0,
    cache_hit_rate: 0,
    tool_calls: 0,
    duration_ms: 10,
  })
  await harness.store.appendMetric(resumed.id, {
    event: 'turn',
    model: 'test-model',
    input_tokens: 200,
    cache_creation_tokens: 50,
    response_tokens: 60,
    cache_read_tokens: 1_500,
    cache_hit_rate: 1_500 / 1_750,
    tool_calls: 1,
    duration_ms: 12,
  })

  harness.controller.retarget(resumed, [])
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (harness.controller.getSnapshot().usage.total.inputTokens > 0) break
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(harness.controller.getSnapshot().usage.total, {
    inputTokens: 1_200,
    cacheCreationInputTokens: 550,
    cacheReadInputTokens: 1_500,
    outputTokens: 160,
    cost: { amounts: {}, legacy: true },
  })
  // The last request is still the last turn, not the sum of them.
  assert.deepEqual(harness.controller.getSnapshot().usage.lastRequest, {
    inputTokens: 200,
    cacheCreationInputTokens: 50,
    cacheReadInputTokens: 1_500,
    outputTokens: 60,
  })
})

test('a request that lands first keeps the sidecar total from double-counting it', async () => {
  // The seed is fire-and-forget, so a live request can beat it home. Adding the
  // session's history on top of a total that already counts this process's
  // requests would report every resumed turn twice.
  const harness = await createHarness()
  const resumed = await harness.store.create('resumed session')
  await harness.store.appendMetric(resumed.id, {
    event: 'turn',
    model: 'test-model',
    input_tokens: 9_000,
    response_tokens: 100,
    cache_read_tokens: 1_000,
    cache_hit_rate: 0.1,
    tool_calls: 0,
    duration_ms: 10,
  })

  harness.controller.retarget(resumed, [])
  harness.proxy.onRequestUsage(usage(42, 7))
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }

  assert.deepEqual(harness.controller.getSnapshot().usage.total, usage(42, 7))
})

test('tool progress drives the spinner text and only lists calls when several are in flight', async () => {
  const harness = await createHarness()

  const started = (id: string, name: string, input: unknown): ToolProgressEvent => ({
    call: { id, name, input },
    phase: 'started',
  })

  harness.proxy.onProgress(started('a', 'Read', { filePath: '/tmp/a' }))
  assert.equal(harness.controller.getSnapshot().spinnerSubText, 'Reading /tmp/a')
  let progress = harness.events.at(-1)
  assert.equal(progress?.type, 'tool-progress')
  assert.equal(progress?.type === 'tool-progress' ? progress.listContent : 'set', undefined)

  harness.proxy.onProgress(started('b', 'Read', { filePath: '/tmp/b' }))
  assert.equal(harness.controller.getSnapshot().spinnerSubText, 'Reading 2 files in parallel...')
  progress = harness.events.at(-1)
  assert.equal(
    progress?.type === 'tool-progress' ? progress.listContent : undefined,
    'Reading 2 files in parallel...',
  )

  harness.proxy.onProgress({ call: { id: 'a', name: 'Read', input: {} }, phase: 'finished' })
  harness.proxy.onProgress({ call: { id: 'b', name: 'Read', input: {} }, phase: 'finished' })
  assert.equal(harness.controller.getSnapshot().spinnerSubText, undefined)
})

test('subagent progress is tracked per agent and attached to the matching task record', async () => {
  const harness = await createHarness()

  harness.proxy.onProgress({
    call: { id: 'c1', name: 'Grep', input: { pattern: 'needle' } },
    phase: 'started',
    source: { type: 'subagent', agentType: 'explore', agentId: 'agent-1' },
  })
  const expected = 'explore > Grep: Searching for "needle"'
  assert.equal(harness.controller.getSubagentProgress().get('agent-1'), expected)
  assert.equal(harness.controller.getSnapshot().spinnerSubText, expected)

  const taskRecord: SessionRecord = {
    id: randomUUID(),
    type: 'subagent_task',
    agentId: 'agent-1',
    subagentType: 'explore',
    status: 'running',
    description: 'look',
    task: 'look around',
    createdAt: new Date().toISOString(),
  }
  harness.proxy.onRecord(taskRecord)

  const emitted = harness.events.at(-1)
  assert.equal(emitted?.type, 'record')
  assert.equal(emitted?.type === 'record' ? emitted.subagentProgress : undefined, expected)
})

test('a foreground run\'s latest tool rides tool-progress, keyed by its Agent call', async () => {
  const harness = await createHarness()
  const source = { type: 'subagent' as const, agentType: 'explore', agentId: 'agent-1', parentToolUseId: 'agent-call' }

  harness.proxy.onProgress({ call: { id: 'c1', name: 'Grep', input: { pattern: 'needle' } }, phase: 'started', source })
  harness.proxy.onProgress({ call: { id: 'c1', name: 'Grep', input: {} }, phase: 'finished', source })
  harness.proxy.onProgress({ call: { id: 'c2', name: 'Bash', input: { command: 'ls' } }, phase: 'started', source })
  const progress = harness.events.at(-1)
  assert.deepEqual(progress?.type === 'tool-progress' ? progress.subagents : undefined, [
    { toolUseId: 'agent-call', tool: 'Bash', summary: 'ls', toolCount: 2, agentId: 'agent-1' },
  ])

  // The call's own result ends the run's line.
  harness.proxy.onRecord({
    id: randomUUID(), type: 'tool_result', toolUseId: 'agent-call', tool: 'Agent', ok: true, content: 'done',
    createdAt: new Date().toISOString(),
  } as SessionRecord)
  harness.proxy.onProgress({ call: { id: 'c2', name: 'Bash', input: {} }, phase: 'finished', source })
  const after = harness.events.at(-1)
  assert.equal(after?.type === 'tool-progress' ? after.subagents : 'set', undefined)
})

test('an approval record carries the id of the tool_use it answers', async () => {
  const harness = await createHarness()
  const toolUseId = randomUUID()

  harness.proxy.onRecord({
    id: toolUseId,
    type: 'tool_use',
    tool: 'Bash',
    input: { command: 'ls' },
    riskLevel: 'confirm',
    createdAt: new Date().toISOString(),
  })
  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_approval',
    tool: 'Bash',
    input: { command: 'ls' },
    approved: true,
    riskLevel: 'confirm',
    createdAt: new Date().toISOString(),
  })

  const approval = harness.events.at(-1)
  assert.equal(approval?.type, 'record')
  assert.equal(approval?.type === 'record' ? approval.approvalToolUseId : undefined, toolUseId)
})

test('the first user message names an untitled session, exactly as the store does', async () => {
  // The window chrome reads a session's name off the *pane* — the header, the
  // sidebar row — and nothing used to tell the pane what the store derived on
  // append. The name arrived only when something re-listed the store from disk,
  // which is a whole turn later.
  const harness = await createHarness({ untitled: true })
  const record: SessionRecord = {
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: 'x'.repeat(80),
    createdAt: new Date().toISOString(),
  }

  await harness.store.appendRecord(harness.session.id, record)
  harness.proxy.onRecord(record)

  const stored = (await harness.store.list()).find((meta) => meta.id === harness.session.id)
  assert.equal(harness.controller.getSessionMeta().title, stored?.title)
  assert.equal(harness.controller.getSessionMeta().title, 'x'.repeat(60), 'the store\'s own 60 characters')

  // The naming, then the empty generated title settling the pending state.
  await waitUntil(() => !harness.controller.isTitlePending(), 'the pending title to settle')
  const announced = harness.events.filter((event) => event.type === 'session-meta')
  assert.equal(announced.length, 2)
  assert.equal(
    announced[0]?.type === 'session-meta' ? announced[0].session.id : undefined,
    harness.session.id,
    'the id never moves here; this is not a session switch',
  )

  // The second message is not a rename: only an unnamed session takes a name.
  harness.proxy.onRecord({ ...record, id: randomUUID(), content: '完全不同的第二条' })
  assert.equal(harness.controller.getSessionMeta().title, 'x'.repeat(60))
  assert.equal(harness.events.filter((event) => event.type === 'session-meta').length, 2)
})

test('a session that already has a title is never renamed by a message', async () => {
  const harness = await createHarness()

  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: '第一条消息',
    createdAt: new Date().toISOString(),
  })

  assert.equal(harness.controller.getSessionMeta().title, 'controller test')
  assert.deepEqual(harness.events.filter((event) => event.type === 'session-meta'), [])
})

test('a task snapshot on a tool result becomes pull state', async () => {
  const harness = await createHarness()

  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_result',
    toolUseId: randomUUID(),
    tool: 'TaskUpdate',
    ok: true,
    content: 'ok',
    display: {
      summary: 'Updated tasks',
      taskSnapshot: { tasks: [], counts: { total: 0, remaining: 0, pending: 0, inProgress: 0, completed: 0 } },
    },
    createdAt: new Date().toISOString(),
  })

  assert.deepEqual(
    harness.controller.getSnapshot().taskSnapshot,
    { tasks: [], counts: { total: 0, remaining: 0, pending: 0, inProgress: 0, completed: 0 } },
  )
})

test('dispose unhooks the record proxy so nothing reaches a torn-down UI', async () => {
  const harness = await createHarness()
  const before = harness.events.length

  harness.controller.dispose()
  harness.proxy.onRecord({
    id: randomUUID(),
    type: 'tool_use',
    tool: 'Bash',
    input: {},
    riskLevel: 'safe',
    createdAt: new Date().toISOString(),
  })
  harness.proxy.onProgress({ call: { id: 'x', name: 'Bash', input: {} }, phase: 'started' })
  harness.proxy.onStreamEvent({ type: 'text_delta', text: 'hi' })

  assert.equal(harness.events.length, before)
})

test('a turn opens a snapshot before the loop runs', async () => {
  const order: string[] = []
  const harness = await createHarness({
    run: async () => {
      order.push('loop.run')
      return okResult()
    },
  })

  await harness.controller.submit({ text: 'hello' })

  assert.equal(harness.snapshotCalls.length, 1)
  assert.deepEqual(order, ['loop.run'], 'the snapshot is awaited before the loop starts')
})

test('a turn runs normally when the file history never came up', async () => {
  const harness = await createHarness({ fileHistoryInitFails: true })

  await harness.controller.submit({ text: 'hello' })

  assert.deepEqual(harness.snapshotCalls, [], 'nothing is snapshotted onto state init would replace')
  assert.deepEqual(
    harness.events.filter((event) => event.type === 'notice'),
    [],
    'a session without history is a degraded session, not one worth interrupting',
  )
  assert.deepEqual(types(harness.events).slice(-1), ['turn-end'])
})

test('write tools reach the history of the session that is live now', async () => {
  const harness = await createHarness()

  await harness.controller.trackFileEdit('/tmp/a.ts')

  assert.deepEqual(harness.trackedFiles, ['/tmp/a.ts'])
})

test('dispose stops the file history so no backup outlives the session', async () => {
  const harness = await createHarness()

  harness.controller.dispose()

  assert.equal(harness.counters.fileHistoryDisposals, 1)
})

test('a second submit while a turn is in flight is rejected, not run', async () => {
  // The guard exists because everything after it assigns `this.abortController`:
  // a concurrent run would overwrite the live one and leave the first turn
  // impossible to interrupt. It throws rather than returning quietly, because a
  // dropped message is indistinguishable from one that was sent and answered with
  // nothing — a shell is supposed to catch this and queue the input instead
  // (`SessionHost.pumpQueue`, `App.tsx`'s `handleSubmit`).
  let release: (() => void) | undefined
  const runs: UserInput[] = []
  const harness = await createHarness({
    run: async (input) => {
      runs.push(input)
      // Only the first turn parks; later ones return straight away, or the
      // "accepts the next message" assertion below would wait forever.
      if (runs.length === 1) await new Promise<void>((resolve) => { release = resolve })
      return okResult()
    },
  })

  const first = harness.controller.submit({ text: 'first' })
  await waitUntil(() => runs.length === 1, 'the first turn to start')

  await assert.rejects(
    () => harness.controller.submit({ text: 'second' }),
    /already running/,
    'the second submit must reject',
  )
  assert.deepEqual(runs, [{ text: 'first' }], 'and must not reach the loop')

  release?.()
  await first
  // The guard clears with the turn rather than latching: the same controller has
  // to accept the next message.
  assert.equal(harness.controller.getSnapshot().isStreaming, false)
  await harness.controller.submit({ text: 'third' })
  assert.deepEqual(runs, [{ text: 'first' }, { text: 'third' }])
})

test('the first turn is still interruptible after a second submit was refused', async () => {
  // The point of the guard: the live AbortController must still be the first
  // turn's. If the refused submit had gone through, `interrupt()` would abort the
  // *second* turn's signal and the first would run on unstoppably.
  const seen: Array<AbortSignal | undefined> = []
  const harness = await createHarness({
    run: async (_input, signal) => {
      seen.push(signal)
      await new Promise<void>((resolve) => {
        if (signal?.aborted) resolve()
        else signal?.addEventListener('abort', () => resolve())
      })
      const error = new Error('aborted')
      error.name = 'AbortError'
      throw error
    },
  })

  const first = harness.controller.submit({ text: 'first' })
  await waitUntil(() => seen.length === 1, 'the first turn to start')
  await assert.rejects(() => harness.controller.submit({ text: 'second' }), /already running/)

  harness.controller.interrupt('user-cancel')
  await first

  assert.equal(seen.length, 1, 'only one turn ever reached the loop')
  assert.equal(seen[0]?.aborted, true, 'and interrupting reached that turn')
})

test('a stop during the file snapshot aborts the turn before the provider starts', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const runs: UserInput[] = []
  const harness = await createHarness({
    snapshotGate: () => gate,
    run: async (input) => { runs.push(input); return okResult() },
  })

  const turn = harness.controller.submit({ text: 'hold me' })
  await waitUntil(() => harness.snapshotCalls.length === 1, 'the snapshot to start')
  assert.equal(harness.controller.busyKind(), 'turn', 'preparing is already a busy lane')
  assert.equal(harness.controller.getSnapshot().isStreaming, true)
  assert.throws(() => harness.controller.retarget({ ...harness.session, id: 'other' }, []), /先停止/)
  assert.throws(() => harness.controller.beginSessionSwitch(), /先停止/)

  harness.controller.interrupt('user-cancel')
  release()
  await turn

  assert.deepEqual(runs, [], 'the provider never started')
  const end = harness.events.at(-1)
  assert.equal(end?.type === 'turn-end' ? end.aborted : undefined, true)
  assert.equal(harness.controller.busyKind(), undefined, 'the lane is free again')

  // The next turn is not blocked by the aborted one's controller.
  await harness.controller.submit({ text: 'after' })
  assert.deepEqual(runs, [{ text: 'after' }])
})

test('compaction holds the lane, refuses a second one, and blocks a switch', async () => {
  let release!: (result: CompactCheckResult) => void
  const gate = new Promise<CompactCheckResult>((resolve) => { release = resolve })
  const harness = await createHarness({ compact: () => gate })

  const compacting = harness.controller.compact()
  assert.equal(harness.controller.busyKind(), 'compaction')
  assert.equal(harness.controller.getSnapshot().isStreaming, false,
    'the guard cannot only look at streaming')

  await assert.rejects(() => harness.controller.compact(), /正在压缩/,
    'a second compaction must not release the first one early')
  assert.throws(() => harness.controller.beginSessionSwitch(), /压缩/)
  assert.throws(
    () => harness.controller.retarget({ ...harness.session, id: 'other' }, []),
    /压缩/,
    'the owning retarget entry refuses too',
  )

  release({ compacted: false, usage: usage(0, 0) })
  await compacting
  assert.equal(harness.controller.busyKind(), undefined)
})

test('manual compaction is interruptible and releases its controller after cancellation', async () => {
  const harness = await createHarness({ compact: async (_instructions, signal) => {
    assert.ok(signal)
    await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true }))
    return { compacted: false, usage: usage(0, 0) }
  } })
  const compact = harness.controller.compact()
  const rejected = assert.rejects(compact, { name: 'AbortError' })
  harness.controller.interrupt()
  await rejected
  assert.equal(harness.controller.busyKind(), undefined)
  await harness.controller.submit({ text: 'after compact' })
})

test('interrupted coordinator and wake inputs never become user drafts', async () => {
  for (const origin of ['user', 'coordinator', 'wake'] as const) {
    const harness = await createHarness({ run: async (input, _signal, messageId) => {
      await harness.store.appendRecord(harness.session.id, {
        id: messageId!, type: 'message', role: 'user', content: input.text, createdAt: 'now',
      })
      harness.controller.interrupt()
      throw abortError()
    } })
    await harness.controller.submit({ text: 'same wake text' }, { origin })
    assert.equal(harness.events.some((event) => event.type === 'restore-input'), origin === 'user')
  }
})

test('a switch in flight blocks every way a turn can start, until it ends', async () => {
  const runs: UserInput[] = []
  const harness = await createHarness({
    run: async (input) => { runs.push(input); return okResult() },
  })

  harness.controller.beginSessionSwitch()
  assert.equal(harness.controller.busyKind(), 'switch')
  assert.equal(harness.controller.getSnapshot().switching, true)

  await assert.rejects(() => harness.controller.submit({ text: 'too early' }), /正在切换/)
  await assert.rejects(() => harness.controller.retryTurn('no-such-failure'), /正在切换/)
  await assert.rejects(() => harness.controller.compact(), /正在切换/)
  assert.deepEqual(runs, [], 'no turn started under the switch')

  harness.controller.endSessionSwitch()
  assert.equal(harness.controller.getSnapshot().switching, false,
    'the claim is released in a finally, not latched')
  await harness.controller.submit({ text: 'after' })
  assert.deepEqual(runs, [{ text: 'after' }])
})

test('a running turn refuses the owning retarget and a switch claim', async () => {
  let release!: () => void
  let started!: () => void
  const runStarted = new Promise<void>((resolve) => { started = resolve })
  const hold = new Promise<void>((resolve) => { release = resolve })
  const harness = await createHarness({
    run: async () => {
      started()
      await hold
      return okResult()
    },
  })
  const other = await harness.store.create('other')

  const turn = harness.controller.submit({ text: 'hello' })
  await runStarted
  assert.throws(() => harness.controller.retarget(other, []), /先停止/,
    'the controller itself must refuse, not only the switch wrapper')
  assert.throws(() => harness.controller.beginSessionSwitch(), /先停止/)

  release()
  await turn
  // The turn has ended, so the same call is now allowed.
  harness.controller.retarget(other, [])
  assert.equal(harness.controller.getSessionId(), other.id)
})

test('a failure lands in the session that ran, and only then can a switch follow', async () => {
  let release!: () => void
  let started!: () => void
  const runStarted = new Promise<void>((resolve) => { started = resolve })
  const hold = new Promise<void>((resolve) => { release = resolve })
  const harness = await createHarness({
    run: async () => {
      started()
      await hold
      throw new Error('provider exploded')
    },
  })
  const other = await harness.store.create('other')

  const turn = harness.controller.submit({ text: 'hello' })
  await runStarted
  harness.proxy.onRequestUsage(usage(50, 5))
  assert.throws(() => harness.controller.retarget(other, []), /先停止/)
  release()
  await turn

  const oldRecords = await harness.store.loadRecords(harness.session.id)
  assert.equal(oldRecords.filter((record) => record.type === 'turn_failure').length, 1,
    'the failure belongs to the session that ran')
  assert.deepEqual(await harness.store.loadRecords(other.id), [],
    'and nothing was written to the session it did not switch to')

  harness.controller.retarget(other, [])
  assert.equal(harness.controller.getSessionId(), other.id)
  assert.equal(harness.controller.getSnapshot().usage.lastRequest, null,
    'the previous session\'s request usage does not follow the retarget')
})

test('a rollback stays in the session that ran, and the switch waits for the turn to end', async () => {
  let release!: () => void
  let started!: () => void
  const runStarted = new Promise<void>((resolve) => { started = resolve })
  const hold = new Promise<void>((resolve) => { release = resolve })
  let harness!: Harness
  harness = await createHarness({
    run: async (_input, _signal, messageId) => {
      const record: SessionRecord = {
        type: 'message',
        id: messageId ?? 'user-message',
        role: 'user',
        content: 'hello',
        createdAt: new Date().toISOString(),
      }
      // What the loop does before it announces: the record is on disk, so a
      // rollback has something to cut.
      await harness.store.appendRecord(harness.session.id, record)
      harness.proxy.onRecord(record)
      started()
      await hold
      throw abortError()
    },
  })
  const other = await harness.store.create('other')
  await harness.store.appendRecord(other.id, {
    type: 'message',
    id: 'keep',
    role: 'user',
    content: 'keep me',
    createdAt: 'now',
  })

  const turn = harness.controller.submit({ text: 'hello' })
  await runStarted
  assert.throws(() => harness.controller.retarget(other, []), /先停止/)
  harness.controller.interrupt('user-cancel')
  release()
  await turn

  assert.deepEqual(await harness.store.loadRecords(harness.session.id), [],
    'the interrupted prompt is rolled back from its own log')
  const kept = await harness.store.loadRecords(other.id)
  assert.deepEqual(kept.map((record) => record.id), ['keep'],
    'and the session it did not switch to is untouched')
  assert.equal(
    harness.events.filter((event) => event.type === 'restore-input').length,
    1,
    'the interrupted prompt comes back to this pane\'s composer',
  )

  harness.controller.retarget(other, [])
  assert.equal(harness.controller.getSessionId(), other.id)
})

test('a queued submission is accepted when its user record lands, not when the turn ends', async () => {
  const accepted: string[] = []
  const order: string[] = []
  const harness = await createHarness({
    run: async (_input, _signal, messageId, overrides) => {
      // What the real loop does: stamp the queued id on the user record and
      // append it, then keep working for the rest of the turn.
      const source = (overrides as { sourceQueuedMessageId?: string } | undefined)?.sourceQueuedMessageId
      order.push('user-record-appended')
      harness.proxy.onRecord({
        type: 'message',
        id: messageId ?? 'm1',
        role: 'user',
        content: 'queued',
        createdAt: new Date().toISOString(),
        ...(source ? { sourceQueuedMessageId: source } : {}),
      })
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('turn-finished')
      return okResult()
    },
  })

  await harness.controller.submit({ text: 'queued' }, undefined, {
    queuedMessageId: 'q1',
    onAccepted: () => {
      accepted.push('q1')
      order.push('accepted')
    },
  })

  assert.deepEqual(accepted, ['q1'], 'exactly once')
  assert.deepEqual(order, ['user-record-appended', 'accepted', 'turn-finished'],
    'acceptance is the user record, not the end of the turn')

  const stamped = harness.events.find((event) =>
    event.type === 'record' && event.record.type === 'message' && event.record.sourceQueuedMessageId === 'q1')
  assert.ok(stamped, 'the user record carries the queued id a replay reads')
})

test('a submission refused before its user record is never accepted', async () => {
  let ran = false
  const harness = await createHarness({
    imageCapable: false,
    run: async () => { ran = true; return okResult() },
  })
  const accepted: string[] = []

  await assert.rejects(() => harness.controller.submit(
    { text: 'look', images: [makeImageAttachmentRef({ id: 'img-q', ownerSessionId: harness.session.id })] },
    undefined,
    { queuedMessageId: 'q1', onAccepted: () => accepted.push('q1') },
  ))

  assert.equal(ran, false, 'the gate runs before the loop')
  assert.deepEqual(accepted, [], 'so the queue keeps the message and its images')
})

/** Polls rather than sleeping, so the wait is as short as the work allows. */
async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`Timed out waiting for ${what}`)
}

test('a model-written title replaces the first-message fallback, unless the user renamed meanwhile', async () => {
  const record = (): SessionRecord => ({
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: '帮我把登录页的按钮改成蓝色',
    createdAt: new Date().toISOString(),
  })
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  const named = await createHarness({ untitled: true, titleReply: '"修改登录按钮颜色"\n' })
  const first = record()
  await named.store.appendRecord(named.session.id, first)
  named.proxy.onRecord(first)
  await settle()
  assert.equal(named.controller.getSessionMeta().title, '修改登录按钮颜色')
  assert.equal((await named.store.list()).find((m) => m.id === named.session.id)?.title, '修改登录按钮颜色')
  assert.equal(named.events.filter((event) => event.type === 'session-meta').length, 2)
  assert.equal(named.controller.isTitlePending(), false)

  const renamed = await createHarness({ untitled: true, titleReply: '修改登录按钮颜色' })
  const second = record()
  await renamed.store.appendRecord(renamed.session.id, second)
  renamed.proxy.onRecord(second)
  renamed.controller.refreshSessionMeta({ ...renamed.controller.getSessionMeta(), title: '我自己的名字' })
  await settle()
  assert.equal(renamed.controller.getSessionMeta().title, '我自己的名字')
})

test('the fallback title is pending until generation settles, landed or not', async () => {
  const record: SessionRecord = {
    id: randomUUID(),
    type: 'message',
    role: 'user',
    content: '帮我把登录页的按钮改成蓝色',
    createdAt: new Date().toISOString(),
  }
  // An empty reply is a generation that produced nothing: the fallback stays.
  const harness = await createHarness({ untitled: true, titleReply: '' })
  const pendingAtMeta: boolean[] = []
  harness.controller.onEvent((event) => {
    if (event.type === 'session-meta') pendingAtMeta.push(harness.controller.isTitlePending())
  })
  await harness.store.appendRecord(harness.session.id, record)
  harness.proxy.onRecord(record)
  assert.equal(harness.controller.isTitlePending(), true)
  await waitUntil(() => !harness.controller.isTitlePending(), 'the pending title to settle')
  assert.equal(harness.controller.getSessionMeta().title, '帮我把登录页的按钮改成蓝色')
  assert.deepEqual(pendingAtMeta, [true, false], 'the fallback is announced as pending, then the settle')
})

test('turn events carry the origin and whether the turn failed', async () => {
  const ok = await createHarness({})
  await ok.controller.submit({ text: 'a' }, { origin: 'wake' })
  assert.deepEqual(structuredClone(ok.events.filter((e) => e.type === 'turn-start' || e.type === 'turn-end')).map((e) => [e.origin, e.type === 'turn-end' ? e.failed : undefined]), [['wake', undefined], ['wake', false]])

  const bad = await createHarness({ run: async () => { throw new Error('boom') } })
  await bad.controller.submit({ text: 'a' })
  const end = bad.events.at(-1)
  assert.ok(end?.type === 'turn-end' && end.failed === true && end.origin === 'user')
})

async function idleOverride(options: { role?: CoordinationRole; tokens?: number; idleMs: number }): Promise<unknown> {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  try {
    let seen: { compactBeforeSend?: boolean } | undefined
    const harness = await createHarness({
      ...(options.role ? { role: options.role } : {}),
      run: async (_input, _signal, _id, overrides) => {
        seen = overrides as { compactBeforeSend?: boolean } | undefined
        return okResult()
      },
    })
    if (options.tokens !== undefined) harness.proxy.onRequestUsage(usage(options.tokens, 1))
    mock.timers.tick(options.idleMs)
    await harness.controller.submit({ text: 'hi' })
    return seen?.compactBeforeSend
  } finally {
    mock.timers.reset()
  }
}

test('idle compaction: a coordinator past the cache TTL and over 40% compacts before sending', async () => {
  assert.equal(await idleOverride({ role: 'coordinator', tokens: 500, idleMs: 3_700_000 }), true)
})

test('idle compaction: under 40%, within the TTL, or not a coordinator, nothing is forced', async () => {
  assert.equal(await idleOverride({ role: 'coordinator', tokens: 300, idleMs: 3_700_000 }), undefined)
  assert.equal(await idleOverride({ role: 'coordinator', tokens: 500, idleMs: 60_000 }), undefined)
  assert.equal(await idleOverride({ role: 'thread', tokens: 500, idleMs: 3_700_000 }), undefined)
  assert.equal(await idleOverride({ tokens: 500, idleMs: 3_700_000 }), undefined)
})

test('idle compaction: unknown occupancy never forces a compaction', async () => {
  assert.equal(await idleOverride({ role: 'coordinator', idleMs: 3_700_000 }), undefined)
})
