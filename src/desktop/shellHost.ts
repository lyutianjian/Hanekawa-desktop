import { z } from 'zod/v3'
import path from 'node:path'
import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'
import { maskKey } from '../config/maskKey.js'
import { VALID_EFFORT_LEVELS, normalizeSupportedEfforts } from '../config/effort.js'
import { resolveImageCapability, SUPPORTED_PROVIDER_NAMES } from '../config/providers/registry.js'
import { carryJsonOnlyModelFields } from '../config/service.js'
import type { Config, ModelConfig } from '../config/service.js'
import type { Endpoint, Routing } from '../config/routing.js'
import {
  loadLocalSettings,
  loadSettingsLayers,
  localSettingsPath,
  setLocalCacheTtl1h,
  setLocalThinking,
  coordinationSettings,
  setLocalCoordination,
  setLocalPermissionEntries,
  setLocalStartupPermissionMode,
  setMcpServerTrustLocally,
  setMcpServerLocally,
  removeMcpServerLocally,
  setSkillEnabledLocally,
  disabledSkillNames,
  type MyAgentSettings,
  type StartupPermissionMode,
} from '../config/settings.js'
import { DEFAULT_CONTEXT_MANAGEMENT, type ContextManagementConfig } from '../prompts/budget.js'
import { coordinatedThreadSessionIds, deleteSessionArtifacts } from '../runtime/deleteSession.js'
import type { ProviderConfigChangeScope } from '../runtime/providerRuntime.js'
import type { SessionMeta } from '../sessions/service.js'
import { SessionStore } from '../sessions/service.js'
import type { McpServerConfig } from '../services/mcp/index.js'
import { BUILT_IN_AGENT_DEFINITIONS, type BaseAgentDefinition } from '../tools/AgentTool/AgentTool.js'
import { SkillsService, type SkillDefinition } from '../services/skills/skillsService.js'
import { DEFAULT_AUTO_RESOLVE_DAYS, DEFAULT_QUIET_DAYS } from '../services/coordination/lifecycle.js'
import { importSkill } from '../services/skills/importSkill.js'
import { readUserInstructions, writeUserInstructions } from '../services/context/projectContext.js'
import { peekSessions } from './recentProjects.js'
import { UsageScanner } from './usageStats.js'
import { getProjectDataDir, getSkillsDir, isGlobalWorkspaceRoot } from '../utils/paths.js'
import type {
  DirectoryProject,
  DirectoryWorkspace,
  PaneLike,
  ProjectDirectory,
  ProjectEntry,
} from '../runtime/projectDirectory.js'
import { projectDisplayName, projectRootKey } from '../runtime/projectDirectory.js'
import type { RuntimeChannel } from '../runtime/protocol/channel.js'
import type { CoordinationLaneControl } from '../runtime/protocol/coordinationHost.js'
import type { LaneMux } from '../runtime/protocol/laneChannel.js'
import { projectToolDisplays } from '../runtime/protocol/host.js'
import type { SessionPane, SessionWorkspace } from '../runtime/sessionWorkspace.js'
import type { McpConnectionStatus, RuntimeHost } from '../runtime/types.js'
import {
  CONTEXT_MANAGEMENT_FIELDS,
  SHELL_LANE,
  USER_INSTRUCTIONS_MAX_CHARS,
  type ShellCommand,
  type ShellEvent,
  type WireLaneInfo,
  type WireShellDeleteSessionResult,
  type WireShellOpenInEditorResult,
  type WireShellSetWindowThemeResult,
  type WireShellPickImagesResult,
  type WireBrowserRect,
  type WireBrowserTabInfo,
  type WireShellBrowserCreateTabResult,
  type WireShellBrowserOkResult,
  type WireShellOpenProjectResult,
  type WireShellRemoveProjectResult,
  type WireShellOpenSessionResult,
  type WireShellPanesResult,
  type WireSessionSummary,
  type WireShellSessionsResult,
  type WireShellUsageStatsResult,
  type WireShellRenameSessionResult,
  type WireShellSettingsChangeResult,
  type WireShellSettingsResult,
  type WireSettingsSnapshot,
  type WireAgentDefinitionInfo,
  type WireContextManagementInfo,
  type WireCoordinationSettingsInfo,
  type WireEndpointInfo,
  type WireMcpServerInfo,
  type WireSkillInfo,
  type WireModelInfo,
  type WirePermissionGroup,
  type WirePermissionsInfo,
  type WireEditorTarget,
  type SettingsChange,
  type WireShellCoordinationOkResult,
  type WireShellNewCoordinatorProjectResult,
  type WireShellOpenCoordinatorResult,
  type WireShellThreadMergeResult,
  type WireShellThreadTranscriptResult,
  type WireShellThreadMergesResult,
  type WireThreadMerge,
  type WireCoordinationThreads,
  type WireThreadInfo,
  type WireThreadStatus,
} from './shellProtocol.js'

/**
 * The window's host: every decision a single-window shell makes about lanes
 * and projects, in a module a plain-node test can import.
 *
 * `main.ts` cannot be tested (`app.requestSingleInstanceLock()` runs at module
 * top level), so whatever lives only there is uncovered forever. This class is
 * where those decisions went: the lane registry, "one pane, one lane"
 * deduplication, the fixed detach order, "a project dies with its last lane",
 * and the pane-resolution choreography an `open-pane` used to do inline. What
 * deliberately stays in `main.ts`: the `BrowserWindow`, native dialogs, and
 * `bootstrap()` — the shell owns the MCP trust prompt and the error boxes, the
 * same split `ProjectDirectory` already draws.
 *
 * Two keys, and they are not interchangeable. The lane key is minted here and
 * never moves; `paneId` is the session id and travels under `/clear` and
 * `/resume`. Host callbacks arrive with the moving id, so they look lanes up
 * by scanning `pane.getSession()` — never by assuming the key.
 *
 * The occupant of a lane is opaque. Production passes a factory that builds a
 * `SessionHost` over the pane; a test passes a recorder. All this class asks of
 * either is the three members of `LaneOccupant`, which is what keeps the shell
 * protocol testable without casting a `SessionHost`'s concrete deps.
 */

// --- the structural halves, generic for the same reason ProjectDirectory is --

/**
 * The project half the shell touches: a root, the store sessions resolve
 * through, the one scope-opener a fresh draft needs, and the one call that
 * stops background work.
 */
export interface ShellLaneProject extends DirectoryProject {
  readonly store: {
    resolve(idOrPrefix: string): Promise<SessionMeta | undefined>
    createDraft(title?: string): SessionMeta
    /** The sidebar's history: every session on disk, newest first. */
    list(): Promise<SessionMeta[]>
    delete(idOrPrefix: string): Promise<void>
    rename(idOrPrefix: string, title: string): Promise<void>
  }
  /**
   * The settings screen's read *and* write surface.
   *
   * A narrow structural slice rather than `ConfigService` itself, and every
   * member here exists on it with exactly this signature — `Satisfied<RuntimeHost,
   * ShellLaneProject>` below is what keeps that true. Do not add
   * `setFallbackModel` / `setCompactModel` / `removeRouting`: they do not exist,
   * which is why those two fields are read-only in the snapshot.
   *
   * The project is the right seam. There is one `ConfigService` per project and
   * up to N lanes over it, so reaching config through a lane's occupant would
   * mean picking an arbitrary one — and the settings screen can be pointed at a
   * project whose lanes you are not looking at. The occupant is only asked to
   * *react* (`refreshAfterConfigChange`).
   */
  readonly config: {
    get(): Config
    getRouting(): Routing
    setRouting(routing: Routing): void
    setEndpoint(name: string, endpoint: Endpoint): void
    removeEndpoint(name: string): void
    renameEndpoint(oldName: string, newName: string): void
    /** The models that resolve through one endpoint — what removing it takes with it. */
    modelsForEndpoint(name: string): string[]
    setModelConfig(name: string, model: ModelConfig): void
    removeModel(name: string): void
    renameModel(oldKey: string, newKey: string): void
    setDefaultModel(name: string): void
    setContextManagement(patch: Partial<ContextManagementConfig>): void
    resolveModel(name: string): ModelConfig | undefined
    getSaveTarget(): string
    save(): Promise<void>
  }
  /**
   * The merged settings the runtime is *running on*, for the cards that read
   * settings rather than config. Read here rather than re-merged off disk: a
   * second merge can differ from the loop's, and a screen showing rules the gate
   * is not enforcing is worse than a screen showing none.
   */
  getSettings(): MyAgentSettings
  /** Read-only: the agent cards list these; editing them means editing files. */
  listAgentDefinitions(): readonly BaseAgentDefinition[]
  reloadAgentDefinitions(): Promise<number>
  /** Re-reads `.myagent/skills/` and re-registers their slash commands. */
  reloadSkills(): Promise<number>
  /** As it stands now. Mutated in place by `reloadMcpServers`, never replaced. */
  readonly mcp: McpConnectionStatus
  reloadMcpServers(): Promise<void>
  /** Re-reads the settings layers. Per *project*, so the shell calls it once per edit. */
  reloadSettings(): Promise<{ needsRuntimeRebuild: boolean }>
  /** The scope type is opaque here: the shell mints it and hands it straight to `adopt`. */
  openScope(session: SessionMeta): Promise<unknown>
}

/**
 * The workspace half: `SessionWorkspace`'s pane surface, declared structurally
 * so a test fakes it without casting. Parameterized by the pane type because
 * `createOccupant` needs the *real* pane (a `SessionHost` wants the
 * controller, the slot and the scope off it), and `PaneLike` alone would
 * erase those behind an assertion at the one place types matter most.
 */
export interface ShellLaneWorkspace<PaneT extends PaneLike = SessionPane> extends DirectoryWorkspace {
  paneForSession(sessionId: string): PaneT | undefined
  open(session: SessionMeta): Promise<PaneT>
  adopt(scope: unknown, options?: { modelKey?: string }): PaneT
  close(pane: PaneT): void
}

/**
 * Everything a lane holds besides its key.
 *
 * Deliberately small, and every member required. Production passes a
 * `SessionHost`; a test passes a recorder — and because the interface is
 * structural, tsc names a member either of them forgets. The two beyond
 * `dispose()` were added together on purpose: both are "the shell needs to
 * speak to one lane's host", and widening this once for both was the whole
 * reason `rename-session` waited for the settings fan-out.
 */
export interface LaneOccupant {
  dispose(): void
  /**
   * This lane's project config changed.
   *
   * `rebuild` is the shell's decision, not something the host reads off
   * `reloadSettings()`. That call's `needsRuntimeRebuild` is *only*
   * `hooksChanged` (`bootstrap.ts:141`), so a provider or routing edit reports
   * `false` — trusting it would produce a settings screen that saves, redraws,
   * and does nothing until the next launch, which is indistinguishable from
   * working.
   */
  refreshAfterConfigChange(options: { rebuild: boolean; scope: ProviderConfigChangeScope }): void
  /**
   * The model key this lane is mid-turn on, or `undefined` when it is idle.
   *
   * Asked before a `remove-model` / `remove-endpoint` and nowhere else. Config
   * references repair themselves now, so this is the only remaining reason a
   * removal is refused — and it has to be asked of the lane, because the config
   * cannot know which of its models is currently streaming.
   */
  activeModelKey(): string | undefined
  /**
   * The session's meta moved without the session moving — a rename. The host
   * refreshes its controller's copy and pushes `session-changed`; anything
   * heavier (`retarget`) would interrupt the turn and reset usage for a title.
   */
  refreshSessionMeta(session: SessionMeta): void
  /**
   * The lane's session as coordination drives it — production hands the
   * `SessionHost` itself. Optional: a lane without one cannot be reached by the
   * coordinator, which is what a test recorder wants.
   */
  coordination?: CoordinationLaneControl
}

/**
 * The host-side coordination commands, keyed by project `cwd`.
 * `CoordinationService` satisfies it; the shell only routes to it.
 */
export interface ShellCoordination {
  /** The coordinator session id, created when the project has none. */
  ensureCoordinator(cwd: string, options?: { opening?: boolean }): Promise<string>
  stopAll(cwd: string): Promise<void>
  pendingMerges(cwd: string): Promise<WireThreadMerge[]>
  mergeThread(cwd: string, threadId: string): Promise<WireShellThreadMergeResult>
  dismissMerge(cwd: string, threadId: string): Promise<void>
  resolveConflictViaThread(cwd: string, threadId: string): Promise<void>
  /** The thread table, lifecycle applied and text sanitized; no coordinator check. */
  threadInfos(cwd: string): Promise<{ coordinatorSessionId?: string; openingThreadId?: string; started?: boolean; threads: readonly ShellThreadInfo[] }>
  /** The user's stop of one thread. */
  stopThreadById(cwd: string, threadId: string): Promise<void>
  /** The user's 结案 of one thread. */
  resolveThreadById(cwd: string, threadId: string): Promise<void>
}

/**
 * The slice of the service's `ThreadInfo` the wire carries. `status` is the
 * service's plain string; {@link toWireThreadInfo} narrows it.
 */
export interface ShellThreadInfo {
  threadId: string
  sessionId: string
  title: string
  status: string
  statusLine?: string
  lastReport?: string
  lastActivityAt?: string
  branch?: string
}

/** How long a burst of thread-table writes for one project is folded into one push. */
export const COORDINATION_BROADCAST_DELAY_MS = 50

export interface LaneAttach<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends DirectoryWorkspace = SessionWorkspace,
> {
  lane: string
  /** The mux view for this lane; the occupant speaks its protocol on it. */
  channel: RuntimeChannel
  pane: PaneT
  project: ProjectEntry<P, W>
}

/**
 * The default here is the structural slice, not `SessionWorkspace` itself: a
 * type-parameter default is checked against the constraint *before* `PaneT`
 * resolves, so `SessionWorkspace` — which only fits once `PaneT` is known to
 * be `SessionPane` — cannot be spelled as the default. The production shell
 * instantiates the triple explicitly:
 * `new ShellHost<RuntimeHost, SessionPane, SessionWorkspace>(…)`.
 */
export interface ShellHostDeps<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends ShellLaneWorkspace<PaneT> = ShellLaneWorkspace<PaneT>,
> {
  /** The mux both sides of the window share. `SHELL_LANE` is claimed here. */
  mux: LaneMux
  directory: ProjectDirectory<P, W>
  /** Mints lane keys. Monotonic and never reused — `/clear` and `/resume` must not move it. */
  nextLaneKey: () => string
  /** Builds a lane's occupant (production: the `SessionHost` for that pane). */
  createOccupant: (attach: LaneAttach<P, PaneT, W>) => LaneOccupant
  /** `open-project` hand-off. A shell that cannot open projects rejects the command. */
  onOpenProject?: (path?: string) => void
  /**
   * `open-in-editor` hand-off, given the project's real `cwd` — and, since T15,
   * one file inside it at one line (`target.path` already resolved to an
   * absolute path bounded by the cwd; absent means the directory itself).
   *
   * Awaited, unlike `onOpenProject`: launching an editor usually fails by not
   * being installed, and that has to come back as a `fail` the renderer can put
   * in the transcript. A shell without one rejects the command.
   */
  onOpenInEditor?: (cwd: string, target?: { path: string; line?: number }) => Promise<void>
  /**
   * A native directory picker, for `import-skill` without a `sourceDir`.
   *
   * Awaited and allowed to answer `undefined` (cancelled) — the same shape
   * `promptForProjectDirectory` already has in `main.ts`. A shell without one
   * rejects the pathless variant rather than silently importing nothing.
   */
  onPickDirectory?: (options: { title: string; buttonLabel: string }) => Promise<string | undefined>
  /**
   * 「选择图片」 (S11): a native multi-select image picker, answered with
   * absolute paths. `defaultPath` is the directory the dialog opens in, when
   * the caller knows one worth anchoring to. Awaited and allowed to answer
   * `undefined` (cancelled) — the same shape `onPickDirectory` has. A shell
   * without one rejects, because a picker that silently answered "no images"
   * would read as the user having cancelled.
   */
  onPickImages?: (options: { defaultPath?: string }) => Promise<string[] | undefined>
  /**
   * Repaints the native title-bar overlay for the resolved theme (5g).
   *
   * Not awaited and allowed to be absent: see the `set-window-theme` arm of
   * `execute`.
   */
  onWindowTheme?: (theme: 'dark' | 'light') => void
  /**
   * While quitting, `detachLane` skips project shutdown: teardown owns the
   * ordering then, and closing projects mid-loop would race its own sweep.
   */
  isQuitting?: () => boolean
  /** Fired when the last lane goes — the single window's "nothing left" moment. */
  onAllLanesClosed?: (reason: string) => void
  /**
   * The persisted "added projects" registry, most recently opened first. The
   * sidebar's history lists every one of these — most without an open runtime —
   * beside the open projects and the global workspace.
   *
   * Optional so a test that only exercises open projects needs no fake; the
   * production shell always provides it.
   */
  knownProjects?: () => Promise<readonly string[]>
  /**
   * Opens a project on demand — a history row of a not-yet-open project was
   * clicked, or "new session" fired with nothing open at all. Bootstraps the
   * runtime and hands back the directory entry; when `sessionId` names the
   * session being opened, the bootstrap scope is built *over* it so the
   * project's first pane is the pane the click asked for.
   *
   * Optional for the same reason `knownProjects` is.
   */
  ensureProject?: (
    cwd: string,
    options?: { sessionId?: string },
  ) => Promise<ProjectEntry<P, W>>
  /**
   * `ensureProject` for a caller that will open a lane on a session other than
   * the bootstrap draft: `session` is that draft when this call created the
   * project (otherwise absent), so the caller can drop its pane.
   */
  ensureProjectFresh?: (cwd: string) => Promise<{ entry: ProjectEntry<P, W>; session?: SessionMeta }>
  /**
   * Drops a project from the "added projects" registry — the write half of
   * `remove-project`. Optional for the same reason `knownProjects` is; a shell
   * without one still closes the lanes, it just cannot make the row stay gone.
   */
  onForgetProject?: (cwd: string) => Promise<void>
  /**
   * The browser's tab host, when this shell has one.
   *
   * Optional like every other Electron-shaped dependency here, and for the same
   * reason: the test host has no window to hang a `WebContentsView` on. Without
   * it the browser commands reject rather than answering `ok`, because a panel
   * whose tabs silently never opened is indistinguishable from a broken one.
   *
   * `closeLane` is the half `detachLane` calls — tabs belong to a lane and die
   * with it.
   */
  browser?: {
    createTab(lane: string, url?: string): string
    closeTab(tabId: string): void
    closeLane(lane: string): void
    navigate(tabId: string, url: string): void
    goBack(tabId: string): void
    goForward(tabId: string): void
    reload(tabId: string): void
    takeOver(tabId: string): void
    releaseTab(tabId: string): void
    setBounds(tabId: string, rect: WireBrowserRect, visible: boolean): void
  }
  /** Project coordination. Without it the coordination commands reject. */
  coordination?: ShellCoordination
}

interface LaneEntry<P extends DirectoryProject, W extends DirectoryWorkspace, PaneT extends PaneLike> {
  pane: PaneT
  project: ProjectEntry<P, W>
  occupant: LaneOccupant
}

// The defaults are the real halves; if either stops satisfying its structural
// slice, these constants stop compiling. `Satisfied` (not a boolean check) so a
// wrong member is a *type* error naming the gap, the same net
// `electronChannel.test.ts` casts over its Electron slices.
type Satisfied<Real, Ours> = Real extends Ours ? true : never
const runtimeHostSatisfiesShellLaneProject: Satisfied<RuntimeHost, ShellLaneProject> = true
const sessionWorkspaceSatisfiesShellLaneWorkspace: Satisfied<
  SessionWorkspace,
  ShellLaneWorkspace<SessionPane>
> = true

// --- inbound validation ------------------------------------------------------

const commandId = z.string()

const mcpServerConfigSchema: z.ZodType<McpServerConfig> = z
  .object({
    transport: z.union([z.literal('stdio'), z.literal('sse')]),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    url: z.string().optional(),
    headers: z.record(z.string()).optional(),
    env: z.record(z.string()).optional(),
    envPassthrough: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()

/**
 * The settings edits, keyed by `kind` for the same reason the commands are
 * keyed by `type`: a variant added to `SettingsChange` without a schema here
 * fails the build *by name*, and `_NoSettingsDrift` below catches a field that
 * drifted rather than a whole variant that went missing.
 */
const SETTINGS_CHANGE_SCHEMAS = {
  'set-endpoint': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-endpoint'),
      name: z.string(),
      provider: z.string(),
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
    })
    .strict(),
  'clear-endpoint-key': z
    .object({ scope: z.literal('provider'), kind: z.literal('clear-endpoint-key'), name: z.string() })
    .strict(),
  'remove-endpoint': z
    .object({ scope: z.literal('provider'), kind: z.literal('remove-endpoint'), name: z.string() })
    .strict(),
  'rename-endpoint': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('rename-endpoint'),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
  'set-model': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-model'),
      key: z.string(),
      model: z.string(),
      provider: z.string().optional(),
      endpoint: z.string().optional(),
      contextWindow: z.number().optional(),
      longContext1m: z.boolean().optional(),
      supportsImageInput: z.boolean().optional(),
      maxOutputTokens: z.number().optional(),
      supportedEfforts: z.array(z.enum(VALID_EFFORT_LEVELS)).optional(),
    })
    .strict(),
  'rename-model': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('rename-model'),
      from: z.string(),
      to: z.string(),
    })
    .strict(),
  'remove-model': z
    .object({ scope: z.literal('provider'), kind: z.literal('remove-model'), key: z.string() })
    .strict(),
  'set-default-model': z
    .object({ scope: z.literal('provider'), kind: z.literal('set-default-model'), key: z.string() })
    .strict(),
  'set-routing': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-routing'),
      role: z.union([z.literal('main'), z.literal('plan'), z.literal('compact')]),
      value: z.string(),
    })
    .strict(),
  'set-subagent-routing': z
    .object({
      scope: z.literal('provider'),
      kind: z.literal('set-subagent-routing'),
      type: z.string(),
      value: z.string(),
    })
    .strict(),
  'set-permission-entries': z
    .object({
      scope: z.literal('permissions'),
      kind: z.literal('set-permission-entries'),
      behavior: z.union([z.literal('allow'), z.literal('deny'), z.literal('ask')]),
      entries: z.array(z.string()),
    })
    .strict(),
  'set-startup-permission-mode': z
    .object({
      scope: z.literal('permissions'),
      kind: z.literal('set-startup-permission-mode'),
      mode: z.union([z.literal('default'), z.literal('auto'), z.literal('bypass')]),
    })
    .strict(),
  'reload-agent-definitions': z
    .object({ scope: z.literal('agent'), kind: z.literal('reload-agent-definitions') })
    .strict(),
  'set-coordination-model': z
    .object({
      scope: z.literal('agent'),
      kind: z.literal('set-coordination-model'),
      role: z.enum(['coordinator', 'thread']),
      value: z.string().min(1),
    })
    .strict(),
  'set-coordination-effort': z
    .object({
      scope: z.literal('agent'),
      kind: z.literal('set-coordination-effort'),
      role: z.enum(['coordinator', 'thread']),
      value: z.union([z.enum(VALID_EFFORT_LEVELS), z.literal('inherit')]),
    })
    .strict(),
  'set-coordination-days': z
    .object({
      scope: z.literal('agent'),
      kind: z.literal('set-coordination-days'),
      field: z.enum(['quietDays', 'autoResolveDays']),
      value: z.number().int().min(0),
    })
    .strict(),
  'set-cache-ttl': z
    .object({ scope: z.literal('general'), kind: z.literal('set-cache-ttl'), enabled: z.boolean() })
    .strict(),
  'set-user-instructions': z
    .object({
      scope: z.literal('personalization'),
      kind: z.literal('set-user-instructions'),
      content: z.string().max(USER_INSTRUCTIONS_MAX_CHARS),
    })
    .strict(),
  'set-thinking': z
    .object({ scope: z.literal('general'), kind: z.literal('set-thinking'), enabled: z.boolean() })
    .strict(),
  'set-context-management': z
    .object({
      scope: z.literal('general'),
      kind: z.literal('set-context-management'),
      // The same list the rows are drawn from, so a seventh field cannot reach
      // one and miss the other.
      field: z.enum(CONTEXT_MANAGEMENT_FIELDS),
      value: z.number(),
    })
    .strict(),
  'set-skill-enabled': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('set-skill-enabled'),
      name: z.string(),
      enabled: z.boolean(),
    })
    .strict(),
  'import-skill': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('import-skill'),
      sourceDir: z.string().optional(),
    })
    .strict(),
  'reload-skills': z
    .object({ scope: z.literal('extensions'), kind: z.literal('reload-skills') })
    .strict(),
  'set-mcp-trust': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('set-mcp-trust'),
      name: z.string(),
      trusted: z.boolean(),
    })
    .strict(),
  'set-mcp-server': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('set-mcp-server'),
      name: z.string().min(1),
      server: mcpServerConfigSchema,
      previousName: z.string().min(1).optional(),
    })
    .strict(),
  'remove-mcp-server': z
    .object({
      scope: z.literal('extensions'),
      kind: z.literal('remove-mcp-server'),
      name: z.string().min(1),
    })
    .strict(),
  'reconnect-mcp': z
    .object({ scope: z.literal('extensions'), kind: z.literal('reconnect-mcp') })
    .strict(),
} as const satisfies Record<SettingsChange['kind'], z.ZodTypeAny>

type SettingsChangeOption = (typeof SETTINGS_CHANGE_SCHEMAS)[SettingsChange['kind']]

const settingsChangeSchema = z.discriminatedUnion(
  'kind',
  Object.values(SETTINGS_CHANGE_SCHEMAS) as unknown as [
    SettingsChangeOption,
    ...SettingsChangeOption[],
  ],
)

const SHELL_COMMAND_SCHEMAS = {
  panes: z.object({ type: z.literal('panes'), id: commandId }).strict(),
  'open-session': z
    .object({
      type: z.literal('open-session'),
      id: commandId,
      sessionId: z.string().optional(),
      title: z.string().optional(),
      projectRoot: z.string().optional(),
    })
    .strict(),
  'open-project': z
    .object({ type: z.literal('open-project'), id: commandId, path: z.string().optional() })
    .strict(),
  'remove-project': z
    .object({ type: z.literal('remove-project'), id: commandId, projectRoot: z.string() })
    .strict(),
  'list-sessions': z.object({ type: z.literal('list-sessions'), id: commandId }).strict(),
  'usage-stats': z.object({ type: z.literal('usage-stats'), id: commandId }).strict(),
  'delete-session': z
    .object({
      type: z.literal('delete-session'),
      id: commandId,
      projectRoot: z.string(),
      sessionId: z.string(),
    })
    .strict(),
  'get-settings': z
    .object({ type: z.literal('get-settings'), id: commandId, projectRoot: z.string().optional() })
    .strict(),
  'settings-change': z
    .object({
      type: z.literal('settings-change'),
      id: commandId,
      projectRoot: z.string(),
      change: settingsChangeSchema,
    })
    .strict(),
  'rename-session': z
    .object({
      type: z.literal('rename-session'),
      id: commandId,
      projectRoot: z.string(),
      sessionId: z.string(),
      title: z.string(),
    })
    .strict(),
  'open-in-editor': z
    .object({
      type: z.literal('open-in-editor'),
      id: commandId,
      projectRoot: z.string(),
      target: z
        .object({
          path: z.string().min(1),
          line: z.number().int().positive().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
  'set-window-theme': z
    .object({
      type: z.literal('set-window-theme'),
      id: commandId,
      theme: z.enum(['dark', 'light']),
    })
    .strict(),
  'pick-images': z
    .object({
      type: z.literal('pick-images'),
      id: commandId,
      projectRoot: z.string().min(1).optional(),
    })
    .strict(),
  'browser-create-tab': z
    .object({
      type: z.literal('browser-create-tab'),
      id: commandId,
      lane: z.string().min(1),
      url: z.string().min(1).optional(),
    })
    .strict(),
  'browser-close-tab': z
    .object({ type: z.literal('browser-close-tab'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-navigate': z
    .object({
      type: z.literal('browser-navigate'),
      id: commandId,
      tabId: z.string().min(1),
      url: z.string().min(1),
    })
    .strict(),
  'browser-go-back': z
    .object({ type: z.literal('browser-go-back'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-go-forward': z
    .object({ type: z.literal('browser-go-forward'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-reload': z
    .object({ type: z.literal('browser-reload'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-take-over': z
    .object({ type: z.literal('browser-take-over'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-release': z
    .object({ type: z.literal('browser-release'), id: commandId, tabId: z.string().min(1) })
    .strict(),
  'browser-set-bounds': z
    .object({
      type: z.literal('browser-set-bounds'),
      id: commandId,
      tabId: z.string().min(1),
      // Finite, because these are multiplied into native pixel bounds: a `NaN`
      // from a mid-collapse measurement would otherwise reach `setBounds`.
      rect: z
        .object({
          x: z.number().finite(),
          y: z.number().finite(),
          width: z.number().finite().nonnegative(),
          height: z.number().finite().nonnegative(),
        })
        .strict(),
      visible: z.boolean(),
    })
    .strict(),
  'open-coordinator': z
    .object({ type: z.literal('open-coordinator'), id: commandId, projectRoot: z.string().min(1) })
    .strict(),
  'new-coordinator-project': z
    .object({ type: z.literal('new-coordinator-project'), id: commandId, path: z.string().min(1).optional() })
    .strict(),
  'coordination-stop-all': z
    .object({ type: z.literal('coordination-stop-all'), id: commandId, projectRoot: z.string().min(1) })
    .strict(),
  'thread-merges': z
    .object({ type: z.literal('thread-merges'), id: commandId, projectRoot: z.string().min(1) })
    .strict(),
  'thread-merge': z
    .object({
      type: z.literal('thread-merge'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
  'thread-merge-dismiss': z
    .object({
      type: z.literal('thread-merge-dismiss'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
  'thread-merge-resolve': z
    .object({
      type: z.literal('thread-merge-resolve'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
  'coordination-threads': z
    .object({ type: z.literal('coordination-threads'), id: commandId, projectRoot: z.string().min(1) })
    .strict(),
  'thread-stop': z
    .object({
      type: z.literal('thread-stop'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
  'thread-resolve': z
    .object({
      type: z.literal('thread-resolve'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
    })
    .strict(),
  'thread-transcript': z
    .object({
      type: z.literal('thread-transcript'),
      id: commandId,
      projectRoot: z.string().min(1),
      threadId: z.string().min(1),
      since: z.string().optional(),
    })
    .strict(),
} as const satisfies Record<ShellCommand['type'], z.ZodTypeAny>

type CommandOption = (typeof SHELL_COMMAND_SCHEMAS)[ShellCommand['type']]

export const shellCommandSchema = z.discriminatedUnion(
  'type',
  Object.values(SHELL_COMMAND_SCHEMAS) as unknown as [CommandOption, ...CommandOption[]],
)

type ParsedShellCommand = z.infer<typeof shellCommandSchema>

type Assert<T extends true> = T
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
/** Field-level drift guard: a wrong type or a missing field reddens the build. */
type _NoDrift = Assert<MutuallyAssignable<ShellCommand, ParsedShellCommand>>
/** The same guard one level down, where the four settings cards will all land. */
type _NoSettingsDrift = Assert<MutuallyAssignable<SettingsChange, z.infer<typeof settingsChangeSchema>>>

export interface ShellCommandParseFailure {
  ok: false
  /** Recovered when present, so the sender's promise rejects rather than hangs. */
  id?: string
  message: string
}

export type ShellCommandParseResult = { ok: true; command: ShellCommand } | ShellCommandParseFailure

/** Bounded because it is echoed back over the wire in a `fail`. */
const MAX_MESSAGE_CHARS = 500

export function parseShellCommand(message: unknown): ShellCommandParseResult {
  const parsed = shellCommandSchema.safeParse(message)
  if (parsed.success) {
    return { ok: true, command: parsed.data as ShellCommand }
  }
  const failure: ShellCommandParseFailure = { ok: false, message: describe(parsed.error) }
  if (isRecord(message) && typeof message.id === 'string') failure.id = message.id
  return failure
}

function describe(error: z.ZodError): string {
  const summary = error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
  return summary.length > MAX_MESSAGE_CHARS ? `${summary.slice(0, MAX_MESSAGE_CHARS)}…` : summary
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Bounds a renderer-named file to the project it was named under.
 *
 * Lexical, not `realpath`: the search tool that printed the path already kept
 * it inside the cwd, so this is a backstop against a renderer that names
 * something else — and a lexical check works in a test harness whose cwds do
 * not exist on disk. The prefix comparison needs no case folding because both
 * sides are built from the *same* `cwd` string; only the relative tail is the
 * renderer's.
 */
function resolveProjectFile(cwd: string, target: WireEditorTarget): { path: string; line?: number } {
  const root = path.resolve(cwd)
  const absolute = path.resolve(root, target.path)
  if (absolute !== root && !absolute.startsWith(root + path.sep)) {
    throw new Error(`Refusing to open "${target.path}": it is outside the project`)
  }
  return { path: absolute, ...(target.line === undefined ? {} : { line: target.line }) }
}

// --- the host ----------------------------------------------------------------

export class ShellHost<
  P extends ShellLaneProject = RuntimeHost,
  PaneT extends PaneLike = SessionPane,
  W extends ShellLaneWorkspace<PaneT> = ShellLaneWorkspace<PaneT>,
> {
  private readonly channel: RuntimeChannel
  /** Insertion-ordered: the lane list the renderer sees is the order lanes were opened. */
  private readonly lanes = new Map<string, LaneEntry<P, W, PaneT>>()
  /** Project root -> the pending `coordination-threads` push for it. */
  private readonly threadBroadcasts = new Map<string, ReturnType<typeof setTimeout>>()
  private disposed = false
  private readonly usageScanner = new UsageScanner()

  constructor(private readonly deps: ShellHostDeps<P, PaneT, W>) {
    this.channel = deps.mux.lane(SHELL_LANE)
    this.channel.onMessage(this.handleMessage)
    // No `onClose`: a dead shell lane means the renderer is gone, and window
    // teardown — not this class — owns what happens then.
  }

  // --- lane lifecycle ------------------------------------------------------

  /**
   * Resolves or creates a pane, then attaches it to a lane.
   *
   * The same choreography `open-pane` used to do inline in `main.ts`: an
   * existing pane for the session is reused (one pane per session, or two
   * `AgentLoop`s append to one JSONL); a known session id resolves through the
   * store; anything else mints an in-memory draft. A pane that already has a
   * lane is not re-attached — the caller gets the existing key and an
   * activation request, which is the single-window equivalent of focusing.
   */
  async openLane(
    entry: ProjectEntry<P, W>,
    options: { sessionId?: string; title?: string; activate?: boolean } = {},
  ): Promise<WireShellOpenSessionResult> {
    const activate = options.activate ?? true
    if (options.sessionId !== undefined) {
      const existing = entry.workspace.paneForSession(options.sessionId)
      if (existing) return this.registerLane(entry, existing, activate)
      const session = await entry.project.store.resolve(options.sessionId)
      if (!session) throw new Error(`Session not found: ${options.sessionId}`)
      return this.registerLane(entry, await entry.workspace.open(session), activate)
    }
    const scope = await entry.project.openScope(entry.project.store.createDraft(options.title))
    return this.registerLane(entry, entry.workspace.adopt(scope, {}), activate)
  }

  /**
   * The `onPaneOpened` hand-off: a `SessionHost` has already created the pane
   * in its workspace (an `open-pane` from some lane's renderer), and this
   * window needs the lane for it. Deduplicates on pane identity, so a second
   * arrival for the same pane is an activation, never a second occupant.
   */
  attachPane(entry: ProjectEntry<P, W>, pane: PaneT): string {
    return this.registerLane(entry, pane).lane
  }

  /**
   * The single exit path for every way a lane dies — a renderer's `close-pane`
   * arriving through `onPaneClosed`, the OS closing the window, a failed
   * `loadFile`, app teardown. Drops the map entry *first*, so re-entrant calls
   * find nothing and every path below runs at most once.
   *
   * Order is fixed and load-bearing: dispose the occupant (unsubscribe before
   * anything it could observe), close the lane (the control frame that
   * releases the renderer's pending requests — `SessionHost.dispose()` does
   * not touch the channel), then run the pane's own four-step close. After the
   * topology update, a project with no lanes left is shut down: `shutdown()`
   * is the only call that stops background tasks and MCP clients, and a
   * project nothing on screen can reach is a set of orphaned child processes.
   *
   * `deferExit` hands that tail to the caller — the one caller that is about to
   * put a lane *back* (`deleteSession`). An explicit flag rather than a check on
   * `reason`: `reason` is a free string for logs and `shutdown()`, and making it
   * carry control flow turns every future reason into a semantic branch. **A
   * caller that defers owns what happens next**, including calling
   * `settleAfterLastLane` itself if it cannot replace the lane after all.
   */
  detachLane(key: string, reason: string, options: { deferExit?: boolean } = {}): void {
    const entry = this.lanes.get(key)
    if (!entry) return
    this.lanes.delete(key)
    entry.occupant.dispose()
    // After the occupant, before the channel: a tab belongs to this lane, so it
    // dies with it — but only once the session that could still be driving it
    // has stopped. The renderer's pane budget does reach this path, which is
    // why it never evicts a lane that owns tabs.
    this.deps.browser?.closeLane(key)
    this.deps.mux.closeLane(key)
    entry.project.workspace.close(entry.pane)
    this.broadcastLanes()
    if (this.deps.isQuitting?.()) return
    if (options.deferExit) return
    this.settleAfterLastLane(entry.project, reason)
  }

  /**
   * What a detach means for the project and for the window: the last lane of a
   * project shuts it down, and the last lane of the window is the single-window
   * equivalent of "the last window closed".
   *
   * Split out of `detachLane` so a caller that defers it can run it later — or
   * not at all, when the lane has been replaced.
   */
  private settleAfterLastLane(project: ProjectEntry<P, W>, reason: string): void {
    const projectStillOpen = [...this.lanes.values()].some((held) => held.project === project)
    if (!projectStillOpen) void this.deps.directory.closeProject(project, reason)
    if (this.lanes.size === 0) this.deps.onAllLanesClosed?.(reason)
  }

  /**
   * `onPaneClosed` arrives with the pane's *current* session id — which moves
   * under `/clear` and `/resume`. The lane key does not, so the scan reads
   * through `pane.getSession()` exactly like the window map it replaced.
   */
  detachLaneBySessionId(paneId: string, reason: string): void {
    const lane = this.laneForSessionId(paneId)
    if (lane === undefined) return
    this.detachLane(lane, reason)
  }

  laneForSessionId(paneId: string): string | undefined {
    for (const [lane, entry] of this.lanes) {
      if (entry.pane.getSession().id === paneId) return lane
    }
    return undefined
  }

  laneKeys(): string[] {
    return [...this.lanes.keys()]
  }

  /** The live lane of a session, as coordination drives it. Scans like {@link laneForSessionId}. */
  laneControlFor(sessionId: string): CoordinationLaneControl | undefined {
    const lane = this.laneForSessionId(sessionId)
    return lane === undefined ? undefined : this.lanes.get(lane)?.occupant.coordination
  }

  /**
   * Opens (or finds) a session's lane by project `cwd` — the coordinator's way
   * in, which knows a directory rather than a wire root. A closed project is
   * bootstrapped over that very session, so no throwaway draft pane is minted.
   */
  async openLaneForCwd(cwd: string, sessionId: string, activate: boolean): Promise<CoordinationLaneControl> {
    const entry = this.deps.directory.get(cwd) ?? (await this.deps.ensureProject?.(cwd, { sessionId }))
    if (!entry) throw new Error(`No project is open at ${cwd}`)
    await this.openLane(entry, { sessionId, activate })
    const control = this.laneControlFor(sessionId)
    if (!control) throw new Error(`The lane for session ${sessionId} cannot be coordinated.`)
    return control
  }

  // --- topology ------------------------------------------------------------

  /**
   * The cwd of a *known but not open* project, by the wire's normalized root
   * key. `undefined` when the root names nothing the registry ever saw.
   */
  private async knownCwdForRoot(projectRoot: string): Promise<string | undefined> {
    if (!this.deps.knownProjects) return undefined
    const known = await this.deps.knownProjects()
    return known.find((cwd) => projectRootKey(cwd) === projectRoot)
  }

  private refuseGlobalCoordinator(cwd: string): void {
    if (isGlobalWorkspaceRoot(cwd)) throw new Error('主目录是「最近」工作区，不能作为协调项目；请选择一个具体的项目文件夹。')
  }

  /** The open project at `cwd`, or a newly bootstrapped one along with its draft session. */
  private async ensureFresh(cwd: string): Promise<{ entry: ProjectEntry<P, W>; session?: SessionMeta }> {
    const open = this.deps.directory.get(cwd)
    if (open) return { entry: open }
    if (this.deps.ensureProjectFresh) return this.deps.ensureProjectFresh(cwd)
    if (this.deps.ensureProject) return { entry: await this.deps.ensureProject(cwd) }
    throw new Error(`No project is open at ${cwd}`)
  }

  /**
   * Opens the project's coordinator on the active lane. A project bootstrapped
   * for it has a lane-less draft pane nobody will open, so that pane is dropped
   * (as `openProject` avoids it) and a failure shuts the project again.
   */
  private async openCoordinator(cwd: string, options: { opening?: boolean } = {}): Promise<WireShellOpenCoordinatorResult> {
    const coordination = this.requireCoordination()
    this.refuseGlobalCoordinator(cwd)
    const { entry, session } = await this.ensureFresh(cwd)
    try {
      const sessionId = await coordination.ensureCoordinator(entry.cwd, options)
      const opened = await this.openLane(entry, { sessionId, activate: true })
      const draft = session === undefined ? undefined : entry.workspace.paneForSession(session.id)
      if (draft) entry.workspace.close(draft)
      return opened
    } catch (error) {
      if (session !== undefined) this.settleAfterLastLane(entry, 'coordinator-failed')
      throw error
    }
  }

  /**
   * The real directory a wire root names — open project, registry entry, or the
   * global workspace — without opening anything.
   *
   * **The home branch is the load-bearing one.** The home directory is
   * deliberately not a registry member (it is the implicit global workspace), so
   * `knownCwdForRoot` can never answer for it, while `listSessions` lists 「最近」
   * unconditionally. Every root-keyed command therefore has to resolve home
   * *itself*: without this, deleting or renaming a 「最近」 session — or opening
   * its settings — failed with "No project is open at …" the moment the global
   * runtime's last lane closed, which nothing could reopen.
   *
   * Any new root-keyed command goes through here or {@link ensureEntryForRoot},
   * never through `knownCwdForRoot` alone.
   */
  private async cwdForRoot(projectRoot: string): Promise<string | undefined> {
    const open = this.deps.directory.get(projectRoot)
    if (open) return open.cwd
    return (await this.knownCwdForRoot(projectRoot))
      ?? (projectRootKey(homedir()) === projectRoot ? homedir() : undefined)
  }

  /**
   * The same resolution for the commands that need a *live* project (settings
   * read the config, the skills service and the MCP clients off it), bootstrapping
   * on demand when the root is known but closed.
   */
  private async ensureEntryForRoot(
    projectRoot: string,
    options: { sessionId?: string } = {},
  ): Promise<ProjectEntry<P, W>> {
    const open = this.deps.directory.get(projectRoot)
    if (open) return open
    const cwd = await this.cwdForRoot(projectRoot)
    if (cwd !== undefined && this.deps.ensureProject) {
      return this.deps.ensureProject(cwd, options)
    }
    throw new Error(`No project is open at ${projectRoot}`)
  }

  /**
   * Which project an `open-session` lands on.
   *
   * Three cases, in order: a root that is already open; a root that resolves
   * through {@link cwdForRoot} (bootstrapped on demand, over the session the
   * command named, so the bootstrap pane *is* the pane being asked for); and no
   * root at all — the first open project, else the global workspace, because
   * "new session" with nothing open is the global workspace's most ordinary
   * entry.
   */
  private async resolveProjectEntry(
    projectRoot: string | undefined,
    sessionId: string | undefined,
  ): Promise<ProjectEntry<P, W>> {
    if (projectRoot !== undefined) {
      return this.ensureEntryForRoot(projectRoot, sessionId !== undefined ? { sessionId } : {})
    }
    const first = this.deps.directory.entries()[0]
    if (first) return first
    if (this.deps.ensureProject) return this.deps.ensureProject(homedir())
    throw new Error('No project is open.')
  }

  /**
   * The whole lane topology, across every project. The same projection every
   * `SessionHost`'s `describePanes` answers with, extended with the lane key —
   * so the renderer's tab bar and the hosts' pane lists can never disagree
   * about which panes exist.
   */
  describeLanes(): WireLaneInfo[] {
    const out: WireLaneInfo[] = []
    for (const [lane, entry] of this.lanes) out.push(this.describeOne(lane, entry))
    return out
  }

  /** Pushes the current topology on the shell lane. Fired on every change. */
  broadcastLanes(): void {
    this.post({ type: 'lanes', lanes: this.describeLanes() })
  }

  /**
   * Asks the renderer to make a lane active. Activation is a renderer concern
   * in a single window; all the main process can do is ask, and the renderer
   * is free to already be there.
   */
  requestActivate(lane: string): void {
    this.post({ type: 'activate', lane })
  }

  // --- commands ------------------------------------------------------------

  private handleMessage = (message: unknown): void => {
    const parsed = parseShellCommand(message)
    if (!parsed.ok) {
      if (parsed.id !== undefined) {
        this.post({ type: 'fail', id: parsed.id, message: parsed.message })
      }
      return
    }
    void this.runCommand(parsed.command)
  }

  private async runCommand(command: ShellCommand): Promise<void> {
    try {
      const result = await this.execute(command)
      this.post({ type: 'reply', id: command.id, result })
    } catch (error) {
      this.post({
        type: 'fail',
        id: command.id,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** Exhaustive by `assertNever`: an unhandled variant must not compile. */
  private async execute(command: ShellCommand): Promise<unknown> {
    switch (command.type) {
      case 'panes':
        return { lanes: this.describeLanes() } satisfies WireShellPanesResult
      case 'open-session': {
        const entry = await this.resolveProjectEntry(command.projectRoot, command.sessionId)
        return this.openLane(entry, { sessionId: command.sessionId, title: command.title })
      }
      case 'open-project': {
        // Missing callback rejects rather than answering `ok` — a focus that
        // silently did nothing is indistinguishable from success on the wire.
        if (!this.deps.onOpenProject) throw new Error('The shell cannot open projects.')
        this.deps.onOpenProject(command.path)
        return { ok: true } satisfies WireShellOpenProjectResult
      }
      case 'remove-project':
        return this.removeProject(command.projectRoot)
      case 'list-sessions':
        return this.listSessions()
      case 'usage-stats':
        return this.usageStats()
      case 'delete-session':
        return this.deleteSession(command.projectRoot, command.sessionId)
      case 'get-settings':
        return this.getSettings(command.projectRoot)
      case 'settings-change':
        return this.applySettingsChange(command.projectRoot, command.change)
      case 'rename-session':
        return this.renameSession(command.projectRoot, command.sessionId, command.title)
      case 'open-in-editor':
        return this.openInEditor(command.projectRoot, command.target)
      case 'set-window-theme': {
        // Unlike `open-project` / `open-in-editor`, a missing callback answers
        // `ok` rather than rejecting: the overlay is chrome, a shell without one
        // (every non-Windows build, and the test host) is not broken, and a
        // rejection here would put a native-chrome detail in the transcript.
        this.deps.onWindowTheme?.(command.theme)
        return { ok: true } satisfies WireShellSetWindowThemeResult
      }
      case 'pick-images': {
        if (!this.deps.onPickImages) throw new Error('The shell cannot open an image picker.')
        // Anchor only; an unknown or closed root opens the dialog unanchored
        // rather than failing — the choice of directory never changes what the
        // answer means (the per-pane host import re-resolves the project).
        const cwd = command.projectRoot === undefined ? undefined : await this.cwdForRoot(command.projectRoot)
        const paths = await this.deps.onPickImages({ ...(cwd !== undefined ? { defaultPath: cwd } : {}) })
        return { ok: true, paths: paths ?? [] } satisfies WireShellPickImagesResult
      }
      case 'browser-create-tab': {
        const browser = this.requireBrowser()
        // The lane is checked here rather than in the schema: a tab on a lane
        // that has already closed would never be drawn and would never be
        // cleaned up, because `closeLane` already ran for it.
        if (!this.lanes.has(command.lane)) throw new Error(`No such lane: ${command.lane}`)
        return {
          tabId: browser.createTab(command.lane, command.url),
        } satisfies WireShellBrowserCreateTabResult
      }
      case 'browser-close-tab':
        this.requireBrowser().closeTab(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-navigate':
        this.requireBrowser().navigate(command.tabId, command.url)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-go-back':
        this.requireBrowser().goBack(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-go-forward':
        this.requireBrowser().goForward(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-reload':
        this.requireBrowser().reload(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-take-over':
        this.requireBrowser().takeOver(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-release':
        this.requireBrowser().releaseTab(command.tabId)
        return { ok: true } satisfies WireShellBrowserOkResult
      case 'browser-set-bounds': {
        // The one command whose reply nobody awaits: it rides every resize
        // frame. A shell without a browser drops it silently rather than
        // rejecting — there is no user-visible act to report, and a geometry
        // push is superseded by the next one anyway.
        this.deps.browser?.setBounds(command.tabId, command.rect, command.visible)
        return { ok: true } satisfies WireShellBrowserOkResult
      }
      case 'open-coordinator':
        return this.openCoordinator(await this.requireCwdForRoot(command.projectRoot))
      case 'new-coordinator-project': {
        const { onPickDirectory } = this.deps
        if (command.path === undefined && !onPickDirectory) throw new Error('The shell cannot open projects.')
        const target = command.path ?? (await onPickDirectory!({ title: '新建项目', buttonLabel: '新建' }))
        if (target === undefined) return { cancelled: true } satisfies WireShellNewCoordinatorProjectResult
        return this.openCoordinator(target, { opening: true })
      }
      case 'coordination-stop-all': {
        const coordination = this.requireCoordination()
        await coordination.stopAll(await this.requireCwdForRoot(command.projectRoot))
        return { ok: true } satisfies WireShellCoordinationOkResult
      }
      case 'thread-merges': {
        const coordination = this.requireCoordination()
        const merges = await coordination.pendingMerges(await this.requireCwdForRoot(command.projectRoot))
        return { merges } satisfies WireShellThreadMergesResult
      }
      case 'thread-merge': {
        const coordination = this.requireCoordination()
        const result = await coordination.mergeThread(await this.requireCwdForRoot(command.projectRoot), command.threadId)
        return {
          kind: result.kind,
          ...(result.message !== undefined ? { message: result.message } : {}),
        } satisfies WireShellThreadMergeResult
      }
      case 'thread-merge-dismiss': {
        const coordination = this.requireCoordination()
        await coordination.dismissMerge(await this.requireCwdForRoot(command.projectRoot), command.threadId)
        return { ok: true } satisfies WireShellCoordinationOkResult
      }
      case 'thread-merge-resolve': {
        // Live project: the message may have to cold-open the thread's lane.
        const coordination = this.requireCoordination()
        const entry = await this.ensureEntryForRoot(command.projectRoot)
        await coordination.resolveConflictViaThread(entry.cwd, command.threadId)
        return { ok: true } satisfies WireShellCoordinationOkResult
      }
      case 'coordination-threads': {
        const coordination = this.requireCoordination()
        const cwd = await this.requireCwdForRoot(command.projectRoot)
        return this.coordinationThreads(coordination, cwd, command.projectRoot)
      }
      case 'thread-stop': {
        const coordination = this.requireCoordination()
        await coordination.stopThreadById(await this.requireCwdForRoot(command.projectRoot), command.threadId)
        return { ok: true } satisfies WireShellCoordinationOkResult
      }
      case 'thread-resolve': {
        const coordination = this.requireCoordination()
        await coordination.resolveThreadById(await this.requireCwdForRoot(command.projectRoot), command.threadId)
        return { ok: true } satisfies WireShellCoordinationOkResult
      }
      case 'thread-transcript': {
        const coordination = this.requireCoordination()
        const cwd = await this.requireCwdForRoot(command.projectRoot)
        const thread = (await coordination.threadInfos(cwd)).threads.find((info) => info.threadId === command.threadId)
        if (!thread) throw new Error(`No thread ${command.threadId} in ${command.projectRoot}`)
        const read = await new SessionStore(cwd).loadRecordsIfChanged(thread.sessionId, command.since)
        if (read.records === undefined) return { unchanged: true, token: read.token } satisfies WireShellThreadTranscriptResult
        const toolDisplays = projectToolDisplays(read.records)
        return {
          unchanged: false,
          token: read.token,
          records: read.records,
          ...(toolDisplays ? { toolDisplays } : {}),
        } satisfies WireShellThreadTranscriptResult
      }
      default:
        return assertNever(command)
    }
  }

  private async coordinationThreads(
    coordination: ShellCoordination,
    cwd: string,
    projectRoot: string,
  ): Promise<WireCoordinationThreads> {
    const table = await coordination.threadInfos(cwd)
    const state: WireCoordinationThreads = { projectRoot, threads: [] }
    if (table.coordinatorSessionId !== undefined) state.coordinatorSessionId = table.coordinatorSessionId
    if (table.openingThreadId !== undefined) state.openingThreadId = table.openingThreadId
    if (table.started === true) state.started = true
    for (const thread of table.threads) {
      const wire = toWireThreadInfo(thread)
      if (wire) state.threads.push(wire)
    }
    return state
  }

  private requireCoordination(): ShellCoordination {
    const coordination = this.deps.coordination
    if (!coordination) throw new Error('The shell has no project coordination.')
    return coordination
  }

  /**
   * A root-keyed command that only reads or writes the thread table and git:
   * no runtime needed, so a closed project is not bootstrapped for it.
   */
  private async requireCwdForRoot(projectRoot: string): Promise<string> {
    const cwd = await this.cwdForRoot(projectRoot)
    if (cwd === undefined) throw new Error(`No project is known at ${projectRoot}`)
    return cwd
  }

  private requireBrowser(): NonNullable<ShellHostDeps<P, PaneT, W>['browser']> {
    const browser = this.deps.browser
    if (!browser) throw new Error('The shell has no browser.')
    return browser
  }

  /**
   * Every *added* project's session history, in the order the registry keeps
   * (the order they were added, first added first), with the global workspace's
   * own sessions last — the sidebar's whole world, not just what is open right
   * now. The registry order is stable across opens, which is what keeps a group
   * from moving when one of its sessions is created; see `recentProjects.ts`.
   *
   * Two sources per root: an open project reads through its live store, a
   * registered-but-closed one through the read-only index peek (no runtime, no
   * lock). Open projects the registry somehow missed are appended defensively,
   * because a project on screen must be a project with history. `Promise.all`
   * because every read is independent — locks, `readdir`s and tiny JSON parses.
   *
   * The sessions are projected field by field: `SessionMeta` carries an
   * unbounded array (`checkpoints`) that no row reads.
   */
  private async knownRoots(): Promise<string[]> {
    const roots: string[] = []
    const addRoot = (cwd: string): void => {
      const key = projectRootKey(cwd)
      if (!roots.some((existing) => projectRootKey(existing) === key)) roots.push(cwd)
    }
    if (this.deps.knownProjects) {
      for (const cwd of await this.deps.knownProjects()) addRoot(cwd)
    }
    for (const entry of this.deps.directory.entries()) addRoot(entry.cwd)
    // The global workspace: always known, always listed, anchored last — a
    // project is where work belongs; the fallback is where it lands when
    // nothing is opened.
    addRoot(homedir())
    return roots
  }

  private usageStats(): Promise<WireShellUsageStatsResult> {
    return this.knownRoots().then((roots) => this.usageScanner.scan(roots))
  }

  private async listSessions(): Promise<WireShellSessionsResult> {
    const roots = await this.knownRoots()
    const projects = await Promise.all(
      roots.map(async (cwd) => {
        const entry = this.deps.directory.get(cwd)
        const sessions = entry ? await entry.project.store.list() : await peekSessions(cwd)
        return {
          cwd,
          open: entry !== undefined,
          projectRoot: projectRootKey(cwd),
          projectName: projectDisplayName(cwd),
          projectPath: cwd,
          isGlobal: isGlobalWorkspaceRoot(cwd),
          sessions: sessions.map(summarize),
        }
      }),
    )
    return {
      // Carried even when the filter below drops the global group: the renderer
      // must be able to name the home workspace without matching its display
      // name, and「不在项目中工作」asks for it precisely when it has no row.
      globalRoot: projectRootKey(homedir()),
      projects: projects
        // Every *added* project is listed unconditionally, history or not: the
        // registry is what the sidebar draws a project row from, so a project
        // whose sessions were all deleted stays reachable and only
        // `remove-project` takes it off screen. The global workspace is the
        // exception — it is implicit rather than added, so it earns its row by
        // being open or by having sessions.
        .filter((project) => !project.isGlobal || project.open || project.sessions.length > 0)
        .map(({ cwd: _cwd, open: _open, ...project }) => project),
    } satisfies WireShellSessionsResult
  }

  /**
   * Removes a project: its lanes go, its runtime shuts down, the registry entry
   * is dropped, **and its whole session history is deleted from disk**.
   *
   * The deletion is what the menu item now promises, and it is the reason the
   * shutdown is awaited rather than fired off: `settleAfterLastLane` starts the
   * close with a bare `void`, and a runtime still draining is a runtime that can
   * write `index.json` back after the sweep has been through it.
   *
   * The sessions go one at a time through `deleteSessionArtifacts`, the same
   * path a single `delete-session` takes — that function owns *what* a session
   * leaves behind (JSONL, file history, subagent transcripts),
   * and duplicating the list here is how the other three got leaked once before.
   * Once every session is gone, the rest of the project's data dir (index,
   * plans) goes with it. The project's own `.myagent/` is never touched:
   * settings, skills and rules are not history.
   *
   * The lane teardown borrows `deleteSession`'s deferral (below): detaching the
   * window's *last* lane fires `onAllLanesClosed`, which quits the app off
   * darwin. "Remove this project" is not "I am done with this window", so the
   * last-lane case defers the exit and lands on a fresh global workspace draft
   * instead — the same answer `deleteSession` gives, and the reason `deferExit`
   * is a flag rather than a check on `reason`.
   */
  private async removeProject(projectRoot: string): Promise<WireShellRemoveProjectResult> {
    const entry = this.deps.directory.get(projectRoot)
    const cwd = await this.cwdForRoot(projectRoot)
    if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
    // The global workspace is not a registry member, so there is nothing to
    // forget and nowhere for its sessions to go. Rejecting is the honest answer.
    if (isGlobalWorkspaceRoot(cwd)) throw new Error('The global workspace cannot be removed.')

    const lanes = [...this.lanes.entries()]
      .filter(([, held]) => held.project === entry)
      .map(([lane]) => lane)
    // True when this project holds every lane in the window: the exit has to be
    // deferred and a replacement lane opened, or the app quits under the user.
    const replacing = lanes.length > 0 && lanes.length === this.lanes.size
    for (const lane of lanes) this.detachLane(lane, 'project-removed', { deferExit: replacing })
    // Awaited whether the exit was deferred or not: `deferExit` skips
    // `settleAfterLastLane` entirely, and the close that path *does* start is
    // fire-and-forget. `closeProject` is idempotent and hands back the in-flight
    // teardown, so this is "wait for whichever of us started it".
    if (entry) await this.deps.directory.closeProject(entry, 'project-removed')

    await this.deps.onForgetProject?.(cwd)
    const failures = await this.deleteProjectSessions(cwd)

    if (replacing) {
      try {
        if (!this.deps.ensureProject) throw new Error('The shell cannot open the global workspace.')
        await this.openLane(await this.deps.ensureProject(homedir()))
      } catch (error) {
        // The replacement is what the deferral was for. Without it the window
        // sits with zero lanes and the "nothing left" moment never fires, so
        // hand it over explicitly before reporting the failure.
        this.deps.onAllLanesClosed?.('project-removed')
        throw error
      }
    }
    // Reported last, and only after the window is whole again: the project is
    // already off the sidebar, so this is "these files are still there", not a
    // failed removal the renderer should put the row back for.
    if (failures.length > 0) {
      throw new Error(`项目已移除，但有 ${failures.length} 个会话没能删干净：${failures.join('；')}`)
    }
    return { ok: true } satisfies WireShellRemoveProjectResult
  }

  /**
   * Every session under one root, deleted through the single-session path.
   *
   * Per session `try`/`catch`: one locked file must not leave the rest of the
   * history behind, and the registry entry is already gone by the time this
   * runs — there is no "put it back" to fall back to.
   */
  private async deleteProjectSessions(cwd: string): Promise<string[]> {
    const failures: string[] = []
    try {
      const store = new SessionStore(cwd)
      await store.init()
      for (const session of await store.list()) {
        try {
          await deleteSessionArtifacts(cwd, store, session.id)
        } catch (error) {
          failures.push(`${session.id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length === 0) await rm(getProjectDataDir(cwd), { recursive: true, force: true })
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
    return failures
  }

  /**
   * Deletes a session, lane and all. The order is fixed and every step of it is
   * load-bearing:
   *
   *  1. The entry's `store` and `cwd` are captured **before** anything closes.
   *     Deleting the session behind a project's last lane runs `closeProject`,
   *     after which `directory.get()` no longer finds it — reading them later
   *     would work until the day someone deletes their only open session.
   *  2. The id is **resolved** first. `SessionStore.delete` accepts a prefix but
   *     `deleteSessionArtifacts` does not, so passing the raw wire string
   *     through would delete the right session and the wrong file history. An
   *     id that resolves to nothing is swept as given: a delete interrupted
   *     after the store step leaves artifacts only a retry can reach.
   *  3. The lane goes before the files. `detachLane` is the single exit path,
   *     and a pane still holding a session whose JSONL just vanished is a ghost
   *     row whose next append recreates the file.
   *  4. `deleteSessionArtifacts` owns *what* gets deleted — store files, file
   *     history, subagent transcripts. This method deliberately
   *     does not enumerate them: it did once, with two of the four, and the
   *     other two leaked.
   *
   * No topology broadcast at the end. Deleting an *open* session already
   * announced one from `detachLane`; deleting a closed one changes no lane, and
   * `ShellClient` swallows a re-announcement of an identical list by design. The
   * renderer refreshes its history off this command's own reply instead — which
   * is also the only signal that would work for a closed session.
   *
   * The fifth step is conditional: deleting the session behind the window's
   * *only* lane used to run `onAllLanesClosed`, which quits the app off darwin —
   * "clean up this history" and "I am done with this window" were the same event
   * in `detachLane`. So that one case defers the tail and opens a draft instead:
   * an empty window is far closer to what was asked for, and a fresh draft is
   * what "new session" has always meant here. The draft is created **after**
   * `deleteSessionArtifacts`, so the sweep only ever faces the id being deleted.
   * A project's last lane in a *multi-project* window still shuts that project
   * down, exactly as closing its last pane does.
   */
  private async deleteSession(
    projectRoot: string,
    sessionId: string,
  ): Promise<WireShellDeleteSessionResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) {
      // A closed project's history is still deletable — through a transient
      // store, without bootstrapping a runtime for a deletion. No lane can
      // exist for a project the directory does not hold, so this is purely a
      // filesystem deletion. `cwdForRoot`, not `knownCwdForRoot`: 「最近」's rows
      // are on screen whether or not the global runtime is up.
      const cwd = await this.cwdForRoot(projectRoot)
      if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
      const store = new SessionStore(cwd)
      const session = await store.resolve(sessionId)
      await deleteSessionArtifacts(cwd, store, session?.id ?? sessionId)
      return { ok: true } satisfies WireShellDeleteSessionResult
    }
    const { store } = entry.project
    const { cwd } = entry

    // A session already gone from the store may still have left artifacts —
    // a coordination pointer naming it, say — so its id is swept all the same.
    const session = (await store.resolve(sessionId)) ?? { id: sessionId }

    // A coordinator takes its threads with it, so their lanes go too.
    const ids = [...(await coordinatedThreadSessionIds(cwd, session.id)), session.id]
    const lanes = ids.flatMap((id) => this.laneForSessionId(id) ?? [])
    // The window's last lanes: the project must stay open, because the draft
    // below is going to be opened on it.
    const replacing = lanes.length > 0 && lanes.length === this.lanes.size
    for (const lane of lanes) this.detachLane(lane, 'session-deleted', { deferExit: replacing })

    await deleteSessionArtifacts(cwd, store, session.id)

    if (replacing) {
      try {
        // No `sessionId`: a draft, and `registerLane` already broadcasts and
        // asks the renderer to activate it.
        await this.openLane(entry)
      } catch (error) {
        // The replacement is what the deferral was for. Without it the project
        // would sit in the directory with no lanes and no shutdown — orphaned
        // background tasks and MCP clients nothing on screen can reach.
        this.settleAfterLastLane(entry, 'session-deleted')
        throw error
      }
    }
    return { ok: true } satisfies WireShellDeleteSessionResult
  }

  // --- settings ------------------------------------------------------------

  /**
   * Runs `use` against a live project, bootstrapping the root on demand and
   * shutting it down again if this call is the only reason it exists.
   *
   * The settings screen holds a `projectRoot` from whenever it last loaded and
   * has no visible picker while one project is open, so the root it names is
   * routinely a project whose last lane has since closed — most often 「最近」,
   * which nothing else can reopen. Bootstrapping is the honest answer (the edit
   * lands on the project the screen is showing), but a runtime with no lane is
   * a leak: nothing would ever close its MCP clients or background tasks. So the
   * transient case is closed here, and a project that was already open — or that
   * a lane picked up while this ran — is left alone.
   */
  private async withProjectEntry<T>(
    projectRoot: string,
    use: (entry: ProjectEntry<P, W>) => Promise<T>,
  ): Promise<T> {
    const existed = this.deps.directory.get(projectRoot) !== undefined
    const entry = await this.ensureEntryForRoot(projectRoot)
    try {
      return await use(entry)
    } finally {
      const held = [...this.lanes.values()].some((lane) => lane.project === entry)
      if (!existed && !held) await this.deps.directory.closeProject(entry, 'settings-transient')
    }
  }

  /** The settings read model, plus the project list the screen's selector needs. */
  private async getSettings(projectRoot?: string): Promise<WireShellSettingsResult> {
    const projects = (): WireShellSettingsResult['projects'] =>
      this.deps.directory.entries().map((open) => ({
        projectRoot: open.root,
        projectName: projectDisplayName(open.cwd),
      }))
    if (projectRoot !== undefined) {
      return this.withProjectEntry(projectRoot, async (entry) => ({
        settings: await this.describeSettings(entry),
        // Read inside, while the transient project is still open: the screen's
        // selector must be able to name the project it is showing.
        projects: projects(),
      } satisfies WireShellSettingsResult))
    }
    const entry = this.deps.directory.entries()[0]
    if (!entry) throw new Error('No project is open.')
    return {
      settings: await this.describeSettings(entry),
      projects: projects(),
    } satisfies WireShellSettingsResult
  }

  /**
   * One settings edit. The order here is fixed and four steps of it are not
   * obvious:
   *
   *  - **`save()` before `reloadSettings()`.** `reloadSettings` ends in
   *    `config.load(settings)` (`bootstrap.ts`), which re-reads the config
   *    layers from disk. An in-memory mutation that has not been saved is
   *    *destroyed* by it. Swapping these two lines silently discards the user's
   *    edit while answering with a snapshot that looks right until the next pull.
   *  - **`save()` only when the config was mutated.** `save()` writes the whole
   *    merged `Config`, so calling it for a permissions or MCP edit would copy
   *    every settings-declared model and endpoint into `config.json` as a side
   *    effect of adding one rule.
   *  - **`reloadSettings()` once per project, not per lane.** It is a
   *    project-level call — N lanes over one project would re-read and
   *    re-validate the settings files N times for one edit.
   *  - **`afterReload` after it.** An MCP reconnect reads the settings the
   *    runtime now holds, so it has to run once the reload has replaced them.
   *
   * The fan-out is per variant rather than unconditional: permission rules and
   * the config layer are read live, and rebuilding a runtime for them would
   * throw away the prompt cache for nothing. `needsRuntimeRebuild` is still not
   * consulted — see `LaneOccupant.refreshAfterConfigChange`.
   */
  private async applySettingsChange(
    projectRoot: string,
    change: SettingsChange,
  ): Promise<WireShellSettingsChangeResult> {
    return this.withProjectEntry(projectRoot, (entry) => this.applySettingsChangeTo(entry, change))
  }

  private async applySettingsChangeTo(
    entry: ProjectEntry<P, W>,
    change: SettingsChange,
  ): Promise<WireShellSettingsChangeResult> {
    // Before anything is mutated: a model a turn is *running on* cannot be
    // deleted. Every other reference — the default model, a routing role, an
    // endpoint's models — now repairs itself inside `ConfigService`, so this is
    // the last refusal left, and it is one only the shell can make.
    this.refuseIfModelIsInFlight(entry, change)

    // `ConfigService` still owns the checks it can make on its own (a rename
    // onto an existing key, a context number that cannot mean anything).
    // Letting it throw keeps them in one place — and nothing has been saved
    // yet, so a rejection leaves the config as it was.
    const effect = await applySettingsEffect(entry, change, this.deps.onPickDirectory)
    if (effect.saveConfig) await entry.project.config.save()
    // Provider configuration is global. A project opened before first-time
    // setup must see the same saved models as the project editing settings.
    // The user-wide instructions are global too: every open project re-reads them.
    const affected =
      change.scope === 'provider' || change.scope === 'personalization'
        ? this.deps.directory.entries()
        : [entry]
    for (const target of affected) await target.project.reloadSettings()
    if (effect.afterReload) await effect.afterReload()

    let rebuiltLanes = 0
    if (effect.rebuild) {
      for (const held of this.lanes.values()) {
        if (!affected.includes(held.project)) continue
        held.occupant.refreshAfterConfigChange({ rebuild: true, scope: effect.scope })
        rebuiltLanes += 1
      }
    }
    return {
      settings: await this.describeSettings(entry),
      rebuiltLanes,
    } satisfies WireShellSettingsChangeResult
  }

  /**
   * Refuses a removal that would pull the model out from under a running turn.
   *
   * Deleting a model is otherwise always allowed now: `ConfigService` re-points
   * whatever named it and `removeEndpoint` takes that endpoint's models with it.
   * A turn already streaming is the exception — it holds a provider built from
   * that model, and taking it away mid-flight fails the turn rather than the
   * click. Refusing *here*, before `applySettingsEffect`, is what keeps the
   * config untouched when it happens.
   */
  private refuseIfModelIsInFlight(entry: ProjectEntry<P, W>, change: SettingsChange): void {
    const doomed =
      change.kind === 'remove-model'
        ? [change.key]
        : change.kind === 'remove-endpoint'
          ? entry.project.config.modelsForEndpoint(change.name)
          : []
    if (doomed.length === 0) return
    for (const held of this.lanes.values()) {
      const running = held.occupant.activeModelKey()
      if (running === undefined || !doomed.includes(running)) continue
      const title = held.pane.getSession().title ?? held.pane.getSession().id
      throw new Error(`模型 ${running} 上还有会话「${title}」在跑，先中断它再删。`)
    }
  }

  /**
   * Retitles a session, refreshing its lane if one is open.
   *
   * The id is resolved first for the same reason `delete-session` does it: the
   * store takes a prefix, but `laneForSessionId` compares whole ids.
   *
   * Unlike `delete-session` this *does* broadcast. `sessionTitle` is a
   * `WireLaneInfo` field and part of `ShellClient`'s list comparison, so the
   * topology genuinely differs and the swallow-identical-lists rule does not
   * apply.
   */
  private async renameSession(
    projectRoot: string,
    sessionId: string,
    title: string,
  ): Promise<WireShellRenameSessionResult> {
    const entry = this.deps.directory.get(projectRoot)
    if (!entry) {
      // Same rule as delete: a transient store, no runtime, and the global
      // workspace resolves here too. There is no lane to refresh and no topology
      // to broadcast — a closed session's title moves only its index row.
      const cwd = await this.cwdForRoot(projectRoot)
      if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
      const store = new SessionStore(cwd)
      const session = await store.resolve(sessionId)
      if (!session) throw new Error(`Session not found: ${sessionId}`)
      await store.rename(session.id, title)
      return { ok: true, title } satisfies WireShellRenameSessionResult
    }
    const { store } = entry.project

    const session = await store.resolve(sessionId)
    if (!session) throw new Error(`Session not found: ${sessionId}`)

    await store.rename(session.id, title)

    const lane = this.laneForSessionId(session.id)
    if (lane !== undefined) {
      const updated = await store.resolve(session.id)
      if (updated) this.lanes.get(lane)?.occupant.refreshSessionMeta(updated)
    }
    this.broadcastLanes()
    return { ok: true, title } satisfies WireShellRenameSessionResult
  }

  /**
   * Hands the project's directory to an editor — or, with `target`, one file
   * inside it at one line (T15: a search result's path, clicked).
   *
   * `entry.cwd`, not `entry.root`: the root is the normalized comparison key
   * (`projectRootKey` lower-cases on Windows), and handing a case-folded path to
   * a process is a path that may not exist. The root is what the *renderer*
   * names, because it is the only project handle the lane list carries.
   */
  private async openInEditor(
    projectRoot: string,
    target?: WireEditorTarget,
  ): Promise<WireShellOpenInEditorResult> {
    // Only a path is needed, so a closed project (or the global workspace) opens
    // an editor without bootstrapping a runtime for it.
    const cwd = await this.cwdForRoot(projectRoot)
    if (cwd === undefined) throw new Error(`No project is open at ${projectRoot}`)
    // Missing callback rejects rather than answering `ok`, the same rule
    // `open-project` follows: silence is indistinguishable from success.
    if (!this.deps.onOpenInEditor) throw new Error('The shell cannot open an editor.')
    await this.deps.onOpenInEditor(cwd, target === undefined ? undefined : resolveProjectFile(cwd, target))
    return { ok: true } satisfies WireShellOpenInEditorResult
  }

  /**
   * The settings snapshot, projected **field by field**.
   *
   * Never a spread, and never the return of `resolveModel()`: that method folds
   * the referenced endpoint's `apiKey` and `baseUrl` into what it hands back
   * (`config/service.ts`), so one spread ships every key the user owns across
   * the preload boundary. It is called here only for the `resolves` boolean.
   *
   * Async because the permission and MCP cards need the *local* settings layer
   * beside the merged one — the merge concatenates and unions, so it cannot say
   * which entries this screen is allowed to rewrite.
   */
  private async describeSettings(entry: ProjectEntry<P, W>): Promise<WireSettingsSnapshot> {
    const { config } = entry.project
    const raw = config.get()
    const routing = config.getRouting()
    const merged = entry.project.getSettings()
    // The layers beside the merge: the merge concatenates and unions, so only
    // these can say which entries this screen may rewrite, and which names the
    // local layer merely *overrides*.
    const layers = await loadSettingsLayers(entry.cwd)
    const local = layers.local

    const endpoints = Object.entries(raw.endpoints ?? {}).map(([name, endpoint]) => {
      const info: WireEndpointInfo = { name, provider: endpoint.provider }
      if (endpoint.baseUrl !== undefined) info.baseUrl = endpoint.baseUrl
      if (endpoint.apiKey) info.apiKeyMasked = maskKey(endpoint.apiKey)
      return info
    })

    const models = Object.entries(raw.models).map(([key, model]) => {
      const info: WireModelInfo = {
        key,
        model: model.model,
        resolves: config.resolveModel(key) !== undefined,
      }
      if (model.provider !== undefined) info.provider = model.provider
      if (model.endpoint !== undefined) info.endpoint = model.endpoint
      if (model.contextWindow !== undefined) info.contextWindow = model.contextWindow
      if (model.longContext1m !== undefined) info.longContext1m = model.longContext1m
      // The raw switch is what the edit form seeds from; the effective marker is
      // `resolveImageCapability` against the endpoint the model references, so
      // the renderer never needs the provider registry to draw the list.
      if (model.supportsImageInput === true) info.supportsImageInput = true
      if (resolveImageCapability(model, model.endpoint ? raw.endpoints?.[model.endpoint] : undefined)) {
        info.imageCapable = true
      }
      if (model.maxOutputTokens !== undefined) info.maxOutputTokens = model.maxOutputTokens
      if (model.supportedEfforts !== undefined) info.supportedEfforts = [...model.supportedEfforts]
      if (model.baseUrl !== undefined) info.baseUrl = model.baseUrl
      if (model.apiKey) info.apiKeyMasked = maskKey(model.apiKey)
      return info
    })

    // The four built-ins unioned with whatever routing already names, so a
    // custom `.myagent/agents/*.md` type that has been routed keeps its row.
    const subagentTypes = [...new Set([...BUILTIN_SUBAGENT_TYPES, ...Object.keys(routing.subagent ?? {})])]

    const permissions: WirePermissionsInfo = {
      localPath: localSettingsPath(entry.cwd),
      mode: startupMode(merged.permissions?.mode),
      modeIsLocal: local.permissions?.mode !== undefined,
      groups: (['allow', 'ask', 'deny'] as const).map((behavior) =>
        splitPermissionGroup(behavior, merged, local),
      ),
    }

    const builtInTypes = new Set(BUILT_IN_AGENT_DEFINITIONS.map((definition) => definition.type))
    const agents = entry.project.listAgentDefinitions().map((definition) => {
      const info: WireAgentDefinitionInfo = {
        type: definition.type,
        description: definition.description,
        builtIn: builtInTypes.has(definition.type),
        isReadOnlyAgent: definition.isReadOnlyAgent,
        routing: routing.subagent?.[definition.type] ?? 'inherit',
      }
      if (definition.permissionMode !== undefined) info.permissionMode = definition.permissionMode
      if (definition.tools !== undefined) info.tools = [...definition.tools]
      if (definition.model !== undefined) info.model = definition.model
      if (definition.maxTurns !== undefined) info.maxTurns = definition.maxTurns
      return info
    })

    // Read off disk rather than through the runtime: `getSkills()` is already
    // filtered, and the card has to draw the switched-off ones too.
    const disabledSkills = disabledSkillNames(merged)
    const skills = (await new SkillsService(entry.cwd).listAll()).map((skill) =>
      describeSkill(skill, !disabledSkills.has(skill.name)),
    )

    const locallyTrusted = new Set(local.mcp?.trustedServers ?? [])
    const trusted = new Set(merged.mcp?.trustedServers ?? [])
    const inherited = new Set(
      [layers.user, layers.project, layers.legacyMcp].flatMap((layer) => Object.keys(layer.mcpServers ?? {})),
    )
    const mcpServers = Object.entries(merged.mcpServers ?? {}).map(([name, server]) =>
      describeMcpServer(name, server, entry.project.mcp, trusted, locallyTrusted, {
        isLocal: !!local.mcpServers?.[name],
        shadowsInherited: !!local.mcpServers?.[name] && inherited.has(name),
      }),
    )

    // Merged over the defaults rather than reported as written: `config.json` may
    // name one field, and the screen has to show the number the budget will use.
    const contextValues = { ...DEFAULT_CONTEXT_MANAGEMENT, ...raw.agent.contextManagement }
    const contextManagement = Object.fromEntries(
      CONTEXT_MANAGEMENT_FIELDS.map((field) => [field, contextValues[field]]),
    ) as WireContextManagementInfo

    const snapshot: WireSettingsSnapshot = {
      projectRoot: entry.root,
      projectName: projectDisplayName(entry.cwd),
      saveTarget: config.getSaveTarget(),
      endpoints,
      models,
      routing: {
        main: routing.main ?? 'inherit',
        plan: routing.plan ?? 'inherit',
        compact: routing.compact ?? 'inherit',
        subagent: subagentTypes.map((type) => ({
          type,
          value: routing.subagent?.[type] ?? 'inherit',
        })),
      },
      providers: [...SUPPORTED_PROVIDER_NAMES],
      subagentTypes,
      permissions,
      agents,
      skills,
      skillsDir: getSkillsDir(entry.cwd),
      mcpServers,
      contextManagement,
      userInstructions: await readUserInstructions(),
      coordination: describeCoordination(merged),
      general: {
        localPath: localSettingsPath(entry.cwd),
        ...(merged.cache?.ttl1h !== undefined ? { cacheTtl1h: merged.cache.ttl1h } : {}),
        ...(merged.thinking !== undefined ? { thinking: merged.thinking } : {}),
      },
    }
    if (raw.defaultModel !== undefined) snapshot.defaultModel = raw.defaultModel
    if (raw.fallbackModel !== undefined) snapshot.fallbackModel = raw.fallbackModel
    if (raw.compactModel !== undefined) snapshot.compactModel = raw.compactModel
    return snapshot
  }

  // --- internals -----------------------------------------------------------

  private registerLane(
    entry: ProjectEntry<P, W>,
    pane: PaneT,
    activate = true,
  ): WireShellOpenSessionResult {
    const existing = this.laneForPane(pane)
    if (existing !== undefined) {
      if (activate) this.requestActivate(existing)
      return { lane: existing, pane: this.describeOne(existing, this.lanes.get(existing)!) }
    }
    const lane = this.deps.nextLaneKey()
    const occupant = this.deps.createOccupant({
      lane,
      channel: this.deps.mux.lane(lane),
      pane,
      project: entry,
    })
    this.lanes.set(lane, { pane, project: entry, occupant })
    // `lanes` before `activate`: one channel is FIFO, so the renderer always
    // builds its pane session for a lane before being asked to switch to it.
    this.broadcastLanes()
    if (activate) this.requestActivate(lane)
    return { lane, pane: this.describeOne(lane, this.lanes.get(lane)!) }
  }

  private laneForPane(pane: PaneT): string | undefined {
    for (const [lane, entry] of this.lanes) {
      if (entry.pane === pane) return lane
    }
    return undefined
  }

  /**
   * Field by field through `ProjectDirectory.describe` — the one pane→wire
   * projection — with the lane key added. A live lane's project is open by
   * construction (`detachLane` shuts a project down only after its last lane
   * is gone), so a missing projection is an invariant break, not a row to
   * skip.
   */
  private describeOne(lane: string, entry: LaneEntry<P, W, PaneT>): WireLaneInfo {
    const [pane] = this.deps.directory.describe([entry.pane])
    if (!pane) throw new Error(`Lane ${lane} has no project to describe it.`)
    const info: WireLaneInfo = {
      paneId: pane.paneId,
      sessionId: pane.sessionId,
      projectRoot: pane.projectRoot,
      projectName: pane.projectName,
      lane,
    }
    if (pane.sessionTitle !== undefined) info.sessionTitle = pane.sessionTitle
    if (pane.coordinationRole !== undefined) info.coordinationRole = pane.coordinationRole
    return info
  }

  /**
   * Announces the browser's tabs, across every lane.
   *
   * Pushed rather than pulled, and whole rather than delta, for the same reasons
   * `broadcastLanes` is: the panel diffs the list, and the host is the only side
   * that knows when a page finished loading or changed its title. The tab host
   * coalesces its own bursts, so one page load is one call here.
   */
  broadcastBrowserState(tabs: WireBrowserTabInfo[]): void {
    this.post({ type: 'browser-state', tabs })
  }

  /**
   * A project's thread table was written. Pushes the whole table, like
   * `browser-state`, but coalesced per project root: one wake writes the
   * table several times in a row, and each push re-reads it. A project that
   * is not open is skipped — the renderer pulls when it opens one.
   */
  broadcastCoordinationThreads(cwd: string): void {
    const coordination = this.deps.coordination
    if (this.disposed || !coordination) return
    const root = projectRootKey(cwd)
    if (!this.deps.directory.get(root) || this.threadBroadcasts.has(root)) return
    this.threadBroadcasts.set(
      root,
      setTimeout(() => {
        this.threadBroadcasts.delete(root)
        const entry = this.deps.directory.get(root)
        if (this.disposed || !entry) return
        this.coordinationThreads(coordination, entry.cwd, root).then(
          (state) => {
            if (!this.disposed) this.post({ type: 'coordination-threads', state })
          },
          (error: unknown) => console.error('[hanekawa] coordination threads push failed:', error),
        )
      }, COORDINATION_BROADCAST_DELAY_MS),
    )
  }

  /** Drops the pending pushes; the window (and its renderer) is gone. */
  dispose(): void {
    this.disposed = true
    for (const timer of this.threadBroadcasts.values()) clearTimeout(timer)
    this.threadBroadcasts.clear()
  }

  private post(event: ShellEvent): void {
    this.channel.post(event)
  }
}

const WIRE_THREAD_STATUSES: ReadonlySet<string> = new Set<WireThreadStatus>([
  'running',
  'idle',
  'awaiting-coordinator',
  'needs-you',
  'failed',
  'interrupted',
  'quiet',
  'resolved',
  'stale',
])

/** Field by field, never a spread: `ThreadInfo` carries tool-only fields. A status the wire does not know is dropped. */
function toWireThreadInfo(thread: ShellThreadInfo): WireThreadInfo | undefined {
  if (!WIRE_THREAD_STATUSES.has(thread.status)) return undefined
  const wire: WireThreadInfo = {
    threadId: thread.threadId,
    sessionId: thread.sessionId,
    title: thread.title,
    status: thread.status as WireThreadStatus,
    lastActivityAt: thread.lastActivityAt ?? '',
  }
  if (thread.statusLine !== undefined) wire.statusLine = thread.statusLine
  if (thread.lastReport !== undefined) wire.lastReport = thread.lastReport
  if (thread.branch !== undefined) wire.branch = thread.branch
  return wire
}

function assertNever(value: never): never {
  throw new Error(`Unhandled shell command: ${JSON.stringify(value)}`)
}

/**
 * A session index row → the four fields a sidebar row reads. Field by field,
 * never a spread: `SessionMeta` gains entries (`checkpoints` per turn) that
 * nothing downstream of this command reads, and the
 * registry peek's narrower rows satisfy the same shape.
 */
function summarize(session: {
  id: string
  updatedAt: string
  messageCount: number
  title?: string
  coordination?: { role: 'coordinator' | 'thread' }
}): WireSessionSummary {
  const summary: WireSessionSummary = {
    id: session.id,
    updatedAt: session.updatedAt,
    messageCount: session.messageCount,
  }
  if (session.title !== undefined) summary.title = session.title
  if (session.coordination !== undefined) summary.coordinationRole = session.coordination.role
  return summary
}

/**
 * The subagent types that always get a routing row, whether or not the config
 * has spoken about them. Mirrors the built-ins `.myagent/agents/` may override.
 */
const BUILTIN_SUBAGENT_TYPES = ['general', 'fork', 'explore', 'plan'] as const

/**
 * The startup mode the screen is able to write back.
 *
 * `StartupPermissionMode` is `Exclude<PermissionMode, 'plan'>`, so its type also
 * admits `readonly` — but `validateSettings` accepts only these three, meaning a
 * file naming `readonly` never loads at all. Reporting the default instead keeps
 * the select from offering a value that would make the next reload throw.
 */
function startupMode(mode: StartupPermissionMode | undefined): WirePermissionsInfo['mode'] {
  return mode === 'auto' || mode === 'bypass' ? mode : 'default'
}

/**
 * One permission group, split into "in the local layer" and "from somewhere
 * else".
 *
 * Subtracted by *count*, not as a set: a literal that appears in both the
 * project and the local layer really is in the merge twice, and exactly one of
 * those copies is the one this screen can remove. Treating them as sets would
 * report the entry as purely inherited and then quietly delete it anyway.
 */
function splitPermissionGroup(
  behavior: 'allow' | 'deny' | 'ask',
  merged: MyAgentSettings,
  local: MyAgentSettings,
): WirePermissionGroup {
  const localEntries = [...(local.permissions?.[behavior] ?? [])]
  const unmatched = [...localEntries]
  const inherited: string[] = []
  for (const entry of merged.permissions?.[behavior] ?? []) {
    const index = unmatched.indexOf(entry)
    if (index !== -1) {
      unmatched.splice(index, 1)
      continue
    }
    inherited.push(entry)
  }
  return { behavior, local: localEntries, inherited }
}

/** One skill row: its frontmatter, minus the body and the hook commands. */
/** Merged coordination settings with the default day counts filled in. */
function describeCoordination(merged: ReturnType<ShellLaneProject['getSettings']>): WireCoordinationSettingsInfo {
  const c = coordinationSettings(merged)
  return {
    ...(c.coordinatorModel !== undefined ? { coordinatorModel: c.coordinatorModel } : {}),
    ...(c.coordinatorEffort !== undefined ? { coordinatorEffort: c.coordinatorEffort } : {}),
    ...(c.threadModel !== undefined ? { threadModel: c.threadModel } : {}),
    ...(c.threadEffort !== undefined ? { threadEffort: c.threadEffort } : {}),
    quietDays: c.quietDays ?? DEFAULT_QUIET_DAYS,
    autoResolveDays: c.autoResolveDays ?? DEFAULT_AUTO_RESOLVE_DAYS,
  }
}

function describeSkill(skill: SkillDefinition, enabled: boolean): WireSkillInfo {
  const info: WireSkillInfo = {
    name: skill.name,
    description: skill.description,
    enabled,
    // The parser defaults an absent `inclusion` to `manual`; the fallback is
    // for a definition that reached here from somewhere else.
    inclusion: skill.inclusion ?? 'manual',
    hasHooks: skill.hooks !== undefined,
  }
  if (skill.paths?.length) info.paths = [...skill.paths]
  if (skill.allowedTools?.length) info.allowedTools = [...skill.allowedTools]
  if (skill.model !== undefined) info.model = skill.model
  if (skill.effort !== undefined) info.effort = skill.effort
  if (skill.attachments?.length) info.attachments = skill.attachments.length
  return info
}

/**
 * One MCP server row: what it is, whether it is trusted, and what the last
 * connection attempt made of it.
 *
 * The configuration comes from the settings rather than from the live client —
 * `ManagedMcpClient` keeps its config private, and a server that failed to
 * connect has no client at all but still needs a row.
 */
function describeMcpServer(
  name: string,
  server: McpServerConfig,
  status: McpConnectionStatus,
  trusted: ReadonlySet<string>,
  locallyTrusted: ReadonlySet<string>,
  layer: { isLocal: boolean; shadowsInherited: boolean },
): WireMcpServerInfo {
  const connected = status.connected.find((entry) => entry.name === name)
  const failed = status.failed.find((entry) => entry.name === name)
  const info: WireMcpServerInfo = {
    name,
    transport: server.transport,
    target:
      server.transport === 'stdio'
        ? [server.command ?? '', ...(server.args ?? [])].join(' ').trim()
        : server.url ?? '',
    trusted: trusted.has(name),
    // Trust is unioned across layers, so a grant from above cannot be revoked
    // here. Granting is always possible; taking away is not.
    trustEditable: !trusted.has(name) || locallyTrusted.has(name),
    status: connected ? 'connected' : failed ? 'failed' : 'unknown',
    ...(layer.isLocal ? { isLocal: true, config: server } : {}),
    ...(layer.shadowsInherited ? { shadowsInherited: true } : {}),
  }
  if (connected) info.toolCount = connected.toolCount
  if (failed) info.error = failed.error
  return info
}

/** What one edit costs beyond the mutation itself. */
interface SettingsChangeEffect {
  /** The in-memory `Config` was changed and has to be saved before the reload. */
  saveConfig: boolean
  /** Every live lane of this project rebuilds its runtime after the reload. */
  rebuild: boolean
  /**
   * Which routing scope a rebuild re-resolves the model against. `'models'` for
   * everything that is not a provider edit: it keeps the current model key when
   * that key still resolves, which is what "rebuild but do not change model"
   * means.
   */
  scope: ProviderConfigChangeScope
  /**
   * Runs after `reloadSettings()`. For anything that reads the settings the
   * runtime now holds — an MCP reconnect would otherwise re-apply the trust list
   * from before the edit.
   */
  afterReload?: () => Promise<void>
}

/**
 * Applies one edit and reports what the shell owes it afterwards.
 *
 * Split by scope rather than one flat switch because the two halves write to
 * different places: provider edits mutate the in-memory `Config` (and are saved
 * by the caller), while everything else writes a settings layer or performs an
 * action. Exhaustive by `assertNeverChange` either way, so a new variant cannot
 * reach production as a silent no-op.
 */
async function applySettingsEffect<P extends ShellLaneProject, W extends ShellLaneWorkspace<PaneLike>>(
  entry: ProjectEntry<P, W>,
  change: SettingsChange,
  // Only `import-skill` needs it, and only when the command arrived without a
  // path. Passed in rather than reached for so this stays Electron-free.
  pickDirectory?: ShellHostDeps<P, PaneLike, W>['onPickDirectory'],
): Promise<SettingsChangeEffect> {
  if (change.scope === 'provider') {
    return {
      saveConfig: true,
      rebuild: true,
      scope: applyProviderChange(entry.project.config, change),
    }
  }

  switch (change.kind) {
    case 'set-permission-entries':
      await setLocalPermissionEntries(entry.cwd, change.behavior, change.entries)
      // No rebuild: `reloadSettings()` pushes the new rules into every open
      // scope's gate, and replacing a runtime would drop its prompt cache for
      // nothing.
      return { saveConfig: false, rebuild: false, scope: 'models' }
    case 'set-startup-permission-mode':
      // Startup only, and deliberately so: the mode is read when a scope builds
      // its gate, so this reaches the *next* session rather than fighting with
      // the mode the user has toggled in an open one.
      await setLocalStartupPermissionMode(entry.cwd, change.mode)
      return { saveConfig: false, rebuild: false, scope: 'models' }
    case 'reload-agent-definitions':
      await entry.project.reloadAgentDefinitions()
      // A runtime hands its Agent tool the definitions that existed when it was
      // built, so without the rebuild the reload only reaches the next one.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-coordination-model': {
      if (change.value !== 'inherit' && entry.project.config.get().models[change.value] === undefined) {
        throw new Error(`No model named ${change.value}`)
      }
      const value = change.value === 'inherit' ? undefined : change.value
      await setLocalCoordination(
        entry.cwd,
        change.role === 'coordinator' ? { coordinatorModel: value } : { threadModel: value },
      )
      // Read live through `port.settings` when a coordinator or thread starts.
      return { saveConfig: false, rebuild: false, scope: 'models' }
    }
    case 'set-coordination-effort': {
      const value = change.value === 'inherit' ? undefined : change.value
      await setLocalCoordination(
        entry.cwd,
        change.role === 'coordinator' ? { coordinatorEffort: value } : { threadEffort: value },
      )
      return { saveConfig: false, rebuild: false, scope: 'models' }
    }
    case 'set-coordination-days':
      await setLocalCoordination(entry.cwd, { [change.field]: change.value })
      return { saveConfig: false, rebuild: false, scope: 'models' }
    case 'set-cache-ttl':
      await setLocalCacheTtl1h(entry.cwd, change.enabled)
      // `cacheRuntime` is captured at runtime construction, so this one does
      // need the rebuild.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-user-instructions':
      await writeUserInstructions(change.content)
      // The reload re-reads the file; the rebuild is what puts it in an open
      // session's system prompt.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-thinking':
      await setLocalThinking(entry.cwd, change.enabled)
      // Same reason as the cache TTL: the loop is handed its thinking config
      // when the runtime is built, so only a rebuild reaches an open session.
      return { saveConfig: false, rebuild: true, scope: 'models' }
    case 'set-context-management':
      entry.project.config.setContextManagement({ [change.field]: change.value })
      // No rebuild, because a rebuild would not help: the numbers are snapshotted
      // into the session scope at bootstrap, which is why the rows say so.
      return { saveConfig: true, rebuild: false, scope: 'models' }
    case 'set-skill-enabled':
      await setSkillEnabledLocally(entry.cwd, change.name, change.enabled)
      // The reload comes after `reloadSettings()` because `SkillsService` reads
      // the merged layers to decide what is switched on; the rebuild is for the
      // same reason the agent reload needs one — a runtime is handed the skill
      // list it was built with.
      return {
        saveConfig: false,
        rebuild: true,
        scope: 'models',
        afterReload: async () => {
          await entry.project.reloadSkills()
        },
      }
    case 'reload-skills':
      return {
        saveConfig: false,
        rebuild: true,
        scope: 'models',
        afterReload: async () => {
          await entry.project.reloadSkills()
        },
      }
    case 'import-skill': {
      // The copy happens *before* the reload, not in `afterReload`: a failed
      // import (no SKILL.md, a name already taken) has to reject the command
      // rather than come back as a successful-looking snapshot with nothing new
      // in it. Nothing has been written to config or settings at this point.
      let sourceDir = change.sourceDir
      if (sourceDir === undefined) {
        if (!pickDirectory) throw new Error('The shell cannot open a folder picker.')
        sourceDir = await pickDirectory({ title: '导入技能', buttonLabel: '导入' })
        // Cancelling is a no-op, not an error — the same rule the project picker
        // follows. The reload still runs and answers with an unchanged snapshot.
        if (!sourceDir) return { saveConfig: false, rebuild: false, scope: 'models' }
      }
      await importSkill(entry.cwd, sourceDir)
      // Rebuild for the reason `set-skill-enabled` needs one: a runtime is handed
      // the skill list it was built with.
      return {
        saveConfig: false,
        rebuild: true,
        scope: 'models',
        afterReload: async () => {
          await entry.project.reloadSkills()
        },
      }
    }
    case 'set-mcp-trust':
      await setMcpServerTrustLocally(entry.cwd, change.name, change.trusted)
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    case 'set-mcp-server': {
      // Trust follows the *user*, not the edit: a new server is trusted because
      // adding it by hand is the grant, but an edit — including a rename —
      // carries the trust it already had. Re-granting here would quietly undo a
      // revocation the next time someone fixed a typo in an arg.
      const local = await loadLocalSettings(entry.cwd)
      const priorName = change.previousName ?? change.name
      const isNew = !local.mcpServers || !(priorName in local.mcpServers)
      const trusted = isNew || (local.mcp?.trustedServers ?? []).includes(priorName)
      await setMcpServerLocally(entry.cwd, change.name, change.server, {
        ...(change.previousName !== undefined ? { previousName: change.previousName } : {}),
        trusted,
      })
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    }
    case 'remove-mcp-server':
      await removeMcpServerLocally(entry.cwd, change.name)
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    case 'reconnect-mcp':
      return {
        saveConfig: false,
        rebuild: false,
        scope: 'models',
        afterReload: () => entry.project.reloadMcpServers(),
      }
    default:
      return assertNeverChange(change)
  }
}

/**
 * Applies one provider edit to the config **in memory** and reports which
 * routing scope the runtimes must be re-resolved against.
 *
 * Nothing here saves: `applySettingsChange` owns the save/reload ordering, and
 * keeping the mutation separate is what lets a rejected reference check leave
 * the on-disk config untouched.
 *
 * Exhaustive by `assertNeverChange`, so a variant added to `SettingsChange`
 * cannot reach production as a silent no-op.
 */
function applyProviderChange(
  config: ShellLaneProject['config'],
  change: Extract<SettingsChange, { scope: 'provider' }>,
): ProviderConfigChangeScope {
  switch (change.kind) {
    case 'set-endpoint': {
      const existing = config.get().endpoints?.[change.name]
      const endpoint: Endpoint = { provider: change.provider }
      if (existing?.promptCaching !== undefined) endpoint.promptCaching = existing.promptCaching
      if (change.baseUrl !== undefined && change.baseUrl !== '') endpoint.baseUrl = change.baseUrl
      // An absent `apiKey` means "leave it alone", so the stored key is carried
      // forward. Clearing is `clear-endpoint-key`, precisely so this branch
      // never has to guess what an empty string meant.
      if (change.apiKey !== undefined) {
        if (change.apiKey !== '') endpoint.apiKey = change.apiKey
      } else if (existing?.apiKey !== undefined) {
        endpoint.apiKey = existing.apiKey
      }
      config.setEndpoint(change.name, endpoint)
      return 'endpoints'
    }
    case 'clear-endpoint-key': {
      const existing = config.get().endpoints?.[change.name]
      if (!existing) throw new Error(`No endpoint named ${change.name}`)
      const endpoint: Endpoint = { provider: existing.provider }
      if (existing.baseUrl !== undefined) endpoint.baseUrl = existing.baseUrl
      if (existing.promptCaching !== undefined) endpoint.promptCaching = existing.promptCaching
      config.setEndpoint(change.name, endpoint)
      return 'endpoints'
    }
    case 'remove-endpoint':
      config.removeEndpoint(change.name)
      return 'endpoints'
    case 'rename-endpoint':
      // Rewrites the models that named it, which is why this is a variant of its
      // own: a remove plus an add would delete every one of them.
      config.renameEndpoint(change.from, change.to)
      return 'endpoints'
    case 'set-model': {
      const model: ModelConfig = { model: change.model }
      const existing = config.get().models[change.key]
      if (change.provider !== undefined && change.provider !== '') model.provider = change.provider
      if (change.endpoint !== undefined && change.endpoint !== '') model.endpoint = change.endpoint
      if (change.contextWindow !== undefined) model.contextWindow = change.contextWindow
      // Form-managed fields are replaced, so the form seeds them from the
      // snapshot. Everything the form has no widget for — the cache policy —
      // is carried over instead, or a context-window edit here would quietly
      // delete it from `config.json`.
      if (change.longContext1m !== undefined) model.longContext1m = change.longContext1m
      // Form-owned like `longContext1m`: the form seeds it from the snapshot, so
      // an untouched switch round-trips and an omitted one means off. The carry
      // below must not own this field, or a deliberate switch-off would be
      // overridden by the stale on-disk value.
      if (change.supportsImageInput !== undefined) model.supportsImageInput = change.supportsImageInput
      if (change.maxOutputTokens !== undefined) model.maxOutputTokens = change.maxOutputTokens
      // Normalized here as well as in the form: a full selection is "no
      // restriction", and writing it out would freeze today's five levels into
      // the config file.
      const supportedEfforts = normalizeSupportedEfforts(change.supportedEfforts)
      if (supportedEfforts !== undefined) model.supportedEfforts = supportedEfforts
      config.setModelConfig(change.key, carryJsonOnlyModelFields(model, existing))
      return 'models'
    }
    case 'rename-model':
      // Rewrites every reference, routing included — which is why this is a
      // dedicated variant rather than a remove plus an add.
      config.renameModel(change.from, change.to)
      return 'models'
    case 'remove-model':
      config.removeModel(change.key)
      return 'models'
    case 'set-default-model':
      config.setDefaultModel(change.key)
      return 'models'
    case 'set-routing': {
      const routing = config.getRouting()
      config.setRouting({ ...routing, [change.role]: change.value })
      return 'routing'
    }
    case 'set-subagent-routing': {
      const routing = config.getRouting()
      config.setRouting({
        ...routing,
        subagent: { ...routing.subagent, [change.type]: change.value },
      })
      return 'routing'
    }
    default:
      return assertNeverChange(change)
  }
}

function assertNeverChange(value: never): never {
  throw new Error(`Unhandled settings change: ${JSON.stringify(value)}`)
}

export {
  runtimeHostSatisfiesShellLaneProject,
  sessionWorkspaceSatisfiesShellLaneWorkspace,
}
