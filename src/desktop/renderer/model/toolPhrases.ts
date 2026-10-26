import type { ActivityStep, TaskOp } from './transcript.js'
import { isMemoryIndex, memoryOp, memorySlug, type MemoryOp } from './memoryOps.js'

/**
 * How a tool call reads as an action, shared by the live status line (「读取
 * waiting.ts」) and the rows of an opened run card (「读取 **waiting.ts**」).
 */

export type CallStep = Extract<ActivityStep, { kind: 'tool' | 'task' }>

/** How each built-in reads as an activity: the verb, and which target it names. */
const PHRASES: Record<string, { readonly verb: string; readonly target?: 'file' | 'text' }> = {
  Read: { verb: '读取', target: 'file' },
  Edit: { verb: '编辑', target: 'file' },
  MultiEdit: { verb: '编辑', target: 'file' },
  NotebookEdit: { verb: '编辑', target: 'text' },
  Write: { verb: '写入', target: 'file' },
  Delete: { verb: '删除', target: 'file' },
  Grep: { verb: '搜索', target: 'text' },
  Glob: { verb: '查找文件', target: 'text' },
  Bash: { verb: '运行', target: 'text' },
  BashOutput: { verb: '读取输出' },
  KillShell: { verb: '结束进程' },
  Monitor: { verb: '监控', target: 'text' },
  WebFetch: { verb: '抓取', target: 'text' },
  WebSearch: { verb: '联网搜索', target: 'text' },
  Browser: { verb: '浏览器', target: 'text' },
  Skill: { verb: '使用技能', target: 'text' },
  Agent: { verb: '子代理', target: 'text' },
  SendMessage: { verb: '发送消息', target: 'text' },
  AskUserQuestion: { verb: '等待你回答' },
  TodoWrite: { verb: '更新任务' },
  TaskCreate: { verb: '更新任务' },
  TaskUpdate: { verb: '更新任务' },
  TaskList: { verb: '查看任务' },
  TaskGet: { verb: '查看任务' },
  EnterPlanMode: { verb: '进入计划模式' },
  ExitPlanMode: { verb: '提出计划' },
  Config: { verb: '修改设置' },
}

const TARGET_MAX = 40

/**
 * A call as a verb and what it acts on. `bare` marks a shell command the model
 * described: 「检查工作目录」 already says everything, and 「运行 检查工作目录」 would
 * only add a word. Without a description the command's first word is the target,
 * and keeps its verb.
 */
export function callParts(step: CallStep, fullPath = false): { readonly verb: string; readonly target: string; readonly bare: boolean } {
  if (step.tool.taskOps !== undefined) return { verb: taskPhrase(step.tool.taskOps), target: '', bare: false }
  const memory = memoryOp(step)
  if (memory !== undefined) return memoryParts(step, memory)
  const phrase = step.toolName === undefined ? undefined : PHRASES[step.toolName]
  if (phrase === undefined) {
    const name = step.tool.displayName || step.toolName || '工具'
    return { verb: `调用 ${name}`, target: '', bare: false }
  }
  if (phrase.target === undefined) return { verb: phrase.verb, target: '', bare: false }
  // Grep and Glob caption as `pattern · glob · path`; the pattern is the target.
  const raw = step.tool.description ?? step.tool.useSummary.split(' · ')[0] ?? ''
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  const target = phrase.target === 'file' && !fullPath ? oneLine.split(/[\\/]/).pop()! : bashWord(step, oneLine)
  return { verb: phrase.verb, target, bare: step.toolName === 'Bash' && !!step.tool.description?.trim() }
}

const MEMORY_VERBS: Readonly<Record<MemoryOp, string>> = {
  recall: '调取记忆', search: '查找记忆', save: '保存记忆', update: '更新记忆', delete: '删除记忆',
}

/** 「保存记忆 user-role」; the index is named for what touching it does, 「整理记忆索引」. */
function memoryParts(step: CallStep, op: MemoryOp): { readonly verb: string; readonly target: string; readonly bare: boolean } {
  if (isMemoryIndex(step)) return { verb: op === 'recall' ? '调取记忆索引' : '整理记忆索引', target: '', bare: false }
  const target = op === 'search' ? (step.tool.useSummary.split(' · ')[0] ?? '') : memorySlug(step)
  return { verb: MEMORY_VERBS[op], target, bare: false }
}

/** An undescribed command reads as its first word, 「运行 sed…」; the whole command is in the body. */
function bashWord(step: CallStep, target: string): string {
  if (step.toolName !== 'Bash' || step.tool.description?.trim()) return target
  const [word = '', ...rest] = target.split(' ')
  return rest.length > 0 ? `${word}…` : word
}

const TASK_VERBS = { start: '开始', complete: '完成', update: '更新', delete: '删除' } as const

/**
 * What a row of task calls did: 「创建 5 个任务」, 「开始任务 1，完成任务 2」. A few ids
 * are named, more are counted; a row that only looked is 「查看任务」.
 */
export function taskPhrase(ops: readonly TaskOp[]): string {
  const created = ops.reduce((sum, op) => sum + (op.kind === 'create' ? op.count : 0), 0)
  const parts = created > 0 ? [`创建 ${created} 个任务`] : []
  for (const kind of ['start', 'complete', 'update', 'delete'] as const) {
    const ids = [...new Set(ops.flatMap((op) => (op.kind === kind ? [op.id] : [])))]
    if (ids.length === 0) continue
    parts.push(ids.length <= 3 ? `${TASK_VERBS[kind]}任务 ${ids.join('、')}` : `${TASK_VERBS[kind]} ${ids.length} 个任务`)
  }
  return parts.join('，') || '查看任务'
}

/**
 * 「读取 waiting.ts」, for the live line: the target is clipped to one short phrase.
 * A command the model did not describe, and a tool with no phrase of its own, say
 * only what kind of thing runs — 「运行命令」 when it waits on the user's approval.
 */
export function callPhrase(step: CallStep, approving = false): string {
  const generic = step.toolName === 'Bash' && !step.tool.description?.trim() ? '命令'
    : step.tool.taskOps === undefined && (step.toolName === undefined || PHRASES[step.toolName] === undefined) ? '工具'
    : undefined
  if (generic !== undefined) return `${approving ? '' : '正在'}运行${generic}`
  const { verb, target, bare } = callParts(step)
  if (target.length === 0) return verb
  const clipped = target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX - 1)}…` : target
  return bare ? clipped : `${verb}${step.toolName === 'Agent' ? ' · ' : ' '}${clipped}`
}
