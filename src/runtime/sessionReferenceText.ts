import type { SessionReference } from './protocol/sessionReferences.js'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const ID_PATTERN = new RegExp(`^${UUID}$`, 'i')
const URI_PATTERN = new RegExp(`^hanekawa://session/(${UUID})$`, 'i')

export function parseSessionReference(value: string): string | undefined {
  if (ID_PATTERN.test(value)) return value.toLowerCase()
  return URI_PATTERN.exec(value)?.[1]?.toLowerCase()
}

export function sessionReferenceUri(sessionId: string): string {
  const id = parseSessionReference(sessionId)
  if (!id) throw new Error('无效的会话 ID')
  return `hanekawa://session/${id}`
}

export function sessionReferenceMarkdown(reference: Pick<SessionReference, 'sessionId' | 'title'>): string {
  const title = reference.title.replace(/\\/g, '\\\\').replace(/[\[\]]/g, '\\$&').replace(/\r?\n/g, ' ')
  return `[${title}](${sessionReferenceUri(reference.sessionId)})`
}

export interface SessionReferenceSpan extends SessionReference {
  start: number
  end: number
  text: string
}

/** Both the clipboard's bare URI and the canonical Markdown are understood. */
export function parseSessionReferences(text: string): SessionReferenceSpan[] {
  const pattern = new RegExp(`\\[((?:\\\\.|[^\\]\\\\\\n])*)\\]\\((hanekawa://session/${UUID})\\)|hanekawa://session/${UUID}`, 'gi')
  const result: SessionReferenceSpan[] = []
  for (const match of text.matchAll(pattern)) {
    const start = match.index!
    const end = start + match[0].length
    // A prefix of an invalid URI is never a reference.
    if (!match[2] && /[a-z0-9/?#%_@:+\\-]/i.test(text[end] ?? '')) continue
    const uri = match[2] ?? match[0]
    const sessionId = parseSessionReference(uri)
    if (!sessionId) continue
    const title = match[1]?.replace(/\\([\\\[\]])/g, '$1') ?? sessionId
    result.push({ sessionId, uri: sessionReferenceUri(sessionId), title, start, end, text: match[0] })
  }
  return result
}
