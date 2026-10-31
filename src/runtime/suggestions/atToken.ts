import type { SuggestionItem } from './types.js'
import { insertSuggestion } from './insertSuggestion.js'

/**
 * The half of `@` file completion that a browser can run.
 *
 * `fileSuggestions.ts` needs `node:fs`, `node:path` and `fuse.js` to *find*
 * candidates, none of which a renderer bundle can carry. But
 * deciding **where the `@` token starts** and **what the text looks like after
 * accepting one** is pure string work, and both shells need exactly that: the
 * host searches, the view splices.
 *
 * So the split is by dependency, not by convenience. This module and its
 * insertion helper only operate on strings, which lets this module sit on
 * `test/rendererImports.test.ts`'s allowlist — that test opens every allowlisted
 * file and fails on any `node:` value import other than `node:crypto`.
 * `fileSuggestions.ts` re-exports all four names, so no existing caller moved.
 */

export interface FileSuggestionMetadata {
  replacementText: string
  path: string
  kind: 'directory' | 'file' | 'session'
  projectName?: string
  updatedAt?: string
  currentProject?: boolean
}

export type FileSuggestion = SuggestionItem<FileSuggestionMetadata> & {
  metadata: FileSuggestionMetadata
}

/**
 * The `@…` token the caret currently sits in, or null.
 *
 * Two forms: a bare `@path/to/file` that ends at the first space, and a quoted
 * `@"path with spaces` that stays open until its closing quote. Both must start
 * at a word boundary, so an email address or a `foo@bar` never opens a picker.
 */
export function extractAtCompletionToken(text: string, cursorPos: number): {
  token: string
  startPos: number
} | null {
  const before = text.slice(0, cursorPos)
  const quotedIndex = before.lastIndexOf('@"')
  if (quotedIndex >= 0 && (quotedIndex === 0 || /\s/.test(before[quotedIndex - 1]!))) {
    const token = before.slice(quotedIndex)
    if (!token.slice(2).includes('"')) {
      return { token, startPos: quotedIndex }
    }
  }

  const atIndex = before.lastIndexOf('@')
  if (atIndex < 0 || (atIndex > 0 && !/\s/.test(before[atIndex - 1]!))) return null
  const token = before.slice(atIndex)
  if (/\s/.test(token) || token.startsWith('@"')) return null
  return { token, startPos: atIndex }
}

/**
 * The two shapes an `@` mention takes in a *settled* string, as fresh regexes.
 *
 * Fresh on every call because both are `/g`: a shared instance carries `lastIndex`
 * between callers, and the second caller silently starts halfway through its input.
 *
 * The leading `(^|\s)` group is the same word boundary `extractAtCompletionToken`
 * enforces, and it is the whole reason `foo@bar` and an email address are not
 * mentions. `src/harness/atMentions.ts` builds its attachments from these, and
 * `extractAtMentions` below builds the renderer's chips — one pattern, two readers.
 */
export function atMentionPatterns(): { quoted: RegExp; regular: RegExp } {
  return {
    quoted: /(^|\s)@"([^"]+)"((?:#L\d+(?:-\d+)?)?)(?:#[^\s]*)?/g,
    regular: /(^|\s)@([^\s"]+)/g,
  }
}

/** Where a mention sits in the text, and what it names. */
export interface AtMentionSpan {
  /** Index of the `@`. */
  readonly start: number
  /** One past the last character of the mention. */
  readonly end: number
  /** The exact source substring, `@` and quotes included. */
  readonly text: string
  /** The path (plus any `#L…` suffix), unquoted — what the host resolves and what a chip shows. */
  readonly mention: string
}

/**
 * Every mention in a settled string, in the order it is read.
 *
 * `extractAtMentionedFiles` in `harness/` answers a different question — which
 * *files* to attach, deduplicated and capped — and discards positions on the way.
 * A view needs the positions, because it renders the text around them.
 *
 * Sorted by position, not by pattern: the quoted pass finds its matches first, so a
 * bare mention earlier in the sentence would otherwise be reported second and the
 * text would be reassembled out of order. Overlaps are dropped for the same reason;
 * today's two patterns cannot produce one (neither can match inside the other), but
 * a third would, and the failure mode is duplicated text rather than an error.
 */
export function extractAtMentions(input: string): AtMentionSpan[] {
  const { quoted, regular } = atMentionPatterns()
  const found: AtMentionSpan[] = []

  for (const pattern of [quoted, regular]) {
    for (const match of input.matchAll(pattern)) {
      const lead = match[1] ?? ''
      const start = (match.index ?? 0) + lead.length
      const text = match[0].slice(lead.length)
      const mention = pattern === quoted ? `${match[2] ?? ''}${match[3] ?? ''}` : match[2] ?? ''
      if (mention) found.push({ start, end: start + text.length, text, mention })
    }
  }

  found.sort((left, right) => left.start - right.start)
  const spans: AtMentionSpan[] = []
  for (const span of found) {
    const previous = spans[spans.length - 1]
    if (previous && span.start < previous.end) continue
    spans.push(span)
  }
  return spans
}

/**
 * The text after accepting a suggestion, plus where the caret goes.
 *
 * A directory gets no trailing space: accepting `@src/` is a step *into* it, and
 * the next keystroke should keep completing. A file gets one, because it is done.
 */
export function applyFileSuggestion(
  input: string,
  cursorPos: number,
  suggestion: FileSuggestion,
): { text: string; cursorPos: number } {
  const token = extractAtCompletionToken(input, cursorPos)
  if (!token) return { text: input, cursorPos }

  return insertSuggestion(input, token.startPos, cursorPos, suggestion.metadata.replacementText, suggestion.metadata.kind !== 'directory')
}
