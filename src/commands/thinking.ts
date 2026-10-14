import type { CommandDefinition } from './types.js'

const ON = ['on', 'true', '1', 'enable', 'enabled', 'yes']
const OFF = ['off', 'false', '0', 'disable', 'disabled', 'no']

/** `on` / `off`, or undefined when the word is neither. */
export function parseThinkingArgument(input: string): boolean | undefined {
  const value = input.trim().toLowerCase()
  if (ON.includes(value)) return true
  if (OFF.includes(value)) return false
  return undefined
}

export const thinkingCommand: CommandDefinition = {
  name: 'thinking',
  description: 'Show or set extended thinking (off sends no thinking parameter)',
  argumentHint: '[on|off]',
  run: async (args, context) => {
    const current = context.getThinking?.() ?? true

    // No argument: report, and toggling still needs a word — `/thinking` alone
    // flipping a persisted setting is too easy to do by accident.
    if (!args.trim()) {
      context.writeLine([
        `Thinking: ${current ? 'on' : 'off'}`,
        '',
        'on   requests carry adaptive thinking; effort tunes how much.',
        'off  no thinking parameter is sent at all.',
        '',
        'Usage: /thinking <on|off>',
      ].join('\n'))
      return
    }

    const enabled = parseThinkingArgument(args)
    if (enabled === undefined) {
      context.writeLine(`无效的值 "${args.trim()}"，请用 on 或 off。`, 'error')
      return
    }

    if (!context.setThinking) {
      context.writeLine('Thinking control not available.')
      return
    }

    await context.setThinking(enabled)
    context.writeLine(
      enabled
        ? 'Thinking: on (adaptive)'
        : 'Thinking: off — requests will not carry a thinking parameter.',
    )
  },
}
