import type { CommandDefinition } from './types.js'

/**
 * The slash commands available in one project.
 *
 * An instance rather than a module-level `Map`: skill commands are read from
 * `<cwd>/.myagent/skills/`, so a shared registry means the second project
 * bootstrapped in a process either leaks its skills into the first or is
 * refused as a duplicate name. `ProjectRuntime` owns one, alongside
 * `ToolRegistry` and `BackgroundTaskRegistry` — everything a `cwd` has exactly
 * one of.
 */
export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>()
  /**
   * Which entries came from `.myagent/skills/`.
   *
   * Skills are re-read on `/skills reload` (and on every `reloadSkills()`), so
   * the registration has to be *replaceable*: without this set the second pass
   * saw its own previous entry through `has()`, skipped it as a name clash and
   * left the stale description and prompt in place, while a deleted skill kept
   * its slash command forever.
   */
  private readonly skillNames = new Set<string>()

  register(def: CommandDefinition): void {
    this.commands.set(def.name, def)
  }

  /** Same as `register`, but the entry is owned by `clearSkills()`. */
  registerSkill(def: CommandDefinition): void {
    this.commands.set(def.name, def)
    this.skillNames.add(def.name)
  }

  /**
   * Drop every skill-sourced entry, leaving built-ins untouched — the first
   * step of a reload, so the pass that follows sees a clean slate and built-ins
   * still shadow a same-named skill.
   */
  clearSkills(): void {
    for (const name of this.skillNames) this.commands.delete(name)
    this.skillNames.clear()
  }

  get(name: string): CommandDefinition | undefined {
    return this.commands.get(name)
      ?? [...this.commands.values()].find((c) => c.aliases?.includes(name))
  }

  /** Filtered for display: what a `/` menu or `/help` should show. */
  list(): CommandDefinition[] {
    return [...this.commands.values()].filter((c) => (c.isEnabled?.() ?? true) && !c.isHidden)
  }

  has(name: string): boolean {
    return this.get(name) !== undefined
  }

  isSkill(name: string): boolean {
    const command = this.get(name)
    return command !== undefined && this.skillNames.has(command.name)
  }
}
