import type { SessionRecord, TaskItem, ToolContext } from '../harness/types.js'
import { isSystemReminderBlock } from '../harness/systemReminder.js'
import { normalizeToolInput } from './inputAliases.js'
import { normalizeTask, sortedTasks } from './taskFormat.js'
import {
  taskCreateInputSchema,
  taskUpdateInputSchema,
  type NewTaskInput,
  type TaskUpdateInput,
} from './taskSchemas.js'

const TASK_TOOL_NAMES = new Set(['TaskCreate', 'TaskUpdate'])

export function ensureTaskState(context: ToolContext): Map<string, TaskItem> {
  if (!context.taskState) context.taskState = new Map()
  return context.taskState
}

export function currentSortedTasks(context: ToolContext): TaskItem[] {
  return sortedTasks(ensureTaskState(context).values())
}

function nextTaskId(tasks: ReadonlyMap<string, TaskItem>): string {
  const numericIds = [...tasks.keys()]
    .map((id) => Number.parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0)
  let index = numericIds.length > 0 ? Math.max(...numericIds) + 1 : tasks.size + 1
  while (tasks.has(String(index))) index++
  return String(index)
}

export function applyTaskCreate(input: NewTaskInput, tasks: Map<string, TaskItem>, requestTurnId?: string): TaskItem {
  const id = nextTaskId(tasks)
  const task = normalizeTask({
    id,
    status: 'pending',
    subject: input.subject,
    description: input.description,
    ...(input.activeForm ? { activeForm: input.activeForm } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
    ...(requestTurnId ? { requestTurnId } : {}),
  })
  tasks.set(id, task)
  return task
}

/**
 * A list is local to one user request. The request's first `TaskCreate`
 * starts over, dropping what an earlier request left, finished or not, so IDs
 * restart at 1; once this request has written the list, it only adds.
 */
export function startRequestTaskList(tasks: Map<string, TaskItem>, requestTurnId: string | undefined): void {
  if (requestTurnId === undefined) return
  for (const task of tasks.values()) {
    if (task.requestTurnId !== requestTurnId) {
      tasks.clear()
      return
    }
  }
}

/** A `TaskUpdate` in a later request carries the whole list over into it. */
export function claimTaskList(tasks: Map<string, TaskItem>, requestTurnId: string | undefined): void {
  if (requestTurnId === undefined) return
  for (const [id, task] of tasks) {
    if (task.requestTurnId !== requestTurnId) tasks.set(id, { ...task, requestTurnId })
  }
}

function mergeMetadata(existing: Record<string, unknown> | undefined, incoming: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!incoming) return existing
  const merged = { ...(existing ?? {}) }
  for (const [key, value] of Object.entries(incoming)) {
    if (value === null) delete merged[key]
    else merged[key] = value
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function addUniqueValues(current: readonly string[] | undefined, incoming: readonly string[] | undefined): string[] | undefined {
  if (!incoming || incoming.length === 0) return current ? [...current] : undefined
  const next = new Set(current ?? [])
  for (const item of incoming) next.add(item)
  return [...next]
}

function deleteTask(tasks: Map<string, TaskItem>, taskId: string): boolean {
  const deleted = tasks.delete(taskId)
  if (!deleted) return false
  for (const [id, task] of tasks) {
    const blocks = (task.blocks ?? []).filter((candidate) => candidate !== taskId)
    const blockedBy = (task.blockedBy ?? []).filter((candidate) => candidate !== taskId)
    tasks.set(id, normalizeTask({ ...task, blocks, blockedBy }))
  }
  return true
}

export function applyTaskUpdate(input: TaskUpdateInput, tasks: Map<string, TaskItem>): { found: boolean; deleted?: boolean; updated?: TaskItem } {
  const existing = tasks.get(input.taskId)
  if (!existing) return { found: false }

  if (input.status === 'deleted') {
    return { found: true, deleted: deleteTask(tasks, input.taskId) }
  }

  const updated = normalizeTask({
    ...existing,
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.description !== undefined ? { description: input.description } : {}),
    ...(input.activeForm !== undefined ? { activeForm: input.activeForm } : {}),
    ...(input.owner !== undefined ? { owner: input.owner } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    blocks: addUniqueValues(existing.blocks, input.addBlocks) ?? [],
    blockedBy: addUniqueValues(existing.blockedBy, input.addBlockedBy) ?? [],
    metadata: mergeMetadata(existing.metadata, input.metadata),
  })
  tasks.set(input.taskId, updated)

  for (const blockId of input.addBlocks ?? []) {
    const blocked = tasks.get(blockId)
    if (blocked) {
      tasks.set(blockId, normalizeTask({
        ...blocked,
        blockedBy: addUniqueValues(blocked.blockedBy, [input.taskId]) ?? [],
      }))
    }
  }
  for (const blockerId of input.addBlockedBy ?? []) {
    const blocker = tasks.get(blockerId)
    if (blocker) {
      tasks.set(blockerId, normalizeTask({
        ...blocker,
        blocks: addUniqueValues(blocker.blocks, [input.taskId]) ?? [],
      }))
    }
  }

  return { found: true, updated }
}

/**
 * Replays the task tools, request boundaries included: a request starts with
 * the first user record of a turn unless that record is only system reminders
 * — the same turns the loop sets `requestTurnId` for.
 */
export function restoreTaskStateFromRecords(records: readonly SessionRecord[]): Map<string, TaskItem> {
  const tasks = new Map<string, TaskItem>()
  const toolUses = new Map<string, Extract<SessionRecord, { type: 'tool_use' }>>()
  let requestTurnId: string | undefined
  let userTurnId: string | undefined

  for (const record of records) {
    if (record.type === 'message' && record.role === 'user') {
      if ((record.turnId === undefined || record.turnId !== userTurnId) && !isSystemReminderBlock(record.content)) {
        requestTurnId = record.turnId ?? record.id
      }
      userTurnId = record.turnId
      continue
    }
    if (record.type === 'tool_use' && TASK_TOOL_NAMES.has(record.tool)) {
      toolUses.set(record.id, record)
      continue
    }

    if (record.type !== 'tool_result' || !record.ok) continue
    const toolUse = toolUses.get(record.toolUseId)
    if (!toolUse) continue

    try {
      if (toolUse.tool === 'TaskCreate') {
        // Sessions recorded before the batch shape hold one task at the top level.
        const { tasks: created } = taskCreateInputSchema.parse(normalizeToolInput('TaskCreate', toolUse.input))
        startRequestTaskList(tasks, requestTurnId)
        for (const task of created) applyTaskCreate(task, tasks, requestTurnId)
      } else if (toolUse.tool === 'TaskUpdate') {
        if (applyTaskUpdate(taskUpdateInputSchema.parse(toolUse.input), tasks).found) claimTaskList(tasks, requestTurnId)
      }
    } catch {
      // Ignore stale or malformed historical task calls; live execution already validates inputs.
    }
  }

  return tasks
}
