import type { SessionMeta } from '../sessions/service.js'
import type { ModelPricing, SessionRecord } from '../harness/types.js'
import type { ToolDisplays, WirePaneInfo } from '../runtime/protocol/wire.js'
import type { McpServerConfig } from '../services/mcp/types.js'
import type { EffortLevel } from '../config/effort.js'
import type { EndpointProbeResult } from '../config/providers/probe.js'
import type { SupportedProviderName } from '../config/providers/registry.js'

export type { EndpointProbeFailure, ProbedModel } from '../config/providers/probe.js'

export type { McpServerConfig }

/**
 * The shell protocol: what the single desktop window's `__shell` lane carries.
 *
 * Session traffic (36 `HostCommand`s and their events) flows on per-pane lanes
 * untouched. This is the lane *beside* them — the one that speaks for the
 * window rather than for any one session, so the renderer can ask about and
 * steer the lane topology itself.
 *
 * Deliberately small. Commands answer "what lanes exist", "open or focus a
 * session as a lane", and "open a project"; events announce topology changes
 * and activation requests. Settings live here too in phase 4d — a settings
 * screen is a window-level surface, not a session view — which is why the lane
 * exists from the start rather than being bolted on later.
 *
 * The reply/fail envelopes are the same shapes `SessionClient` speaks, so the
 * renderer's shell client reuses `PendingRequests` and the fail path unchanged.
 * Only this file is shared with the renderer, so it must stay browser-safe:
 * type-only imports, no zod (the host-side schemas live in `shellHost.ts`),
 * no Node builtins.
 */

/**
 * The reserved lane key for shell traffic. Not a lane `ShellHost` mints — it
 * exists on both muxes from construction and no session may ever claim it.
 */
export const SHELL_LANE = '__shell'

/**
 * A wire pane plus the lane key it currently lives on.
 *
 * `paneId` (the session id) moves under `/clear` and `/resume`; the lane key
 * does not. Everything on the renderer that wants a stable handle on an open
 * session — tab rows, close buttons, activation — goes through `lane`.
 */
export interface WireLaneInfo extends WirePaneInfo {
  lane: string
}

/**
 * A file the editor is asked to show, inside the named project — the click a
 * search result's path answers with (§6.2 检索).
 *
 * `path` is **relative to the project's cwd**, because the renderer cannot do
 * better: it holds only the normalized `projectRoot` key, which is case-folded
 * on Windows into a path that may not exist, so an absolute path built on it
 * would be a guess. The host resolves `path` against the project's real `cwd`
 * and bounds it there — a renderer that cannot name a directory the shell has
 * not opened cannot name a file outside one either.
 */
export interface WireEditorTarget {
  path: string
  /** The line to go to — a Grep hit's own line. Absent opens the file itself. */
  line?: number
}

// --- renderer → main ---------------------------------------------------------

export type ShellCommand =
  /** The full lane topology, across every open project. */
  | { type: 'panes'; id: string }
  /**
   * Opens a session as a lane, or focuses its existing lane. Without
   * `sessionId` a fresh draft is minted. `projectRoot` is the normalized key
   * the `lanes` events carry; omitted, the first open project answers.
   */
  | { type: 'open-session'; id: string; sessionId?: string; title?: string; projectRoot?: string }
  /**
   * Every session on disk, per project — the sidebar's history, which is a
   * superset of the lane topology (most sessions are not open).
   *
   * A pull rather than a pushed event: the renderer already refreshes on every
   * topology change and at turn end, and a push would either fire on every
   * snapshot tick or need its own change detection on the store.
   */
  | { type: 'list-sessions'; id: string }
  /** Per-day token and activity buckets over every project's metrics — the home page's statistics card. */
  | { type: 'usage-stats'; id: string }
  /**
   * Deletes a session: its lane if one is open, its three files, and its file
   * history. `projectRoot` is required — sessions live per project, and guessing
   * would delete out of the wrong one.
   */
  | { type: 'delete-session'; id: string; projectRoot: string; sessionId: string }
  /**
   * Asks the shell to open a project, exactly like the `open-project` host
   * command: `ok` means accepted, not that a project is open — the user still
   * has a directory dialog to answer.
   */
  | { type: 'open-project'; id: string }
  /**
   * Forgets a project: unregisters it from `~/.myagent/projects.json` and
   * releases any lane it still holds.
   *
   * **Deletes nothing.** The project's `.myagent/` directory and every session
   * in it survive, so re-opening the directory restores the group and its
   * history — which is what makes this safe as the sidebar's only way to make a
   * project row go away. The global workspace is not removable.
   */
  | { type: 'remove-project'; id: string; projectRoot: string }
  /**
   * The settings screen's whole read model for one project, in one pull.
   * Without `projectRoot` the first open project answers, matching
   * `open-session`.
   */
  | { type: 'get-settings'; id: string; projectRoot?: string }
  /**
   * One edit. A single command carrying a discriminated `SettingsChange`
   * rather than ten commands: the four settings cards will otherwise add a
   * command apiece, and every one of them would repeat the same
   * project-lookup / save / reload / fan-out choreography.
   */
  | { type: 'settings-change'; id: string; projectRoot: string; change: SettingsChange }
  /**
   * Lists an endpoint's models — the settings screen's connection test. With
   * `endpointName` and no `apiKey` the key saved for that endpoint is used.
   * Never rejects for a failed connection;
   * the reason is in the answer.
   */
  | {
      type: 'probe-endpoint'
      id: string
      projectRoot: string
      provider: SupportedProviderName
      baseUrl?: string
      apiKey?: string
      endpointName?: string
    }
  /**
   * Retitles a session. `sessionId` may be a prefix — the host resolves it,
   * for the same reason `delete-session` does.
   */
  | { type: 'rename-session'; id: string; projectRoot: string; sessionId: string; title: string }
  /**
   * Opens the project's directory in VS Code (`code <cwd>`), the canvas
   * header's "open location" — or, with `target`, one file inside it at one
   * line.
   *
   * Carries `projectRoot` — the normalized key the lane list uses — rather than
   * a path, because a renderer must not be able to name a directory the shell
   * has not opened. The host resolves it to that project's real `cwd`, and
   * resolves `target.path` against that cwd.
   *
   * The reply waits for the editor to actually start: "not installed" is the
   * likely answer and it has to reach the user as a `fail`, not as a native
   * error box the renderer never hears about.
   */
  | { type: 'open-in-editor'; id: string; projectRoot: string; target?: WireEditorTarget }
  /**
   * Repaints the window's native title-bar overlay for the resolved theme.
   *
   * The frameless chrome (5g) keeps Windows' own three buttons, drawn by the OS
   * into an overlay the *main* process owns — so the renderer, which is where the
   * theme preference lives, has no other way to tell it that dark just became
   * light. Carries the resolved theme, never a colour: colours belong to the
   * stylesheet, and a renderer that could name one would be painting chrome the
   * token test cannot see.
   *
   * `preference` rides along because the resolved theme alone cannot say
   * "follow the system": the main process sets `nativeTheme.themeSource` from
   * it, which is what turns the macOS traffic lights, native dialogs, a
   * `<select>`'s popup and the embedded browser's `prefers-color-scheme` with
   * the app — and it is remembered for the next launch's first frame, which
   * paints before any renderer script has run.
   */
  | {
      type: 'set-window-theme'
      id: string
      theme: 'dark' | 'light'
      preference: 'system' | 'dark' | 'light'
    }
  /**
   * Something in a pane now waits on the user (a permission, a question, a
   * plan). The shell flashes the taskbar button (Windows) or bounces the Dock
   * icon (macOS) — only while the window is not focused, so a prompt the user
   * is already looking at does not nag.
   *
   * Fire-and-forget like `browser-set-bounds`: an attention cue is chrome, and
   * a lost one has nothing for the user to act on.
   */
  | { type: 'request-attention'; id: string }
  /**
   * 「选择图片」 (S11): puts up the shell's image picker and answers the chosen
   * paths. `projectRoot`, when present, only anchors where the dialog opens —
   * the *host-side* import (per-pane lane, `import-attachment`) re-resolves
   * against the project that lane belongs to. A cancelled dialog answers
   * `paths: []` rather than rejecting; this command never reads a file.
   */
  | { type: 'pick-images'; id: string; projectRoot?: string }
  /**
   * Opens a browser tab on `lane` and answers its id. Without `url` the tab
   * starts blank — the address bar is then the thing that navigates it.
   *
   * Tabs belong to a lane, not to the window: the panel only ever draws the
   * active lane's tabs, and a lane's tabs die with it (`detachLane`). A pane
   * evicted by the renderer's own budget keeps its tabs, because eviction is a
   * renderer-side repaint decision and the tab lives in the main process.
   */
  | { type: 'browser-create-tab'; id: string; lane: string; url?: string }
  | { type: 'browser-close-tab'; id: string; tabId: string }
  /** Points the tab at `url`. Rejects anything but `http:`/`https:`. */
  | { type: 'browser-navigate'; id: string; tabId: string; url: string }
  | { type: 'browser-go-back'; id: string; tabId: string }
  | { type: 'browser-go-forward'; id: string; tabId: string }
  | { type: 'browser-reload'; id: string; tabId: string }
  /**
   * The user took the browser back from the agent. Blocks the lane's session
   * until it is handed back — see `browser/ownership.ts`.
   */
  | { type: 'browser-take-over'; id: string; tabId: string }
  /**
   * The user handed the tab back: whoever was driving it may drive it again,
   * now, without waiting for a new turn. Sent by 「交还」 and by sending the
   * agent a message, which are the same statement made two ways.
   */
  | { type: 'browser-release'; id: string; tabId: string }
  /**
   * Where the panel's placeholder element is, in CSS pixels relative to the
   * window's content area, and whether it should be on screen at all.
   *
   * **Fire-and-forget**, like `set-window-theme`: this rides every resize frame,
   * every sidebar drag and every `ResizeObserver` callback, so a reply ledger
   * entry per push would be pure overhead — and there is nothing for the user to
   * act on if a geometry push is lost, because the next one supersedes it.
   *
   * `visible` is not just "is this tab active": the panel also reports false when
   * it is occluded or the window itself is hidden, because a native view keeps
   * painting over page content that the stylesheet believes it has covered.
   */
  | {
      type: 'browser-set-bounds'
      id: string
      tabId: string
      rect: WireBrowserRect
      visible: boolean
    }
  /**
   * Opens the project's coordinator session as the active lane, creating the
   * session the first time; every later call reuses the one the project's
   * coordination pointer names.
   */
  | { type: 'open-coordinator'; id: string; projectRoot: string }
  /**
   * Picks a folder, adds it as a project and opens its coordinator session. The home directory
   * is refused: it is the global workspace and gets no coordinator.
   */
  | { type: 'new-coordinator-project'; id: string }
  /** Starts the survey thread (了解项目) of a project whose coordinator has no threads yet. */
  | { type: 'coordination-survey'; id: string; projectRoot: string }
  /** Stops the coordinator and every thread of the project that has a live lane. */
  | { type: 'coordination-stop-all'; id: string; projectRoot: string }
  /** Worktree threads whose branch has commits the project's branch lacks. */
  | { type: 'thread-merges'; id: string; projectRoot: string }
  /** Merges a thread's branch into the project's checked-out branch. */
  | { type: 'thread-merge'; id: string; projectRoot: string; threadId: string }
  /** Hides a thread's merge prompt until its branch gets a new commit. */
  | { type: 'thread-merge-dismiss'; id: string; projectRoot: string; threadId: string }
  /** Asks the thread itself to bring its branch up to date and resolve the conflict. */
  | { type: 'thread-merge-resolve'; id: string; projectRoot: string; threadId: string }
  /** The project's thread table (pull); the same payload the `coordination-threads` event pushes. */
  | { type: 'coordination-threads'; id: string; projectRoot: string }
  /** The user's stop of one thread: interrupts its lane, no coordinator involved. */
  | { type: 'thread-stop'; id: string; projectRoot: string; threadId: string }
  /** The user's 结案 of one thread. */
  | { type: 'thread-resolve'; id: string; projectRoot: string; threadId: string }
  /** A thread's records from disk, lane open or not; `since` is the token of the reader's last copy. */
  | { type: 'thread-transcript'; id: string; projectRoot: string; threadId: string; since?: string }

// --- browser -----------------------------------------------------------------

/** CSS pixels, relative to the window's content area. */
export interface WireBrowserRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * One tab as the panel draws it.
 *
 * `lane` rather than `paneId`: the lane key is the stable handle (a session id
 * moves under `/clear` and `/resume`), and the panel's whole job is deciding
 * which tabs belong to the lane currently on screen.
 */
export interface WireBrowserTabInfo {
  tabId: string
  lane: string
  /** The committed URL, or `''` for a tab that has never navigated. */
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The last navigation failure, cleared when a new navigation starts. */
  error?: string
  /**
   * The address that failed. Carried separately because a failed navigation
   * never commits: `url` is still the page the tab was showing before it.
   */
  errorUrl?: string
  /**
   * The site's icon, as a `data:` URL.
   *
   * Encoded rather than linked: the renderer runs under `img-src 'self' data:`,
   * and a remote `<img>` here would be the app's own window fetching from a
   * site the model chose. The bytes are read in the browser partition, where
   * the page that named them already lives.
   */
  favicon?: string
  /**
   * The agent's control of this tab was taken back by the user. Drawn as a
   * badge; cleared by 「交还」, by the user's next message, or by the turn it
   * interrupted ending — whichever comes first.
   */
  takenOver?: boolean
  /**
   * The session driving this tab is mid-turn, so there is something to take
   * over: the panel draws the「agent 正在操作」banner. Between turns, and on a
   * tab no session has driven, the tab is the user's and「接管」is unavailable
   * rather than a press that does nothing.
   */
  agentActive?: boolean
  /** File names of downloads the page started and the browser cancelled, oldest first. */
  blockedDownloads?: string[]
}

// --- settings ----------------------------------------------------------------

/** The cap on `~/.myagent/AGENTS.md`, shared by the host's schema and the editor's `maxLength`. */
export const USER_INSTRUCTIONS_MAX_CHARS = 64_000

/**
 * The settings screen's left-hand categories.
 *
 * `appearance` is renderer-local (theme preference); it carries no host config and
 * never rides a `SettingsChange`. Every other category maps to a wire `scope`.
 */
export type SettingsCategory =
  | 'provider'
  | 'extensions'
  | 'permissions'
  | 'agent'
  | 'general'
  | 'personalization'
  | 'appearance'

/** An endpoint as the screen shows it; the edit form shows the real key. */
export interface WireEndpointInfo {
  name: string
  provider: string
  baseUrl?: string
  apiKey?: string
}

export interface WireModelInfo {
  key: string
  model: string
  provider?: string
  endpoint?: string
  contextWindow?: number
  /**
   * The raw `supportsImageInput` switch off the config entry — the user's
   * declaration, not the effective capability. Present only when on; this is
   * what the edit form seeds from, so editing another field cannot reset it.
   */
  supportsImageInput?: boolean
  /**
   * Effective image-input capability — `resolveImageCapability` of the model
   * against its endpoint, computed host-side because the renderer cannot reach
   * the provider registry. Present only when true; this is the list marker.
   * Can differ from `supportsImageInput`: a switch on a provider whose adapter
   * carries no images reads as on-but-not-capable.
   */
  imageCapable?: boolean
  maxOutputTokens?: number
  /** The effort levels this model accepts; absent means every level. */
  supportedEfforts?: EffortLevel[]
  /** `thinking: { type: 'disabled' }` on the config entry; present only when true. */
  thinkingOff?: boolean
  pricing?: ModelPricing
  /** Only when set inline on the model rather than inherited from an endpoint. */
  baseUrl?: string
  apiKeyMasked?: string
  /**
   * `resolveModel(key) !== undefined`. Carried so the row can be drawn *and*
   * explain itself: a model that is configured but cannot run must say so
   * rather than silently vanish from the list (the 4c invariant).
   */
  resolves: boolean
}

export interface WireRoutingInfo {
  main: string
  plan: string
  compact: string
  /** An array, not a Record: it pins the order the selects are drawn in. */
  subagent: Array<{ type: string; value: string }>
}

/**
 * One permission group, split by the file it lives in.
 *
 * Split rather than flagged per entry because that is the shape of the
 * constraint: `mergeSettings` *concatenates* `permissions.allow/deny/ask`
 * across layers, so the only group this screen can rewrite is the local one,
 * and writing a merged group back would copy every inherited entry into the
 * local file.
 */
export interface WirePermissionGroup {
  behavior: 'allow' | 'deny' | 'ask'
  local: string[]
  inherited: string[]
}

export interface WirePermissionsInfo {
  /** `localSettingsPath(cwd)`, `~/.myagent/projects/<key>/settings.local.json` — the screen says what it writes. */
  localPath: string
  /**
   * The startup mode as merged. Editable whatever layer set it: unlike the
   * groups, `permissions.mode` is last-writer-wins, and the local layer is last.
   */
  mode: 'default' | 'auto' | 'bypass'
  /** Whether the local layer is what set the mode, for the row's own detail. */
  modeIsLocal: boolean
  groups: WirePermissionGroup[]
}

/**
 * An agent definition as the screen shows it: read-only, field by field.
 *
 * Projected rather than shipped because `BaseAgentDefinition` carries
 * `getSystemPrompt` — a function, which `structuredClone` refuses outright.
 */
export interface WireAgentDefinitionInfo {
  type: string
  description: string
  /** A built-in cannot be edited by editing a file; a custom one can. */
  builtIn: boolean
  permissionMode?: string
  /** Absent means every tool: the definition says `tools: ['*']` or nothing. */
  tools?: string[]
  model?: string
  /** Absent means no turn cap. */
  maxTurns?: number
  isReadOnlyAgent: boolean
  /** `routing.subagent[type]`, or `inherit`. The one editable field here. */
  routing: string
}

/**
 * One skill as the screen shows it.
 *
 * A projection for the same reason `WireAgentDefinitionInfo` is one: a
 * `SkillDefinition` carries the whole `SKILL.md` body and its hook commands,
 * neither of which a settings row has any use for.
 */
export interface WireSkillInfo {
  name: string
  description: string
  /** False when `skills.disabled` names it in any settings layer. */
  enabled: boolean
  inclusion: 'always' | 'manual' | 'fileMatch'
  /** Only for `fileMatch`: the globs that pull the skill in. */
  paths?: string[]
  allowedTools?: string[]
  model?: string
  effort?: string
  /** The definition declares hooks; the rows say so rather than listing them. */
  hasHooks: boolean
  attachments?: number
}

export interface WireMcpServerInfo {
  name: string
  transport: 'stdio' | 'sse'
  /** The command with its args, or the URL — whichever the transport uses. */
  target: string
  trusted: boolean
  /**
   * False when a layer above trusts it. `mcp.trustedServers` is *unioned*
   * across layers, so this screen can grant trust but cannot take that grant
   * away — and a toggle that silently does nothing is worse than a disabled one.
   */
  trustEditable: boolean
  status: 'connected' | 'failed' | 'unknown'
  toolCount?: number
  error?: string
  isLocal?: boolean
  /**
   * The local layer *overrides* a server of the same name from above, so
   * deleting the local entry uncovers the inherited one instead of removing the
   * row. The screen has to say so, and must not predict a disappearance.
   */
  shadowsInherited?: boolean
  config?: McpServerConfig
}

/**
 * The context-budget numbers, in the order the screen draws them.
 *
 * Exported as a value because both the schema and the rows iterate it; spelled
 * once so a seventh field cannot be added to one and forgotten in the other.
 */
export const CONTEXT_MANAGEMENT_FIELDS = [
  'contextWindow',
  'summaryOutputTokens',
  'autoCompactReserveRatio',
  'manualCompactBufferTokens',
  'microCompactThresholdRatio',
] as const

export type WireContextManagementField = (typeof CONTEXT_MANAGEMENT_FIELDS)[number]

/** Merged over the defaults, so every field has a number to draw. */
export type WireContextManagementInfo = Record<WireContextManagementField, number>

/**
 * Merged coordination settings. A model or effort that is absent inherits; the
 * day counts always carry a number (the default filled in), 0 meaning off.
 */
export interface WireCoordinationSettingsInfo {
  coordinatorModel?: string
  coordinatorEffort?: EffortLevel
  threadModel?: string
  threadEffort?: EffortLevel
  quietDays: number
  autoResolveDays: number
}

export interface WireGeneralInfo {
  /** `localSettingsPath(cwd)`, `~/.myagent/projects/<key>/settings.local.json`, same file the permission groups use. */
  localPath: string
  /**
   * `cache.ttl1h`. Absent is not `false`: unset means the 1h TTL is on, which
   * `MYAGENT_PROMPT_CACHE_1H=0` turns off, and the row says so.
   */
  cacheTtl1h?: boolean
  /**
   * `thinking`. Absent is not `false`: unset means extended thinking is on,
   * which is what the row says.
   */
  thinking?: boolean
}

export interface WireSettingsSnapshot {
  projectRoot: string
  projectName: string
  /** `getSaveTarget()` — the screen says which file it is about to write. */
  saveTarget: string
  endpoints: WireEndpointInfo[]
  models: WireModelInfo[]
  routing: WireRoutingInfo
  defaultModel?: string
  /**
   * Read-only for now: `ConfigService` has `setDefaultModel` but no
   * `setFallbackModel` / `setCompactModel`, and inventing them belongs to a
   * separate, tested change rather than to the screen that wants them.
   */
  fallbackModel?: string
  compactModel?: string
  /** `SUPPORTED_PROVIDER_NAMES` — the provider select's choices. */
  providers: string[]
  /** The built-in subagent types unioned with any the routing already names. */
  subagentTypes: string[]
  permissions: WirePermissionsInfo
  agents: WireAgentDefinitionInfo[]
  skills: WireSkillInfo[]
  /** `.myagent/skills/` — the skills card names the directory it is reading. */
  skillsDir: string
  mcpServers: WireMcpServerInfo[]
  /** From `config.json`, not the settings layers — see `setContextManagement`. */
  contextManagement: WireContextManagementInfo
  general: WireGeneralInfo
  coordination: WireCoordinationSettingsInfo
  /** `~/.myagent/AGENTS.md`; empty when the file does not exist. Global, not per project. */
  userInstructions: string
}

/**
 * One settings edit.
 *
 * `scope` picks the card and `kind` the operation. `kind` is unique across the
 * whole union, not just within a scope: the host's schema table is keyed by it
 * and so is the dispatch switch.
 *
 * `apiKey` absent means "leave it alone"; clearing is its own variant rather
 * than `apiKey: null`, because an optional field cannot distinguish "the user
 * did not touch this" from "the user emptied it".
 */
export type SettingsChange =
  | { scope: 'provider'; kind: 'set-endpoint'; name: string; provider: string; baseUrl?: string; apiKey?: string }
  | { scope: 'provider'; kind: 'clear-endpoint-key'; name: string }
  | { scope: 'provider'; kind: 'remove-endpoint'; name: string }
  | { scope: 'provider'; kind: 'rename-endpoint'; from: string; to: string }
  | {
      scope: 'provider'
      kind: 'set-model'
      key: string
      model: string
      provider?: string
      endpoint?: string
      contextWindow?: number
      /**
       * The image-input switch, form-owned: absent means
       * off, and the host's rebuild is how a switch-off gets removed from
       * `config.json`. `true` is the only on value — the same strict rule
       * `ModelConfig` applies.
       */
      supportsImageInput?: boolean
      maxOutputTokens?: number
      /** Absent means "no restriction" — the form never sends an empty list. */
      supportedEfforts?: EffortLevel[]
      /** Form-owned like `supportsImageInput`: absent turns the model's thinking back on. */
      thinkingOff?: boolean
      /** Form-owned: absent removes the model's pricing. */
      pricing?: ModelPricing
    }
  | { scope: 'provider'; kind: 'rename-model'; from: string; to: string }
  | { scope: 'provider'; kind: 'remove-model'; key: string }
  | { scope: 'provider'; kind: 'set-default-model'; key: string }
  | { scope: 'provider'; kind: 'set-routing'; role: 'main' | 'plan' | 'compact'; value: string }
  | { scope: 'provider'; kind: 'set-subagent-routing'; type: string; value: string }
  /**
   * The whole group, not one entry. Rewriting the group is what makes a removal
   * possible and what keeps inherited entries out of the local file; the
   * renderer therefore sends `local` plus or minus one line.
   */
  | { scope: 'permissions'; kind: 'set-permission-entries'; behavior: 'allow' | 'deny' | 'ask'; entries: string[] }
  | { scope: 'permissions'; kind: 'set-startup-permission-mode'; mode: 'default' | 'auto' | 'bypass' }
  /** An action, not a write: re-reads `.myagent/agents/` and rebuilds runtimes. */
  | { scope: 'agent'; kind: 'reload-agent-definitions' }
  /** Local layer. `'inherit'` clears the setting; otherwise a model key from the snapshot. */
  | { scope: 'agent'; kind: 'set-coordination-model'; role: 'coordinator' | 'thread'; value: string }
  /** Local layer. `'inherit'` clears the setting. */
  | { scope: 'agent'; kind: 'set-coordination-effort'; role: 'coordinator' | 'thread'; value: EffortLevel | 'inherit' }
  /** Local layer; an integer >= 0, where 0 turns the rule off. */
  | { scope: 'agent'; kind: 'set-coordination-days'; field: 'quietDays' | 'autoResolveDays'; value: number }
  | { scope: 'general'; kind: 'set-cache-ttl'; enabled: boolean }
  | { scope: 'general'; kind: 'set-thinking'; enabled: boolean }
  | { scope: 'personalization'; kind: 'set-user-instructions'; content: string }
  | { scope: 'general'; kind: 'set-context-management'; field: WireContextManagementField; value: number }
  /**
   * A skill's on/off switch, written to the local layer.
   *
   * `extensions` rather than `general`: the trust toggle and the reconnect
   * moved onto the skills page with it, and one page is one scope.
   */
  | { scope: 'extensions'; kind: 'set-skill-enabled'; name: string; enabled: boolean }
  /** An action: re-reads `.myagent/skills/` and re-registers their commands. */
  | { scope: 'extensions'; kind: 'reload-skills' }
  /** Copies a skill folder the user picks into `.myagent/skills/` and reloads. */
  | { scope: 'extensions'; kind: 'import-skill' }
  | { scope: 'extensions'; kind: 'set-mcp-trust'; name: string; trusted: boolean }
  /**
   * `previousName` is a rename: one command rather than a remove plus a set, so
   * the host can move the trust entry with the config instead of leaving the old
   * name trusted and treating the new one as a brand-new server.
   */
  | {
      scope: 'extensions'
      kind: 'set-mcp-server'
      name: string
      server: McpServerConfig
      previousName?: string
    }
  | { scope: 'extensions'; kind: 'remove-mcp-server'; name: string }
  /** Also an action. Never prompts for trust — see `ProjectRuntime.reloadMcpServers`. */
  | { scope: 'extensions'; kind: 'reconnect-mcp' }

// --- main → renderer ---------------------------------------------------------

export type ShellEvent =
  /**
   * The lane topology changed. Pushed on every open, close and session switch
   * (a switch moves `paneId` under a lane, which is a topology change even
   * though no lane opened or closed).
   */
  | { type: 'lanes'; lanes: WireLaneInfo[] }
  /**
   * A request that the renderer make `lane` the active pane. Activation is a
   * renderer concern in a single window — the main process can only ask.
   */
  | { type: 'activate'; lane: string }
  /**
   * The browser's tabs changed — opened, closed, navigated, finished loading,
   * or were taken over. The whole list every time, across every lane, for the
   * same reason `lanes` is a whole list: the panel diffs it, and a per-tab delta
   * would need its own ordering guarantees against the open/close events.
   */
  | { type: 'browser-state'; tabs: WireBrowserTabInfo[] }
  /**
   * One project's thread table changed. The whole list, like `browser-state`,
   * coalesced per project on the host; only pushed for open projects.
   */
  | { type: 'coordination-threads'; state: WireCoordinationThreads }
  /**
   * A native application-menu item was clicked (the macOS menu bar). The
   * renderer runs it exactly as it runs the title-bar menu of the same name:
   * the menu only names the action, every decision (is a project open, which
   * lane closes) stays in the renderer that owns them.
   */
  | { type: 'menu-action'; action: WireMenuAction }
  /**
   * The window gained or lost focus. The renderer dims its title bar and
   * sidebar headings while inactive, which both platforms' own apps do.
   */
  | { type: 'window-focus'; focused: boolean }
  | { type: 'reply'; id: string; result: unknown }
  | { type: 'fail'; id: string; message: string }

/**
 * What a native menu item can ask the renderer to do. Every one has a renderer
 * keyboard path too; the menu is a second way in, never the only one.
 */
export type WireMenuAction =
  | 'new-session'
  | 'open-project'
  | 'open-settings'
  | 'toggle-sidebar'
  | 'toggle-browser'
  | 'close-session'

// --- reply payloads ----------------------------------------------------------

export interface WireShellPanesResult {
  lanes: WireLaneInfo[]
}

export interface WireShellOpenSessionResult {
  lane: string
  pane: WireLaneInfo
}

/**
 * A session as the sidebar needs it: the four fields a row reads.
 *
 * Projected field by field rather than shipping `SessionMeta`, which was the
 * first attempt. `SessionMeta` is already a wire type elsewhere
 * (`WireSessionsResult`, `session-changed`) so reusing it looked free — but this
 * command answers with *every* session in *every* open project, and a field
 * nobody here reads grows without bound: `checkpoints` gains an entry per
 * turn. At a few hundred sessions that is
 * hundreds of kilobytes `structuredClone`d across the preload boundary on every
 * pull, and retained for as long as the renderer holds the list.
 */
export interface WireSessionSummary {
  id: string
  title?: string
  updatedAt: string
  messageCount: number
  /** The session's last turn ended on an error. */
  failed?: boolean
  /** The session's coordination role, when it belongs to a project's coordination. */
  coordinationRole?: 'coordinator' | 'thread'
}

/** One project's session history. */
export interface WireShellProjectSessions {
  projectRoot: string
  projectName: string
  /** The real directory, as the user spelled it; `projectRoot` is a case-folded key. */
  projectPath: string
  /**
   * The home directory's implicit workspace rather than an added project.
   *
   * Carried rather than derived, because the renderer must not string-match the
   * display name (`最近`) to recognize it — and it needs to, since the global
   * workspace is the one group with no "remove from sidebar".
   */
  isGlobal: boolean
  sessions: WireSessionSummary[]
}

export interface WireShellSessionsResult {
  /** In the order projects were opened, which is `ProjectDirectory`'s order. */
  projects: WireShellProjectSessions[]
  /**
   * The global workspace's root key, whether or not it earned a group above.
   *
   * The renderer needs to be able to *name* the home-rooted workspace — the
   * welcome screen's「不在项目中工作」opens a session in it — and it is forbidden
   * from string-matching the display name (`最近`) to find it. `projects` cannot
   * answer: the global group is filtered out until it is open or has history,
   * which is exactly the case where the user is asking for it.
   */
  globalRoot: string
}

/** One local calendar day of turns, across every project. */
export interface WireUsageDay {
  /** Local date, `YYYY-MM-DD`. */
  day: string
  /** Sessions whose first turn fell on this day. */
  sessions: number
  turns: number
  /** Prompt (uncached + cache writes + cache reads) plus output tokens. */
  tokens: number
  /** Turns per local hour, 24 entries. */
  hours: number[]
  /** Tokens per model. */
  models: Record<string, number>
}

export interface WireShellUsageStatsResult {
  /** Ascending by day; days without a turn are absent. */
  days: WireUsageDay[]
}

export interface WireShellDeleteSessionResult {
  ok: true
}

export interface WireShellOpenProjectResult {
  ok: true
}

/** `ok` means the project is unregistered and its lanes are gone. No files were touched. */
export interface WireShellRemoveProjectResult {
  ok: true
}

export interface WireShellSettingsResult {
  settings: WireSettingsSnapshot
  /**
   * Every open project. Settings are per project and N may be open, so the
   * screen needs a selector — the sidebar's grouping does not carry over here.
   */
  projects: Array<{ projectRoot: string; projectName: string }>
}

export interface WireShellSettingsChangeResult {
  /** A fresh snapshot. The renderer never re-derives one from the change. */
  settings: WireSettingsSnapshot
  /** How many live lanes of that project rebuilt their runtime. */
  rebuiltLanes: number
}

export type WireShellProbeEndpointResult = EndpointProbeResult

export interface WireShellRenameSessionResult {
  ok: true
  title: string
}

/** `ok` means the overlay was repainted, or that this shell has no overlay. */
export interface WireShellSetWindowThemeResult {
  ok: true
}

/** The picker's answer; empty means cancelled, never an error. */
export interface WireShellPickImagesResult {
  ok: true
  paths: string[]
}

/** `ok` means the editor process started, not that it drew a window. */
export interface WireShellOpenInEditorResult {
  ok: true
}

export interface WireShellBrowserCreateTabResult {
  tabId: string
}

/**
 * `ok` means the command was accepted, not that the page finished loading —
 * navigation completion arrives as a `browser-state` event.
 */
export interface WireShellBrowserOkResult {
  ok: true
}

/** `open-coordinator` answers like `open-session`: the lane it landed on. */
export type WireShellOpenCoordinatorResult = WireShellOpenSessionResult

/** `cancelled` when the folder picker was dismissed. */
export type WireShellNewCoordinatorProjectResult = WireShellOpenCoordinatorResult | { cancelled: true }

/** `ok` means the command ran; a stop does not wait for the turns to drain. */
export interface WireShellCoordinationOkResult {
  ok: true
}

/** One thread branch waiting to be merged. */
export interface WireThreadMerge {
  threadId: string
  title: string
  branch: string
  added: number
  removed: number
  /** The last merge attempt conflicted and was undone. */
  conflict: boolean
  /** The thread is still working (or waiting on the user): shown, but not mergeable yet. */
  running: boolean
}

/** A thread's effective status (lifecycle already applied host-side). */
export type WireThreadStatus =
  | 'running'
  | 'idle'
  | 'awaiting-coordinator'
  | 'needs-you'
  | 'failed'
  | 'interrupted'
  | 'quiet'
  | 'resolved'
  | 'stale'

/** One thread as the desktop shows it. Title and report text are already sanitized. */
export interface WireThreadInfo {
  threadId: string
  sessionId: string
  title: string
  status: WireThreadStatus
  statusLine?: string
  lastReport?: string
  /** ISO 8601. */
  lastActivityAt: string
  /** The worktree branch, for a thread that writes code. */
  branch?: string
}

/** A project's whole thread table, newest activity first. */
export interface WireCoordinationThreads {
  projectRoot: string
  coordinatorSessionId?: string
  /** The survey thread the welcome's 「读取项目」 started. */
  openingThreadId?: string
  /** The project has had a coordinator, even if its session was since deleted. */
  started?: true
  threads: WireThreadInfo[]
}

/** `unchanged` when the file still matches the request's `since`; `token` is what to send next time. */
export type WireShellThreadTranscriptResult =
  | { unchanged: true; token: string }
  | { unchanged: false; token: string; records: SessionRecord[]; toolDisplays?: ToolDisplays }

export interface WireShellThreadMergesResult {
  merges: WireThreadMerge[]
}

/**
 * A merge attempt's outcome. Only `merged` changed anything: `dirty` and
 * `running` refused up front, `conflict` was rolled back.
 */
export interface WireShellThreadMergeResult {
  kind: 'merged' | 'dirty' | 'conflict' | 'error' | 'running' | 'no-worktree'
  message?: string
}
