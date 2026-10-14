import type { CommandDefinition } from './types.js'
import { VALID_EFFORT_LEVELS, effortDescription, type EffortLevel } from '../config/effort.js'

export const effortCommand: CommandDefinition = {
  name: 'effort',
  aliases: ['e'],
  description: 'Show or set the thinking effort level',
  argumentHint: '[low|medium|high|xhigh|max]',
  run: async (args, context) => {
    const level = args.trim().toLowerCase() as EffortLevel

    // No argument: open the interactive picker when available, otherwise print help.
    if (!level) {
      if (context.openEffortPicker) {
        context.openEffortPicker()
        return
      }
      const current = context.getEffort?.() ?? 'high'
      const lines = [
        `Current effort: ${current}`,
        '',
        'Available levels:',
        ...VALID_EFFORT_LEVELS.map((l) => `  ${l.padEnd(8)} ${effortDescription(l)}`),
        '',
        'Usage: /effort <level>  (alias: /e)',
      ]
      context.writeLine(lines.join('\n'))
      return
    }

    // Validate
    if (!(VALID_EFFORT_LEVELS as readonly string[]).includes(level)) {
      context.writeLine(`无效的强度 "${level}"，可选：${VALID_EFFORT_LEVELS.join('、')}`, 'error')
      return
    }

    // Set
    if (!context.setEffort) {
      context.writeLine('Effort control not available.')
      return
    }

    const result = context.setEffort(level)
    if (result && typeof result === 'object' && 'then' in result) {
      await result
    }
    // Silent on success, for the reason `/model` is (see `model.ts`): the level
    // in force is already on screen — the status line's effort symbol, the
    // desktop chip — and this context cannot see the *clamped* level anyway, so
    // the line it used to print could name a level the model never accepted.
  },
}
