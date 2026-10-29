import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hostCommandSchema, MAX_ATTACHMENT_WIRE_BYTES, parseHostCommand } from '../src/runtime/protocol/commandSchema.js'
import type { HostCommand } from '../src/runtime/protocol/wire.js'

/**
 * The schema is a second description of `HostCommand`, so most of what matters
 * here is that the two cannot drift. Two compile-time guards in
 * `commandSchema.ts` already cover that (a keyed `satisfies` table and a mutual
 * assignability assertion); this file adds the runtime half, which is what
 * catches a copy-paste that typechecks -- a variant whose key and whose
 * `z.literal` disagree.
 */

/** One minimal valid instance of every variant. */
const SAMPLES = {
  hello: { type: 'hello', id: '1' },
  submit: { type: 'submit', id: '1', input: 'hi' },
  interrupt: { type: 'interrupt', id: '1', reason: 'user-cancel' },
  'retry-turn': { type: 'retry-turn', id: '1', failureId: 'f-1' },
  reload: { type: 'reload', id: '1' },
  retarget: { type: 'retarget', id: '1', sessionId: 's' },
  'run-tool': { type: 'run-tool', id: '1', name: 'Read', input: { file_path: '/tmp/x' } },
  'run-command': { type: 'run-command', id: '1', input: '/help' },
  'list-commands': { type: 'list-commands', id: '1' },
  'file-suggestions': { type: 'file-suggestions', id: '1', input: 'read @src/a', cursorPos: 11 },
  'list-branches': { type: 'list-branches', id: '1' },
  'switch-branch': { type: 'switch-branch', id: '1', branch: 'topic' },
  checkpoints: { type: 'checkpoints', id: '1' },
  'context-breakdown': { type: 'context-breakdown', id: '1' },
  'restore-code': { type: 'restore-code', id: '1', messageId: 'm1' },
  'truncate-session': { type: 'truncate-session', id: '1', messageId: 'm1' },
  'summarize-rewind': { type: 'summarize-rewind', id: '1', messageId: 'm1', decision: 'summarize-from-here' },
  'set-model': { type: 'set-model', id: '1', modelKey: 'main' },
  'set-effort': { type: 'set-effort', id: '1', level: 'high' },
  'set-permission-mode': { type: 'set-permission-mode', id: '1', mode: 'plan' },
  'ui-response': { type: 'ui-response', requestId: 'r', response: { kind: 'permission', approved: true } },
  'list-models': { type: 'list-models', id: '1' },
  'resolve-model': { type: 'resolve-model', id: '1', input: 'fast' },
  'set-default-model': { type: 'set-default-model', id: '1', reference: 'fast' },
  'list-sessions': { type: 'list-sessions', id: '1' },
  'create-session': { type: 'create-session', id: '1' },
  'reload-agents': { type: 'reload-agents', id: '1' },
  'reload-skills': { type: 'reload-skills', id: '1' },
  'reload-settings': { type: 'reload-settings', id: '1' },
  'list-background-tasks': { type: 'list-background-tasks', id: '1' },
  'peek-task-output': { type: 'peek-task-output', id: '1', taskId: 't' },
  'kill-task': { type: 'kill-task', id: '1', taskId: 't' },
  'open-pane': { type: 'open-pane', id: '1' },
  'close-pane': { type: 'close-pane', id: '1', paneId: 'p' },
  'list-panes': { type: 'list-panes', id: '1' },
  'focus-pane': { type: 'focus-pane', id: '1', paneId: 'p' },
  'open-project': { type: 'open-project', id: '1' },
  'enqueue-message': { type: 'enqueue-message', id: '1', content: 'later, please' },
  'clear-queue': { type: 'clear-queue', id: '1' },
  'import-attachment': { type: 'import-attachment', id: '1', source: { kind: 'path', path: 'C:/pics/a.png' } },
  'remove-attachment': { type: 'remove-attachment', id: '1', imageId: 'img-1' },
  'get-attachment-preview': { type: 'get-attachment-preview', id: '1', imageId: 'img-1' },
  'get-attachment-view': { type: 'get-attachment-view', id: '1', imageId: 'img-1' },
  'get-subagent-transcript': { type: 'get-subagent-transcript', id: '1', agentId: 'explore-1' },
  'open-attachment': { type: 'open-attachment', id: '1', imageId: 'img-1' },
  shutdown: { type: 'shutdown', id: '1', reason: 'bye' },
} as const satisfies Record<HostCommand['type'], HostCommand>

test('the schema covers exactly the variants wire.ts declares', () => {
  // Read from the source rather than from the type, so a variant deleted from
  // both `HostCommand` and the schema at once still has to be deleted from
  // wire.ts to pass -- and so the failure names the variant.
  const source = readFileSync(fileURLToPath(new URL('../src/runtime/protocol/wire.ts', import.meta.url)), 'utf8')
  const start = source.indexOf('export type HostCommand =')
  const end = source.indexOf('export type InterruptReason')
  assert.ok(start >= 0 && end > start, 'could not slice the HostCommand union out of wire.ts')

  const declared = [...source.slice(start, end).matchAll(/type: '([a-z-]+)'/g)].map((match) => match[1])
  assert.ok(declared.length > 15, `only parsed ${declared.length} variants; the regex probably broke`)

  assert.deepEqual([...declared].sort(), [...hostCommandSchema.optionsMap.keys()].sort())
})

test('the sample table covers every variant', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), [...hostCommandSchema.optionsMap.keys()].sort())
})

for (const [name, sample] of Object.entries(SAMPLES)) {
  test(`${name} round-trips unchanged`, () => {
    const parsed = parseHostCommand(sample)
    assert.ok(parsed.ok, `expected ${name} to parse`)
    assert.deepEqual(parsed.command, sample)
  })
}

test('an unknown type is rejected, with the id recovered', () => {
  // Before validation this fell through the switch in execute() and was
  // answered with a `reply` carrying `result: undefined`, so the caller saw a
  // command that had quietly done nothing as a success.
  const parsed = parseHostCommand({ type: 'bogus', id: 'x' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.id, 'x')
  assert.equal(parsed.requestId, undefined)
})

test('close-pane accepts the conditional eviction flag and validates its type', () => {
  const command = { type: 'close-pane', id: 'c', paneId: 'p', onlyIfIdle: true }
  const parsed = parseHostCommand(command)
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.command, command)
  assert.equal(parseHostCommand({ ...command, onlyIfIdle: 'true' }).ok, false)
})

test('an unknown key is rejected and named', () => {
  const parsed = parseHostCommand({ type: 'hello', id: 'x', extra: 1 })
  assert.equal(parsed.ok, false)
  assert.match(parsed.message, /extra/)
})

test('a wrong field type is rejected', () => {
  const parsed = parseHostCommand({ type: 'restore-code', id: 'x', messageId: 42 })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.id, 'x')
})

test('set-permission-mode accepts every mode, including readonly', () => {
  // PERMISSION_MODES is the Shift+Tab cycle and omits `readonly`; building the
  // schema from it would reject a legal mode.
  for (const mode of ['default', 'plan', 'auto', 'bypass', 'readonly']) {
    const parsed = parseHostCommand({ type: 'set-permission-mode', id: '1', mode })
    assert.ok(parsed.ok, `expected ${mode} to parse`)
  }
  assert.equal(parseHostCommand({ type: 'set-permission-mode', id: '1', mode: 'god' }).ok, false)
})

test('set-effort accepts a numeric token budget as a string', () => {
  // A numeric effort is a raw budget, not one of VALID_EFFORT_LEVELS, and
  // RuntimeSlot.applyEffort keeps it as given.
  assert.equal(parseHostCommand({ type: 'set-effort', id: '1', level: '32000' }).ok, true)
  assert.equal(parseHostCommand({ type: 'set-effort', id: '1', level: 'max' }).ok, true)
})

test('summarize-rewind accepts both decisions and nothing else', () => {
  for (const decision of ['summarize-from-here', 'summarize-up-to-here']) {
    const parsed = parseHostCommand({ type: 'summarize-rewind', id: '1', messageId: 'm', decision })
    assert.ok(parsed.ok, `expected ${decision} to parse`)
  }
  // 'restore-conversation' is a RestoreDecision, not a RewindSummaryDecision:
  // the picker offers five options and only two of them summarize.
  for (const decision of ['restore-conversation', 'summarize', '', undefined]) {
    assert.equal(parseHostCommand({ type: 'summarize-rewind', id: '1', messageId: 'm', decision }).ok, false)
  }
})

test('run-tool preserves any input shape byte for byte', () => {  for (const input of [null, 42, 'text', [1, 2], { nested: { deep: [{ a: 1 }] } }]) {
    const parsed = parseHostCommand({ type: 'run-tool', id: '1', name: 'X', input })
    assert.ok(parsed.ok)
    assert.deepEqual((parsed.command as { input: unknown }).input, input)
  }
})

test('run-tool still rejects an unknown key beside its free-form input', () => {
  assert.equal(parseHostCommand({ type: 'run-tool', id: '1', name: 'X', input: {}, cwd: '/' }).ok, false)
})

test('a ui-response recovers requestId and never an id', () => {
  const parsed = parseHostCommand({ type: 'ui-response', requestId: 'r', response: { kind: 'permission' } })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.requestId, 'r')
  assert.equal(parsed.id, undefined)
})

test('a requestId on any other command is not recovered', () => {
  // Otherwise a malformed `submit` carrying a stray requestId could settle
  // somebody else's pending prompt.
  const parsed = parseHostCommand({ type: 'submit', id: 'x', requestId: 'r' })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.requestId, undefined)
})

test('every UiResponse kind parses', () => {
  const responses = [
    { kind: 'permission', approved: false, alwaysAllow: true },
    { kind: 'ask-user-question', result: { kind: 'answers', answers: { q: 'a' } } },
    { kind: 'ask-user-question', result: { kind: 'rejected' } },
    { kind: 'enter-plan', approved: true },
    { kind: 'exit-plan', decision: { kind: 'approve_restore_keep' } },
    { kind: 'exit-plan', decision: { kind: 'approve_auto_keep', planContent: 'p' } },
    { kind: 'exit-plan', decision: { kind: 'approve_bypass_keep' } },
    { kind: 'exit-plan', decision: { kind: 'reject', feedback: 'no' } },
  ]
  for (const response of responses) {
    const parsed = parseHostCommand({ type: 'ui-response', requestId: 'r', response })
    assert.ok(parsed.ok, `expected ${JSON.stringify(response)} to parse`)
  }
})

test('non-objects are rejected with nothing to answer', () => {
  for (const message of [null, 42, 'x', [], undefined]) {
    const parsed = parseHostCommand(message)
    assert.equal(parsed.ok, false)
    assert.equal(parsed.id, undefined)
    assert.equal(parsed.requestId, undefined)
  }
})

test('the failure message is bounded', () => {
  // It is echoed back over the wire, so a hostile payload must not turn into a
  // large reply.
  const parsed = parseHostCommand({ type: 'hello', id: 'x', ...Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`key${index}`.padEnd(40, 'x'), 1]),
  ) })
  assert.equal(parsed.ok, false)
  assert.ok(parsed.message.length <= 501, `message was ${parsed.message.length} chars`)
})

test('the two shell hand-off commands are strict about their own fields', () => {
  // Both are pure forwards to a shell callback, so the host does no resolving
  // that would catch a bogus payload later -- the schema is the only gate.
  assert.equal(parseHostCommand({ type: 'focus-pane', id: '1' }).ok, false)
  assert.equal(parseHostCommand({ type: 'focus-pane', id: '1', paneId: 'p', sessionId: 's' }).ok, false)
  assert.equal(parseHostCommand({ type: 'focus-pane', id: '1', paneId: 42 }).ok, false)

  // The shell owns the picker: no path, and nothing else may ride along.
  assert.equal(parseHostCommand({ type: 'open-project', id: '1', path: 'C:/repo' }).ok, false)
  assert.equal(parseHostCommand({ type: 'open-project', id: '1', cwd: 'C:/repo' }).ok, false)
})

test('submit carries attachment ids, and only ids', () => {
  const parsed = parseHostCommand({ type: 'submit', id: '1', input: 'hi', imageIds: ['img-a', 'img-b'] })
  assert.ok(parsed.ok)
  assert.deepEqual(parsed.command.type === 'submit' ? parsed.command.imageIds : undefined, ['img-a', 'img-b'])

  // A renderer that tries to smuggle a path, a MIME type, or a dimension in
  // place of an id never reaches the host's store lookup.
  assert.equal(parseHostCommand({ type: 'submit', id: '1', input: 'hi', imageIds: 'img-a' }).ok, false)
  assert.equal(parseHostCommand({ type: 'submit', id: '1', input: 'hi', images: [{ id: 'img-a' }] }).ok, false)
})

test('import-attachment accepts both sources and rejects oversized bytes at the boundary', () => {
  const small = new Uint8Array([1, 2, 3])
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'p.png', bytes: small } }).ok,
    true,
  )
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'path', path: 'C:/pics/a.png', name: 'a.png' } }).ok,
    true,
  )

  // One byte over the cap, so the boundary itself is exact.
  const oversized = new Uint8Array(MAX_ATTACHMENT_WIRE_BYTES + 1)
  const parsed = parseHostCommand({
    type: 'import-attachment',
    id: '1',
    source: { kind: 'bytes', name: 'huge.png', bytes: oversized },
  })
  assert.equal(parsed.ok, false)
  assert.equal(parsed.id, '1', 'the id is recovered so the sender rejects rather than hangs')
  assert.match(parsed.message, /attachment limit/)

  // The cap applies to the buffer's bytes, not to a view into a larger one.
  const view = new Uint8Array(new ArrayBuffer(MAX_ATTACHMENT_WIRE_BYTES + 1024), 0, 4)
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'v.png', bytes: view } }).ok,
    true,
  )

  // Anything but a real Uint8Array is refused — no DOM objects, no base64.
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'x', bytes: 'aGVsbG8=' } }).ok,
    false,
  )
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'x', bytes: {} } }).ok,
    false,
  )
  assert.equal(parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'nope' } }).ok, false)
  assert.equal(
    parseHostCommand({ type: 'import-attachment', id: '1', source: { kind: 'bytes', name: 'x', bytes: small, path: 'C:/x' } }).ok,
    false,
  )
})

test('a sub-agent transcript is asked for by an id that cannot be a path', () => {
  assert.equal(parseHostCommand({ type: 'get-subagent-transcript', id: '1', agentId: 'explore-1' }).ok, true)
  for (const agentId of ['../x', 'a/b', '', 'a.b']) {
    assert.equal(parseHostCommand({ type: 'get-subagent-transcript', id: '1', agentId }).ok, false)
  }
})

test('the id-addressed attachment commands take an imageId and nothing else', () => {
  const types = [
    'remove-attachment',
    'get-attachment-preview',
    'get-attachment-view',
    'open-attachment',
  ] as const
  for (const type of types) {
    assert.equal(parseHostCommand({ type, id: '1', imageId: 'img-1' }).ok, true)
    assert.equal(parseHostCommand({ type, id: '1' }).ok, false)
    assert.equal(parseHostCommand({ type, id: '1', imageId: 'img-1', path: 'C:/x.png' }).ok, false)
  }
})
