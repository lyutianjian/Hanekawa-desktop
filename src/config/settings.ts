import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { getGlobalMyAgentDir, getProjectDataDir, isGlobalWorkspaceRoot } from '../utils/paths.js'
import type { AgentConfig, ModelConfig } from './service.js'
import type { Endpoint, Routing } from './routing.js'
import { type EffortLevel } from './effort.js'
import type { HookCommand } from '../harness/hooks.js'
import { permissionRuleToEntry, type PermissionRule } from '../harness/permissions.js'
import type { McpServerConfig } from '../services/mcp/types.js'

export type HookCommandSetting = HookCommand
export type PreToolUseHookSetting = HookCommandSetting
export type StartupPermissionMode = 'default' | 'auto' | 'bypass'

const STARTUP_PERMISSION_MODES: readonly StartupPermissionMode[] = ['default', 'auto', 'bypass']

export interface MyAgentSettings {
  permissions?: {
    mode?: StartupPermissionMode
    allow?: string[]
    deny?: string[]
    ask?: string[]
    /**
     * Extra roots auto mode treats as workspace, alongside `cwd`.
     * Concatenated across layers like `allow`/`deny`/`ask`.
     */
    additionalDirectories?: string[]
  }
  hooks?: {
    userPromptSubmit?: HookCommandSetting[]
    preToolUse?: HookCommandSetting[]
    postToolUse?: HookCommandSetting[]
    preCompact?: HookCommandSetting[]
    postCompact?: HookCommandSetting[]
    subagentStart?: HookCommandSetting[]
    subagentStop?: HookCommandSetting[]
    stop?: HookCommandSetting[]
  }
  mcpServers?: Record<string, McpServerConfig>
  mcp?: {
    trustedServers?: string[]
  }
  skills?: {
    /**
     * Skill names that are switched off: no prompt section, no slash command,
     * and the `Skill` tool cannot load them.
     */
    disabled?: string[]
  }
  cache?: {
    ttl1h?: boolean
  }
  models?: Record<string, ModelConfig>
  endpoints?: Record<string, Endpoint>
  routing?: Routing
  defaultModel?: string
  fallbackModel?: string
  compactModel?: string
  agent?: AgentConfig
  autoCompact?: boolean
  /** Let the model keep cross-session notes in the project's memory directory. On unless false. */
  autoMemory?: boolean
  autoCompactThreshold?: number
  effortLevel?: EffortLevel
  /**
   * Extended thinking. Unset means on: the request carries the provider's
   * adaptive thinking config. `false` sends no `thinking` parameter at all.
   */
  thinking?: boolean
}

interface LegacyMcpSettings {
  mcpServers?: Record<string, McpServerConfig>
}

async function loadSettingsFile(filePath: string): Promise<MyAgentSettings> {
  let content: string
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  try {
    const settings = JSON.parse(content) as MyAgentSettings
    // `acceptEdits` was renamed `auto`; it lands as `auto` on the next write.
    if ((settings.permissions?.mode as string | undefined) === 'acceptEdits') settings.permissions!.mode = 'auto'
    return settings
  } catch (error) {
    console.error(`[myagent] Warning: corrupted settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

async function loadLegacyMcpSettings(cwd: string): Promise<MyAgentSettings> {
  let content: string
  const filePath = join(cwd, '.myagent', 'mcp.json')
  try {
    content = await readFile(filePath, 'utf-8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }

  try {
    const config = JSON.parse(content) as LegacyMcpSettings
    return config.mcpServers ? { mcpServers: config.mcpServers } : {}
  } catch (error) {
    console.error(`[myagent] Warning: corrupted MCP settings file ${filePath}: ${error instanceof Error ? error.message : String(error)}`)
    return {}
  }
}

function mergeSettings(...sources: MyAgentSettings[]): MyAgentSettings {
  const result: MyAgentSettings = {}

  for (const source of sources) {
    if (source.defaultModel !== undefined) {
      result.defaultModel = source.defaultModel
    }

    if (source.fallbackModel !== undefined) {
      result.fallbackModel = source.fallbackModel
    }

    if (source.compactModel !== undefined) {
      result.compactModel = source.compactModel
    }

    if (source.models) {
      result.models = { ...result.models, ...source.models }
    }

    if (source.endpoints) {
      result.endpoints = { ...result.endpoints, ...source.endpoints }
    }

    if (source.routing) {
      result.routing = {
        ...result.routing,
        ...source.routing,
        subagent: {
          ...result.routing?.subagent,
          ...source.routing.subagent,
        },
      }
    }

    if (source.agent) {
      result.agent = {
        ...result.agent,
        ...source.agent,
        contextManagement: {
          ...result.agent?.contextManagement,
          ...source.agent.contextManagement,
        },
      }
    }

    if (source.permissions) {
      const mode = source.permissions.mode ?? result.permissions?.mode
      // Concatenated like allow/deny/ask, but only written when a layer
      // actually declared one: an empty array in every merged snapshot would
      // be noise for a setting almost nobody sets.
      const additionalDirectories = [
        ...(result.permissions?.additionalDirectories ?? []),
        ...(source.permissions.additionalDirectories ?? []),
      ]
      result.permissions = {
        ...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
        ...(mode !== undefined ? { mode } : {}),
        allow: [...(result.permissions?.allow ?? []), ...(source.permissions.allow ?? [])],
        deny: [...(result.permissions?.deny ?? []), ...(source.permissions.deny ?? [])],
        ask: [...(result.permissions?.ask ?? []), ...(source.permissions.ask ?? [])],
      }
    }

    if (source.hooks) {
      result.hooks = {
        ...result.hooks,
        ...(source.hooks.userPromptSubmit
          ? {
              userPromptSubmit: [
                ...(result.hooks?.userPromptSubmit ?? []),
                ...source.hooks.userPromptSubmit,
              ],
            }
          : {}),
        ...(source.hooks.preToolUse
          ? {
              preToolUse: [
                ...(result.hooks?.preToolUse ?? []),
                ...source.hooks.preToolUse,
              ],
            }
          : {}),
        ...(source.hooks.postToolUse
          ? {
              postToolUse: [
                ...(result.hooks?.postToolUse ?? []),
                ...source.hooks.postToolUse,
              ],
            }
          : {}),
        ...(source.hooks.preCompact
          ? {
              preCompact: [
                ...(result.hooks?.preCompact ?? []),
                ...source.hooks.preCompact,
              ],
            }
          : {}),
        ...(source.hooks.postCompact
          ? {
              postCompact: [
                ...(result.hooks?.postCompact ?? []),
                ...source.hooks.postCompact,
              ],
            }
          : {}),
        ...(source.hooks.subagentStart
          ? {
              subagentStart: [
                ...(result.hooks?.subagentStart ?? []),
                ...source.hooks.subagentStart,
              ],
            }
          : {}),
        ...(source.hooks.subagentStop
          ? {
              subagentStop: [
                ...(result.hooks?.subagentStop ?? []),
                ...source.hooks.subagentStop,
              ],
            }
          : {}),
        ...(source.hooks.stop
          ? {
              stop: [
                ...(result.hooks?.stop ?? []),
                ...source.hooks.stop,
              ],
            }
          : {}),
      }
    }

    if (source.mcpServers) {
      result.mcpServers = { ...result.mcpServers, ...source.mcpServers }
    }

    if (source.mcp) {
      const trustedServers = source.mcp.trustedServers
        ? [...new Set([...(result.mcp?.trustedServers ?? []), ...source.mcp.trustedServers])]
        : result.mcp?.trustedServers
      result.mcp = {
        ...result.mcp,
        ...(trustedServers ? { trustedServers } : {}),
      }
    }

    // Replaced outright, unlike `permissions.*` (concatenated) and
    // `mcp.trustedServers` (unioned): a union would make a name disabled in the
    // user layer impossible to switch back on from the project or local layer,
    // which is a toggle that visibly does nothing.
    if (source.skills) {
      result.skills = { ...result.skills, ...source.skills }
    }

    if (source.cache) {
      result.cache = {
        ...result.cache,
        ...source.cache,
      }
    }

    if (source.autoCompact !== undefined) {
      result.autoCompact = source.autoCompact
    }

    if (source.autoMemory !== undefined) {
      result.autoMemory = source.autoMemory
    }

    if (source.autoCompactThreshold !== undefined) {
      result.autoCompactThreshold = source.autoCompactThreshold
    }

    if (source.effortLevel !== undefined) {
      result.effortLevel = source.effortLevel
    }

    if (source.thinking !== undefined) {
      result.thinking = source.thinking
    }
  }

  return result
}

/**
 * The layers behind {@link loadMergedSettings}, in merge order.
 *
 * Exposed so a UI can ask what the local layer *inherits* — "this server is also
 * defined above me" is not a question the merged view can answer, and neither is
 * it one a caller should re-derive by guessing the layer order.
 */
export interface SettingsLayers {
  user: MyAgentSettings
  project: MyAgentSettings
  legacyMcp: MyAgentSettings
  local: MyAgentSettings
}

/**
 * A repository must not loosen its own guard: the checked-in layer cannot pick
 * the startup permission mode or pre-trust MCP servers. Both stay settable from
 * the user and local layers.
 */
function withoutProjectTrustGrants(settings: MyAgentSettings): MyAgentSettings {
  const ignored: string[] = []
  if (settings.permissions?.mode !== undefined) {
    const { mode: _mode, ...permissions } = settings.permissions
    settings = { ...settings, permissions }
    ignored.push('permissions.mode')
  }
  if (settings.mcp?.trustedServers !== undefined) {
    const { trustedServers: _trusted, ...mcp } = settings.mcp
    settings = { ...settings, mcp }
    ignored.push('mcp.trustedServers')
  }
  if (ignored.length > 0) {
    console.error(`[myagent] Warning: .myagent/settings.json cannot set ${ignored.join(' or ')}; ignored. Set it in ~/.myagent/settings.json or the local layer.`)
  }
  return settings
}

export async function loadSettingsLayers(cwd: string): Promise<SettingsLayers> {
  const user = await loadSettingsFile(join(getGlobalMyAgentDir(), 'settings.json'))
  // The home directory *is* the global workspace, and its "project" layer is
  // the user layer. Loading both would apply every permission entry and hook
  // twice — the same double-load `ConfigService` already guards against for
  // `config.json`.
  const project = isGlobalWorkspaceRoot(cwd)
    ? {}
    : withoutProjectTrustGrants(await loadSettingsFile(join(cwd, '.myagent', 'settings.json')))
  const legacyMcp = await loadLegacyMcpSettings(cwd)
  const local = await loadSettingsFile(localSettingsPath(cwd))
  return { user, project, legacyMcp, local }
}

export async function loadMergedSettings(cwd: string): Promise<MyAgentSettings> {
  const { user, project, legacyMcp, local } = await loadSettingsLayers(cwd)
  return mergeSettings(user, project, legacyMcp, local)
}

async function writeSettingsAtomic(filePath: string, settings: MyAgentSettings): Promise<void> {
  await mkdir(join(dirname(filePath)), { recursive: true })
  await writeFile(`${filePath}.tmp`, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  await rename(`${filePath}.tmp`, filePath)
}

/**
 * The layer every in-app write lands in: an "always allow", an MCP trust
 * decision, and everything the desktop settings screen edits outside
 * `config.json`.
 *
 * Per project but personal, so it lives in the project's data dir under
 * `~/.myagent/projects/`, not in the project: clicking "always allow" must not
 * make a `.myagent/` appear in someone's repository.
 */
export function localSettingsPath(cwd: string): string {
  return join(getProjectDataDir(cwd), 'settings.local.json')
}

/**
 * The project-local layer on its own, unmerged.
 *
 * A UI needs this *beside* the merged settings to tell "yours" from
 * "inherited". `mergeSettings` concatenates `permissions.*` and unions
 * `mcp.trustedServers`, so the merged view cannot say which file an entry came
 * from — and only the entries in this one can be edited by rewriting it.
 */
export async function loadLocalSettings(cwd: string): Promise<MyAgentSettings> {
  return loadSettingsFile(localSettingsPath(cwd))
}

/** The keys {@link updateLocalSettings} is allowed to rewrite. */
export type LocalSettingsPatch = {
  [K in 'permissions' | 'mcp' | 'skills' | 'cache' | 'thinking' | 'mcpServers']?: MyAgentSettings[K]
}

const LOCAL_PATCH_KEYS = ['permissions', 'mcp', 'skills', 'cache', 'thinking', 'mcpServers'] as const

/**
 * Rewrites the named keys in the local layer and leaves the rest of that file
 * alone.
 *
 * A key present in `patch` is replaced **outright**, and that is the whole
 * point: `permissions.allow/deny/ask` and `hooks.*` *concatenate* across
 * layers, so writing a merged group back here would copy every inherited entry
 * into this file — and replacing the group is the only way a removal can
 * happen at all. A key explicitly set to `undefined` is deleted rather than
 * written as `null`.
 *
 * Validated **before** the write: `reloadSettings()` throws on invalid
 * settings, so a bad write would leave the project unable to reload until
 * someone edited the file by hand.
 */
export async function updateLocalSettings(cwd: string, patch: LocalSettingsPatch): Promise<void> {
  const filePath = localSettingsPath(cwd)
  const next = await loadSettingsFile(filePath)
  for (const key of LOCAL_PATCH_KEYS) {
    if (!Object.hasOwn(patch, key)) continue
    const value = patch[key]
    if (value === undefined) delete next[key]
    // Indexed through a wider type on purpose: the key is one of
    // `LOCAL_PATCH_KEYS` and the value came from `patch[key]`, but the compiler
    // distributes the union over both sides and asks for their intersection.
    else (next as Record<string, unknown>)[key] = value
  }

  const validation = validateSettings(next)
  if (!validation.valid) {
    throw new Error(`Invalid settings: ${validation.errors.join('; ')}`)
  }
  await writeSettingsAtomic(filePath, next)
}

/** Replaces one permission group in the local layer. */
export async function setLocalPermissionEntries(
  cwd: string,
  behavior: 'allow' | 'deny' | 'ask',
  entries: readonly string[],
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  await updateLocalSettings(cwd, {
    permissions: { ...local.permissions, [behavior]: [...entries] },
  })
}

/**
 * The startup permission mode, in the local layer.
 *
 * Startup only: `SessionScope` reads it once when it builds its
 * `PermissionGate`, and `reloadSettings()` refreshes the *rules* but never the
 * mode. Already-open sessions keep the mode they opened with.
 */
export async function setLocalStartupPermissionMode(
  cwd: string,
  mode: StartupPermissionMode,
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  await updateLocalSettings(cwd, { permissions: { ...local.permissions, mode } })
}

/**
 * Adds or removes one server in the local layer's trust list.
 *
 * Removal only reaches *this* layer: `mcp.trustedServers` is unioned across
 * layers, so a name trusted in the user or project layer cannot be revoked
 * from here. Callers that offer a toggle have to say so.
 */
export async function setMcpServerTrustLocally(
  cwd: string,
  serverName: string,
  trusted: boolean,
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  const trustedServers = new Set(local.mcp?.trustedServers ?? [])
  if (trusted) trustedServers.add(serverName)
  else trustedServers.delete(serverName)
  await updateLocalSettings(cwd, {
    mcp: { ...local.mcp, trustedServers: [...trustedServers].sort() },
  })
}

export interface SetMcpServerOptions {
  /** The name being renamed away from: its config and trust entry are moved. */
  previousName?: string
  /** The trust the server should end up with. Left alone when omitted. */
  trusted?: boolean
}

/**
 * Adds, edits or renames one MCP server in the local layer.
 *
 * The config and the trust entry are written in one patch because they are keyed
 * by the same name: a rename that moved only the config would leave the old
 * name's trust behind, pre-trusting whatever server takes that name next.
 */
export async function setMcpServerLocally(
  cwd: string,
  serverName: string,
  config: McpServerConfig,
  options: SetMcpServerOptions = {},
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  const { previousName, trusted } = options
  const servers = { ...local.mcpServers }
  if (previousName !== undefined && previousName !== serverName) delete servers[previousName]
  servers[serverName] = config

  const patch: LocalSettingsPatch = { mcpServers: servers }
  if (trusted !== undefined || (previousName !== undefined && previousName !== serverName)) {
    const trustedServers = new Set(local.mcp?.trustedServers ?? [])
    if (previousName !== undefined && previousName !== serverName) trustedServers.delete(previousName)
    if (trusted === true) trustedServers.add(serverName)
    else if (trusted === false) trustedServers.delete(serverName)
    patch.mcp = { ...local.mcp, trustedServers: [...trustedServers].sort() }
  }
  await updateLocalSettings(cwd, patch)
}

/**
 * Removes one MCP server from the local layer, trust entry and all.
 *
 * Trust is keyed by name only, so a left-behind entry would silently pre-trust
 * the *next* server to take this name — one arriving through a pulled
 * `.myagent/settings.json`, say, which would then register its tools without the
 * prompt in `runtime/mcp.ts` ever firing.
 */
export async function removeMcpServerLocally(
  cwd: string,
  serverName: string,
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  const hasServer = !!local.mcpServers && serverName in local.mcpServers
  const trustedServers = new Set(local.mcp?.trustedServers ?? [])
  const hasTrust = trustedServers.delete(serverName)
  if (!hasServer && !hasTrust) return

  const patch: LocalSettingsPatch = {}
  if (hasServer) {
    const { [serverName]: _, ...rest } = local.mcpServers!
    patch.mcpServers = rest
  }
  if (hasTrust) patch.mcp = { ...local.mcp, trustedServers: [...trustedServers].sort() }
  await updateLocalSettings(cwd, patch)
}

/**
 * Switches one skill on or off in the local layer.
 *
 * Unlike {@link setMcpServerTrustLocally} this reaches every layer's decision:
 * `skills` is *replaced* by the merge rather than unioned, so the list written
 * here is the list that counts, and no skill can be stuck off from above.
 */
export async function setSkillEnabledLocally(
  cwd: string,
  skillName: string,
  enabled: boolean,
): Promise<void> {
  const local = await loadLocalSettings(cwd)
  const disabled = new Set(local.skills?.disabled ?? [])
  if (enabled) disabled.delete(skillName)
  else disabled.add(skillName)
  await updateLocalSettings(cwd, {
    skills: { ...local.skills, disabled: [...disabled].sort() },
  })
}

/** The names {@link MyAgentSettings.skills} switches off, as a set. */
export function disabledSkillNames(settings: MyAgentSettings): Set<string> {
  return new Set(settings.skills?.disabled ?? [])
}

export async function trustMcpServerLocally(cwd: string, serverName: string): Promise<void> {
  await setMcpServerTrustLocally(cwd, serverName, true)
}

/**
 * Extended thinking, in the local layer.
 *
 * Written as an explicit boolean rather than deleted when enabled: "on" and
 * "unset" behave the same, but only a written `true` survives a `thinking:
 * false` in a layer above this one.
 */
export async function setLocalThinking(cwd: string, enabled: boolean): Promise<void> {
  await updateLocalSettings(cwd, { thinking: enabled })
}

/** The 1-hour prompt-cache TTL, in the local layer. */
export async function setLocalCacheTtl1h(cwd: string, enabled: boolean): Promise<void> {
  const local = await loadLocalSettings(cwd)
  await updateLocalSettings(cwd, { cache: { ...local.cache, ttl1h: enabled } })
}

export async function persistPermissionRule(cwd: string, rule: PermissionRule): Promise<void> {
  const local = await loadLocalSettings(cwd)
  const key = rule.behavior
  const entries = [...(local.permissions?.[key] ?? [])]
  const entry = permissionRuleToEntry(rule)
  if (!entries.includes(entry)) entries.push(entry)
  await setLocalPermissionEntries(cwd, key, entries)
}

export async function saveEffortLevel(level: EffortLevel): Promise<void> {
  const settingsPath = join(getGlobalMyAgentDir(), 'settings.json')
  const settings = await loadSettingsFile(settingsPath)
  settings.effortLevel = level
  await writeSettingsAtomic(settingsPath, settings)
}

export function validateSettings(settings: MyAgentSettings): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (settings.models) {
    for (const [name, model] of Object.entries(settings.models)) {
      if (!model || typeof model !== 'object') {
        errors.push(`models.${name} must be an object`)
        continue
      }
      if (typeof model.provider !== 'string' || model.provider.trim() === '') {
        if (typeof model.endpoint !== 'string' || model.endpoint.trim() === '') {
          errors.push(`models.${name}.provider must be a non-empty string when endpoint is not set`)
        }
      }
      if (typeof model.model !== 'string' || model.model.trim() === '') {
        errors.push(`models.${name}.model must be a non-empty string`)
      }
      if (model.contextWindow !== undefined && (!Number.isInteger(model.contextWindow) || model.contextWindow < 1)) {
        errors.push(`models.${name}.contextWindow must be a positive integer`)
      }
      if (model.supportsImageInput !== undefined && typeof model.supportsImageInput !== 'boolean') {
        errors.push(`models.${name}.supportsImageInput must be a boolean`)
      }
    }
  }

  if (settings.defaultModel !== undefined && (typeof settings.defaultModel !== 'string' || settings.defaultModel.trim() === '')) {
    errors.push('defaultModel must be a non-empty string')
  } else if (
    // Only checkable when this layer also declares the models. `models` may live
    // entirely in `config.json`, which `validateSettings` never sees, so an
    // unconditional check would reject perfectly good configs.
    settings.models !== undefined
    && typeof settings.defaultModel === 'string'
    && settings.defaultModel.trim() !== ''
    && settings.models[settings.defaultModel.trim()] === undefined
  ) {
    errors.push(`defaultModel "${settings.defaultModel.trim()}" is not a key in models`)
  }

  if (settings.fallbackModel !== undefined && (typeof settings.fallbackModel !== 'string' || settings.fallbackModel.trim() === '')) {
    errors.push('fallbackModel must be a non-empty string')
  }

  if (settings.compactModel !== undefined && (typeof settings.compactModel !== 'string' || settings.compactModel.trim() === '')) {
    errors.push('compactModel must be a non-empty string')
  }

  if (settings.agent?.system !== undefined && typeof settings.agent.system !== 'string') {
    errors.push('agent.system must be a string')
  }

  if (settings.mcpServers) {
    for (const [name, config] of Object.entries(settings.mcpServers)) {
      if (config.transport === 'stdio' && !config.command) {
        errors.push(`MCP server "${name}" with stdio transport requires "command"`)
      }
      if (config.transport === 'sse' && !config.url) {
        errors.push(`MCP server "${name}" with sse transport requires "url"`)
      }
      if (config.args !== undefined && !Array.isArray(config.args)) {
        errors.push(`MCP server "${name}" args must be an array of strings`)
      } else if (config.args?.some((arg) => typeof arg !== 'string')) {
        errors.push(`MCP server "${name}" args must be an array of strings`)
      }
      if (config.timeoutMs !== undefined && (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1)) {
        errors.push(`MCP server "${name}" timeoutMs must be a positive integer`)
      }
      if (config.env !== undefined) {
        if (typeof config.env !== 'object' || config.env === null || Array.isArray(config.env)) {
          errors.push(`MCP server "${name}" env must be an object`)
        } else if (Object.values(config.env).some((v) => typeof v !== 'string')) {
          errors.push(`MCP server "${name}" env values must be strings`)
        }
      }
      if (config.envPassthrough !== undefined) {
        if (!Array.isArray(config.envPassthrough) || config.envPassthrough.some((arg) => typeof arg !== 'string')) {
          errors.push(`MCP server "${name}" envPassthrough must be an array of strings`)
        }
      }
      if (config.cwd !== undefined && typeof config.cwd !== 'string') {
        errors.push(`MCP server "${name}" cwd must be a string`)
      }
    }
  }

  if (settings.mcp?.trustedServers !== undefined) {
    if (!Array.isArray(settings.mcp.trustedServers)) {
      errors.push('mcp.trustedServers must be an array of strings')
    } else if (settings.mcp.trustedServers.some((server) => typeof server !== 'string' || server.trim() === '')) {
      errors.push('mcp.trustedServers must be an array of non-empty strings')
    }
  }

  if (settings.skills?.disabled !== undefined) {
    if (!Array.isArray(settings.skills.disabled)) {
      errors.push('skills.disabled must be an array of strings')
    } else if (settings.skills.disabled.some((name) => typeof name !== 'string' || name.trim() === '')) {
      errors.push('skills.disabled must be an array of non-empty strings')
    }
  }

  if (settings.cache?.ttl1h !== undefined && typeof settings.cache.ttl1h !== 'boolean') {
    errors.push('cache.ttl1h must be a boolean')
  }

  if (settings.autoMemory !== undefined && typeof settings.autoMemory !== 'boolean') {
    errors.push('autoMemory must be a boolean')
  }

  if (settings.thinking !== undefined && typeof settings.thinking !== 'boolean') {
    errors.push('thinking must be a boolean')
  }

  if (settings.effortLevel !== undefined && !['low', 'medium', 'high', 'xhigh', 'max'].includes(settings.effortLevel)) {
    errors.push('effortLevel must be one of: low, medium, high, xhigh, max')
  }

  if (settings.permissions?.mode !== undefined && !STARTUP_PERMISSION_MODES.includes(settings.permissions.mode as StartupPermissionMode)) {
    errors.push(`permissions.mode must be one of: ${STARTUP_PERMISSION_MODES.join(', ')}`)
  }

  for (const name of ['allow', 'deny', 'ask', 'additionalDirectories'] as const) {
    const rules = settings.permissions?.[name]
    if (rules !== undefined && !Array.isArray(rules)) {
      errors.push(`permissions.${name} must be an array`)
      continue
    }
    if (rules?.some((rule) => typeof rule !== 'string' || rule.trim() === '')) {
      errors.push(`permissions.${name} must be an array of non-empty strings`)
    }
  }

  for (const name of ['userPromptSubmit', 'preToolUse', 'postToolUse', 'preCompact', 'postCompact', 'subagentStart', 'subagentStop', 'stop'] as const) {
    const hooks = settings.hooks?.[name]
    if (hooks !== undefined && !Array.isArray(hooks)) {
      errors.push(`hooks.${name} must be an array`)
      continue
    }
    for (const [index, hook] of (hooks ?? []).entries()) {
      validateHookSetting(hook, `hooks.${name}[${index}]`, errors)
    }
  }

  return { valid: errors.length === 0, errors }
}

function validateHookSetting(hook: HookCommandSetting, path: string, errors: string[]): void {
  if (!hook || typeof hook !== 'object') {
    errors.push(`${path} must be an object`)
    return
  }
  if (typeof hook.command !== 'string' || hook.command.trim() === '') {
    errors.push(`${path}.command must be a non-empty string`)
  }
  if (hook.matcher !== undefined && typeof hook.matcher !== 'string') {
    errors.push(`${path}.matcher must be a string`)
  }
  if (hook.timeoutMs !== undefined && (!Number.isInteger(hook.timeoutMs) || hook.timeoutMs < 1)) {
    errors.push(`${path}.timeoutMs must be a positive integer`)
  }
}
