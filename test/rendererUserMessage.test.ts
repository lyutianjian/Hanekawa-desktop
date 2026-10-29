import test from 'node:test'
import assert from 'node:assert/strict'
import fc from 'fast-check'

import { splitUserMessage } from '../src/desktop/renderer/model/userMessage.js'
import { extractAtMentions } from '../src/runtime/suggestions/atToken.js'

/**
 * The user bubble's segmentation. The property at the bottom is the one that makes
 * 「正文逐字不变」 checkable rather than a claim in a comment.
 */

/** The registry the bubble decorates by. Two skills and one built-in with an alias. */
const COMMANDS = [
  { name: 'review', description: 'Review the diff', isSkill: true },
  { name: 'slides', description: 'Build a deck', isSkill: true },
  { name: 'compact', description: 'Compact the conversation', aliases: ['shrink'] },
]

const rebuilt = (input: string): string => splitUserMessage(input).map((segment) => segment.text).join('')
const labels = (input: string): string[] =>
  splitUserMessage(input).flatMap((segment) => (segment.kind === 'file' ? [segment.label] : []))

test('a message with no mention is one text segment', () => {
  assert.deepEqual(splitUserMessage('hello there'), [{ kind: 'text', text: 'hello there' }])
  assert.deepEqual(splitUserMessage(''), [])
})

test('a bare mention becomes a pill and the text around it is untouched', () => {
  assert.deepEqual(splitUserMessage('look at @src/a.ts please'), [
    { kind: 'text', text: 'look at ' },
    { kind: 'file', text: '@src/a.ts', label: 'src/a.ts' },
    { kind: 'text', text: ' please' },
  ])
})

test('a mention at the very start needs no leading text segment', () => {
  assert.deepEqual(splitUserMessage('@a.ts is broken'), [
    { kind: 'file', text: '@a.ts', label: 'a.ts' },
    { kind: 'text', text: ' is broken' },
  ])
})

test('the quoted form keeps its spaces and loses only the punctuation', () => {
  assert.deepEqual(splitUserMessage('read @"src/with space.cpp"#L3-4 now'), [
    { kind: 'text', text: 'read ' },
    { kind: 'file', text: '@"src/with space.cpp"#L3-4', label: 'src/with space.cpp#L3-4' },
    { kind: 'text', text: ' now' },
  ])
})

test('a line range rides along in the label', () => {
  assert.deepEqual(labels('see @src/a.ts#L10-20'), ['src/a.ts#L10-20'])
})

test('two mentions in one sentence both become pills', () => {
  assert.deepEqual(splitUserMessage('把 @a.ts 的逻辑搬到 @b.ts'), [
    { kind: 'text', text: '把 ' },
    { kind: 'file', text: '@a.ts', label: 'a.ts' },
    { kind: 'text', text: ' 的逻辑搬到 ' },
    { kind: 'file', text: '@b.ts', label: 'b.ts' },
  ])
})

test('an address is not a mention, because a mention starts at a word boundary', () => {
  // The `(^|\s)` group earns its keep here: without it every email in a pasted
  // stack trace turns into a file pill.
  assert.deepEqual(labels('mail me at foo@bar.com'), [])
  assert.equal(rebuilt('mail me at foo@bar.com'), 'mail me at foo@bar.com')
})

test('mentions are reported in reading order, not pattern order', () => {
  // The quoted pattern runs first, so an unsorted implementation reports the later
  // quoted mention before the earlier bare one — and the bubble is reassembled with
  // its words swapped.
  assert.deepEqual(labels('@a.ts then @"b c.ts"'), ['a.ts', 'b c.ts'])
  assert.equal(rebuilt('@a.ts then @"b c.ts"'), '@a.ts then @"b c.ts"')
})

test('the spans a chip is built from point at exactly the text it replaces', () => {
  const input = 'read @"a b.ts"#L2 and @c.ts'
  for (const span of extractAtMentions(input)) {
    assert.equal(input.slice(span.start, span.end), span.text)
  }
})

test('a skill opens the bubble as a mark and its name, the slash gone', () => {
  // The composer draws a skill by replacing its `/` with the package mark; the
  // bubble has to keep saying the same thing once the message is sent.
  assert.deepEqual(splitUserMessage('/slides make a deck', COMMANDS), [
    { kind: 'command', text: '/slides', label: 'slides', isSkill: true },
    { kind: 'text', text: ' make a deck' },
  ])
})

test('a built-in command keeps the slash that names it', () => {
  assert.deepEqual(splitUserMessage('/compact', COMMANDS), [
    { kind: 'command', text: '/compact', label: '/compact', isSkill: false },
  ])
})

test('a command is recognised by its alias and drawn as it was typed', () => {
  assert.deepEqual(splitUserMessage('/shrink now', COMMANDS), [
    { kind: 'command', text: '/shrink', label: '/shrink', isSkill: false },
    { kind: 'text', text: ' now' },
  ])
})

test('an unregistered slash is not a command, so it stays the text it was', () => {
  // The composer never decorated it either: this is a prompt, not a command.
  assert.deepEqual(splitUserMessage('/nope do something', COMMANDS), [
    { kind: 'text', text: '/nope do something' },
  ])
  assert.deepEqual(splitUserMessage('/usr/bin/env node', COMMANDS), [
    { kind: 'text', text: '/usr/bin/env node' },
  ])
})

test('the command head and the mentions inside its arguments are both drawn', () => {
  assert.deepEqual(splitUserMessage('/review @src/a.ts please', COMMANDS), [
    { kind: 'command', text: '/review', label: 'review', isSkill: true },
    { kind: 'text', text: ' ' },
    { kind: 'file', text: '@src/a.ts', label: 'src/a.ts' },
    { kind: 'text', text: ' please' },
  ])
})

test('leading whitespace is kept as text, the way the composer keeps it', () => {
  assert.deepEqual(splitUserMessage('  /compact', COMMANDS), [
    { kind: 'text', text: '  ' },
    { kind: 'command', text: '/compact', label: '/compact', isSkill: false },
  ])
})

test('every segmentation reassembles into the input, character for character', () => {
  // The decision「原地内联，正文不变」, as a property. A segmenter that hoisted a
  // mention out of the body — the design document's own layout — fails this.
  fc.assert(
    fc.property(
      fc.stringMatching(/^[a-z@". \n#L0-9一-龥/-]*$/),
      (input) => {
        assert.equal(rebuilt(input), input)
        // The same invariant under decoration: a recognised leading token is a
        // segment like any other, never a rewrite of the user's words.
        assert.equal(splitUserMessage(input, COMMANDS).map((segment) => segment.text).join(''), input)
      },
    ),
    { numRuns: 500 },
  )
})

test('a command segment carries the source token it replaces', () => {
  for (const input of ['/compact', '/slides a b', '  /review @a.ts']) {
    for (const segment of splitUserMessage(input, COMMANDS)) {
      if (segment.kind !== 'command') continue
      assert.ok(input.includes(segment.text), segment.text)
      assert.equal(segment.label, segment.isSkill ? segment.text.slice(1) : segment.text)
    }
  }
})
