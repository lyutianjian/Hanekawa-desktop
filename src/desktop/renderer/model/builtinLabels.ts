import type { WireCommandInfo } from '../../../runtime/protocol/wire.js'

/**
 * Chinese captions for the built-in slash commands — display only.
 *
 * The English descriptions stay where they are, so this table is a mirror
 * applied at the last step, keyed by name *and* the English it replaces. A
 * skill that reuses a built-in command name carries its own description, which
 * does not match and so shows as written; an English line edited at the source
 * falls back to English rather than showing a stale translation.
 * `test/builtinLabels.test.ts` pins every `en` to its source.
 */
interface Caption {
  readonly en: string
  readonly zh: string
}

export const COMMAND_DESCRIPTIONS: Readonly<Record<string, Caption>> = {
  help: { en: 'Show available commands', zh: '列出可用命令' },
  clear: { en: 'Clear conversation history', zh: '清空当前对话' },
  cost: { en: 'Show token usage and cost', zh: '查看 token 用量和费用' },
  model: { en: 'Show or set the current model', zh: '查看或切换当前模型' },
  session: { en: 'Show current session info', zh: '查看当前会话信息' },
  skills: { en: 'List available skills', zh: '列出可用技能' },
  compact: { en: 'Summarize the conversation now to free up context', zh: '立即压缩对话，腾出上下文' },
  repair: { en: 'Repair session record invariants', zh: '修复会话记录' },
  agents: { en: 'Manage custom agent definitions and subagent tasks', zh: '管理自定义子代理和子代理任务' },
  provider: { en: 'Manage endpoints, models, and routing', zh: '管理接口、模型和路由' },
  plan: { en: 'Enter plan mode or show the current plan', zh: '进入计划模式或查看当前计划' },
  effort: { en: 'Show or set the thinking effort level', zh: '查看或设置思考强度' },
  tasks: { en: 'Show background shell and agent tasks', zh: '查看后台命令和子代理任务' },
  resume: { en: 'Resume a session from the current working directory', zh: '恢复当前目录下的会话' },
  rewind: { en: 'Return to an earlier point in this session', zh: '回到本会话的较早位置' },
  'paste-image': { en: 'Attach the image currently on the clipboard', zh: '附加剪贴板里的图片' },
  attachments: { en: 'List or remove draft image attachments', zh: '查看或移除待发送的图片' },
}

function caption(table: Readonly<Record<string, Caption>>, name: string, text: string): string {
  const entry = Object.hasOwn(table, name) ? table[name] : undefined
  return entry?.en === text ? entry.zh : text
}

export function commandDescription(command: WireCommandInfo): string {
  return caption(COMMAND_DESCRIPTIONS, command.name, command.description)
}

/** The command list the renderer keeps, captioned once on arrival. */
export function localizeCommands(commands: readonly WireCommandInfo[]): WireCommandInfo[] {
  return commands.map((command) => ({ ...command, description: commandDescription(command) }))
}
