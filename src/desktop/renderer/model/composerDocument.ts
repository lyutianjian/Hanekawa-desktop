import { parseSessionReferences } from '../../../runtime/sessionReferenceText.js'

export type ComposerFragment =
  | { kind: 'text'; text: string }
  | { kind: 'session-reference'; text: string; title: string; uri: string; sessionId: string }

export function parseComposerDocument(text: string): ComposerFragment[] {
  const fragments: ComposerFragment[] = []
  let offset = 0
  for (const span of parseSessionReferences(text)) {
    if (span.start > offset) fragments.push({ kind: 'text', text: text.slice(offset, span.start) })
    fragments.push({ kind: 'session-reference', text: span.text, title: span.title, uri: span.uri, sessionId: span.sessionId })
    offset = span.end
  }
  if (offset < text.length) fragments.push({ kind: 'text', text: text.slice(offset) })
  return fragments
}

export function serializeComposerDocument(fragments: readonly ComposerFragment[]): string {
  return fragments.map((fragment) => fragment.text).join('')
}

/** A serialized URI is one caret stop, even though its visible title is shorter. */
export function composerAtomicOffset(text: string, offset: number, direction: 'before' | 'after'): number {
  const span = parseSessionReferences(text).find((entry) => entry.start < offset && offset < entry.end)
  return span ? direction === 'before' ? span.start : span.end : Math.max(0, Math.min(text.length, offset))
}
