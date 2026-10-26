import { isDeepStrictEqual } from 'node:util'
import { readConfigurationFile, updateConfigurationFile } from './file.js'
import { getGlobalConfigPath } from '../utils/paths.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import type { ModelPricing } from '../harness/types.js'
import type { ModelCatalogEntry } from './modelCatalog.js'
import { ApiKeyRedactor } from './apiKeys.js'
import { loadUserSettings, type MyAgentSettings } from './settings.js'
import type { ChatThinkingFormat } from './providers/openaiCompat.js'
import {
  resolveCoordination,
  type CoordinationConfig,
  type CoordinationRole,
  type ResolvedCoordinationConfig,
} from './coordination.js'
import {
  EFFORT_RANK,
  VALID_EFFORT_LEVELS,
  normalizeSupportedEfforts,
  type EffortLevel,
} from './effort.js'
import {
  mergeRouting,
  pickRoutedModel,
  type Endpoint,
  type PromptCachingMode,
  type Routing,
  type RoutingRole,
} from './routing.js'

/**
 * The three tier names that `routing` / `defaultModel` used to hold.
 *
 * Kept only so a config written before tiers were removed can be recognized and
 * warned about; nothing resolves through them any more.
 */
const LEGACY_TIER_NAMES: readonly string[] = ['fast', 'balanced', 'powerful']

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/** The three model references that live directly on the config object. */
export type ModelReferenceField = 'defaultModel' | 'fallbackModel' | 'compactModel'

export interface ModelConfig {
  provider?: string
  model: string
  contextWindow?: number
  endpoint?: string
  apiKey?: string
  baseUrl?: string
  /** Overrides the endpoint's Anthropic prompt caching mode; defaults to auto. */
  promptCaching?: PromptCachingMode
  promptCacheRetention?: 'in_memory' | '24h'
  /** Carried from the endpoint by `resolveModel`; see `Endpoint.thinkingFormat`. */
  thinkingFormat?: ChatThinkingFormat
  pricing?: ModelPricing
  maxOutputTokens?: number
  thinking?: ThinkingConfig
  /**
   * The effort levels this model accepts, or absent for "all of them".
   *
   * A set rather than a ceiling: a model can refuse a level in the middle of the
   * ladder, and some endpoints reject an unsupported `effort` outright instead
   * of rounding it. A config still holding the older `maxEffort` ceiling is
   * expanded into the equivalent set on load.
   */
  supportedEfforts?: EffortLevel[]
  /**
   * Whether this model accepts image input — the user's declaration about the
   * endpoint behind it, not something probed or inferred from the model name,
   * the endpoint, or `contextWindow`. Absent means off, and only a strict
   * `true` means on; a config written with `"true"` or `1` is off.
   *
   * Half of the effective capability: `resolveImageCapability` ANDs it with the
   * provider adapter's own implementation. Two models on one endpoint may
   * differ, which is why this lives on the model and not the endpoint. Not a
   * session-scope field — it is re-read whenever a runtime is built, so a
   * settings change reaches the next request rather than being pinned to the
   * session that was open when it was made.
   */
  supportsImageInput?: boolean
}

/**
 * The `ModelConfig` fields no editing form owns — they are written in
 * `config.json` by hand and have no widget in `/provider` or desktop Settings.
 *
 * Both model forms save by *rebuilding* a `ModelConfig` from their fields, which
 * is what makes "off is absence" work for the switches they do own. That same
 * rebuild silently drops everything they don't own, so a JSON-configured field
 * would survive exactly until the first unrelated edit.
 *
 * `supportsImageInput`, `thinking` and `pricing` are *not* here: the form owns a widget for each, so
 * the forms seed and send it, and carrying it here would override a deliberate
 * switch-off with the stale on-disk value on every save.
 */
const JSON_ONLY_MODEL_FIELDS = [
  'apiKey',
  'baseUrl',
  'promptCaching',
  'promptCacheRetention',
] as const satisfies readonly (keyof ModelConfig)[]

/**
 * Copies the JSON-only fields of `existing` onto a freshly built `next`.
 *
 * Called by every model-form save path so editing a context window in either
 * frontend cannot reset a capability the user declared in `config.json`. Fields
 * the form does own are already on `next` and are left alone; `next` is mutated
 * and returned for use as an expression.
 */
export function carryJsonOnlyModelFields(next: ModelConfig, existing: ModelConfig | undefined): ModelConfig {
  if (!existing) return next
  for (const field of JSON_ONLY_MODEL_FIELDS) {
    const value = existing[field]
    if (value !== undefined) Object.assign(next, { [field]: value })
  }
  return next
}

export interface AgentConfig {
  system?: string
  contextManagement?: Partial<ContextManagementConfig>
  sessionDir?: string
  /** Coordinator/thread effort and the thread lifecycle day counts. Global only. */
  coordination?: CoordinationConfig
}

export interface Config {
  endpoints?: Record<string, Endpoint>
  models: Record<string, ModelConfig>
  routing?: Routing
  defaultModel?: string
  fallbackModel?: string
  compactModel?: string
  agent: AgentConfig
}

const DEFAULT_CONFIG: Config = {
  models: {},
  agent: {
    contextManagement: {
      contextWindow: 272_000,
      summaryOutputTokens: 20_000,
      autoCompactReserveRatio: 0.083,
      manualCompactBufferTokens: 3_000,
      microCompactThresholdRatio: 0.9,
    },
  },
}

export interface ConfigServiceOptions {
  /**
   * Absolute path to the one config layer. Defaults to
   * {@link getGlobalConfigPath}, which resolves `homedir()` lazily — a test that
   * redirects USERPROFILE/HOME before constructing is already isolated and does
   * not need this.
   */
  configPath?: string
}

/**
 * The config layer is **global only**: one `~/.myagent/config.json` for every
 * project.
 *
 * Endpoints, models and routing are account-level facts — an API key and a model
 * list do not belong to a directory — and a project layer on top of them was the
 * source of two separate failures: the same model had to be re-declared per
 * repo, and `getSaveTarget()` silently scattered API keys into whichever project
 * happened to have a `config.json`. Repository config is never automatically
 * imported; see `migrateProjectConfig.ts`.
 *
 * Settings (`permissions`, `hooks`, `skills.disabled`, …) are unaffected: they
 * still layer global-then-project. Only trusted global settings stack under
 * this file; merged project settings never enter the account configuration.
 */
export class ConfigService {
  private readonly apiKeyRedactor = new ApiKeyRedactor()
  redactToolOutput = (text: string): string => {
    this.apiKeyRedactor.rememberConfig(this.config)
    return this.apiKeyRedactor.redact(text)
  }
  private config: Config
  private configPath: string
  private persistedConfig: Partial<Config> = {}
  private loadFailure: unknown
  /** Human-readable notes about tier-era config found by the last `load()`. */
  private legacyModelFindings: string[] = []

  /**
   * `cwd` is kept in the signature although nothing here reads it: every caller
   * constructs one service per project, and the parameter is what makes the
   * "one config for all of them" rule visible at the call site.
   */
  constructor(_cwd: string, options?: ConfigServiceOptions) {
    this.configPath = options?.configPath ?? getGlobalConfigPath()
    this.config = structuredClone(DEFAULT_CONFIG)
  }

  async load(): Promise<void> {
    const previous = this.config
    try {
      const loaded = await readConfigurationFile<Partial<Config>>(this.configPath) ?? {}
      const persisted = structuredClone(loaded)
      const userSettings = await loadUserSettings()
      const settingsConfig = configFromSettings(userSettings)
      this.apiKeyRedactor.rememberConfig(settingsConfig)
      this.apiKeyRedactor.rememberConfig(loaded)
      this.config = deepMergeConfig(deepMergeConfig(DEFAULT_CONFIG, settingsConfig), loaded)
      this.migrateMaxEffort()
      this.legacyModelFindings = this.migrateLegacyTiers([userSettings, loaded])
      this.persistedConfig = persisted
      this.loadFailure = undefined
    } catch (error) {
      this.config = previous
      this.loadFailure = error
      throw error
    }
  }

  /**
   * Expand the retired `maxEffort` ceiling into `supportedEfforts`.
   *
   * In memory only, and silently: unlike the tier migration this changes no
   * behaviour — a prefix of the ladder clamps identically either way — so it is
   * not worth a startup warning. The field is rewritten to disk the next time
   * the model is saved.
   */
  private migrateMaxEffort(): void {
    for (const model of Object.values(this.config.models)) {
      const legacy = (model as { maxEffort?: unknown }).maxEffort
      delete (model as { maxEffort?: unknown }).maxEffort
      model.supportedEfforts = normalizeSupportedEfforts(model.supportedEfforts)
        ?? (typeof legacy === 'string' && legacy in EFFORT_RANK
          ? normalizeSupportedEfforts(
              VALID_EFFORT_LEVELS.filter(
                (level) => EFFORT_RANK[level] <= EFFORT_RANK[legacy as EffortLevel],
              ),
            )
          : undefined)
      if (model.supportedEfforts === undefined) delete model.supportedEfforts
    }
  }

  /**
   * What the last `load()` found left over from the tier era, already repaired.
   *
   * Reported rather than thrown, following `fallbackModel` / `compactModel`:
   * a stale config should start with a warning and a sane model, not refuse to
   * launch. `bootstrap()` turns these into `RuntimeDiagnostic`s.
   */
  getLegacyModelFindings(): readonly string[] {
    return this.legacyModelFindings
  }

  /**
   * Recognize tier-era config, warn about it, and leave something workable.
   *
   * A tier name is only legacy when it does *not* name a real model. A user with
   * a model literally keyed `fast` and `routing.main: "fast"` has written a
   * perfectly valid new-style config, and rewriting it to `'inherit'` would
   * break a working setup to fix an imaginary one. (`resolveModelInput` has
   * always had to answer this same ambiguity in the model's favour.)
   *
   * Two repairs, both chosen so the agent still starts with a real model:
   *  - a `routing` value naming a tier becomes `'inherit'`, since the role it
   *    described no longer exists and inheriting the main model is the closest
   *    honest reading;
   *  - a `defaultModel` naming a tier becomes the first model key that actually
   *    resolves, because leaving it would make `getDefaultModel()` return
   *    undefined and nothing would answer "which model am I".
   */
  private migrateLegacyTiers(rawLayers: readonly (object | undefined)[]): string[] {
    const findings: string[] = []
    const isStaleTier = (value: string): boolean =>
      LEGACY_TIER_NAMES.includes(value.trim()) && !this.resolveModel(value.trim())

    for (const layer of rawLayers) {
      if (!layer) continue
      const record = layer as Record<string, unknown>
      if (record.profiles !== undefined) {
        findings.push('`profiles` is no longer supported; routing now names model keys directly.')
      }
      if (record.activeProfile !== undefined) {
        findings.push('`activeProfile` is no longer supported; routing now names model keys directly.')
      }
    }

    const routing = this.config.routing
    if (routing) {
      for (const role of ROUTED_ROLES) {
        const value = routing[role]
        if (value !== undefined && isStaleTier(value)) {
          findings.push(`routing.${role} was the tier "${value}"; treating it as "inherit".`)
          routing[role] = 'inherit'
        }
      }
      for (const [type, value] of Object.entries(routing.subagent ?? {})) {
        if (value !== undefined && isStaleTier(value)) {
          findings.push(`routing.subagent.${type} was the tier "${value}"; treating it as "inherit".`)
          routing.subagent![type] = 'inherit'
        }
      }
    }

    const defaultModel = this.config.defaultModel
    if (defaultModel !== undefined && isStaleTier(defaultModel)) {
      const replacement = Object.keys(this.config.models).find((key) => this.resolveModel(key))
      if (replacement) {
        findings.push(`defaultModel was the tier "${defaultModel}"; using model "${replacement}" instead.`)
        this.config.defaultModel = replacement
      } else {
        findings.push(`defaultModel was the tier "${defaultModel}" and no configured model resolves; it has been dropped.`)
        delete this.config.defaultModel
      }
    }

    // Deduplicate: `profiles` in two layers is one story, not two.
    return [...new Set(findings)]
  }

  /**
   * The one file writes go to. There is no project layer to prefer any more, so
   * an API key is written once instead of being copied into every directory the
   * agent is launched from.
   */
  getSaveTarget(): string {
    return this.configPath
  }

  async save(): Promise<void> {
    if (this.loadFailure !== undefined) throw this.loadFailure
    const expected = this.persistedConfig
    const config = JSON.parse(JSON.stringify(this.config)) as Config
    let saved: Partial<Config> | undefined
    try {
      await updateConfigurationFile<Partial<Config>>(this.getSaveTarget(), (current) => {
        if (!isDeepStrictEqual(current, expected)) {
          throw new Error('配置文件已被其他操作修改，请重新加载后再保存。')
        }
        for (const key of ['endpoints', 'models', 'routing', 'defaultModel', 'fallbackModel', 'compactModel', 'agent'] as const) delete current[key]
        saved = { ...current, ...config }
        return saved
      })
      this.persistedConfig = saved!
    } catch (error) {
      this.loadFailure = error
      throw error
    }
  }

  get(): Config {
    return this.config
  }

  getModel(name: string): ModelConfig | undefined {
    return this.resolveModel(name)
  }

  getDefaultModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.defaultModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  getFallbackModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.fallbackModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  getCompactModel(): ModelConfig | undefined {
    const modelKey = this.resolveModelReference(this.config.compactModel)
    return modelKey ? this.resolveModel(modelKey) : undefined
  }

  /**
   * The three top-level model references, written the same way: a name that
   * resolves to a real model is stored as given, so aliases and exact keys both
   * survive, and a name that resolves to nothing is refused rather than saved as
   * a reference `load()` would have to repair. Callers that need to report why
   * resolve the name first (see `resolveModelInput`).
   */
  setDefaultModel(name: string): void {
    this.setModelReference('defaultModel', name)
  }

  setFallbackModel(name: string): void {
    this.setModelReference('fallbackModel', name)
  }

  setCompactModel(name: string): void {
    this.setModelReference('compactModel', name)
  }

  /** @returns whether the name resolved and was stored. */
  setModelReference(field: ModelReferenceField, name: string): boolean {
    if (!this.resolveModelReference(name)) return false
    this.config[field] = name
    return true
  }

  /** The configured reference for a field, exactly as stored (aliases included). */
  getModelReference(field: ModelReferenceField): string | undefined {
    return this.config[field]
  }

  /** Every configured model key, in config order. */
  listModelKeys(): string[] {
    return Object.keys(this.config.models)
  }

  /** Safe, explicit projection in configuration order; unresolved endpoints are omitted. */
  listSelectableModels(): ModelCatalogEntry[] {
    return this.listModelKeys().flatMap((key) => {
      const model = this.resolveModelReference(key) ? this.resolveModel(key) : undefined
      return model ? [{ key, model: model.model, ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }) }] : []
    })
  }

  addModel(name: string, model: ModelConfig): void {
    this.setModelConfig(name, model)
  }

  resolveModel(name: string): ModelConfig | undefined {
    const model = this.config.models[name]
    if (!model) return undefined

    if (!model.endpoint) {
      return model.provider ? { ...model } : undefined
    }

    const endpoint = this.config.endpoints?.[model.endpoint]
    if (!endpoint) return undefined
    const resolved: ModelConfig = {
      provider: endpoint.provider,
      ...(endpoint.baseUrl !== undefined ? { baseUrl: endpoint.baseUrl } : {}),
      ...(endpoint.apiKey !== undefined ? { apiKey: endpoint.apiKey } : {}),
      ...(endpoint.promptCaching !== undefined ? { promptCaching: endpoint.promptCaching } : {}),
      ...(endpoint.thinkingFormat !== undefined ? { thinkingFormat: endpoint.thinkingFormat } : {}),
      ...model,
    }
    return resolved.provider ? resolved : undefined
  }

  /**
   * Which model key a role should run on.
   *
   * Three steps, and there is no fourth: look the role up in `routing`; if it
   * named a model key that resolves, use it; otherwise — `'inherit'`, absent, or
   * a name that no longer resolves — fall back to the current model, then to
   * `defaultModel`. An unresolvable routing entry degrading to the parent model
   * is deliberate: it is what makes deleting a model a recoverable mistake.
   */
  resolveModelKeyFor(role: RoutingRole, options: { currentModelKey?: string } = {}): string | undefined {
    const fallback = this.resolveFallbackModelKey(options.currentModelKey)
    const routed = pickRoutedModel(this.getRouting(), role)
    if (routed === undefined || routed === 'inherit') return fallback
    return this.resolveModel(routed) ? routed : fallback
  }

  resolveModelInput(input: string): string | undefined {
    return this.resolveModelReference(input)
  }

  /**
   * A configured name to a usable model key. `'inherit'` is not a
   * misconfiguration — it resolves to nothing on purpose.
   */
  resolveModelReference(reference: string | undefined): string | undefined {
    const trimmed = reference?.trim()
    if (!trimmed) return undefined
    if (trimmed.toLowerCase() === 'inherit') return undefined
    return this.resolveModel(trimmed) ? trimmed : undefined
  }

  private resolveFallbackModelKey(currentModelKey?: string): string | undefined {
    if (currentModelKey && this.resolveModel(currentModelKey)) return currentModelKey
    return this.resolveModelReference(this.config.defaultModel)
  }

  getEndpoint(name: string): Endpoint | undefined {
    return this.config.endpoints?.[name]
  }

  setEndpoint(name: string, endpoint: Endpoint): void {
    this.config.endpoints = { ...this.config.endpoints, [name]: endpoint }
  }

  /** The models that resolve through one endpoint, in config order. */
  modelsForEndpoint(name: string): string[] {
    return Object.entries(this.config.models)
      .filter(([, model]) => model.endpoint === name)
      .map(([key]) => key)
  }

  /**
   * Removes an endpoint **and every model that resolves through it**.
   *
   * It used to throw instead. That made an endpoint undeletable until the user
   * had hunted down each of its models by hand, for a reference the config can
   * repair itself: a model whose endpoint is gone cannot resolve, so keeping it
   * only leaves a key that silently does nothing. Deleting is now one act, and
   * `removeModel` below is what re-points whatever spoke for those models.
   *
   * The one thing that still blocks a removal is a turn *running* on the model,
   * and that is not a fact the config knows — the desktop shell checks it before
   * calling in (`ShellHost.applySettingsChange`).
   */
  removeEndpoint(name: string): void {
    for (const modelName of this.modelsForEndpoint(name)) this.removeModel(modelName)
    if (!this.config.endpoints?.[name]) return
    const { [name]: _removed, ...rest } = this.config.endpoints
    this.config.endpoints = Object.keys(rest).length > 0 ? rest : undefined
  }

  /**
   * Renames an endpoint and re-points the models that resolve through it.
   *
   * Its own command rather than a remove plus an add, for the same reason
   * `renameModel` is: `removeEndpoint` deletes the endpoint's models, so the
   * pair would turn a rename into a silent deletion of everything that named it.
   */
  renameEndpoint(oldName: string, newName: string): void {
    if (oldName === newName) return
    const endpoints = this.config.endpoints ?? {}
    const endpoint = endpoints[oldName]
    if (!endpoint) throw new Error(`Endpoint "${oldName}" not found.`)
    if (endpoints[newName]) throw new Error(`Endpoint "${newName}" already exists.`)

    const { [oldName]: _renamed, ...rest } = endpoints
    this.config.endpoints = { ...rest, [newName]: endpoint }
    for (const key of this.modelsForEndpoint(oldName)) {
      this.config.models[key] = { ...this.config.models[key]!, endpoint: newName }
    }
  }

  setModelConfig(name: string, model: ModelConfig): void {
    this.config.models = { ...this.config.models, [name]: model }
    if (!this.config.defaultModel?.trim() && this.resolveModel(name)) {
      this.config.defaultModel = name
    }
  }

  /**
   * Removes a model and repairs everything that pointed at it.
   *
   * This used to throw for each of the four references below — `defaultModel`,
   * `fallbackModel`, `compactModel` and any `routing` role. That made the model
   * you are most likely to want to replace the one you could not delete, and it
   * was a check with nothing behind it: there are no model *tiers* any more, so
   * "the default" is only "where a new session starts", not a rank.
   *
   * So each reference is repaired rather than defended. The three top-level
   * fields move to the next model still configured — `config.models` is written
   * in insertion order, so "the next one" is the one below it on the settings
   * screen — and are dropped entirely when nothing is left. A routing role goes
   * back to `'inherit'`, which `resolveModelKeyFor` already reads as "follow the
   * main model" and is the same thing that role would have degraded to.
   */
  removeModel(name: string): void {
    delete this.config.models[name]
    const successor = Object.keys(this.config.models)[0]

    for (const field of ['defaultModel', 'fallbackModel', 'compactModel'] as const) {
      if (this.config[field] !== name) continue
      if (successor === undefined) delete this.config[field]
      else this.config[field] = successor
    }

    const { routing } = this.config
    if (!routing) return
    for (const [role] of routingReferences(routing).filter(([, value]) => value === name)) {
      if (role.startsWith('subagent.')) routing.subagent![role.slice('subagent.'.length)] = 'inherit'
      else routing[role as DirectRouteRole] = 'inherit'
    }
  }

  renameModel(oldKey: string, newKey: string): void {
    if (oldKey === newKey) return
    const model = this.config.models[oldKey]
    if (!model) throw new Error(`Model "${oldKey}" not found.`)
    if (this.config.models[newKey]) throw new Error(`Model "${newKey}" already exists.`)

    this.setModelConfig(newKey, model)
    delete this.config.models[oldKey]

    if (this.config.defaultModel === oldKey) this.config.defaultModel = newKey
    if (this.config.fallbackModel === oldKey) this.config.fallbackModel = newKey
    if (this.config.compactModel === oldKey) this.config.compactModel = newKey

    const routing = this.config.routing
    if (routing) {
      for (const role of ROUTED_ROLES) {
        if (routing[role] === oldKey) routing[role] = newKey
      }
      for (const [type, value] of Object.entries(routing.subagent ?? {})) {
        if (value === oldKey) routing.subagent![type] = newKey
      }
    }
  }

  getRouting(): Routing {
    return mergeRouting(this.config.routing)
  }

  setRouting(routing: Routing): void {
    this.config.routing = mergeRouting(routing)
  }

  /**
   * Patches `agent.contextManagement`, one field or several.
   *
   * Written here because context management is global configuration;
   * project and local settings cannot provide it.
   *
   * Throws on a value that cannot mean anything, the way `removeModel` does:
   * these numbers feed the token budget, and a zero context window or a
   * ratio above 1 does not degrade — it makes every turn either compact
   * immediately or never.
   */
  setContextManagement(patch: Partial<ContextManagementConfig>): void {
    const sanitized = sanitizeContextManagement(patch)
    if (!sanitized) return
    for (const [field, value] of Object.entries(sanitized) as Array<[keyof ContextManagementConfig, number]>) {
      const isRatio = field === 'microCompactThresholdRatio' || field === 'autoCompactReserveRatio'
      if (isRatio) {
        if (!Number.isFinite(value) || value <= 0 || value > 1) {
          throw new Error(`agent.contextManagement.${field} must be a ratio in (0, 1].`)
        }
      } else if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`agent.contextManagement.${field} must be a positive integer.`)
      }
    }
    this.config.agent = {
      ...this.config.agent,
      contextManagement: { ...this.config.agent.contextManagement, ...sanitized },
    }
  }

  /**
   * The global coordination group, day defaults filled in.
   *
   * Read from `agent.coordination` and nowhere else: the six scheduling values
   * are account-level, and a project layer that still names one is legacy data
   * the migration consumes rather than a fallback source.
   */
  getCoordination(): ResolvedCoordinationConfig {
    return resolveCoordination(this.config.agent.coordination)
  }

  /** Patches the group; an explicit `undefined` deletes that field. */
  setCoordination(patch: CoordinationConfig): void {
    const next: CoordinationConfig = { ...this.config.agent.coordination }
    for (const [field, value] of Object.entries(patch) as Array<[keyof CoordinationConfig, unknown]>) {
      if (value === undefined) {
        delete next[field]
        continue
      }
      if (field === 'quietDays' || field === 'autoResolveDays') {
        if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
          throw new Error(`agent.coordination.${field} must be a non-negative integer.`)
        }
        next[field] = value
        continue
      }
      if (typeof value !== 'string' || !VALID_EFFORT_LEVELS.includes(value as EffortLevel)) {
        throw new Error(`agent.coordination.${field} must be one of: ${VALID_EFFORT_LEVELS.join(', ')}.`)
      }
      next[field] = value as EffortLevel
    }
    this.config.agent = { ...this.config.agent, coordination: next }
  }

  /**
   * Sets one coordination routing role; `'inherit'` is stored as written.
   *
   * `allowUnknown` is for the migration: it promotes a legacy value even when
   * no model currently answers to it, so the settings screen can show the
   * broken reference instead of the value silently disappearing.
   */
  setCoordinationRouting(role: CoordinationRole, value: string, options: { allowUnknown?: boolean } = {}): void {
    const trimmed = value.trim()
    if (!trimmed) throw new Error(`routing.${role} needs a model key or "inherit".`)
    if (trimmed !== 'inherit' && !options.allowUnknown && !this.resolveModel(trimmed)) {
      throw new Error(`routing.${role} names unknown model "${trimmed}".`)
    }
    this.config.routing = { ...mergeRouting(this.config.routing), [role]: trimmed }
  }

  /**
   * The model one coordination role runs on.
   *
   * Unlike {@link resolveModelKeyFor} this refuses to hide a broken role: a
   * configured key that no longer resolves is reported as `invalid` so the
   * session shows a configuration failure instead of quietly running on the
   * main model. `undefined` with no `invalid` means "inherit", which resolves
   * through the main-model rules.
   */
  resolveCoordinationModelKey(role: CoordinationRole): { modelKey?: string; invalid?: string } {
    const routed = pickRoutedModel(this.getRouting(), { kind: role })
    if (routed === undefined || routed === 'inherit') {
      return { modelKey: this.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: this.config.defaultModel }) }
    }
    if (this.resolveModel(routed)) return { modelKey: routed }
    return { invalid: routed }
  }
}

/** The routing keys that hold a model directly (subagents are nested). */
const ROUTED_ROLES = ['main', 'plan', 'compact', 'coordinator', 'thread'] as const

type DirectRouteRole = (typeof ROUTED_ROLES)[number]

/**
 * Every `role -> value` pair in a routing map, subagents included, as
 * `['plan', 'sonnet']` / `['subagent.explore', 'haiku']`. One walk shared by the
 * removal check and anything else that has to ask "who points at this model".
 */
function routingReferences(routing: Routing | undefined): Array<[string, string]> {
  if (!routing) return []
  const pairs: Array<[string, string]> = []
  for (const role of ROUTED_ROLES) {
    const value = routing[role]
    if (value !== undefined) pairs.push([role, value])
  }
  for (const [type, value] of Object.entries(routing.subagent ?? {})) {
    if (value !== undefined) pairs.push([`subagent.${type}`, value])
  }
  return pairs
}

function configFromSettings(settings?: MyAgentSettings): Partial<Config> {
  if (!settings) return {}

  return {
    ...(settings.models ? { models: settings.models } : {}),
    ...(settings.endpoints ? { endpoints: settings.endpoints } : {}),
    ...(settings.routing ? { routing: settings.routing } : {}),
    ...(settings.defaultModel !== undefined ? { defaultModel: settings.defaultModel } : {}),
    ...(settings.fallbackModel !== undefined ? { fallbackModel: settings.fallbackModel } : {}),
    ...(settings.compactModel !== undefined ? { compactModel: settings.compactModel } : {}),
    // `agent.coordination` is global-only: a project layer naming it is legacy
    // data the migration reads directly, never a source of runtime values.
    ...(settings.agent ? { agent: stripCoordination(settings.agent) } : {}),
  }
}

function stripCoordination(agent: AgentConfig): AgentConfig {
  if (!agent.coordination) return agent
  const { coordination: _ignored, ...rest } = agent
  return rest
}

function deepMergeConfig(base: Config, overrides: Partial<Config>): Config {
  const contextManagement = sanitizeContextManagement(overrides.agent?.contextManagement)
  return {
    endpoints: { ...base.endpoints, ...overrides.endpoints },
    models: { ...base.models, ...overrides.models },
    routing: mergeRouting(base.routing, overrides.routing),
    defaultModel: overrides.defaultModel ?? base.defaultModel,
    fallbackModel: overrides.fallbackModel ?? base.fallbackModel,
    compactModel: overrides.compactModel ?? base.compactModel,
    agent: {
      ...base.agent,
      ...overrides.agent,
      contextManagement: {
        ...base.agent.contextManagement,
        ...contextManagement,
      },
    },
  }
}

function sanitizeContextManagement(
  config?: Partial<ContextManagementConfig>,
): Partial<ContextManagementConfig> | undefined {
  if (!config) return undefined
  return {
    ...(config.contextWindow !== undefined ? { contextWindow: config.contextWindow } : {}),
    ...(config.summaryOutputTokens !== undefined ? { summaryOutputTokens: config.summaryOutputTokens } : {}),
    ...(config.autoCompactReserveRatio !== undefined ? { autoCompactReserveRatio: config.autoCompactReserveRatio } : {}),
    ...(config.manualCompactBufferTokens !== undefined ? { manualCompactBufferTokens: config.manualCompactBufferTokens } : {}),
    ...(config.microCompactThresholdRatio !== undefined ? { microCompactThresholdRatio: config.microCompactThresholdRatio } : {}),
  }
}
