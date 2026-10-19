import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { ContextBuilder, INSTRUCTIONS_MESSAGE_ID } from './contextBuilder.js'
import { extractDiscoveredToolNames, filterToolsForRequest, resolveToolSearchState, TOOL_SEARCH_TOOL_NAME, type ToolSearchState } from '../utils/toolSearch.js'
import type { ContextSources } from './contextBreakdown.js'
import type { EnvironmentInfo } from './contextBuilder.js'
import { ToolRunner } from './toolRunner.js'
import {
  EMPTY_TOKEN_USAGE,
  addTokenUsage,
  cacheCreationTokens,
  cacheHitRate,
  costField,
  promptTokens,
  reportsCacheCreation,
} from './usage.js'
import { autoCompactIfNeeded, compactNow, summarizeRecordsForContinuation, type CompactCheckInput, type CompactCheckResult } from './compact.js'
import {
  prepareRecordsForRequestWithDiagnostics,
  requestTokenCountFromUsage,
} from './requestPrep.js'
import { applyProgressiveCompaction } from './progressiveCompact.js'
import { summarizeToolUse } from './toolUseSummary.js'
import { agentCacheSource, compactCacheSource, formatCacheHitRate, notifyCompaction, resetCacheBreakDetection, type CacheBreakSource } from './cacheBreakDetection.js'
import { logDiagnostics, type RuntimeDiagnostic } from './diagnostics.js'
import { toMetricUsage, type SessionMetricInput } from './metrics.js'
import type { RecordStream } from './recordStream.js'
import { MemoryRecordStream } from './recordStream.js'
import type { ImageAttachmentRef, UserInput } from '../media/types.js'
import { mergeHooks, runLifecycleHooks, type Hooks, type LifecycleHookName } from './hooks.js'
import { FallbackTriggeredError } from '../config/retry.js'
import {
  getAutoCompactThreshold,
  getContextWindowForModel,
  getEffectiveContextWindowSize,
  type ContextManagementConfig,
} from '../prompts/budget.js'
import { ESCALATED_MAX_TOKENS, MODEL_CONTEXT_WINDOW_DEFAULT } from '../prompts/budget.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { CacheRuntime } from './cacheControl.js'
import type { PermissionMode } from './permissions.js'
import type { PlanModeManager } from './planModeManager.js'
import type { AgentRunResult, AttachmentBytesLoader, ChatMessage, TurnFailureRecord, ModelProvider, ModelRequest, ModelResponse, ModelStreamEvent, RequestImageBytes, SessionRecord, SteerSource, Tool, ToolCall, ToolContext, ToolResultRecord, ToolUseSummaryRecord, TokenUsage, TurnOrigin } from './types.js'
import type { CompactPromptVariant } from '../prompts/compactPrompt.js'
import { formatTaskLine, remainingTasksFromState, sortedTasks } from '../tools/taskFormat.js'
import { describeShell } from '../tools/BashTool/BashTool.js'
import {
  ENTER_PLAN_MODE_TOOL_NAME,
  EXIT_PLAN_MODE_TOOL_NAME,
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
} from '../tools/toolNames.js'
import {
  buildAtMentionContextRecord,
  collectAtMentionImages,
  formatAtMentionImageErrors,
  type AtMentionImageImporter,
} from './atMentions.js'
import {
  appendPlaceholderBlocks,
  assertCurrentImagesAvailable,
  assertNewImagesAllowed,
  FallbackNotApplicableForImagesError,
  formatHistoricalProjectionNotice,
  formatMissingHistoricalImagePlaceholder,
  projectTurnImagesForRequest,
  recordIsCurrentTurn,
  TurnImageBlockError,
  type AttachmentFactsResolver,
  type RequestImageProjection,
} from './turnImages.js'
import {
  assertInputImagesWithinRequestBody,
  estimateRequestTextBytes,
  formatImageByteStripNotice,
  formatMediaStripNotice,
  formatTooManyImagesBlockedMessage,
  requestContextReserveBytes,
  resolveMaxMediaItems,
  stripExcessImageBytes,
  stripExcessMediaItems,
  type ImageByteStripResult,
  type MediaStripResult,
} from './mediaStrip.js'
import { resolveMaxRequestBodyBytes } from '../media/imageRequestLimits.js'
import {
  describeImageTokenStrategy,
  resolveImageTokenStrategy,
  type ImageTokenStrategy,
} from '../media/imageTokens.js'
import { ToolResultTrimState } from './toolResultTrimState.js'
import { getToolResultSpillDir } from '../utils/paths.js'
import { isSystemReminderBlock, wrapInSystemReminder } from './systemReminder.js'

export interface ActiveModelRuntime {
  provider: ModelProvider
  model: string
  modelKey?: string
  contextWindow?: number
  providerName?: string
  promptCacheRetention?: 'in_memory' | '24h'
  /**
   * Effective image-input capability (`resolveImageCapability` of the config
   * this runtime was built from), carried per model so a fallback, plan, or
   * override model answers with its own capability rather than the session's
   * startup model's. Resolved at construction — never a session-scope
   * snapshot — so a settings toggle reaches the next runtime built.
   */
  supportsImageInput?: boolean
}

/**
 * Options for {@link AgentLoop.runTool}. All fields are optional; by default
 * the call is isolated (records routed to a fresh in-memory stream, toolContext
 * forked from the main loop). Provide explicit overrides to opt into
 * participation with the main session.
 */
export interface RunToolOptions {
  /** Aborts the dispatched tool call. Does not abort a pending run() ahead of it in the queue. */
  signal?: AbortSignal
  /** Override the toolContext. Defaults to a forked copy of the loop's main toolContext. */
  toolContext?: ToolContext
  /** Override the record stream. Defaults to an isolated in-memory stream. */
  recordStream?: RecordStream
  /** Override the turnId stamped on emitted records. Defaults to a fresh UUID. */
  turnId?: string
}

export interface AgentRunOverrides {
  allowedTools?: string[]
  model?: ActiveModelRuntime
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  hooks?: Hooks
  skillName?: string
  skillArgs?: string
  displayInput?: string
  /**
   * Stamped onto the user record when this run came from the message queue, so
   * a replay can tell that the queued message was already sent. See
   * `ChatMessage.sourceQueuedMessageId`.
   */
  sourceQueuedMessageId?: string
  /** Who drives this turn. Defaults to 'user'. */
  origin?: TurnOrigin
  /** Force a compaction check on iteration 0, ignoring the threshold (idle compaction). */
  compactBeforeSend?: boolean
}

interface ActiveRunOverrides {
  compactBeforeSend?: boolean
  allowedTools?: Set<string>
  tools?: Tool[]
  model?: ActiveModelRuntime
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  hooks?: Hooks
  displayInput?: string
  sourceQueuedMessageId?: string
  origin?: TurnOrigin
  skillInvocation?: {
    skillName: string
    skillArgs: string
    prompt: string
  }
}

export interface AgentLoopOptions {
  provider: ModelProvider
  model: string
  modelKey?: string
  contextWindow?: number
  tools: Tool[]
  contextBuilder: ContextBuilder
  toolRunner: ToolRunner
  toolContext: ToolContext
  system?: string
  projectContext?: string
  /** The memory section; kept apart from `projectContext`, which subagents inherit. */
  memoryPrompt?: string
  /** `MEMORY.md`, labelled; it opens the conversation alongside `projectContext`. */
  memoryIndex?: string
  criticalSystemReminder?: string
  skills?: SkillDefinition[]
  promptCacheRetention?: 'in_memory' | '24h'
  /** Effective image-input capability of the primary model; see `ActiveModelRuntime`. */
  supportsImageInput?: boolean
  /**
   * The session's attachment store, used to import @-mentioned project images
   * at input-preparation time. Absent where no store exists (test loops;
   * subagents until their ownership rules land) — image mentions then stay
   * plain text, exactly as before this option existed.
   */
  imageAttachments?: AtMentionImageImporter
  /**
   * Resolves stored attachment facts (original dimensions, cache path,
   * existence) for the request path's image rules: the current-input
   * availability check and the historical-image text projection. Absent where
   * no store exists — current-input files are then not re-checked at
   * submission, and historical placeholders fall back to the file-missing
   * wording only when they cannot be resolved at all.
   */
  attachmentFacts?: AttachmentFactsResolver
  /**
   * Loads send-version image bytes for the request path. Consulted only after
   * the final send decision (design §11.1 step 5) — compaction and the count
   * cap have already settled what the request carries, so no earlier phase
   * ever touches image bytes. Absent where no store exists (test loops;
   * subagents until their ownership rules land) — requests then carry image
   * refs without bytes, which a real payload builder refuses to send.
   */
  attachmentBytes?: AttachmentBytesLoader
  contextManagement?: Partial<ContextManagementConfig>
  isGitRepo?: boolean
  /**
   * Cap on tool iterations. Unset means unbounded — the main session relies on
   * the abort signal, the token budget and auto-compaction instead, so a long
   * task never loses its work to a turn counter (spec §3.2). Sub-agents pass a
   * value and get the old bounded behaviour.
   */
  maxTurns?: number
  maxTurnsExceededBehavior?: 'error' | 'partial'
  maxOutputTokens?: number
  tokenBudget?: number
  tokenWarningThreshold?: number
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  fallbackModel?: ActiveModelRuntime
  compactModel?: ActiveModelRuntime
  planModel?: ActiveModelRuntime
  fallbackRetryDelayMs?: number
  hooks?: Hooks
  cacheRuntime?: CacheRuntime
  cacheSource?: CacheBreakSource
  /**
   * A fork's inherited prefix: every request sends the parent's system, tools
   * and history byte for byte ahead of this loop's own records, so it reads
   * the parent's cache. The loop never auto-compacts under one — compacting
   * its own records cannot shrink what it inherited.
   */
  inheritedRequest?: ModelRequest
  preloadRecords?: SessionRecord[]
  permissionMode?(): PermissionMode
  planModeManager?: PlanModeManager
  getCompactFailureCount?(): Promise<number>
  setCompactFailureCount?(count: number): Promise<void>
  recordStream: RecordStream
  onRecord?(record: SessionRecord): void
  onStreamEvent?(event: ModelStreamEvent): void
  /**
   * One completed foreground request's usage, reported the moment the response
   * lands. Same value `statusUsage` carries at the end of the run — this only
   * makes every intermediate request visible too, so a status readout derived
   * from it moves per step instead of per turn. Subagent loops are built
   * without it (`AgentTool`), so their requests never retarget the parent's
   * readout.
   */
  onRequestUsage?(usage: TokenUsage, anchorRecordId?: string): void
  /** User-role messages appended verbatim at the start of each step. */
  consumePendingUserMessages?(): string[]
  /** The user's mid-turn messages, recorded into the running turn at each step. */
  steer?: SteerSource
  /** Fixed role segment for the static system prompt (coordinator lanes). */
  rolePrompt?: string
  compactPromptVariant?: CompactPromptVariant
  /**
   * A pending coordination update, taken at the start of each step. The loop
   * appends it as a durable record, then acks; a failed append leaves it pending.
   */
  consumeCoordinationUpdate?(): Promise<{ content: string; ack(): Promise<void> } | undefined>
  /** Leading block of the post-compact restore (the coordinator board). */
  coordinationRestore?(): Promise<string | undefined>
}

const MAX_RECOVERY_COUNT = 3
const DEFAULT_FALLBACK_RETRY_DELAY_MS = 5 * 60 * 1000
/** Safe calls in one response run at most this many at a time, so a burst of shell commands cannot swamp the machine. */
const MAX_CONCURRENT_TOOL_CALLS = 10

type TurnRetryStart = { readonly retryOf: Pick<TurnFailureRecord, 'id' | 'userMessageId'> }

export class AgentLoop {
  private readonly modelState: {
    current: ActiveModelRuntime
    primary: ActiveModelRuntime
    fallback?: ActiveModelRuntime
    fallbackActivatedAt?: number
  }
  private recordsCache: SessionRecord[] | undefined
  private recordsCacheHasCleanToolProtocol = false
  /** Frozen tool-result trim decisions; see `ToolResultTrimState`. */
  private trimState: ToolResultTrimState | undefined
  /**
   * The provider's count for the last foreground request and the record it
   * ended on. Kept across turns, so a turn's first compaction check adds the
   * new records to a real count instead of estimating the whole transcript.
   */
  private responseBaseline: { tokens: number; recordCount: number; recordId: string | undefined } | undefined
  private pendingSubagentTranscriptUsage: TokenUsage = { ...EMPTY_TOKEN_USAGE }
  private readonly pendingToolUseSummaries: PendingToolUseSummary[] = []
  // Serializes run() and runTool() against each other. Both helpers funnel
  // through enqueue() so that a tool dispatched via runTool cannot race a
  // concurrent run() and clobber shared state in the toolContext,
  // recordsCache, or recordStream.
  private inFlight: Promise<unknown> | null = null
  // Sticky for the rest of the session after any model switch: thinking
  // signatures are model/provider-bound, and prior primary/fallback thinking
  // blocks should not be replayed across either side of a fallback boundary.
  private stripAllThinkingBlocksFromRequests = false
  private activeRunOverrides: ActiveRunOverrides | undefined
  /** Last (capability x image set) state the loop notified about, for notice dedup. */
  private lastImageProjectionSignature: string | undefined
  /** Last (cap x kept set) media-strip state the loop notified about, same rule. */
  private lastMediaStripSignature: string | undefined
  /** Last (byte budget x kept set) request-size state, same once-per-state rule. */
  private lastImageByteStripSignature: string | undefined
  /**
   * Last combined image state the loop built a request from. When it moves —
   * capability flip, omitted-set change, cap change — the usage baseline
   * describes a request whose image content no longer matches, so the run
   * loop must re-estimate instead of reusing it (design §11.2).
   */
  private lastImageRequestSignature: string | undefined
  private imageRequestStateChanged = false
  /**
   * New (current-turn) images the last request build carried, straight from
   * the turn-image projection so "new" cannot mean two different things here
   * and there. Read when an automatic fallback asks whether it applies.
   */
  private currentRequestNewImages: ImageAttachmentRef[] = []
  private stepsSinceTaskTool = 0

  constructor(private readonly options: AgentLoopOptions) {
    const primary = {
      provider: options.provider,
      model: options.model,
      modelKey: options.modelKey,
      contextWindow: options.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
      providerName: options.provider.name,
      promptCacheRetention: options.promptCacheRetention,
      supportsImageInput: options.supportsImageInput,
    }
    this.modelState = {
      current: primary,
      primary,
      fallback: options.fallbackModel,
    }
    this.options.toolContext.appendMetric = (metric) => this.emitMetric(metric)
    // Live image-input capability for the Read tool's image branch: reads the
    // model actually serving the loop (fallback/plan/override switches
    // included), never a session-startup snapshot (design §9.1).
    this.options.toolContext.getSupportsImageInput = () => this.activeModel.supportsImageInput === true
    this.options.toolRunner.addRecordListener((record) => {
      this.noteRecordAppended(record)
    })
  }

  /**
   * The active model as a status display should name it, with one exception.
   *
   * Plan mode shows the *primary* model rather than the plan model: the switch
   * is transient and role-driven, and naming the plan model would read as the
   * session having changed models. `supportsImageInput` does not follow that
   * policy — it is a capability, not a label, and the UI gates whether images
   * can be attached at all on it. Reporting the primary model's capability while
   * a text-only plan model serves the request would offer an attachment the
   * provider then rejects, so the flag comes off the model that will actually
   * run — `requestModel`, which resolves plan routing before the turn starts
   * too, not just once a request is in flight.
   */
  /** The cheap model for side calls (naming, summaries): the compact route, else the primary. */
  getSideModel(): ActiveModelRuntime {
    return this.options.compactModel ?? this.modelState.primary
  }

  getActiveModel(): Omit<ActiveModelRuntime, 'provider'> {
    const visibleModel = this.isPlanModelActive() ? this.modelState.primary : this.activeModel
    return {
      model: visibleModel.model,
      modelKey: visibleModel.modelKey,
      contextWindow: visibleModel.contextWindow,
      providerName: visibleModel.providerName,
      promptCacheRetention: visibleModel.promptCacheRetention,
      supportsImageInput: this.requestModel.supportsImageInput,
    }
  }

  /**
   * The two context-window numbers a status display needs, read off the *active*
   * model rather than the configured one.
   *
   * `usable` is the autocompact threshold — the window minus the summary's
   * reserved output and the safety buffer — which is the only honest denominator
   * for "how full is the context": the turn that crosses it is compacted, so the
   * raw window is a number the conversation never reaches. Both come from
   * `activeContextManagement`, so a fallback or plan-model switch is reflected
   * immediately; `modelConfig.contextWindow` read from outside would still name
   * the model the runtime was built with.
   */
  getContextBudget(): { contextWindow: number; usableContextWindow: number } {
    const contextManagement = this.activeContextManagement
    return {
      contextWindow: getContextWindowForModel(contextManagement),
      usableContextWindow: getAutoCompactThreshold(contextManagement),
    }
  }

  clearCachedSections(key?: string): void {
    this.options.contextBuilder.clearCachedSections(key)
  }

  invalidateSkillsSection(): void {
    this.options.contextBuilder.invalidateSkillsSection()
  }

  invalidateRecordsCache(): void {
    this.recordsCache = undefined
    this.recordsCacheHasCleanToolProtocol = false
    this.responseBaseline = undefined
  }

  /** Update effort level at runtime; takes effect on the next turn. */
  setEffort(effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined): void {
    this.options.effort = effort
  }

  getEffort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
    return this.options.effort
  }

  noteRecordAppended(record: SessionRecord): void {
    this.recordsCache?.push(record)
    if (record.type === 'subagent_transcript') {
      this.pendingSubagentTranscriptUsage = addTokenUsage(this.pendingSubagentTranscriptUsage, record.usage)
      void this.emitMetric({ event: 'subagent_usage', model: record.model ?? '', usage: toMetricUsage(record.usage) })
    }
    if (record.type === 'tool_use' || record.type === 'tool_result') {
      this.recordsCacheHasCleanToolProtocol = false
    }
  }

  async run(userInput: UserInput, signal?: AbortSignal, messageId?: string, overrides?: AgentRunOverrides): Promise<AgentRunResult> {
    return this.enqueue(() => this.runWithOverrides(userInput, signal, messageId, overrides))
  }

  /**
   * Runs a failed turn again on its own user message: no new message, no
   * prompt hooks. What the turn finished before failing stays, so it carries
   * on from the request that failed.
   */
  async retry(failure: TurnRetryStart['retryOf'], signal?: AbortSignal): Promise<AgentRunResult> {
    return this.enqueue(() => this.runInternal({ retryOf: failure }, signal))
  }

  /**
   * Layer-2 submission preparation (design §9.2): the same new-image rule the
   * loop enforces, exposed for the session controller to call *before* it
   * emits turn-start, so a blocked submission never surfaces as a turn that
   * started and failed. Covers the input's explicit images only — @-mentioned
   * images are imported inside run(), where the same rule runs again before
   * any record exists. Reads live model state (an override model included),
   * so it cannot act on stale capability information.
   */
  assertImagesAllowedForSubmission(input: UserInput, overrides?: AgentRunOverrides): void {
    // The model that will actually serve the request, not the one the status
    // bar names: in plan mode with a text-only plan model, gating on the
    // primary would accept an attachment the request then has to reject
    // (design §9.1, last row).
    const model = overrides?.model ?? this.nextRoleModel()
    assertNewImagesAllowed(input.images, model.supportsImageInput, model.model)
    // The per-request count cap also gates submission, so an input that alone
    // exceeds it fails before anything is recorded — the request-path strip
    // re-checks with the model actually serving each iteration.
    const maxImages = resolveMaxMediaItems(model.provider.maxImagesPerRequest?.())
    if (input.images && input.images.length > maxImages) {
      throw new TurnImageBlockError(
        'too-many-images',
        [...input.images],
        formatTooManyImagesBlockedMessage(input.images.length, maxImages),
      )
    }
    // The request-size budget also gates submission, the same way (design
    // §11.1): an input whose images alone would serialize over the body limit
    // fails before anything is recorded. History and text only the request
    // build can know refine this at send time.
    assertInputImagesWithinRequestBody(
      input.images,
      resolveMaxRequestBodyBytes(model.provider.maxRequestBodyBytes?.()),
    )
  }

  async summarizeRecordsForRewind(records: SessionRecord[]): Promise<{ summary: string; usage?: TokenUsage; preTokens: number }> {
    return this.enqueue(async () => {
      const result = await summarizeRecordsForContinuation({
        records,
        provider: this.activeModel.provider,
        model: this.activeModel.model,
        compactRuntime: this.options.compactModel,
        promptCacheRetention: this.activeModel.promptCacheRetention,
        // Rewind summaries share the compaction image projection (design
        // §11.3): images in the summarized range become text placeholders.
        ...(this.options.attachmentFacts ? { attachmentFacts: this.options.attachmentFacts } : {}),
        cwd: this.dataRoot(),
        ...(this.options.compactPromptVariant ? { compactPromptVariant: this.options.compactPromptVariant } : {}),
      })
      return {
        summary: result.content,
        usage: result.usage,
        preTokens: result.preTokens,
      }
    })
  }

  /** `/compact`: summarizes the conversation now, between turns; throws when the summary fails. */
  async compact(instructions?: string): Promise<CompactCheckResult> {
    return this.enqueue(async () => {
      const turnId = randomUUID()
      const records = await this.loadPreparedRecords(turnId)
      const userMessageId = [...records].reverse().find((record) => record.type === 'message' && record.role === 'user')?.id ?? ''
      const cacheSource = this.options.cacheSource ?? agentCacheSource(this.options.toolContext.sessionId, this.dataRoot())
      return this.runCompaction(compactNow, records, turnId, userMessageId, cacheSource, instructions ? { compactInstructions: instructions } : {})
    })
  }

  private async runWithOverrides(
    userInput: UserInput,
    signal?: AbortSignal,
    messageId?: string,
    overrides?: AgentRunOverrides,
  ): Promise<AgentRunResult> {
    const previous = this.activeRunOverrides
    const previousSkillInvocation = this.options.toolContext.skillInvocation
    this.activeRunOverrides = this.normalizeRunOverrides(userInput, overrides)
    if (this.activeRunOverrides?.model && !this.isSameModel(this.activeRunOverrides.model, this.modelState.current)) {
      this.stripAllThinkingBlocksFromRequests = true
    }
    this.options.toolContext.skillInvocation = this.activeRunOverrides?.skillInvocation
    try {
      return await this.runInternal(userInput, signal, messageId)
    } finally {
      this.activeRunOverrides = previous
      this.options.toolContext.skillInvocation = previousSkillInvocation
    }
  }

  private normalizeRunOverrides(userInput: UserInput, overrides: AgentRunOverrides | undefined): ActiveRunOverrides | undefined {
    if (!overrides) return undefined
    const normalized: ActiveRunOverrides = {}
    if (overrides.allowedTools) {
      const allowed = new Set(overrides.allowedTools.map((tool) => tool.trim()).filter(Boolean))
      const known = new Set(this.options.tools.map((tool) => tool.name))
      const unknown = [...allowed].filter((tool) => !known.has(tool))
      if (unknown.length > 0) {
        throw new Error(`Unknown allowed tool${unknown.length === 1 ? '' : 's'} for skill command: ${unknown.join(', ')}`)
      }
      normalized.allowedTools = allowed
      normalized.tools = this.options.tools.filter((tool) => allowed.has(tool.name))
    }
    if (overrides.model) normalized.model = overrides.model
    if (overrides.effort) normalized.effort = overrides.effort
    if (overrides.hooks) normalized.hooks = overrides.hooks
    if (overrides.displayInput !== undefined && overrides.displayInput !== userInput.text) {
      normalized.displayInput = overrides.displayInput
    }
    if (overrides.origin) normalized.origin = overrides.origin
    if (overrides.compactBeforeSend) normalized.compactBeforeSend = true
    if (overrides.sourceQueuedMessageId) normalized.sourceQueuedMessageId = overrides.sourceQueuedMessageId
    if (overrides.skillName) {
      normalized.skillInvocation = {
        skillName: overrides.skillName,
        skillArgs: overrides.skillArgs ?? '',
        prompt: userInput.text,
      }
    }
    return Object.keys(normalized).length > 0 ? normalized : undefined
  }

  /**
   * Records one user input: its @-mentioned images, the new-image gates, the
   * user record, and its at-mention context. A refused input throws before
   * anything is recorded.
   */
  private async recordUserInput(
    userInput: UserInput,
    turnId: string,
    fields: Pick<ChatMessage, 'id' | 'displayContent' | 'sourceQueuedMessageId'>,
  ): Promise<ChatMessage & { type: 'message' }> {
    // Input preparation for @-mentioned images (design §7.1): import and bind
    // them to the user message *before* it is recorded. A failed explicit
    // image reference throws here — no user record, no at-mention record, the
    // draft survives in the shell — instead of degrading to plain text.
    const mentionImages = this.options.imageAttachments && !userInput.text.trimStart().startsWith('/')
      ? await collectAtMentionImages({
          userInput: userInput.text,
          toolContext: this.options.toolContext,
          importer: this.options.imageAttachments,
          existingImageCount: userInput.images?.length ?? 0,
        })
      : undefined
    if (mentionImages && mentionImages.errors.length > 0) {
      throw new Error(formatAtMentionImageErrors(mentionImages.errors))
    }
    const turnImages = mentionImages && mentionImages.images.length > 0
      ? [...(userInput.images ?? []), ...mentionImages.images]
      : userInput.images
    // New-image gate (design §9.2): runs before the user record exists, so a
    // blocked submission leaves the session untouched and the draft survives
    // in the shell. Queued inputs reach this gate only when they are actually
    // recorded — waiting never turns new images into degradable history.
    // Read off the model that will serve the next request — plan routing and
    // a temporary override included — so a text-only plan model blocks here
    // rather than after the user record exists (design §9.1, last row).
    const submissionModel = this.requestModel
    assertNewImagesAllowed(turnImages, submissionModel.supportsImageInput, submissionModel.model)
    await assertCurrentImagesAvailable(turnImages, this.options.attachmentFacts)
    // Request-size gate, same position (design §11.1): an input whose images
    // alone exceed the body limit never becomes a record.
    assertInputImagesWithinRequestBody(
      turnImages,
      resolveMaxRequestBodyBytes(submissionModel.provider.maxRequestBodyBytes?.()),
    )
    const userMessage: ChatMessage & { type: 'message' } = {
      type: 'message',
      ...fields,
      role: 'user',
      content: userInput.text,
      ...(turnImages && turnImages.length > 0 ? { images: turnImages } : {}),
      turnId,
      createdAt: new Date().toISOString(),
    }
    await this.appendRecord(userMessage)
    if (!userInput.text.trimStart().startsWith('/')) {
      const atMentionRecord = await buildAtMentionContextRecord({
        userInput: userInput.text,
        userMessageId: userMessage.id,
        turnId,
        toolContext: this.options.toolContext,
        createdAt: new Date().toISOString(),
      })
      if (atMentionRecord) {
        await this.appendRecord(atMentionRecord)
      }
    }
    return userMessage
  }

  private async recordTurnRetry(failure: TurnRetryStart['retryOf']): Promise<{ turnId: string; userMessage: ChatMessage & { type: 'message' } }> {
    const { records } = await this.loadRecordsOnce()
    const userMessage = records.find((record): record is ChatMessage & { type: 'message' } =>
      record.type === 'message' && record.role === 'user' && record.id === failure.userMessageId)
    if (!userMessage) throw new Error('The failed turn\'s message is no longer in this session.')
    const turnId = userMessage.turnId ?? randomUUID()
    await this.appendRecord({
      type: 'turn_retry',
      id: randomUUID(),
      failureId: failure.id,
      userMessageId: userMessage.id,
      turnId,
      createdAt: new Date().toISOString(),
    })
    return { turnId, userMessage }
  }

  /**
   * Steering: messages the user sent mid-turn join the turn at the next step,
   * in order. A slash command stops the walk — it runs as a turn of its own —
   * and so does a message the gates refuse; both, and everything behind them,
   * stay queued for the queue pump once the turn is over.
   */
  private async takeSteerMessages(turnId: string, signal?: AbortSignal): Promise<void> {
    const steer = this.options.steer
    if (!steer) return
    for (const message of steer.pending()) {
      // The message this turn started from; its removal may still be in flight.
      if (message.id === this.activeRunOverrides?.sourceQueuedMessageId) continue
      if (message.content.trimStart().startsWith('/')) return
      // A coordinator message never joins a turn someone else is driving; it
      // stays queued (and keeps the order) for the pump.
      if (message.origin === 'coordinator' && this.activeRunOverrides?.origin !== 'coordinator') return
      let userMessage: ChatMessage & { type: 'message' }
      try {
        userMessage = await this.recordUserInput(
          { text: message.content, ...(message.images && message.images.length > 0 ? { images: message.images } : {}) },
          turnId,
          { id: randomUUID(), sourceQueuedMessageId: message.id },
        )
      } catch {
        return
      }
      await steer.consume(message.id)
      await this.runUserPromptSubmitHooks(userMessageInput(userMessage), turnId, signal)
    }
  }

  /**
   * A pending coordination update joins the turn as a durable record at a step
   * boundary — after the previous step's tool results, never between a
   * tool_use and its result. Appended first, then acked: a failed ack only
   * means the same update may arrive again. Fail-open throughout.
   */
  private async takeCoordinationUpdate(turnId: string): Promise<void> {
    const consume = this.options.consumeCoordinationUpdate
    if (!consume) return
    let taken: { content: string; ack(): Promise<void> } | undefined
    try {
      taken = await consume()
    } catch {
      return
    }
    if (!taken?.content) return
    try {
      await this.appendRecord({
        type: 'coordination_update',
        id: randomUUID(),
        content: taken.content,
        turnId,
        createdAt: new Date().toISOString(),
      })
    } catch {
      return
    }
    try {
      await taken.ack()
    } catch {
      // The record is in place; the update stays pending and may repeat.
    }
  }

  private async coordinationRestore(): Promise<string | undefined> {
    try {
      return await this.options.coordinationRestore?.()
    } catch {
      return undefined
    }
  }

  private async runInternal(start: UserInput | TurnRetryStart, signal?: AbortSignal, messageId?: string): Promise<AgentRunResult> {
    let usage = { ...EMPTY_TOKEN_USAGE }
    let lastForegroundResponseUsage: TokenUsage | undefined
    let pendingAssistantStreamContent = ''
    this.pendingSubagentTranscriptUsage = { ...EMPTY_TOKEN_USAGE }
    this.currentRequestNewImages = []
    const retrying = 'retryOf' in start
    let turnId: string
    let userMessage: ChatMessage & { type: 'message' }
    if (retrying) {
      ({ turnId, userMessage } = await this.recordTurnRetry(start.retryOf))
    } else {
      turnId = randomUUID()
      userMessage = await this.recordUserInput(start, turnId, {
        id: messageId ?? randomUUID(),
        ...(this.activeRunOverrides?.displayInput ? { displayContent: this.activeRunOverrides.displayInput } : {}),
        ...(this.activeRunOverrides?.sourceQueuedMessageId
          ? { sourceQueuedMessageId: this.activeRunOverrides.sourceQueuedMessageId }
          : {}),
      })
    }
    // A turn woken by notifications alone carries on the request before it;
    // messages steered in mid-turn amend this one.
    if (!isSystemReminderBlock(userMessage.content)) this.options.toolContext.requestTurnId = turnId
    try {
      // A retry's prompt was already submitted; its hooks ran then.
      if (!retrying) await this.runUserPromptSubmitHooks(userMessageInput(userMessage), turnId, signal)
      const maxTurns = this.options.maxTurns
      const tokenBudget = this.options.tokenBudget
      const tokenWarnThreshold = this.options.tokenWarningThreshold ?? 0.8
      const cacheSource = this.options.cacheSource
        ?? agentCacheSource(this.options.toolContext.sessionId, this.dataRoot())

      let lastRequestId: string | undefined
      let maxOutputTokensOverride: number | undefined = this.options.maxOutputTokens
      let maxOutputTokensRecoveryCount = 0
      const responseSegments: string[] = []
      let lastAssistantContent = ''
      const resetModelRequestState = (modelChanged = true) => {
        lastRequestId = undefined
        // A model switch also invalidates the usage baseline: the previous
        // response's cost described a request shaped for the previous model
        // — its image-token strategy included (design §11.2) — so the next
        // estimate must be recomputed from the records. An image-state move on
        // the same model keeps it: omitting images only shrinks the request,
        // and new images sit in the pending records the estimate adds on.
        if (modelChanged) this.responseBaseline = undefined
        maxOutputTokensOverride = this.options.maxOutputTokens
        maxOutputTokensRecoveryCount = 0
      }

      for (let iteration = 0; maxTurns === undefined || iteration < maxTurns; iteration++) {
        // Check abort signal at the start of each iteration
        if (signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        const pendingUserMessages = this.options.consumePendingUserMessages?.() ?? []
        for (const message of pendingUserMessages) {
          await this.appendRecord({
            type: 'message',
            id: randomUUID(),
            role: 'user',
            content: message,
            turnId,
            createdAt: new Date().toISOString(),
          })
        }
        await this.takeCoordinationUpdate(turnId)
        await this.takeSteerMessages(turnId, signal)
        await this.options.planModeManager?.beforeTurn()
        if (this.syncRoleModel(cacheSource)) {
          resetModelRequestState()
        }
        await this.flushReadyToolUseSummaries(turnId)
        const preparedRecords = await this.loadPreparedRecords(turnId, userMessage.id)
        if (this.consumeImageRequestStateChanged()) resetModelRequestState(false)
        const imageTokenStrategy = resolveImageTokenStrategy(
          this.activeModel.providerName,
          this.activeModel.supportsImageInput,
        )
        const interruptionContext = await this.consumeTurnInterruptionContext(preparedRecords, userMessage.content)
        const progressive = applyProgressiveCompaction({
          records: preparedRecords,
          system: this.options.system,
          contextManagement: this.activeContextManagement,
          lastResponseTokenCount: this.responseBaseline?.tokens,
          lastResponseRecordCount: this.responseBaseline?.recordCount,
          lastResponseRecordId: this.responseBaseline?.recordId,
          imageTokenStrategy,
          now: new Date(),
          trimState: this.trimState,
          turnId,
        })
        await this.appendPendingTrimRecords()
        let recordsBeforeCompact = progressive.records
        const compactResult = await this.runCompaction(autoCompactIfNeeded, recordsBeforeCompact, turnId, userMessage.id, cacheSource, {
          lastResponseTokenCount: progressive.lastResponseTokenCount,
          lastResponseRecordCount: this.responseBaseline?.recordCount,
          lastResponseRecordId: this.responseBaseline?.recordId,
          ...(iteration === 0 && this.activeRunOverrides?.compactBeforeSend === true ? { force: true } : {}),
        }, signal)
        usage = addTokenUsage(usage, compactResult.usage)

      if (this.retryPrimaryIfReady(cacheSource)) {
        resetModelRequestState()
        if (this.syncRoleModel(cacheSource)) {
          resetModelRequestState()
        }
        recordsBeforeCompact = await this.loadPreparedRecords(turnId, userMessage.id)
        if (this.consumeImageRequestStateChanged()) resetModelRequestState(false)
      }

      const records = await this.materializePostCompactRestore(recordsBeforeCompact)
      const baseRequest = await this.buildModelRequest(records, turnId, userMessage.id, cacheSource, {
        includeUserContext: true,
        permissionMode: this.options.permissionMode?.(),
        // Called once the images are in: a one-shot attachment is not spent on
        // a request that never got built.
        transientUserContext: () => [this.options.planModeManager?.getActivePlanAttachment(), interruptionContext]
          .filter((item): item is string => Boolean(item)),
      })
      const requestRecordCount = records.length
      const canReuseResponseTokenEstimate = !compactResult.compacted
      pendingAssistantStreamContent = ''

      const modelRequest: ModelRequest = {
        ...baseRequest,
        maxOutputTokens: maxOutputTokensOverride,
        previousRequestId: lastRequestId,
        retry: { signal },
        onTextDelta: (delta: string) => {
          pendingAssistantStreamContent += delta
        },
        onStreamEvent: (event: ModelStreamEvent) => {
          this.options.onStreamEvent?.(event)
        },
      }

      let response
      const modelStartedAt = Date.now()
      try {
        response = await this.activeModel.provider.createMessage(modelRequest)
        pendingAssistantStreamContent = ''
      } catch (error) {
        if (error instanceof FallbackTriggeredError) {
          const outcome = this.activateFallback(cacheSource)
          if (outcome === 'activated') {
            pendingAssistantStreamContent = ''
            resetModelRequestState()
            continue
          }
          if (outcome === 'blocked-by-images') {
            throw new FallbackNotApplicableForImagesError(
              error.originalError ?? error,
              this.modelState.fallback?.model ?? 'the fallback model',
              this.currentRequestNewImages,
            )
          }
        }
        throw error
      }

      usage = addTokenUsage(usage, response.usage)
      if (response.usage) {
        this.options.toolContext._forkPrefix = {
          request: durablePrefix(modelRequest),
          promptTokens: promptTokens(response.usage),
          usableContextWindow: this.getContextBudget().usableContextWindow,
        }
      }
      lastForegroundResponseUsage = response.usage
      // Per request, not per turn: this is the only point where the provider's
      // own count for the context just sent is known, and a multi-step turn
      // passes through it once per step.
      // The anchor is the last record this request carried, so a reader can add
      // the estimate for everything appended after it to the provider's own
      // count and get a context readout that keeps up mid-turn.
      if (response.usage) this.options.onRequestUsage?.(response.usage, records.at(-1)?.id)
      await this.emitTurnMetric(modelStartedAt, response.usage ?? EMPTY_TOKEN_USAGE, response.toolCalls.length)
      const responseTokens = canReuseResponseTokenEstimate ? requestTokenCountFromUsage(response.usage) : undefined
      this.responseBaseline = responseTokens === undefined
        ? undefined
        : { tokens: responseTokens, recordCount: requestRecordCount, recordId: records.at(-1)?.id }
      lastRequestId = response.requestId
      if (response.cacheBreak) {
        await this.emitMetric({
          event: 'cache_break',
          source: response.cacheBreak.source,
          reasons: response.cacheBreak.reasons,
          drop_tokens: response.cacheBreak.tokenDrop,
        })
      }

      if (response.usage) {
        // Cache-break detection itself is owned by anthropicProvider via
        // checkResponseForCacheBreak (cause-aware). Loop only emits the
        // hit-rate summary for debug visibility on every provider.
        if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
          console.error(`[hanekawa][cache] ${formatCacheHitRate(response.usage)}`)
        }
      }

      const assistantMessage: ChatMessage & { type: 'message' } = {
        type: 'message',
        id: randomUUID(),
        role: 'assistant',
        content: response.content,
        turnId,
        createdAt: new Date().toISOString(),
        model: this.activeModel.model,
        ...(response.reasoningContent ? { reasoningContent: response.reasoningContent } : {}),
        ...(response.thinkingBlocks && response.thinkingBlocks.length > 0
          ? { thinkingBlocks: response.thinkingBlocks }
          : {}),
        ...(response.reasoningDetails?.length ? { reasoningDetails: response.reasoningDetails } : {}),
        ...(response.responseItems?.length ? { responseItems: response.responseItems } : {}),
      }

      // max_output_tokens escalation: retry with higher limit
      if (response.stopReason === 'max_tokens') {
        if (maxOutputTokensOverride === undefined) {
          maxOutputTokensOverride = ESCALATED_MAX_TOKENS
          continue
        }

        await this.appendRecord(assistantMessage)
        const maxTokensContent = appendResponseSegment(responseSegments, response.content)
        if (maxOutputTokensRecoveryCount < MAX_RECOVERY_COUNT) {
          await this.appendRecord({
            type: 'message',
            id: randomUUID(),
            role: 'user',
            content: buildMaxTokensContinuationReminder(this.options.toolContext.taskState),
            turnId,
            createdAt: new Date().toISOString(),
          })
          maxOutputTokensRecoveryCount++
          continue
        }

        const finished = await this.finishTurn({
          content: maxTokensContent,
          usage,
          turnId,
          signal,
          stopReason: 'max_tokens',
          truncated: true,
          segments: [...responseSegments],
          statusUsage: lastForegroundResponseUsage,
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      const responseContent = combineResponseSegments(responseSegments, response.content)
      lastAssistantContent = responseContent

      // Token budget check
      const cumulativeTokens = requestTokenCountFromUsage(usage) ?? 0
      if (tokenBudget && cumulativeTokens > tokenBudget) {
        const finished = await this.finishTurn({
          content: `${responseContent}\n\n[Token budget exceeded: ${cumulativeTokens} > ${tokenBudget}]`,
          usage,
          turnId,
          signal,
          segments: segmentsWithFinalResponse(responseSegments, response.content),
          statusUsage: lastForegroundResponseUsage,
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      // Token warning
      if (
        tokenBudget &&
        cumulativeTokens > tokenBudget * tokenWarnThreshold &&
        response.toolCalls.length > 0
      ) {
        const pct = Math.round((cumulativeTokens / tokenBudget) * 100)
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: wrapInSystemReminder(`Token budget at ${pct}%. Finish the current task and stop using tools.`),
          turnId,
          createdAt: new Date().toISOString(),
        })
      }

      if (response.toolCalls.length === 0) {
        await this.appendRecord(assistantMessage)
        const finished = await this.finishTurn({
          content: responseContent,
          usage,
          turnId,
          signal,
          segments: segmentsWithFinalResponse(responseSegments, response.content),
          statusUsage: lastForegroundResponseUsage,
        })
        if (finished.continueLoop) continue
        return finished.result
      }

      await this.appendRecord(assistantMessage)

      // Check abort signal before executing tools
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const toolResults = await this.runToolCallsInOrder(response.toolCalls, signal, turnId)
      this.options.planModeManager?.noteToolUseTurn()
      usage = addTokenUsage(usage, this.drainSubagentTranscriptUsage())
      this.startToolUseSummary(toolResults, turnId)

      // Track discovered tool names from ToolSearch results
      this.trackDiscoveredTools(toolResults)

      if (toolResults.length > 0 && toolResults.every((r) => !r.ok)) {
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: wrapInSystemReminder('All tool calls in the previous turn failed. Review the errors above and decide how to proceed — try a different approach, ask the user for help, or report the failures.'),
          turnId,
          createdAt: new Date().toISOString(),
        })
      }

      const taskReminder = this.noteTaskToolStep(response.toolCalls)
      if (taskReminder) {
        await this.appendRecord({
          type: 'message',
          id: randomUUID(),
          role: 'user',
          content: taskReminder,
          turnId,
          createdAt: new Date().toISOString(),
        })
      }
      }

      // Only reachable with an explicit maxTurns; without one the loop above
      // never falls through.
      if (maxTurns !== undefined && this.options.maxTurnsExceededBehavior === 'partial') {
        const content = buildMaxTurnsExceededContent(lastAssistantContent, maxTurns)
        const finished = await this.finishTurn({
          content,
          usage,
          turnId,
          signal,
          stopReason: 'max_turns',
          truncated: true,
          segments: content ? [content] : undefined,
          statusUsage: lastForegroundResponseUsage,
        })
        if (!finished.continueLoop) return finished.result
        return finishResult({
          content,
          usage,
          stopReason: 'max_turns',
          truncated: true,
          segments: content ? [content] : undefined,
          statusUsage: lastForegroundResponseUsage,
        })
      }

      throw new Error('Agent loop exceeded maximum tool iterations')
    } catch (error) {
      if (isAbortError(error) && isUserCancelAbort(signal)) {
        await this.appendPartialAssistantMessage(pendingAssistantStreamContent, turnId)
        pendingAssistantStreamContent = ''
        await this.appendTurnInterruption(userMessage, turnId)
      }
      throw error
    }
  }

  /** Counts tool-calling responses since the last task tool call; due every `TASK_REMINDER_STEPS` while tasks remain open. */
  private noteTaskToolStep(toolCalls: readonly ToolCall[]): string | undefined {
    if (toolCalls.some((call) => TASK_TOOL_NAMES.has(call.name))) {
      this.stepsSinceTaskTool = 0
      return undefined
    }
    if (++this.stepsSinceTaskTool < TASK_REMINDER_STEPS) return undefined
    this.stepsSinceTaskTool = 0
    return buildTaskReminder(this.options.toolContext.taskState)
  }

  private async consumeTurnInterruptionContext(records: readonly SessionRecord[], userInput: string): Promise<string | undefined> {
    const interruption = [...records]
      .reverse()
      .find((record) => record.type === 'turn_interruption' && record.recoverable && !record.consumedAt)
    if (!interruption || interruption.type !== 'turn_interruption') return undefined

    const intent = classifyInterruptionIntent(userInput)
    await this.consumeTurnInterruption(interruption.id)

    const remaining = interruption.remainingTasks.length > 0
      ? interruption.remainingTasks.map((task) => `- #${task.id} [${task.status}] ${task.subject}`).join('\n')
      : '- No tracked remaining tasks.'

    if (intent === 'continue') {
      return wrapInSystemReminder([
        'The previous turn was interrupted by the user and is now being resumed. Continue from where you left off, but do not blindly repeat tool calls that already completed.',
        `Interrupted prompt:\n${interruption.prompt}`,
        `Remaining tracked tasks:\n${remaining}`,
        'Before doing more work, inspect or update TaskList so task status reflects the resumed state.',
      ].join('\n'))
    }

    if (intent === 'abandon') {
      return wrapInSystemReminder([
        'The previous interrupted turn has been abandoned by the user. Do not resume or replay it unless the user asks again.',
        `Previously remaining tracked tasks:\n${remaining}`,
      ].join('\n'))
    }

    return wrapInSystemReminder([
      'There is an interrupted prior turn, but the user has provided a new request. Do not automatically replay the interrupted prompt.',
      `Interrupted prompt:\n${interruption.prompt}`,
      `Previously remaining tracked tasks:\n${remaining}`,
      'Treat those tasks as context only; follow the latest user request.',
    ].join('\n'))
  }

  private async consumeTurnInterruption(recordId: string): Promise<void> {
    try {
      await this.options.recordStream.update?.(recordId, (record) => {
        if (record.type !== 'turn_interruption') return record
        return {
          ...record,
          recoverable: false,
          consumedAt: new Date().toISOString(),
        }
      })
      this.recordsCache = this.recordsCache?.map((record) => {
        if (record.type !== 'turn_interruption' || record.id !== recordId) return record
        return {
          ...record,
          recoverable: false,
          consumedAt: new Date().toISOString(),
        }
      })
    } catch (error) {
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error(`[hanekawa][interrupt] failed to consume interruption ${recordId}:`, error)
      }
    }
  }

  private async appendTurnInterruption(userMessage: ChatMessage & { type: 'message' }, turnId: string): Promise<void> {
    if (this.recordsCache?.some((record) => record.type === 'turn_interruption' && record.turnId === turnId)) return
    await this.appendRecord({
      id: randomUUID(),
      type: 'turn_interruption',
      turnId,
      userMessageId: userMessage.id,
      prompt: userMessage.content,
      ...(userMessage.images && userMessage.images.length > 0 ? { images: userMessage.images } : {}),
      remainingTasks: remainingTasksFromState(this.options.toolContext.taskState),
      recoverable: true,
      createdAt: new Date().toISOString(),
    })
  }

  private async appendPartialAssistantMessage(content: string, turnId: string): Promise<void> {
    if (content.trim().length === 0) return
    await this.appendRecord({
      type: 'message',
      id: randomUUID(),
      role: 'assistant',
      content,
      turnId,
      createdAt: new Date().toISOString(),
      model: this.activeModel.model,
    })
  }

  /**
   * Run a single tool call out-of-band. By default the call is fully isolated
   * from the main loop: it gets its own in-memory record stream (so tool_use,
   * tool_approval, and tool_result records do not pollute the main session's
   * persisted JSONL or the records cache), and a forked toolContext (so
   * mutable state — readFiles, readFileState, invokedSkills, taskState — is
   * not shared with the main loop's pending or future run()).
   *
   * Calls are serialized against run() and other runTool() invocations via
   * the loop's in-flight gate. If a concurrent run() is in progress, this
   * call waits for it to finish before executing.
   *
   * Use this for diagnostic dispatch that should leave no trace in the main
   * conversation. Pass `recordStream` and/or `toolContext`
   * explicitly only if you actually want the call to participate in the main
   * session — e.g. tests asserting record persistence.
   */
  async runTool(call: ToolCall, options?: RunToolOptions): Promise<ToolResultRecord> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    return this.enqueue(() => this.runToolInternal(call, options))
  }

  private async runToolInternal(call: ToolCall, options?: RunToolOptions): Promise<ToolResultRecord> {
    if (options?.signal?.aborted) {
      throw new DOMException('The operation was aborted.', 'AbortError')
    }

    const recordStream: RecordStream = options?.recordStream ?? new MemoryRecordStream()
    const toolContext = options?.toolContext ?? this.forkToolContext()
    const turnId = options?.turnId ?? randomUUID()

    const isolatedRunner = this.options.toolRunner.fork({
      onRecord: async (record) => {
        await recordStream.append(record)
      },
    })

    return isolatedRunner.run(call, toolContext, options?.signal, turnId)
  }

  /**
   * Produce a shallow-but-collection-cloned copy of the configured
   * toolContext. Sets and Maps are duplicated so mutations performed by an
   * out-of-band tool call do not leak back into the main loop's view of
   * which files have been read, what skills have been invoked, or the
   * current task list. The returned context omits transient fields
   * (abortSignal, appendRecord) which the ToolRunner installs per-call.
   */
  /** Key for project data dirs (spill, diagnostics): the project, not a worktree. */
  private dataRoot(): string {
    return this.options.toolContext.projectDir ?? this.options.toolContext.cwd
  }

  private forkToolContext(): ToolContext {
    const source = this.options.toolContext
    const fork: ToolContext = {
      cwd: source.cwd,
      ...(source.projectDir ? { projectDir: source.projectDir } : {}),
      sessionId: source.sessionId,
      readFiles: new Set(source.readFiles),
    }
    if (source.readFileState) fork.readFileState = new Map(source.readFileState)
    if (source.invokedSkills) fork.invokedSkills = new Map(source.invokedSkills)
    if (source.taskState) fork.taskState = new Map(source.taskState)
    if (source.planModeBridge) fork.planModeBridge = source.planModeBridge
    if (source.askUserQuestionBridge) fork.askUserQuestionBridge = source.askUserQuestionBridge
    if (source.imageAttachments) fork.imageAttachments = source.imageAttachments
    if (source.getSupportsImageInput) fork.getSupportsImageInput = source.getSupportsImageInput
    return fork
  }

  /**
   * Funnel run() and runTool() through a single in-flight slot. New work
   * waits for any prior work to settle (success or failure) before starting,
   * which guarantees neither helper races on shared state. The slot is
   * cleared in finally regardless of outcome.
   */
  private async enqueue<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.inFlight
    if (previous) {
      try {
        await previous
      } catch {
        // Prior work's failure is the prior caller's concern. We only need
        // sequencing here, not error propagation.
      }
    }
    const current = (async () => work())()
    this.inFlight = current
    try {
      return await current
    } finally {
      if (this.inFlight === current) {
        this.inFlight = null
      }
    }
  }

  /**
   * Loads the send-version bytes for the images the final request still
   * carries (design §11.1 step 5): runs after the capability projection, the
   * count cap, and compaction have all settled what stays, so bytes load
   * exactly once per request build and no earlier phase ever touches them.
   *
   * A ref whose files cannot be loaded follows the same layering as the
   * capability projection: one on the current turn blocks the request —
   * current pixels are never dropped silently — while history degrades to the
   * file-missing placeholder. That substitution is a pure projection over
   * this request's record copies; JSONL and the records cache keep their refs.
   */
  private async prepareRequestImages(
    records: SessionRecord[],
    currentTurnId: string,
    currentUserMessageId: string,
    preloadRecords?: SessionRecord[],
  ): Promise<{
    records: SessionRecord[]
    preloadRecords?: SessionRecord[]
    imageBytes?: Map<string, RequestImageBytes>
  }> {
    const unchanged = { records, ...(preloadRecords ? { preloadRecords } : {}) }
    const bearing: Array<SessionRecord & { images: ImageAttachmentRef[] }> = []
    const refs = new Map<string, { ref: ImageAttachmentRef; currentTurn: boolean }>()
    // Preloaded records are scanned with the session's own, so an inherited
    // image that survived the capability projection gets real bytes loaded for
    // it — and one whose files are gone degrades to the same placeholder
    // instead of being sent as a ref with nothing behind it.
    for (const record of [...(preloadRecords ?? []), ...records]) {
      if (record.type !== 'message' && record.type !== 'tool_result') continue
      if (!record.images || record.images.length === 0) continue
      const currentTurn = recordIsCurrentTurn(record, currentTurnId, currentUserMessageId)
      bearing.push(record as SessionRecord & { images: ImageAttachmentRef[] })
      for (const ref of record.images) {
        const prior = refs.get(ref.id)
        refs.set(ref.id, { ref, currentTurn: (prior?.currentTurn ?? false) || currentTurn })
      }
    }
    if (refs.size === 0) return unchanged
    const loader = this.options.attachmentBytes
    if (!loader) return unchanged

    const loaded = await Promise.all([...refs.values()].map(async ({ ref }) => {
      const result = await loader.readSendBytes(ref)
      return { ref, result }
    }))
    const imageBytes = new Map<string, RequestImageBytes>()
    const missingIds = new Set<string>()
    for (const { ref, result } of loaded) {
      if (result.ok) imageBytes.set(ref.id, result.value)
      else missingIds.add(ref.id)
    }
    if (missingIds.size === 0) return { ...unchanged, imageBytes }

    const missingCurrent = [...refs.values()]
      .filter((entry) => entry.currentTurn && missingIds.has(entry.ref.id))
      .map((entry) => entry.ref)
    if (missingCurrent.length > 0) {
      const plural = missingCurrent.length === 1 ? '' : 's'
      throw new TurnImageBlockError(
        'file-missing',
        missingCurrent,
        `${missingCurrent.length} image${plural} referenced by this turn ${missingCurrent.length === 1 ? 'is' : 'are'} no longer available `
          + `in the session's attachment store (${missingCurrent.map((ref) => ref.name).join(', ')}). `
          + `The turn was stopped before this request was sent; re-attach the image${plural} and resend.`,
      )
    }

    if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
      console.error(
        `[hanekawa][image-send] ${missingIds.size} historical image${missingIds.size === 1 ? '' : 's'} `
          + `could not be loaded and will be sent as file-missing placeholders`,
      )
    }

    // Pure projection, the same shape mediaStrip's omissions take: every
    // occurrence of an unloadable historical ref keeps its slot as text.
    const projectionsByRecordId = new Map<
      string,
      { rest: SessionRecord; keptImages: ImageAttachmentRef[]; blocks: string[] }
    >()
    for (const record of bearing) {
      const missingRefs = record.images.filter((ref) => missingIds.has(ref.id))
      if (missingRefs.length === 0) continue
      const keptImages = record.images.filter((ref) => !missingIds.has(ref.id))
      const { images: _images, ...rest } = record
      projectionsByRecordId.set(record.id, {
        rest,
        keptImages,
        blocks: missingRefs.map((ref) => formatMissingHistoricalImagePlaceholder(ref)),
      })
    }
    const applyProjection = (source: SessionRecord[]): SessionRecord[] => source.map((record) => {
      const projection = projectionsByRecordId.get(record.id)
      if (!projection) return record
      // Only message/tool_result records reach this map entry; the cast keeps
      // the destructure honest for the union TS cannot narrow here.
      const rest = projection.rest as SessionRecord & { content: string }
      return {
        ...rest,
        ...(projection.keptImages.length > 0 ? { images: projection.keptImages } : {}),
        content: appendPlaceholderBlocks(rest.content, projection.blocks),
      } as SessionRecord
    })
    return {
      records: applyProjection(records),
      ...(preloadRecords ? { preloadRecords: applyProjection(preloadRecords) } : {}),
      imageBytes,
    }
  }

  /**
   * The per-request image rules applied to the fork preload — the parent
   * transcript a fork subagent inherits (design §12.3).
   *
   * The preload never passes through `loadPreparedRecords`: it is not this
   * session's log, and it must not be compacted, repaired, or written back. So
   * the capability projection has to be applied here, or an inherited image
   * would reach a model that may not accept images at all.
   *
   * Every preloaded record is history by construction — nothing in it carries
   * this loop's turn id — so there is no current-turn exemption to grant: a
   * text-only child degrades all of them to placeholders on *its own*
   * capability, never on the parent's conclusion. The count and byte caps stay
   * on the session's own records; the preload is already bounded by the fork's
   * token budget before it gets here.
   */
  private async projectPreloadImages(currentTurnId: string): Promise<SessionRecord[] | undefined> {
    const preload = this.options.preloadRecords
    if (!preload || preload.length === 0) return preload
    const projection = await projectTurnImagesForRequest({
      records: preload,
      currentTurnId,
      supportsImageInput: this.activeModel.supportsImageInput,
      modelLabel: this.activeModel.model,
      ...(this.options.attachmentFacts ? { resolveAttachmentFacts: this.options.attachmentFacts } : {}),
    })
    return projection.records
  }

  /**
   * Straight to the stream: a trim record is request-prep bookkeeping, not
   * transcript content, so it stays out of the records cache and the UI.
   */
  private async appendPendingTrimRecords(): Promise<void> {
    for (const record of this.trimState?.takePendingRecords() ?? []) {
      await this.options.recordStream.append(record)
    }
  }

  private async loadPreparedRecords(turnId?: string, userMessageId?: string): Promise<SessionRecord[]> {
    const loaded = await this.loadRecordsOnce()
    const imageTokenStrategy = resolveImageTokenStrategy(
      this.activeModel.providerName,
      this.activeModel.supportsImageInput,
    )
    // Built from the log the first time through, before this turn's results
    // exist: everything already there was already sent, so it freezes as-is.
    this.trimState ??= ToolResultTrimState.fromRecords(loaded.records)
    const prepared = prepareRecordsForRequestWithDiagnostics(
      loaded.records,
      this.activeContextManagement,
      new Date(),
      {
        repairToolPairing: !this.recordsCacheHasCleanToolProtocol,
        imageTokenStrategy,
        trimState: this.trimState,
        spillDir: getToolResultSpillDir(this.dataRoot(), this.options.toolContext.sessionId),
        ...(turnId ? { turnId } : {}),
        ...(this.stripAllThinkingBlocksFromRequests ? { stripAllThinkingBlocks: true } : {}),
      },
    )
    await this.appendPendingTrimRecords()
    if (!prepared.diagnostics.some((diagnostic) => diagnostic.code === 'tool_protocol_repaired')) {
      this.recordsCacheHasCleanToolProtocol = true
    }
    logDiagnostics([...loaded.diagnostics, ...prepared.diagnostics])
    if (!turnId) return prepared.records
    // Per-request image rules (design §9.1, §11.1): history degrades to text
    // placeholders for a text-only model, new images never do. Runs after
    // pairing repair and before compaction, on the model actually serving this
    // iteration — a fallback, plan, or retry-primary switch re-derives it —
    // and is a pure projection: the records cache and JSONL keep their images.
    const projection = await projectTurnImagesForRequest({
      records: prepared.records,
      currentTurnId: turnId,
      currentUserMessageId: userMessageId,
      supportsImageInput: this.activeModel.supportsImageInput,
      modelLabel: this.activeModel.model,
      ...(this.options.attachmentFacts ? { resolveAttachmentFacts: this.options.attachmentFacts } : {}),
    })
    // The image-count cap runs on what the projection left in the request
    // (design §11.1: projection before budget): history, current input, and
    // tool images all count; a lower adapter limit tightens the local cap;
    // the oldest history leaves first and this turn's images are protected.
    const stripped = stripExcessMediaItems(projection.records, {
      currentTurnId: turnId,
      ...(userMessageId ? { currentUserMessageId: userMessageId } : {}),
      maxMediaItems: resolveMaxMediaItems(this.activeModel.provider.maxImagesPerRequest?.()),
    })
    // The request-size budget (design §11.1 step 3, the volume half the count
    // cap above does not see): the body limit minus the estimated text bytes
    // is what the images may serialize into, and the oldest history leaves the
    // request first when they would not fit. Metadata-only estimate — the
    // bytes of whatever survives load in step 5, and the provider's final
    // check measures the real serialized body.
    const byteStripped = this.stripExcessImageBytesForRequest(stripped.records, turnId, userMessageId)
    if (
      process.env.MYAGENT_DEBUG_PROVIDER === '1'
      && (stripped.keptImageCount + stripped.omittedImages.length > 0
        || byteStripped.omittedImages.length > 0)
    ) {
      console.error(
        `[hanekawa][image-tokens] strategy=${describeImageTokenStrategy(imageTokenStrategy)}, `
        + `kept=${stripped.keptImageCount}, omitted=${stripped.omittedImages.length}, cap=${stripped.maxMediaItems}`
        + (byteStripped.omittedImages.length > 0
          ? `, bytesOmitted=${byteStripped.omittedImages.length}, byteBudget=${byteStripped.maxImageRequestBytes}`
          : ''),
      )
    }
    this.currentRequestNewImages = projection.newImages
    this.noteImageProjection(projection)
    this.noteMediaStrip(stripped)
    this.noteImageByteStrip(byteStripped)
    this.noteImageRequestState(projection, stripped, byteStripped)
    return byteStripped.records
  }

  /**
   * The byte-budget pass for one request build. Image-free records return
   * untouched without paying for the text estimate — the common case pays
   * nothing.
   */
  private stripExcessImageBytesForRequest(
    records: SessionRecord[],
    turnId?: string,
    userMessageId?: string,
  ): ImageByteStripResult {
    const carriesImages = records.some(
      (record) => (record.type === 'message' || record.type === 'tool_result')
        && record.images !== undefined && record.images.length > 0,
    )
    if (!carriesImages) {
      return { records, omittedImages: [], keptImageBytes: 0, maxImageRequestBytes: 0, signature: 'no-images' }
    }
    const maxRequestBodyBytes = resolveMaxRequestBodyBytes(this.activeModel.provider.maxRequestBodyBytes?.())
    const textBytes = estimateRequestTextBytes(records, {
      system: this.options.system,
      tools: this.currentTools,
    })
    return stripExcessImageBytes(records, {
      ...(turnId ? { currentTurnId: turnId } : {}),
      ...(userMessageId ? { currentUserMessageId: userMessageId } : {}),
      maxImageRequestBytes: Math.max(
        0,
        maxRequestBodyBytes - textBytes - requestContextReserveBytes(maxRequestBodyBytes),
      ),
    })
  }

  /**
   * Notifies once per distinct (capability, image set) degradation — not per
   * tool step or per turn — and stays quiet when a capable model takes over
   * again, while still remembering that state so re-degrading the same set
   * later notifies again.
   */
  private noteImageProjection(projection: RequestImageProjection): void {
    if (projection.signature === this.lastImageProjectionSignature) return
    this.lastImageProjectionSignature = projection.signature
    if (projection.projectedImageCount === 0) return
    this.options.onStreamEvent?.({
      type: 'image_capability_notice',
      message: formatHistoricalProjectionNotice(projection.projectedImageCount, projection.missingImageCount),
      omittedImageCount: projection.projectedImageCount,
      ...(projection.missingImageCount > 0 ? { missingImageCount: projection.missingImageCount } : {}),
    })
  }

  /** Same once-per-state rule for count-cap omissions (design §11.1 step 3). */
  private noteMediaStrip(strip: MediaStripResult): void {
    if (strip.signature === this.lastMediaStripSignature) return
    this.lastMediaStripSignature = strip.signature
    if (strip.omittedImages.length === 0) return
    this.options.onStreamEvent?.({
      type: 'media_limit_notice',
      message: formatMediaStripNotice(strip.omittedImages.length, strip.maxMediaItems),
      omittedImageCount: strip.omittedImages.length,
      maxImages: strip.maxMediaItems,
    })
  }

  /** Same once-per-state rule for request-size omissions (design §11.1 step 3). */
  private noteImageByteStrip(strip: ImageByteStripResult): void {
    if (strip.signature === this.lastImageByteStripSignature) return
    this.lastImageByteStripSignature = strip.signature
    if (strip.omittedImages.length === 0) return
    this.options.onStreamEvent?.({
      type: 'request_size_notice',
      message: formatImageByteStripNotice(strip.omittedImages.length, strip.maxImageRequestBytes),
      omittedImageCount: strip.omittedImages.length,
      maxImageRequestBytes: strip.maxImageRequestBytes,
    })
  }

  /**
   * Remembers the image state the request was built from. Any move —
   * capability flip, a different omitted set or a different cap — means the
   * next request no longer continues the previous one, so the per-request
   * state resets. Model switches cover this too (via the model-request reset),
   * so this catches the image-only changes between them.
   */
  private noteImageRequestState(
    projection: RequestImageProjection,
    strip: MediaStripResult,
    byteStrip: ImageByteStripResult,
  ): void {
    const signature = `${projection.signature}|${strip.signature}|${byteStrip.signature}`
    if (this.lastImageRequestSignature !== undefined && signature !== this.lastImageRequestSignature) {
      this.imageRequestStateChanged = true
    }
    this.lastImageRequestSignature = signature
  }

  private consumeImageRequestStateChanged(): boolean {
    if (!this.imageRequestStateChanged) return false
    this.imageRequestStateChanged = false
    return true
  }

  private async loadRecordsOnce(): Promise<{ records: SessionRecord[]; diagnostics: RuntimeDiagnostic[] }> {
    if (this.recordsCache) {
      return { records: this.recordsCache, diagnostics: [] }
    }

    const loaded = this.options.recordStream.loadWithDiagnostics
      ? await this.options.recordStream.loadWithDiagnostics()
      : { records: await this.options.recordStream.load(), diagnostics: [] }
    this.recordsCache = [...loaded.records]
    this.recordsCacheHasCleanToolProtocol = false
    return { records: this.recordsCache, diagnostics: loaded.diagnostics }
  }

  private async appendRecord(record: SessionRecord): Promise<void> {
    await this.options.recordStream.append(record)
    this.noteRecordAppended(record)
    this.options.onRecord?.(record)
  }

  private startToolUseSummary(toolResults: ToolResultRecord[], turnId: string): void {
    const runtime = this.options.compactModel
    const summarizableResults = toolResults.filter((result) => !isPlanControlTool(result.tool))
    if (!runtime || summarizableResults.length === 0) return

    const entry: PendingToolUseSummary = {
      turnId,
      status: 'pending',
      promise: summarizeToolUse({
        provider: runtime.provider,
        model: runtime.model,
        promptCacheRetention: runtime.promptCacheRetention,
        toolResults: summarizableResults,
        cwd: this.dataRoot(),
      }),
    }
    entry.promise.then((summary) => {
      entry.status = 'ready'
      entry.record = {
        ...summary.record,
        turnId,
      }
    }).catch((error: unknown) => {
      entry.status = 'failed'
      if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
        console.error('[hanekawa][tool-summary] failed:', error)
      }
    })
    this.pendingToolUseSummaries.push(entry)
  }

  private async flushReadyToolUseSummaries(turnId: string): Promise<void> {
    if (this.pendingToolUseSummaries.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    for (let index = 0; index < this.pendingToolUseSummaries.length;) {
      const entry = this.pendingToolUseSummaries[index]
      if (!entry || entry.status === 'pending') {
        index += 1
        continue
      }
      this.pendingToolUseSummaries.splice(index, 1)
      if (entry.status !== 'ready' || !entry.record) continue
      await this.appendRecord({
        ...entry.record,
        turnId: entry.record.turnId ?? turnId,
      })
    }
  }

  /** The tools a request would declare now, and whether deferred ones are searched for. */
  private toolsForRequest(): { toolSearchState: ToolSearchState; toolsForContext: Tool[] } {
    const toolSearchState = resolveToolSearchState({
      tools: this.currentTools,
      contextWindowSize: getContextWindowForModel(this.activeContextManagement),
      providerSupportsDynamicToolSearch: this.activeModel.provider.supportsDynamicToolSearch?.() ?? false,
    })
    const toolsForContext = toolSearchState.enabled
      ? this.currentTools
      : this.currentTools.filter((tool) => tool.name !== TOOL_SEARCH_TOOL_NAME)
    return { toolSearchState, toolsForContext }
  }

  /** The context-builder input that does not depend on the history. */
  private fixedContextInput(tools: Tool[], dynamicToolSearchEnabled: boolean) {
    const env: EnvironmentInfo = {
      cwd: this.options.toolContext.cwd,
      platform: process.platform,
      // Asked of the Bash tool rather than guessed: on Windows it resolves Git
      // Bash before PowerShell, and this line is what the model writes syntax
      // for.
      shell: describeShell(),
      osVersion: `${os.type()} ${os.release()}`,
      isGitRepo: this.options.isGitRepo ?? false,
      model: this.activeModel.model,
    }
    return {
      tools,
      system: this.options.system,
      // An inherited prefix already opens with the parent's instructions message.
      ...(this.options.inheritedRequest
        ? {}
        : { projectContext: this.options.projectContext, memoryIndex: this.options.memoryIndex }),
      memoryPrompt: this.options.memoryPrompt,
      rolePrompt: this.options.rolePrompt,
      criticalSystemReminder: this.options.criticalSystemReminder,
      skills: this.options.skills,
      contextManagement: this.activeContextManagement,
      toolContext: this.options.toolContext,
      env,
      dynamicToolSearchEnabled,
    }
  }

  /** The fixed parts of the request this loop would send after `records`, for the context breakdown. */
  async describeContextSources(records: readonly SessionRecord[]): Promise<ContextSources> {
    const { toolSearchState, toolsForContext } = this.toolsForRequest()
    const built = await this.options.contextBuilder.build({
      records: [],
      ...this.fixedContextInput(toolsForContext, toolSearchState.enabled),
      includeUserContext: false,
    })
    const loadedTools = toolSearchState.enabled
      ? filterToolsForRequest(this.currentTools, extractDiscoveredToolNames([...records]))
      : toolsForContext
    return {
      system: built.system ?? '',
      skillsSection: this.options.contextBuilder.skillsSystemSection(this.options.skills ?? []),
      loadedTools,
      deferredTools: toolSearchState.enabled ? this.currentTools.filter((tool) => !loadedTools.includes(tool)) : [],
      instructions: built.messages.find((message) => message.id === INSTRUCTIONS_MESSAGE_ID)?.content,
    }
  }

  /**
   * The request this loop sends for `records` — system, tools and history built
   * exactly as the main path builds them, so a request that must share the
   * main conversation's cached prefix (a compaction) gets it byte for byte.
   * The caller adds the per-attempt fields: streaming, retry, output limit.
   */
  private async buildModelRequest(
    records: SessionRecord[],
    turnId: string,
    userMessageId: string,
    cacheSource: CacheBreakSource,
    tail: { includeUserContext: boolean; permissionMode?: PermissionMode; transientUserContext?: () => string[] },
  ): Promise<ModelRequest> {
    // The inherited half of the request, re-derived per iteration for the
    // same reason the session records are: the model serving this attempt
    // decides what its images become.
    const preloadRecords = await this.projectPreloadImages(turnId)
    // Final image-byte loading (design §11.1 step 5): after every projection,
    // cap, and compaction decision above, load the send-version bytes the
    // request will actually carry. Current-turn files that cannot be loaded
    // stop the request; unloadable history degrades to placeholders here.
    const imageSend = await this.prepareRequestImages(records, turnId, userMessageId, preloadRecords)
    const { toolSearchState, toolsForContext } = this.toolsForRequest()

    const built = await this.options.contextBuilder.build({
      preloadRecords: imageSend.preloadRecords,
      records: imageSend.records,
      ...this.fixedContextInput(toolsForContext, toolSearchState.enabled),
      includeUserContext: tail.includeUserContext,
      permissionMode: tail.permissionMode,
      transientUserContext: tail.transientUserContext?.() ?? [],
    })

    // Set provider name on tool context for ToolSearchTool dual-provider support
    this.options.toolContext.providerName = this.activeModel.providerName
    // Inject full tool list for ToolSearchTool scoring
    this.options.toolContext._allTools = this.currentTools

    const hasDeferred = toolSearchState.enabled
    const allDeferredToolNames = toolSearchState.allDeferredToolNames

    // Filter tools: only include deferred tools that have been discovered
    // via tool_reference blocks in message history. Non-deferred tools and
    // ToolSearch itself are always included.
    const discoveredNames = extractDiscoveredToolNames(records)

    // Separate pre-compact vs post-compact discovered tools.
    // After compaction, tool_reference blocks from pre-compact messages are lost.
    // Tools discovered before compaction should NOT have defer_loading; their
    // schema was already loaded and the tool_reference is no longer in history.
    const preCompactDiscoveredNames = new Set<string>()
    for (const record of records) {
      if (record.type === 'compact_boundary' && record.preCompactDiscoveredTools) {
        for (const name of record.preCompactDiscoveredTools) preCompactDiscoveredNames.add(name)
      }
    }
    // Post-compact discovered = all discovered minus pre-compact
    const postCompactDiscoveredNames = new Set<string>()
    for (const name of discoveredNames) {
      if (!preCompactDiscoveredNames.has(name)) postCompactDiscoveredNames.add(name)
    }
    // Store for the payload builder to use as defer_loading candidates
    this.options.toolContext._postCompactDiscoveredNames = postCompactDiscoveredNames
    // Sync back to toolContext for post-compact restore
    if (discoveredNames.size > 0) {
      this.options.toolContext.discoveredToolNames ??= new Set()
      for (const name of discoveredNames) {
        this.options.toolContext.discoveredToolNames.add(name)
      }
    }
    const filteredTools = hasDeferred
      ? filterToolsForRequest(this.currentTools, discoveredNames)
      : toolsForContext

    const request: ModelRequest = {
      system: built.system,
      systemBlocks: built.systemBlocks,
      messages: built.messages,
      contextItems: built.contextItems,
      tools: filteredTools,
      model: this.activeModel.model,
      promptCacheRetention: this.activeModel.promptCacheRetention,
      thinking: this.options.thinking,
      effort: this.currentEffort,
      cacheSource,
      cacheRuntime: this.options.cacheRuntime,
      promptCacheKey: this.options.toolContext.sessionId,
      turnId,
      hasDeferredTools: hasDeferred,
      allDeferredToolNames,
      postCompactDiscoveredNames: this.options.toolContext._postCompactDiscoveredNames,
      ...(imageSend.imageBytes ? { imageBytes: imageSend.imageBytes } : {}),
    }
    return this.options.inheritedRequest ? withInheritedPrefix(this.options.inheritedRequest, request) : request
  }

  /**
   * One compaction attempt with everything both paths share. An inheriting fork
   * compacts only its own records: the parent prefix ahead of them is sent
   * unchanged, so its cache still hits. The summary is a model call of its own,
   * often the longest wait in the turn; bracketed so a shell can say so while it runs.
   */
  private async runCompaction(
    compact: (input: CompactCheckInput) => Promise<CompactCheckResult>,
    records: SessionRecord[],
    turnId: string,
    userMessageId: string,
    cacheSource: CacheBreakSource,
    extra: Partial<CompactCheckInput>,
    signal?: AbortSignal,
  ): Promise<CompactCheckResult> {
    let compacting = false
    const result = await compact({
      records,
      provider: this.activeModel.provider,
      model: this.activeModel.model,
      compactRuntime: this.options.compactModel,
      tools: this.currentTools,
      system: this.options.system,
      contextManagement: this.activeContextManagement,
      imageTokenStrategy: resolveImageTokenStrategy(this.activeModel.providerName, this.activeModel.supportsImageInput),
      discoveredToolNames: this.options.toolContext.discoveredToolNames,
      promptCacheRetention: this.activeModel.promptCacheRetention,
      turnId,
      circuitKey: this.options.toolContext.sessionId,
      cwd: this.dataRoot(),
      ...(this.options.compactPromptVariant ? { compactPromptVariant: this.options.compactPromptVariant } : {}),
      ...(this.options.attachmentFacts ? { attachmentFacts: this.options.attachmentFacts } : {}),
      getCompactFailureCount: this.options.getCompactFailureCount,
      setCompactFailureCount: this.options.setCompactFailureCount,
      ...(this.compactSharesPrefix()
        ? {
            summarizeWithSharedPrefix: (prompt: string) =>
              this.summarizeWithSharedPrefix(records, prompt, turnId, userMessageId, signal),
          }
        : {}),
      ...(signal ? { signal } : {}),
      appendRecord: (record) => this.appendRecord(record),
      onBeforeCompact: (event) => {
        compacting = true
        this.options.onStreamEvent?.({ type: 'compact', phase: 'start' })
        return this.runCompactHooks('preCompact', event, turnId, signal)
      },
      onAfterCompact: (event) => this.runCompactHooks('postCompact', event, turnId, signal),
      ...extra,
    }).finally(() => {
      if (compacting) this.options.onStreamEvent?.({ type: 'compact', phase: 'end' })
    })
    if (result.compacted) {
      notifyCompaction(cacheSource)
      this.options.contextBuilder.clearCachedSections()
      if (result.metrics) {
        await this.emitMetric({
          event: 'compact',
          model: this.activeModel.model,
          pre_tokens: result.metrics.preTokens,
          post_tokens: result.metrics.postTokens,
          compact_duration_ms: result.metrics.compactDurationMs,
          usage: toMetricUsage(result.usage),
        })
      }
    }
    return result
  }

  /** A compact model other than the active one cannot read the active model's cache. */
  private compactSharesPrefix(): boolean {
    const compact = this.options.compactModel
    return !compact || compact.model === this.activeModel.model
  }

  /**
   * The compaction request as the conversation's own request with the compact
   * prompt as its last message: every byte ahead of that message is the prefix
   * the main loop already cached. The prompt is marked transient so the cache
   * write stops at the history, not at a message no one will send again.
   */
  private async summarizeWithSharedPrefix(
    records: SessionRecord[],
    prompt: string,
    turnId: string,
    userMessageId: string,
    signal: AbortSignal | undefined,
  ): Promise<ModelResponse> {
    const base = await this.buildModelRequest(
      records,
      turnId,
      userMessageId,
      compactCacheSource(this.dataRoot()),
      { includeUserContext: false },
    )
    const message: ChatMessage = {
      id: 'compact-request',
      role: 'user',
      content: prompt,
      createdAt: new Date().toISOString(),
      transient: true,
    }
    return this.activeModel.provider.createMessage({
      ...base,
      messages: [...base.messages, message],
      contextItems: [...(base.contextItems ?? []), { kind: 'message', message }],
      retry: { callerKind: 'background', persistent: true, signal },
    })
  }

  /**
   * Build the post-compact restore once and store it on the pending boundary,
   * so it becomes part of the durable, cached prefix instead of a one-request
   * tail. Returns `records` with the stored form applied — even when the write
   * failed, this request still carries it (the next one rebuilds).
   */
  private async materializePostCompactRestore(records: SessionRecord[]): Promise<SessionRecord[]> {
    const pendingIds = new Set((this.recordsCache ?? records)
      .filter((record) => record.type === 'compact_boundary' && record.postCompactRestore === 'pending')
      .map((record) => record.id))
    if (pendingIds.size === 0) return records

    const restoredContext = await this.options.contextBuilder.buildPostCompactRestore(
      this.options.toolContext,
      await this.coordinationRestore(),
    )
    const consume = (record: SessionRecord): SessionRecord => {
      if (!pendingIds.has(record.id) || record.type !== 'compact_boundary' || record.postCompactRestore !== 'pending') return record
      return { ...record, postCompactRestore: 'consumed', ...(restoredContext ? { restoredContext } : {}) }
    }
    for (const recordId of pendingIds) {
      try {
        await this.options.recordStream.update?.(recordId, consume)
        // Only update in-memory cache if persistence succeeded, to avoid
        // state divergence between memory and disk.
        this.recordsCache = this.recordsCache?.map((record) => record.id === recordId ? consume(record) : record)
      } catch (error) {
        if (process.env.MYAGENT_DEBUG_PROVIDER === '1') {
          console.error(`[hanekawa][compact] failed to persist consumed restore record ${recordId}:`, error)
        }
      }
    }
    return records.map(consume)
  }

  private async runToolCallsInOrder(calls: ToolCall[], signal?: AbortSignal, turnId?: string): Promise<ToolResultRecord[]> {
    const results: ToolResultRecord[] = []
    let index = 0

    while (index < calls.length) {
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }

      const call = calls[index]
      if (!call) break
      this.assertToolAllowed(call.name)

      if (!this.isConcurrencySafe(call)) {
        const result = await this.options.toolRunner.run(call, this.options.toolContext, signal, turnId, {
          hooks: this.activeRunOverrides?.hooks,
        })
        results.push(result)
        if (result.errorCode === 'aborted' || signal?.aborted) {
          throw new DOMException('The operation was aborted.', 'AbortError')
        }
        index += 1
        continue
      }

      const safeBatch: ToolCall[] = []
      while (index < calls.length && safeBatch.length < MAX_CONCURRENT_TOOL_CALLS) {
        const candidate = calls[index]
        if (!candidate || !this.isConcurrencySafe(candidate)) break
        safeBatch.push(candidate)
        index += 1
      }

      const settled = await Promise.allSettled(
        safeBatch.map((toolCall) => this.options.toolRunner.run(toolCall, this.options.toolContext, signal, turnId, {
          hooks: this.activeRunOverrides?.hooks,
        })),
      )
      let firstRejection: unknown
      let sawAbort = false
      for (const item of settled) {
        if (item.status === 'fulfilled') {
          results.push(item.value)
          if (item.value.errorCode === 'aborted') {
            sawAbort = true
          }
        } else {
          firstRejection ??= item.reason
          if (isAbortError(item.reason)) {
            sawAbort = true
          }
        }
      }

      if (sawAbort || signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError')
      }
      if (firstRejection !== undefined) {
        throw firstRejection
      }
    }

    return results
  }

  private drainSubagentTranscriptUsage(): TokenUsage {
    const usage = this.pendingSubagentTranscriptUsage
    this.pendingSubagentTranscriptUsage = { ...EMPTY_TOKEN_USAGE }
    return usage
  }

  /**
   * Extract discovered tool names from ToolSearch results and add them to
   * toolContext.discoveredToolNames. This set survives compaction via the
   * post-compact restore mechanism.
   */
  private trackDiscoveredTools(toolResults: ToolResultRecord[]): void {
    for (const result of toolResults) {
      if (result.tool !== 'ToolSearch' || !result.ok) continue
      // For Anthropic: content is JSON.stringify({matches, query, totalDeferredTools})
      // For OpenAI: content is plain text with schemas — skip
      try {
        const parsed = JSON.parse(result.content)
        if (Array.isArray(parsed.matches)) {
          this.options.toolContext.discoveredToolNames ??= new Set()
          for (const name of parsed.matches) {
            this.options.toolContext.discoveredToolNames.add(name)
          }
        }
      } catch {
        // Not JSON (OpenAI text format) — skip
      }
    }
  }

  private isConcurrencySafe(call: ToolCall): boolean {
    const tool = this.currentTools.find((candidate) => candidate.name === call.name)
    if (!tool) return false
    if (tool.concurrentWhenReadonly) {
      // A classifier failure must not fail the turn; the call then just runs alone.
      try {
        return this.options.toolRunner.isReadonlyCall(tool, call)
      } catch {
        return false
      }
    }
    if (tool.isDestructive === true) return false
    if (tool.isConcurrencySafeInput) return tool.isConcurrencySafeInput(call.input)
    return tool.isConcurrencySafe === true && tool.isReadOnly === true
  }

  private assertToolAllowed(toolName: string): void {
    if (!this.activeRunOverrides?.allowedTools) return
    if (!this.activeRunOverrides.allowedTools.has(toolName)) {
      throw new Error(`Tool ${toolName} is not allowed for this skill command.`)
    }
  }

  private async emitTurnMetric(startedAt: number, usage: TokenUsage, toolCalls: number): Promise<void> {
    await this.emitMetric({
      event: 'turn',
      model: this.activeModel.model,
      input_tokens: usage.inputTokens,
      // Written only when the provider reported it, so the sidecar keeps the
      // same "absent means not reported" contract as `TokenUsage` itself.
      ...(reportsCacheCreation(usage) ? { cache_creation_tokens: cacheCreationTokens(usage) } : {}),
      response_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadInputTokens,
      cache_hit_rate: cacheHitRate(usage),
      tool_calls: toolCalls,
      duration_ms: Date.now() - startedAt,
      ...costField(usage.cost),
    })
  }

  /**
   * Text hooks keep receiving the user's text verbatim; the images ride along
   * as metadata only (design §13) — never bytes, never a placeholder written
   * back into the prompt. Covers the input's explicit images plus the @-mention
   * images already imported for this turn, so the hook sees the attachment set
   * the submission actually carries.
   */
  private async runUserPromptSubmitHooks(userInput: UserInput, turnId: string, signal?: AbortSignal): Promise<void> {
    const result = await runLifecycleHooks(
      this.currentHooks?.userPromptSubmit,
      'userPromptSubmit',
      {
        prompt: userInput.text,
        ...(userInput.images && userInput.images.length > 0
          ? {
              images: userInput.images.map(({ id, name, mimeType, width, height, byteLength }) => ({
                id, name, mimeType, width, height, byteLength,
              })),
            }
          : {}),
      },
      this.options.toolContext,
      signal,
    )
    await this.appendLifecycleHookMessages('userPromptSubmit', result.stdout, result.failures, turnId)
  }

  private async runCompactHooks(
    hookName: 'preCompact' | 'postCompact',
    input: object,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const hookInput = { ...input } as Record<string, unknown>
    const result = await runLifecycleHooks(
      this.currentHooks?.[hookName],
      hookName,
      hookInput,
      this.options.toolContext,
      signal,
      typeof hookInput.trigger === 'string' ? hookInput.trigger : undefined,
    )
    await this.appendLifecycleHookMessages(hookName, result.stdout, result.failures, turnId)
    if (result.blockingErrors.length > 0) {
      await this.appendRecord({
        type: 'message',
        id: randomUUID(),
        role: 'user',
        content: wrapInSystemReminder(`${hookName} hook blocking error:\n${result.blockingErrors.join('\n')}`),
        turnId,
        createdAt: new Date().toISOString(),
      })
    }
  }

  private async finishTurn(input: {
    content: string
    usage: TokenUsage
    turnId: string
    signal?: AbortSignal
    stopReason?: string
    truncated?: boolean
    segments?: string[]
    statusUsage?: TokenUsage
  }): Promise<{ continueLoop: true } | { continueLoop: false; result: AgentRunResult }> {
    const result = await runLifecycleHooks(
      this.currentHooks?.stop,
      'stop',
      {
        response: input.content,
        model: this.activeModel.model,
        modelKey: this.activeModel.modelKey,
      },
      this.options.toolContext,
      input.signal,
    )
    await this.appendLifecycleHookMessages('stop', result.stdout, result.failures, input.turnId)
    if (result.preventContinuation) {
      return { continueLoop: false, result: finishResult(input) }
    }
    if (result.blockingErrors.length > 0) {
      await this.appendRecord({
        type: 'message',
        id: randomUUID(),
        role: 'user',
        content: wrapInSystemReminder(`stop hook blocking error:\n${result.blockingErrors.join('\n')}`),
        turnId: input.turnId,
        createdAt: new Date().toISOString(),
      })
      return { continueLoop: true }
    }
    return { continueLoop: false, result: finishResult(input) }
  }

  private async appendLifecycleHookMessages(
    hookName: LifecycleHookName,
    stdout: string,
    failures: string[],
    turnId: string,
  ): Promise<void> {
    const blocks: string[] = []
    if (stdout.trim()) {
      blocks.push(stdout.trim())
    }
    if (failures.length > 0) {
      blocks.push(`Hook failures:\n${failures.join('\n')}`)
    }
    if (blocks.length === 0) return

    await this.appendRecord({
      type: 'message',
      id: randomUUID(),
      role: 'user',
      content: wrapInSystemReminder(`${hookName} hook output:\n${blocks.join('\n\n')}`),
      turnId,
      createdAt: new Date().toISOString(),
    })
  }

  private async emitMetric(metric: SessionMetricInput): Promise<void> {
    try {
      await this.options.recordStream.appendMetric?.(metric)
    } catch {
      // Metrics are best-effort and must not affect the user turn.
    }
  }

  private get activeModel(): ActiveModelRuntime {
    return this.activeRunOverrides?.model ?? this.modelState.current
  }

  private get activeContextManagement(): Partial<ContextManagementConfig> {
    return {
      ...this.options.contextManagement,
      contextWindow: this.activeModel.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT,
    }
  }

  private get currentTools(): Tool[] {
    return this.activeRunOverrides?.tools ?? this.options.tools
  }

  private get currentEffort(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined {
    return this.activeRunOverrides?.effort ?? this.options.effort
  }

  private get currentHooks(): Hooks | undefined {
    return mergeHooks(this.options.hooks, this.activeRunOverrides?.hooks)
  }

  /**
   * The model the *next* request will actually be built on — plan routing and
   * an active fallback included. `syncRoleModel` applies it at the top of each
   * loop iteration; capability reporting and the submission gate read it so
   * they judge the model that will serve the request rather than the one the
   * input bar happens to name (design §9.1, last row).
   */
  private nextRoleModel(): ActiveModelRuntime {
    if (this.modelState.fallback && this.isSameModel(this.modelState.current, this.modelState.fallback)) {
      return this.modelState.current
    }
    return this.options.permissionMode?.() === 'plan' && this.options.planModel
      ? this.options.planModel
      : this.modelState.primary
  }

  /** {@link nextRoleModel} with a temporary run override taking precedence. */
  private get requestModel(): ActiveModelRuntime {
    return this.activeRunOverrides?.model ?? this.nextRoleModel()
  }

  private syncRoleModel(cacheSource: ReturnType<typeof agentCacheSource>): boolean {
    if (this.activeRunOverrides?.model) return false
    if (this.modelState.fallback && this.isSameModel(this.activeModel, this.modelState.fallback)) {
      return false
    }

    const next = this.nextRoleModel()

    if (this.isSameModel(this.activeModel, next)) return false
    this.switchActiveModel(next, cacheSource)
    return true
  }

  private isPlanModelActive(): boolean {
    if (this.activeRunOverrides?.model) return false
    return Boolean(this.options.planModel && this.isSameModel(this.activeModel, this.options.planModel))
  }

  /**
   * Automatic fallback (design §9.1): a text-only fallback does not apply to a
   * turn that carries new images. Reporting that as its own outcome — rather
   * than switching and letting the next request build throw — is what lets the
   * caller keep the failure that asked for the fallback, and is why the same
   * incompatible target is never retried in a loop.
   */
  private activateFallback(
    cacheSource: ReturnType<typeof agentCacheSource>,
  ): 'activated' | 'unavailable' | 'blocked-by-images' {
    if (this.activeRunOverrides?.model) return 'unavailable'
    const fallback = this.modelState.fallback
    if (!fallback) return 'unavailable'
    if (this.isSameModel(fallback, this.activeModel)) return 'unavailable'
    if (fallback.supportsImageInput !== true && this.currentRequestNewImages.length > 0) {
      return 'blocked-by-images'
    }

    this.switchActiveModel(fallback, cacheSource)
    this.modelState.fallbackActivatedAt = Date.now()
    return 'activated'
  }

  private retryPrimaryIfReady(cacheSource: ReturnType<typeof agentCacheSource>): boolean {
    if (this.activeRunOverrides?.model) return false
    if (!this.modelState.fallback) return false
    if (!this.isSameModel(this.activeModel, this.modelState.fallback)) return false
    if (this.isSameModel(this.modelState.primary, this.modelState.fallback)) return false

    const fallbackActivatedAt = this.modelState.fallbackActivatedAt
    if (fallbackActivatedAt === undefined) return false

    const retryDelayMs = this.options.fallbackRetryDelayMs ?? DEFAULT_FALLBACK_RETRY_DELAY_MS
    if (Date.now() - fallbackActivatedAt < retryDelayMs) return false

    this.switchActiveModel(this.modelState.primary, cacheSource)
    this.modelState.fallbackActivatedAt = undefined
    return true
  }

  private switchActiveModel(next: ActiveModelRuntime, cacheSource: ReturnType<typeof agentCacheSource>): void {
    this.modelState.current = next
    this.stripAllThinkingBlocksFromRequests = true
    this.responseBaseline = undefined
    resetCacheBreakDetection(cacheSource)
    this.options.contextBuilder.clearCachedSections()
  }

  private isSameModel(a: ActiveModelRuntime, b: ActiveModelRuntime): boolean {
    if (a.modelKey || b.modelKey) return a.modelKey === b.modelKey
    return a.provider === b.provider && a.model === b.model
  }
}

interface PendingToolUseSummary {
  turnId: string
  status: 'pending' | 'ready' | 'failed'
  promise: Promise<{ record: ToolUseSummaryRecord; usage?: TokenUsage }>
  record?: ToolUseSummaryRecord
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function appendResponseSegment(segments: string[], content: string): string {
  if (content.length > 0) segments.push(content)
  return combineResponseSegments(segments)
}

function combineResponseSegments(segments: readonly string[], finalContent?: string): string {
  return segmentsWithFinalResponse(segments, finalContent)?.join('\n\n') ?? ''
}

function segmentsWithFinalResponse(
  segments: readonly string[],
  finalContent?: string,
): string[] | undefined {
  const parts = [...segments]
  if (finalContent !== undefined && finalContent.length > 0) parts.push(finalContent)
  return parts.length > 0 ? parts : undefined
}

function buildMaxTokensContinuationReminder(taskState: ToolContext['taskState']): string {
  const blocks = [
    'Your previous response was cut off by the token limit. Continue from the exact point where it stopped.',
    'Do not restart, summarize, or repeat completed text. Finish the remaining answer or remaining tool-driven task directly.',
  ]
  const remaining = remainingTasksFromState(taskState)
  if (remaining.length > 0) {
    blocks.push(
      'Still-open tracked tasks:',
      ...remaining.map((task) => `- #${task.id} [${task.status}] ${task.subject}`),
    )
  }
  return wrapInSystemReminder(blocks.join('\n'))
}

const TASK_TOOL_NAMES = new Set([TASK_CREATE_TOOL_NAME, TASK_GET_TOOL_NAME, TASK_LIST_TOOL_NAME, TASK_UPDATE_TOOL_NAME])
const TASK_REMINDER_STEPS = 10

function buildTaskReminder(taskState: ToolContext['taskState']): string | undefined {
  if (remainingTasksFromState(taskState).length === 0) return undefined
  const tasks = sortedTasks(taskState?.values() ?? [])
  const completedIds = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  return wrapInSystemReminder([
    `No task tool call in your last ${TASK_REMINDER_STEPS} responses. Task list:`,
    ...tasks.map((task) => formatTaskLine(task, completedIds)),
    '',
    'If it lags behind your work, update it now: mark fully done tasks completed and your current task in_progress; add, reword, or delete tasks that no longer match. If it is accurate, continue. Never mention this reminder.',
  ].join('\n'))
}

function buildMaxTurnsExceededContent(content: string, maxTurns: number): string {
  const base = content.trim().length > 0
    ? content
    : '(Sub-agent reached the max turns limit before producing a final response.)'
  return `${base}\n\n[Sub-agent output may be incomplete: reached max turns limit (${maxTurns}).]`
}

function finishResult(input: {
  content: string
  usage: TokenUsage
  stopReason?: string
  truncated?: boolean
  segments?: string[]
  statusUsage?: TokenUsage
}): AgentRunResult {
  return {
    content: input.content,
    usage: input.usage,
    ...(input.statusUsage ? { statusUsage: input.statusUsage } : {}),
    ...(input.stopReason ? { stopReason: input.stopReason } : {}),
    ...(input.truncated ? { truncated: true } : {}),
    ...(input.segments && input.segments.length > 0 ? { segments: input.segments } : {}),
  }
}

function isPlanControlTool(toolName: string): boolean {
  return toolName === ENTER_PLAN_MODE_TOOL_NAME || toolName === EXIT_PLAN_MODE_TOOL_NAME
}

function classifyInterruptionIntent(input: string): 'continue' | 'abandon' | 'new_request' {
  const normalized = input.trim().toLowerCase()
  if (!normalized) return 'new_request'
  if (startsWithInterruptionCommand(normalized, [
    'continue',
    'resume',
    'carry on',
    'go on',
    'keep going',
    '继续',
    '接着',
    '恢复',
    '接着做',
    '继续做',
  ])) {
    return 'continue'
  }
  if (startsWithInterruptionCommand(normalized, [
    'cancel',
    'abort',
    'stop',
    'ignore',
    'never mind',
    'nevermind',
    '算了',
    '不用了',
    '停止',
    '放弃',
    '不要继续',
    '别继续',
  ])) {
    return 'abandon'
  }
  return 'new_request'
}

function startsWithInterruptionCommand(input: string, commands: readonly string[]): boolean {
  return commands.some((command) => {
    if (input === command) return true
    if (!input.startsWith(command)) return false
    const next = input[command.length]
    return next === undefined || /\s|[,.!?;:，。！？；：]/u.test(next)
  })
}

function isUserCancelAbort(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason === 'user-cancel'
}

/** The cacheable half of a request: no per-request tail, no per-attempt fields. */
function durablePrefix(request: ModelRequest): ModelRequest {
  const isTransient = (message: ChatMessage) => message.transient === true
  return {
    system: request.system,
    systemBlocks: request.systemBlocks,
    messages: request.messages.filter((message) => !isTransient(message)),
    contextItems: request.contextItems?.filter((item) => !(item.kind === 'message' && isTransient(item.message))),
    tools: request.tools,
    model: request.model,
    promptCacheRetention: request.promptCacheRetention,
    thinking: request.thinking,
    effort: request.effort,
    cacheSource: request.cacheSource,
    cacheRuntime: request.cacheRuntime,
    promptCacheKey: request.promptCacheKey,
    hasDeferredTools: request.hasDeferredTools,
    allDeferredToolNames: request.allDeferredToolNames,
    postCompactDiscoveredNames: request.postCompactDiscoveredNames,
    ...(request.imageBytes ? { imageBytes: request.imageBytes } : {}),
  }
}

/**
 * `own` behind the inherited prefix. Everything that renders ahead of the
 * history comes from the parent, so the bytes match; a tool this loop found
 * that the parent's request lacked trails the parent's list.
 */
function withInheritedPrefix(inherited: ModelRequest, own: ModelRequest): ModelRequest {
  const inheritedTools = inherited.tools ?? []
  const inheritedNames = new Set(inheritedTools.map((tool) => tool.name))
  const imageBytes = new Map([...(inherited.imageBytes ?? []), ...(own.imageBytes ?? [])])
  return {
    ...own,
    system: inherited.system,
    systemBlocks: inherited.systemBlocks,
    thinking: inherited.thinking,
    effort: inherited.effort,
    promptCacheKey: inherited.promptCacheKey ?? own.promptCacheKey,
    tools: [...inheritedTools, ...(own.tools ?? []).filter((tool) => !inheritedNames.has(tool.name))],
    hasDeferredTools: inherited.hasDeferredTools,
    allDeferredToolNames: inherited.allDeferredToolNames,
    postCompactDiscoveredNames: new Set([...(inherited.postCompactDiscoveredNames ?? []), ...(own.postCompactDiscoveredNames ?? [])]),
    messages: [...inherited.messages, ...own.messages],
    contextItems: [...(inherited.contextItems ?? []), ...(own.contextItems ?? [])],
    ...(imageBytes.size > 0 ? { imageBytes } : {}),
  }
}

function userMessageInput(message: ChatMessage): UserInput {
  return {
    text: message.content,
    ...(message.images && message.images.length > 0 ? { images: message.images } : {}),
  }
}
