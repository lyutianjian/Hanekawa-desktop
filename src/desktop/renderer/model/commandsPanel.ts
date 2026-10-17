import type { BackgroundTaskSnapshot } from '../../../services/backgroundTasks/registry.js'

/**
 * The task page's 命令 section: the session's background shell processes,
 * running first, then the finished ones newest first. Agents are left out —
 * they are the 子代理 section's. Pure, from wire types only.
 */

export interface CommandRow {
  readonly id: string
  readonly command: string
  /** The bead's colour, in the sub-agent panel's vocabulary. */
  readonly tone: 'running' | 'done' | 'failed'
  readonly running: boolean
  /** 状态 · exit code, without the clock — the view ticks that in place. */
  readonly status: string
  readonly startedAt: number
  readonly finishedAt?: number
}

const STATUS_LABELS: Record<BackgroundTaskSnapshot['status'], string> = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  killed: '已停止',
  orphaned: '已脱管',
}

export function commandRows(tasks: readonly BackgroundTaskSnapshot[]): CommandRow[] {
  return tasks
    .filter((task) => task.kind === 'shell')
    .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt)
    .map((task) => {
      const exit = task.exitCode !== undefined && task.exitCode !== null ? `exit ${task.exitCode}` : undefined
      return {
        id: task.id,
        command: task.command ?? task.description ?? task.id,
        tone: task.status === 'running' ? 'running' : task.status === 'completed' ? 'done' : 'failed',
        running: task.status === 'running',
        status: [STATUS_LABELS[task.status], exit].filter((part) => part !== undefined).join(' · '),
        startedAt: task.startedAt,
        ...(task.finishedAt === undefined ? {} : { finishedAt: task.finishedAt }),
      }
    })
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h${minutes % 60}m`
}
