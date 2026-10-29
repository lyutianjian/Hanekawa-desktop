import { isCommandInput, parseSlashCommand } from '../../../runtime/suggestions/commandSuggestions.js'
import type { CommandView } from '../../../commands/types.js'
import type { CommandEffect, CommandSurface, WireCommandInfo } from '../../../runtime/protocol/wire.js'

/**
 * Where a line of composer text goes, and what a slash command's effects mean.
 *
 * Only registered slash names are commands; other input remains a message.
 *
 * The completion dropdown that makes the commands discoverable lives in
 * `completion.ts`, which owns both sources; it moved out of this file when file
 * mentions arrived, because those are asynchronous and needed a sequence guard
 * that has nothing to do with routing.
 *
 * DOM-free on purpose; see `diffRows.ts`.
 */

export type InputClass =
  | { kind: 'empty' }
  | { kind: 'command'; line: string }
  | { kind: 'prompt'; text: string }

export function matchInputCommand(raw: string, commands: readonly WireCommandInfo[]) {
  const parsed = parseSlashCommand(raw)
  if (!parsed) return undefined
  const command = commands.find((entry) => entry.name === parsed.name)
    ?? commands.find((entry) => entry.aliases?.includes(parsed.name))
    ?? (parsed.name === 'exit' ? { name: 'exit', description: '退出应用' } : undefined)
  return command ? { ...parsed, command } : undefined
}

export function classifyInput(raw: string, commands: readonly WireCommandInfo[]): InputClass {
  const text = raw.trim()
  if (text.length === 0) return { kind: 'empty' }
  if (matchInputCommand(raw, commands)) return { kind: 'command', line: text }
  return { kind: 'prompt', text: isCommandInput(raw.trimStart()) ? raw : text }
}

// --- effects ----------------------------------------------------------------

export type CommandIntent =
  | { kind: 'write-line'; text: string; tone?: 'error' }
  | { kind: 'show-view'; view: CommandView; rows: readonly CommandViewRow[] }
  | { kind: 'open-surface'; surface: CommandSurface }

/**
 * A `CommandEffect` to something the view can do.
 *
 * Exhaustive with an `assertNever` tail: a fourth effect kind must be a compile
 * error here, because the shipped renderer handled one of the three and dropped
 * the other two in silence.
 */
export function commandEffectToIntent(effect: CommandEffect): CommandIntent {
  switch (effect.kind) {
    case 'write-line':
      return { kind: 'write-line', text: effect.text, ...(effect.tone ? { tone: effect.tone } : {}) }
    case 'open-command-view':
      return { kind: 'show-view', view: effect.view, rows: commandViewRows(effect.view) }
    case 'open-surface':
      return { kind: 'open-surface', surface: effect.surface }
  }

  return assertNever(effect)
}

export interface CommandViewRow {
  readonly label: string
  readonly value: string
  readonly tone: 'normal' | 'success' | 'warning' | 'error'
  /** A section heading rather than a row of data. */
  readonly heading?: boolean
}

/** Both `CommandView` shapes flattened to one row list a table can paint. */
export function commandViewRows(view: CommandView): CommandViewRow[] {
  if (view.kind === 'list') {
    return view.items.map((item) => ({
      label: item.label,
      value: item.description ?? '',
      tone: 'normal' as const,
    }))
  }

  return view.sections.flatMap((section) => [
    ...(section.title ? [{ label: section.title, value: '', tone: 'normal' as const, heading: true }] : []),
    ...section.rows.map((row) => ({
      label: row.label,
      value: row.value,
      tone: row.tone ?? ('normal' as const),
    })),
  ])
}

function assertNever(value: never): never {
  throw new Error(`Unhandled command effect: ${JSON.stringify(value)}`)
}
