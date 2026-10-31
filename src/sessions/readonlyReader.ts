import { createReadStream } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { getHanekawaDir, getSessionsDir } from '../utils/paths.js'
import { parseJsonLinesWithDiagnostics, readJsonFile } from '../utils/json.js'
import type { SessionRecord } from '../harness/types.js'
import { parseSessionReference } from '../runtime/sessionReferenceText.js'

export interface ReadonlySessionIndexEntry {
  id: string
  updatedAt: string
  title?: string
  messageCount: number
  lastTurnFailed?: boolean
  coordination?: { role: 'coordinator' | 'thread' }
}

export async function readSessionIndex(root: string): Promise<{ sessions?: unknown }> {
  const current = join(getSessionsDir(root), 'index.json')
  try {
    await access(current)
    return await readJsonFile(current, {})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return readJsonFile(join(getHanekawaDir(root), 'sessions', 'index.json'), {})
  }
}

export async function peekSessionIndex(root: string): Promise<ReadonlySessionIndexEntry[]> {
  const index = await readSessionIndex(root)
  if (!Array.isArray(index.sessions)) return []
  return index.sessions.flatMap((entry: unknown): ReadonlySessionIndexEntry[] => {
    if (!entry || typeof entry !== 'object') return []
    const row = entry as Record<string, unknown>
    if (typeof row.id !== 'string' || typeof row.updatedAt !== 'string') return []
    const result: ReadonlySessionIndexEntry = {
      id: row.id, updatedAt: row.updatedAt,
      messageCount: typeof row.messageCount === 'number' ? row.messageCount : 0,
    }
    if (typeof row.title === 'string' && row.title) result.title = row.title
    if (row.lastTurnFailed === true) result.lastTurnFailed = true
    const role = (row.coordination as { role?: unknown } | undefined)?.role
    if (role === 'coordinator' || role === 'thread') result.coordination = { role }
    return [result]
  }).sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
}

export interface ReadonlySessionSource {
  path: string
  format: 'jsonl' | 'json'
  size: number
}

export async function findSessionSource(root: string, sessionId: string): Promise<ReadonlySessionSource> {
  if (!parseSessionReference(sessionId)) throw new Error('无效的会话 ID')
  for (const dir of [getSessionsDir(root), join(getHanekawaDir(root), 'sessions')]) {
    for (const format of ['jsonl', 'json'] as const) {
      const file = join(dir, `${sessionId}.${format}`)
      try {
        const info = await stat(file)
        if (info.isFile()) return { path: file, format, size: info.size }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  throw new Error('会话记录不存在，可能已删除')
}

export interface ReadonlyRecord {
  record?: SessionRecord
  start: number
  end: number
  diagnostic?: string
}

function isReadableRecord(value: unknown): value is SessionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  if (typeof record.type !== 'string' || typeof record.id !== 'string') return false
  if (record.type === 'message') return typeof record.content === 'string'
    && (record.displayContent === undefined || typeof record.displayContent === 'string')
    && typeof record.role === 'string' && typeof record.createdAt === 'string'
  if (record.type === 'compact_boundary') return typeof record.summary === 'string'
  if (record.type === 'tool_result') return typeof record.content === 'string' && typeof record.tool === 'string' && typeof record.toolUseId === 'string'
  if (record.type === 'tool_use') return typeof record.tool === 'string'
  return true
}

/** Does not initialize a store, recover indexes, migrate data, or acquire locks. */
export async function* readSessionRecords(
  source: ReadonlySessionSource,
  options: { offset?: number; signal?: AbortSignal } = {},
): AsyncGenerator<ReadonlyRecord> {
  options.signal?.throwIfAborted()
  if (source.format === 'json') {
    const raw = JSON.parse(await readFile(source.path, { encoding: 'utf8', signal: options.signal })) as { records?: unknown[] }
    if (!Array.isArray(raw.records)) throw new Error('旧版会话记录损坏')
    for (const [index, value] of raw.records.entries()) {
      options.signal?.throwIfAborted()
      if (index < (options.offset ?? 0)) continue
      if (isReadableRecord(value)) yield { record: value, start: index, end: index + 1 }
      else yield { start: index, end: index + 1, diagnostic: `旧版会话第 ${index + 1} 条记录损坏` }
    }
    return
  }
  const stream = createReadStream(source.path, { start: options.offset ?? 0, signal: options.signal })
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  let offset = options.offset ?? 0
  try {
    for await (const line of lines) {
      options.signal?.throwIfAborted()
      const start = offset
      // JSONL writers always append LF. A final unterminated row is pending,
      // even when its prefix already happens to be syntactically valid JSON.
      offset += Buffer.byteLength(line) + 1
      if (offset > source.size) {
        yield { start, end: source.size, diagnostic: '末尾记录尚未写完，未读取该记录' }
        break
      }
      if (!line.trim()) continue
      const parsed = parseJsonLinesWithDiagnostics<SessionRecord>(line)
      const record = parsed.records[0]
      if (!isReadableRecord(record)) {
        yield { start, end: offset, diagnostic: `会话记录损坏（字节 ${start}）` }
      } else yield { record, start, end: offset }
    }
  } finally {
    lines.close()
    stream.destroy()
  }
}

/** Serializable lexer state lets a budget end inside even a very large tool row. */
export interface ContentScanState {
  depth: number
  recordsDepth?: number
  inString: boolean
  escaped: boolean
  unicode?: string
  expectKey: boolean
  key: string
  token: string
  mode: 'key' | 'field' | 'content' | 'other'
  type?: string
  role?: string
  id?: string
  hasDisplay?: boolean
  tail: string
  capture?: string
  after: number
  contentSnippet?: string
  displaySnippet?: string
}

function freshScanState(): ContentScanState {
  return { depth: 0, inString: false, escaped: false, expectKey: false,
    key: '', token: '', mode: 'other', tail: '', after: 0 }
}

export async function scanSessionContent(
  source: ReadonlySessionSource,
  options: { query: string; offset?: number; state?: ContentScanState; budget: number; signal?: AbortSignal },
): Promise<{ snippets: Array<{ messageId: string; text: string }>; offset: number; state?: ContentScanState; complete: boolean; bytesScanned: number }> {
  const start = options.offset ?? 0
  const { open } = await import('node:fs/promises')
  const file = await open(source.path, 'r')
  const snippets: Array<{ messageId: string; text: string }> = []
  let state = options.state ?? freshScanState()
  let offset = start
  const query = options.query.toLocaleLowerCase()
  const consume = (char: string): void => {
    if (state.mode === 'key' || state.mode === 'field') {
      if (state.token.length < 256) state.token += char
    } else if (state.mode === 'content') {
      if (state.capture !== undefined) {
        if (state.after > 0) { state.capture += char; state.after-- }
      } else {
        state.tail = (state.tail + char).slice(-(query.length + 70))
        if (state.tail.toLocaleLowerCase().includes(query)) {
          state.capture = state.tail
          state.tail = ''
          state.after = 100
        }
      }
    }
  }
  try {
    while (offset < source.size && offset - start < options.budget) {
      options.signal?.throwIfAborted()
      const size = Math.min(64 * 1024, options.budget - (offset - start), source.size - offset)
      if (size <= 0) break
      const buffer = Buffer.allocUnsafe(size)
      const { bytesRead } = await file.read(buffer, 0, size, offset)
      if (!bytesRead) break
      let end = bytesRead
      // Resume at a complete UTF-8 boundary without overshooting the budget.
      if (offset + end < source.size) {
        let lead = end - 1
        while (lead >= 0 && (buffer[lead]! & 0xc0) === 0x80) lead--
        if (lead >= 0) {
          const byte = buffer[lead]!
          const length = byte < 0x80 ? 1 : byte < 0xe0 ? 2 : byte < 0xf0 ? 3 : 4
          if (lead + length > end) end = lead
        }
      }
      if (end === 0) break
      for (const char of buffer.subarray(0, end).toString('utf8')) processChar(char)
      offset += end
    }
  } finally { await file.close() }
  return { snippets, offset, ...(offset < source.size ? { state } : {}), complete: offset >= source.size, bytesScanned: offset - start }

  function processChar(char: string): void {
    if (state.inString) {
      if (state.unicode !== undefined) {
        state.unicode += char
        if (state.unicode.length === 4) {
          if (/^[0-9a-f]{4}$/i.test(state.unicode)) consume(String.fromCharCode(parseInt(state.unicode, 16)))
          state.unicode = undefined
        }
      } else if (state.escaped) {
        state.escaped = false
        if (char === 'u') state.unicode = ''
        else consume(({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[char] ?? char)
      } else if (char === '\\') state.escaped = true
      else if (char === '"') {
        state.inString = false
        if (state.mode === 'key') { state.key = state.token; state.expectKey = false }
        else if (state.mode === 'field') {
          if (state.key === 'type') state.type = state.token
          if (state.key === 'role') state.role = state.token
          if (state.key === 'id') state.id = state.token
        } else if (state.mode === 'content') {
          if (state.key === 'displayContent') { state.hasDisplay = true; state.displaySnippet = state.capture }
          else state.contentSnippet = state.capture
        }
        state.mode = 'other'
        state.token = ''; state.tail = ''; state.capture = undefined; state.after = 0
      } else consume(char)
      return
    }
    if (char === '\n' && source.format === 'jsonl') {
      finishRecord()
      state = freshScanState()
    } else if (char === '"') {
      state.inString = true
      state.token = ''; state.tail = ''; state.capture = undefined; state.after = 0
      const atRecord = source.format === 'jsonl' ? state.depth === 1
        : state.recordsDepth !== undefined && state.depth === state.recordsDepth + 1
      state.mode = (atRecord || (source.format === 'json' && state.depth === 1 && state.expectKey))
        ? state.expectKey ? 'key'
          : ['type', 'role', 'id'].includes(state.key) ? 'field'
            : ['content', 'displayContent'].includes(state.key)
              && (!state.type || state.type === 'message') && (!state.role || state.role === 'user' || state.role === 'assistant')
              ? 'content' : 'other'
        : 'other'
    } else if (char === '{' || char === '[') {
      if (source.format === 'json' && char === '[' && state.depth === 1 && state.key === 'records') state.recordsDepth = state.depth + 1
      if (source.format === 'json' && char === '{' && state.depth === state.recordsDepth) {
        state = { ...freshScanState(), depth: state.depth, recordsDepth: state.recordsDepth }
      }
      state.depth++
      if (char === '{' && (state.depth === 1 || (state.recordsDepth !== undefined && state.depth === state.recordsDepth + 1))) state.expectKey = true
    } else if (char === '}' || char === ']') {
      state.depth--
      if (source.format === 'json' && char === '}' && state.depth === state.recordsDepth) {
        finishRecord(true)
        state = { ...freshScanState(), depth: state.depth, recordsDepth: state.recordsDepth }
      }
    } else if (char === ',' && (state.depth === 1 || (state.recordsDepth !== undefined && state.depth === state.recordsDepth + 1))) state.expectKey = true

    function finishRecord(legacy = false): void {
      const text = state.hasDisplay ? state.displaySnippet : state.contentSnippet
      if ((legacy || state.depth === 0) && state.type === 'message' && (state.role === 'user' || state.role === 'assistant') && state.id && text && snippets.length < 2) snippets.push({ messageId: state.id, text })
    }
  }
}
