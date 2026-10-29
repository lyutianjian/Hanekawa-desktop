import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createUiBridges } from '../src/runtime/bridges.js'
import { CommandRegistry } from '../src/commands/registry.js'
import { SessionHost } from '../src/runtime/protocol/host.js'
import { SessionClient } from '../src/runtime/protocol/client.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import {
  initialPermissionIndex,
  permissionKeyToIntent,
  permissionResponseFor,
  permissionViewModel,
} from '../src/desktop/renderer/model/permissionDialog.js'
import type { SessionController } from '../src/runtime/sessionController.js'
import type { RuntimeSlot } from '../src/runtime/runtimeSlot.js'
import type { ProjectRuntime, SessionScope } from '../src/runtime/types.js'
import type { UserInput } from '../src/media/types.js'
import { imageErrorCopy } from '../src/media/imageErrors.js'
import { TurnImageBlockError } from '../src/harness/turnImages.js'
import { ImageAttachmentService } from '../src/services/imageAttachments/imageAttachmentService.js'
import { MAX_ATTACHMENT_WIRE_BYTES } from '../src/runtime/protocol/commandSchema.js'
import { assertNoImageBytes, fixtureImagePath, loadFixtureBytes } from './helpers/imageFixtures.js'
import type { PermissionRequest } from '../src/harness/permissions.js'
import type { Tool } from '../src/harness/types.js'

/**
 * The desktop permission flow, end to end, with only the view's DOM left out.
 *
 * A real `PermissionGate`-shaped request goes into a real `createUiBridges()`,
 * through a real `SessionHost`, across a channel that structured-clones every
 * message, into a real `SessionClient`, and is answered by the real renderer
 * view model. Everything the shipped renderer threw away — the diff preview, the
 * destructive analysis, the always-allow affordance — has to survive that trip.
 *
 * Two properties are load-bearing and cannot be checked in the pure model tests:
 * that `onAlwaysAllow` fires *before* the prompt promise resolves, and that a
 * handler which throws still answers rather than parking the agent loop.
 */

interface Harness {
  scope: SessionScope
  host: SessionHost
  client: SessionClient
  cwd: string
  /** Inputs the controller was actually asked to run, in order. */
  submits: string[]
  /** The same submissions with their image refs intact. */
  inputs: UserInput[]
  /** The project's real attachment store, shared with the fake project below. */
  attachments: ImageAttachmentService
  /** Paths the shell was asked to open, host-resolved from registered ids. */
  openedAttachmentPaths: string[]
  /** Flips the turn state and notifies, the way the real controller does. */
  setStreaming: (value: boolean) => void
  /** Stands in for a model switch: what the queue's accept gate answers. */
  setImageCapable: (value: boolean) => void
  dispose: () => void
}

async function createHarness(): Promise<Harness> {
  const cwd = await mkdtemp(path.join(tmpdir(), 'myagent-desktop-ui-'))
  // A real file, so the preview is a genuine overwrite diff rather than a
  // create: `buildFileToolPreview` reads the disk through `defaultReadFile`.
  await writeFile(path.join(cwd, 'notes.txt'), 'alpha\nbeta\ngamma\n', 'utf8')

  const bridges = createUiBridges()
  const session = { id: 'ses', shortId: 'ses', title: 'round trip', messageCount: 0, updatedAt: 'now' }

  const scope = {
    session,
    projectDir: cwd,
    workingDir: cwd,
    bridges,
    permissionGate: {
      getMode: () => 'default',
      onModeChange: () => () => undefined,
    },
    promptSections: {},
    createRuntime: () => ({}),
    existingRecords: [],
    hasRecoverableInterruption: false,
    diagnostics: [],
    dispose: () => undefined,
  } as unknown as SessionScope

  const project = {
    cwd,
    config: {},
    // Only `appendRecord` is reached: the host's `MessageQueue` persists every
    // mutation as a `message_queue` record, which is exactly why the queue lives
    // host-side rather than in the renderer.
    store: { appendRecord: async () => undefined },
    backgroundTasks: { subscribe: () => () => undefined, getSnapshot: () => [], hasParentNotifications: () => false, promoteForeground: () => 0 },
    // Real: the attachment commands run the actual S05 service over this temp
    // project, so imports land on disk and ids resolve through registration.
    attachments: new ImageAttachmentService(cwd),
    // Real: `ProjectRuntime.commands` is what the host resolves slash commands
    // through, and the cast below is exactly what would hide its absence.
    commands: new CommandRegistry(),
    mcp: { connected: [], failed: [] },
    initialModelKey: 'main',
    configuredEffortLevel: 'high',
    createActiveModelRuntime: () => ({}),
    shutdown: async () => undefined,
  } as unknown as ProjectRuntime

  const submits: string[] = []
  const inputs: UserInput[] = []
  const openedAttachmentPaths: string[] = []
  const snapshotListeners = new Set<() => void>()
  let streaming = false
  let imageCapable = true

  const controller = {
    onEvent: () => () => undefined,
    subscribe: (listener: () => void) => {
      snapshotListeners.add(listener)
      return () => snapshotListeners.delete(listener)
    },
    getSnapshot: () => ({
      isStreaming: streaming,
      switching: false,
      // `total` is not nullable on `SessionUsage`; the real controller seeds it
      // with `createEmptySessionUsage()`, and the host reads it to derive the cost.
      usage: {
        total: { inputTokens: 0, cacheReadInputTokens: 0, outputTokens: 0 },
        lastRequest: null,
      },
      taskSnapshot: undefined,
      spinnerSubText: undefined,
      contextUsedTokens: undefined,
      turnOutputTokens: undefined,
    }),
    busyKind: () => (streaming ? 'turn' : undefined),
    getSubagentProgress: () => new Map<string, string>(),
    submit: async (input: UserInput) => {
      submits.push(input.text)
      inputs.push(input)
    },
    // The real rule, in miniature: the loop's gate refuses images the active
    // model cannot take, and the queue runs it before it accepts anything.
    assertInputAcceptable: (input: UserInput) => {
      if (!imageCapable && input.images && input.images.length > 0) {
        // The real gate's error class, so the round trip covers what the host
        // does with a reason-carrying block (S24).
        throw new TurnImageBlockError(
          'model-not-capable',
          [...input.images],
          'Model fake does not accept image input',
        )
      }
    },
  } as unknown as SessionController

  const runtimeSlot = {
    current: { modelKey: 'main', modelConfig: { model: 'fake' }, providerName: 'fake', loop: {}, planModeManager: {} },
    subscribe: () => () => undefined,
    getEffort: () => 'high',
  } as unknown as RuntimeSlot

  const [hostChannel, clientChannel] = createMemoryChannelPair()
  // The host reaches for a pane registry on every open-pane / close-pane /
  // list-panes command. Tests that do not exercise those commands get a
  // no-op registry; the host only touches the workspace on those three.
  const workspace = {
    list: () => [],
    paneForSession: () => undefined,
    open: async () => { throw new Error('open not used in this test') },
    adopt: () => { throw new Error('adopt not used in this test') },
    close: () => undefined,
  }
  const host = new SessionHost({
    channel: hostChannel,
    controller,
    runtimeSlot,
    project,
    scope,
    workspace,
    onPaneOpened: () => undefined,
    onPaneClosed: () => undefined,
    // What `main.ts` wires to `shell.openPath`; recording it lets a test assert
    // the path arrived host-resolved rather than renderer-supplied.
    onOpenAttachment: (filePath) => {
      openedAttachmentPaths.push(filePath)
    },
  })
  const client = new SessionClient(clientChannel)

  return {
    scope,
    host,
    client,
    cwd,
    submits,
    inputs,
    attachments: project.attachments,
    openedAttachmentPaths,
    setStreaming: (value: boolean) => {
      streaming = value
      for (const listener of [...snapshotListeners]) listener()
    },
    setImageCapable: (value: boolean) => {
      imageCapable = value
    },
    dispose: () => {
      host.dispose()
      client.dispose()
    },
  }
}

function tool(name: string, riskLevel: 'safe' | 'confirm' | 'dangerous'): Tool {
  return { name, riskLevel } as unknown as Tool
}

function writeRequest(overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: tool('Write', 'confirm'),
    input: { filePath: 'notes.txt', content: 'alpha\nBETA\ngamma\n' },
    reason: 'writing a file',
    source: 'mode',
    denialStreak: 0,
    ...overrides,
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a file write reaches the renderer as a DTO carrying a real diff preview', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      return { approved: true }
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt(writeRequest({ toolUseId: 'write-call-1' }))

  assert.equal(approved, true)
  const dto = seen as { toolName: string; toolUseId?: string; preview?: { kind: string; oldText: string; newText: string } }
  assert.equal(dto.toolName, 'Write')
  assert.equal(dto.toolUseId, 'write-call-1', 'the exact waiting call survives the host/client round trip')
  assert.equal(dto.preview?.kind, 'diff', 'the host builds the preview; the renderer cannot')
  assert.equal(dto.preview?.oldText, 'alpha\nbeta\ngamma\n')

  // And the renderer's own model turns it into rows.
  const view = permissionViewModel({ request: seen as never, selectedIndex: 0 })
  assert.ok(view.preview?.kind === 'diff')
  assert.deepEqual(
    view.preview.rows.filter((row) => row.kind !== 'ctx').map((row) => [row.kind, row.text]),
    [['del', 'beta'], ['add', 'BETA']],
  )
  harness.dispose()
})

test('answering "always" fires onAlwaysAllow before the gate\'s promise resolves', async () => {
  const harness = await createHarness()
  const order: string[] = []

  harness.client.setHandlers({
    permission: async (request) => {
      // Exactly what the renderer does: derive the options, press "a", answer.
      const view = permissionViewModel({ request, selectedIndex: initialPermissionIndex(request) })
      const intent = permissionKeyToIntent({ key: 'a' }, { selectedIndex: view.selectedIndex, options: view.options })
      assert.equal(intent.kind, 'answer')
      assert.ok(intent.kind === 'answer')
      assert.equal(intent.action, 'always', 'the gate offered a rule, so always-allow is on the list')
      return permissionResponseFor(intent.action)
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt(writeRequest({
    alwaysAllowRule: { toolName: 'Write', behavior: 'allow', source: 'session' },
    onAlwaysAllow: () => order.push('rule saved'),
  }))
  order.push('prompt resolved')

  assert.equal(approved, true)
  // `PermissionGate` reads the captured flag on the line after its await returns,
  // so the callback has to have run by then.
  assert.deepEqual(order, ['rule saved', 'prompt resolved'])
  harness.dispose()
})

test('a destructive command arrives with its warnings and no always-allow option', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      const view = permissionViewModel({ request, selectedIndex: initialPermissionIndex(request) })
      // Deny is pre-selected, so plain Enter is the safe answer.
      const intent = permissionKeyToIntent({ key: 'Enter' }, { selectedIndex: view.selectedIndex, options: view.options })
      assert.ok(intent.kind === 'answer')
      return permissionResponseFor(intent.action)
    },
  })

  const approved = await harness.scope.bridges.prompt.prompt({
    tool: tool('Bash', 'confirm'),
    input: { command: 'rm -rf /tmp/whatever' },
    reason: 'shell command',
    source: 'mode',
    denialStreak: 1,
    alwaysAllowRule: { toolName: 'Bash', behavior: 'allow', source: 'session' },
    onAlwaysAllow: () => assert.fail('always-allow must not be reachable for a destructive command'),
  })

  assert.equal(approved, false, 'Enter on a destructive request denies')
  const dto = seen as { destructiveWarnings: unknown[]; denialStreak: number }
  assert.ok(dto.destructiveWarnings.length > 0, 'the host ran the shell analyzer')
  assert.equal(dto.denialStreak, 1)

  const view = permissionViewModel({ request: seen as never, selectedIndex: 0 })
  assert.deepEqual(view.options.map((option) => option.action), ['allow', 'deny'])
  assert.equal(view.tone, 'danger')
  assert.equal(view.denialStreakNote, '已拒绝过一次。')
  harness.dispose()
})

test('a renderer handler that throws still answers, so the loop is never parked', async () => {
  const harness = await createHarness()
  harness.client.setHandlers({
    permission: async () => { throw new Error('the dialog blew up') },
  })

  // Nothing else releases this: `PermissionGate.approve` has no timeout, and
  // `ToolRunner.run` does not pass its abort signal into it.
  const approved = await harness.scope.bridges.prompt.prompt(writeRequest())
  assert.equal(approved, false, 'the permission fallback is denial')

  harness.client.setHandlers({
    enterPlan: async () => { throw new Error('the dialog blew up') },
  })
  // The asymmetry survives: entering plan mode only restricts the agent.
  assert.equal(await harness.scope.bridges.enterPlan.open(), true)
  harness.dispose()
})

test('several prompts queue, and each resolves with its own answer', async () => {
  const harness = await createHarness()
  const seen: string[] = []
  harness.client.setHandlers({
    permission: async (request) => {
      seen.push(String((request.input as { filePath?: string }).filePath))
      return { approved: (request.input as { filePath?: string }).filePath === 'first.txt' }
    },
  })

  const first = harness.scope.bridges.prompt.prompt(writeRequest({ input: { filePath: 'first.txt', content: 'a' } }))
  const second = harness.scope.bridges.prompt.prompt(writeRequest({ input: { filePath: 'second.txt', content: 'b' } }))
  await settle()

  assert.deepEqual(await Promise.all([first, second]), [true, false])
  assert.deepEqual(seen, ['first.txt', 'second.txt'])
  harness.dispose()
})

test('the whole DTO survives structured clone, preview included', async () => {
  const harness = await createHarness()
  let seen: unknown
  harness.client.setHandlers({
    permission: async (request) => {
      seen = request
      return { approved: false }
    },
  })

  // The memory channel clones on every post, so getting here at all proves it —
  // Electron's IPC would throw on a live object and `child_process.send` would
  // silently drop a function.
  await harness.scope.bridges.prompt.prompt(writeRequest())
  assert.doesNotThrow(() => structuredClone(seen))
  assert.equal(JSON.stringify(seen).includes('"execute"'), false, 'no Tool crossed the boundary')
  harness.dispose()
})

/**
 * The mid-turn Enter path, end to end with only the DOM left out.
 *
 * The model layer cannot cover this: `keymap.ts` decides that the keystroke means
 * "queue", but whether the message actually survives the round trip, appears in
 * the strip and is sent afterwards depends on the host owning the queue, on
 * `PersistedQueuedMessage` being clone-safe, and on the pump firing off the
 * snapshot publish that ends the turn.
 */
test('a message queued mid-turn crosses the boundary, shows up, and is sent when the turn ends', async () => {
  const harness = await createHarness()
  const announced: string[][] = []
  harness.client.onQueueChanged((messages) => {
    announced.push(messages.map((message) => message.content))
  })

  harness.setStreaming(true)
  // What `resolveKey` returning `'enqueue'` leads to in `app.ts`.
  const stored = await harness.client.enqueueMessage('the next thing')

  assert.equal(stored.content, 'the next thing')
  assert.equal(stored.priority, 'next')
  assert.doesNotThrow(() => structuredClone(stored))

  await settle()
  assert.deepEqual(harness.client.getQueuedMessages().map((entry) => entry.content), ['the next thing'])
  // This is what the strip draws from; `queuedMessagesView` turns it into rows.
  assert.deepEqual(announced.at(0), ['the next thing'])
  assert.deepEqual(harness.submits, [], 'and nothing was sent while the turn ran')

  harness.setStreaming(false)
  await settle()

  assert.deepEqual(harness.submits, ['the next thing'], 'the turn ending is what releases it')
  assert.deepEqual(harness.client.getQueuedMessages(), [], 'and the strip empties')
  assert.deepEqual(announced.at(-1), [])
  harness.dispose()
})

test('a message queued mid-turn carries its attachments as refs, not paths', async () => {
  const harness = await createHarness()
  const imported = await harness.client.importAttachment({
    kind: 'path',
    path: fixtureImagePath('transparent.png'),
  })
  assert.ok(imported.ok, 'import failed')
  if (!imported.ok) return
  const { ref } = imported.attachment

  harness.setStreaming(true)
  const stored = await harness.client.enqueueMessage('look at this later', { imageIds: [ref.id, ref.id] })

  // The queue persists text *and* refs — never the source path — and the ref is
  // the host's, resolved out of its own store.
  assert.deepEqual(stored.images?.map((image) => image.id), [ref.id])
  assert.equal(stored.images?.[0]?.name, 'transparent.png')
  assert.doesNotThrow(() => structuredClone(stored))
  assertNoImageBytes(stored, 'queued message')

  await settle()
  assert.deepEqual(harness.client.getQueuedMessages()[0]?.images?.map((image) => image.id), [ref.id])

  harness.setStreaming(false)
  await settle()
  assert.deepEqual(harness.submits, ['look at this later'])
  assert.deepEqual(harness.inputs[0]?.images?.map((image) => image.id), [ref.id], 'the hand-off keeps them')
  harness.dispose()
})

test('an unknown attachment id and a text-only model both refuse the enqueue outright', async () => {
  const harness = await createHarness()
  const imported = await harness.client.importAttachment({
    kind: 'path',
    path: fixtureImagePath('transparent.png'),
  })
  assert.ok(imported.ok, 'import failed')
  if (!imported.ok) return

  harness.setStreaming(true)
  await assert.rejects(
    () => harness.client.enqueueMessage('with a ghost', { imageIds: ['not-registered'] }),
    /not available/,
  )
  assert.deepEqual(harness.client.getQueuedMessages(), [], 'nothing was queued')

  // The accept-time capability check (design §12.2): refused while the composer
  // still holds the draft, rather than persisted into a refusal later.
  harness.setImageCapable(false)
  await assert.rejects(
    () => harness.client.enqueueMessage('describe this', { imageIds: [imported.attachment.ref.id] }),
    (error: unknown) => {
      // Only the message survives the wire, so the exit rides along in it
      // (S24): the renderer shows a `fail` verbatim, and "this model cannot
      // see images" without a way out is a dead end.
      const message = (error as Error).message
      assert.match(message, /does not accept image input/)
      assert.ok(message.endsWith(imageErrorCopy('model-not-capable')!.action), message)
      return true
    },
  )
  await settle()
  assert.deepEqual(harness.client.getQueuedMessages(), [])

  // Text still queues on the same model, and nothing was lost on the way.
  await harness.client.enqueueMessage('plain text')
  await settle()
  assert.deepEqual(harness.client.getQueuedMessages().map((message) => message.content), ['plain text'])
  harness.setStreaming(false)
  await settle()
  assert.deepEqual(harness.submits, ['plain text'])
  harness.dispose()
})

test('clearing the queue reaches the host and empties the strip', async () => {
  const harness = await createHarness()
  harness.setStreaming(true)
  await harness.client.enqueueMessage('never mind')
  await settle()
  assert.equal(harness.client.getQueuedMessages().length, 1)

  // The Clear button in `dom/queueView.ts`.
  await harness.client.clearQueue()
  await settle()

  assert.deepEqual(harness.client.getQueuedMessages(), [])
  harness.setStreaming(false)
  await settle()
  assert.deepEqual(harness.submits, [], 'a cleared message must not surface later')
  harness.dispose()
})

/**
 * The image-attachment command surface, end to end over the same cloned wire.
 *
 * What has to survive here is the whole S08 bargain: bytes cross as a plain
 * `Uint8Array` (never a DOM object), ids are the only thing a submit carries,
 * the host builds the refs from its own store, and no reply — including the
 * preview's — ever carries more than its designed payload.
 */
test('pasted bytes import, and a submit carries the host-resolved ref', async () => {
  const harness = await createHarness()
  const bytes = await loadFixtureBytes('transparent.png')

  const imported = await harness.client.importAttachment({
    kind: 'bytes',
    name: 'transparent.png',
    bytes: new Uint8Array(bytes),
  })
  assert.ok(imported.ok, `import failed: ${imported.ok ? '' : imported.message}`)
  if (!imported.ok) return
  const { ref, animated } = imported.attachment
  assert.equal(ref.ownerSessionId, 'ses', 'the current session owns the import')
  assert.equal(ref.name, 'transparent.png')
  assert.equal(animated, false)
  assert.ok(ref.byteLength > 0)
  // Clone-safe and byte-free: a ref is metadata, not an image.
  assert.doesNotThrow(() => structuredClone(imported))
  assertNoImageBytes(imported, 'import reply')

  // The same id twice is one attachment, in order, and an id the store
  // vouches for reaches the controller as a full ref.
  await harness.client.submit('describe this', { imageIds: [ref.id, ref.id] })
  await settle()
  assert.deepEqual(harness.submits, ['describe this'])
  const input = harness.inputs[0]!
  assert.deepEqual(input.images?.map((image) => image.id), [ref.id])
  assert.equal(input.images?.[0]?.mimeType, ref.mimeType)
  assert.equal(input.images?.[0]?.width, ref.width)
  harness.dispose()
})

test('a local file imports through a path the host reads itself', async () => {
  const harness = await createHarness()
  const imported = await harness.client.importAttachment({
    kind: 'path',
    path: fixtureImagePath('exif-orientation.jpg'),
  })
  assert.ok(imported.ok, `import failed: ${imported.ok ? '' : imported.message}`)
  if (!imported.ok) return
  // No name on the wire: the host derived it from the path.
  assert.equal(imported.attachment.ref.name, 'exif-orientation.jpg')

  // A path that is not an image is an answer, not a protocol error.
  const notAnImage = await harness.client.importAttachment({ kind: 'path', path: `${harness.cwd}/notes.txt` })
  assert.equal(notAnImage.ok, false)
  assert.equal(notAnImage.reason, 'decode-failed')

  const missing = await harness.client.importAttachment({ kind: 'path', path: `${harness.cwd}/gone.png` })
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'file-missing')
  harness.dispose()
})

test('an attachment id from another session rejects the submit before a turn starts', async () => {
  const harness = await createHarness()
  const bytes = await loadFixtureBytes('transparent.png')
  // Registered under a *different* owner session, straight through the service:
  // the renderer never gets to say which session an id belongs to.
  const other = await harness.attachments.importImage('other-session', Buffer.from(bytes), 'transparent.png')
  assert.ok(other.ok)
  const imageId = other.ok ? other.value.ref.id : ''

  await assert.rejects(harness.client.submit('try this one', { imageIds: [imageId] }), /not available/)
  await settle()
  assert.deepEqual(harness.submits, [], 'the turn never started')

  // An unregistered id in the current session is the same refusal.
  await assert.rejects(harness.client.submit('no such image', { imageIds: ['img-nope'] }), /not available/)
  await settle()
  assert.deepEqual(harness.submits, [])
  harness.dispose()
})

test('oversized paste bytes are refused at the schema, before the store sees them', async () => {
  const harness = await createHarness()
  await assert.rejects(
    harness.client.importAttachment({
      kind: 'bytes',
      name: 'huge.png',
      bytes: new Uint8Array(MAX_ATTACHMENT_WIRE_BYTES + 1),
    }),
    /attachment limit/,
  )
  harness.dispose()
})

test('previews are bounded data URLs fetched on demand, with structured failures', async () => {
  const harness = await createHarness()
  const bytes = await loadFixtureBytes('transparent.png')
  const imported = await harness.client.importAttachment({
    kind: 'bytes',
    name: 'transparent.png',
    bytes: new Uint8Array(bytes),
  })
  assert.ok(imported.ok)
  if (!imported.ok) return

  const preview = await harness.client.getAttachmentPreview(imported.attachment.ref.id)
  assert.ok(preview.ok, `preview failed: ${preview.ok ? '' : preview.message}`)
  if (!preview.ok) return
  assert.match(preview.dataUrl, /^data:image\/png;base64,/)

  const missing = await harness.client.getAttachmentPreview('img-nope')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'file-missing')
  harness.dispose()
})

test('remove is idempotent and open hands the host-resolved path to the shell', async () => {
  const harness = await createHarness()
  const bytes = await loadFixtureBytes('transparent.png')
  const imported = await harness.client.importAttachment({
    kind: 'bytes',
    name: 'transparent.png',
    bytes: new Uint8Array(bytes),
  })
  assert.ok(imported.ok)
  if (!imported.ok) return
  const ref = imported.attachment.ref

  // Dropping a draft hold twice, and dropping one nobody held, are both answers.
  await harness.client.removeAttachment(ref.id)
  await harness.client.removeAttachment(ref.id)
  await harness.client.removeAttachment('img-never-held')

  const opened = await harness.client.openAttachment(ref.id)
  assert.equal(opened.ok, true)
  // The path the shell received is the one the *service* computed, not a value
  // the renderer ever named.
  const stored = await harness.attachments.resolveRef({ ownerSessionId: 'ses', id: ref.id })
  assert.ok(stored.ok)
  assert.deepEqual(harness.openedAttachmentPaths, [stored.ok ? stored.value.metadata.localPath : ''])

  const missing = await harness.client.openAttachment('img-nope')
  assert.equal(missing.ok, false)
  assert.equal(missing.reason, 'file-missing')
  harness.dispose()
})
