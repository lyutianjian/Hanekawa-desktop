import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ConfigService } from '../config/service.js'
import { migrateProjectConfig } from '../config/migrateProjectConfig.js'
import {
  loadMergedSettings,
  validateSettings,
  type MyAgentSettings,
} from '../config/settings.js'
import { clampEffort } from '../config/effort.js'
import { permissionRulesFromSettings } from '../harness/permissions.js'
import type { RuntimeDiagnostic } from '../harness/diagnostics.js'
import { getAllTools } from '../tools/index.js'
import { BUILT_IN_AGENT_DEFINITIONS, type BaseAgentDefinition } from '../tools/AgentTool/AgentTool.js'
import { SkillsService } from '../services/skills/skillsService.js'
import { AgentDefinitionLoader } from '../services/agents/agentDefinitionLoader.js'
import { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import { ImageAttachmentService, attachmentSendVersionPath } from '../services/imageAttachments/imageAttachmentService.js'
import type { AttachmentFactsResolver } from '../harness/turnImages.js'
import { removeLegacyShadowGit } from '../services/fileHistory/legacyShadowGit.js'
import { clearProjectContextCache, getProjectEntries } from '../services/context/projectContext.js'
import type { SessionMeta } from '../sessions/service.js'
import { registerBuiltinCommands } from '../commands/index.js'
import { CommandRegistry } from '../commands/registry.js'
import { registerSkillCommands } from '../commands/skills.js'
import { createActiveModelRuntimeFactory } from './createRuntime.js'
import { RuntimeStartupError } from './errors.js'
import { connectMcpServers } from './mcp.js'
import { createSessionScope, type SessionScopeDeps } from './sessionScope.js'
import { ToolRegistry } from './toolRegistry.js'
import type { ManagedMcpClient, McpServerConfig } from '../services/mcp/index.js'
import type { BootstrapOptions, McpConnectionStatus, RuntimeHost, SessionScope } from './types.js'

function mergeAgentDefinitions<T extends { type: string }>(base: readonly T[], overrides: readonly T[]): T[] {
  const merged = new Map<string, T>()
  for (const definition of base) merged.set(definition.type, definition)
  for (const definition of overrides) merged.set(definition.type, definition)
  return [...merged.values()]
}

/**
 * Models are validated after ConfigService merges them, when a loop is built.
 * Legacy settings declarations must not prevent opening the editor that can
 * override them in global config.json. Other settings still fail validation.
 */
function validateShellSettings(settings: MyAgentSettings) {
  return validateSettings({ ...settings, models: undefined })
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

/**
 * The attachment store as the request path's facts resolver: metadata without
 * image bytes, plus an existence check. An attachment counts as gone only when
 * both the immutable original and the send version are missing — a surviving
 * original can rebuild the send version, and a lone surviving send version is
 * still a cacheable file the historical placeholder can name honestly.
 */
function createAttachmentFactsResolver(service: ImageAttachmentService, cwd: string): AttachmentFactsResolver {
  return {
    resolveAttachmentFacts: async (ref) => {
      const resolved = await service.resolveRef(ref)
      if (!resolved.ok) return { ok: false }
      const { metadata } = resolved.value
      const originalExists = await fileExists(metadata.localPath)
      const sendPath = attachmentSendVersionPath(cwd, ref)
      if (!originalExists && !(await fileExists(sendPath))) return { ok: false }
      return {
        ok: true,
        facts: {
          originalWidth: metadata.originalWidth,
          originalHeight: metadata.originalHeight,
          ...(metadata.exifOrientation !== undefined ? { exifOrientation: metadata.exifOrientation } : {}),
          localPath: originalExists ? metadata.localPath : sendPath,
        },
      }
    },
  }
}

/**
 * Assembles everything needed to run an agent in `cwd`, with no terminal or
 * React dependency: settings, config, tools, skills, agent definitions, MCP
 * servers, the permission gate, and the runtime factory.
 *
 * Invalid settings throw {@link RuntimeStartupError}. Missing model/provider
 * configuration leaves the shell available for setup. MCP failures are
 * reported in `mcp.failed`.
 */
export async function bootstrap(options: BootstrapOptions): Promise<RuntimeHost> {
  const { cwd, store, session, confirmMcpTrust } = options

  const backgroundTasks = new BackgroundTaskRegistry(
    (sessionId, record) => store.appendRecord(sessionId, record),
  )

  // One per project, like `backgroundTasks` above: attachments are addressed
  // by `(sessionId, imageId)` inside the project data dir's `attachments/`, so every
  // host and tool context over this project must share one service for the
  // same-session dedup and in-flight guards to mean anything.
  const attachments = new ImageAttachmentService(cwd)

  // Not awaited: this is disk the old checkpoint implementation left behind and
  // nothing below reads it, so startup must not wait on deleting gigabytes.
  void removeLegacyShadowGit(cwd)

  // One per project, like `toolRegistry` below: `registerSkillCommands` reads
  // `<cwd>/.myagent/skills/`, so a process-wide registry would let a second
  // project's skills answer this one's slash commands.
  const commands = new CommandRegistry()

  // Mutable so `reloadSettings()` can replace it; `createRuntime` reads it
  // through a getter, so the next runtime built picks up the new contents.
  let settings = await loadMergedSettings(cwd)
  const configuredEffortLevel = settings.effortLevel ?? 'high'
  // Before the first load and never again: config.json is global-only now, so a
  // project that still has its own file has to be folded into the global one or
  // its endpoints and models would simply stop existing.
  const migrationFindings = await migrateProjectConfig(cwd)
  const config = new ConfigService(cwd)
  await config.load(settings)
  const settingsValidation = validateShellSettings(settings)
  if (!settingsValidation.valid) {
    throw new RuntimeStartupError(
      'invalid_settings',
      `Invalid settings:\n${settingsValidation.errors.map((error) => `- ${error}`).join('\n')}`,
    )
  }

  // `AGENTS.md` / `CLAUDE.md` from cwd upwards, read once here. Mutable for the
  // same reason `settings` is: `reloadSettings()` re-reads them and the next
  // runtime built picks up the new contents.
  let projectEntries = await getProjectEntries(cwd)

  // Read live rather than captured: the default model is editable from the
  // settings screen, and a new session opened afterwards has to start on the
  // model the user just chose, not the one that was default at launch.
  const resolveDefaultModelKey = (): string | undefined =>
    config.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: config.get().defaultModel })

  const startupModelKey = resolveDefaultModelKey()
  const modelConfig = startupModelKey ? config.getModel(startupModelKey) : undefined
  const modelDiagnostics = [
    ...migrationFindings.map((message) => ({
      code: 'project_config_migrated',
      severity: 'warning' as const,
      message,
    })),
    ...(store.takeMigrationFindings?.() ?? []).map((finding) => ({
      code: finding.kind === 'failed' ? 'project_data_migration_failed' : 'project_data_migrated',
      severity: finding.kind === 'failed' ? 'warning' as const : 'info' as const,
      message: finding.message,
    })),
    ...checkLegacyModelTiers(config),
    ...checkOptionalModelReferences(config),
  ]
  const clampedInitialEffort = clampEffort(configuredEffortLevel, modelConfig?.supportedEfforts)

  // The shell's own tools go last so a name it injects wins over nothing —
  // there is no built-in to shadow, and a collision would be a bug in the
  // shell, not a policy this line should paper over.
  const toolRegistry = new ToolRegistry([...await getAllTools(backgroundTasks), ...(options.extraTools ?? [])])
  // Constructed fresh on every read: the service caches, and a reload exists
  // precisely to see files that changed since startup.
  let skills = await new SkillsService(cwd).list()
  const agentLoader = new AgentDefinitionLoader(cwd)
  let customAgentDefinitions = await agentLoader.list()
  let agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
  modelDiagnostics.push(...agentDefinitionDiagnostics(agentLoader.warnings, customAgentDefinitions, skills))
  const reloadAgentDefinitions = async (): Promise<number> => {
    agentLoader.invalidate()
    customAgentDefinitions = await agentLoader.list()
    agentDefinitions = mergeAgentDefinitions([...BUILT_IN_AGENT_DEFINITIONS], customAgentDefinitions)
    return customAgentDefinitions.length
  }

  /**
   * Re-reads `.myagent/skills/` and re-registers the slash commands they define.
   *
   * The prompt side needs no help: `ContextBuilder` fingerprints its
   * `# Available skills` section and drops the cached copy when it changes.
   */
  const reloadSkills = async (): Promise<number> => {
    skills = await new SkillsService(cwd).list()
    await registerSkillCommands(commands, cwd)
    return skills.length
  }

  /**
   * Re-reads the settings layers.
   *
   * Only the parts that are read live take effect immediately — permission
   * rules and the config layer. Hooks and the cache-break `cacheRuntime` are
   * captured when a runtime is constructed, so the caller has to rebuild the
   * runtime for those; `needsRuntimeRebuild` says so rather than leaving the
   * caller to guess.
   *
   * The project's instruction files (`AGENTS.md` / `CLAUDE.md`) ride along:
   * they are not a settings layer, but they are captured per runtime the same
   * way, and this is the one reload every host already calls, so an edited
   * file reaches the next runtime instead of waiting for a restart. The global
   * `~/.myagent/AGENTS.md` is not here: each session snapshots it when it
   * starts (`createRuntimeFactory`), and an open session keeps its snapshot.
   *
   * Every open scope gets the new rules, not just the newest one: each holds
   * its own `PermissionGate`, so reaching only one would leave the other tabs
   * enforcing the rules the process started with.
   */
  const reloadSettings = async (): Promise<{ needsRuntimeRebuild: boolean }> => {
    const next = await loadMergedSettings(cwd)
    const validation = validateShellSettings(next)
    if (!validation.valid) {
      throw new RuntimeStartupError(
        'invalid_settings',
        `Invalid settings:\n${validation.errors.map((error) => `- ${error}`).join('\n')}`,
      )
    }

    const hooksChanged = JSON.stringify(next.hooks) !== JSON.stringify(settings.hooks)
    const previousConfig = JSON.stringify(config.get())
    settings = next
    await config.load(settings)
    const configChanged = previousConfig !== JSON.stringify(config.get())

    clearProjectContextCache(cwd)
    const nextProjectEntries = await getProjectEntries(cwd)
    const projectEntriesChanged = JSON.stringify(nextProjectEntries) !== JSON.stringify(projectEntries)
    projectEntries = nextProjectEntries

    const rules = permissionRulesFromSettings(settings.permissions)
    for (const scope of scopes) scope.permissionGate.setConfigRules(rules)
    return { needsRuntimeRebuild: hooksChanged || projectEntriesChanged || configChanged }
  }

  // Fail-open: a server that fails to connect is reported but does not block
  // startup. Trust is confirmed through the host, before it owns stdin.
  const recordMcpFailure = async (name: string, error: string): Promise<void> => {
    await store.appendMetric(session.id, {
      event: 'mcp_connect_failed',
      server: name,
      error,
    })
  }

  let mcpClients: ManagedMcpClient[] = []
  // One object for the life of the project: hosts read `ProjectRuntime.mcp`
  // directly, so a reload rewrites its contents instead of replacing it.
  const mcpStatus: McpConnectionStatus = { connected: [], failed: [] }
  const connectMcp = async (
    confirmTrust: (name: string, server: McpServerConfig) => Promise<boolean>,
  ): Promise<void> => {
    const result = await connectMcpServers({
      cwd,
      settings,
      registry: toolRegistry,
      confirmTrust,
      onConnectFailure: recordMcpFailure,
    })
    mcpClients = result.clients
    mcpStatus.connected.splice(0, mcpStatus.connected.length, ...result.status.connected)
    mcpStatus.failed.splice(0, mcpStatus.failed.length, ...result.status.failed)
  }
  await connectMcp(confirmMcpTrust)

  /**
   * Reconnects every MCP server from the current settings.
   *
   * Tools are dropped *before* reconnecting: a server the settings no longer
   * name would otherwise keep its tools in every live runtime's tool array,
   * since the registry only ever hears about servers that connect.
   *
   * Never prompts. `confirmMcpTrust` is a pre-channel prompt by construction
   * (it runs before any UI exists), and a reload happens while a UI is up, so
   * an untrusted server is reported as such rather than asked about.
   */
  const reloadMcpServers = async (): Promise<void> => {
    const previousClients = mcpClients
    const previousServers = mcpStatus.connected.map((entry) => entry.name)
    mcpClients = []
    await Promise.allSettled(previousClients.map((client) => client.close()))
    for (const name of previousServers) toolRegistry.removeServerTools(name)
    await connectMcp(async () => false)
  }

  registerBuiltinCommands(commands)
  await registerSkillCommands(commands, cwd)

  const contextManagement = config.get().agent.contextManagement
  const isGitRepo = existsSync(join(cwd, '.git'))

  const createActiveModelRuntime = createActiveModelRuntimeFactory(config, contextManagement)

  const scopeDeps: SessionScopeDeps = {
    cwd,
    config,
    store,
    getSettings: () => settings,
    getSkills: () => skills,
    getAgentDefinitions: () => agentDefinitions,
    getProjectEntries: () => projectEntries,
    toolRegistry,
    backgroundTasks,
    contextManagement,
    isGitRepo,
    initialEffort: clampedInitialEffort,
    createActiveModelRuntime,
    imageAttachments: attachments,
    attachmentFacts: createAttachmentFactsResolver(attachments, cwd),
    attachmentBytes: attachments,
  }

  // Every scope currently open. `reloadSettings` has to reach all of them, and
  // `shutdown` has to release all of them.
  const scopes = new Set<SessionScope>()
  const openScope = async (target: SessionMeta): Promise<SessionScope> => {
    const created = await createSessionScope(scopeDeps, target)
    // Wrapped rather than handed a deregister callback: the scope has no reason
    // to know it is being tracked, and this keeps the set private to bootstrap.
    const scope: SessionScope = {
      ...created,
      dispose: () => {
        scopes.delete(scope)
        created.dispose()
      },
    }
    scopes.add(scope)
    return scope
  }

  const initialScope = await openScope(session)

  return {
    ...initialScope,
    // The initial scope shows the project's startup diagnostics too — they need
    // surfacing once, and this is the scope that surfaces them.
    diagnostics: [...modelDiagnostics, ...initialScope.diagnostics],
    cwd,
    config,
    store,
    backgroundTasks,
    attachments,
    commands,
    mcp: mcpStatus,
    // A getter, so a `set-default-model` that has already been saved into the
    // live `ConfigService` reaches the next session without a restart. Removing
    // the last model returns new panes to setup instead of reusing a stale key.
    get initialModelKey(): string | undefined {
      return resolveDefaultModelKey()
    },
    initialEffort: typeof clampedInitialEffort === 'string' ? clampedInitialEffort : undefined,
    configuredEffortLevel,
    createActiveModelRuntime,
    openScope,
    getSettings: () => settings,
    getProjectEntries: () => projectEntries,
    listAgentDefinitions: () => agentDefinitions,
    reloadAgentDefinitions,
    reloadSkills,
    reloadSettings,
    reloadMcpServers,
    shutdown: async (reason: string) => {
      // Swallow errors so a misbehaving server cannot prevent a clean exit.
      await backgroundTasks.stopAll(undefined, reason)
      await Promise.allSettled(mcpClients.map((client) => client.close()))
      for (const scope of [...scopes]) scope.dispose()
    },
  }
}

/**
 * The configured name, or undefined when the setting means "unset".
 *
 * `inherit` is a legitimate value that resolves to nothing on purpose, so it is
 * not a misconfiguration.
 */
function configuredModelName(reference: string | undefined): string | undefined {
  const trimmed = reference?.trim()
  if (!trimmed || trimmed.toLowerCase() === 'inherit') return undefined
  return trimmed
}

/**
 * Surfaces tier-era config that `ConfigService.load()` already migrated.
 *
 * The `fast`/`balanced`/`powerful` tiers and the `profiles` layer under them are
 * gone; a config written before that still parses, so the only way the user
 * learns their `routing` no longer means what it said is a warning here. Reports
 * rather than throws, for the same reason `checkOptionalModelReferences` does:
 * refusing to start over a setting we already repaired helps nobody.
 */
function checkLegacyModelTiers(config: ConfigService): RuntimeDiagnostic[] {
  return config.getLegacyModelFindings().map((message) => ({
    code: 'legacy_model_tiers',
    severity: 'warning' as const,
    message,
  }))
}

/**
 * Warns about `fallbackModel` / `compactModel` naming something that does not
 * exist.
 *
 * `resolveModelReference` only ever returns a key `resolveModel` already
 * accepted, so the old `config.getModel(resolved)` guards here could never
 * fire. What they were reaching for was real, though: an unresolvable name
 * yields `undefined`, which is indistinguishable from "not configured", so a
 * typo was silently ignored. These are optional settings — degrading to no
 * fallback beats refusing to start — so this reports rather than throws.
 */
/** Loader findings and skill names no loaded skill answers to. */
function agentDefinitionDiagnostics(
  warnings: readonly string[],
  definitions: readonly BaseAgentDefinition[],
  skills: readonly { name: string }[],
): RuntimeDiagnostic[] {
  const known = new Set(skills.map((skill) => skill.name))
  const messages = [
    ...warnings,
    ...definitions.flatMap((definition) => (definition.skills ?? [])
      .filter((name) => !known.has(name))
      .map((name) => `Custom agent '${definition.type}' references missing skill '${name}'`)),
  ]
  return messages.map((message) => ({ code: 'agent_definition', severity: 'warning', message }))
}

function checkOptionalModelReferences(config: ConfigService): RuntimeDiagnostic[] {
  const diagnostics: RuntimeDiagnostic[] = []
  const optional = [
    { code: 'unknown_fallback_model', label: 'fallbackModel', raw: config.get().fallbackModel },
    { code: 'unknown_compact_model', label: 'compactModel', raw: config.get().compactModel },
  ] as const

  for (const { code, label, raw } of optional) {
    const configured = configuredModelName(raw)
    if (configured && !config.resolveModelReference(configured)) {
      diagnostics.push({
        code,
        severity: 'warning',
        message: `Unknown ${label} configured: ${configured}. It will be ignored.`,
      })
    }
  }
  return diagnostics
}
