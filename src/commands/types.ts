import type { SessionRecord, TokenUsage } from '../harness/types.js'
import type { EffortLevel } from '../config/effort.js'
import type { Hooks } from '../harness/hooks.js'

export interface CommandDefinition {
  name: string
  description: string
  aliases?: string[]
  argumentHint?: string
  isHidden?: boolean
  isEnabled?: () => boolean
  run: (args: string, context: CommandContext) => Promise<string | void>
}

export type CommandUsage = TokenUsage

export interface CommandSessionMetricsSummary {
  totalCacheHitRate: number | null
  totalTurns: number
  firstBreakTurnCount: number | null
  cacheBreakCount: number
  averageCompactIntervalTurns: number | null
}

/** `busy`: a turn is running. `empty`: no user message since the last compaction. */
export type CommandCompactResult = 'compacted' | 'busy' | 'empty'

export interface CommandModelInfo {
  key: string
  model: string
  providerName: string
}

export type SetModelResult =
  /**
   * `notice` is informational only — a manual switch is never refused because
   * of images already in the conversation (design §9.1). It describes what the
   * new model will do with them, and callers render it next to the success
   * line rather than as a confirmation prompt.
   */
  | { ok: true; model: CommandModelInfo; notice?: string }
  | { ok: false; message: string; availableModels?: string[] }

export interface CommandSubagentDetails {
  task?: Extract<SessionRecord, { type: 'subagent_task' }>
  transcript?: Extract<SessionRecord, { type: 'subagent_transcript' }>
  transcriptRecords: SessionRecord[]
}

export interface CommandSubagentCleanupResult {
  dryRun: boolean
  entries: Array<{
    agentId: string
    status: string
    worktreePath: string
    exists: boolean
    removed?: boolean
    error?: string
  }>
}

export interface CommandSubmitQueryOptions {
  allowedTools?: string[]
  model?: string
  effort?: EffortLevel
  hooks?: Hooks
  skillName?: string
  skillArgs?: string
  displayInput?: string
}

export interface CommandShellResult {
  ok: boolean
  content: string
  errorCode?: string
}

export type CommandView =
  | {
      kind: 'list'
      title: string
      subtitle?: string
      items: Array<{ id: string; label: string; description?: string }>
    }
  | {
      kind: 'info'
      title: string
      subtitle?: string
      sections: Array<{
        title?: string
        rows: Array<{ label: string; value: string; tone?: 'normal' | 'success' | 'warning' | 'error' }>
      }>
    }

export interface CommandContext {
  cwd: string
  sessionId: string
  /** `tone: 'error'` draws the line as a failure rather than as information. */
  writeLine: (msg: string, tone?: 'error') => void
  openCommandView?: (view: CommandView) => void
  clearMessages: () => void | Promise<void>
  clearCachedSections?: () => void
  invalidateRecordsCache?: () => void
  repairRecords?: () => Promise<{ repairedCount: number; diagnostics: Array<{ message: string }> }>
  /** Summarizes the conversation now; throws when the summary fails. */
  compactConversation?: (instructions?: string) => Promise<CommandCompactResult>
  getUsage?: () => CommandUsage
  getSessionMetricsSummary?: () => Promise<CommandSessionMetricsSummary | null>
  getModel?: () => CommandModelInfo | undefined
  setModel?: (model: string) => void | SetModelResult | Promise<void | SetModelResult>
  getEffort?: () => string
  setEffort?: (level: string) => void | Promise<void>
  openModelPicker?: () => void
  openEffortPicker?: () => void
  reloadAgentDefinitions?: () => Promise<number>
  /** Re-reads `.myagent/skills/` and re-registers their slash commands. */
  reloadSkills?: () => Promise<number>
  getPermissionMode?: () => string
  enterPlanMode?: () => void | Promise<void>
  readPlanFile?: () => Promise<{ path: string; content: string | null }>
  openPlanFile?: () => Promise<{ message: string }>
  submitQuery?: (input: string, options?: CommandSubmitQueryOptions) => Promise<void>
  /** `/paste-image`: capture the system clipboard's image into the composer's draft. */
  pasteImageFromClipboard?: () => Promise<void>
  /** Draft image attachment lines as the strip shows them, numbered. */
  listDraftAttachments?: () => string[]
  /** Removes the 1-based numbered draft image; renumbering follows the list. */
  removeDraftAttachment?: (index: number) => { ok: boolean; message?: string }
  /** Drops every draft image attachment (files stay with their session). */
  clearDraftAttachments?: () => void
  runShellCommand?: (command: string) => Promise<CommandShellResult>
  openProviderPanel?: () => void
  openBackgroundTasks?: () => void
  openResumePicker?: () => void
  /** `/rewind`: the checkpoint panel. Terminal-side this is also Escape-Escape. */
  openRewindPanel?: () => void
  listSubagentTasks?: () => Promise<Array<Extract<SessionRecord, { type: 'subagent_task' }>>>
  getSubagentDetails?: (agentIdOrPrefix: string) => Promise<CommandSubagentDetails | null>
  cleanupSubagentWorktrees?: (options: { apply: boolean }) => Promise<CommandSubagentCleanupResult>
}

export type CommandResult =
  | { type: 'continue' }
  | { type: 'exit' }
  | { type: 'message'; text: string }
