import type { BackgroundTaskSnapshot } from '../../../services/backgroundTasks/registry.js'
import { commandRows } from './commandsPanel.js'
import type { ThreadTone } from './coordinationStatus.js'
import { subagentTone, type SubagentEntry } from './subagentPanel.js'
import { toolStatusLabel } from './transcript.js'

export type TaskGroup = 'running' | 'finished'

export interface BackgroundTaskRow {
  readonly id: string
  readonly kind: 'shell' | 'agent'
  readonly title: string
  readonly tone: ThreadTone
  readonly running: boolean
  readonly status: string
  readonly model?: string
  readonly startedAt?: number
  readonly durationMs?: number
  readonly tokens?: number
}

export type BackgroundTaskGroups = Readonly<Record<TaskGroup, readonly BackgroundTaskRow[]>>

/** Both kinds share a list: active in start order, finished newest first. */
export function backgroundTaskGroups(tasks: readonly BackgroundTaskSnapshot[], agents: readonly SubagentEntry[]): BackgroundTaskGroups {
  const rows: BackgroundTaskRow[] = commandRows(tasks).map((command) => ({
    id: command.id,
    kind: 'shell',
    title: command.command,
    tone: command.tone === 'running' ? 'running' : command.tone === 'done' ? 'muted' : 'danger',
    running: command.running,
    status: command.status,
    startedAt: command.startedAt,
    ...(command.finishedAt === undefined ? {} : { durationMs: Math.max(0, command.finishedAt - command.startedAt) }),
  }))
  for (const agent of agents) {
    const task = tasks.find((candidate) => candidate.kind === 'agent' && candidate.toolUseId === agent.id)
    const startedAt = task?.startedAt ?? agent.startedAt
    const durationMs = task?.finishedAt !== undefined && startedAt !== undefined
      ? Math.max(0, task.finishedAt - startedAt)
      : agent.durationMs
    rows.push({
      id: agent.id,
      kind: 'agent',
      title: agent.description,
      tone: subagentTone(agent.status),
      running: agent.status === 'running' || agent.status === 'awaiting-approval',
      status: toolStatusLabel(agent.status),
      ...(agent.model === undefined ? {} : { model: agent.model }),
      ...(startedAt === undefined ? {} : { startedAt }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(agent.tokens === undefined ? {} : { tokens: agent.tokens }),
    })
  }
  return {
    running: rows.filter((row) => row.running).sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0)),
    finished: rows.filter((row) => !row.running).sort((a, b) => endedAt(b) - endedAt(a)),
  }
}

function endedAt(row: BackgroundTaskRow): number {
  return (row.startedAt ?? 0) + (row.durationMs ?? 0)
}
