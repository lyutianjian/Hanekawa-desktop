import type { Tool } from '../../harness/types.js'
import { sortedTasks, taskDisplay } from '../taskFormat.js'
import { applyTaskCreate, ensureTaskState } from '../taskState.js'
import { taskCreateInputSchema } from '../taskSchemas.js'
import { TASK_CREATE_TOOL_NAME } from './constants.js'
import { DESCRIPTION, getPrompt } from './prompt.js'

export const taskCreateTool: Tool = {
  name: TASK_CREATE_TOOL_NAME,
  description: `${DESCRIPTION}\n\n${getPrompt()}`,
  inputSchema: taskCreateInputSchema,
  riskLevel: 'safe',
  userFacingName: () => 'TaskCreate',
  getToolUseSummary(input) {
    const tasks = typeof input === 'object' && input !== null ? (input as { tasks?: unknown }).tasks : undefined
    if (!Array.isArray(tasks)) return null
    const subjects = tasks.map((task) => (task as { subject?: unknown } | null)?.subject).filter((subject) => typeof subject === 'string')
    return subjects.length > 0 ? subjects.join(' · ') : null
  },
  getActivityDescription: () => 'Creating tasks',
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const parsed = taskCreateInputSchema.parse(input)
    const tasks = ensureTaskState(context)
    const created = parsed.tasks.map((task) => applyTaskCreate(task, tasks))
    return {
      ok: true,
      content: `Created ${created.length === 1 ? 'task' : 'tasks'} ${created.map((task) => `#${task.id}: ${task.subject}`).join(', ')}`,
      metadata: { display: taskDisplay(sortedTasks(tasks.values())) },
    }
  },
}
