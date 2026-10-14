import type { ZodTypeAny } from 'zod/v3'
import type { CacheBreakResult, CacheBreakSource } from './cacheBreakDetection.js'
import type { CacheRuntime } from './cacheControl.js'
import type { JsonSchema, ToolValidationResult } from './toolValidation.js'
import type { PermissionMode } from './permissions.js'
import type { RiskContext, RiskTier } from './risk/types.js'
import type { SessionMetricInput } from './metrics.js'
import type { RetryErrorCategory } from '../config/retry.js'
import type { ImageAttachmentMetadata, ImageAttachmentRef, ImageInputErrorReason, ImageMimeType } from '../media/types.js'

export type RiskLevel = 'safe' | 'confirm' | 'dangerous'

export type ChatRole = 'user' | 'assistant' | 'system' | 'tool'

export interface ThinkingBlock {
  type: 'thinking' | 'redacted_thinking'
  thinking?: string
  signature?: string
  data?: string
}

export type ModelStreamEvent =
  | { type: 'message_start' }
  | { type: 'thinking_start'; index?: number; redacted?: boolean }
  | { type: 'thinking_delta'; index?: number; thinking: string }
  | { type: 'thinking_signature'; index?: number; signature: string }
  | { type: 'thinking_stop'; index?: number }
  | { type: 'redacted_thinking'; index?: number }
  | { type: 'text_delta'; index?: number; text: string }
  /** `name` is the tool whose arguments these are, when the provider announced it. */
  | { type: 'tool_input_delta'; index?: number; name?: string; partialJson: string }
  | { type: 'message_stop' }
  | { type: 'idle_warning'; idleMs: number }
  /** Attempt `attempt` failed for `reason`; the provider sleeps `delayMs` and sends again. */
  | { type: 'retry'; attempt: number; reason: RetryErrorCategory; delayMs: number }
  /** An automatic compaction began summarizing (`start`) or settled either way (`end`). */
  | { type: 'compact'; phase: 'start' | 'end' }
  /**
   * The loop degraded a request's historical images to text placeholders
   * because the serving model cannot accept images (design §9.1). Emitted
   * once per distinct (capability, image set) state — not per tool step —
   * and carries text only, never image bytes.
   */
  | { type: 'image_capability_notice'; message: string; omittedImageCount: number; missingImageCount?: number }
  /**
   * The loop omitted images to keep a request within its image-count cap
   * (design §11.1 step 3): oldest history first, the current turn's images
   * protected. Emitted once per distinct (cap, kept set) state — like the
   * capability notice, not per tool step — and carries text only.
   */
  | { type: 'media_limit_notice'; message: string; omittedImageCount: number; maxImages: number }
  /**
   * The loop omitted images to keep a request's image bytes within the
   * request-size budget (design §11.1 step 3): oldest history first, the
   * current turn's images protected. Same once-per-state rule and text-only
   * payload as the count-cap notice above.
   */
  | { type: 'request_size_notice'; message: string; omittedImageCount: number; maxImageRequestBytes: number }

export interface ChatMessage {
  id: string
  role: ChatRole
  content: string
  displayContent?: string
  createdAt: string
  turnId?: string
  model?: string
  reasoningContent?: string
  thinkingBlocks?: ThinkingBlock[]
  /**
   * Image refs submitted with this message. `content` stays the text of record
   * for display, search, and the existing commands; images ride beside it and
   * resolve through the owning session's attachment service, never inlined.
   */
  images?: ImageAttachmentRef[]
  /**
   * The queued message this user record was submitted from (design §12.2).
   *
   * The hand-off consumes a queued message only once its user record is on
   * disk, which leaves one window: a crash between the two writes. Replay
   * closes it — a queued message whose id appears here has already been sent,
   * so `replayMessageQueue` drops it instead of sending it twice. It follows
   * the ordinary rollback rules: a turn rolled back takes its user record with
   * it, and the queued message legitimately comes back.
   */
  sourceQueuedMessageId?: string
  /**
   * Built for this request only and never persisted — user context, the
   * transient attachments, the post-compact restore. They sit after the
   * history, so next turn the same position holds a real record instead;
   * a cache breakpoint on one writes a prefix no later turn can read back
   * (spec §2). The payload builder carries the flag down so
   * `addCacheBreakpoints` can anchor on the last durable message.
   */
  transient?: boolean
}

export interface ToolUseRecord {
  id: string
  type: 'tool_use'
  tool: string
  input: unknown
  riskLevel: RiskLevel
  createdAt: string
  turnId?: string
}

export interface ToolResultRecord {
  id: string
  type: 'tool_result'
  toolUseId: string
  tool: string
  ok: boolean
  content: string
  display?: ToolResultDisplay
  _tokens?: number
  errorCode?: ToolErrorCode
  errorDetails?: unknown
  createdAt: string
  turnId?: string
  /**
   * Pre-mapped API result block. When a tool defines mapToolResultToToolResultBlockParam,
   * the ToolRunner calls it after execute() and caches the result here.
   * The Anthropic payload builder uses this instead of the plain-text content
   * when present, enabling tool_reference blocks for ToolSearch.
   */
  apiResultBlock?: ToolResultBlockParam
  /** Images the tool produced (e.g. a `Read` of an image file), persisted as refs. */
  images?: ImageAttachmentRef[]
}

export type ToolProgressPhase = 'started' | 'finished'

export interface ToolProgressEvent {
  call: ToolCall
  phase: ToolProgressPhase
  source?: {
    type: 'subagent'
    agentType: string
    agentId?: string
    /** The parent's `Agent` call this run answers, so a UI can draw progress on that step. */
    parentToolUseId?: string
  }
}

export interface ToolApprovalRecord {
  id: string
  type: 'tool_approval'
  tool: string
  input: unknown
  approved: boolean
  riskLevel: RiskLevel
  createdAt: string
  turnId?: string
}

export interface CompactBoundaryRecord {
  id: string
  type: 'compact_boundary'
  summary: string
  preTokens: number
  postCompactRestore?: 'pending' | 'consumed'
  /**
   * The restore built when this boundary was consumed, stored verbatim so every
   * later request (and a resumed session) replays the same cached bytes.
   */
  restoredContext?: string
  createdAt: string
  turnId?: string
  /** Tool names discovered via ToolSearch before compaction — survives compaction. */
  preCompactDiscoveredTools?: string[]
}

export interface CompactAttemptFailedRecord {
  id: string
  type: 'compact_attempt_failed'
  error: string
  failureCount: number
  circuitOpen: boolean
  preTokens: number
  createdAt: string
  turnId?: string
}

/**
 * Coordinator board snapshot / pending notes, appended by the loop at the start
 * of a step. Durable: replayed on every later request as a system reminder.
 */
export interface CoordinationUpdateRecord {
  id: string
  type: 'coordination_update'
  content: string
  createdAt: string
  turnId?: string
}

export interface ToolUseSummaryRecord {
  id: string
  type: 'tool_use_summary'
  summary: string
  toolUseIds: string[]
  createdAt: string
  turnId?: string
  model?: string
}

/**
 * A tool result's trimmed form, stored verbatim so `/resume` rebuilds the exact
 * bytes the model already saw (spec §5.1). The string, not the rule that
 * produced it — a later change to the wording must not move the cached prefix.
 */
export interface ToolResultTrimRecord {
  id: string
  type: 'tool_result_trim'
  toolUseId: string
  content: string
  createdAt: string
  turnId?: string
}

export interface AtMentionFileContext {
  path: string
  displayPath: string
  lineStart: number
  lineEnd: number
  truncated: boolean
}

export interface AtMentionContextRecord {
  id: string
  type: 'at_mention_context'
  userMessageId: string
  files: AtMentionFileContext[]
  content: string
  createdAt: string
  turnId?: string
}

export interface SubagentTranscriptRecord {
  id: string
  type: 'subagent_transcript'
  agentId: string
  subagentType: string
  model?: string
  parentToolUseId?: string
  transcriptPath?: string
  status?: SubagentTaskStatus
  stopReason?: string
  truncated?: boolean
  summary?: string
  recordCount?: number
  messageCount?: number
  toolUseCount?: number
  toolResultCount?: number
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  criticalFiles?: string[]
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
  // Intentionally empty when persisted in the parent session; full transcript
  // records live in the sidechain transcript file when transcriptPath is set.
  records?: SessionRecord[]
  usage: TokenUsage
  createdAt: string
  turnId?: string
}

export type SubagentTaskStatus = 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'killed' | 'orphaned'

export interface BackgroundTaskRecord {
  id: string
  type: 'background_task'
  taskId: string
  sessionId: string
  kind: 'shell' | 'agent'
  status: BackgroundTaskStatus
  command?: string
  pid?: number
  agentId?: string
  agentType?: string
  description?: string
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  signal?: string | null
  reason?: string
  createdAt: string
  turnId?: string
}

export interface SubagentTaskRecord {
  id: string
  type: 'subagent_task'
  agentId: string
  subagentType: string
  model?: string
  status: SubagentTaskStatus
  description: string
  task: string
  name?: string
  parentToolUseId?: string
  transcriptPath?: string
  summary?: string
  error?: string
  usage?: TokenUsage
  toolUseCount?: number
  durationMs?: number
  verdict?: 'PASS' | 'FAIL' | 'PARTIAL'
  criticalFiles?: string[]
  isolation?: 'worktree'
  worktreePath?: string
  worktreeBaseRef?: string
  worktreeChangeSummary?: string
  createdAt: string
  turnId?: string
}

export interface PlanModeRequestRecord {
  id: string
  type: 'plan_mode_request'
  kind: 'enter' | 'exit' | 'subagent_exit'
  submittedFromSessionId: string
  planContent?: string
  /** The `ExitPlanMode` call that raised it, so the outcome can be shown on that call. */
  toolUseId?: string
  createdAt: string
  turnId?: string
}

export interface PlanModeOutcomeRecord {
  id: string
  type: 'plan_mode_outcome'
  kind: 'enter_approved' | 'enter_rejected' | 'exit_approved' | 'exit_rejected'
  requestId: string
  detail?: string
  /** Exit outcomes: the call that raised the request, and the plan the decision was made on. */
  toolUseId?: string
  planContent?: string
  createdAt: string
  turnId?: string
}

export interface TurnInterruptionRecord {
  id: string
  type: 'turn_interruption'
  userMessageId: string
  prompt: string
  /** Image refs the interrupted input carried, restored with the text. */
  images?: ImageAttachmentRef[]
  remainingTasks: TaskItem[]
  recoverable: boolean
  consumedAt?: string
  createdAt: string
  turnId?: string
}

/**
 * A turn that ended on a provider or network error. Persisted so a reopened
 * session still says why its last turn stopped; the renderer classifies
 * `error`/`status`/`code` into words.
 */
export interface TurnFailureRecord {
  id: string
  type: 'turn_failure'
  userMessageId: string
  /** The thrown error's message, verbatim. */
  error: string
  /** HTTP status of a provider error. */
  status?: number
  /** The SDK's or Node's machine code, e.g. `insufficient_quota` or `ECONNREFUSED`. */
  code?: string
  model?: string
  providerName?: string
  baseUrl?: string
  createdAt: string
  turnId?: string
}

/** Who drove a turn: the user, a coordinator session, or an automatic wake. */
export type TurnOrigin = 'user' | 'coordinator' | 'wake'

export type MessageQueuePriority = 'now' | 'next' | 'later'

export interface PersistedQueuedMessage {
  id: string
  content: string
  priority: MessageQueuePriority
  createdAt: string
  /** Image refs queued with the text; restored intact across a restart. */
  images?: ImageAttachmentRef[]
  /** Absent = the user. A coordinator message is only steered into a coordinator-driven turn. */
  origin?: 'coordinator'
}

/**
 * Messages the user sent while a turn is running, offered to that turn at each
 * step boundary (steering). The loop removes a message only once its user
 * record is on disk; whatever it leaves behind waits for the next turn.
 */
export interface SteerSource {
  pending(): readonly PersistedQueuedMessage[]
  consume(messageId: string): Promise<void>
}

export type MessageQueueRecord =
  | {
      id: string
      type: 'message_queue'
      operation: 'enqueue'
      message: PersistedQueuedMessage
      createdAt: string
      turnId?: string
    }
  | {
      id: string
      type: 'message_queue'
      operation: 'dequeue'
      messageId: string
      createdAt: string
      turnId?: string
    }
  | {
      id: string
      type: 'message_queue'
      operation: 'clear'
      createdAt: string
      turnId?: string
    }

export type SessionRecord =
  | ({ type: 'message' } & ChatMessage)
  | AtMentionContextRecord
  | ToolUseRecord
  | ToolResultRecord
  | ToolResultTrimRecord
  | ToolApprovalRecord
  | CompactBoundaryRecord
  | CompactAttemptFailedRecord
  | ToolUseSummaryRecord
  | CoordinationUpdateRecord
  | SubagentTranscriptRecord
  | SubagentTaskRecord
  | BackgroundTaskRecord
  | PlanModeRequestRecord
  | PlanModeOutcomeRecord
  | TurnInterruptionRecord
  | TurnFailureRecord
  | MessageQueueRecord

export interface TaskItem {
  id: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  subject: string
  description: string
  activeForm?: string
  owner?: string
  blocks?: string[]
  blockedBy?: string[]
  metadata?: Record<string, unknown>
}

export interface PlanModeBridge {
  parentSessionId: string
  parentAppendRecord(record: SessionRecord): Promise<void>
  activePlanFilePath?: string
}

export interface AskUserQuestionBridge {
  ask(input: AskUserQuestionRequest): Promise<AskUserQuestionResult>
}

export interface AskUserQuestionOption {
  label: string
  description: string
  preview?: string
}

export interface AskUserQuestionItem {
  question: string
  header: string
  options: AskUserQuestionOption[]
  multiSelect: boolean
}

export interface AskUserQuestionRequest {
  questions: AskUserQuestionItem[]
}

export type AskUserQuestionAnswers = Record<string, string>
export type AskUserQuestionAnnotations = Record<string, {
  preview?: string
  notes?: string
}>

export type AskUserQuestionResult =
  | { kind: 'answers'; answers: AskUserQuestionAnswers; annotations?: AskUserQuestionAnnotations }
  | { kind: 'rejected'; feedback?: string }

/**
 * What image-reading tools need from the session's attachment store: import
 * bytes, get back the ref records carry plus the original's facts for the
 * caption. Structurally satisfied by `ImageAttachmentService`; the narrower
 * `AtMentionImageImporter` (at-mentions) accepts it too.
 */
export interface ImageAttachmentImporter {
  importImage(
    ownerSessionId: string,
    bytes: Buffer,
    name: string,
  ): Promise<
    | {
      ok: true
      value: {
        ref: ImageAttachmentRef
        metadata: Pick<
          ImageAttachmentMetadata,
          'originalWidth' | 'originalHeight' | 'exifOrientation' | 'sentWidth' | 'sentHeight' | 'localPath'
        >
        animated: boolean
      }
    }
    | { ok: false; reason: ImageInputErrorReason | 'store-write-failed'; message: string }
  >
}

/** A loaded image's send-version bytes, in the form the request path needs. */
export interface RequestImageBytes {
  bytes: Uint8Array
  mimeType: ImageMimeType
}

/**
 * Loads a ref's send-version bytes — the only way pixels reach a request.
 * Structurally satisfied by `ImageAttachmentService.readSendBytes`; the loop
 * consults it only after the final send decision (design §11.1 step 5), so
 * preparation, projection, and budget work never touch image bytes.
 */
export interface AttachmentBytesLoader {
  readSendBytes(
    ref: ImageAttachmentRef,
  ): Promise<
    | { ok: true; value: RequestImageBytes }
    | { ok: false; reason: ImageInputErrorReason | 'store-write-failed'; message: string }
  >
}

/** A session's part in a project's coordination (see `services/coordination/`). */
export type CoordinationRole = 'coordinator' | 'thread'

export interface ToolContext {
  cwd: string
  /** Key for per-project data dirs (plans, memory, spill, transcripts). Absent means `cwd`. */
  projectDir?: string
  sessionId: string
  readFiles: Set<string>
  readFileState?: Map<string, ReadFileState>
  invokedSkills?: Map<string, { content: string; timestamp: number }>
  taskState?: Map<string, TaskItem>
  /**
   * The session's attachment store, used by the Read tool's image branch.
   * Absent where no store is wired (test loops) — image reads then fail with a
   * precondition instead of degrading to binary text. A subagent's context
   * holds its own handle over the project store, pinned to the parent session
   * so its images join the parent's artifact tree (design §12.3).
   */
  imageAttachments?: ImageAttachmentImporter
  /**
   * Live image-input capability of the model currently serving the loop —
   * including fallback, plan, and override switches — installed by the loop.
   * Absent means "not capable".
   */
  getSupportsImageInput?(): boolean
  abortSignal?: AbortSignal
  appendRecord?(record: SessionRecord): Promise<void>
  appendMetric?(metric: SessionMetricInput): Promise<void>
  /**
   * Called by write tools with an absolute path *before* they touch the file,
   * so file history can back up the pre-edit contents. Absent when no file
   * history service is wired; every write path must still work without it.
   */
  trackFileEdit?(filePath: string): Promise<void>
  currentToolUseId?: string
  currentTurnId?: string
  getPermissionMode?(): PermissionMode
  setPermissionMode?(mode: PermissionMode): void
  exitPlanMode?(): PermissionMode
  planModeBridge?: PlanModeBridge
  askUserQuestionBridge?: AskUserQuestionBridge
  /** Active provider name ('anthropic' | 'openai') — used by ToolSearchTool to format results. */
  providerName?: string
  /** Full unfiltered tool list for ToolSearchTool scoring. */
  _allTools?: Tool[]
  /** Tool names already discovered via ToolSearch — survives compaction. */
  discoveredToolNames?: Set<string>
  /** Tool names discovered AFTER the last compaction — these still have tool_reference blocks in history. */
  _postCompactDiscoveredNames?: Set<string>
  /** The durable prefix of this loop's latest request, for a fork to inherit. */
  _forkPrefix?: ForkPrefix
  /** Current skill slash command invocation metadata, attached only for the active turn. */
  skillInvocation?: {
    skillName: string
    skillArgs: string
    prompt: string
  }
}

export type ToolErrorCode =
  | 'invalid_input'
  | 'permission_denied'
  | 'precondition_failed'
  | 'stale_file'
  | 'not_found'
  | 'timeout'
  | 'command_failed'
  | 'execution_failed'
  | 'aborted'

export interface ReadFileState {
  /** Always LF-normalized, so `oldString` matching never sees a `\r`. */
  content: string
  timestamp: number
  mtimeMs: number
  ctimeMs?: number
  size: number
  dev?: number
  ino?: number
  /** Original on-disk encoding and line endings, restored on write-back. */
  encoding?: BufferEncoding
  lineEndings?: 'CRLF' | 'LF'
}

export interface ToolResult {
  ok: boolean
  content: string
  errorCode?: ToolErrorCode
  errorDetails?: unknown
  metadata?: ToolResultMetadata
  /** Images the tool produced; the ToolRunner persists them on the record. */
  images?: ImageAttachmentRef[]
}

/**
 * API-level tool_result block parameter.
 * Most tools use {type, tool_use_id, content: string}.
 * ToolSearch overrides to emit tool_reference content blocks.
 */
export interface ToolResultBlockParam {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<{ type: 'tool_reference'; tool_name: string } | { type: 'text'; text: string }>
  is_error?: boolean
}

export interface ToolResultMetadata extends Record<string, unknown> {
  display?: ToolResultDisplay
}

export interface ToolResultDisplay {
  summary: string
  headerSuffix?: string
  detail?: string
  taskSnapshot?: TaskDisplaySnapshot
  /** `AskUserQuestion`: the user's answers, keyed by question text. */
  answers?: Record<string, string>
}

export interface TaskDisplaySnapshot {
  tasks: TaskDisplayItem[]
  counts: TaskDisplayCounts
  activeTaskId?: string
}

export interface TaskDisplayItem {
  id: string
  status: TaskItem['status']
  subject: string
  description: string
  activeForm?: string
  owner?: string
  blocks: string[]
  blockedBy: string[]
}

export interface TaskDisplayCounts {
  total: number
  remaining: number
  pending: number
  inProgress: number
  completed: number
}

export interface Tool {
  name: string
  /** When set, the tool is offered only to sessions with one of these roles. Absent means available to everyone. */
  sessionRoles?: readonly CoordinationRole[]
  description: string
  inputSchema: ZodTypeAny
  apiInputSchema?: JsonSchema
  validateInput?(input: unknown): ToolValidationResult
  riskLevel: RiskLevel
  isReadOnly?: boolean
  /** Input-sensitive `isReadOnly`, for tools whose effect depends on the call. */
  isReadOnlyInput?(input: unknown): boolean
  /**
   * The call's risk tier (`harness/risk/`), for tools whose metadata cannot
   * say it: without it the tier follows `isReadOnly`/`riskLevel`.
   */
  classifyRisk?(input: unknown, context: RiskContext): RiskTier
  isDestructive?: boolean
  /**
   * Maximum persisted tool result content size. This is applied once when the
   * tool result is recorded so later request preparation sees stable bytes.
   */
  maxResultSizeChars?: number
  /**
   * True only for tools that can run alongside other safe tools without
   * mutating project files or shared write-tracking state.
   */
  isConcurrencySafe?: boolean
  /**
   * Optional input-sensitive concurrency check for tools whose safety depends
   * on the requested mode or subcommand.
   */
  isConcurrencySafeInput?(input: unknown): boolean
  /**
   * One-line capability phrase used by ToolSearch for keyword matching.
   * Should be 3-10 words describing what the tool does (e.g. "search file contents with regex").
   */
  searchHint?: string
  /**
   * When true, this tool is deferred and requires ToolSearch to load its schema
   * before it can be called. Deferred tools are announced by name only in the
   * system prompt; the model must use ToolSearch to discover their parameters.
   */
  shouldDefer?: boolean
  /**
   * When true, this tool is never deferred even if shouldDefer or isMcp is true.
   * Use for tools that must be available from the first turn.
   */
  alwaysLoad?: boolean
  /**
   * True for MCP-provided tools. MCP tools are deferred by default when
   * tool search is enabled, unless alwaysLoad is set.
   */
  isMcp?: boolean
  /**
   * User-facing name for TUI display. This mirrors Claude Code's tool-owned
   * display hooks without coupling core tools to React/Ink rendering.
   */
  userFacingName?(input: unknown): string
  /**
   * Short input summary shown in the TUI header, usually inside parentheses.
   */
  getToolUseSummary?(input: unknown): string | null | undefined
  /**
   * Present-tense activity description used by spinners/progress summaries.
   */
  getActivityDescription?(input: unknown): string | null | undefined
  /**
   * Whether the TUI should render the persisted result body under the tool use.
   */
  shouldDisplayResult?(input: unknown, result: string): boolean
  /**
   * Render-time customized one-line summary for the collapsed TUI view.
   * Runs in the React render path (not at tool execution), receives the full
   * persisted result string, and returns null to defer to display.summary.
   * Tools that already populate metadata.display.summary typically don't need
   * this hook — it's meant for tools whose result content needs parsing to
   * produce a human-readable line (e.g. Bash line counts, agent stats).
   */
  renderToolResultSummary?(input: unknown, result: string, ok: boolean): string | null
  /**
   * Convert the tool's execute() result into the API-level tool_result block.
   * Most tools return a string content; ToolSearch overrides this to emit
   * tool_reference content blocks for Anthropic's dynamic tool loading.
   * When not defined, the default behavior wraps result.content as plain text.
   * The optional `context` parameter provides providerName and _allTools
   * for provider-aware formatting (e.g. OpenAI schemas as text).
   */
  mapToolResultToToolResultBlockParam?(result: unknown, toolUseID: string, context?: ToolContext): ToolResultBlockParam
  execute(input: unknown, context: ToolContext): Promise<ToolResult>
}

export interface CommandContext {
  cwd: string
  writeLine(message: string): void
}

export interface Command {
  name: string
  description: string
  run(args: string[], context: CommandContext): Promise<void>
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

/**
 * One request's token counts, split the way a caching provider bills them.
 *
 * The three input-side fields are disjoint: `inputTokens` is what was sent
 * uncached, `cacheCreationInputTokens` what was written into the cache, and
 * `cacheReadInputTokens` what was served from it. Their sum is the whole prompt
 * — see `promptTokens()`, which is the only thing that should ever add them up.
 *
 * `cacheCreationInputTokens` is optional because it is persisted (subagent
 * records carry a `TokenUsage`) and because no OpenAI-compatible endpoint
 * reports it: absent means "this provider does not distinguish cache writes",
 * never zero writes. Treat it as 0 through `cacheCreationTokens()` and never
 * read the field directly.
 */
export interface TokenUsage {
  inputTokens: number
  cacheCreationInputTokens?: number
  cacheReadInputTokens: number
  outputTokens: number
}

export interface ModelPricing {
  cacheReadInputPerMillionTokens?: number
  /** Cache writes; Anthropic bills these above the input rate (1.25x for 5m). */
  cacheWriteInputPerMillionTokens?: number
  inputPerMillionTokens?: number
  outputPerMillionTokens?: number
  currency?: string
}

export interface AgentRunResult {
  content: string
  usage: TokenUsage
  statusUsage?: TokenUsage
  stopReason?: string
  truncated?: boolean
  segments?: string[]
}

export interface ContextChatMessage {
  kind: 'message'
  message: ChatMessage
}

export interface ContextToolUse {
  kind: 'tool_use'
  id: string
  tool: string
  input: unknown
}

export interface ContextToolResult {
  kind: 'tool_result'
  toolUseId: string
  tool: string
  ok: boolean
  content: string
  /** Pre-mapped API block (e.g. tool_reference for ToolSearch). */
  apiResultBlock?: ToolResultBlockParam
  /** Images carried from the persisted tool_result record. */
  images?: ImageAttachmentRef[]
}

export type ModelContextItem = ContextChatMessage | ContextToolUse | ContextToolResult

/**
 * A request's cacheable half — system, tools and history, minus the tail
 * rebuilt per request — with what a fork needs to judge whether it fits.
 */
export interface ForkPrefix {
  request: ModelRequest
  /** Prompt tokens the provider counted for that request. */
  promptTokens: number
  /** Where the parent loop would auto-compact. */
  usableContextWindow: number
}

export interface ModelRequest {
  system?: string
  systemBlocks?: string[]
  messages: ChatMessage[]
  contextItems?: ModelContextItem[]
  tools?: Tool[]
  model: string
  promptCacheRetention?: 'in_memory' | '24h'
  /**
   * `false` sends no `cache_control` at all. For one-shot requests (compaction,
   * summaries, extraction) whose prefix nothing reads back: a marker there only
   * buys a cache write, billed above the plain input rate.
   */
  promptCaching?: false
  maxOutputTokens?: number
  previousRequestId?: string
  thinking?: { type: 'adaptive' } | { type: 'enabled'; budgetTokens: number } | { type: 'disabled' }
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  retry?: { maxRetries?: number; signal?: AbortSignal; callerKind?: 'interactive' | 'background'; persistent?: boolean }
  cacheSource: CacheBreakSource
  cacheRuntime?: CacheRuntime
  /** When true, the Anthropic payload builder adds defer_loading and the tool-reference beta header. */
  hasDeferredTools?: boolean
  /** All deferred tool names from the FULL (unfiltered) tool list. Used for <available-deferred-tools>. */
  allDeferredToolNames?: Set<string>
  /** Tool names discovered after the last compaction — only these should have defer_loading. */
  postCompactDiscoveredNames?: Set<string>
  /**
   * Send-version bytes for the image refs this request still carries, keyed
   * by attachment id. Loaded once, after the final send decision (design
   * §11.1 step 5) — compaction and the count cap have already decided what
   * stays. Payload builders turn entries into provider image blocks; a ref
   * still riding `messages`/`contextItems` without an entry here is an
   * invariant violation and must fail the build, never silently drop the
   * image.
   */
  imageBytes?: Map<string, RequestImageBytes>
  onTextDelta?: (delta: string) => void
  onStreamEvent?: (event: ModelStreamEvent) => void
}

export interface ModelResponse {
  content: string
  toolCalls: ToolCall[]
  usage?: TokenUsage
  requestId?: string
  stopReason?: string
  reasoningContent?: string
  thinkingBlocks?: ThinkingBlock[]
  cacheBreak?: CacheBreakResult
}

export interface ModelProvider {
  name: string
  supportsDynamicToolSearch?(): boolean
  /**
   * Whether this adapter implements image input. Mirrors the class's static
   * capability flag so a live request path can ask the provider it is actually
   * holding; `resolveImageCapability` is the shared entry point that combines
   * this with the model config's switch.
   */
  supportsImageInput?(): boolean
  /**
   * This adapter's own per-request image-count limit, when it declares one
   * below the local default (design §8). `undefined` means "no adapter limit
   * known" — the local cap applies on its own.
   */
  maxImagesPerRequest?(): number | undefined
  /**
   * This adapter's own per-image send-byte limit, when it declares one below
   * the local default (design §8/§11.1). `undefined` means "no adapter limit
   * known". Effective limits always take the stricter of local and adapter.
   */
  maxImageBytes?(): number | undefined
  /**
   * This adapter's own limit for the whole serialized request body, when it
   * declares one below the local default (design §11.1). `undefined` means
   * "no adapter limit known".
   */
  maxRequestBodyBytes?(): number | undefined
  createMessage(request: ModelRequest): Promise<ModelResponse>
}
