import type { ActivityStep } from './transcript.js'

/**
 * Calls on the project's memory directory, which the host marks
 * (`ToolDisplayDto.memory`), read as memory work rather than file work:
 * 「保存记忆 user-role」 instead of 「写入 user-role.md」.
 */

export type MemoryOp = 'recall' | 'search' | 'save' | 'update' | 'delete'

type ToolStep = Extract<ActivityStep, { kind: 'tool' | 'task' }>

const OPS: Readonly<Record<string, MemoryOp>> = {
  Read: 'recall',
  Grep: 'search',
  Glob: 'search',
  Write: 'save',
  Edit: 'update',
  MultiEdit: 'update',
  Delete: 'delete',
}

/** The memory op a step is, or undefined for an ordinary call. */
export function memoryOp(step: ActivityStep): MemoryOp | undefined {
  if ((step.kind !== 'tool' && step.kind !== 'task') || step.tool.memory !== true || step.toolName === undefined) return undefined
  return OPS[step.toolName]
}

function fileName(step: ToolStep): string {
  return (step.tool.useSummary.split(' · ')[0] ?? '').trim().split(/[\\/]/).pop()!
}

/** `MEMORY.md`, the index — never counted as a memory. */
export function isMemoryIndex(step: ActivityStep): boolean {
  const op = memoryOp(step)
  return op !== undefined && op !== 'search' && fileName(step as ToolStep) === 'MEMORY.md'
}

/** The memory's slug: the file name without `.md`. */
export function memorySlug(step: ToolStep): string {
  return fileName(step).replace(/\.md$/, '')
}

/**
 * The steps a run draws: a settled write to the index is folded into the memory
 * save beside it, since the index line only restates that save. A failed or
 * interrupted index write still draws.
 */
export function drawnSteps(steps: readonly ActivityStep[]): readonly ActivityStep[] {
  const changes = (step: ActivityStep): boolean => {
    const op = memoryOp(step)
    return op === 'save' || op === 'update' || op === 'delete'
  }
  if (!steps.some((step) => changes(step) && !isMemoryIndex(step))) return steps
  const folded = steps.filter((step) => !(changes(step) && isMemoryIndex(step) && step.kind === 'tool' && step.status === 'done'))
  return folded.length === steps.length ? steps : folded
}
