import test from 'node:test'
import assert from 'node:assert/strict'
import { CommandRegistry, registerBuiltinCommands } from '../src/commands/index.js'
import {
  COMMAND_DESCRIPTIONS,
  commandDescription,
  localizeCommands,
} from '../src/desktop/renderer/model/builtinLabels.js'

test('every built-in command has a caption whose English matches its source', () => {
  const registry = new CommandRegistry()
  registerBuiltinCommands(registry)
  const commands = registry.list()
  assert.deepEqual(commands.map((c) => c.name).sort(), Object.keys(COMMAND_DESCRIPTIONS).sort())
  for (const command of commands) {
    assert.equal(COMMAND_DESCRIPTIONS[command.name]?.en, command.description, command.name)
  }
})

test('built-ins show Chinese; skills keep their own text', () => {
  assert.equal(commandDescription({ name: 'clear', description: 'Clear conversation history' }), '清空当前对话')
  // A skill registered under a built-in name carries its own description.
  assert.equal(commandDescription({ name: 'plan', description: 'My planning skill' }), 'My planning skill')
  assert.equal(commandDescription({ name: 'deploy', description: 'Ship it' }), 'Ship it')
  assert.deepEqual(localizeCommands([{ name: 'help', description: 'Show available commands', aliases: ['h'] }]), [
    { name: 'help', description: '列出可用命令', aliases: ['h'] },
  ])
})
