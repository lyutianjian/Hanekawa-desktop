import type { ActivityStep } from './transcript.js'

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
  WebFetch: { verb: '抓取', target: 'text' },
  WebSearch: { verb: '联网搜索', target: 'text' },
  Browser: { verb: '浏览器', target: 'text' },
  Skill: { verb: '使用技能', target: 'text' },
  Agent: { verb: '子代理', target: 'text' },
  SendMessage: { verb: '发送消息', target: 'text' },
  AskUserQuestion: { verb: '等待回答' },
  TodoWrite: { verb: '更新任务' },
  TaskCreate: { verb: '更新任务' },
  TaskUpdate: { verb: '更新任务' },
  TaskList: { verb: '查看任务' },
  TaskGet: { verb: '查看任务' },
  EnterPlanMode: { verb: '进入计划模式' },
  ExitPlanMode: { verb: '提出计划' },
  Config: { verb: '修改设置' },
}

const PLURALS: Record<string, readonly [string, string]> = {
  Read: ['读取', '个文件'],
  Edit: ['编辑', '个文件'],
  MultiEdit: ['编辑', '个文件'],
  Write: ['写入', '个文件'],
  Delete: ['删除', '个文件'],
  Grep: ['搜索', '处'],
  Glob: ['查找', '组文件'],
  Bash: ['运行', '个命令'],
  WebFetch: ['抓取', '个网页'],
  WebSearch: ['联网搜索', '次'],
  Agent: ['运行', '个子代理'],
}

const TARGET_MAX = 40

/**
 * A call as a verb and what it acts on. `bare` marks a shell command the model
 * described: 「检查工作目录」 already says everything, and 「运行 检查工作目录」 would
 * only add a word. Without a description the command itself is the target, and
 * keeps its verb.
 */
export function callParts(step: CallStep, fullPath = false): { readonly verb: string; readonly target: string; readonly bare: boolean } {
  const phrase = step.toolName === undefined ? undefined : PHRASES[step.toolName]
  if (phrase === undefined) {
    const name = step.tool.displayName || step.toolName || '工具'
    return { verb: `调用 ${name}`, target: '', bare: false }
  }
  if (phrase.target === undefined) return { verb: phrase.verb, target: '', bare: false }
  // Grep and Glob caption as `pattern · glob · path`; the pattern is the target.
  const raw = step.tool.description ?? step.tool.useSummary.split(' · ')[0] ?? ''
  const oneLine = raw.replace(/\s+/g, ' ').trim()
  const target = phrase.target === 'file' && !fullPath ? oneLine.split(/[\\/]/).pop()! : oneLine
  return { verb: phrase.verb, target, bare: step.toolName === 'Bash' && !!step.tool.description?.trim() }
}

/** 「读取 waiting.ts」, for the live line: the target is clipped to one short phrase. */
export function callPhrase(step: CallStep): string {
  const { verb, target, bare } = callParts(step)
  if (target.length === 0) return verb
  const clipped = target.length > TARGET_MAX ? `${target.slice(0, TARGET_MAX - 1)}…` : target
  return bare ? clipped : `${verb}${step.toolName === 'Agent' ? ' · ' : ' '}${clipped}`
}

/**
 * Calls that run together, said once: the same tool as a count (「读取 3 个文件」),
 * a mix as the last one plus how many (「… 等 3 项」) — the last because a batch
 * settles in order and the one still open is the one being waited on.
 */
export function batchPhrase(running: readonly CallStep[]): string {
  const last = running[running.length - 1]!
  if (running.length === 1) return callPhrase(last)
  const plural = last.toolName !== undefined && running.every((step) => step.toolName === last.toolName)
    ? PLURALS[last.toolName]
    : undefined
  return plural ? `${plural[0]} ${running.length} ${plural[1]}` : `${callPhrase(last)} 等 ${running.length} 项`
}
