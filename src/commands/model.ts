import type { CommandDefinition } from './types.js'

export const modelCommand: CommandDefinition = {
  name: 'model',
  description: 'Show or set the current model',
  argumentHint: '[model-name]',
  run: async (args, context) => {
    const currentModel = context.getModel?.()

    if (!args.trim()) {
      if (context.openModelPicker) {
        context.openModelPicker()
        return
      }

      if (!currentModel) {
        context.writeLine('Current model: unknown')
        return
      }

      context.writeLine([
        'Current model:',
        `  Name:     ${currentModel.key}`,
        `  Provider: ${currentModel.providerName}`,
        `  Model ID: ${currentModel.model}`,
      ].join('\n'))
      return
    }

    const newModel = args.trim()
    if (!context.setModel) {
      context.writeLine('Model switching is not available.')
      return
    }

    const result = await context.setModel(newModel)
    if (result && !result.ok) {
      const lines = [result.message]
      if (result.availableModels && result.availableModels.length > 0) {
        lines.push(`可用模型：${result.availableModels.join('、')}`)
      }
      context.writeLine(lines.join('\n'), 'error')
      return
    }

    context.clearCachedSections?.()
    // No confirmation line. Both shells carry the live model in a persistent
    // readout — the TUI's status line, the desktop composer's chip — so a
    // `Model set to: …` row in the transcript restated what is already on screen
    // and then stayed there, outliving the fact it reported.
    //
    // The image-impact notice still prints: it is a consequence of the switch
    // that nothing else shows. Reported, not asked — the switch already
    // happened, and images in the conversation only change how the next request
    // is built (design §9.1).
    if (result?.ok && result.notice) context.writeLine(result.notice)
  },
}
