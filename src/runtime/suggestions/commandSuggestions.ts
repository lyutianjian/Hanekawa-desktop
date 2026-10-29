import Fuse, { type FuseResult } from 'fuse.js'
import type { CommandDefinition } from '../../commands/types.js'
import type { SuggestionItem } from './types.js'

/**
 * The subset of a command this module actually reads.
 *
 * Widened from `CommandDefinition` for the desktop renderer: `run` is a function
 * and cannot cross the process boundary, so a client only ever holds name,
 * description and aliases. The default type parameter below keeps every existing
 * caller — all of which pass real `CommandDefinition`s — unchanged.
 */
export interface CommandSuggestionSource {
  name: string
  description: string
  aliases?: string[]
  isHidden?: boolean
  isEnabled?: () => boolean
}

export type CommandSuggestion<T extends CommandSuggestionSource = CommandDefinition> =
  SuggestionItem<T> & {
    metadata: T
  }

interface CommandSearchItem<T extends CommandSuggestionSource> {
  name: string
  aliases: string[]
  description: string
  command: T
}

/**
 * Built per call, deliberately.
 *
 * There used to be a `WeakMap<CommandDefinition[], Fuse>` here "to avoid
 * re-indexing on every keystroke". It never hit once, in the TUI or anywhere
 * else: the key was the array returned by `commands.filter(...)` below, freshly
 * allocated on every call. Keying on the *unfiltered* array instead would be
 * wrong rather than slow — `isEnabled()` is dynamic, so the visible set can
 * change without the array's identity changing.
 */
function buildCommandFuse<T extends CommandSuggestionSource>(
  commands: T[],
): Fuse<CommandSearchItem<T>> {
  const data = commands.map((command) => ({
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
    command,
  }))

  return new Fuse(data, {
    includeScore: true,
    threshold: 0.35,
    location: 0,
    distance: 100,
    keys: [
      { name: 'name', weight: 3 },
      { name: 'aliases', weight: 2 },
      { name: 'description', weight: 0.5 },
    ],
  })
}

export function isCommandInput(input: string): boolean {
  return input.startsWith('/')
}

export function parseSlashCommand(input: string): { name: string; args: string; start: number; end: number } | undefined {
  const text = input.trimStart()
  const match = /^\/([^\s]+)/.exec(text)
  if (!match) return undefined
  const start = input.length - text.length
  const end = start + match[0].length
  return { name: match[1]!, args: input.slice(end).trim(), start, end }
}

export function hasCommandArgs(input: string): boolean {
  if (!isCommandInput(input)) return false
  const spaceIndex = input.indexOf(' ')
  if (spaceIndex < 0) return false
  return input.slice(spaceIndex + 1).trim().length > 0
}

export function createCommandSuggestion<T extends CommandSuggestionSource>(
  command: T,
): CommandSuggestion<T> {
  return {
    id: command.name,
    displayText: `/${command.name}`,
    description: command.description,
    metadata: command,
  }
}

export function generateCommandSuggestions<T extends CommandSuggestionSource>(
  input: string,
  commands: T[],
): CommandSuggestion<T>[] {
  if (!isCommandInput(input) || hasCommandArgs(input)) return []

  const query = input.slice(1).trim().toLowerCase()
  const visibleCommands = commands.filter((command) => !command.isHidden && (command.isEnabled?.() ?? true))

  if (query === '') {
    return [...visibleCommands]
      .sort((a: T, b: T) => a.name.localeCompare(b.name))
      .map((command) => createCommandSuggestion(command))
  }

  const fuse = buildCommandFuse(visibleCommands)
  return [...fuse.search(query)]
    .sort((a: FuseResult<CommandSearchItem<T>>, b: FuseResult<CommandSearchItem<T>>) => (
      compareCommandMatches(query, a, b)
    ))
    .map((result: FuseResult<CommandSearchItem<T>>) => createCommandSuggestion(result.item.command))
}

export function applyCommandSuggestion<T extends CommandSuggestionSource>(
  suggestion: CommandSuggestion<T>,
): {
  text: string
  cursorPos: number
} {
  const command = suggestion.metadata
  const text = `/${command.name} `
  return { text, cursorPos: text.length }
}

function compareCommandMatches<T extends CommandSuggestionSource>(
  query: string,
  a: FuseResult<CommandSearchItem<T>>,
  b: FuseResult<CommandSearchItem<T>>,
): number {
  const aRank = matchRank(query, a.item)
  const bRank = matchRank(query, b.item)
  if (aRank !== bRank) return aRank - bRank

  if (aRank <= 3 && a.item.name.length !== b.item.name.length) {
    return a.item.name.length - b.item.name.length
  }

  return (a.score ?? 0) - (b.score ?? 0)
}

function matchRank<T extends CommandSuggestionSource>(
  query: string,
  item: CommandSearchItem<T>,
): number {
  const name = item.name.toLowerCase()
  const aliases = item.aliases.map((alias) => alias.toLowerCase())

  if (name === query) return 0
  if (aliases.some((alias) => alias === query)) return 1
  if (name.startsWith(query)) return 2
  if (aliases.some((alias) => alias.startsWith(query))) return 3
  return 4
}
