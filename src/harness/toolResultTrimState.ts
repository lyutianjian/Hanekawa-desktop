import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { countTextTokens } from '../prompts/budget.js'
import type { SessionRecord, ToolResultRecord, ToolResultTrimRecord } from './types.js'

/**
 * The trim ledger (spec §5.1).
 *
 * A tool result that has once gone out in some shape keeps that shape for the
 * rest of the session: prompt caching matches on a prefix, so re-deciding what
 * to trim on every request rewrites history mid-stream and throws away every
 * cached block behind the edit. So decisions are made once, for results the
 * model has not seen yet, and replayed verbatim afterwards.
 *
 * The replacement *string* is what gets persisted, never the rule that made it
 * — reformatting the wording in a later version must not shift a resumed
 * session's prefix by a single byte.
 */
export class ToolResultTrimState {
  private readonly seen = new Set<string>()
  private readonly trimmed = new Map<string, string>()
  private readonly pending: ToolResultTrimRecord[] = []

  /**
   * Rebuild from a session's records. Everything already in the log was
   * already sent, so it is frozen: a stored replacement replays, and anything
   * else stays whole forever.
   */
  static fromRecords(records: SessionRecord[]): ToolResultTrimState {
    const state = new ToolResultTrimState()
    for (const record of records) {
      if (record.type === 'tool_result') state.seen.add(record.toolUseId)
      if (record.type === 'tool_result_trim') {
        state.seen.add(record.toolUseId)
        state.trimmed.set(record.toolUseId, record.content)
      }
    }
    return state
  }

  isSeen(toolUseId: string): boolean {
    return this.seen.has(toolUseId)
  }

  replacementFor(toolUseId: string): string | undefined {
    return this.trimmed.get(toolUseId)
  }

  markSeen(toolUseId: string): void {
    this.seen.add(toolUseId)
  }

  /** Freeze a decision and queue the record that makes it survive a restart. */
  recordTrim(toolUseId: string, content: string, turnId?: string): void {
    this.seen.add(toolUseId)
    this.trimmed.set(toolUseId, content)
    this.pending.push({
      id: randomUUID(),
      type: 'tool_result_trim',
      toolUseId,
      content,
      createdAt: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
    })
  }

  /** Records to append; the caller owns the write, this class stays sync. */
  takePendingRecords(): ToolResultTrimRecord[] {
    return this.pending.splice(0, this.pending.length)
  }
}

const PREVIEW_MAX_LINES = 40
const PREVIEW_MAX_CHARS = 4_000

/**
 * The replacement for an oversized result. The full output goes to disk and
 * the model gets a preview plus the path, so nothing is destroyed the way the
 * old `[Result truncated]` line destroyed it — the model can Read the rest.
 * A failed write degrades to preview-only; it must never fail the request.
 */
export function buildOversizeReplacement(
  record: ToolResultRecord,
  spillDir?: string,
): string {
  const tokens = countTextTokens(record.content)
  const preview = buildPreview(record.content)
  const spillPath = spillDir ? writeSpillFile(spillDir, record) : undefined
  const where = spillPath
    ? `full output saved to ${spillPath} — Read that path with offset/limit for the rest`
    : 'the remainder could not be saved and is gone from this session'
  return [
    `[Large result: ${record.tool} produced ${record.content.length} characters (~${tokens} tokens); ${where}]`,
    preview,
  ].join('\n')
}

function buildPreview(content: string): string {
  const byLines = content.split('\n').slice(0, PREVIEW_MAX_LINES).join('\n')
  return byLines.length > PREVIEW_MAX_CHARS ? byLines.slice(0, PREVIEW_MAX_CHARS) : byLines
}

function writeSpillFile(spillDir: string, record: ToolResultRecord): string | undefined {
  const target = path.join(spillDir, `${record.toolUseId}.txt`)
  try {
    mkdirSync(spillDir, { recursive: true })
    writeFileSync(target, record.content, 'utf8')
    return target
  } catch {
    return undefined
  }
}
