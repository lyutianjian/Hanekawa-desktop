/**
 * The task panel's agents, as data: every `Agent` call in a transcript,
 * flattened into what a list row and a detail page draw.
 *
 * DOM-free like the rest of `model/`.
 */

import { splitAgentReply } from './agentReply.js'
import type { ThreadTone } from './coordinationStatus.js'
import { toolStepStatus, type ToolStepDetail, type ToolStepStatus, type TranscriptItem } from './transcript.js'

export const AGENT_TOOL = 'Agent'

/** The continuation notice the result carries for the model — a background run's only id until it ends. */
const AGENT_ID = /Agent ID: ([A-Za-z0-9_-]+)\. Use SendMessage/

export interface SubagentEntry {
  /** The `Agent` call's tool-use id — the same id its transcript step carries. */
  readonly id: string
  /** The run's own id, which names its transcript file; unknown until it starts a tool. */
  readonly agentId?: string
  readonly name: string
  readonly agentType?: string
  /** What the parent called the job — the call's own summary line. */
  readonly description: string
  readonly status: ToolStepStatus
  /**
   * The run itself is over: its own record arrived, or the call failed. Not
   * `status`, which a background run's call reaches the moment it starts.
   */
  readonly finished: boolean
  readonly model?: string
  /** Epoch ms, for a running clock. */
  readonly startedAt?: number
  readonly durationMs?: number
  readonly task?: string
  readonly reply?: string
  readonly notes: readonly string[]
}

/**
 * The tone a status shows in: the five the thread list uses, so 「running」 reads
 * as the same spinning mark on both sides of the shell. A run that was cut off
 * gets no failure colour — nothing failed, it stopped — just the neutral rung.
 */
export function subagentTone(status: ToolStepStatus): ThreadTone {
  switch (status) {
    case 'running': return 'running'
    case 'awaiting-approval': return 'attention'
    case 'failed': return 'danger'
    case 'done': return 'muted'
    case 'interrupted': return 'neutral'
  }
}

/** Running ones first in the order they started, then the finished, newest first. */
export function subagentEntries(items: readonly TranscriptItem[]): SubagentEntry[] {
  const running: SubagentEntry[] = []
  const settled: SubagentEntry[] = []
  for (const item of items) {
    if (item.kind !== 'tool' || item.toolName !== AGENT_TOOL || item.tool === undefined) continue
    const entry = toEntry(item)
    if (entry.status === 'running' || entry.status === 'awaiting-approval') running.push(entry)
    else settled.unshift(entry)
  }
  return [...running, ...settled]
}

function toEntry(item: TranscriptItem): SubagentEntry {
  const tool = item.tool!
  const status = toolStepStatus(item)
  const reply = tool.content === undefined ? undefined : splitAgentReply(tool.content)
  const startedAt = tool.startedAt === undefined ? Number.NaN : Date.parse(tool.startedAt)
  const response = fullerReply(reply?.text, tool.subagent?.summary)
  const agentId = tool.subagent?.agentId ?? tool.live?.agentId ?? (tool.content === undefined ? undefined : AGENT_ID.exec(tool.content)?.[1])
  return {
    id: item.id,
    name: tool.displayName,
    description: agentDescription(tool),
    status,
    finished: status === 'failed' || status === 'interrupted' || tool.subagent !== undefined,
    notes: reply?.notes ?? [],
    ...(agentId === undefined ? {} : { agentId }),
    ...(tool.agentType === undefined ? {} : { agentType: tool.agentType }),
    ...(tool.subagent?.model === undefined ? {} : { model: tool.subagent.model }),
    ...(Number.isFinite(startedAt) ? { startedAt } : {}),
    // A detached run's call settled at its start; that span is not the run's.
    ...(tool.durationMs === undefined || status === 'running' ? {} : { durationMs: tool.durationMs }),
    ...(tool.task === undefined ? {} : { task: tool.task }),
    ...(response === undefined ? {} : { reply: response }),
  }
}

export function agentDescription(tool: Pick<ToolStepDetail, 'description' | 'task' | 'useSummary'>): string {
  const text = tool.description || tool.task || tool.useSummary || '未命名任务'
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > 80 ? `${line.slice(0, 79)}…` : line
}

/**
 * The fuller of the result's `content` and the run's own transcript: the same
 * report budgeted differently, and a background agent's result is only a start
 * notice, so the longer text is the truer reply.
 */
function fullerReply(content: string | undefined, summary: string | undefined): string | undefined {
  if (content === undefined || content.length === 0) return summary
  if (summary === undefined || summary.length === 0) return content
  return content.length >= summary.length ? content : summary
}
