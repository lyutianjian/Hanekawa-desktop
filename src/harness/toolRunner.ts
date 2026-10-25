import { randomUUID } from 'node:crypto'
import { PermissionGate } from './permissions.js'
import { mergeHooks, runLifecycleHooks, runPreToolUseHooks } from './hooks.js'
import { validateToolInput, type ToolValidationError } from './toolValidation.js'
import { normalizeToolInput } from '../tools/inputAliases.js'
import { describeToolError } from '../tools/fsErrors.js'
import { countTextTokens } from '../prompts/budget.js'
import { wrapInSystemReminder } from './systemReminder.js'
import type { ImageAttachmentRef } from '../media/types.js'
import type { ToolHooks } from './hooks.js'
import type { SessionRecord, TaskDisplayCounts, TaskDisplayItem, TaskDisplaySnapshot, TaskItem, Tool, ToolCall, ToolContext, ToolErrorCode, ToolProgressEvent, ToolResultDisplay, ToolResultMetadata, ToolResultRecord, ToolUseRecord } from './types.js'

export interface ToolRunEvents {
  onRecord(record: SessionRecord): Promise<void>
  onProgress?(event: ToolProgressEvent): Promise<void> | void
}

type ToolRunRecordListener = (record: SessionRecord) => void

export interface ToolRunOptions {
  hooks?: ToolHooks
}

export class ToolRunner {
  private readonly recordListeners = new Set<ToolRunRecordListener>()

  constructor(
    private readonly tools: Tool[],
    private readonly permissionGate: PermissionGate,
    private readonly events: ToolRunEvents,
    private readonly hooks: ToolHooks = {},
  ) {}

  addRecordListener(listener: ToolRunRecordListener): () => void {
    this.recordListeners.add(listener)
    return () => {
      this.recordListeners.delete(listener)
    }
  }

  /**
   * Create a sibling ToolRunner that shares tools, permission gate, and hooks
   * but routes records and progress events to a different sink. The returned
   * runner has its own (empty) record-listener set, so any in-process listeners
   * registered on the original (e.g. AgentLoop's records cache invalidator) are
   * not invoked for forked runs. Use this when running a tool in isolation,
   * such as a diagnostic call that must not pollute the main session's record
   * stream or in-memory caches.
   */
  fork(events: ToolRunEvents): ToolRunner {
    return new ToolRunner(this.tools, this.permissionGate, events, this.hooks)
  }

  isReadonlyCall(tool: Tool, call: ToolCall): boolean {
    return this.permissionGate.riskLevel(tool, call.input) === 'readonly'
  }

  async run(call: ToolCall, context: ToolContext, signal?: AbortSignal, turnId?: string, options?: ToolRunOptions): Promise<ToolResultRecord> {
    if (signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const tool = this.tools.find((candidate) => candidate.name === call.name)
    if (!tool) throw new Error(`Unknown tool: ${call.name}`)
    const activeHooks = mergeHooks(this.hooks, options?.hooks)

    // Rewrite the model's parameter names to this tool's before anything reads
    // them, so permissions, hooks, display and the persisted record all see one
    // canonical shape. Done here rather than in a schema preprocess because
    // execute() below receives `call.input` itself, not zod's parsed output.
    call.input = normalizeToolInput(tool.name, call.input)

    const toolUse: ToolUseRecord = {
      id: call.id,
      type: 'tool_use',
      tool: tool.name,
      input: call.input,
      riskLevel: tool.riskLevel,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    }
    await this.emitRecord(toolUse)
    let progressStarted = false
    let recordFailed = false
    let resultStarted = false
    let approvalRecorded = false
    const recordForRun = async (record: SessionRecord): Promise<void> => {
      try { await this.emitRecord(record) }
      catch (error) { recordFailed = true; throw error }
    }
    const settleResult = async (record: ToolResultRecord): Promise<void> => {
      resultStarted = true
      await this.emitToolResultAndPostHooks(record, tool, call.input, executionContext, signal, activeHooks)
    }

    const executionContext: ToolContext = {
      ...context,
      abortSignal: signal ?? context.abortSignal,
      appendRecord: recordForRun,
      appendMetric: context.appendMetric,
      currentToolUseId: call.id,
      currentTurnId: turnId,
      getPermissionMode: () => this.permissionGate.getMode(),
      setPermissionMode: (mode) => this.permissionGate.setMode(mode),
      exitPlanMode: () => this.permissionGate.exitPlanMode(),
    }

    try {
      await this.emitProgress({ call, phase: 'started' })
      progressStarted = true

      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const validation = validateToolInput(tool, call.input)
      if (!validation.ok) {
        const record = this.result(
          call,
          tool.name,
          false,
          formatValidationFailure(tool, validation.errors),
          'invalid_input',
          validation.errors,
          turnId,
          tool.maxResultSizeChars,
        )
        await settleResult(record)
        return record
      }

      const decision = await this.permissionGate.approveDetailed(tool, call.input)
      const approved = decision.approved
      // Bind the call to the target resolved at classification time, so neither
      // the approval await nor a pre-tool hook can re-point it.
      if (decision.writeTarget !== undefined) {
        executionContext.approvedWriteTarget = decision.writeTarget
      }
      await recordForRun(this.permissionGate.createApprovalRecord(tool, call.input, approved, turnId))
      approvalRecorded = true
      if (!approved) {
        // A denial the user never saw must not claim they made it, or the model
        // retries the same call believing a human rejected it.
        const reason = decision.denialReason ?? `User denied permission for ${tool.name}.`
        const denied = this.result(call, tool.name, false, reason, 'permission_denied', undefined, turnId, tool.maxResultSizeChars)
        await settleResult(denied)
        return denied
      }

      // Check abort signal after permission approval — user may have cancelled
      // while the permission dialog was open.
      if (signal?.aborted) {
        const aborted = this.result(call, tool.name, false, abortedToolResultContent(signal), 'aborted', undefined, turnId, tool.maxResultSizeChars)
        await settleResult(aborted)
        return aborted
      }

      const preToolHooks = await runPreToolUseHooks(activeHooks?.preToolUse, tool, call.input, executionContext, signal)
      syncMutableToolContext(context, executionContext)
      if (!preToolHooks.ok) {
        const blocked = this.result(
          call,
          tool.name,
          false,
          preToolHooks.content ?? `Pre-tool hook blocked ${tool.name}.`,
          'precondition_failed',
          preToolHooks.details,
          turnId,
          tool.maxResultSizeChars,
        )
        await settleResult(blocked)
        return blocked
      }

      // Check abort signal again after pre-tool hooks.
      if (signal?.aborted) {
        const aborted = this.result(call, tool.name, false, abortedToolResultContent(signal), 'aborted', undefined, turnId, tool.maxResultSizeChars)
        await settleResult(aborted)
        return aborted
      }

      try {
        const result = await tool.execute(call.input, executionContext)
        syncMutableToolContext(context, executionContext)
        const content = decision.reminder ? `${result.content}\n\n${wrapInSystemReminder(decision.reminder)}` : result.content
        const record = this.result(call, tool.name, result.ok, content, result.errorCode, result.errorDetails, turnId, tool.maxResultSizeChars, result.metadata?.display, result.images)
        // Map tool result to API format (e.g. tool_reference blocks for ToolSearch)
        if (tool.mapToolResultToToolResultBlockParam) {
          try {
            record.apiResultBlock = tool.mapToolResultToToolResultBlockParam(result, call.id, executionContext)
          } catch {
            // Mapping is best-effort; fall back to plain-text content
          }
        }
        await settleResult(record)
        await this.emitAssistantMessageFromMetadata(result.metadata, turnId)
        return record
      } catch (error) {
        if (resultStarted || recordFailed) throw error
        syncMutableToolContext(context, executionContext)
        const errorCode = error instanceof Error && error.name === 'AbortError' ? 'aborted' : 'execution_failed'
        const content = errorCode === 'aborted'
          ? abortedToolResultContent(signal, error)
          : describeToolError(tool.name, error, executionContext.cwd)
        const record = this.result(call, tool.name, false, content, errorCode, undefined, turnId, tool.maxResultSizeChars)
        await settleResult(record)
        return record
      }
    } catch (error) {
      if (resultStarted || recordFailed) throw error
      syncMutableToolContext(context, executionContext)
      if (!approvalRecorded) {
        await recordForRun(this.permissionGate.createApprovalRecord(tool, call.input, false, turnId))
      }
      const aborted = signal?.aborted || isAbortError(error)
      const record = this.result(call, tool.name, false,
        aborted ? abortedToolResultContent(signal, error) : describeToolError(tool.name, error, executionContext.cwd),
        aborted ? 'aborted' : 'execution_failed', undefined, turnId, tool.maxResultSizeChars)
      await settleResult(record)
      return record
    } finally {
      if (progressStarted) {
        await this.emitProgress({ call, phase: 'finished' })
      }
    }
  }

  private async emitRecord(record: SessionRecord): Promise<void> {
    await this.events.onRecord(record)
    for (const listener of this.recordListeners) {
      listener(record)
    }
  }

  private async emitProgress(event: ToolProgressEvent): Promise<void> {
    try {
      await this.events.onProgress?.(event)
    } catch (error) {
      // Progress updates are UI-only; tool execution and persistence own truth.
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error('[myagent][toolRunner] emitProgress error:', error)
      }
    }
  }

  private async emitToolResultAndPostHooks(
    record: ToolResultRecord,
    tool: Tool,
    input: unknown,
    context: ToolContext,
    signal?: AbortSignal,
    hooks?: ToolHooks,
  ): Promise<void> {
    await this.emitRecord(record)
    const result = await runLifecycleHooks(
      hooks?.postToolUse,
      'postToolUse',
      {
        tool: tool.name,
        riskLevel: tool.riskLevel,
        input,
        result: {
          ok: record.ok,
          content: record.content,
          errorCode: record.errorCode,
          errorDetails: record.errorDetails,
          // Attachment metadata only (design §13): refs' facts, never bytes.
          ...(record.images && record.images.length > 0
            ? {
                images: record.images.map(({ id, name, mimeType, width, height, byteLength }) => ({
                  id, name, mimeType, width, height, byteLength,
                })),
              }
            : {}),
        },
        toolUseId: record.toolUseId,
      },
      context,
      signal,
      tool.name,
    )
    await this.emitPostToolUseHookMessage(tool.name, result, record.turnId)
  }

  private async emitPostToolUseHookMessage(
    toolName: string,
    result: Awaited<ReturnType<typeof runLifecycleHooks>>,
    turnId?: string,
  ): Promise<void> {
    const blocks: string[] = []
    if (result.stdout.trim()) blocks.push(result.stdout.trim())
    if (result.failures.length > 0) blocks.push(`Hook failures:\n${result.failures.join('\n')}`)
    if (result.blockingErrors.length > 0) blocks.push(`Hook blocking errors:\n${result.blockingErrors.join('\n')}`)
    if (blocks.length === 0) return

    await this.emitRecord({
      id: randomUUID(),
      type: 'message',
      role: 'user',
      content: wrapInSystemReminder(`postToolUse hook output for ${toolName}:\n${blocks.join('\n\n')}`),
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  }

  private result(
    call: ToolCall,
    tool: string,
    ok: boolean,
    content: string,
    errorCode?: ToolErrorCode,
    errorDetails?: unknown,
    turnId?: string,
    maxResultSizeChars?: number,
    display?: ToolResultDisplay,
    images?: ImageAttachmentRef[],
  ): ToolResultRecord {
    const boundedContent = applyToolResultBudget(content, maxResultSizeChars)
    const boundedDisplay = normalizeToolResultDisplay(display)
    return {
      id: randomUUID(),
      type: 'tool_result',
      toolUseId: call.id,
      tool,
      ok,
      content: boundedContent,
      ...(boundedDisplay ? { display: boundedDisplay } : {}),
      _tokens: countTextTokens(`${tool}\n${boundedContent}`),
      ...(errorCode ? { errorCode } : {}),
      ...(errorDetails !== undefined ? { errorDetails } : {}),
      ...(turnId ? { turnId } : {}),
      ...(images !== undefined && images.length > 0 ? { images } : {}),
      createdAt: new Date().toISOString(),
    }
  }

  private async emitAssistantMessageFromMetadata(metadata: ToolResultMetadata | undefined, turnId?: string): Promise<void> {
    const content = metadata?.assistantMessageContent
    if (typeof content === 'string' && content.trim().length > 0) {
      await this.emitRecord({
        id: randomUUID(),
        type: 'message',
        role: 'assistant',
        content,
        ...(turnId ? { turnId } : {}),
        createdAt: new Date().toISOString(),
      })
    }

    const subagentSummary = formatSubagentSummary(metadata?.subagent)
    if (!subagentSummary) return
    await this.emitRecord({
      id: randomUUID(),
      type: 'message',
      role: 'assistant',
      content: subagentSummary,
      ...(turnId ? { turnId } : {}),
      createdAt: new Date().toISOString(),
    })
  }
}

function abortedToolResultContent(signal: AbortSignal | undefined, error?: unknown): string {
  if (signal?.reason === 'user-cancel') return 'Interrupted by user'
  return error instanceof Error ? error.message : 'The operation was aborted.'
}

function normalizeToolResultDisplay(display: ToolResultDisplay | undefined): ToolResultDisplay | undefined {
  if (!display) return undefined
  const summary = display.summary.trim()
  if (!summary) return undefined
  const headerSuffix = display.headerSuffix?.trim()
  const detail = display.detail?.trim()
  const taskSnapshot = normalizeTaskDisplaySnapshot(display.taskSnapshot)
  const { answers } = display
  return {
    summary,
    ...(headerSuffix ? { headerSuffix } : {}),
    ...(detail ? { detail } : {}),
    ...(taskSnapshot ? { taskSnapshot } : {}),
    ...(answers ? { answers } : {}),
  }
}

const MAX_TASK_DISPLAY_ITEMS = 50
const MAX_TASK_DISPLAY_TEXT_CHARS = 500

function normalizeTaskDisplaySnapshot(snapshot: TaskDisplaySnapshot | undefined): TaskDisplaySnapshot | undefined {
  if (!snapshot || !Array.isArray(snapshot.tasks)) return undefined
  const tasks = snapshot.tasks
    .slice(0, MAX_TASK_DISPLAY_ITEMS)
    .map(normalizeTaskDisplayItem)
    .filter((task): task is TaskDisplayItem => Boolean(task))
  if (tasks.length === 0) return undefined
  const activeTaskId = typeof snapshot.activeTaskId === 'string' && tasks.some((task) => task.id === snapshot.activeTaskId)
    ? snapshot.activeTaskId
    : undefined
  return {
    tasks,
    counts: normalizeTaskDisplayCounts(snapshot.counts, tasks),
    ...(activeTaskId ? { activeTaskId } : {}),
  }
}

function normalizeTaskDisplayItem(item: TaskDisplayItem): TaskDisplayItem | undefined {
  if (!isRecord(item)) return undefined
  const id = trimDisplayString(item.id)
  const subject = trimDisplayString(item.subject)
  const description = trimDisplayString(item.description)
  if (!id || !subject) return undefined
  const status = normalizeTaskStatus(item.status)
  if (!status) return undefined
  const activeForm = trimDisplayString(item.activeForm)
  const owner = trimDisplayString(item.owner)
  return {
    id,
    status,
    subject,
    description: description ?? subject,
    ...(activeForm ? { activeForm } : {}),
    ...(owner ? { owner } : {}),
    blocks: normalizeIdList(item.blocks),
    blockedBy: normalizeIdList(item.blockedBy),
  }
}

function normalizeTaskDisplayCounts(counts: TaskDisplayCounts | undefined, tasks: readonly TaskDisplayItem[]): TaskDisplayCounts {
  if (counts && isRecord(counts)) {
    return {
      total: normalizeCount(counts.total, tasks.length),
      remaining: normalizeCount(counts.remaining, tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length),
      pending: normalizeCount(counts.pending, tasks.filter((task) => task.status === 'pending').length),
      inProgress: normalizeCount(counts.inProgress, tasks.filter((task) => task.status === 'in_progress').length),
      completed: normalizeCount(counts.completed, tasks.filter((task) => task.status === 'completed').length),
    }
  }
  return {
    total: tasks.length,
    remaining: tasks.filter((task) => task.status === 'pending' || task.status === 'in_progress').length,
    pending: tasks.filter((task) => task.status === 'pending').length,
    inProgress: tasks.filter((task) => task.status === 'in_progress').length,
    completed: tasks.filter((task) => task.status === 'completed').length,
  }
}

function normalizeTaskStatus(value: unknown): TaskItem['status'] | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
    ? value
    : undefined
}

function normalizeIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => trimDisplayString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_TASK_DISPLAY_ITEMS)
}

function trimDisplayString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_TASK_DISPLAY_TEXT_CHARS)
}

/**
 * Reporting only the first issue meant a call with two wrong keys took two
 * turns to fix. Listing every issue plus the accepted parameter names lets the
 * model correct the whole call at once.
 */
function formatValidationFailure(tool: Tool, errors: ToolValidationError[]): string {
  const lines = errors.length > 0
    ? errors.map((error) => `- ${error.message}`)
    : ['- invalid input']
  const accepted = acceptedParameterNames(tool)
  const footer = accepted.length > 0 ? `\nAccepted parameters: ${accepted.join(', ')}.` : ''
  return `Tool input validation failed for ${tool.name}:\n${lines.join('\n')}${footer}`
}

function acceptedParameterNames(tool: Tool): string[] {
  const shape = (tool.inputSchema as { _def?: { shape?: unknown } })._def?.shape
  const resolved = typeof shape === 'function' ? (shape as () => unknown)() : shape
  return isRecord(resolved) ? Object.keys(resolved) : []
}

function normalizeCount(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback
}

function formatSubagentSummary(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined
  if (value.suppressContextSummary === true) return undefined
  const type = typeof value.type === 'string' ? value.type : undefined
  if (!type) return undefined

  const attributes: string[] = [`type="${escapeAttribute(type)}"`]
  const agentId = typeof value.agentId === 'string' ? value.agentId : undefined
  if (agentId) attributes.push(`agent_id="${escapeAttribute(agentId)}"`)

  const verdict = typeof value.verdict === 'string' ? value.verdict : undefined
  if (verdict) attributes.push(`verdict="${escapeAttribute(verdict)}"`)

  const stopReason = typeof value.stopReason === 'string' ? value.stopReason : undefined
  if (stopReason) attributes.push(`stop_reason="${escapeAttribute(stopReason)}"`)

  if (value.truncated === true) attributes.push('truncated="true"')

  const usage = isRecord(value.usage) ? value.usage : undefined
  const tokens = usage ? totalTokens(usage) : undefined
  if (tokens !== undefined) attributes.push(`tokens="${tokens}"`)

  const criticalFiles = Array.isArray(value.criticalFiles)
    ? value.criticalFiles.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : []
  if (criticalFiles.length === 0) {
    return `<subagent-summary ${attributes.join(' ')} />`
  }

  const files = criticalFiles
    .map((file) => `  <critical-file>${escapeElementText(file)}</critical-file>`)
    .join('\n')
  return `<subagent-summary ${attributes.join(' ')}>\n${files}\n</subagent-summary>`
}

function totalTokens(usage: Record<string, unknown>): number | undefined {
  const fields = [
    numericUsageField(usage.inputTokens),
    numericUsageField(usage.cacheCreationInputTokens),
    numericUsageField(usage.cacheReadInputTokens),
    numericUsageField(usage.outputTokens),
  ]
  if (fields.every((field) => field === undefined)) return undefined
  return fields.reduce<number>((sum, field) => sum + (field ?? 0), 0)
}

function numericUsageField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeElementText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function syncMutableToolContext(target: ToolContext, source: ToolContext): void {
  target.readFileState = source.readFileState
  target.invokedSkills = source.invokedSkills
  target.taskState = source.taskState
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function applyToolResultBudget(content: string, maxResultSizeChars: number | undefined): string {
  if (maxResultSizeChars === undefined || content.length <= maxResultSizeChars) return content
  return [
    content.slice(0, maxResultSizeChars),
    `[Tool result truncated: exceeded ${maxResultSizeChars} chars; original ${content.length} chars]`,
  ].join('\n\n')
}
