import test from 'node:test'
import assert from 'node:assert/strict'
import {
  NO_COMPLETIONS,
  mergeMentionSuggestions,
  acceptCompletion,
  acceptOnly,
  applyFileResponse,
  beginFileRequest,
  closeCompletions,
  commandCompletions,
  completionRows,
  fileCompletionQuery,
  isOpen,
  moveCompletion,
  selectCompletion,
  type CompletionState,
} from '../src/desktop/renderer/model/completion.js'
import type { FileSuggestion } from '../src/runtime/suggestions/atToken.js'
import type { WireCommandInfo } from '../src/runtime/protocol/wire.js'

/**
 * The dropdown over two sources that behave differently.
 *
 * The file half is asynchronous — every keystroke inside an `@…` token is an IPC
 * round trip, and nothing orders the answers. A request for `@src/d` can settle
 * *after* the `@src/de` that followed it, and folding that stale answer in would
 * show the user a list describing text they have already moved past. The `seq`
 * carried on the state is the guard, and the tests below deliver responses out
 * of order on purpose.
 *
 * DOM-free, like every `model/` module: these compile in the base tsconfig
 * program, which has no DOM lib, so a decision is only testable if it never
 * touches a node.
 */

const COMMANDS: WireCommandInfo[] = [
  { name: 'model', description: 'Switch model', aliases: ['m'] },
  { name: 'clear', description: 'Clear session' },
]

function file(path: string, kind: 'file' | 'directory' = 'file'): FileSuggestion {
  return {
    id: `file:${kind}:${path}`,
    displayText: path,
    description: kind === 'directory' ? 'directory' : 'code file',
    metadata: {
      replacementText: kind === 'directory' ? `@${path}` : `@${path}`,
      path,
      kind,
    },
  }
}

// --- the `@` token ----------------------------------------------------------

test('a file lookup is asked for only when the caret sits in an @ token', () => {
  assert.deepEqual(fileCompletionQuery('read @src/a', 11), { input: 'read @src/a', cursorPos: 11 })
  assert.deepEqual(fileCompletionQuery('@', 1), { input: '@', cursorPos: 1 })
  // A bare `@` must start at a word boundary, so an email is prose.
  assert.equal(fileCompletionQuery('mail me@example.com', 19), undefined)
  assert.equal(fileCompletionQuery('no mention here', 15), undefined)
  // The token ends at the first space.
  assert.equal(fileCompletionQuery('read @src/a and stop', 20), undefined)
  // A quoted mention stays open across spaces until its closing quote.
  assert.deepEqual(fileCompletionQuery('read @"my dir/a', 15), { input: 'read @"my dir/a', cursorPos: 15 })
})

test('the whole composer text is sent, not the token', () => {
  // `generateFileSuggestions` re-derives the token host-side. Sending the two
  // halves separately would give them somewhere to disagree.
  const query = fileCompletionQuery('please read @src/desk', 21)
  assert.equal(query?.input, 'please read @src/desk')
  assert.equal(query?.cursorPos, 21)
})

// --- the sequence guard -----------------------------------------------------

test('a stale file answer never overwrites a newer one', () => {
  let state: CompletionState = NO_COMPLETIONS

  const first = beginFileRequest(state)
  state = first.state
  const second = beginFileRequest(state)
  state = second.state

  assert.notEqual(first.seq, second.seq, 'each request gets its own sequence')

  // The newer request answers first, then the older one arrives late.
  state = applyFileResponse(state, second.seq, [file('src/desktop/app.ts')])
  assert.ok(state.kind === 'file')
  assert.deepEqual(completionRows(state).map((row) => row.displayText), ['src/desktop/app.ts'])

  const afterStale = applyFileResponse(state, first.seq, [file('src/dumped.ts')])
  assert.equal(afterStale, state, 'the late answer is dropped whole, not merged')
})

test('typing a slash invalidates a file request already in flight', () => {
  let state: CompletionState = NO_COMPLETIONS
  const pending = beginFileRequest(state)
  state = pending.state

  // The user deleted the `@` and typed `/` instead before the answer came back.
  state = commandCompletions(state, '/m', COMMANDS)
  assert.equal(state.kind, 'command')

  state = applyFileResponse(state, pending.seq, [file('src/a.ts')])
  assert.equal(state.kind, 'command', 'the file answer must not replace the command list')
})

test('closing the dropdown also invalidates an in-flight request', () => {
  let state: CompletionState = NO_COMPLETIONS
  const pending = beginFileRequest(state)
  state = closeCompletions(pending.state)

  state = applyFileResponse(state, pending.seq, [file('src/a.ts')])
  assert.equal(state.kind, 'none', 'a dropdown the user dismissed must not reopen itself')
})

test('rows stay on screen while the next answer is in flight', () => {
  let state: CompletionState = NO_COMPLETIONS
  const first = beginFileRequest(state)
  state = applyFileResponse(first.state, first.seq, [file('src/a.ts')])
  assert.equal(completionRows(state).length, 1)

  // One more keystroke: the old rows must not blink out before the new ones land.
  const second = beginFileRequest(state)
  assert.equal(completionRows(second.state).length, 1)
})

test('an empty answer closes the dropdown', () => {
  const started = beginFileRequest(NO_COMPLETIONS)
  const state = applyFileResponse(started.state, started.seq, [])
  assert.equal(state.kind, 'none')
  assert.equal(isOpen(state), false)
})

// --- accepting --------------------------------------------------------------

test('built-in and skill completions both finish with one space after the token', () => {
  for (const command of [COMMANDS[0]!, { name: 'review', description: 'Review code', isSkill: true }]) {
    const state = commandCompletions(NO_COMPLETIONS, `/${command.name}`, [command])
    const text = `/${command.name} `
    assert.deepEqual(acceptCompletion(state, `/${command.name}`, command.name.length + 1), { text, cursorPos: text.length })
  }
})

test('accepting a file mention splices over its token and leaves the rest alone', () => {
  const started = beginFileRequest(NO_COMPLETIONS)
  const state = applyFileResponse(started.state, started.seq, [file('src/desktop/app.ts')])

  // The caret sits at the end of `@src/de`, with prose on both sides of it.
  const applied = acceptCompletion(state, 'read @src/de and summarise', 12)
  assert.deepEqual(applied, {
    text: 'read @src/desktop/app.ts and summarise',
    cursorPos: 25,
  })
})

test('accepting a directory keeps completing; accepting a file does not', () => {
  const dir = beginFileRequest(NO_COMPLETIONS)
  const dirState = applyFileResponse(dir.state, dir.seq, [file('src/desktop/', 'directory')])
  const afterDir = acceptCompletion(dirState, '@src/de', 7)
  assert.equal(afterDir?.text, '@src/desktop/', 'no trailing space: the next keystroke keeps completing')

  const leaf = beginFileRequest(NO_COMPLETIONS)
  const leafState = applyFileResponse(leaf.state, leaf.seq, [file('src/a.ts')])
  const afterLeaf = acceptCompletion(leafState, '@src/a', 6)
  assert.equal(afterLeaf?.text, '@src/a.ts ', 'a file is done, so it gets its space')
})

test('Enter is accept-only for files and accept-and-run for commands', () => {
  const started = beginFileRequest(NO_COMPLETIONS)
  const fileState = applyFileResponse(started.state, started.seq, [file('src/a.ts')])
  assert.equal(acceptOnly(fileState), true)

  assert.equal(acceptOnly(commandCompletions(NO_COMPLETIONS, '/', COMMANDS)), false)
  assert.equal(acceptOnly(NO_COMPLETIONS), false)
})

test('both sources share one ring, and moving does not re-request', () => {
  const started = beginFileRequest(NO_COMPLETIONS)
  const state = applyFileResponse(started.state, started.seq, [file('a.ts'), file('b.ts')])

  const down = moveCompletion(state, 'down')
  assert.ok(down.kind === 'file')
  assert.equal(down.selectedIndex, 1)
  assert.equal(down.seq, state.seq, 'moving the cursor is not a new request')

  const wrapped = moveCompletion(down, 'down')
  assert.ok(wrapped.kind === 'file')
  assert.equal(wrapped.selectedIndex, 0, 'wraps')

  const up = moveCompletion(state, 'up')
  assert.ok(up.kind === 'file')
  assert.equal(up.selectedIndex, 1, 'wraps the other way')

  // Selecting the second row is what accepting then uses.
  assert.equal(acceptCompletion(down, '@', 1)?.text, '@b.ts ')
})

test('an empty state answers nothing rather than throwing', () => {
  assert.deepEqual(completionRows(NO_COMPLETIONS), [])
  assert.equal(isOpen(NO_COMPLETIONS), false)
  assert.equal(acceptCompletion(NO_COMPLETIONS, 'x', 1), undefined)
  assert.equal(moveCompletion(NO_COMPLETIONS, 'down'), NO_COMPLETIONS)
})

test('a clicked row is focused by index, clamped and without re-requesting', () => {
  const started = beginFileRequest(NO_COMPLETIONS)
  const state = applyFileResponse(started.state, started.seq, [file('a.ts'), file('b.ts')])

  const picked = selectCompletion(state, 1)
  assert.ok(picked.kind === 'file')
  assert.equal(picked.selectedIndex, 1)
  assert.equal(picked.seq, state.seq, 'a click is not a new request either')
  assert.equal(acceptCompletion(picked, '@', 1)?.text, '@b.ts ')

  // Clamped rather than wrapped: an index off the end is a stale row, not a step
  // around a ring.
  assert.equal((selectCompletion(state, 9) as { selectedIndex: number }).selectedIndex, 1)
  assert.equal((selectCompletion(state, -3) as { selectedIndex: number }).selectedIndex, 0)
  assert.equal(selectCompletion(NO_COMPLETIONS, 0), NO_COMPLETIONS)
})


test('mixed mentions keep both sources, cap at fifteen and accept sessions without sending', () => {
  const sessions: FileSuggestion[] = Array.from({ length: 15 }, (_, i) => ({
    id: `session:${i}`, displayText: `会话${i}`,
    metadata: { kind: 'session', path: 'hanekawa://session/11111111-1111-4111-8111-111111111111', replacementText: '[会话](hanekawa://session/11111111-1111-4111-8111-111111111111)', projectName: '最近' },
  }))
  const combined = mergeMentionSuggestions(Array.from({ length: 15 }, (_, i) => file(`src/a${i}.ts`)), sessions)
  assert.equal(combined.length, 15)
  assert.ok(combined.filter((row) => row.metadata.kind === 'file').length >= 5)
  assert.ok(combined.filter((row) => row.metadata.kind === 'session').length >= 5)
  const requested = beginFileRequest(NO_COMPLETIONS)
  const state = applyFileResponse(requested.state, requested.seq, sessions)
  assert.equal(acceptOnly(state), true)
  const accepted = acceptCompletion(state, '参考 @会', 5)
  assert.equal(accepted?.text, '参考 [会话](hanekawa://session/11111111-1111-4111-8111-111111111111) ')
  assert.deepEqual(acceptCompletion(state, '参考 @ 下一步', 4), {
    text: '参考 [会话](hanekawa://session/11111111-1111-4111-8111-111111111111) 下一步',
    cursorPos: accepted!.cursorPos,
  })
  assert.equal(completionRows(state)[0]?.mention?.icon, 'message-circle')
})
