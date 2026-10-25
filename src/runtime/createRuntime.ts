import { createProvider, resolveImageCapability } from '../config/providers.js'
import { buildMemoryIndexContext, buildMemoryPrompt, readMemoryIndex } from '../services/memory/memoryPrompt.js'
import { createMemoryIndexWatch } from '../services/memory/memoryIndexWatch.js'
import { composeProjectContext, readUserInstructions } from '../services/context/projectContext.js'
import type { ConfigService, ModelConfig, ThinkingConfig } from '../config/service.js'
import type { EffortLevel, EffortValue } from '../config/effort.js'
import type { RoutingRole } from '../config/routing.js'
import { validateSettings, type MyAgentSettings } from '../config/settings.js'
import { COORDINATOR_ROLE_PROMPT } from '../prompts/coordinatorPrompt.js'
import { CoordinationStore } from '../services/coordination/threadStore.js'
import { formatCoordinationUpdate, formatCoordinatorRestore, formatThreadTaskRestore } from './coordination/messages.js'
import { createModelConfigPort } from './modelConfigPort.js'
import { AgentLoop, type ActiveModelRuntime } from '../harness/loop.js'
import { ContextBuilder } from '../harness/contextBuilder.js'
import { priceUsage } from '../harness/usage.js'
import { PlanModeManager } from '../harness/planModeManager.js'
import { ToolRunner } from '../harness/toolRunner.js'
import type { SystemPromptSectionCache } from '../harness/sections.js'
import type { PermissionGate } from '../harness/permissions.js'
import type { AttachmentBytesLoader, CoordinationRole, ImageAttachmentImporter, MemoryIndexWatch, ModelPricing, ModelProvider, SessionRecord, ToolContext } from '../harness/types.js'
import type { AttachmentFactsResolver } from '../harness/turnImages.js'
import { MODEL_CONTEXT_WINDOW_DEFAULT } from '../prompts/budget.js'
import type { ContextManagementConfig } from '../prompts/budget.js'
import { JsonlRecordStream } from '../sessions/recordStream.js'
import type { SessionMeta, SessionStore } from '../sessions/service.js'
import { createAgentTool, prepareForkPreloadRecords } from '../tools/AgentTool/AgentTool.js'
import type { BaseAgentDefinition } from '../tools/AgentTool/AgentTool.js'
import { restoreTaskStateFromRecords } from '../tools/taskState.js'
import { rememberShownFiles } from '../tools/fileState.js'
import type { SkillDefinition } from '../services/skills/skillsService.js'
import type { BackgroundTaskRegistry } from '../services/backgroundTasks/registry.js'
import type { RecordProxy, UiBridges } from './bridges.js'
import { RuntimeStartupError } from './errors.js'
import type { ToolRegistry } from './toolRegistry.js'
import type { AgentSession } from './types.js'

function createModelProvider(modelKey: string, modelConfig: ModelConfig) {
  const validation = validateSettings({ models: { [modelKey]: modelConfig } })
  if (!validation.valid) throw new RuntimeStartupError('unknown_model', validation.errors.join('\n'))
  let provider
  try {
    provider = createProvider(modelConfig)
  } catch (error) {
    // SDKs can reject local configuration (for example a missing API key)
    // during construction, before the user has had a chance to open settings.
    throw new RuntimeStartupError(
      'provider_creation_failed',
      `Could not initialize provider "${modelConfig.provider}": ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  if (!provider) {
    throw new RuntimeStartupError('provider_creation_failed', `Unsupported or missing provider: ${modelConfig.provider ?? '(none)'}`)
  }
  // Every runtime's provider comes through here, so each response is priced by
  // the model that actually served it.
  return withPricing(provider, modelConfig.pricing)
}

/** Attaches `pricing`'s cost to every response's usage, on the provider itself. */
export function withPricing(provider: ModelProvider, pricing: ModelPricing | undefined): ModelProvider {
  const createMessage = provider.createMessage.bind(provider)
  provider.createMessage = async (request) => {
    const response = await createMessage(request)
    return response.usage ? { ...response, usage: priceUsage(response.usage, pricing) } : response
  }
  return provider
}

/** The model's own window, else the global default from `agent.contextManagement`. */
export function resolveContextWindow(
  model: ModelConfig,
  contextManagement: Partial<ContextManagementConfig> | undefined,
): number {
  return model.contextWindow ?? contextManagement?.contextWindow ?? MODEL_CONTEXT_WINDOW_DEFAULT
}

/**
 * Resolves a model key into the provider/model pair the loop runs on.
 * Re-reads `config` on every call, so `/provider` edits take effect without
 * restarting.
 */
export function createActiveModelRuntimeFactory(
  config: ConfigService,
  contextManagement?: Partial<ContextManagementConfig>,
): (modelKey: string) => ActiveModelRuntime {
  return (modelKey: string): ActiveModelRuntime => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new RuntimeStartupError('unknown_model', `Unknown model: ${modelKey}`)
    }
    const targetProvider = createModelProvider(modelKey, targetModelConfig)
    return {
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: resolveContextWindow(targetModelConfig, contextManagement),
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
    }
  }
}

export interface CreateRuntimeDeps {
  /** The project root: keys data dirs (plans, memory, spill, transcripts). */
  cwd: string
  /** Where tools run; a coordination thread's worktree. Defaults to `cwd`. */
  workingDir?: string
  /** The session's coordination role, which filters the tool set. */
  role?: CoordinationRole
  config: ConfigService
  store: SessionStore
  /**
   * All four are read at call time rather than captured, so a reload changes
   * what the *next* runtime is built from. `/agents reload` only ever worked
   * because it was already a getter; settings and skills were captured by value
   * and silently stayed at their startup contents for the life of the process.
   */
  getSettings: () => MyAgentSettings
  getSkills: () => SkillDefinition[]
  getAgentDefinitions: () => BaseAgentDefinition[]
  /**
   * The project's `AGENTS.md` / `CLAUDE.md` files, labelled. Captured per
   * runtime like the settings above, so an edit reaches a session on the next
   * rebuild — see `reloadSettings`'s `needsRuntimeRebuild`.
   */
  getProjectEntries: () => readonly string[]
  /** Set when auto memory is on for this scope; the index is read once per session id. */
  memoryDir?: string
  toolRegistry: ToolRegistry
  promptSections: SystemPromptSectionCache
  permissionGate: PermissionGate
  backgroundTasks: BackgroundTaskRegistry
  bridges: UiBridges
  contextManagement: Partial<ContextManagementConfig> | undefined
  isGitRepo: boolean
  initialEffort: EffortValue
  createActiveModelRuntime: (modelKey: string) => ActiveModelRuntime
  /**
   * Called by every write tool before they write, so the session's file history
   * can back the file up. Subagents inherit it through their forked context.
   */
  trackFileEdit?: (filePath: string) => Promise<void>
  /**
   * The project's attachment store, shared by `@`-mentioned project images
   * (input preparation) and the Read tool's image branch (toolContext). One
   * service per project (see `bootstrap`); the loop keeps its own reference,
   * and the Agent tool wraps it per subagent run so the child's images are
   * owned by this session rather than by the agent id (S23).
   */
  imageAttachments?: ImageAttachmentImporter
  /**
   * The project's attachment store as the request path's facts resolver —
   * current-input availability checks and historical-image placeholders (S15).
   */
  attachmentFacts?: AttachmentFactsResolver
  /**
   * The project's attachment store as the request path's send-byte loader —
   * the loop loads final-send image bytes through it (S17).
   */
  attachmentBytes?: AttachmentBytesLoader
  /**
   * Notified whenever a runtime is built for a different session than the last
   * one. `bootstrap` uses it to retarget session-scoped state (denial counters)
   * that the gate holds across runtimes.
   */
  onActiveSessionChange?: (sessionId: string) => void
}

export type CreateRuntime = (
  modelKey: string,
  runtimeSession: SessionMeta,
  runtimeRecords?: readonly SessionRecord[],
) => AgentSession

/**
 * Builds the factory that assembles one complete agent runtime. Every model
 * switch, `/clear`, and resume calls it again and disposes the previous
 * result.
 */
export function createRuntimeFactory(deps: CreateRuntimeDeps): CreateRuntime {
  const {
    cwd,
    workingDir = cwd,
    role,
    config,
    store,
    getSettings,
    getSkills,
    getAgentDefinitions,
    getProjectEntries,
    memoryDir,
    toolRegistry,
    promptSections,
    permissionGate,
    backgroundTasks,
    bridges,
    contextManagement,
    isGitRepo,
    initialEffort,
    createActiveModelRuntime,
    trackFileEdit,
    imageAttachments,
    attachmentFacts,
    attachmentBytes,
    onActiveSessionChange,
  } = deps
  let activeSessionId: string | undefined

  // Read once per session id, not per runtime: a rebuild of an open session
  // keeps them, so an edit — the model's or the settings screen's — reaches the
  // next new session without moving an open session's cached prefix. The one
  // global-file read feeds both the memory section's wording and the
  // instructions message, so they cannot disagree.
  type SessionSnapshot = { sessionId: string; userInstructions: string; memoryPrompt: string; memoryIndex?: string; memoryIndexWatch?: MemoryIndexWatch }
  let sessionSnapshot: SessionSnapshot | undefined
  const snapshotFor = (sessionId: string): SessionSnapshot => {
    if (sessionSnapshot?.sessionId !== sessionId) {
      const userInstructions = readUserInstructions()
      const index = memoryDir ? readMemoryIndex(memoryDir) : ''
      const memoryIndex = memoryDir ? buildMemoryIndexContext(memoryDir, index) : undefined
      sessionSnapshot = {
        sessionId,
        userInstructions,
        memoryPrompt: buildMemoryPrompt(memoryDir, userInstructions),
        ...(memoryIndex ? { memoryIndex } : {}),
        ...(memoryDir ? { memoryIndexWatch: createMemoryIndexWatch(memoryDir, index) } : {}),
      }
    }
    return sessionSnapshot
  }

  const createRoutedRuntime = (
    role: RoutingRole,
    currentModelKey: string,
  ): ActiveModelRuntime | undefined => {
    const routedModelKey = config.resolveModelKeyFor(role, { currentModelKey })
    return routedModelKey ? createActiveModelRuntime(routedModelKey) : undefined
  }

  return (modelKey, runtimeSession, runtimeRecords = []) => {
    const targetModelConfig = config.getModel(modelKey)
    if (!targetModelConfig) {
      throw new RuntimeStartupError('unknown_model', `Unknown model: ${modelKey}`)
    }

    const targetProvider = createModelProvider(modelKey, targetModelConfig)

    // Past the last throwing validation, so a rejected model key never
    // retargets session-scoped state.
    onActiveSessionChange?.(runtimeSession.id)

    const currentFallbackModelKey = config.resolveModelReference(config.get().fallbackModel)
    const fallbackModel = currentFallbackModelKey && currentFallbackModelKey !== modelKey
      ? createActiveModelRuntime(currentFallbackModelKey)
      : undefined

    const currentCompactModelKey = config.resolveModelReference(config.get().compactModel)
    const compactModel = currentCompactModelKey
      ? createActiveModelRuntime(currentCompactModelKey)
      : createRoutedRuntime({ kind: 'compact' }, modelKey)
    const planModel = createRoutedRuntime({ kind: 'plan' }, modelKey)

    const snapshot = snapshotFor(runtimeSession.id)
    activeSessionId = runtimeSession.id
    let disposed = false
    // Disk writes use the runtime's fixed RecordStream. UI events must also
    // stay with that session when an append or background callback arrives late.
    const isCurrent = () => !disposed && activeSessionId === runtimeSession.id
    const recordEvents: Pick<RecordProxy, 'onRecord' | 'onProgress' | 'onStreamEvent' | 'onRequestUsage'> = {
      onRecord: (record) => {
        if (isCurrent()) bridges.record.onRecord(record)
      },
      onProgress: (event) => {
        if (isCurrent()) bridges.record.onProgress(event)
      },
      onStreamEvent: (event) => {
        if (isCurrent()) bridges.record.onStreamEvent(event)
      },
      onRequestUsage: (usage, anchorRecordId) => {
        if (isCurrent()) bridges.record.onRequestUsage(usage, anchorRecordId)
      },
    }
    const projectContext = composeProjectContext(snapshot.userInstructions, getProjectEntries())
    const watch = snapshot.memoryIndexWatch
    const recordStream = new JsonlRecordStream(store, runtimeSession.id)
    let loop: AgentLoop | undefined
    const planModeManager = new PlanModeManager({
      cwd,
      sessionMeta: runtimeSession,
      store,
      gate: permissionGate,
      appendRecord: async (record) => {
        await recordStream.append(record)
        loop?.noteRecordAppended(record)
        recordEvents.onRecord(record)
      },
      loadRecords: async () => recordStream.load(),
      openEnterPrompt: bridges.enterPlan.open,
      openExitDialog: bridges.exitPlan.open,
    })
    const planSlugProvider = () => planModeManager.getSlug()
    permissionGate.setPlanSlugProvider(planSlugProvider)

    // `thinking: false` in settings means "send no thinking parameter"; unset is
    // the adaptive default. Read per runtime, so a settings reload followed by a
    // rebuild is all it takes for the switch to reach a session.
    const thinking: ThinkingConfig = getSettings().thinking === false
      ? { type: 'disabled' }
      : { type: 'adaptive' }

    const runtimeTools = toolRegistry.buildRuntimeTools(role)
    runtimeTools.push(createAgentTool({
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: resolveContextWindow(targetModelConfig, contextManagement),
      providerName: targetProvider.name,
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
      fallbackModel,
      tools: () => runtimeTools,
      permissionPrompt: bridges.prompt.prompt,
      permissionMode: () => permissionGate.getMode(),
      getConfigRules: () => permissionGate.getConfigRules(),
      getSessionRules: () => permissionGate.getSessionRules(),
      getSessionRuleStore: () => permissionGate.getSessionRuleStore(),
      getAdditionalDirectories: () => permissionGate.getAdditionalDirectories(),
      cwd: workingDir,
      projectDir: cwd,
      system: config.get().agent.system,
      projectContext,
      skills: getSkills(),
      agentDefinitions: getAgentDefinitions(),
      loadParentRecords: async () => prepareForkPreloadRecords(await recordStream.load()),
      contextManagement,
      isGitRepo,
      hooks: getSettings().hooks,
      cacheRuntime: { settings: getSettings(), env: process.env },
      // Subagents follow the same switch as the main loop.
      thinking,
      compactModel,
      onSubagentProgress: recordEvents.onProgress,
      resolveSubagentModel: (subagentType, requestedModelKey) => requestedModelKey
        ? createActiveModelRuntime(requestedModelKey)
        : createRoutedRuntime(
          { kind: 'subagent', type: subagentType },
          modelKey,
        ),
      backgroundTasks,
      // The same three handles the main loop gets. The Agent tool re-owns the
      // importer per run so a subagent's images land in *this* session's tree
      // (S23); the two read-only ones pass straight through, since they only
      // resolve refs that are already registered.
      ...(imageAttachments ? { imageAttachments } : {}),
      ...(attachmentFacts ? { attachmentFacts } : {}),
      ...(attachmentBytes ? { attachmentBytes } : {}),
    }))

    toolRegistry.register(runtimeTools, role)
    const runtimeToolRunner = new ToolRunner(runtimeTools, permissionGate, {
      onRecord: async (record) => {
        await recordStream.append(record)
        recordEvents.onRecord(record)
      },
      onProgress: (event) => {
        recordEvents.onProgress(event)
      },
    }, {
      preToolUse: getSettings().hooks?.preToolUse,
      postToolUse: getSettings().hooks?.postToolUse,
    })

    // Only the coordinator lane reads the board; a superseded coordinator
    // (the pointer moved on) consumes nothing. A thread reads its own row, for
    // the task it must pick up again after a compaction summarized it away.
    const coordStore = role === 'coordinator' || role === 'thread'
      ? new CoordinationStore(cwd, { lifecycle: () => config.getCoordination() })
      : undefined
    const coordinationHooks = coordStore && role === 'coordinator'
      ? {
          rolePrompt: COORDINATOR_ROLE_PROMPT,
          compactPromptVariant: 'coordinator' as const,
          consumeCoordinationUpdate: async () => {
            if ((await coordStore.read()).coordinator?.sessionId !== runtimeSession.id) return undefined
            const update = await coordStore.peekCoordinationUpdate()
            if (!update) return undefined
            const content = formatCoordinationUpdate({ ...(update.snapshot ? { snapshot: update.snapshot } : {}), notes: update.notes.map((n) => ({ threadId: n.threadId, text: n.text })) })
            if (!content) return undefined
            return { content, ack: () => coordStore.ackCoordinationUpdate(update) }
          },
          coordinationRestore: async () => {
            const update = await coordStore.peekCoordinationUpdate()
            const notes = update?.notes ?? []
            const text = formatCoordinatorRestore({ board: await coordStore.currentBoard(), notes: notes.map((n) => n.text) })
            if (notes.length > 0) await coordStore.ackCoordinationUpdate({ notes })
            return text
          },
        }
      : coordStore && role === 'thread'
        ? {
            compactPromptVariant: 'thread' as const,
            taskRestore: async (input: { lastInstruction?: { text: string; recordId: string } }) => {
              const { threads } = await coordStore.read()
              const thread = threads.find((row) => row.sessionId === runtimeSession.id)
              if (!thread) return undefined
              return formatThreadTaskRestore({
                threadId: thread.threadId,
                title: thread.title,
                brief: thread.brief,
                ...(thread.background ? { background: thread.background } : {}),
                ...(thread.worktree ? { branch: thread.worktree.branch } : {}),
                ...(input.lastInstruction ? { lastInstruction: input.lastInstruction } : {}),
              })
            },
          }
        : {}

    const toolContext: ToolContext = {
      cwd: workingDir,
      projectDir: cwd,
      sessionId: runtimeSession.id,
      readFiles: new Set(),
      readFileState: new Map(),
      invokedSkills: new Map(),
      taskState: new Map(restoreTaskStateFromRecords(runtimeRecords)),
      getPermissionMode: () => permissionGate.getMode(),
      setPermissionMode: (mode) => permissionGate.setMode(mode),
      exitPlanMode: () => permissionGate.exitPlanMode(),
      planModeBridge: planModeManager.buildBridge(),
      askUserQuestionBridge: bridges.askUserQuestion,
      ...(trackFileEdit || watch
        ? {
            trackFileEdit: async (filePath: string) => {
              watch?.noteWrite(filePath)
              await trackFileEdit?.(filePath)
            },
          }
        : {}),
      ...(imageAttachments ? { imageAttachments } : {}),
      // Model references belong to config.json, so the Config tool writes them
      // through ConfigService — the same owner the model picker uses — rather
      // than through settings.json, which the config layer overrides.
      modelConfig: createModelConfigPort(config),
    }
    // Instruction files the conversation opens with count as read.
    void rememberShownFiles([projectContext, snapshot.memoryIndex ?? ''].join('\n\n'), toolContext)

    loop = new AgentLoop({
      ...coordinationHooks,
      provider: targetProvider,
      model: targetModelConfig.model,
      modelKey,
      contextWindow: resolveContextWindow(targetModelConfig, contextManagement),
      tools: runtimeTools,
      contextBuilder: new ContextBuilder(undefined, contextManagement, promptSections),
      toolRunner: runtimeToolRunner,
      toolContext,
      system: config.get().agent.system,
      projectContext,
      memoryPrompt: snapshot.memoryPrompt,
      memoryIndex: snapshot.memoryIndex,
      ...(watch ? { memoryIndexWatch: watch } : {}),
      skills: getSkills(),
      promptCacheRetention: targetModelConfig.promptCacheRetention,
      supportsImageInput: resolveImageCapability(targetModelConfig),
      contextManagement,
      isGitRepo,
      hooks: getSettings().hooks,
      cacheRuntime: { settings: getSettings(), env: process.env },
      thinking,
      effort: typeof initialEffort === 'string' ? initialEffort as EffortLevel : undefined,
      permissionMode: () => permissionGate.getMode(),
      planModeManager,
      fallbackModel,
      compactModel,
      planModel,
      getCompactFailureCount: async () => (await store.load(runtimeSession.id))?.compactFailureCount ?? 0,
      setCompactFailureCount: async (count) => store.setCompactFailureCount(runtimeSession.id, count),
      recordStream,
      onRecord: recordEvents.onRecord,
      onStreamEvent: recordEvents.onStreamEvent,
      onRequestUsage: recordEvents.onRequestUsage,
      consumePendingUserMessages: (midTurn) => backgroundTasks.consumeParentNotifications(runtimeSession.id, midTurn),
      steer: bridges.steer,
      ...(imageAttachments ? { imageAttachments } : {}),
      ...(attachmentFacts ? { attachmentFacts } : {}),
      ...(attachmentBytes ? { attachmentBytes } : {}),
    })

    const activeLoop = loop
    return {
      loop: activeLoop,
      planModeManager,
      modelKey,
      modelConfig: targetModelConfig,
      providerName: targetProvider.name,
      run: (input, signal, messageId, overrides) => activeLoop.run(input, signal, messageId, overrides),
      dispose: () => {
        disposed = true
        toolRegistry.unregister(runtimeTools)
        permissionGate.clearPlanSlugProvider(planSlugProvider)
      },
    }
  }
}
