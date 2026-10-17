import type { CommandDefinition } from './types.js'

export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: 'Summarize the conversation now to free up context',
  argumentHint: '[what to keep]',
  async run(args, context) {
    if (!context.compactConversation) {
      context.writeLine('Compaction is unavailable in this runtime.')
      return
    }

    let result
    try {
      result = await context.compactConversation(args.trim() || undefined)
    } catch (error) {
      context.writeLine(`压缩上下文失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    // A success needs no line: the transcript's own compaction row reports it.
    if (result === 'busy') context.writeLine('当前回合进行中，等它结束再压缩。', 'error')
    else if (result === 'empty') context.writeLine('没有可压缩的内容。')
  },
}
