import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { parseYamlFrontmatter } from '../../utils/frontmatter.js'
import {
  AGENT_MAX_RESULT_SIZE_CHARS,
  ALL_AGENT_DISALLOWED_TOOLS,
  BUILT_IN_AGENT_DEFINITIONS,
  infersReadOnlyAgentFromTools,
  type BaseAgentDefinition,
} from '../../tools/AgentTool/AgentTool.js'
import type { PermissionMode } from '../../harness/permissions.js'
import { VALID_EFFORT_LEVELS, type EffortLevel } from '../../config/effort.js'
import type { SubagentIsolation } from './subagentWorktree.js'
import { getAgentsDir, getLocalAgentsDir } from '../../utils/paths.js'

interface AgentFrontmatter {
  name?: unknown
  description?: unknown
  model?: unknown
  permissionMode?: unknown
  skills?: unknown
  mcpServers?: unknown
  background?: unknown
  isolation?: unknown
  tools?: unknown
  disallowedTools?: unknown
  isReadOnlyAgent?: unknown
  omitProjectContext?: unknown
  maxTurns?: unknown
  maxResultSizeChars?: unknown
  initialPrompt?: unknown
  effort?: unknown
  criticalSystemReminder?: unknown
}

const CUSTOM_AGENT_PROMPT_WARN_CHARS = 16_000
const BUILT_IN_AGENT_TYPES = new Set(BUILT_IN_AGENT_DEFINITIONS.map((definition) => definition.type))

export class AgentDefinitionLoader {
  private cached: BaseAgentDefinition[] | undefined
  /** Problems found by the last `list()`; stderr would tear the TUI. */
  warnings: string[] = []

  constructor(
    private readonly cwd: string,
    private readonly homeDir = homedir(),
  ) {}

  async list(): Promise<BaseAgentDefinition[]> {
    if (this.cached) return this.cached
    this.warnings = []
    const definitions = new Map<string, BaseAgentDefinition>()
    for (const dir of this.agentDirs()) {
      for (const definition of await this.loadDir(dir)) {
        definitions.set(definition.type, definition)
      }
    }
    const result = [...definitions.values()]
    this.cached = result
    return result
  }

  invalidate(): void {
    this.cached = undefined
  }

  private agentDirs(): string[] {
    return [
      path.join(this.homeDir, '.hanekawa', 'agents'),
      getAgentsDir(this.cwd),
      getLocalAgentsDir(this.cwd),
    ]
  }

  private async loadDir(dir: string): Promise<BaseAgentDefinition[]> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }

    const definitions: BaseAgentDefinition[] = []
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md')) continue
      const filePath = path.join(dir, entry)
      try {
        definitions.push(this.parse(await readFile(filePath, 'utf8')))
      } catch (error) {
        this.warnings.push(`Failed to load agent definition from ${entry}: ${(error as Error).message}`)
      }
    }
    return definitions
  }

  private parse(raw: string): BaseAgentDefinition {
    const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
    if (!match) {
      throw new Error('Agent file must include YAML frontmatter (---\\n...\\n---)')
    }

    const frontmatter = parseYamlFrontmatter(match[1]) as AgentFrontmatter
    if (typeof frontmatter.name !== 'string' || frontmatter.name.trim() === '') {
      throw new Error('Agent frontmatter must include non-empty string "name" field')
    }
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim() === '') {
      throw new Error('Agent frontmatter must include non-empty string "description" field')
    }

    const tools = parseTools(frontmatter.tools)
    const userDisallowedTools = parseOptionalStringArray(frontmatter.disallowedTools, 'disallowedTools')
    const model = parseOptionalString(frontmatter.model, 'model')
    const permissionMode = parseOptionalPermissionMode(frontmatter.permissionMode)
    const skills = parseOptionalStringArray(frontmatter.skills, 'skills')
    const mcpServers = parseOptionalStringArray(frontmatter.mcpServers, 'mcpServers')
    const background = parseOptionalBoolean(frontmatter.background, 'background')
    const isolation = parseOptionalIsolation(frontmatter.isolation)
    const maxTurns = parseOptionalPositiveInt(frontmatter.maxTurns, 'maxTurns')
    const maxResultSizeChars = parsePositiveInt(
      frontmatter.maxResultSizeChars,
      AGENT_MAX_RESULT_SIZE_CHARS,
      'maxResultSizeChars',
    )
    const omitProjectContext = parseBoolean(frontmatter.omitProjectContext, false, 'omitProjectContext')
    const explicitReadOnlyAgent = parseOptionalBoolean(frontmatter.isReadOnlyAgent, 'isReadOnlyAgent')
    const initialPrompt = parseOptionalString(frontmatter.initialPrompt, 'initialPrompt')
    const criticalSystemReminder = parseOptionalString(frontmatter.criticalSystemReminder, 'criticalSystemReminder')

    const effort = parseOptionalEffort(frontmatter.effort)

    const content = match[2].trim()
    const inferredReadOnlyAgent = infersReadOnlyAgentFromTools(tools)

    if (BUILT_IN_AGENT_TYPES.has(frontmatter.name)) {
      this.warnings.push(`Custom agent '${frontmatter.name}' overrides built-in definition`)
    }
    if (explicitReadOnlyAgent === true && !inferredReadOnlyAgent) {
      this.warnings.push(`Custom agent '${frontmatter.name}' declares isReadOnlyAgent: true but lists write-like tools; treating it as non-read-only`)
    }
    if (content.length > CUSTOM_AGENT_PROMPT_WARN_CHARS) {
      this.warnings.push(`Custom agent '${frontmatter.name}' system prompt is ${content.length} chars, above the recommended ${CUSTOM_AGENT_PROMPT_WARN_CHARS} char soft limit`)
    }

    return {
      type: frontmatter.name,
      description: frontmatter.description,
      ...(model ? { model } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      ...(skills ? { skills } : {}),
      ...(mcpServers ? { mcpServers } : {}),
      ...(background !== undefined ? { background } : {}),
      ...(isolation ? { isolation } : {}),
      ...(tools ? { tools } : {}),
      disallowedTools: userDisallowedTools
        ? [...new Set([...ALL_AGENT_DISALLOWED_TOOLS, ...userDisallowedTools])]
        : [...ALL_AGENT_DISALLOWED_TOOLS],
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      maxResultSizeChars,
      isReadOnlyAgent: explicitReadOnlyAgent === false ? false : inferredReadOnlyAgent,
      omitProjectContext,
      getSystemPrompt: () => content,
      ...(initialPrompt ? { initialPrompt } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(criticalSystemReminder ? { criticalSystemReminder } : {}),
    }
  }
}

function parseTools(value: unknown): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error('Agent frontmatter "tools" must be an array of non-empty strings')
  }
  const tools = value.map((item) => item.trim())
  if (tools.includes('*')) {
    if (tools.length !== 1) {
      throw new Error('Agent frontmatter "tools" may use "*" only by itself')
    }
    return undefined
  }
  return tools
}

function parseOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Agent frontmatter "${field}" must be a non-empty string`)
  }
  return value.trim()
}

function parseOptionalStringArray(value: unknown, field: string): readonly string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.trim() !== '')) {
    throw new Error(`Agent frontmatter "${field}" must be an array of non-empty strings`)
  }
  return value.map((item) => item.trim())
}

function parseOptionalPermissionMode(value: unknown): PermissionMode | undefined {
  if (value === undefined) return undefined
  if (value === 'acceptEdits') return 'auto'
  if (value === 'default' || value === 'plan' || value === 'auto' || value === 'bypass') {
    return value
  }
  throw new Error('Agent frontmatter "permissionMode" must be one of: default, plan, auto, bypass')
}

function parseOptionalIsolation(value: unknown): SubagentIsolation | undefined {
  if (value === undefined) return undefined
  if (value === 'worktree') return value
  throw new Error('Agent frontmatter "isolation" must be "worktree" when set')
}

function parsePositiveInt(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined) return defaultValue
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new Error(`Agent frontmatter "${field}" must be a positive integer`)
  }
  return value
}

function parseOptionalPositiveInt(value: unknown, field: string): number | undefined {
  return value === undefined ? undefined : parsePositiveInt(value, 0, field)
}

function parseBoolean(value: unknown, defaultValue: boolean, field: string): boolean {
  if (value === undefined) return defaultValue
  if (typeof value !== 'boolean') {
    throw new Error(`Agent frontmatter "${field}" must be a boolean`)
  }
  return value
}

function parseOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new Error(`Agent frontmatter "${field}" must be a boolean`)
  }
  return value
}

function parseOptionalEffort(value: unknown): EffortLevel | undefined {
  if (value === undefined) return undefined
  if ((VALID_EFFORT_LEVELS as readonly unknown[]).includes(value)) return value as EffortLevel
  throw new Error(`Agent frontmatter "effort" must be one of: ${VALID_EFFORT_LEVELS.join(', ')}`)
}
