import { open, stat } from 'node:fs/promises'
import type { ReadFileState, ToolContext, ToolResult } from '../harness/types.js'
import type { Stats } from 'node:fs'
import { decodeTextBuffer, readEditableTextFile, readTextFile, type LineEndings, type TextFileRead } from './textFile.js'
import { resolveSafeTarget, type SafeTarget } from './pathSafety.js'

type FileSignature = Pick<ReadFileState, 'mtimeMs' | 'ctimeMs' | 'size' | 'dev' | 'ino'>

/** Encoding, BOM and line endings travel with the content so a write can restore them. */
export interface TextFileMeta {
  encoding?: BufferEncoding
  bom?: boolean
  lineEndings?: LineEndings
}

const MAX_READ_FILE_STATE_ENTRIES = 100
let lastReadFileTimestamp = 0

export async function captureReadFileState(absolute: string, content: string, meta: TextFileMeta = {}): Promise<ReadFileState> {
  const fileStat = await stat(absolute)
  return captureReadFileStateFromStat(content, fileStat, meta)
}

/**
 * Read a file and capture its stat atomically via a single file handle.
 * This avoids TOCTOU between content read and metadata capture.
 *
 * The returned content is LF-normalized (see `textFile.ts`): every caller that
 * matches a model-supplied string against it would otherwise fail outright on a
 * CRLF file, because the model emits `\n`.
 */
export async function readFileAndRemember(absolute: string, context: ToolContext): Promise<string> {
  const file = await readTextFileWithStat(absolute)
  storeReadFileState(absolute, captureReadFileStateFromStat(file.content, file.fileStat, file), context)
  return file.content
}

/**
 * Marks the files shown whole under a `Contents of <path> (...):` label as read,
 * so editing an instruction file the conversation opened with costs no Read. A
 * file counts only while its text is exactly what was shown: a truncated or
 * since-changed one still has to be read.
 */
export async function rememberShownFiles(shown: string, context: ToolContext): Promise<void> {
  for (const match of shown.matchAll(/^Contents of (.+?) \([^\n]*\):\n\n/gm)) {
    const absolute = match[1]!
    const start = match.index + match[0].length
    const file = await readTextFileWithStat(absolute).catch(() => undefined)
    const text = file?.content.trim()
    if (!file || !text) continue
    const end = start + text.length
    if (shown.slice(start, end) !== text || (end < shown.length && !shown.startsWith('\n\n', end))) continue
    storeReadFileState(absolute, { ...captureReadFileStateFromStat(file.content, file.fileStat, file), shownInContext: true }, context)
  }
}

/** Single-handle read that also returns the stat, for atomic read+metadata capture. */
export async function readTextFileWithStat(absolute: string): Promise<{
  content: string
  encoding: BufferEncoding
  bom: boolean
  lineEndings: LineEndings
  fileStat: Stats
}> {
  const fh = await open(absolute, 'r')
  try {
    const raw = await fh.readFile()
    const fileStat = await fh.stat()
    const decoded = decodeTextBuffer(raw)
    return { ...decoded, fileStat }
  } finally {
    await fh.close()
  }
}

/**
 * Remember file state from pre-read content. Use readFileAndRemember()
 * instead when possible to avoid TOCTOU between read and stat.
 */
export async function rememberReadFile(absolute: string, content: string, context: ToolContext, meta: TextFileMeta = {}): Promise<void> {
  storeReadFileState(absolute, await captureReadFileState(absolute, content, meta), context)
}

function storeReadFileState(absolute: string, state: ReadFileState, context: ToolContext): void {
  context.readFileState ??= new Map()
  evictOldestReadFileStateIfNeeded(context, absolute)
  context.readFiles.add(absolute)
  context.readFileState.set(absolute, state)
}

export function captureReadFileStateFromStat(content: string, fileStat: Stats, meta: TextFileMeta = {}): ReadFileState {
  return {
    content,
    timestamp: nextReadFileTimestamp(),
    ...captureFileSignature(fileStat),
    ...(meta.encoding ? { encoding: meta.encoding, bom: meta.bom === true } : {}),
    ...(meta.lineEndings ? { lineEndings: meta.lineEndings } : {}),
  }
}

/**
 * The encoding and line endings a write-back should use. Falls back to reading
 * the file when there is no remembered state (the read-before-write rule makes
 * that rare, but a state eviction can cause it).
 */
export async function resolveTextFileMeta(absolute: string, context: ToolContext): Promise<Required<TextFileMeta>> {
  const state = context.readFileState?.get(absolute)
  if (state?.encoding && state.lineEndings) {
    return { encoding: state.encoding, bom: state.bom === true, lineEndings: state.lineEndings }
  }
  try {
    const { encoding, bom, lineEndings } = await readTextFile(absolute)
    return { encoding, bom, lineEndings }
  } catch {
    return { encoding: 'utf8', bom: false, lineEndings: 'LF' }
  }
}

function nextReadFileTimestamp(): number {
  const now = Date.now()
  lastReadFileTimestamp = Math.max(now, lastReadFileTimestamp + 1)
  return lastReadFileTimestamp
}

function captureFileSignature(fileStat: Stats): FileSignature {
  return {
    mtimeMs: fileStat.mtimeMs,
    ctimeMs: fileStat.ctimeMs,
    size: fileStat.size,
    dev: fileStat.dev,
    ino: fileStat.ino,
  }
}

function evictOldestReadFileStateIfNeeded(context: ToolContext, incoming: string): void {
  const state = context.readFileState
  if (!state || state.has(incoming) || state.size < MAX_READ_FILE_STATE_ENTRIES) return

  let oldestKey: string | undefined
  let oldestTimestamp = Infinity

  for (const [key, value] of state.entries()) {
    if (value.timestamp < oldestTimestamp) {
      oldestTimestamp = value.timestamp
      oldestKey = key
    }
  }

  if (oldestKey !== undefined) {
    state.delete(oldestKey)
    context.readFiles.delete(oldestKey)
  }
}

function signatureChanged(state: ReadFileState, current: FileSignature): boolean {
  if (state.size !== current.size || state.mtimeMs !== current.mtimeMs) {
    return true
  }
  if (state.ctimeMs !== undefined && current.ctimeMs !== undefined && state.ctimeMs !== current.ctimeMs) {
    return true
  }
  if (state.dev !== undefined && current.dev !== undefined && state.dev !== current.dev) {
    return true
  }
  if (state.ino !== undefined && current.ino !== undefined && state.ino !== current.ino) {
    return true
  }
  return false
}

export async function requireFreshRead(absolute: string, filePath: string, context: ToolContext): Promise<ToolResult | undefined> {
  const wasRead = context.readFiles.has(absolute)
  const state = context.readFileState?.get(absolute)
  if (!wasRead) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file must be read first.`,
      errorCode: 'precondition_failed',
    }
  }
  if (!state) {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: read state is no longer available. Read it again before retrying.`,
      errorCode: 'precondition_failed',
      errorDetails: {
        reason: 'read_state_missing',
      },
    }
  }

  let fileStat
  try {
    fileStat = await stat(absolute)
  } catch {
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file no longer exists. Read it again before retrying.`,
      errorCode: 'not_found',
    }
  }

  const current = captureFileSignature(fileStat)
  if (signatureChanged(state, current)) {
    // A metadata-only change (xattr, chmod, touch) moves ctime/mtime without
    // touching the text; the remembered content is always the whole file.
    const fresh = await readTextFileWithStat(absolute).catch(() => undefined)
    if (fresh?.content === state.content) {
      context.readFileState!.set(absolute, { ...state, ...captureReadFileStateFromStat(fresh.content, fresh.fileStat, fresh) })
      return undefined
    }
    return {
      ok: false,
      content: `Refusing to modify ${filePath}: file changed since it was last read. Read it again before retrying.`,
      errorCode: 'stale_file',
      errorDetails: {
        previous: {
          mtimeMs: state.mtimeMs,
          ctimeMs: state.ctimeMs,
          size: state.size,
          dev: state.dev,
          ino: state.ino,
        },
        current,
      },
    }
  }

  return undefined
}

export function getReadFileContent(absolute: string, context: ToolContext): string | undefined {
  return context.readFileState?.get(absolute)?.content
}

/** String replacements use current disk content; their matching text is the precondition. */
export async function prepareFileEdit(absolute: string, filePath: string, context: ToolContext): Promise<
  { target: SafeTarget; file: TextFileRead; notice: string } | { error: ToolResult }
> {
  const resolved = await resolveSafeTarget(absolute, filePath, { approvedTarget: context.approvedWriteTarget })
  if ('error' in resolved) return resolved
  const { target } = resolved
  if (target.identity.kind !== 'file') {
    return { error: {
      ok: false,
      content: `Cannot edit ${filePath}: ${target.identity.kind === 'missing' ? 'file does not exist' : 'target is not a regular file'}.`,
      errorCode: target.identity.kind === 'missing' ? 'not_found' : 'invalid_input',
    } }
  }
  const file = await readEditableTextFile(target.canonical)
  if (!file) {
    return { error: {
      ok: false,
      content: `Cannot edit ${filePath}: unsupported text encoding or binary content. Edit supports UTF-8 and UTF-16LE with a BOM.`,
      errorCode: 'invalid_input',
    } }
  }
  const previous = getReadFileContent(absolute, context)
  const notice = previous !== undefined && previous !== file.content
    ? '\nThe file changed since it was last read. The replacements matched its current content; other changes were preserved. Read it before edits that depend on surrounding code.'
    : ''
  return { target, file, notice }
}
