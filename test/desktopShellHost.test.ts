import { getGlobalMyAgentDir } from '../src/utils/paths.js'
import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ShellHost,
  parseShellCommand,
  runtimeHostSatisfiesShellLaneProject,
  sessionWorkspaceSatisfiesShellLaneWorkspace,
  type LaneAttach,
  type ShellLaneProject,
  type ShellCoordination,
  COORDINATION_BROADCAST_DELAY_MS,
  type ShellLaneWorkspace,
} from '../src/desktop/shellHost.js'
import { ShellClient } from '../src/desktop/renderer/shellClient.js'
import { SHELL_LANE, type ShellCommand, type SettingsChange, type WireLaneInfo } from '../src/desktop/shellProtocol.js'
import { createLaneMux } from '../src/runtime/protocol/laneChannel.js'
import { createMemoryChannelPair } from '../src/runtime/protocol/memoryChannel.js'
import { getSubagentTranscriptDir } from '../src/harness/sidechainRecordStream.js'
import {
  ProjectDirectory,
  projectRootKey,
  type PaneLike,
  type ProjectEntry,
} from '../src/runtime/projectDirectory.js'
import type { RuntimeChannel } from '../src/runtime/protocol/channel.js'
import { SessionStore, type SessionMeta } from '../src/sessions/service.js'
import type { Config, ModelConfig } from '../src/config/service.js'
import { mergeRouting, type Endpoint, type Routing } from '../src/config/routing.js'
import { loadMergedSettings, localSettingsPath, type MyAgentSettings } from '../src/config/settings.js'
import type { ContextManagementConfig } from '../src/prompts/budget.js'
import { BUILT_IN_AGENT_DEFINITIONS, type BaseAgentDefinition } from '../src/tools/AgentTool/AgentTool.js'
import type { McpConnectionStatus } from '../src/runtime/types.js'
import { getSessionsDir } from '../src/utils/paths.js'

/**
 * `ShellHost` — every lane/project decision the single-window shell makes, with
 * a real `ProjectDirectory` over fake halves.
 *
 * The fakes follow the `ProjectDirectory` generic pattern: `implements` the
 * structural slices this class actually calls, so the constraints keep
 * checking them and the suite needs **no `as unknown as`** — a missing member
 * is a compile error, not a runtime surprise. The occupant is a recorder, the
 * pane is a mutable session holder (which is what makes the "`/clear` moves
 * the pane id, never the lane key" case writable), and the whole shell
 * protocol is driven through a memory pair with a mux on each side and the
 * shipping `ShellClient` on the renderer's `__shell` lane.
 *
 * The order assertions in the detach cases are the load-bearing ones: the map
 * entry drops before anything runs (re-entrancy), the occupant is disposed
 * before the pane closes, and a project's last lane is the only thing that
 * shuts the project down.
 */

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * An absolute fixture path, spelled the way the running platform spells one.
 *
 * These fixtures were written as Windows literals (`C:\repo\alpha`), which made
 * every assertion that goes *through* `path` platform-specific without saying
 * so: on a POSIX box `C:\repo\alpha` contains no separator at all, so its
 * basename is the whole string, nothing is inside anything, and a join produces
 * a path no check can relate to its root. The paths themselves are arbitrary —
 * none of them is ever opened — so the one thing that matters is that they are
 * shaped like a real root here.
 */
function fixturePath(...segments: string[]): string {
  return path.join(process.platform === 'win32' ? 'C:\\' : '/', ...segments)
}

// The settings cards read the *local* layer off disk and `loadMergedSettings`
// layers `~/.myagent/settings.json` under it, so without its own home this file
// would read the developer's settings and assert differently per machine.
beforeEach(() => {
  const testHome = mkdtempSync(path.join(os.tmpdir(), 'myagent-home-'))
  process.env.USERPROFILE = testHome
  process.env.HOME = testHome
})

function sessionOf(id: string, title?: string): SessionMeta {
  return {
    id,
    shortId: id.slice(0, 8),
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messageCount: 0,
    ...(title !== undefined ? { title } : {}),
  }
}

/** An ISO timestamp `minutesAgo` before a fixed instant, for index fixtures. */
const at = (minutesAgo: number): string =>
  new Date(Date.UTC(2026, 7, 20, 12, 0, 0) - minutesAgo * 60_000).toISOString()

class FakePane implements PaneLike {
  constructor(public session: SessionMeta) {}
  getSession(): SessionMeta {
    return this.session
  }
}

/** The scope a fake project opens: exactly what `adopt` needs, nothing more. */
interface FakeScope {
  session: SessionMeta
}

class FakeStore {
  readonly sessions = new Map<string, SessionMeta>()
  readonly drafts: SessionMeta[] = []
  readonly deleted: string[] = []
  readonly renamed: Array<{ id: string; title: string }> = []
  /** Set to make `resolve` behave like the real prefix resolver. */
  resolvePrefixes = false

  constructor(private readonly log: string[] = []) {}

  async resolve(idOrPrefix: string): Promise<SessionMeta | undefined> {
    const exact = this.sessions.get(idOrPrefix)
    if (exact || !this.resolvePrefixes) return exact
    const matches = [...this.sessions.values()].filter((session) =>
      session.id.startsWith(idOrPrefix),
    )
    return matches.length === 1 ? matches[0] : undefined
  }

  createDraft(title?: string): SessionMeta {
    const draft = sessionOf(`draft-${this.drafts.length + 1}`, title)
    this.drafts.push(draft)
    return draft
  }

  async list(): Promise<SessionMeta[]> {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async delete(idOrPrefix: string): Promise<void> {
    this.deleted.push(idOrPrefix)
    this.log.push(`store-delete:${idOrPrefix}`)
    this.sessions.delete(idOrPrefix)
  }

  async rename(idOrPrefix: string, title: string): Promise<void> {
    this.renamed.push({ id: idOrPrefix, title })
    this.log.push(`store-rename:${idOrPrefix}`)
    const session = this.sessions.get(idOrPrefix)
    if (session) this.sessions.set(idOrPrefix, { ...session, title })
  }
}

/**
 * A config fake that records call order.
 *
 * The order matters more than the values here: `save()` landing *after*
 * `reloadSettings()` would be silently destroyed by the latter's
 * `config.load()`, so the log is what pins it.
 */
class FakeConfig {
  config: Config = { models: {}, agent: {} }
  saves = 0

  constructor(private readonly log: string[] = []) {}

  get(): Config {
    return this.config
  }

  getRouting(): Routing {
    return mergeRouting(this.config.routing)
  }

  setRouting(routing: Routing): void {
    this.config.routing = routing
  }

  setEndpoint(name: string, endpoint: Endpoint): void {
    this.config.endpoints = { ...this.config.endpoints, [name]: endpoint }
  }

  modelsForEndpoint(name: string): string[] {
    return Object.entries(this.config.models)
      .filter(([, model]) => model.endpoint === name)
      .map(([key]) => key)
  }

  // Mirrors the real service: the endpoint's models go with it rather than
  // making it undeletable.
  removeEndpoint(name: string): void {
    for (const model of this.modelsForEndpoint(name)) this.removeModel(model)
    const next = { ...this.config.endpoints }
    delete next[name]
    this.config.endpoints = next
  }

  setModelConfig(name: string, model: ModelConfig): void {
    this.config.models = { ...this.config.models, [name]: model }
  }

  // Mirrors the real service: references are repaired, not defended.
  removeModel(name: string): void {
    const next = { ...this.config.models }
    delete next[name]
    this.config.models = next
    const successor = Object.keys(next)[0]
    if (this.config.defaultModel === name) {
      if (successor === undefined) delete this.config.defaultModel
      else this.config.defaultModel = successor
    }
    const routing = this.getRouting()
    for (const role of ['main', 'plan', 'compact'] as const) {
      if (routing[role] === name) routing[role] = 'inherit'
    }
    this.config.routing = routing
  }

  renameEndpoint(oldName: string, newName: string): void {
    const endpoint = this.config.endpoints?.[oldName]
    if (!endpoint) throw new Error(`No endpoint named ${oldName}`)
    const next = { ...this.config.endpoints }
    delete next[oldName]
    next[newName] = endpoint
    this.config.endpoints = next
    for (const key of this.modelsForEndpoint(oldName)) {
      this.config.models[key] = { ...this.config.models[key]!, endpoint: newName }
    }
  }

  renameModel(oldKey: string, newKey: string): void {
    const model = this.config.models[oldKey]
    if (!model) throw new Error(`No model named ${oldKey}`)
    const next = { ...this.config.models }
    delete next[oldKey]
    next[newKey] = model
    this.config.models = next
    const routing = this.getRouting()
    for (const role of ['main', 'plan', 'compact'] as const) {
      if (routing[role] === oldKey) routing[role] = newKey
    }
    this.config.routing = routing
  }

  setDefaultModel(name: string): void {
    // Mirrors the real service: unresolvable keys are a silent no-op.
    if (!this.config.models[name]) return
    this.config.defaultModel = name
  }

  /**
   * Mirrors the real `ConfigService.resolveModel`, **including that it folds the
   * endpoint's `apiKey` and `baseUrl` into what it returns**.
   *
   * That fold is the whole reason `describeSettings` must project field by
   * field. A fake that skipped it would make the "no raw key on the wire" case
   * vacuous — it passed a deliberate `...resolveModel(key)` mutation until this
   * was fixed.
   */
  resolveModel(name: string): ModelConfig | undefined {
    const model = this.config.models[name]
    if (!model) return undefined
    if (!model.endpoint) return model.provider ? { ...model } : undefined
    const endpoint = this.config.endpoints?.[model.endpoint]
    if (!endpoint) return undefined
    const resolved: ModelConfig = {
      provider: endpoint.provider,
      ...(endpoint.baseUrl !== undefined ? { baseUrl: endpoint.baseUrl } : {}),
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...model,
    }
    return resolved.provider ? resolved : undefined
  }

  getSaveTarget(): string {
    return `${this.cwdLabel}/.myagent/config.json`
  }

  cwdLabel = 'project'

  /**
   * Mirrors the real service, **including that it throws on a value that cannot
   * mean anything**. The shell lets that rejection propagate, so a fake which
   * accepted anything would make the "a rejected value writes nothing" case
   * vacuous.
   */
  setContextManagement(patch: Partial<ContextManagementConfig>): void {
    for (const [field, value] of Object.entries(patch) as Array<[string, number]>) {
      if (field.endsWith('Ratio')) {
        if (!(value > 0 && value <= 1)) throw new Error(`${field} must be a ratio in (0, 1]`)
      } else if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${field} must be a positive integer`)
      }
    }
    this.config.agent = {
      ...this.config.agent,
      contextManagement: { ...this.config.agent.contextManagement, ...patch },
    }
  }

  async save(): Promise<void> {
    this.saves += 1
    this.log.push('config-save')
  }
}

class FakeProject implements ShellLaneProject {
  readonly store: FakeStore
  readonly config: FakeConfig
  readonly openedScopes: SessionMeta[] = []
  readonly shutdowns: string[] = []
  reloads = 0
  agentReloads = 0
  skillReloads = 0
  mcpReloads = 0
  /** The merged settings, as the last load read them off disk. */
  settings: MyAgentSettings = {}
  agentDefinitions: BaseAgentDefinition[] = [...BUILT_IN_AGENT_DEFINITIONS]
  readonly mcp: McpConnectionStatus = { connected: [], failed: [] }

  constructor(
    readonly cwd: string,
    private readonly log: string[],
  ) {
    this.store = new FakeStore(log)
    this.config = new FakeConfig(log)
    this.config.cwdLabel = cwd
  }

  /** What `bootstrap()` does before any UI exists; a constructor cannot await. */
  async loadSettings(): Promise<void> {
    this.settings = await loadMergedSettings(this.cwd)
  }

  async reloadSettings(): Promise<{ needsRuntimeRebuild: boolean }> {
    this.reloads += 1
    this.log.push(`reload-settings:${this.cwd}`)
    // The real one re-reads all four layers and replaces what `getSettings()`
    // answers. Doing the same here is what makes a settings-layer edit
    // observable at all: those writes go to `settings.local.json` on disk, not
    // through this fake.
    await this.loadSettings()
    // The real one reports `hooksChanged` only — a provider edit reports false,
    // which is exactly why the shell does not consult it.
    return { needsRuntimeRebuild: false }
  }

  getSettings(): MyAgentSettings {
    return this.settings
  }

  listAgentDefinitions(): readonly BaseAgentDefinition[] {
    return this.agentDefinitions
  }

  async reloadAgentDefinitions(): Promise<number> {
    this.agentReloads += 1
    this.log.push(`reload-agents:${this.cwd}`)
    return this.agentDefinitions.length
  }

  async reloadSkills(): Promise<number> {
    this.skillReloads += 1
    this.log.push(`reload-skills:${this.cwd}`)
    return 0
  }

  async reloadMcpServers(): Promise<void> {
    this.mcpReloads += 1
    this.log.push(`reload-mcp:${this.cwd}`)
  }

  async openScope(session: SessionMeta): Promise<FakeScope> {
    this.openedScopes.push(session)
    return { session }
  }

  async shutdown(reason: string): Promise<void> {
    this.shutdowns.push(reason)
    this.log.push(`shutdown:${this.cwd}:${reason}`)
  }
}

class FakeWorkspace implements ShellLaneWorkspace<FakePane> {
  readonly panes: FakePane[] = []
  readonly closed: FakePane[] = []

  constructor(private readonly log: string[]) {}

  list(): readonly FakePane[] {
    return [...this.panes]
  }

  paneForSession(sessionId: string): FakePane | undefined {
    return this.panes.find((pane) => pane.getSession().id === sessionId)
  }

  async open(session: SessionMeta): Promise<FakePane> {
    const existing = this.paneForSession(session.id)
    if (existing) return existing
    const pane = new FakePane(session)
    this.panes.push(pane)
    return pane
  }

  adopt(scope: unknown, _options?: { modelKey?: string }): FakePane {
    // The one honest assertion in this file: `adopt`'s parameter is `unknown`
    // by design (the shell hands a scope straight through), and only the fake
    // knows what its own `openScope` produced.
    const { session } = scope as FakeScope
    const existing = this.paneForSession(session.id)
    if (existing) return existing
    const pane = new FakePane(session)
    this.panes.push(pane)
    return pane
  }

  close(pane: FakePane): void {
    const index = this.panes.indexOf(pane)
    if (index === -1) return
    this.panes.splice(index, 1)
    this.closed.push(pane)
    this.log.push(`close-pane:${pane.getSession().id}`)
  }

  closeAll(): void {
    for (const pane of [...this.panes]) this.close(pane)
    this.log.push(`closeAll`)
  }
}

interface Harness {
  host: ShellHost<FakeProject, FakePane, FakeWorkspace>
  client: ShellClient
  directory: ProjectDirectory<FakeProject, FakeWorkspace>
  entry: ProjectEntry<FakeProject, FakeWorkspace>
  project: FakeProject
  workspace: FakeWorkspace
  attaches: LaneAttach<FakeProject, FakePane, FakeWorkspace>[]
  disposed: string[]
  configRefreshes: Array<{ lane: string; rebuild: boolean; scope: string }>
  metaRefreshes: Array<{ lane: string; session: SessionMeta }>
  activates: string[]
  laneEvents: WireLaneInfo[][]
  allLanesClosed: string[]
  openProjectRequests: Array<string | undefined>
  /** What `open-in-editor` handed over, in order: the cwd, and a target when one was named. */
  editorRequests: Array<{ cwd: string; target?: { path: string; line?: number } }>
  /** Makes the next `open-in-editor` reject, the way an uninstalled `code` does. */
  failEditor(message: string | undefined): void
  /** The themes `set-window-theme` handed to the window overlay, in order. */
  windowThemes: Array<'dark' | 'light'>
  /** What `pick-images` handed the picker: the anchor, when one was resolvable. */
  pickedImageAnchors: Array<{ defaultPath?: string }>
  /** The paths the next `pick-images` round trip answers with. */
  setPickedImages(paths: string[] | undefined): void
  /** The cwds `remove-project` handed to the registry, in order. */
  forgottenProjects: string[]
  /**
   * The interleaved action log the fakes append to (`close-pane:<id>`,
   * `store-delete:<id>`, `shutdown:<cwd>:<reason>`, `closeAll`). The only place
   * *relative order* between the workspace and the store is observable — two
   * separate arrays cannot tell "closed the lane first" from "closed it after".
   */
  log: string[]
  /** The renderer-side mux: `lane(key)` observes a lane's death from that side. */
  rendererMux: ReturnType<typeof createLaneMux>
  setQuitting(value: boolean): void
  /**
   * Puts one lane mid-turn on a model key — `undefined` puts it back to idle.
   * The only state that can still refuse a model or endpoint removal.
   */
  runOn(lane: string, modelKey: string | undefined): void
  /** Registers another project in the same directory, with its own fakes. */
  addProject(cwd: string): { project: FakeProject; workspace: FakeWorkspace; entry: ProjectEntry<FakeProject, FakeWorkspace> }
}

function createHarness(
  options: {
    withOpenProject?: boolean
    withOpenInEditor?: boolean
    /** A shell with no native overlay — every non-Windows build. */
    withWindowTheme?: boolean
    cwd?: string
    /** The registry the sidebar's full history is built from. */
    knownProjects?: () => Promise<readonly string[]>
    /** Boots a project the registry knows but the directory does not hold. */
    ensureProject?: (
      cwd: string,
      options?: { sessionId?: string },
    ) => Promise<ProjectEntry<FakeProject, FakeWorkspace>>
    ensureProjectFresh?: (
      cwd: string,
    ) => Promise<{ entry: ProjectEntry<FakeProject, FakeWorkspace>; session?: SessionMeta }>
    /** A shell without an image picker — `pick-images` must reject, not answer empty. */
    withPickImages?: boolean
    /** A shell that cannot write the registry — `remove-project` still detaches. */
    withForgetProject?: boolean
    /** The host-side coordination commands. */
    coordination?: ShellCoordination
    /** The native folder picker's answer. */
    pickDirectory?: () => Promise<string | undefined>
  } = {},
): Harness {
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const mainMux = createLaneMux(mainTransport)
  const rendererMux = createLaneMux(rendererTransport)

  const directory = new ProjectDirectory<FakeProject, FakeWorkspace>()
  const log: string[] = []
  // A real directory only when a case actually writes settings files into one;
  // everything else stays on a path that does not exist, which is exactly what
  // the local-layer reader treats as "no local settings".
  const first = createProject(directory, options.cwd ?? fixturePath('repo', 'alpha'), log)

  const attaches: LaneAttach<FakeProject, FakePane, FakeWorkspace>[] = []
  const disposed: string[] = []
  const configRefreshes: Array<{ lane: string; rebuild: boolean; scope: string }> = []
  const metaRefreshes: Array<{ lane: string; session: SessionMeta }> = []
  const activates: string[] = []
  const laneEvents: WireLaneInfo[][] = []
  const allLanesClosed: string[] = []
  const openProjectRequests: Array<string | undefined> = []
  const editorRequests: Array<{ cwd: string; target?: { path: string; line?: number } }> = []
  const windowThemes: Array<'dark' | 'light'> = []
  const pickedImageAnchors: Array<{ defaultPath?: string }> = []
  let pickedImages: string[] | undefined = []
  const setPickedImages = (paths: string[] | undefined): void => {
    pickedImages = paths
  }
  const forgottenProjects: string[] = []
  let editorFailure: string | undefined
  let quitting = false
  let nextKey = 0
  /** Lane -> the model key a turn is streaming on. Empty means every lane is idle. */
  const laneActiveModels = new Map<string, string>()

  const host = new ShellHost<FakeProject, FakePane, FakeWorkspace>({
    mux: mainMux,
    directory,
    nextLaneKey: () => `${++nextKey}`,
    createOccupant: (attach) => {
      attaches.push(attach)
      return {
        dispose: () => disposed.push(attach.lane),
        refreshAfterConfigChange: (options) => configRefreshes.push({ lane: attach.lane, ...options }),
        refreshSessionMeta: (session) => {
          metaRefreshes.push({ lane: attach.lane, session })
          // Mirrors production: the host hands the meta to its controller, and
          // `SessionPane.getSession()` reads back through it — which is what
          // makes the following `broadcastLanes()` carry the new title.
          attach.pane.session = session
        },
        // Idle unless a test says otherwise; `runOn` is what arms it.
        activeModelKey: () => laneActiveModels.get(attach.lane),
      }
    },
    ...(options.withOpenProject === false
      ? {}
      : { onOpenProject: (path?: string) => openProjectRequests.push(path) }),
    ...(options.withOpenInEditor === false
      ? {}
      : {
          onOpenInEditor: async (cwd: string, target?: { path: string; line?: number }) => {
            editorRequests.push(target === undefined ? { cwd } : { cwd, target })
            // Rejecting *after* recording: the host must have handed the path
            // over before it can report the launch failing.
            if (editorFailure !== undefined) throw new Error(editorFailure)
          },
        }),
    ...(options.withWindowTheme === false
      ? {}
      : { onWindowTheme: (theme: 'dark' | 'light') => windowThemes.push(theme) }),
    ...(options.withPickImages === false
      ? {}
      : {
          onPickImages: async (pickOptions: { defaultPath?: string }) => {
            pickedImageAnchors.push(pickOptions)
            return pickedImages
          },
        }),
    ...(options.knownProjects ? { knownProjects: options.knownProjects } : {}),
    ...(options.ensureProject ? { ensureProject: options.ensureProject } : {}),
    ...(options.ensureProjectFresh ? { ensureProjectFresh: options.ensureProjectFresh } : {}),
    ...(options.withForgetProject === false
      ? {}
      : {
          onForgetProject: async (cwd: string) => {
            forgottenProjects.push(cwd)
          },
        }),
    ...(options.coordination ? { coordination: options.coordination } : {}),
    ...(options.pickDirectory ? { onPickDirectory: options.pickDirectory } : {}),
    isQuitting: () => quitting,
    onAllLanesClosed: (reason) => allLanesClosed.push(reason),
  })

  const shellLane = rendererMux.lane(SHELL_LANE)
  const client = new ShellClient(shellLane)
  client.onActivate((lane) => activates.push(lane))
  client.onLanes((lanes) => laneEvents.push([...lanes]))

  return {
    host,
    client,
    directory,
    entry: first.entry,
    project: first.project,
    workspace: first.workspace,
    attaches,
    disposed,
    configRefreshes,
    metaRefreshes,
    activates,
    laneEvents,
    allLanesClosed,
    openProjectRequests,
    editorRequests,
    windowThemes,
    pickedImageAnchors,
    setPickedImages,
    forgottenProjects,
    failEditor: (message: string | undefined) => {
      editorFailure = message
    },
    log,
    rendererMux,
    setQuitting: (value: boolean) => {
      quitting = value
    },
    /** Puts one lane mid-turn on a model key, the state that blocks a removal. */
    runOn: (lane: string, modelKey: string | undefined) => {
      if (modelKey === undefined) laneActiveModels.delete(lane)
      else laneActiveModels.set(lane, modelKey)
    },
    addProject: (cwd: string) => createProject(directory, cwd, log),
  }
}

function createProject(
  directory: ProjectDirectory<FakeProject, FakeWorkspace>,
  cwd: string,
  log: string[],
) {
  const project = new FakeProject(cwd, log)
  const workspace = new FakeWorkspace(log)
  const entry = directory.add(project, workspace)
  return { project, workspace, entry }
}

/** Posts a raw command on the shell lane, bypassing `ShellClient`. */
function postRawShellCommand(lane: RuntimeChannel, command: unknown): void {
  lane.post(command)
}

// --- drift guards ------------------------------------------------------------

test('the structural shell halves are satisfied by the real runtime types', () => {
  // The compile-time assertions are the real test; this keeps the constants
  // used and the intent readable, the same net as electronChannel.test.ts.
  assert.ok(runtimeHostSatisfiesShellLaneProject)
  assert.ok(sessionWorkspaceSatisfiesShellLaneWorkspace)
})

const COMMAND_SAMPLES = {
  panes: { type: 'panes', id: 'a' },
  'open-session': { type: 'open-session', id: 'b', sessionId: 's1', title: 'T', projectRoot: 'r' },
  'open-project': { type: 'open-project', id: 'c', path: fixturePath('repo') },
  'list-sessions': { type: 'list-sessions', id: 'd' },
  'usage-stats': { type: 'usage-stats', id: 'u' },
  'delete-session': { type: 'delete-session', id: 'e', projectRoot: 'r', sessionId: 's1' },
  'get-settings': { type: 'get-settings', id: 'f', projectRoot: 'r' },
  'settings-change': {
    type: 'settings-change',
    id: 'g',
    projectRoot: 'r',
    change: { scope: 'provider', kind: 'set-routing', role: 'main', value: 'inherit' },
  },
  'rename-session': { type: 'rename-session', id: 'h', projectRoot: 'r', sessionId: 's1', title: 'T' },
  'probe-endpoint': { type: 'probe-endpoint', id: 'w', projectRoot: 'r', provider: 'openai', endpointName: 'main' },
  'open-in-editor': { type: 'open-in-editor', id: 'i', projectRoot: 'r' },
  'set-window-theme': { type: 'set-window-theme', id: 'j', theme: 'light' },
  'pick-images': { type: 'pick-images', id: 'l', projectRoot: 'r' },
  'remove-project': { type: 'remove-project', id: 'k', projectRoot: 'r' },
  'browser-create-tab': { type: 'browser-create-tab', id: 'm', lane: '1', url: 'https://example.com' },
  'browser-close-tab': { type: 'browser-close-tab', id: 'n', tabId: 't1' },
  'browser-navigate': { type: 'browser-navigate', id: 'o', tabId: 't1', url: 'https://example.com' },
  'browser-go-back': { type: 'browser-go-back', id: 'p', tabId: 't1' },
  'browser-go-forward': { type: 'browser-go-forward', id: 'q', tabId: 't1' },
  'browser-reload': { type: 'browser-reload', id: 'r', tabId: 't1' },
  'browser-take-over': { type: 'browser-take-over', id: 's', tabId: 't1' },
  'browser-release': { type: 'browser-release', id: 'u', tabId: 't1' },
  'browser-set-bounds': {
    type: 'browser-set-bounds',
    id: 't',
    tabId: 't1',
    rect: { x: 0, y: 0, width: 480, height: 720 },
    visible: true,
  },
  'open-coordinator': { type: 'open-coordinator', id: 'v', projectRoot: 'r' },
  'new-coordinator-project': { type: 'new-coordinator-project', id: 'v2', path: 'p' },
  'coordination-stop-all': { type: 'coordination-stop-all', id: 'w', projectRoot: 'r' },
  'coordination-survey': { type: 'coordination-survey', id: 'w2', projectRoot: 'r' },
  'thread-merges': { type: 'thread-merges', id: 'x', projectRoot: 'r' },
  'thread-merge': { type: 'thread-merge', id: 'y', projectRoot: 'r', threadId: 't1' },
  'thread-merge-dismiss': { type: 'thread-merge-dismiss', id: 'z', projectRoot: 'r', threadId: 't1' },
  'thread-merge-resolve': { type: 'thread-merge-resolve', id: 'aa', projectRoot: 'r', threadId: 't1' },
  'coordination-threads': { type: 'coordination-threads', id: 'ab', projectRoot: 'r' },
  'thread-stop': { type: 'thread-stop', id: 'ac', projectRoot: 'r', threadId: 't1' },
  'thread-resolve': { type: 'thread-resolve', id: 'ad', projectRoot: 'r', threadId: 't1' },
  'thread-transcript': { type: 'thread-transcript', id: 'ae', projectRoot: 'r', threadId: 't1', since: '10:1' },
} as const satisfies Record<ShellCommand['type'], ShellCommand>

/**
 * One sample per `SettingsChange` variant. The keyed `satisfies` is the guard —
 * a variant added without a schema in `SETTINGS_CHANGE_SCHEMAS` fails by name,
 * and this array proves each one actually parses rather than merely typechecks.
 */
const SETTINGS_CHANGE_SAMPLES = {
  'set-endpoint': { scope: 'provider', kind: 'set-endpoint', name: 'e1', provider: 'anthropic' },
  'clear-endpoint-key': { scope: 'provider', kind: 'clear-endpoint-key', name: 'e1' },
  'remove-endpoint': { scope: 'provider', kind: 'remove-endpoint', name: 'e1' },
  'rename-endpoint': { scope: 'provider', kind: 'rename-endpoint', from: 'e1', to: 'e2' },
  'set-model': { scope: 'provider', kind: 'set-model', key: 'm1', model: 'claude-x', supportsImageInput: true },
  'rename-model': { scope: 'provider', kind: 'rename-model', from: 'm1', to: 'm2' },
  'remove-model': { scope: 'provider', kind: 'remove-model', key: 'm1' },
  'set-default-model': { scope: 'provider', kind: 'set-default-model', key: 'm1' },
  'set-routing': { scope: 'provider', kind: 'set-routing', role: 'plan', value: 'm1' },
  'set-subagent-routing': { scope: 'provider', kind: 'set-subagent-routing', type: 'explore', value: 'm1' },
  'set-permission-entries': {
    scope: 'permissions',
    kind: 'set-permission-entries',
    behavior: 'allow',
    entries: ['Bash(git status:*)'],
  },
  'set-startup-permission-mode': {
    scope: 'permissions',
    kind: 'set-startup-permission-mode',
    mode: 'auto',
  },
  'reload-agent-definitions': { scope: 'agent', kind: 'reload-agent-definitions' },
  'set-coordination-model': { scope: 'agent', kind: 'set-coordination-model', role: 'coordinator', value: 'big' },
  'set-coordination-effort': { scope: 'agent', kind: 'set-coordination-effort', role: 'thread', value: 'high' },
  'set-coordination-days': { scope: 'agent', kind: 'set-coordination-days', field: 'quietDays', value: 5 },
  'set-cache-ttl': { scope: 'general', kind: 'set-cache-ttl', enabled: true },
  'set-thinking': { scope: 'general', kind: 'set-thinking', enabled: false },
  'set-context-management': {
    scope: 'general',
    kind: 'set-context-management',
    field: 'contextWindow',
    value: 400_000,
  },
  'set-skill-enabled': {
    scope: 'extensions',
    kind: 'set-skill-enabled',
    name: 'demo',
    enabled: false,
  },
  'reload-skills': { scope: 'extensions', kind: 'reload-skills' },
  'import-skill': { scope: 'extensions', kind: 'import-skill', sourceDir: '/tmp/demo-skill' },
  'set-mcp-trust': { scope: 'extensions', kind: 'set-mcp-trust', name: 'github', trusted: true },
  'set-mcp-server': {
    scope: 'extensions',
    kind: 'set-mcp-server',
    name: 'sqlite',
    server: {
      transport: 'stdio',
      command: 'sqlite-mcp',
      args: ['--db', 'test.db'],
      env: { FOO: 'bar' },
      envPassthrough: ['PATH'],
      cwd: '/tmp',
    },
  },
  'remove-mcp-server': { scope: 'extensions', kind: 'remove-mcp-server', name: 'sqlite' },
  'reconnect-mcp': { scope: 'extensions', kind: 'reconnect-mcp' },
  'set-user-instructions': { scope: 'personalization', kind: 'set-user-instructions', content: 'Reply in Chinese.' },
} as const satisfies Record<SettingsChange['kind'], SettingsChange>

test('every settings change variant round-trips through its schema', () => {
  for (const change of Object.values(SETTINGS_CHANGE_SAMPLES)) {
    const parsed = parseShellCommand({ type: 'settings-change', id: 'x', projectRoot: 'r', change })
    assert.equal(parsed.ok, true, `expected ${change.kind} to parse`)
    if (parsed.ok && parsed.command.type === 'settings-change') {
      assert.deepEqual(parsed.command.change, change)
    }
  }
})

test('a settings change with an unknown field is rejected', () => {
  const parsed = parseShellCommand({
    type: 'settings-change',
    id: 'x',
    projectRoot: 'r',
    change: { scope: 'provider', kind: 'remove-model', key: 'm1', sneaky: 1 },
  })
  assert.equal(parsed.ok, false, '.strict() must reject an extra field')
})

test('every shell command variant round-trips through its schema', () => {
  for (const command of Object.values(COMMAND_SAMPLES)) {
    const parsed = parseShellCommand(command)
    assert.equal(parsed.ok, true, `expected ${command.type} to parse`)
    if (parsed.ok) assert.deepEqual(parsed.command, command)
  }
  assert.deepEqual(
    Object.keys(COMMAND_SAMPLES).sort(),
    [
      'browser-close-tab',
      'browser-create-tab',
      'browser-go-back',
      'browser-go-forward',
      'browser-navigate',
      'browser-release',
      'browser-reload',
      'browser-set-bounds',
      'browser-take-over',
      'coordination-stop-all',
      'coordination-survey',
      'coordination-threads',
      'delete-session',
      'get-settings',
      'list-sessions',
      'new-coordinator-project',
      'open-coordinator',
      'open-in-editor',
      'open-project',
      'open-session',
      'panes',
      'pick-images',
      'probe-endpoint',
      'remove-project',
      'rename-session',
      'set-window-theme',
      'settings-change',
      'thread-merge',
      'thread-merge-dismiss',
      'thread-merge-resolve',
      'thread-merges',
      'thread-resolve',
      'thread-stop',
      'thread-transcript',
      'usage-stats',
    ],
    'a variant added to ShellCommand must fail the satisfies table by name',
  )
})

test('a coordination command without a thread id is rejected', () => {
  assert.equal(parseShellCommand({ type: 'thread-merge', id: 'x', projectRoot: 'r' }).ok, false)
  assert.equal(parseShellCommand({ type: 'open-coordinator', id: 'x', projectRoot: 'r', extra: 1 }).ok, false)
  assert.equal(parseShellCommand({ type: 'thread-stop', id: 'x', projectRoot: 'r' }).ok, false)
  assert.equal(parseShellCommand({ type: 'thread-resolve', id: 'x', projectRoot: 'r', threadId: '' }).ok, false)
  assert.equal(parseShellCommand({ type: 'thread-transcript', id: 'x', projectRoot: 'r' }).ok, false)
})

test('a malformed command fails with the id recovered', () => {
  const parsed = parseShellCommand({ type: 'open-session', id: 'x1', bogus: true })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) {
    assert.equal(parsed.id, 'x1')
    assert.match(parsed.message, /bogus/)
  }
  assert.equal(parseShellCommand('nonsense').ok, false)
})

// --- open-session ------------------------------------------------------------

test('open-session without a sessionId mints a fresh draft and a lane', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  assert.equal(result.lane, '1')
  assert.equal(result.pane.lane, '1')
  assert.equal(result.pane.paneId, h.project.store.drafts[0]!.id)
  assert.equal(result.pane.projectRoot, h.entry.root)
  assert.equal(result.pane.projectName, 'alpha')

  // The full choreography: draft → scope → adopt → occupant on a lane channel.
  assert.equal(h.project.store.drafts.length, 1)
  assert.equal(h.project.openedScopes.length, 1)
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.attaches.length, 1)
  assert.equal(h.attaches[0]!.lane, '1')
  assert.equal(h.attaches[0]!.pane, h.workspace.panes[0])
  assert.equal(h.attaches[0]!.project, h.entry)
  assert.equal(typeof h.attaches[0]!.channel.post, 'function')

  // Topology and activation both reached the renderer, lanes before activate.
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1'])
  assert.deepEqual(h.activates, ['1'])
})

test('openLane with activate: false registers the lane without activating it', async () => {
  const h = createHarness()
  const result = await h.host.openLane(h.entry, { activate: false })
  await settle()

  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), [result.lane])
  assert.equal(h.attaches.length, 1, 'the occupant is still built')
  assert.deepEqual(h.activates, [], 'and nobody was asked to switch to it')
})

test('openLane activates by default, for a new lane and an existing one', async () => {
  const h = createHarness()
  const first = await h.host.openLane(h.entry)
  const second = await h.host.openLane(h.entry, { sessionId: h.workspace.panes[0]!.getSession().id })
  await settle()

  assert.equal(second.lane, first.lane)
  assert.deepEqual(h.activates, [first.lane, first.lane])
})

test('open-session defaults to the first open project', async () => {
  const h = createHarness()
  const result = await h.client.openSession()
  await settle()
  assert.equal(result.pane.projectRoot, h.entry.root)
})

test('open-session with no project open fails', async () => {
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const emptyDirectory = new ProjectDirectory<FakeProject, FakeWorkspace>()
  const host = new ShellHost<FakeProject, FakePane, FakeWorkspace>({
    mux: createLaneMux(mainTransport),
    directory: emptyDirectory,
    nextLaneKey: () => '1',
    createOccupant: () => ({
      dispose: () => {},
      refreshAfterConfigChange: () => {},
      refreshSessionMeta: () => {},
      activeModelKey: () => undefined,
    }),
  })
  void host
  const client = new ShellClient(createLaneMux(rendererTransport).lane(SHELL_LANE))
  await assert.rejects(client.openSession(), /No project is open/)
})

test('open-session reuses a session that already has a pane, and a pane that already has a lane', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'First'))

  const first = await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  const second = await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await settle()

  assert.equal(second.lane, first.lane)
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.attaches.length, 1, 'a lane that exists is activated, never rebuilt')
  assert.deepEqual(h.activates, [first.lane, first.lane])
})

test('open-session resolves a stored session id into a new pane and lane', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'Stored'))
  const result = await h.client.openSession({ sessionId: 's1' })
  await settle()

  assert.equal(result.pane.sessionTitle, 'Stored')
  assert.equal(h.project.store.drafts.length, 0, 'a known id must not mint a draft')
  assert.equal(h.project.openedScopes.length, 0)
  assert.equal(h.workspace.panes.length, 1)
})

test('open-session rejects an unknown session id', async () => {
  const h = createHarness()
  await assert.rejects(h.client.openSession({ sessionId: 'nope' }), /Session not found: nope/)
})

test('openLane attaches a pane the project already adopted, without a second one', async () => {
  // The bootstrap path: the initial scope was adopted before any lane existed,
  // and the first lane must claim *that* pane.
  const h = createHarness()
  const scope = await h.project.openScope(h.project.store.createDraft())
  const adopted = h.workspace.adopt(scope, {})

  const result = await h.host.openLane(h.entry, { sessionId: adopted.getSession().id })

  assert.equal(result.lane, '1')
  assert.equal(h.workspace.panes.length, 1)
  assert.equal(h.project.store.drafts.length, 1)
  assert.equal(result.pane.paneId, adopted.getSession().id)
})

// --- attachPane (the onPaneOpened hand-off) -----------------------------------

test('attachPane dedups on pane identity and activates; a new pane gets a new lane', async () => {
  const h = createHarness()
  const first = await h.host.openLane(h.entry, {})

  // Same pane again: an activation, not a second occupant.
  assert.equal(h.host.attachPane(h.entry, h.workspace.panes[0]!), first.lane)
  assert.equal(h.attaches.length, 1)

  // A genuinely new pane (a host-side `open-pane` created it): a new lane.
  const scope = await h.project.openScope(h.project.store.createDraft('Second'))
  const pane = h.workspace.adopt(scope, {})
  const secondLane = h.host.attachPane(h.entry, pane)
  await settle()
  assert.equal(secondLane, '2')
  assert.equal(h.attaches.length, 2)
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1', '2'])
})

// --- panes ---------------------------------------------------------------------

test('panes reports the topology across projects, in open order', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })

  const beta = h.addProject(fixturePath('repo', 'beta'))
  beta.project.store.sessions.set('s2', sessionOf('s2', 'In beta'))
  await h.client.openSession({ sessionId: 's2', projectRoot: beta.entry.root })
  await settle()

  const lanes = await h.client.panes()
  assert.equal(lanes.length, 2)
  assert.equal(lanes[0]!.projectName, 'alpha')
  assert.equal(lanes[1]!.projectName, 'beta')
  assert.equal(lanes[0]!.lane, '1')
  assert.equal(lanes[1]!.lane, '2')
})

// --- open-project ---------------------------------------------------------------

test('open-project hands the path to the shell and answers ok', async () => {
  const h = createHarness()
  const result = await h.client.openProject(fixturePath('repo', 'gamma'))
  await settle()
  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.openProjectRequests, [fixturePath('repo', 'gamma')])
})

test('open-project without a path still reaches the shell', async () => {
  const h = createHarness()
  await h.client.openProject()
  await settle()
  assert.deepEqual(h.openProjectRequests, [undefined])
})

test('open-project rejects when the shell cannot open projects', async () => {
  const h = createHarness({ withOpenProject: false })
  await assert.rejects(h.client.openProject(fixturePath('repo', 'gamma')), /cannot open projects/)
})

// --- detach ---------------------------------------------------------------------

test('detachLane runs the fixed order and releases the renderer side', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  let rendererCloses = 0
  h.rendererMux.lane(result.lane).onClose(() => {
    rendererCloses += 1
  })

  const sessionId = h.workspace.panes[0]!.getSession().id
  h.host.detachLane(result.lane, 'lane-closed')
  await settle()

  // Occupant disposed, pane closed, lane closed on the renderer side too.
  assert.deepEqual(h.disposed, [result.lane])
  assert.deepEqual(h.workspace.closed.map((pane) => pane.getSession().id), [sessionId])
  assert.equal(rendererCloses, 1)

  // The project had no lanes left, so it was shut down — and the renderer saw
  // the topology update.
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
  assert.deepEqual(h.client.getLanes(), [])
  assert.deepEqual(h.allLanesClosed, ['lane-closed'])
})

test('detachLane is idempotent: a second call does nothing', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  h.host.detachLane(result.lane, 'lane-closed')
  h.host.detachLane(result.lane, 'lane-closed')
  await settle()

  assert.deepEqual(h.disposed, [result.lane])
  assert.equal(h.workspace.closed.length, 1)
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
})

test('detachLane skips project shutdown while quitting', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  h.setQuitting(true)
  h.host.detachLane(result.lane, 'app-quit')
  await settle()

  assert.deepEqual(h.project.shutdowns, [], 'teardown owns project shutdown while quitting')
  assert.deepEqual(h.allLanesClosed, [])
})

test('a project survives while another project loses its last lane', async () => {
  const h = createHarness()
  await h.client.openSession({ projectRoot: h.entry.root })

  const beta = h.addProject(fixturePath('repo', 'beta'))
  beta.project.store.sessions.set('s2', sessionOf('s2'))
  const betaLane = await h.client.openSession({ sessionId: 's2', projectRoot: beta.entry.root })
  await settle()

  h.host.detachLane(betaLane.lane, 'lane-closed')
  await settle()

  assert.deepEqual(beta.project.shutdowns, ['lane-closed'])
  assert.deepEqual(h.project.shutdowns, [])
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), ['1'])
})

test('a project survives losing one lane while another of its lanes is open', async () => {
  const h = createHarness()
  const first = await h.client.openSession({ projectRoot: h.entry.root })
  const second = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()
  assert.notEqual(first.lane, second.lane)

  h.host.detachLane(first.lane, 'lane-closed')
  await settle()

  assert.deepEqual(h.project.shutdowns, [], 'one lane left: the project stays alive')
  assert.deepEqual(h.disposed, [first.lane])
  assert.deepEqual(h.client.getLanes().map((lane) => lane.lane), [second.lane])
  assert.deepEqual(h.allLanesClosed, [])
})

test('detachLaneBySessionId follows a pane id that moved under /clear', async () => {
  const h = createHarness()
  const result = await h.client.openSession({ projectRoot: h.entry.root })
  await settle()

  // `/clear` retargets the controller: the same pane, a new session id. The
  // lane key is the one thing that did not move.
  const pane = h.workspace.panes[0]!
  pane.session = sessionOf('after-clear')
  h.host.broadcastLanes()
  await settle()

  assert.equal(h.host.laneForSessionId('after-clear'), result.lane)
  assert.equal(h.host.laneForSessionId(result.pane.paneId), undefined)
  assert.equal(h.client.getLanes()[0]!.paneId, 'after-clear')

  h.host.detachLaneBySessionId('after-clear', 'lane-closed')
  await settle()

  assert.deepEqual(h.disposed, [result.lane])
  assert.deepEqual(h.project.shutdowns, ['lane-closed'])
})

// --- wire-level failure path ------------------------------------------------------

test('a malformed command on the wire fails by id, not silently', async () => {
  const h = createHarness()
  const fails: Array<{ id: string; message: string }> = []
  h.rendererMux.lane(SHELL_LANE).onMessage((event) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      (event as { type?: unknown }).type === 'fail'
    ) {
      fails.push(event as { id: string; message: string })
    }
  })

  postRawShellCommand(h.rendererMux.lane(SHELL_LANE), {
    type: 'open-session',
    id: 'bad-1',
    bogus: true,
  })
  await settle()

  assert.equal(fails.length, 1)
  assert.equal(fails[0]!.id, 'bad-1')
  assert.match(fails[0]!.message, /bogus/)
})

// --- session history -------------------------------------------------------------

test('list-sessions reports every project, in open order, with sessions newest first', async () => {
  const h = createHarness()
  h.project.store.sessions.set('a-old', { ...sessionOf('a-old', 'Old'), updatedAt: '2026-08-01T00:00:00.000Z' })
  h.project.store.sessions.set('a-new', { ...sessionOf('a-new', 'New'), updatedAt: '2026-08-19T00:00:00.000Z' })
  const beta = h.addProject(fixturePath('repo', 'beta'))
  beta.project.store.sessions.set('b-1', sessionOf('b-1', 'In beta'))

  const result = await h.client.listSessions()

  assert.deepEqual(
    result.projects.map((project) => project.projectName),
    ['alpha', 'beta'],
  )
  assert.equal(result.projects[0]!.projectRoot, h.entry.root)
  assert.deepEqual(
    result.projects[0]!.sessions.map((session) => session.id),
    ['a-new', 'a-old'],
  )
  assert.deepEqual(result.projects[1]!.sessions.map((session) => session.id), ['b-1'])
})

test('list-sessions lists a project with no lane open — history is not the topology', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1', 'Never opened'))

  const result = await h.client.listSessions()

  assert.deepEqual(await h.client.panes(), [], 'no lane exists')
  assert.equal(result.projects.length, 1)
  assert.equal(result.projects[0]!.sessions.length, 1)
})

test('list-sessions covers the registry and the global workspace, not just open projects', async () => {
  // A real registered-but-never-opened project with a real index: the closed
  // half of the sidebar reads through the index peek, not a runtime.
  const closedDir = await mkdtemp(path.join(os.tmpdir(), 'myagent-closed-'))
  await mkdir(getSessionsDir(closedDir), { recursive: true })
  await writeFile(
    path.join(getSessionsDir(closedDir), 'index.json'),
    JSON.stringify({ sessions: [{ id: 'c-1', shortId: 'c-1', createdAt: at(5), updatedAt: at(5), messageCount: 2, title: 'Closed history' }] }),
    'utf8',
  )
  // The scratch home the beforeEach installed, with one global session.
  const home = process.env.USERPROFILE!
  await mkdir(getSessionsDir(home), { recursive: true })
  await writeFile(
    path.join(getSessionsDir(home), 'index.json'),
    JSON.stringify({ sessions: [{ id: 'g-1', shortId: 'g-1', createdAt: at(1), updatedAt: at(1), messageCount: 1, title: 'Global' }] }),
    'utf8',
  )
  try {
    const h = createHarness({ knownProjects: () => Promise.resolve([closedDir]) })
    h.project.store.sessions.set('a-1', sessionOf('a-1', 'Open'))

    const result = await h.client.listSessions()

    // Registry first, open entries the registry missed next, global workspace
    // always last. An empty home (the usual case) is simply absent.
    assert.deepEqual(
      result.projects.map((project) => project.projectName),
      [path.basename(closedDir), 'alpha', '最近'],
    )
    assert.deepEqual(
      result.projects[0]!.sessions.map((session) => session.id),
      ['c-1'],
    )
    assert.equal(result.projects[0]!.sessions[0]!.title, 'Closed history')
    assert.equal(result.projects[2]!.projectRoot, projectRootKey(home))
  } finally {
    await rm(closedDir, { recursive: true, force: true })
  }
})

test('list-sessions keeps a registered project that has no sessions at all', async () => {
  // The row is how the user gets back to the project. Filtering it out on "no
  // history" meant deleting the last session deleted the way back.
  const emptyDir = await mkdtemp(path.join(os.tmpdir(), 'myagent-empty-'))
  try {
    const h = createHarness({ knownProjects: () => Promise.resolve([emptyDir]) })

    const result = await h.client.listSessions()

    assert.deepEqual(
      result.projects.map((project) => project.projectName),
      [path.basename(emptyDir), 'alpha'],
      'the registered project is listed with nothing under it; the empty home is not',
    )
    assert.deepEqual(result.projects[0]!.sessions, [])
    assert.deepEqual(
      result.projects.map((project) => project.isGlobal),
      [false, false],
      'isGlobal rides the wire so the renderer never matches on the name',
    )
    // The key is carried even though the group is not: the welcome screen's
    //「不在项目中工作」names the home workspace exactly when it has no row.
    assert.equal(result.globalRoot, projectRootKey(process.env.USERPROFILE!))
  } finally {
    await rm(emptyDir, { recursive: true, force: true })
  }
})

test('remove-project unregisters a closed project and deletes its history', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-forget-'))
  // Real files: the sweep runs through a transient `SessionStore`, exactly like
  // deleting one session of a closed project does.
  const store = new SessionStore(dir)
  await store.init()
  const first = await store.create('One')
  await store.create('Two')
  try {
    const h = createHarness({ knownProjects: () => Promise.resolve([dir]) })

    const result = await h.client.removeProject(projectRootKey(dir))

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(h.forgottenProjects, [dir], 'the real cwd, not the wire key')
    assert.deepEqual(await new SessionStore(dir).list(), [], 'every session is gone from disk')
    assert.equal(existsSync(path.join(getSessionsDir(dir), `${first.id}.jsonl`)), false)
    assert.deepEqual(h.allLanesClosed, [], 'a closed project holds no lanes to lose')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('remove-project releases the open project lanes before forgetting it', async () => {
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-forget-open-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'One'))
    project.project.store.sessions.set('s2', sessionOf('s2', 'Two'))
    // A lane on the *other* project, so this is not the window's last lane.
    await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await h.client.openSession({ sessionId: 's2', projectRoot: project.entry.root })
    await h.client.openSession({ projectRoot: h.entry.root })
    await settle()

    await h.client.removeProject(project.entry.root)
    await settle()

    assert.deepEqual(
      h.client.getLanes().map((lane) => lane.projectRoot),
      [h.entry.root],
      'both of the removed project lanes are gone',
    )
    assert.equal(project.project.shutdowns.length, 1, 'and its runtime came down')
    assert.equal(h.directory.get(cwd), undefined)
    assert.deepEqual(h.forgottenProjects, [cwd])
    assert.deepEqual(h.allLanesClosed, [], 'the window still has a lane')
    assert.equal(
      project.project.shutdowns.length,
      1,
      'the runtime is down before the files go — a draining project rewrites its index',
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('removing the window only project lands on the global workspace, not on quit', async () => {
  // The `deleteSession` lesson: detaching the last lane fires `onAllLanesClosed`,
  // which quits off darwin. "Take this off my sidebar" is not "I am done".
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-forget-last-'))
  const home = process.env.USERPROFILE!
  try {
    let global: ReturnType<Harness['addProject']> | undefined
    const h = createHarness({
      cwd,
      ensureProject: (target) => {
        global ??= h.addProject(target)
        return Promise.resolve(global.entry)
      },
    })
    h.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
    await settle()

    await h.client.removeProject(h.entry.root)
    await settle()

    assert.deepEqual(h.allLanesClosed, [], 'nothing asked the window to go away')
    assert.deepEqual(h.forgottenProjects, [cwd])
    assert.equal(h.directory.get(cwd), undefined, 'the removed project is down')
    assert.equal(h.project.shutdowns.length, 1)

    const lanes = h.client.getLanes()
    assert.equal(lanes.length, 1, 'a replacement lane took its place')
    assert.equal(lanes[0]!.projectRoot, projectRootKey(home))
    assert.equal(h.activates.at(-1), lanes[0]!.lane, 'and the renderer was asked to show it')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('remove-project refuses the global workspace and roots it never saw', async () => {
  const home = process.env.USERPROFILE!
  // Not open, and not a registry member either: the refusal has to survive the
  // root resolving through the home branch rather than through a live project.
  const store = new SessionStore(home)
  await store.init()
  await store.create('A 最近 session')
  const h = createHarness()

  await assert.rejects(
    h.client.removeProject(projectRootKey(home)),
    /「最近」工作区不能移除/,
  )
  await assert.rejects(
    h.client.removeProject(fixturePath('repo', 'never-opened')),
    /No project is open at/,
  )
  assert.deepEqual(h.forgottenProjects, [])
  assert.equal((await new SessionStore(home).list()).length, 1, 'and it deleted nothing')
})

test('open-session bootstraps a registered project on demand, over the named session', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-ondemand-'))
  try {
    const calls: Array<{ cwd: string; sessionId?: string }> = []
    const h = createHarness({
      knownProjects: () => Promise.resolve([dir]),
      ensureProject: (cwd, options) => {
        calls.push({ cwd, ...(options?.sessionId !== undefined ? { sessionId: options.sessionId } : {}) })
        const opened = h.addProject(cwd)
        opened.project.store.sessions.set('s-remote', sessionOf('s-remote', 'From history'))
        return Promise.resolve(opened.entry)
      },
    })

    const result = await h.client.openSession({ sessionId: 's-remote', projectRoot: projectRootKey(dir) })
    await settle()

    assert.deepEqual(calls, [{ cwd: dir, sessionId: 's-remote' }], 'bootstrapped over the named session')
    assert.equal(result.pane.paneId, 's-remote')
    assert.ok(h.attaches.some((attach) => attach.pane.getSession().id === 's-remote'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('open-session on the global root bootstraps the home workspace by name', async () => {
  // The welcome screen's「不在项目中工作」names the root explicitly, and the home
  // directory is deliberately not a registry member — so without the host's own
  // fallback this is the one root that can be named and never resolved.
  const home = process.env.USERPROFILE!
  const calls: string[] = []
  const h = createHarness({
    knownProjects: () => Promise.resolve([]),
    ensureProject: (cwd) => {
      calls.push(cwd)
      return Promise.resolve(h.addProject(cwd).entry)
    },
  })

  const result = await h.client.openSession({ projectRoot: projectRootKey(home) })
  await settle()

  assert.deepEqual(calls, [home])
  assert.equal(result.pane.projectRoot, projectRootKey(home))
})

test('open-session with nothing open falls back to the global workspace', async () => {
  const calls: string[] = []
  const [mainTransport, rendererTransport] = createMemoryChannelPair()
  const emptyDirectory = new ProjectDirectory<FakeProject, FakeWorkspace>()
  let ensure: ((cwd: string) => ProjectEntry<FakeProject, FakeWorkspace>) | undefined
  const host = new ShellHost<FakeProject, FakePane, FakeWorkspace>({
    mux: createLaneMux(mainTransport),
    directory: emptyDirectory,
    nextLaneKey: () => '1',
    createOccupant: () => ({
      dispose: () => {},
      refreshAfterConfigChange: () => {},
      refreshSessionMeta: () => {},
      activeModelKey: () => undefined,
    }),
    knownProjects: () => Promise.resolve([]),
    ensureProject: (cwd) => {
      calls.push(cwd)
      return Promise.resolve(ensure!(cwd))
    },
  })
  void host
  const client = new ShellClient(createLaneMux(rendererTransport).lane(SHELL_LANE))

  const home = process.env.USERPROFILE!
  ensure = (cwd) => {
    const opened = createProject(emptyDirectory, cwd, [])
    opened.project.store.sessions.set('g-new', sessionOf('g-new'))
    return opened.entry
  }
  const result = await client.openSession()
  await settle()

  assert.deepEqual(calls, [home])
  assert.equal(result.pane.projectRoot, projectRootKey(home))
})

test('delete-session and rename-session reach 最近 with the global runtime closed', async () => {
  // The bug this covers: `knownProjects` filters the home root out by design
  // (it is the implicit global workspace, never a registry member), so every
  // root-keyed command answered "No project is open at <home>" the moment the
  // global runtime's last lane closed — while the sidebar kept drawing its rows.
  const home = process.env.USERPROFILE!
  const store = new SessionStore(home)
  await store.init()
  const created = await store.create('A 最近 session')
  const h = createHarness({ knownProjects: () => Promise.resolve([]) })
  assert.equal(h.directory.get(home), undefined, 'the global workspace is not open')

  await h.client.renameSession(projectRootKey(home), created.id, 'Renamed from the sidebar')
  assert.equal((await store.list()).at(0)?.title, 'Renamed from the sidebar')

  await h.client.deleteSession(projectRootKey(home), created.id)
  assert.deepEqual(await store.list(), [], 'the row the sidebar showed is really gone')
})

test('settings on a closed root bootstrap it and put it back down', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-settings-closed-'))
  try {
    const opened: string[] = []
    // A fresh project per call, like `main.ts`'s `ensureProject`: the previous
    // one has been shut down and dropped from the directory by then.
    const projects: Array<ReturnType<Harness['addProject']>> = []
    const h = createHarness({
      knownProjects: () => Promise.resolve([dir]),
      ensureProject: (cwd) => {
        opened.push(cwd)
        const next = h.addProject(cwd)
        projects.push(next)
        return Promise.resolve(next.entry)
      },
    })

    const settings = await h.client.getSettings(projectRootKey(dir))
    assert.equal(settings.settings.projectRoot, projectRootKey(dir))
    await h.client.changeSettings(projectRootKey(dir), {
      scope: 'provider',
      kind: 'set-model',
      key: 'big',
      model: 'claude-big',
      provider: 'anthropic',
    })

    assert.deepEqual(opened, [dir, dir], 'bootstrapped on demand, once per command')
    assert.ok(projects.at(-1)!.project.config.get().models.big, 'and the edit really landed')
    // No lane holds it, so the transient runtime must not be left behind: it
    // owns MCP clients and background tasks nothing on screen could reach.
    assert.equal(h.directory.get(dir), undefined)
    assert.deepEqual(projects.map((entry) => entry.project.shutdowns.length), [1, 1])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('delete-session and rename-session work on a registered project with no runtime', async () => {
  // Real files: the transient `SessionStore` resolves and rewrites a real index.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-closed-delete-'))
  const store = new SessionStore(dir)
  await store.init()
  const created = await store.create('Transient target')
  try {
    const h = createHarness({ knownProjects: () => Promise.resolve([dir]) })

    await h.client.renameSession(projectRootKey(dir), created.id, 'Renamed while closed')
    assert.equal((await store.list()).at(0)?.title, 'Renamed while closed')

    await h.client.deleteSession(projectRootKey(dir), created.id)
    assert.deepEqual(await store.list(), [], 'the closed project history is gone')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- deleting sessions -----------------------------------------------------------

test('delete-session removes the files and the on-disk artifacts of a closed session', async () => {
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Closed'))
    const artifacts = getSubagentTranscriptDir(cwd, 's1')
    await mkdir(artifacts, { recursive: true })

    const result = await h.client.deleteSession(project.entry.root, 's1')

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(project.project.store.deleted, ['s1'])
    assert.equal(existsSync(artifacts), false, "the session's artifacts went with it")
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session closes the open lane first, then deletes — no ghost row', async () => {
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Open'))
    const opened = await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()
    assert.equal(h.host.laneForSessionId('s1'), opened.lane)

    const result = await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.deepEqual(result, { ok: true })
    assert.deepEqual(h.disposed, [opened.lane], 'the occupant was disposed')
    assert.equal(h.host.laneForSessionId('s1'), undefined)
    // The window's last lane, so a draft takes its place; what must not survive
    // is a row still pointing at `s1`.
    const rows = await h.client.panes()
    assert.deepEqual(rows.map((row) => row.sessionId), ['draft-1'], 'the row is gone, not stale')
    // The order, not just the outcome: a pane still bound to a session whose
    // JSONL just vanished recreates the file on its next append, so the close
    // has to land before the store is touched. Asserted on the shared log,
    // which is the only place the two fakes' relative order is visible.
    assert.deepEqual(
      h.log.filter((line) => line.startsWith('close-pane:') || line.startsWith('store-delete:')),
      ['close-pane:s1', 'store-delete:s1'],
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session deletes by the resolved id, not the prefix it was given', async () => {
  // `SessionStore.delete` accepts a prefix; `deleteSessionArtifacts` does not.
  // Passing the raw wire string through would delete the right session and
  // leave (or worse, mis-target) everything else it wrote.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.resolvePrefixes = true
    project.project.store.sessions.set('abcdef12-full-id', sessionOf('abcdef12-full-id', 'Prefixed'))
    const artifacts = getSubagentTranscriptDir(cwd, 'abcdef12-full-id')
    await mkdir(artifacts, { recursive: true })

    await h.client.deleteSession(project.entry.root, 'abcdef12')

    assert.deepEqual(project.project.store.deleted, ['abcdef12-full-id'])
    assert.equal(existsSync(artifacts), false)
    assert.equal(existsSync(getSubagentTranscriptDir(cwd, 'abcdef12')), false)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('delete-session sweeps an unknown session and rejects an unopened project', async () => {
  const h = createHarness()
  assert.deepEqual(await h.client.deleteSession(h.entry.root, 'nope'), { ok: true })
  assert.deepEqual(h.project.store.deleted, ['nope'])
  await assert.rejects(
    h.client.deleteSession(fixturePath('repo', 'never-opened'), 's1'),
    /No project is open at/,
  )
})

test('deleting a project last lane still reaches the store, and shuts that project down', async () => {
  // The order trap: `detachLane` shuts the project down, after which
  // `directory.get()` no longer finds it. The store and cwd must have been
  // captured before that.
  //
  // A *second* project holds a lane throughout, which is what keeps this on the
  // multi-project side of the split: the window is not losing its last lane, so
  // "this project's last pane went away" means the same thing it always did.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    await h.client.openSession({ projectRoot: h.entry.root })
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    const artifacts = getSubagentTranscriptDir(cwd, 's1')
    await mkdir(artifacts, { recursive: true })
    await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.deepEqual(project.project.shutdowns, ['session-deleted'], 'the project went down')
    assert.equal(h.directory.get(cwd), undefined, 'and left the directory')
    assert.deepEqual(project.project.store.deleted, ['s1'])
    assert.equal(existsSync(artifacts), false)
    assert.deepEqual(h.allLanesClosed, [], 'the other project still holds a lane')
    assert.deepEqual(project.project.store.drafts, [], 'a closing project gets no replacement draft')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deleting the window last lane replaces it with a draft instead of quitting', async () => {
  // D1: `detachLane` treated "the last session was deleted" and "the last pane
  // was closed" as one event, and `onAllLanesClosed` quits the app off darwin —
  // so deleting the only open session took the window with it.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    const opened = await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.deepEqual(h.allLanesClosed, [], 'nothing asked the window to go away')
    assert.deepEqual(project.project.shutdowns, [], 'and the project stayed up')
    assert.equal(h.directory.get(cwd), project.entry, 'still in the directory')
    assert.deepEqual(project.project.store.deleted, ['s1'])

    const [draft] = project.project.store.drafts
    assert.ok(draft, 'a draft took the deleted session place')
    const lanes = h.client.getLanes()
    assert.equal(lanes.length, 1)
    assert.equal(lanes[0]!.sessionId, draft.id)
    assert.notEqual(lanes[0]!.lane, opened.lane, 'a new lane key, never the deleted one')
    assert.equal(h.activates.at(-1), lanes[0]!.lane, 'and the renderer was asked to show it')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('the replacement draft is created after the artifacts are gone', async () => {
  // Order, not just outcome: the sweep must only ever face the id being deleted,
  // so the draft cannot exist while `deleteSessionArtifacts` is running.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()
    const drafts: string[] = []
    // The scope opened for the draft is the first observable moment of it, and
    // the shared log is the only place its order against the store is visible.
    const openScope = project.project.openScope.bind(project.project)
    project.project.openScope = async (session) => {
      h.log.push(`open-scope:${session.id}`)
      drafts.push(session.id)
      return openScope(session)
    }

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.equal(drafts.length, 1)
    assert.deepEqual(
      h.log.filter((line) => /^(close-pane|store-delete|open-scope):/.test(line)),
      ['close-pane:s1', 'store-delete:s1', `open-scope:${drafts[0]}`],
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('a replacement that cannot be opened falls back to the exit path', async () => {
  // The deferral is a promise to put a lane back. If that fails, the project is
  // sitting in the directory with no lanes and no shutdown — orphaned background
  // tasks nothing on screen can reach — so the deferred tail has to run after all.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1', 'Only one'))
    await h.client.openSession({ sessionId: 's1', projectRoot: project.entry.root })
    await settle()
    project.project.openScope = async () => {
      throw new Error('no scope today')
    }

    await assert.rejects(h.client.deleteSession(project.entry.root, 's1'), /no scope today/)
    await settle()

    assert.deepEqual(project.project.store.deleted, ['s1'], 'the delete itself still happened')
    assert.deepEqual(project.project.shutdowns, ['session-deleted'], 'the project went down')
    assert.deepEqual(h.allLanesClosed, ['session-deleted'], 'and the window heard about it')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('deleting a closed session leaves the topology untouched', async () => {
  // Why the renderer must refresh its history off the delete's own reply rather
  // than off a `lanes` event: no lane changed, and `ShellClient` swallows a
  // re-announcement of an identical list on purpose (identity stability). A
  // broadcast here would be dead weight that looked like a refresh signal.
  const h = createHarness()
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-delete-'))
  try {
    const project = h.addProject(cwd)
    project.project.store.sessions.set('s1', sessionOf('s1'))
    project.project.store.sessions.set('s2', sessionOf('s2'))
    await h.client.openSession({ sessionId: 's2', projectRoot: project.entry.root })
    await settle()
    const before = h.laneEvents.length
    const lanesBefore = h.client.getLanes()

    await h.client.deleteSession(project.entry.root, 's1')
    await settle()

    assert.equal(h.laneEvents.length, before, 'no listener was woken')
    assert.equal(h.client.getLanes(), lanesBefore, 'and the list kept its identity')
    assert.deepEqual(project.project.store.deleted, ['s1'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

// --- settings ----------------------------------------------------------------

/** Seeds a config with one keyed endpoint and two models, one of them routed. */
function seedConfig(project: FakeProject): void {
  project.config.config = {
    endpoints: {
      main: { provider: 'anthropic', baseUrl: 'https://api.example', apiKey: 'sk-abcdefghijkl' },
    },
    models: {
      big: { model: 'claude-big', endpoint: 'main', contextWindow: 200_000 },
      small: { model: 'claude-small', endpoint: 'main' },
    },
    routing: { main: 'big' },
    defaultModel: 'big',
    agent: {},
  }
}

test('get-settings sends an endpoint its own key and no model a resolved one', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.getSettings(h.entry.root)

  assert.equal(result.settings.endpoints[0]?.apiKey, 'sk-abcdefghijkl')
  assert.equal(result.settings.endpoints[0]?.baseUrl, 'https://api.example')
  // A spread of `resolveModel()` would copy the endpoint's key onto every model.
  assert.ok(!JSON.stringify(result.settings.models).includes('sk-abcdefghijkl'))
})

test('get-settings projects models, routing and the save target', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const { settings, projects } = await h.client.getSettings(h.entry.root)

  assert.deepEqual(
    settings.models.map((model) => model.key),
    ['big', 'small'],
  )
  assert.equal(settings.models[0]?.contextWindow, 200_000)
  assert.equal(settings.routing.main, 'big')
  assert.equal(settings.routing.plan, 'inherit', 'an unset role reads as inherit')
  assert.deepEqual(
    settings.routing.subagent.map((row) => row.type),
    ['general', 'fork', 'explore', 'plan'],
    'the four built-ins always get a row',
  )
  assert.match(settings.saveTarget, /config\.json$/)
  assert.deepEqual(settings.providers, ['anthropic', 'openai', 'openai-responses'])
  assert.deepEqual(projects, [{ projectRoot: h.entry.root, projectName: 'alpha' }])
})

test('a configured model that cannot resolve is still listed, and says so', async () => {
  const h = createHarness()
  seedConfig(h.project)
  // A model pointing at an endpoint that does not exist — which is what
  // `resolveModel` returns undefined for. It must keep its row: a model that is
  // configured but unusable has to explain itself rather than vanish.
  h.project.config.config.models.broken = { model: 'gone', endpoint: 'missing' }

  const { settings } = await h.client.getSettings(h.entry.root)

  const broken = settings.models.find((model) => model.key === 'broken')
  assert.ok(broken, 'the unresolvable model is still drawn')
  assert.equal(broken?.resolves, false)
  assert.equal(settings.models.find((model) => model.key === 'big')?.resolves, true)
})

test('settings-change saves before reloading, or the reload would discard the edit', async () => {
  const h = createHarness()
  seedConfig(h.project)

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-routing',
    role: 'plan',
    value: 'small',
  })

  const saveAt = h.log.indexOf('config-save')
  const reloadAt = h.log.indexOf(`reload-settings:${h.project.cwd}`)
  assert.ok(saveAt >= 0 && reloadAt >= 0, 'both ran')
  assert.ok(
    saveAt < reloadAt,
    'save must precede reloadSettings: reloadSettings ends in config.load(), which re-reads ' +
      'the layers from disk and destroys an unsaved in-memory mutation',
  )
  assert.equal(h.project.config.config.routing?.plan, 'small', 'and the edit survived')
})

test('a model save drops the retired 1M header switch and carries JSON-only fields', async () => {
  const h = createHarness()
  seedConfig(h.project)
  h.project.config.config.models.big!.promptCaching = 'on'
  Object.assign(h.project.config.config.models.big!, { longContext1m: true })

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-model',
    key: 'big',
    model: 'claude-big',
    endpoint: 'main',
    contextWindow: 1_000_000,
  })

  const saved = h.project.config.config.models.big as unknown as Record<string, unknown>
  assert.equal('longContext1m' in saved, false)
  assert.equal(saved.contextWindow, 1_000_000)
  assert.equal(saved.promptCaching, 'on')
})

test('the image-input switch persists, and the snapshot carries the effective marker', async () => {
  const h = createHarness()
  seedConfig(h.project)
  // A second endpoint on a provider whose adapter carries no images: the raw
  // switch and the effective capability must be able to disagree.
  h.project.config.config.endpoints!.custom = { provider: 'custom-proxy' }
  h.project.config.config.models.pickya = {
    model: 'custom-vision',
    endpoint: 'custom',
    supportsImageInput: true,
  }

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-model',
    key: 'big',
    model: 'claude-big',
    endpoint: 'main',
    supportsImageInput: true,
  })
  assert.equal(h.project.config.config.models.big?.supportsImageInput, true)

  const { settings } = await h.client.getSettings(h.entry.root)
  const big = settings.models.find((model) => model.key === 'big')
  assert.equal(big?.supportsImageInput, true, 'the raw switch seeds the edit form')
  assert.equal(big?.imageCapable, true, 'anthropic resolves capable')
  // The declaration survives on a provider that cannot honour it: the marker
  // says no, the switch still says yes, and neither silently rewrites the other.
  const pickya = settings.models.find((model) => model.key === 'pickya')
  assert.equal(pickya?.supportsImageInput, true)
  assert.equal(pickya?.imageCapable, undefined)

  // Switching it off omits the field, and the rebuild removes it.
  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-model',
    key: 'big',
    model: 'claude-big',
    endpoint: 'main',
  })
  assert.equal(h.project.config.config.models.big?.supportsImageInput, undefined)
})

test('one edit reloads the project once and refreshes every lane of it', async () => {
  const h = createHarness()
  seedConfig(h.project)
  for (const id of ['s1', 's2', 's3']) h.project.store.sessions.set(id, sessionOf(id))
  for (const id of ['s1', 's2', 's3']) {
    await h.client.openSession({ sessionId: id, projectRoot: h.entry.root })
  }
  await settle()

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-routing',
    role: 'main',
    value: 'small',
  })

  assert.equal(h.project.reloads, 1, 'reloadSettings is per project, not per lane')
  assert.equal(h.configRefreshes.length, 3, 'every lane of the project rebuilt')
  assert.equal(result.rebuiltLanes, 3)
  assert.deepEqual(
    h.configRefreshes.map((refresh) => refresh.scope),
    ['routing', 'routing', 'routing'],
    'a routing edit re-resolves against routing, not models',
  )
  assert.ok(
    h.configRefreshes.every((refresh) => refresh.rebuild),
    'a provider edit always rebuilds - needsRuntimeRebuild is only hooksChanged, so it cannot be consulted',
  )
})

test('a global provider edit reloads every open project and refreshes their lanes', async () => {
  const h = createHarness()
  seedConfig(h.project)
  const other = h.addProject(fixturePath('repo', 'beta'))
  seedConfig(other.project)
  h.project.store.sessions.set('s1', sessionOf('s1'))
  other.project.store.sessions.set('s2', sessionOf('s2'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await h.client.openSession({ sessionId: 's2', projectRoot: other.entry.root })
  await settle()

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-default-model',
    key: 'small',
  })

  assert.equal(h.configRefreshes.length, 2)
  assert.equal(h.project.reloads, 1)
  assert.equal(other.project.reloads, 1, 'the global configuration reaches the other project too')
})

test('removing a global model checks running turns in other projects before saving', async () => {
  const h = createHarness()
  seedConfig(h.project)
  const other = h.addProject(fixturePath('repo', 'beta'))
  seedConfig(other.project)
  const lane = await h.host.openLane(other.entry, {})
  h.runOn(lane.lane, 'big')

  await assert.rejects(
    h.client.changeSettings(h.entry.root, { scope: 'provider', kind: 'remove-model', key: 'big' }),
    /在跑/,
  )
  assert.ok(h.project.config.config.models.big)
  assert.equal(h.project.config.saves, 0)
})

test('a model a routing role names is deleted anyway, and the role degrades', async () => {
  const h = createHarness()
  seedConfig(h.project)

  await h.client.changeSettings(h.entry.root, { scope: 'provider', kind: 'remove-model', key: 'big' })

  assert.equal(h.project.config.config.models.big, undefined, 'a routed model is still deletable')
  assert.equal(h.project.config.getRouting().main, 'inherit')
})

test('a model a turn is running on cannot be removed, and nothing is written', async () => {
  const h = createHarness()
  seedConfig(h.project)
  const lane = await h.host.openLane(h.entry, {})
  h.runOn(lane.lane, 'big')

  await assert.rejects(
    h.client.changeSettings(h.entry.root, { scope: 'provider', kind: 'remove-model', key: 'big' }),
    /在跑/,
  )
  assert.equal(h.project.config.saves, 0, 'the refusal came before anything was written')
  assert.ok(h.project.config.config.models.big, 'and the model is untouched')

  // The lane going idle is all it takes; nothing else had to change.
  h.runOn(lane.lane, undefined)
  await h.client.changeSettings(h.entry.root, { scope: 'provider', kind: 'remove-model', key: 'big' })
  assert.equal(h.project.config.config.models.big, undefined)
})

test('an endpoint whose model is mid-turn is refused as a whole', async () => {
  const h = createHarness()
  seedConfig(h.project)
  const lane = await h.host.openLane(h.entry, {})
  h.runOn(lane.lane, 'big')

  await assert.rejects(
    h.client.changeSettings(h.entry.root, { scope: 'provider', kind: 'remove-endpoint', name: 'main' }),
    /在跑/,
  )
  // The cascade is what makes this reachable: `big` resolves through `main`, so
  // removing the endpoint would have taken the running model with it.
  assert.ok(h.project.config.config.endpoints?.main, 'the endpoint survived the refusal')
  assert.ok(h.project.config.config.models.big)
})

test('set-endpoint without an apiKey leaves the stored key alone', async () => {
  const h = createHarness()
  seedConfig(h.project)
  h.project.config.config.endpoints!.main!.promptCaching = 'off'

  // What the form sends when the user edited the base URL but never touched the
  // key field, which is showing a mask.
  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-endpoint',
    name: 'main',
    provider: 'anthropic',
    baseUrl: 'https://api.changed',
  })

  assert.equal(h.project.config.config.endpoints?.main?.apiKey, 'sk-abcdefghijkl')
  assert.equal(h.project.config.config.endpoints?.main?.baseUrl, 'https://api.changed')
  assert.equal(h.project.config.config.endpoints?.main?.promptCaching, 'off')
})

test('clear-endpoint-key is the only way a key is removed', async () => {
  const h = createHarness()
  seedConfig(h.project)
  h.project.config.config.endpoints!.main!.promptCaching = 'off'

  await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'clear-endpoint-key',
    name: 'main',
  })

  assert.equal(h.project.config.config.endpoints?.main?.apiKey, undefined)
  assert.equal(h.project.config.config.endpoints?.main?.provider, 'anthropic', 'the rest survives')
  assert.equal(h.project.config.config.endpoints?.main?.promptCaching, 'off')
})

test('set-default-model with an unresolvable key is a no-op, as the service defines it', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'set-default-model',
    key: 'nope',
  })

  assert.equal(result.settings.defaultModel, 'big', 'the default did not move')
})

test('rename-model carries the routing reference with it', async () => {
  const h = createHarness()
  seedConfig(h.project)

  const result = await h.client.changeSettings(h.entry.root, {
    scope: 'provider',
    kind: 'rename-model',
    from: 'big',
    to: 'huge',
  })

  assert.equal(result.settings.routing.main, 'huge')
  assert.ok(result.settings.models.some((model) => model.key === 'huge'))
})

// --- permissions, agents, MCP and the context budget -------------------------

/**
 * A harness whose project is a real directory.
 *
 * The provider cases above need none of this — they go through `FakeConfig`. A
 * permissions, trust or cache edit goes through the shipping
 * `settings.local.json` writer, so there has to be a directory to write into and
 * a `settings.json` above it to inherit from.
 */
async function withSettingsDir(
  projectSettings: Record<string, unknown>,
  run: (h: Harness, cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-shell-settings-'))
  try {
    await mkdir(path.join(cwd, '.myagent'), { recursive: true })
    await writeFile(
      path.join(cwd, '.myagent', 'settings.json'),
      JSON.stringify(projectSettings),
      'utf8',
    )
    const h = createHarness({ cwd })
    seedConfig(h.project)
    // Stands in for the load `bootstrap()` does; a constructor cannot await.
    await h.project.loadSettings()
    await run(h, cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

async function readLocalLayer(cwd: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(localSettingsPath(cwd), 'utf8')) as Record<
    string,
    unknown
  >
}

/** One open lane, so "did this rebuild anything" is observable. */
async function openOneLane(h: Harness): Promise<void> {
  h.project.store.sessions.set('s1', sessionOf('s1'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await settle()
}

test('a permissions edit writes the local layer, saves no config and rebuilds nothing', async () => {
  await withSettingsDir({ permissions: { allow: ['Read'] } }, async (h, cwd) => {
    await openOneLane(h)

    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'allow',
      entries: ['Bash(ls:*)'],
    })

    // `config.save()` writes the whole merged `Config`, so calling it here would
    // copy every settings-declared model and endpoint into config.json as a side
    // effect of adding one rule.
    assert.equal(h.project.config.saves, 0)
    assert.deepEqual((await readLocalLayer(cwd)).permissions, { allow: ['Bash(ls:*)'] })
    // Rules are read live by `reloadSettings`, so replacing the runtimes would
    // throw away their prompt caches for nothing.
    assert.equal(h.configRefreshes.length, 0)
    assert.equal(result.rebuiltLanes, 0)

    const allow = result.settings.permissions.groups.find((group) => group.behavior === 'allow')
    assert.deepEqual(allow, { behavior: 'allow', local: ['Bash(ls:*)'], inherited: ['Read'] })
    assert.match(result.settings.permissions.localPath, /settings\.local\.json$/)
  })
})

test('an inherited rule is never copied into the local layer by an edit', async () => {
  await withSettingsDir({ permissions: { deny: ['Bash(rm -rf:*)'] } }, async (h, cwd) => {
    // The whole-group write is what makes this possible *and* what would break
    // it: writing the merged group back is the bug this guards.
    await h.client.changeSettings(h.entry.root, {
      scope: 'permissions',
      kind: 'set-permission-entries',
      behavior: 'deny',
      entries: ['Delete'],
    })

    assert.deepEqual((await readLocalLayer(cwd)).permissions, { deny: ['Delete'] })
    const { settings } = await h.client.getSettings(h.entry.root)
    const deny = settings.permissions.groups.find((group) => group.behavior === 'deny')
    assert.deepEqual(deny, { behavior: 'deny', local: ['Delete'], inherited: ['Bash(rm -rf:*)'] })
  })
})

test('a removal is a shorter group, and it really shortens the file', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    const write = (entries: string[]) =>
      h.client.changeSettings(h.entry.root, {
        scope: 'permissions',
        kind: 'set-permission-entries',
        behavior: 'ask',
        entries,
      })

    await write(['Bash(git push:*)', 'Delete'])
    const result = await write(['Delete'])

    assert.deepEqual((await readLocalLayer(cwd)).permissions, { ask: ['Delete'] })
    const ask = result.settings.permissions.groups.find((group) => group.behavior === 'ask')
    assert.deepEqual(ask?.local, ['Delete'])
  })
})

test('the startup mode is stored locally and reported as local', async () => {
  await withSettingsDir({ permissions: { mode: 'default' } }, async (h, cwd) => {
    const before = await h.client.getSettings(h.entry.root)
    assert.equal(before.settings.permissions.mode, 'default')
    assert.equal(before.settings.permissions.modeIsLocal, false, 'it came from the project layer')

    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'permissions',
      kind: 'set-startup-permission-mode',
      mode: 'auto',
    })

    assert.deepEqual((await readLocalLayer(cwd)).permissions, { mode: 'auto' })
    // Last-writer-wins across layers and the local layer is last, so unlike the
    // concatenated groups this really does override what sits above it.
    assert.equal(result.settings.permissions.mode, 'auto')
    assert.equal(result.settings.permissions.modeIsLocal, true)
    assert.equal(h.project.config.saves, 0)
  })
})

test('coordination settings: local layer, inherit clears, strict validation', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    seedConfig(h.project)
    const defaults = (await h.client.getSettings(h.entry.root)).settings.coordination
    assert.deepEqual(defaults, { quietDays: 3, autoResolveDays: 7 })

    await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-model', role: 'coordinator', value: 'small',
    })
    await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-effort', role: 'thread', value: 'high',
    })
    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-days', field: 'autoResolveDays', value: 0,
    })
    assert.deepEqual((await readLocalLayer(cwd)).coordination, {
      coordinatorModel: 'small', threadEffort: 'high', autoResolveDays: 0,
    })
    assert.deepEqual(result.settings.coordination, {
      coordinatorModel: 'small', threadEffort: 'high', quietDays: 3, autoResolveDays: 0,
    })
    assert.equal(result.rebuiltLanes, 0)
    assert.equal(h.project.config.saves, 0)

    await assert.rejects(
      h.client.changeSettings(h.entry.root, {
        scope: 'agent', kind: 'set-coordination-model', role: 'thread', value: 'nope',
      }),
      /No model named nope/,
    )
    for (const value of [1.5, -1]) {
      await assert.rejects(
        h.client.changeSettings(h.entry.root, {
          scope: 'agent', kind: 'set-coordination-days', field: 'quietDays', value,
        }),
      )
    }
    assert.equal(
      parseShellCommand({
        type: 'settings-change', id: 'x', projectRoot: 'r',
        change: { scope: 'agent', kind: 'set-coordination-effort', role: 'thread', value: 'bogus' },
      }).ok,
      false,
    )

    const cleared = await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-model', role: 'coordinator', value: 'inherit',
    })
    assert.equal(cleared.settings.coordination.coordinatorModel, undefined)
    await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-effort', role: 'thread', value: 'inherit',
    })
    await h.client.changeSettings(h.entry.root, {
      scope: 'agent', kind: 'set-coordination-days', field: 'autoResolveDays', value: 7,
    })
    assert.deepEqual((await readLocalLayer(cwd)).coordination, { autoResolveDays: 7 })
  })
})

test('the cache toggle rebuilds the lanes; the context numbers do not', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    await openOneLane(h)

    // `cacheRuntime` is captured when a runtime is built, so this one is only
    // applied by replacing the runtime.
    const cache = await h.client.changeSettings(h.entry.root, {
      scope: 'general',
      kind: 'set-cache-ttl',
      enabled: true,
    })
    assert.deepEqual((await readLocalLayer(cwd)).cache, { ttl1h: true })
    assert.equal(cache.settings.general.cacheTtl1h, true)
    assert.equal(cache.rebuiltLanes, 1)
    assert.equal(h.project.config.saves, 0)

    // The context numbers are snapshotted into the session scope at bootstrap, so
    // a rebuild would not reach them either — and pretending otherwise is what
    // the "restart to apply" note on those rows exists to avoid.
    const context = await h.client.changeSettings(h.entry.root, {
      scope: 'general',
      kind: 'set-context-management',
      field: 'contextWindow',
      value: 400_000,
    })
    assert.equal(context.rebuiltLanes, 0)
    assert.equal(h.project.config.saves, 1, 'this one is config.json, so it does save')
    assert.equal(context.settings.contextManagement.contextWindow, 400_000)
    assert.equal(
      context.settings.contextManagement.summaryOutputTokens,
      20_000,
      'the other five keep their values',
    )
  })
})

test('a context number that cannot mean anything is rejected and saves nothing', async () => {
  await withSettingsDir({}, async (h) => {
    await assert.rejects(
      h.client.changeSettings(h.entry.root, {
        scope: 'general',
        kind: 'set-context-management',
        field: 'autoCompactThresholdRatio',
        value: 1.5,
      }),
      /ratio in \(0, 1]/,
    )
    assert.equal(h.project.config.saves, 0)
    assert.equal(h.project.reloads, 0, 'the reload never ran either')
  })
})

test('trusting a server writes the local layer and then reconnects, in that order', async () => {
  await withSettingsDir(
    { mcpServers: { github: { transport: 'stdio', command: 'npx', args: ['github-mcp'] } } },
    async (h, cwd) => {
      const result = await h.client.changeSettings(h.entry.root, {
        scope: 'extensions',
        kind: 'set-mcp-trust',
        name: 'github',
        trusted: true,
      })

      assert.deepEqual((await readLocalLayer(cwd)).mcp, { trustedServers: ['github'] })
      assert.equal(h.project.mcpReloads, 1)
      // The reconnect reads the settings the *runtime* holds, so it has to run
      // after the reload has replaced them — otherwise it re-applies the trust
      // list from before this edit and the server stays untrusted.
      const reloadAt = h.log.indexOf(`reload-settings:${h.project.cwd}`)
      const reconnectAt = h.log.indexOf(`reload-mcp:${h.project.cwd}`)
      assert.ok(reloadAt >= 0 && reconnectAt >= 0, 'both ran')
      assert.ok(reloadAt < reconnectAt, 'the reconnect must see the new trust list')
      assert.equal(result.settings.mcpServers[0]?.trusted, true)
      assert.equal(result.settings.mcpServers[0]?.trustEditable, true)
    },
  )
})

test('a trust that came from above is reported as not editable here', async () => {
  await withSettingsDir(
    { mcpServers: { shared: { transport: 'sse', url: 'https://mcp.example' } } },
    async (h) => {
      const userFile = path.join(getGlobalMyAgentDir(), 'settings.json')
      await mkdir(path.dirname(userFile), { recursive: true })
      await writeFile(userFile, JSON.stringify({ mcp: { trustedServers: ['shared'] } }), 'utf8')
      await h.project.loadSettings()
      h.project.mcp.failed.push({ name: 'shared', error: 'connect ECONNREFUSED' })

      const { settings } = await h.client.getSettings(h.entry.root)

      // `mcp.trustedServers` is unioned across layers, so removing it from the
      // local layer cannot revoke it. A toggle that silently did nothing would
      // be worse than a disabled one.
      assert.deepEqual(settings.mcpServers, [
        {
          name: 'shared',
          transport: 'sse',
          target: 'https://mcp.example',
          trusted: true,
          trustEditable: false,
          status: 'failed',
          error: 'connect ECONNREFUSED',
        },
      ])
    },
  )
})

test('adding a server trusts it, but editing one never re-grants a revoked trust', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-server',
      name: 'sqlite',
      server: { transport: 'stdio', command: 'sqlite-mcp' },
    })
    // Adding a server by hand *is* the grant, so the prompt never has to fire.
    assert.deepEqual((await readLocalLayer(cwd)).mcp, { trustedServers: ['sqlite'] })

    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-trust',
      name: 'sqlite',
      trusted: false,
    })
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-server',
      name: 'sqlite',
      server: { transport: 'stdio', command: 'sqlite-mcp', args: ['--wal'] },
    })

    const local = await readLocalLayer(cwd)
    assert.deepEqual(local.mcp, { trustedServers: [] }, 'fixing an arg must not undo a revocation')
    assert.deepEqual(local.mcpServers, {
      sqlite: { transport: 'stdio', command: 'sqlite-mcp', args: ['--wal'] },
    })
  })
})

test('renaming a server moves its config and its trust, leaving nothing behind', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-server',
      name: 'sqlite',
      server: { transport: 'stdio', command: 'sqlite-mcp' },
    })
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-server',
      name: 'db',
      server: { transport: 'stdio', command: 'sqlite-mcp' },
      previousName: 'sqlite',
    })

    const local = await readLocalLayer(cwd)
    assert.deepEqual(local.mcpServers, { db: { transport: 'stdio', command: 'sqlite-mcp' } })
    // Trust is keyed by name alone: a left-behind `sqlite` would pre-trust the
    // next server to take that name.
    assert.deepEqual(local.mcp, { trustedServers: ['db'] })
  })
})

test('deleting a server takes its trust entry with it', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-mcp-server',
      name: 'sqlite',
      server: { transport: 'stdio', command: 'sqlite-mcp' },
    })
    await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'remove-mcp-server',
      name: 'sqlite',
    })

    const local = await readLocalLayer(cwd)
    assert.deepEqual(local.mcpServers, {})
    assert.deepEqual(local.mcp, { trustedServers: [] })
  })
})

test('a local server that overrides an inherited one says so', async () => {
  await withSettingsDir(
    { mcpServers: { github: { transport: 'stdio', command: 'npx', args: ['github-mcp'] } } },
    async (h) => {
      await h.client.changeSettings(h.entry.root, {
        scope: 'extensions',
        kind: 'set-mcp-server',
        name: 'github',
        server: { transport: 'stdio', command: 'npx', args: ['github-mcp', '--beta'] },
      })

      const { settings } = await h.client.getSettings(h.entry.root)
      const github = settings.mcpServers.find((server) => server.name === 'github')
      assert.equal(github?.isLocal, true)
      // Deleting this row uncovers the project layer's server rather than
      // removing it, and the screen has to be able to say so.
      assert.equal(github?.shadowsInherited, true)
    },
  )
})

/** Writes `<cwd>/.myagent/skills/<name>/SKILL.md` with the frontmatter a skill needs. */
async function writeSkill(cwd: string, name: string, description: string): Promise<void> {
  const dir = path.join(cwd, '.myagent', 'skills', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
    'utf8',
  )
}

test('the snapshot lists every skill on disk, switched-off ones included', async () => {
  await withSettingsDir({ skills: { disabled: ['beta'] } }, async (h, cwd) => {
    await writeSkill(cwd, 'alpha', 'The first skill')
    await writeSkill(cwd, 'beta', 'The second skill')

    const { settings } = await h.client.getSettings(h.entry.root)

    assert.deepEqual(
      settings.skills.map((skill) => [skill.name, skill.enabled]),
      [
        ['alpha', true],
        ['beta', false],
      ],
      'a disabled skill still has a row — it is what the switch turns back on',
    )
    assert.equal(settings.skills[0]?.inclusion, 'manual')
    assert.equal(settings.skills[0]?.description, 'The first skill')
    assert.equal(settings.skillsDir, path.join(cwd, '.myagent', 'skills'))
  })
})

test('switching a skill off writes the local layer, reloads the skills and rebuilds the lanes', async () => {
  await withSettingsDir({}, async (h, cwd) => {
    await writeSkill(cwd, 'demo', 'A demo skill')
    await openOneLane(h)

    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-skill-enabled',
      name: 'demo',
      enabled: false,
    })

    assert.deepEqual((await readLocalLayer(cwd)).skills, { disabled: ['demo'] })
    assert.equal(h.project.config.saves, 0, 'nothing belongs in config.json')
    assert.equal(h.project.skillReloads, 1)
    // The service decides what is on from the *merged* layers, so the reload
    // has to run after `reloadSettings()` has replaced them.
    const reloadAt = h.log.indexOf(`reload-settings:${h.project.cwd}`)
    const skillsAt = h.log.indexOf(`reload-skills:${h.project.cwd}`)
    assert.ok(reloadAt >= 0 && skillsAt >= 0, 'both ran')
    assert.ok(reloadAt < skillsAt, 'the skill reload must see the new disabled list')
    // A runtime is handed the skill list it was built with, so without the
    // rebuild the switch would only reach the next session.
    assert.equal(result.rebuiltLanes, 1)
    assert.equal(result.settings.skills[0]?.enabled, false)

    const back = await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'set-skill-enabled',
      name: 'demo',
      enabled: true,
    })
    assert.deepEqual((await readLocalLayer(cwd)).skills, { disabled: [] })
    assert.equal(back.settings.skills[0]?.enabled, true)
  })
})

test('reload-skills reloads once per project and writes nothing at all', async () => {
  await withSettingsDir({}, async (h) => {
    const other = h.addProject(fixturePath('repo', 'beta'))
    seedConfig(other.project)

    await h.client.changeSettings(h.entry.root, { scope: 'extensions', kind: 'reload-skills' })

    assert.equal(h.project.skillReloads, 1)
    assert.equal(other.project.skillReloads, 0)
    assert.equal(h.project.config.saves, 0)
  })
})

test('reconnect-mcp reconnects once per project and writes nothing at all', async () => {
  await withSettingsDir({}, async (h) => {
    const other = h.addProject(fixturePath('repo', 'beta'))
    seedConfig(other.project)

    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'extensions',
      kind: 'reconnect-mcp',
    })

    assert.equal(h.project.mcpReloads, 1)
    assert.equal(other.project.mcpReloads, 0)
    assert.equal(h.project.config.saves, 0)
    assert.equal(result.rebuiltLanes, 0)
  })
})

test('reloading agent definitions rebuilds the lanes, so the live Agent tool sees them', async () => {
  await withSettingsDir({}, async (h) => {
    await openOneLane(h)

    const result = await h.client.changeSettings(h.entry.root, {
      scope: 'agent',
      kind: 'reload-agent-definitions',
    })

    assert.equal(h.project.agentReloads, 1)
    assert.equal(h.project.config.saves, 0)
    // A runtime hands its Agent tool the definitions that existed when it was
    // built, so without this the reload only reaches the *next* runtime.
    assert.equal(result.rebuiltLanes, 1)
    assert.deepEqual(h.configRefreshes.map((refresh) => refresh.rebuild), [true])
  })
})

test('get-settings projects the agent definitions and the context budget', async () => {
  await withSettingsDir({}, async (h) => {
    h.project.agentDefinitions = [
      ...BUILT_IN_AGENT_DEFINITIONS,
      {
        type: 'reviewer',
        description: 'Reviews a diff',
        tools: ['Read'],
        permissionMode: 'plan',
        disallowedTools: ['Agent'],
        maxTurns: 12,
        isReadOnlyAgent: true,
        getSystemPrompt: () => 'review it',
      },
    ]
    h.project.config.config.routing = { main: 'big', subagent: { reviewer: 'small' } }

    const { settings } = await h.client.getSettings(h.entry.root)

    const reviewer = settings.agents.find((agent) => agent.type === 'reviewer')
    assert.deepEqual(reviewer, {
      type: 'reviewer',
      description: 'Reviews a diff',
      builtIn: false,
      permissionMode: 'plan',
      tools: ['Read'],
      maxTurns: 12,
      isReadOnlyAgent: true,
      routing: 'small',
    })
    const general = settings.agents.find((agent) => agent.type === 'general')
    assert.equal(general?.builtIn, true)
    assert.equal(general?.tools, undefined, 'no tool list means every tool, and the wire says so by omission')
    // Functions cannot cross `structuredClone`, so the projection must be field
    // by field — a spread would put `getSystemPrompt` on the wire.
    assert.ok(!JSON.stringify(settings.agents).includes('review it'))

    assert.equal(settings.contextManagement.contextWindow, 200_000, 'merged over the defaults')
    assert.equal(settings.general.cacheTtl1h, undefined, 'unset is not false')
  })
})

test('rename-session resolves a prefix and refreshes only that lane', async () => {
  const h = createHarness()
  h.project.store.resolvePrefixes = true
  h.project.store.sessions.set('abcdef1234', sessionOf('abcdef1234'))
  h.project.store.sessions.set('zzzz', sessionOf('zzzz'))
  await h.client.openSession({ sessionId: 'abcdef1234', projectRoot: h.entry.root })
  await h.client.openSession({ sessionId: 'zzzz', projectRoot: h.entry.root })
  await settle()

  const result = await h.client.renameSession(h.entry.root, 'abcdef', 'new title')
  await settle()

  assert.deepEqual(result, { ok: true, title: 'new title' })
  assert.deepEqual(
    h.project.store.renamed,
    [{ id: 'abcdef1234', title: 'new title' }],
    'the store is given the resolved id, never the prefix',
  )
  assert.equal(h.metaRefreshes.length, 1, 'only the renamed session lane heard about it')
  assert.equal(h.metaRefreshes[0]?.session.title, 'new title')
})

test('renaming a closed session succeeds and refreshes no occupant', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))

  const result = await h.client.renameSession(h.entry.root, 's1', 'renamed')
  await settle()

  assert.equal(result.ok, true)
  assert.equal(h.metaRefreshes.length, 0)
})

test('rename-session broadcasts, because sessionTitle is a lane field', async () => {
  const h = createHarness()
  h.project.store.sessions.set('s1', sessionOf('s1'))
  await h.client.openSession({ sessionId: 's1', projectRoot: h.entry.root })
  await settle()
  const before = h.laneEvents.length

  await h.client.renameSession(h.entry.root, 's1', 'renamed')
  await settle()

  assert.ok(
    h.laneEvents.length > before,
    'unlike delete-session this does change the topology the client compares',
  )
})

// --- open-in-editor ----------------------------------------------------------

test('open-in-editor hands over the project cwd, not the normalized root', async () => {
  // The lane list only carries the *key*, so that is what the renderer can name;
  // handing that key to a process would pass a case-folded path on Windows.
  const h = createHarness({ cwd: fixturePath('Repo', 'Alpha') })

  const result = await h.client.openInEditor(h.entry.root)

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(h.editorRequests, [{ cwd: fixturePath('Repo', 'Alpha') }])
  assert.notEqual(h.entry.root, fixturePath('Repo', 'Alpha'), 'the key differs from the cwd, or this proves nothing')
})

test('open-in-editor reports a launch failure rather than answering ok', async () => {
  const h = createHarness()
  h.failEditor('code is not installed')

  await assert.rejects(h.client.openInEditor(h.entry.root), /code is not installed/)
  assert.equal(h.editorRequests.length, 1, 'the path was handed over before the failure')
})

test('open-in-editor rejects when the shell has no editor and for an unknown project', async () => {
  const withoutEditor = createHarness({ withOpenInEditor: false })
  await assert.rejects(
    withoutEditor.client.openInEditor(withoutEditor.entry.root),
    /cannot open an editor/,
  )

  const h = createHarness()
  await assert.rejects(h.client.openInEditor(fixturePath('repo', 'never-opened')), /No project is open/)
  assert.deepEqual(h.editorRequests, [], 'an unknown project must not reach the editor at all')
})

test('open-in-editor resolves a search hit against the real cwd, line and all', async () => {
  // T15: a clicked path arrives cwd-relative — the renderer only holds the
  // normalized root key, which on Windows is a case-folded path that may not
  // exist — so the host is the one place that can join it to the project's
  // real cwd. `entry.cwd`, not `entry.root`, same rule as the folder open.
  const h = createHarness({ cwd: fixturePath('Repo', 'Alpha') })

  await h.client.openInEditor(h.entry.root, { path: path.join('src', 'a b.ts'), line: 12 })
  await h.client.openInEditor(h.entry.root, { path: path.join('src', 'c.ts') })

  assert.deepEqual(h.editorRequests, [
    { cwd: fixturePath('Repo', 'Alpha'), target: { path: fixturePath('Repo', 'Alpha', 'src', 'a b.ts'), line: 12 } },
    { cwd: fixturePath('Repo', 'Alpha'), target: { path: fixturePath('Repo', 'Alpha', 'src', 'c.ts') } },
  ])
})

test('a target outside the project is refused before it reaches the editor', async () => {
  // The renderer cannot be trusted to name files any more than directories:
  // the search tool that printed the path already kept it inside the cwd, so
  // this is a backstop — and it must fire *before* the hand-off, or the refusal
  // would answer `ok` for an editor that never opened what was asked.
  const h = createHarness()

  await assert.rejects(
    h.client.openInEditor(h.entry.root, { path: path.join('..', 'outside.txt') }),
    /在项目目录之外/,
  )
  await assert.rejects(
    h.client.openInEditor(h.entry.root, { path: fixturePath('other', 'root', 'a.ts') }),
    /在项目目录之外/,
  )
  assert.deepEqual(h.editorRequests, [], 'a refused path must not reach the editor at all')
})

// --- set-window-theme (5g) ---------------------------------------------------

test('set-window-theme reaches the window, and carries a theme rather than a colour', async () => {
  const h = createHarness()

  assert.deepEqual(await h.client.setWindowTheme('light'), { ok: true })
  assert.deepEqual(await h.client.setWindowTheme('dark'), { ok: true })
  assert.deepEqual(h.windowThemes, ['light', 'dark'])
})

test('set-window-theme answers ok on a shell with no overlay', async () => {
  // Unlike `open-project` and `open-in-editor`, whose missing callbacks reject:
  // those are user-visible actions that silently did nothing, while an overlay is
  // chrome that a platform may simply not have. Rejecting would put a native-chrome
  // detail into the transcript on every theme switch.
  const h = createHarness({ withWindowTheme: false })

  assert.deepEqual(await h.client.setWindowTheme('dark'), { ok: true })
  assert.deepEqual(h.windowThemes, [])
})

// --- pick-images (S11) --------------------------------------------------------

test('pick-images answers the chosen paths and anchors to the open project', async () => {
  const h = createHarness()
  h.setPickedImages([fixturePath('repo', 'alpha', 'shot.png'), fixturePath('repo', 'alpha', 'diagram.png')])

  // `projectRoot` is the normalized key the lane list carries; the shell
  // resolves it to the real cwd and the dialog opens there.
  assert.deepEqual(
    await h.client.pickImages(h.entry.root),
    { ok: true, paths: [fixturePath('repo', 'alpha', 'shot.png'), fixturePath('repo', 'alpha', 'diagram.png')] },
  )
  assert.deepEqual(h.pickedImageAnchors, [{ defaultPath: fixturePath('repo', 'alpha') }])
})

test('a cancelled picker answers empty paths, and an unanchored pick omits the anchor', async () => {
  const h = createHarness()
  h.setPickedImages(undefined)

  assert.deepEqual(await h.client.pickImages(), { ok: true, paths: [] })
  assert.deepEqual(h.pickedImageAnchors, [{}], 'no projectRoot means the dialog opens unanchored')

  // An unknown root is an unanchored dialog, not a failure: the anchor never
  // changes what the answer means (the per-pane import re-resolves the project).
  assert.deepEqual(await h.client.pickImages(fixturePath('nope')), { ok: true, paths: [] })
  assert.deepEqual(h.pickedImageAnchors, [{}, {}])
})

test('pick-images rejects on a shell with no picker, rather than reading as cancelled', async () => {
  const h = createHarness({ withPickImages: false })

  await assert.rejects(h.client.pickImages(), /image picker/)
})

test('settings commands fail cleanly for a project that is not open', async () => {
  const h = createHarness()
  await assert.rejects(h.client.getSettings(fixturePath('repo', 'never-opened')), /No project is open/)
  await assert.rejects(
    h.client.renameSession(fixturePath('repo', 'never-opened'), 's1', 'x'),
    /No project is open/,
  )
})

// --- coordination ------------------------------------------------------------

/** A coordination fake that creates the coordinator session in the project's store, like the service. */
function fakeCoordination(store: () => FakeStore, calls: string[]): ShellCoordination {
  let coordinatorId: string | undefined
  return {
    ensureCoordinator: async (cwd) => {
      calls.push(`ensure:${cwd}`)
      if (coordinatorId !== undefined && (await store().resolve(coordinatorId))) return coordinatorId
      const meta = { ...sessionOf('coord-1', '项目调度'), coordination: { role: 'coordinator' as const, projectKey: 'k' } }
      store().sessions.set(meta.id, meta)
      calls.push('create')
      coordinatorId = meta.id
      return meta.id
    },
    startSurvey: async (cwd) => {
      calls.push(`survey:${cwd}`)
    },
    stopAll: async (cwd) => {
      calls.push(`stop-all:${cwd}`)
    },
    pendingMerges: async (cwd) => {
      calls.push(`merges:${cwd}`)
      return [
        { threadId: 't1', title: 'T', branch: 'hanekawa/t-t1', added: 3, removed: 1, conflict: false, running: false },
      ]
    },
    mergeThread: async (cwd, threadId) => {
      calls.push(`merge:${cwd}:${threadId}`)
      return { kind: 'merged' }
    },
    dismissMerge: async (cwd, threadId) => {
      calls.push(`dismiss:${cwd}:${threadId}`)
    },
    resolveConflictViaThread: async (cwd, threadId) => {
      calls.push(`resolve:${cwd}:${threadId}`)
    },
    threadInfos: async (cwd) => {
      calls.push(`threads:${cwd}`)
      return {
        coordinatorSessionId: 'coord-1',
        threads: [
          {
            threadId: 't1',
            sessionId: 's1',
            title: 'T',
            status: 'running',
            lastActivityAt: '2026-10-10T00:00:00.000Z',
            branch: 'hanekawa/t-t1',
            // A tool-only field the projection must drop.
            ...({ writesCode: true } as object),
          },
          { threadId: 't2', sessionId: 's2', title: 'U', status: 'mystery', lastActivityAt: '2026-10-10T00:00:00.000Z' },
        ],
      }
    },
    stopThreadById: async (cwd, threadId) => {
      calls.push(`stop:${cwd}:${threadId}`)
    },
    resolveThreadById: async (cwd, threadId) => {
      calls.push(`resolve-thread:${cwd}:${threadId}`)
    },
  }
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

test('open-coordinator creates the coordinator session once, then reuses its lane', async () => {
  const calls: string[] = []
  let store: FakeStore | undefined
  const h = createHarness({ coordination: fakeCoordination(() => store!, calls) })
  store = h.project.store

  const first = await h.client.openCoordinator(h.entry.root)
  await settle()
  const second = await h.client.openCoordinator(h.entry.root)
  await settle()

  assert.deepEqual(calls, [`ensure:${h.entry.cwd}`, 'create', `ensure:${h.entry.cwd}`])
  assert.equal(first.pane.sessionId, 'coord-1')
  assert.equal(first.pane.coordinationRole, 'coordinator')
  assert.equal(second.lane, first.lane, 'the second open reuses the lane')
  assert.equal(h.attaches.length, 1)
  assert.deepEqual(h.activates, [first.lane, first.lane])
})

test('the home directory gets no coordinator', async () => {
  const calls: string[] = []
  const h = createHarness({ coordination: fakeCoordination(() => h.project.store, calls) })
  const home = h.addProject(os.homedir()).entry

  await assert.rejects(h.client.openCoordinator(home.root), /主目录/)
  assert.deepEqual(calls, [])
})

test('new-coordinator-project picks a folder, adds it and opens its coordinator; home and a cancelled picker open nothing', async () => {
  const calls: string[] = []
  const ensured: string[] = []
  let picked: string | undefined = fixturePath('repo', 'beta')
  let fresh: { entry: ProjectEntry<FakeProject, FakeWorkspace>; session: SessionMeta } | undefined
  const h = createHarness({
    coordination: fakeCoordination(() => fresh!.entry.project.store, calls),
    pickDirectory: async () => picked,
    ensureProjectFresh: async (cwd) => {
      ensured.push(cwd)
      // Like the bootstrap: a project with one lane-less draft pane.
      const { entry } = h.addProject(cwd)
      const session = sessionOf('draft-1', 'draft')
      entry.workspace.panes.push(new FakePane(session))
      fresh = { entry, session }
      return fresh
    },
  })

  const opened = await h.client.newCoordinatorProject()
  assert.ok('pane' in opened)
  assert.equal(opened.pane.coordinationRole, 'coordinator')
  assert.deepEqual(ensured, [fixturePath('repo', 'beta')])
  assert.deepEqual(calls, [`ensure:${fixturePath('repo', 'beta')}`, 'create'], 'a new coordinator starts no survey by itself')
  assert.deepEqual(
    fresh!.entry.workspace.panes.map((pane) => pane.getSession().id),
    ['coord-1'],
    'the bootstrap draft pane is dropped, not left lane-less',
  )

  picked = undefined
  assert.deepEqual(await h.client.newCoordinatorProject(), { cancelled: true })

  await assert.rejects(h.client.newCoordinatorProject(os.homedir()), /主目录/)
  assert.deepEqual(ensured, [fixturePath('repo', 'beta')], 'home is refused before it is registered')
})

test('open-coordinator on a registered but closed project drops its bootstrap draft too', async () => {
  const calls: string[] = []
  const known = fixturePath('repo', 'gamma')
  let fresh: ProjectEntry<FakeProject, FakeWorkspace> | undefined
  const h = createHarness({
    coordination: fakeCoordination(() => fresh!.project.store, calls),
    knownProjects: async () => [known],
    ensureProjectFresh: async (cwd) => {
      const { entry } = h.addProject(cwd)
      const session = sessionOf('draft-2', 'draft')
      entry.workspace.panes.push(new FakePane(session))
      fresh = entry
      return { entry, session }
    },
  })

  const opened = await h.client.openCoordinator(projectRootKey(known))
  assert.equal(opened.pane.sessionId, 'coord-1')
  assert.deepEqual(fresh!.workspace.panes.map((pane) => pane.getSession().id), ['coord-1'])
})

test('the thread merge commands delegate to the coordination deps with the project cwd', async () => {
  const calls: string[] = []
  const h = createHarness({ coordination: fakeCoordination(() => h.project.store, calls) })
  const cwd = h.entry.cwd

  assert.deepEqual((await h.client.threadMerges(h.entry.root)).merges.map((m) => m.threadId), ['t1'])
  assert.deepEqual(await h.client.mergeThread(h.entry.root, 't1'), { kind: 'merged' })
  assert.deepEqual(await h.client.dismissThreadMerge(h.entry.root, 't1'), { ok: true })
  assert.deepEqual(await h.client.resolveThreadMerge(h.entry.root, 't1'), { ok: true })
  assert.deepEqual(await h.client.stopAllCoordination(h.entry.root), { ok: true })
  assert.deepEqual(calls, [
    `merges:${cwd}`,
    `merge:${cwd}:t1`,
    `dismiss:${cwd}:t1`,
    `resolve:${cwd}:t1`,
    `stop-all:${cwd}`,
  ])
})

test('the thread table commands project to the wire and fill the client cache', async () => {
  const calls: string[] = []
  const h = createHarness({ coordination: fakeCoordination(() => h.project.store, calls) })
  const cwd = h.entry.cwd
  const pushed: string[] = []
  h.client.onCoordinationThreads((state) => pushed.push(state.projectRoot))

  const state = await h.client.coordinationThreads(h.entry.root)
  assert.deepEqual(state, {
    projectRoot: h.entry.root,
    coordinatorSessionId: 'coord-1',
    threads: [
      {
        threadId: 't1',
        sessionId: 's1',
        title: 'T',
        status: 'running',
        lastActivityAt: '2026-10-10T00:00:00.000Z',
        branch: 'hanekawa/t-t1',
      },
    ],
  })
  assert.deepEqual(h.client.getCoordinationThreads(h.entry.root), state)
  assert.deepEqual(pushed, [h.entry.root])
  assert.deepEqual(await h.client.threadStop(h.entry.root, 't1'), { ok: true })
  assert.deepEqual(await h.client.threadResolve(h.entry.root, 't1'), { ok: true })
  assert.deepEqual(calls, [`threads:${cwd}`, `stop:${cwd}:t1`, `resolve-thread:${cwd}:t1`])
})

test('thread-transcript reads the thread from disk with no open lane, and answers unchanged until the file moves', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-thread-transcript-'))
  const store = new SessionStore(dir)
  await store.init()
  const session = await store.create('Thread')
  const message = (id: string) => ({ type: 'message' as const, id, role: 'user' as const, content: id, createdAt: new Date().toISOString() })
  await store.appendRecord(session.id, message('m1'))
  try {
    const coordination: ShellCoordination = {
      ...fakeCoordination(() => new FakeStore(), []),
      threadInfos: async () => ({
        threads: [{ threadId: 't1', sessionId: session.id, title: 'T', status: 'idle', lastActivityAt: '2026-10-10T00:00:00.000Z' }],
      }),
    }
    const h = createHarness({ coordination, knownProjects: () => Promise.resolve([dir]) })
    const root = projectRootKey(dir)

    const first = await h.client.threadTranscript(root, 't1')
    assert.equal(first.unchanged, false)
    assert.deepEqual(first.unchanged ? [] : first.records.map((record) => record.id), ['m1'])
    assert.deepEqual(h.attaches, [], 'no lane was opened for it')

    const again = await h.client.threadTranscript(root, 't1', first.token)
    assert.deepEqual(again, { unchanged: true, token: first.token })

    await store.appendRecord(session.id, { type: 'tool_use', id: 'tu1', tool: 'Read', input: { filePath: 'a.txt' }, riskLevel: 'safe', createdAt: 'now' })
    const grown = await h.client.threadTranscript(root, 't1', first.token)
    assert.equal(grown.unchanged, false)
    assert.deepEqual(grown.unchanged ? [] : grown.records.map((record) => record.id), ['m1', 'tu1'])
    assert.equal(grown.unchanged ? undefined : grown.toolDisplays?.tu1?.displayName, 'Read', 'captions are projected from the records')

    await assert.rejects(h.client.threadTranscript(root, 'nope'), /No thread nope/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('broadcastCoordinationThreads coalesces a burst per open project and stops on dispose', async () => {
  const calls: string[] = []
  const h = createHarness({ coordination: fakeCoordination(() => h.project.store, calls) })
  const pushed: string[] = []
  h.client.onCoordinationThreads((state) => pushed.push(state.projectRoot))

  h.host.broadcastCoordinationThreads(h.entry.cwd)
  h.host.broadcastCoordinationThreads(h.entry.cwd)
  h.host.broadcastCoordinationThreads(h.entry.cwd)
  h.host.broadcastCoordinationThreads(fixturePath('repo', 'not-open'))
  assert.deepEqual(pushed, [], 'nothing before the delay')
  await wait(COORDINATION_BROADCAST_DELAY_MS + 30)
  await settle()
  assert.deepEqual(pushed, [h.entry.root], 'one push for the burst, none for a closed project')
  assert.deepEqual(calls, [`threads:${h.entry.cwd}`])
  assert.equal(h.client.getCoordinationThreads(h.entry.root)?.threads[0]?.threadId, 't1')

  h.host.broadcastCoordinationThreads(h.entry.cwd)
  h.host.dispose()
  await wait(COORDINATION_BROADCAST_DELAY_MS + 30)
  await settle()
  assert.equal(pushed.length, 1, 'dispose cancels the pending push')
})

test('coordination commands reject when the shell has no coordination', async () => {
  const h = createHarness()
  await assert.rejects(h.client.mergeThread(h.entry.root, 't1'), /no project coordination/)
})

test('laneControlFor answers the occupant coordination control by session id', async () => {
  const h = createHarness()
  const result = await h.host.openLane(h.entry)
  assert.equal(h.host.laneControlFor(result.pane.sessionId), undefined, 'the recorder exposes none')
  assert.equal(h.host.laneControlFor('nope'), undefined)
})

test('list-sessions carries a session coordination role', async () => {
  const h = createHarness()
  h.project.store.sessions.set('c1', { ...sessionOf('c1'), coordination: { role: 'coordinator', projectKey: 'k' } })
  h.project.store.sessions.set('p1', sessionOf('p1'))
  const result = await h.client.listSessions()
  const group = result.projects.find((p) => p.projectRoot === h.entry.root)!
  assert.equal(group.sessions.find((s) => s.id === 'c1')?.coordinationRole, 'coordinator')
  assert.equal('coordinationRole' in group.sessions.find((s) => s.id === 'p1')!, false)
})
