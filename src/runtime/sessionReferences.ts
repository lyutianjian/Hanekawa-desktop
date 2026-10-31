import { createHash } from 'node:crypto'
import path from 'node:path'
import Fuse from 'fuse.js'
import { isGlobalWorkspaceRoot, normalizeCaseForComparison, userHome } from '../utils/paths.js'
import { splitAttachedPaths } from '../media/attachedPaths.js'
import { findSessionSource, peekSessionIndex, readSessionRecords, scanSessionContent, type ContentScanState } from '../sessions/readonlyReader.js'
import { parseSessionReference, sessionReferenceUri } from './sessionReferenceText.js'
import type { SessionRecord } from '../harness/types.js'
import type {
  SessionReferenceHost, SessionReferenceInfo, SessionSearchInput, SessionSearchHit,
  SessionSearchResult, SessionReadItem, SessionReadResult,
} from './protocol/sessionReferences.js'

export interface SessionReferenceHostOptions {
  cwd: string
  listProjectRoots?: () => Promise<readonly string[]>
  redact?: (text: string) => string
  getLiveState?: (sessionId: string) => 'running' | 'idle' | 'unknown'
  scanBudgetBytes?: number
}

interface ReadCursor {
  kind: 'read'
  sessionId: string
  direction: 'earlier' | 'later'
  includeTools: boolean
  messageId: string
  textOffset: number
  windowStart?: string
  windowEnd?: string
}
interface SearchCursor {
  kind: 'search'
  signature: string
  sessionId: string
  offset: number
  state?: ContentScanState
}

function encodeCursor(value: ReadCursor | SearchCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}
function decodeCursor(cursor: string): ReadCursor | SearchCursor {
  try {
    if (cursor.length > 16384) throw new Error()
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as ReadCursor | SearchCursor
    if (!parsed || !parseSessionReference(parsed.sessionId)) throw new Error()
    return parsed
  } catch { throw new Error('会话游标无效，请重新开始读取或搜索') }
}

function cleanVisibleText(text: string): string {
  return splitAttachedPaths(text).text.replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+/gi, '[图片数据已省略]')
}

function projectRecord(record: SessionRecord, includeTools: boolean): SessionReadItem | undefined {
  if (record.type === 'message' && (record.role === 'user' || record.role === 'assistant')) {
    const content = cleanVisibleText(record.displayContent ?? record.content)
      + (record.images?.length ? '\n[此消息含图片；未读取像素]' : '')
    return { messageId: record.id, role: record.role, createdAt: record.createdAt, content }
  }
  if (record.type === 'compact_boundary') {
    return {
      messageId: record.id, role: 'summary', createdAt: record.createdAt,
      content: `[历史压缩摘要；摘要不代表被省略的完整原文]\n${cleanVisibleText(record.summary)}`,
    }
  }
  if (includeTools && record.type === 'tool_use') {
    return { messageId: record.id, role: 'tool', createdAt: record.createdAt, tool: record.tool,
      toolUseId: record.id, kind: 'tool_use', content: safeToolInput(record.input) }
  }
  if (includeTools && record.type === 'tool_result') {
    return { messageId: record.id, role: 'tool', createdAt: record.createdAt, tool: record.tool,
      toolUseId: record.toolUseId, kind: 'tool_result', ok: record.ok, content: cleanVisibleText(record.content) }
  }
  return undefined
}

function safeToolInput(input: unknown): string {
  return JSON.stringify(input, (key, value: unknown) => {
    if (/^(?:thinking|reasoning|signature|responseItems|reasoningDetails|apiResultBlock|images|imageData|base64|localPath|transcriptPath)$/i.test(key)) return undefined
    return value
  }) ?? ''
}

function searchSignature(input: SessionSearchInput, currentId?: string): string {
  return createHash('sha256').update(JSON.stringify([
    input.query, input.scope ?? 'title', input.projectRoot ?? '', input.updatedAfter ?? '', input.updatedBefore ?? '', currentId ?? '',
  ])).digest('hex').slice(0, 24)
}

export function createSessionReferenceHost(options: SessionReferenceHostOptions): SessionReferenceHost {
  const redact = options.redact ?? ((text: string) => text)
  const scanBudget = Math.max(4, options.scanBudgetBytes ?? 64 * 1024 * 1024)
  const allSessions = async (signal?: AbortSignal): Promise<SessionReferenceInfo[]> => {
    signal?.throwIfAborted()
    const roots = [options.cwd, userHome(), ...await options.listProjectRoots?.() ?? []]
    const unique = [...new Map(roots.map((root) => [normalizeCaseForComparison(path.resolve(root)), path.resolve(root)])).values()]
    const indexes = await Promise.all(unique.map(async (root) => {
      signal?.throwIfAborted()
      return (await peekSessionIndex(root)).flatMap((meta): SessionReferenceInfo[] => {
        const sessionId = parseSessionReference(meta.id)
        if (!sessionId) return []
        const projectIsGlobal = isGlobalWorkspaceRoot(root)
        return [{
          sessionId, title: redact(meta.title || '未命名会话'), uri: sessionReferenceUri(sessionId), projectRoot: root,
          projectName: projectIsGlobal ? '最近' : path.basename(root), projectIsGlobal,
          updatedAt: meta.updatedAt, state: options.getLiveState?.(sessionId) ?? 'unknown',
        }]
      })
    }))
    signal?.throwIfAborted()
    return [...new Map(indexes.flat().map((row) => [row.sessionId, row])).values()]
      .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))
  }
  const resolve = async (ref: string, signal?: AbortSignal): Promise<SessionReferenceInfo> => {
    const id = parseSessionReference(ref)
    if (!id) throw new Error('无效的会话引用：需要完整 UUID 或 hanekawa://session/<UUID>')
    const result = (await allSessions(signal)).find((row) => row.sessionId === id)
    if (!result) throw new Error('在已知项目中找不到此会话，可能已删除或项目未登记')
    return result
  }

  const search: SessionReferenceHost['search'] = async (input, context) => {
    const { signal, sessionId: currentId } = context ?? {}
    signal?.throwIfAborted()
    if (input.query.length > 1024) throw new Error('会话搜索关键词最多 1024 个字符，请缩短关键词后重新搜索')
    const scope = input.scope ?? 'title'
    if (scope !== 'title' && !input.query.trim()) throw new Error('正文搜索需要非空关键词')
    const limit = Math.max(1, Math.min(20, input.limit ?? 10))
    const all = await allSessions(signal)
    if (input.projectRoot && !all.some((row) => row.projectRoot === input.projectRoot)
      && ![options.cwd, userHome(), ...await options.listProjectRoots?.() ?? []].includes(input.projectRoot)) {
      throw new Error('项目不在已知项目范围内')
    }
    const rows = all.filter((row) => row.sessionId !== currentId
      && (!input.projectRoot || row.projectRoot === input.projectRoot)
      && (!input.updatedAfter || Date.parse(row.updatedAt) >= Date.parse(input.updatedAfter))
      && (!input.updatedBefore || Date.parse(row.updatedAt) < Date.parse(input.updatedBefore)))
    const signature = searchSignature(input, currentId)
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
    if (cursor && (cursor.kind !== 'search' || cursor.signature !== signature
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0)) throw new Error('搜索条件已改变或游标无效，请重新搜索')
    let start = cursor ? rows.findIndex((row) => row.sessionId === cursor.sessionId) : 0
    if (start < 0) throw new Error('搜索游标来源已消失，请重新搜索')
    const titleMatches = input.query.trim()
      ? new Fuse(rows, { keys: ['title'], includeScore: true, threshold: 0.35 }).search(input.query).map((match) => ({ row: match.item, score: match.score ?? 0 }))
      : rows.map((row) => ({ row, score: 0 }))
    const titleSet = new Set(titleMatches.map((match) => match.row.sessionId))
    if (scope === 'title') {
      const ranked = titleMatches.sort((a, b) => {
        const rank = (title: string): number => title.toLocaleLowerCase() === input.query.toLocaleLowerCase() ? 0
          : title.toLocaleLowerCase().startsWith(input.query.toLocaleLowerCase()) ? 1 : 2
        return rank(a.row.title) - rank(b.row.title) || a.score - b.score
          || Number(b.row.projectRoot === options.cwd) - Number(a.row.projectRoot === options.cwd)
          || (Date.parse(b.row.updatedAt) || 0) - (Date.parse(a.row.updatedAt) || 0)
      }).map(({ row }) => row)
      start = cursor ? ranked.findIndex((row) => row.sessionId === cursor.sessionId) : 0
      if (start < 0) throw new Error('搜索游标已失效，请重新搜索')
      const results = ranked.slice(start, start + limit).map((row): SessionSearchHit => ({ ...row, matchedIn: ['title'], snippets: [] }))
      const next = ranked[start + limit]
      return { schemaVersion: 1, results, complete: !next,
        ...(next ? { nextCursor: encodeCursor({ kind: 'search', signature, sessionId: next.sessionId, offset: 0 }) } : {}),
        coverage: { sessionsScanned: results.length, bytesScanned: 0, totalSessions: rows.length } }
    }
    const results: SessionSearchHit[] = []
    let bytesScanned = 0
    let sessionsScanned = 0
    let nextCursor: string | undefined
    for (let i = start; i < rows.length; i++) {
      signal?.throwIfAborted()
      const row = rows[i]!
      const hits: SessionSearchHit['snippets'] = []
      const matchedIn: SessionSearchHit['matchedIn'] = []
      if (scope === 'all' && titleSet.has(row.sessionId) && (!cursor || cursor.offset === 0 || i !== start)) matchedIn.push('title')
      const source = await findSessionSource(row.projectRoot, row.sessionId)
      const partial = i === start && cursor?.kind === 'search' ? cursor : undefined
      if (partial && partial.offset > source.size) throw new Error('搜索来源已改变，请重新搜索')
      const scanned = await scanSessionContent(source, {
        query: input.query, offset: partial?.offset ?? 0, state: partial?.state,
        budget: Math.max(4, scanBudget - bytesScanned), signal,
      })
      bytesScanned += scanned.bytesScanned
      for (const hit of scanned.snippets) {
        const visible = redact(cleanVisibleText(hit.text))
        // Search the already-redacted snippet again: a configured secret is
        // never exposed merely because it was used as the search phrase.
        if (visible.toLocaleLowerCase().includes(input.query.toLocaleLowerCase())) hits.push({ ...hit, text: visible })
      }
      if (hits.length) matchedIn.push('content')
      const finished = scanned.complete
      if (!finished) {
        const state = scanned.state && Object.fromEntries(Object.entries(scanned.state)
          .map(([key, value]) => [key, typeof value === 'string' ? redact(value) : value])) as ContentScanState | undefined
        nextCursor = encodeCursor({ kind: 'search', signature, sessionId: row.sessionId, offset: scanned.offset, state })
      }
      sessionsScanned++
      if (matchedIn.length) results.push({ ...row, matchedIn, snippets: hits })
      if (!finished) break
      if ((results.length >= limit || scanBudget - bytesScanned < 4) && rows[i + 1]) {
        nextCursor = encodeCursor({ kind: 'search', signature, sessionId: rows[i + 1]!.sessionId, offset: 0 })
        break
      }
    }
    const result: SessionSearchResult = { schemaVersion: 1, results, complete: !nextCursor,
      ...(nextCursor ? { nextCursor } : {}), coverage: { sessionsScanned, bytesScanned, totalSessions: rows.length } }
    return result
  }

  const read: SessionReferenceHost['read'] = async (input, context) => {
    const signal = context?.signal
    signal?.throwIfAborted()
    if ((input.cursor && (input.from || input.anchorMessageId)) || (input.from && input.anchorMessageId)) {
      throw new Error('cursor、from 与 anchorMessageId 不能同时指定')
    }
    const session = await resolve(input.ref, signal)
    const includeTools = input.includeTools ?? false
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined
    if (cursor && (cursor.kind !== 'read' || cursor.sessionId !== session.sessionId
      || cursor.includeTools !== includeTools || !['earlier', 'later'].includes(cursor.direction)
      || !Number.isSafeInteger(cursor.textOffset) || cursor.textOffset < 0)) throw new Error('读取游标无效或 includeTools 已改变，请重新读取')
    const direction = cursor?.kind === 'read' ? cursor.direction : input.from === 'start' || input.anchorMessageId ? 'later' : 'earlier'
    const limit = Math.max(1, Math.min(50, input.limit ?? 20))
    const source = await findSessionSource(session.projectRoot, session.sessionId)
    const diagnostics: string[] = []
    // The first pass retains only descriptors. Even a very long conversation
    // keeps no historical message bodies alive while choosing a page.
    const descriptors: Array<{ messageId: string; length: number }> = []
    for await (const entry of readSessionRecords(source, { signal })) {
      if (entry.diagnostic) { if (diagnostics.length < 20) diagnostics.push(entry.diagnostic); continue }
      const item = entry.record && projectRecord(entry.record, includeTools)
      if (item) descriptors.push({ messageId: item.messageId, length: redact(item.content).length })
    }
    const findIndex = (id: string): number => {
      const found = descriptors.findIndex((item) => item.messageId === id)
      if (found < 0) throw new Error('读取游标对应记录已改变或被 rewind 删除，请重新读取')
      return found
    }
    let index = 0
    let end = descriptors.length
    let textOffset = 0
    let pageStart = 0
    if (cursor?.kind === 'read') {
      const at = findIndex(cursor.messageId)
      if (cursor.textOffset > descriptors[at]!.length) throw new Error('读取游标对应文本已改变，请重新读取')
      if (direction === 'earlier' && !cursor.windowStart) {
        end = at
        index = Math.max(0, end - limit)
      } else {
        index = at
        textOffset = cursor.textOffset
        if (cursor.windowStart) pageStart = findIndex(cursor.windowStart)
        if (cursor.windowEnd) end = findIndex(cursor.windowEnd)
      }
    } else if (input.anchorMessageId) {
      index = Math.max(0, findIndex(input.anchorMessageId) - Math.floor(limit / 3))
    } else if (direction === 'earlier') index = Math.max(0, end - limit)
    if (!(cursor?.kind === 'read' && cursor.windowStart)) pageStart = index
    if (index >= end && descriptors.length) throw new Error('读取游标范围已失效，请重新读取')
    const items: SessionReadItem[] = []
    let chars = 0
    let truncated = false
    let continuation: ReadCursor | undefined
    let descriptorIndex = 0
    for await (const entry of readSessionRecords(source, { signal })) {
      const projected = entry.record && projectRecord(entry.record, includeTools)
      if (!projected) continue
      const position = descriptorIndex++
      if (position < index) continue
      if (position >= end || items.length >= limit || chars >= 24_000) break
      const item = { ...projected, content: redact(projected.content) }
      const remaining = item.content.slice(textOffset)
      const content = remaining.slice(0, 24_000 - chars)
      items.push({ ...item, content, ...(textOffset ? { textOffset } : {}) })
      chars += content.length
      if (content.length < remaining.length) {
        truncated = true
        continuation = { kind: 'read', sessionId: session.sessionId, direction, includeTools,
          messageId: item.messageId, textOffset: textOffset + content.length,
          ...(direction === 'earlier' ? { windowStart: descriptors[pageStart]!.messageId,
            windowEnd: descriptors[end]?.messageId } : {}) }
        break
      }
      textOffset = 0
      index++
    }
    if (!continuation) {
      if (index < end) {
        continuation = { kind: 'read', sessionId: session.sessionId, direction, includeTools,
          messageId: descriptors[index]!.messageId, textOffset: 0,
          ...(direction === 'earlier' ? { windowStart: descriptors[pageStart]!.messageId,
            windowEnd: descriptors[end]?.messageId } : {}) }
      } else if (direction === 'earlier' && pageStart > 0) {
        continuation = { kind: 'read', sessionId: session.sessionId, direction, includeTools,
          messageId: descriptors[pageStart]!.messageId, textOffset: 0 }
      }
    }
    return {
      schemaVersion: 1, session,
      page: { direction, firstMessageId: items[0]?.messageId, lastMessageId: items.at(-1)?.messageId,
        ...(continuation ? { nextCursor: encodeCursor(continuation) } : {}), hasMore: !!continuation, truncated },
      items, diagnostics,
    } satisfies SessionReadResult
  }
  return { search, read, resolve }
}
