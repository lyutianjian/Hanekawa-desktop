import {
  countSessionRecordTokens,
  countSessionRecordsTokens,
  TIME_BASED_MC_GAP_THRESHOLD_MINUTES,
  TIME_BASED_MC_KEEP_RECENT,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { SessionRecord } from './types.js'
import type { ImageTokenStrategy } from '../media/imageTokens.js'
import { getRecordsAfterLastCompact } from './requestPrep.js'
import { projectRecordImagesToText } from './turnImages.js'
import type { ToolResultTrimState } from './toolResultTrimState.js'

/** Text a cleared tool result carries; image placeholders may follow it. */
const CLEARED_TOOL_RESULT_CONTENT = '[Old tool result content cleared]'

export interface ProgressiveCompactInput {
  records: SessionRecord[]
  contextManagement?: Partial<ContextManagementConfig>
  system?: string
  lastResponseTokenCount?: number
  lastResponseRecordId?: string
  lastResponseRecordCount?: number
  /** Image-token strategy of the model serving the request being sized. */
  imageTokenStrategy?: ImageTokenStrategy
  now?: Date
  /**
   * The session's trim ledger. A clear is recorded there so the next request
   * replays it; without that the very next iteration sends the originals back
   * and pays a second full-prefix cache write.
   */
  trimState?: ToolResultTrimState
  turnId?: string
}

export interface ProgressiveCompactResult {
  records: SessionRecord[]
  tokenCount: number
  microCompacted: boolean
  snipped: boolean
  /** The last response's count less what a clear took out of the records it covered. */
  lastResponseTokenCount?: number
}

export function applyProgressiveCompaction(input: ProgressiveCompactInput): ProgressiveCompactResult {
  let records = input.records
  let tokenCount = estimateCurrentTokens(input)
  let lastResponseTokenCount = input.lastResponseTokenCount
  let microCompacted = false

  // Keep active request prefixes stable. Only clear old tool results after
  // a long idle gap; capacity-based compaction is handled by autoCompact.
  const timeBased = applyTimeBasedMicrocompact(records, input.now, input.trimState, input.turnId)
  if (timeBased.changed) {
    lastResponseTokenCount = subtractClearedTokens(input, timeBased.records)
    records = timeBased.records
    tokenCount = estimateCurrentTokens({ ...input, records, lastResponseTokenCount })
    microCompacted = true
  }

  return {
    records,
    tokenCount,
    microCompacted,
    snipped: false,
    lastResponseTokenCount,
  }
}

/**
 * The provider counted the cleared records at full size. Records after its
 * boundary are estimated from their cleared form anyway, so only the ones it
 * covered come off.
 */
function subtractClearedTokens(input: ProgressiveCompactInput, cleared: SessionRecord[]): number | undefined {
  if (input.lastResponseTokenCount === undefined) return undefined
  const boundaryIndex = findLastResponseBoundaryIndex(input.records, input.lastResponseRecordId, input.lastResponseRecordCount)
  if (boundaryIndex === undefined) return undefined
  let saved = 0
  for (let index = 0; index <= boundaryIndex; index++) {
    const before = input.records[index]!
    const after = cleared[index]!
    if (before !== after) {
      saved += countSessionRecordTokens(before, input.imageTokenStrategy) - countSessionRecordTokens(after, input.imageTokenStrategy)
    }
  }
  return Math.max(0, input.lastResponseTokenCount - saved)
}

export function estimateCurrentTokens(input: ProgressiveCompactInput): number {
  if (input.lastResponseTokenCount === undefined) {
    return countSessionRecordsTokens(
      getRecordsAfterLastCompact(input.records),
      input.system,
      input.imageTokenStrategy,
    )
  }

  const pendingTokens = countPendingRecordTokens(
    input.records,
    input.lastResponseRecordId,
    input.lastResponseRecordCount,
    input.imageTokenStrategy,
  )
  if (pendingTokens === undefined) {
    return countSessionRecordsTokens(
      getRecordsAfterLastCompact(input.records),
      input.system,
      input.imageTokenStrategy,
    )
  }
  return input.lastResponseTokenCount + pendingTokens
}

/**
 * Time-based micro-compact: when the gap since the last assistant message
 * exceeds the configured threshold, content-clear all but the most recent N
 * compactable tool results. The server prompt cache has almost certainly
 * expired, so the full prefix will be rewritten regardless; clearing old
 * tool results before the request shrinks what gets rewritten.
 *
 * Returns { changed: false } when the trigger doesn't fire.
 */
function applyTimeBasedMicrocompact(
  records: SessionRecord[],
  now?: Date,
  trimState?: ToolResultTrimState,
  turnId?: string,
): { records: SessionRecord[]; changed: boolean } {
  // Only fire when the caller explicitly provides a timestamp (loop.ts does).
  // Without an explicit `now`, tests and internal callers are not affected.
  if (!now) {
    return { records, changed: false }
  }
  const currentTime = now

  // Find the last assistant message timestamp
  let lastAssistantTime: string | undefined
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i]
    if (record?.type === 'message' && record.role === 'assistant') {
      lastAssistantTime = record.createdAt
      break
    }
  }
  if (!lastAssistantTime) {
    return { records, changed: false }
  }

  const gapMs = currentTime.getTime() - new Date(lastAssistantTime).getTime()
  const gapMinutes = gapMs / 60_000
  if (!Number.isFinite(gapMinutes) || gapMinutes < TIME_BASED_MC_GAP_THRESHOLD_MINUTES) {
    return { records, changed: false }
  }

  // Collect tool result IDs in encounter order
  const toolResultIds: string[] = []
  for (const record of records) {
    if (record.type === 'tool_result') {
      toolResultIds.push(record.id)
    }
  }

  // Floor at 1: clearing ALL results leaves the model with zero working context
  const keepRecent = Math.max(1, TIME_BASED_MC_KEEP_RECENT)
  const keepSet = new Set(toolResultIds.slice(-keepRecent))
  const clearIds = new Set(toolResultIds.filter((id) => !keepSet.has(id)))

  if (clearIds.size === 0) {
    return { records, changed: false }
  }

  let changed = false
  const updatedRecords = records.map((record) => {
    if (record.type !== 'tool_result' || !clearIds.has(record.id)) return record
    const hasImages = record.images !== undefined && record.images.length > 0
    if (record.content.startsWith(CLEARED_TOOL_RESULT_CONTENT) && !hasImages) return record
    changed = true
    trimState?.recordTrim(record.toolUseId, CLEARED_TOOL_RESULT_CONTENT, turnId)
    // Clearing the text but keeping `images` would go on uploading the pixels
    // this pass exists to reclaim (design §11.3) — the shared projection drops
    // them and leaves a placeholder naming what was there.
    return projectRecordImagesToText(record, { content: CLEARED_TOOL_RESULT_CONTENT })
  })

  return { records: updatedRecords, changed }
}

function countPendingRecordTokens(
  records: SessionRecord[],
  lastResponseRecordId?: string,
  lastResponseRecordCount?: number,
  imageTokenStrategy?: ImageTokenStrategy,
): number | undefined {
  if (lastResponseRecordId === undefined && lastResponseRecordCount === undefined) return 0

  const boundaryIndex = findLastResponseBoundaryIndex(records, lastResponseRecordId, lastResponseRecordCount)
  if (boundaryIndex === undefined) return undefined

  const pendingRecords = records.slice(boundaryIndex + 1)
  // A compaction since that response made its count describe a context that is gone.
  if (pendingRecords.some((record) => record.type === 'compact_boundary')) return undefined
  let skippedResponseMessage = false
  return pendingRecords.reduce((sum, record) => {
    if (!skippedResponseMessage && record.type === 'message' && record.role === 'assistant') {
      skippedResponseMessage = true
      return sum
    }
    return sum + countSessionRecordTokens(record, imageTokenStrategy)
  }, 0)
}

function findLastResponseBoundaryIndex(
  records: SessionRecord[],
  lastResponseRecordId?: string,
  lastResponseRecordCount?: number,
): number | undefined {
  if (lastResponseRecordId) {
    const index = records.findIndex((record) => record.id === lastResponseRecordId)
    return index >= 0 ? index : undefined
  }

  if (lastResponseRecordCount === undefined) return undefined
  return lastResponseRecordCount - 1
}
