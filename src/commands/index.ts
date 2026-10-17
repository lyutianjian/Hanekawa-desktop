export { CommandRegistry } from './registry.js'
export type { CommandDefinition, CommandContext, CommandResult } from './types.js'

import type { CommandRegistry } from './registry.js'
import { createHelpCommand } from './help.js'
import { clearCommand } from './clear.js'
import { costCommand } from './cost.js'
import { modelCommand } from './model.js'
import { sessionCommand } from './session.js'
import { skillsCommand } from './skills.js'
import { compactCommand } from './compact.js'
import { repairCommand } from './repair.js'
import { agentsCommand } from './agents.js'
import { providerCommand } from './provider.js'
import { planCommand } from './plan.js'
import { effortCommand } from './effort.js'
import { tasksCommand } from './tasks.js'
import { resumeCommand } from './resume.js'
import { rewindCommand } from './rewind.js'
import { pasteImageCommand } from './pasteImage.js'
import { attachmentsCommand } from './attachments.js'

// Register all built-in commands
export function registerBuiltinCommands(registry: CommandRegistry): void {
  // `/help` is the only one that reads the registry back, so it is built
  // against the very registry it is being registered into.
  registry.register(createHelpCommand(registry))
  registry.register(clearCommand)
  registry.register(costCommand)
  registry.register(modelCommand)
  registry.register(sessionCommand)
  registry.register(skillsCommand)
  registry.register(compactCommand)
  registry.register(repairCommand)
  registry.register(agentsCommand)
  registry.register(providerCommand)
  registry.register(planCommand)
  registry.register(effortCommand)
  registry.register(tasksCommand)
  registry.register(resumeCommand)
  registry.register(rewindCommand)
  registry.register(pasteImageCommand)
  registry.register(attachmentsCommand)
}
