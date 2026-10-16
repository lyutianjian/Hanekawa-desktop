import type { TaskItem, Tool } from '../../harness/types.js'
import { isRemainingTask, sortedTasks, taskDisplay } from '../taskFormat.js'
import { applyTaskUpdate, claimTaskList, ensureTaskState } from '../taskState.js'
import { taskUpdateInputSchema } from '../taskSchemas.js'
import { TASK_UPDATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

export const taskUpdateTool: Tool = {
  name: TASK_UPDATE_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${PROMPT}`,
  inputSchema: taskUpdateInputSchema,
  riskLevel: 'safe',
  userFacingName: () => 'TaskUpdate',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const value = input as { taskId?: unknown; status?: unknown; subject?: unknown }
    const parts = [
      typeof value.taskId === 'string' ? `#${value.taskId}` : undefined,
      typeof value.status === 'string' ? value.status : undefined,
      typeof value.subject === 'string' ? value.subject : undefined,
    ].filter((part): part is string => Boolean(part))
    return parts.join(' ')
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Updating task'
    const value = input as { activeForm?: unknown; status?: unknown; subject?: unknown }
    if (value.status === 'in_progress' && typeof value.activeForm === 'string') return value.activeForm
    if (value.status === 'in_progress' && typeof value.subject === 'string') return value.subject
    return 'Updating task'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskUpdateInputSchema.parse(input)
    const tasks = ensureTaskState(context)
    const result = applyTaskUpdate(parsed, tasks)
    if (!result.found) {
      return {
        ok: true,
        content: 'Task not found',
        metadata: { display: { summary: 'Task not found' } },
      }
    }
    claimTaskList(tasks, context.requestTurnId)
    if (result.deleted) {
      return {
        ok: true,
        content: `Updated task #${parsed.taskId} deleted`,
        metadata: { display: taskDisplay(sortedTasks(tasks.values())) },
      }
    }

    const fields = [
      parsed.subject !== undefined ? 'subject' : undefined,
      parsed.description !== undefined ? 'description' : undefined,
      parsed.activeForm !== undefined ? 'activeForm' : undefined,
      parsed.status !== undefined ? 'status' : undefined,
      parsed.owner !== undefined ? 'owner' : undefined,
      parsed.addBlocks && parsed.addBlocks.length > 0 ? 'blocks' : undefined,
      parsed.addBlockedBy && parsed.addBlockedBy.length > 0 ? 'blockedBy' : undefined,
      parsed.metadata !== undefined ? 'metadata' : undefined,
    ].filter((field): field is string => Boolean(field))

    const all = sortedTasks(tasks.values())
    const progress = parsed.status === 'completed' ? describeProgress(all)
      : parsed.status === 'in_progress' ? describeOtherInProgress(all, parsed.taskId)
      : undefined
    return {
      ok: true,
      content: `Updated task #${parsed.taskId} ${fields.join(', ') || 'no changes'}.${progress ? ` ${progress}` : ''}`,
      metadata: { display: taskDisplay(all) },
    }
  },
}

function describeProgress(tasks: readonly TaskItem[]): string {
  const remaining = tasks.filter(isRemainingTask)
  if (remaining.length === 0) return 'All tasks are completed.'
  const count = remaining.length === 1 ? '1 task remains' : `${remaining.length} tasks remain`
  const inProgress = remaining.filter((task) => task.status === 'in_progress')
  if (inProgress.length > 0) return `${count}; in progress: ${inProgress.map(taskLabel).join(', ')}.`
  const completedIds = new Set(tasks.filter((task) => task.status === 'completed').map((task) => task.id))
  const next = remaining.find((task) => (task.blockedBy ?? []).every((id) => completedIds.has(id)))
  return next ? `${count}; next pending: ${taskLabel(next)}.` : `${count}.`
}

function describeOtherInProgress(tasks: readonly TaskItem[], taskId: string): string | undefined {
  const others = tasks.filter((task) => task.status === 'in_progress' && task.id !== taskId)
  if (others.length === 0) return undefined
  const ids = others.map((task) => `#${task.id}`).join(', ')
  return `${ids} ${others.length === 1 ? 'is' : 'are'} also in_progress; keep only one.`
}

function taskLabel(task: TaskItem): string {
  return `#${task.id} ${task.subject}`
}
