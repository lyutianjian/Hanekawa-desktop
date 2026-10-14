import type { CommandDefinition } from './types.js'

export const compactCommand: CommandDefinition = {
  name: 'compact',
  description: 'Manage auto-compact state',
  argumentHint: 'reset',
  async run(args, context) {
    const subcommand = args.trim().toLowerCase()
    if (subcommand !== 'reset') {
      context.writeLine('Usage: /compact reset')
      return
    }

    if (!context.resetCompactFailureCount) {
      context.writeLine('Compact failure reset is unavailable in this runtime.')
      return
    }

    try {
      await context.resetCompactFailureCount()
    } catch (error) {
      context.writeLine(`重置压缩失败计数失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    try {
      context.clearCachedSections?.()
    } catch (error) {
      context.writeLine(`清除缓存段落失败：${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }

    context.writeLine('Auto-compact failure circuit reset.')
  },
}
