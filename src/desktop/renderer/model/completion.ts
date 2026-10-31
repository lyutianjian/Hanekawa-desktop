import {
  applyCommandSuggestion,
  generateCommandSuggestions,
  hasCommandArgs,
  isCommandInput,
  type CommandSuggestion,
} from '../../../runtime/suggestions/commandSuggestions.js'
import {
  applyFileSuggestion,
  extractAtCompletionToken,
  type FileSuggestion,
} from '../../../runtime/suggestions/atToken.js'
import { mentionPresentation, type MentionPresentation } from './mentionPresentation.js'
import type { WireCommandInfo } from '../../../runtime/protocol/wire.js'

/**
 * The completion dropdown, over two sources that behave differently.
 *
 * Slash commands are answered synchronously from a list the client already
 * holds. File mentions are not: `generateFileSuggestions` reads the filesystem
 * and cannot cross into the bundle, so every keystroke inside an `@…` token is
 * an IPC round trip. Nothing orders those answers — a request for `@src/d` can
 * settle after the request for `@src/de` that followed it — so the state carries
 * a monotonic `seq` and `applyFileResponse` drops anything that is not the
 * answer to the newest request.
 *
 * That guard lives here rather than in `app.ts` for the usual reason: a `model/`
 * module is compiled in the base tsconfig program, which has no DOM lib, so a
 * decision is only testable if it is DOM-free. `test/rendererCompletion.test.ts`
 * drives it with responses delivered deliberately out of order.
 *
 * The two sources are also *keyboard*-different — see `acceptOnly` below.
 */

export type CompletionKind = 'none' | 'command' | 'file'

export type CompletionState =
  | { readonly kind: 'none'; readonly seq: number }
  | {
      readonly kind: 'command'
      readonly items: readonly CommandSuggestion<WireCommandInfo>[]
      readonly selectedIndex: number
      readonly seq: number
    }
  | {
      readonly kind: 'file'
      readonly items: readonly FileSuggestion[]
      readonly selectedIndex: number
      readonly seq: number
    }

export const NO_COMPLETIONS: CompletionState = { kind: 'none', seq: 0 }

/** What the dropdown draws. Both suggestion shapes extend `SuggestionItem`. */
export interface CompletionRow {
  readonly displayText: string
  readonly description?: string
  readonly mention?: MentionPresentation
}

export function completionRows(state: CompletionState): readonly CompletionRow[] {
  if (state.kind === 'none') return []
  return state.kind === 'file' ? state.items.map((item) => ({ ...item, mention: mentionPresentation(item) })) : state.items
}

export function isOpen(state: CompletionState): boolean {
  return state.kind !== 'none' && state.items.length > 0
}

/**
 * Whether Enter should accept *without* submitting.
 *
 * A command suggestion is a whole line, so Enter accepts and runs it, matching
 * `useKeyboardShortcuts.ts:286-291`. A file suggestion is a fragment of a
 * sentence still being written — submitting there would send half a prompt.
 */
export function acceptOnly(state: CompletionState): boolean {
  return state.kind === 'file'
}

/**
 * Every transition bumps the sequence, including this one.
 *
 * Typing `/` while a file request is in flight has to invalidate that request:
 * otherwise its answer lands on top of the command list a moment later.
 */
function next(state: CompletionState): number {
  return state.seq + 1
}

/**
 * Command completions for the current composer text.
 *
 * Suppressed once arguments have been typed (`hasCommandArgs`), matching the
 * terminal: `/model sonnet` is a command being written, not a name being looked up.
 */
export function commandCompletions(
  previous: CompletionState,
  raw: string,
  commands: readonly WireCommandInfo[],
): CompletionState {
  const seq = next(previous)
  const text = raw.trimStart()
  if (!isCommandInput(text) || hasCommandArgs(text)) return { kind: 'none', seq }
  const items = generateCommandSuggestions(text, [...commands])
  return items.length === 0 ? { kind: 'none', seq } : { kind: 'command', items, selectedIndex: 0, seq }
}

/**
 * The `@…` token under the caret, or undefined when there is none.
 *
 * The host is asked with the *whole* composer text and the caret rather than
 * with the token: `generateFileSuggestions` re-derives the token itself, and
 * sending the two halves separately would give two places for them to disagree.
 */
export function fileCompletionQuery(
  raw: string,
  cursorPos: number,
): { input: string; cursorPos: number } | undefined {
  return extractAtCompletionToken(raw, cursorPos) ? { input: raw, cursorPos } : undefined
}

/**
 * Records that a file request has gone out and hands back the seq to echo.
 *
 * The old rows stay on screen until the answer arrives — clearing them here
 * would make the dropdown blink on every keystroke.
 */
export function beginFileRequest(previous: CompletionState): { state: CompletionState; seq: number } {
  const seq = next(previous)
  return { state: { ...previous, seq }, seq }
}

/**
 * Folds a host answer in, unless it has been overtaken.
 *
 * The equality is deliberate rather than `>=`: any newer transition — another
 * `@` keystroke, a switch to command completions, a close — has already bumped
 * the sequence, and every one of those means this answer is describing text the
 * user is no longer looking at.
 */
export function applyFileResponse(
  previous: CompletionState,
  seq: number,
  suggestions: readonly FileSuggestion[],
): CompletionState {
  if (seq !== previous.seq) return previous
  if (suggestions.length === 0) return { kind: 'none', seq }
  return { kind: 'file', items: suggestions, selectedIndex: 0, seq }
}

export function closeCompletions(previous: CompletionState): CompletionState {
  return { kind: 'none', seq: next(previous) }
}

/** Wraps, because a dropdown of five is a ring rather than a list with ends. */
export function moveCompletion(state: CompletionState, direction: 'up' | 'down'): CompletionState {
  if (state.kind === 'none') return state
  const total = state.items.length
  if (total === 0) return state
  const step = direction === 'up' ? -1 : 1
  const selectedIndex = ((state.selectedIndex + step) % total + total) % total
  // Not a new request, so the sequence does not move: an in-flight answer for
  // the text still in the composer is still the answer the user wants.
  return { ...state, selectedIndex }
}

/**
 * Focuses a row by index — a click, where `moveCompletion` is an arrow key.
 *
 * Clamped rather than wrapped: an index out of range is a stale row, not a step
 * off the end of a ring. The sequence does not move, for the same reason it does
 * not in `moveCompletion`.
 */
export function selectCompletion(state: CompletionState, index: number): CompletionState {
  if (state.kind === 'none') return state
  const total = state.items.length
  if (total === 0) return state
  const selectedIndex = index < 0 ? 0 : index > total - 1 ? total - 1 : index
  return { ...state, selectedIndex }
}

/**
 * The composer text after accepting the selected row, plus where the caret goes.
 *
 * A command replaces the whole line; a file mention splices over just its `@…`
 * token, which is why this needs the text and caret the command path ignores.
 */
export function acceptCompletion(
  state: CompletionState,
  text: string,
  cursorPos: number,
): { text: string; cursorPos: number } | undefined {
  if (state.kind === 'none') return undefined
  if (state.kind === 'command') {
    const suggestion = state.items[state.selectedIndex]
    return suggestion ? applyCommandSuggestion(suggestion) : undefined
  }
  const suggestion = state.items[state.selectedIndex]
  return suggestion ? applyFileSuggestion(text, cursorPos, suggestion) : undefined
}

/** Both sources keep places; a slow title response cannot delay file rows. */
export function mergeMentionSuggestions(files: readonly FileSuggestion[], sessions: readonly FileSuggestion[], limit = 15): FileSuggestion[] {
  if (files.length === 0) return sessions.slice(0, limit)
  if (sessions.length === 0) return files.slice(0, limit)
  const reserved = Math.min(5, Math.floor(limit / 2))
  const initial = [...sessions.slice(0, reserved), ...files.slice(0, reserved)]
  return [...initial, ...sessions.slice(reserved), ...files.slice(reserved)].slice(0, limit)
}
