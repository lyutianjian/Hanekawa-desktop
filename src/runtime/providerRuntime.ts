import type { ConfigService } from '../config/service.js'
import type { EffortLevel } from '../config/effort.js'
import type { SessionRecord } from '../harness/types.js'
import type { SessionMeta } from '../sessions/service.js'
import type { CreateRuntime } from './createRuntime.js'
import { MISSING_MODEL_ISSUE, RuntimeStartupError, type RuntimeConfigurationIssue } from './errors.js'
import type { RuntimeSlot } from './runtimeSlot.js'
import { resolveSessionModelSelection, type SessionModelSelection } from './sessionSelection.js'
import type { AgentSession } from './types.js'

export type ProviderConfigChangeScope = 'endpoints' | 'models' | 'routing'

/**
 * Resolve the model that should back the live runtime after /provider changes.
 *
 * A coordination session asks its own role: an edit to the main model must not
 * move a thread onto it, and a thread without an explicit pick follows the
 * global thread model. Every other edit keeps the key the session is already
 * running, which is what "rebuild but do not change model" means.
 *
 * An ordinary session keeps the rule it had before coordination existed: a
 * routing refresh re-resolves against the main role, everything else preserves
 * the current key. This batch deliberately does not give normal sessions a
 * persisted model pick.
 */
export function resolveRuntimeSelectionAfterConfigChange(deps: {
  config: ConfigService
  currentModelKey: string | undefined
  scope: ProviderConfigChangeScope
  session: Pick<SessionMeta, 'coordination'>
  defaultEffort: EffortLevel
}): SessionModelSelection {
  const role = deps.session.coordination?.role
  if (role === 'coordinator' || role === 'thread') {
    const selection = resolveSessionModelSelection(deps.config, deps.session, { defaultEffort: deps.defaultEffort })
    if (deps.scope !== 'routing' && deps.currentModelKey && deps.config.getModel(deps.currentModelKey)) {
      return { ...selection, modelKey: deps.currentModelKey }
    }
    return selection
  }

  if (deps.scope === 'routing') {
    const modelKey = deps.config.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: deps.currentModelKey })
    return { ...(modelKey ? { modelKey } : {}), effort: deps.defaultEffort }
  }
  if (deps.currentModelKey && deps.config.getModel(deps.currentModelKey)) {
    return { modelKey: deps.currentModelKey, effort: deps.defaultEffort }
  }
  const modelKey = deps.config.resolveModelKeyFor({ kind: 'main' })
  return { ...(modelKey ? { modelKey } : {}), effort: deps.defaultEffort }
}

/** Startup and settings edits share the same recoverable model-creation path. */
export function refreshRuntimeSlot(deps: {
  config: ConfigService
  runtimeSlot: RuntimeSlot
  createRuntime: CreateRuntime
  modelKey: string | undefined
  session: SessionMeta
  records?: readonly SessionRecord[]
  /** A configured model that does not resolve; reported instead of silently replaced. */
  issue?: RuntimeConfigurationIssue
  /**
   * A role's effort that just changed. Left absent, the slot keeps the level it
   * already had, so an unrelated provider edit cannot overwrite a manual pick.
   */
  effort?: EffortLevel
}): void {
  let next: AgentSession | undefined
  let issue: RuntimeConfigurationIssue = deps.issue ?? MISSING_MODEL_ISSUE
  if (deps.modelKey) {
    try {
      next = deps.createRuntime(deps.modelKey, deps.session, deps.records)
    } catch (error) {
      if (!(error instanceof RuntimeStartupError) || error.code === 'invalid_settings') throw error
      issue = { code: error.code, message: error.message }
    }
  } else if (!deps.issue) {
    const configured = deps.config.get().defaultModel?.trim()
    if (configured && configured.toLowerCase() !== 'inherit') {
      issue = { code: 'no_default_model', message: `Default model could not be resolved: ${configured}.` }
    }
  }
  deps.runtimeSlot.current?.loop.clearCachedSections()
  deps.runtimeSlot.replace(next, issue)
  if (deps.effort !== undefined) deps.runtimeSlot.setEffort(deps.effort)
  else deps.runtimeSlot.reapplyEffort()
}
