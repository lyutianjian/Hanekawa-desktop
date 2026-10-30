import {
  countSessionRecordTokens,
  countTextTokens,
  getEffectiveContextWindowSize,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import type { ImageTokenStrategy } from '../media/imageTokens.js'
import type { SessionRecord, ToolResultRecord, TokenUsage } from './types.js'
import { repairToolResultPairing } from '../sessions/invariants.js'
import { buildOversizeReplacement, ToolResultTrimState } from './toolResultTrimState.js'
import { projectRecordImagesToText } from './turnImages.js'
import { promptTokens } from './usage.js'

const TOOL_RESULTS_CONTEXT_RATIO = 0.5
const TOOL_RESULTS_TOKEN_BUDGET_CAP = 200_000
/**
 * Per-result ceiling. ~25k tokens is ~75KB of ASCII — a full test run or a
 * 2000-line file fits, which the old 10k cap did not, and past it the result
 * is spilled to disk rather than thrown away (spec §5.2).
 */
const TOOL_RESULT_MAX_TOKENS = 25_000

export interface RequestPrepDiagnostic {
  code: 'tool_protocol_repaired'
  severity: 'info' | 'warning'
  message: string
  recordId?: string
  toolUseId?: string
  tool?: string
}

export interface PreparedRecordsResult {
  records: SessionRecord[]
  diagnostics: RequestPrepDiagnostic[]
}

export interface RequestPrepOptions {
  repairToolPairing?: boolean
  /** Image-token strategy of the model serving this request (design §11.2). */
  imageTokenStrategy?: ImageTokenStrategy
  /**
   * The session's trim ledger. Without one each call decides afresh, which is
   * fine for a one-shot caller but never for a loop: see `ToolResultTrimState`.
   */
  trimState?: ToolResultTrimState
  /** Where oversized outputs are spilled; absent means preview-only. */
  spillDir?: string
  turnId?: string
}

export function requestTokenCountFromUsage(usage?: TokenUsage): number | undefined {
  if (!usage) return undefined
  // The prompt *and* the response: this estimates what the next request will
  // carry, and the assistant message just generated is part of it.
  return promptTokens(usage) + usage.outputTokens
}

export function prepareRecordsForRequest(
  records: SessionRecord[],
  contextManagement: Partial<ContextManagementConfig> = {},
  now = new Date(),
): SessionRecord[] {
  return prepareRecordsForRequestWithDiagnostics(records, contextManagement, now).records
}

export function prepareRecordsForRequestWithDiagnostics(
  records: SessionRecord[],
  contextManagement: Partial<ContextManagementConfig> = {},
  now = new Date(),
  options: RequestPrepOptions = {},
): PreparedRecordsResult {
  void now
  const requestVisibleRecords = records.filter(
    (record) => record.type !== 'subagent_transcript' && record.type !== 'tool_result_trim',
  )
  const recordsAfterCompact = getRecordsAfterLastCompact(requestVisibleRecords)
  // The media-count cap runs after the capability projection in the loop
  // (design §11.1: projection before budget), on the model actually serving
  // the request — see `loadPreparedRecords` and `mediaStrip.ts`.
  const prepared = applyToolResultTrims(
    recordsAfterCompact,
    options.trimState ?? new ToolResultTrimState(),
    getToolResultTokenLimit(contextManagement),
    options,
  )

  if (options.repairToolPairing === false) {
    return { records: prepared, diagnostics: [] }
  }

  return repairToolPairingForRequest(prepared)
}

export function getRecordsAfterLastCompact(records: SessionRecord[]): SessionRecord[] {
  for (let index = records.length - 1; index >= 0; index--) {
    // Keep the boundary so ContextBuilder can render its summary into the next request.
    if (records[index]?.type === 'compact_boundary') return records.slice(index)
  }
  return [...records]
}

function getToolResultTokenLimit(
  contextManagement: Partial<ContextManagementConfig>,
): number {
  return Math.min(
    Math.floor(getEffectiveContextWindowSize(contextManagement) * TOOL_RESULTS_CONTEXT_RATIO),
    TOOL_RESULTS_TOKEN_BUDGET_CAP,
  )
}

/**
 * Decide what to trim among the results the model has not seen yet, then
 * replay every decision — old and new — onto the record list.
 *
 * The budget is the *new* results' aggregate, not the whole history's: results
 * already sent are frozen (spec §5.2), and shrinking them retroactively is
 * exactly the rewrite prompt caching punishes.
 */
function applyToolResultTrims(
  records: SessionRecord[],
  trimState: ToolResultTrimState,
  toolResultLimit: number,
  options: RequestPrepOptions,
): SessionRecord[] {
  const unseen: Array<{ record: ToolResultRecord; tokens: number }> = []
  for (const record of records) {
    if (record.type !== 'tool_result' || trimState.isSeen(record.toolUseId)) continue
    unseen.push({ record, tokens: getToolResultTokens(record, options.imageTokenStrategy) })
  }

  let total = 0
  for (const candidate of unseen) {
    // The cap is about the text that would go to disk, so it reads the text
    // rather than the record's total (which folds in image cost).
    if (countTextTokens(candidate.record.content) > TOOL_RESULT_MAX_TOKENS) {
      const replacement = buildOversizeReplacement(candidate.record, options.spillDir)
      trimState.recordTrim(candidate.record.toolUseId, replacement, options.turnId)
      total += countTextTokens(replacement)
      continue
    }
    total += candidate.tokens
  }

  // Oldest first: the newest results are the ones the model is reasoning about.
  for (const candidate of unseen) {
    if (total <= toolResultLimit) break
    if (trimState.replacementFor(candidate.record.toolUseId) !== undefined) continue
    const replacement = summarizedToolResultText(candidate.record, candidate.tokens)
    trimState.recordTrim(candidate.record.toolUseId, replacement, options.turnId)
    total += countTextTokens(replacement) - candidate.tokens
  }

  for (const candidate of unseen) trimState.markSeen(candidate.record.toolUseId)

  return records.map((record) => {
    if (record.type !== 'tool_result') return record
    const replacement = trimState.replacementFor(record.toolUseId)
    if (replacement === undefined) return record
    return applyReplacement(record, replacement)
  })
}

/**
 * One source for a tool result's cost: the budget counter, which folds the
 * text `_tokens` cache together with live image-token arithmetic so a stale
 * cache can never read as the whole count.
 */
function getToolResultTokens(record: ToolResultRecord, imageTokenStrategy?: ImageTokenStrategy): number {
  return countSessionRecordTokens(record, imageTokenStrategy)
}

function summarizedToolResultText(record: ToolResultRecord, tokens: number): string {
  return [
    `[summarized: ${record.tool} ${tokens} tokens]`,
    `status: ${record.ok ? 'ok' : 'error'}`,
    'The original output was removed from this request to stay within the context budget.',
  ].join('\n')
}

/**
 * Images go with the text (design §11.3): a result whose output was replaced
 * must not keep uploading the pixels that made it expensive.
 */
function applyReplacement(record: ToolResultRecord, content: string): ToolResultRecord {
  const projected = projectRecordImagesToText(record, { content })
  return { ...projected, _tokens: undefined }
}

export function compactToolResult(record: ToolResultRecord, tokens: number): ToolResultRecord {
  return applyReplacement(record, summarizedToolResultText(record, tokens))
}

function repairToolPairingForRequest(records: SessionRecord[]): PreparedRecordsResult {
  const repaired = repairToolResultPairing(records)
  return {
    records: repaired.records,
    diagnostics: repaired.diagnostics.map((diagnostic) => ({
      ...diagnostic,
      severity: 'warning',
    })),
  }
}
