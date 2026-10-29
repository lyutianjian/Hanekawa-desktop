import { extractAtMentions } from '../../../runtime/suggestions/atToken.js'
import type { WireCommandInfo } from '../../../runtime/protocol/wire.js'
import { matchInputCommand } from './commandRouting.js'

/**
 * A user message, split into the text, the files it mentions and the slash
 * command it opens with.
 *
 * `design_guidance.md` 三.3① draws referenced files as compact pills. It puts them at
 * the head of the bubble, which this does **not**: a mention here is part of a
 * sentence the user typed (「把 @a.ts 的逻辑搬到 @b.ts」), and hoisting it would edit
 * their words and leave the sentence with a hole. So the pill is drawn where the
 * mention is — the radius table's own name for it, 「行内文件代码胶囊」.
 *
 * The leading `/name` is the composer's other decoration, kept after the send.
 * While the message is being typed, `dom/composerView.ts` paints that token
 * accent-coloured and, for a skill, draws the skill's name behind a package mark
 * in place of the slash; the bubble draws it the same way from this same
 * segmentation, so sending does not undo what the input showed.
 * `matchInputCommand` is the one rule for which leading token *is* a command —
 * registered names only — so the two views cannot disagree about it.
 *
 * The invariant that makes that safe is testable: concatenating every segment's
 * `text` reproduces the input exactly. Nothing is dropped, reordered or
 * normalised. A segment's `label` is what stands in for its `text` when the
 * markup replaces it (a pill drops the `@` and the quotes; a skill drops the
 * slash because the mark says it).
 */

export type UserMessageSegment =
  | { readonly kind: 'text'; readonly text: string }
  /** `text` is the source substring; `label` is what the pill shows. */
  | { readonly kind: 'file'; readonly text: string; readonly label: string }
  /** `text` is the source token (`/name`); `label` is what the token is drawn as. */
  | { readonly kind: 'command'; readonly text: string; readonly label: string; readonly isSkill: boolean }

/**
 * `commands` is the pane's live registry, read through the transcript's
 * `commands()` handler. Empty draws mentions only — an unknown `/foo` is a
 * prompt the model got, not a command, which is what the composer decided while
 * it was being typed.
 */
export function splitUserMessage(
  input: string,
  commands: readonly WireCommandInfo[] = [],
): UserMessageSegment[] {
  const head = matchInputCommand(input, commands)
  if (!head) return mentionSegments(input, 0)

  const token = input.slice(head.start, head.end)
  const segments: UserMessageSegment[] = []
  if (head.start > 0) segments.push({ kind: 'text', text: input.slice(0, head.start) })
  segments.push({
    kind: 'command',
    text: token,
    // The composer's own two answers: a built-in is drawn as the token that was
    // typed (an alias included), a skill by its name with the slash gone.
    label: head.command.isSkill ? head.command.name : token,
    isSkill: head.command.isSkill === true,
  })
  return [...segments, ...mentionSegments(input, head.end)]
}

/** The mentions from `from` on, with the text between them left exactly as typed. */
function mentionSegments(input: string, from: number): UserMessageSegment[] {
  const segments: UserMessageSegment[] = []
  let at = from
  for (const span of extractAtMentions(input)) {
    if (span.start < from) continue
    if (span.start > at) segments.push({ kind: 'text', text: input.slice(at, span.start) })
    // The label drops the `@` and the quotes: the file icon says what they said, and
    // a pill reading `@"a b.ts"` is punctuation the user does not need to re-read.
    segments.push({ kind: 'file', text: span.text, label: span.mention })
    at = span.end
  }
  if (at < input.length) segments.push({ kind: 'text', text: input.slice(at) })
  return segments
}