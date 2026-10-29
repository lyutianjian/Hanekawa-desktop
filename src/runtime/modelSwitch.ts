import type { ConfigService } from '../config/service.js'
import type { SessionRecord } from '../harness/types.js'
import { describeModelSwitchImageImpact } from '../harness/turnImages.js'
import type { SetModelResult } from '../commands/types.js'
import type { SessionMeta } from '../sessions/service.js'
import type { AgentSession } from './types.js'
import type { RuntimeSlot } from './runtimeSlot.js'

/**
 * Switching the model the live runtime is bound to, as `/model <name>` means it.
 *
 * This is a superset of the `set-model` host command, and the difference is
 * deliberate: `set-model` points the current runtime somewhere else, while
 * `/model` is the user naming a preference, so it also writes the choice back to
 * config. Do not fold the persistence into `set-model` — a fallback activation
 * or a picker preview would start rewriting the user's default.
 *
 * Errors come back as `SetModelResult` rather than thrown: every caller renders
 * the message, and the list of available models is part of that message.
 */
export interface ModelSwitchDeps {
  config: ConfigService
  runtimeSlot: RuntimeSlot
  /** Model keys as currently configured; the caller owns refreshing this. */
  availableModelKeys: readonly string[]
  createRuntime: (modelKey: string, session: SessionMeta, records: readonly SessionRecord[]) => AgentSession
  getSession: () => SessionMeta
  /** The live record list, folded into the new runtime's task state. */
  getRecords: () => readonly SessionRecord[]
}

/** The configured model keys — with tiers gone, there is nothing else to offer. */
function availableModels(deps: ModelSwitchDeps): string[] {
  return [...deps.availableModelKeys]
}

/**
 * Replaces the runtime with one bound to `modelKey`. Does not touch config.
 *
 * `clearCachedSections` before the swap: the cached Environment section embeds
 * the model name, so a stale prefix would survive into the next request.
 */
export function activateModelKey(deps: ModelSwitchDeps, modelKey: string): SetModelResult {
  if (!deps.availableModelKeys.includes(modelKey)) {
    return {
      ok: false,
      message: `未知模型：${modelKey}`,
      availableModels: availableModels(deps),
    }
  }

  try {
    const nextRuntime = deps.createRuntime(modelKey, deps.getSession(), deps.getRecords())
    deps.runtimeSlot.current?.loop.clearCachedSections()
    deps.runtimeSlot.replace(nextRuntime)
    // Re-apply current effort, moved onto a level the new model supports.
    deps.runtimeSlot.reapplyEffort()
    // History images never block a switch; they only change what the next
    // request looks like, so the impact is reported and the switch stands
    // (design §9.1). The capability comes off the new runtime's loop — the
    // same resolution the request path uses — never a model-name guess.
    const notice = describeModelSwitchImageImpact(
      deps.getRecords(),
      nextRuntime.loop.getActiveModel().supportsImageInput,
      nextRuntime.modelConfig.model,
    )
    return {
      ok: true,
      model: {
        key: nextRuntime.modelKey,
        model: nextRuntime.modelConfig.model,
        providerName: nextRuntime.providerName,
      },
      ...(notice ? { notice } : {}),
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      availableModels: availableModels(deps),
    }
  }
}

/**
 * `activateModelKey` plus the write-back that makes the choice stick.
 *
 * The pick is a global preference: the next session in *any* project starts on
 * it. Two writes buy that. `defaultModel` is where a new session looks by
 * default, and a `routing.main` naming some other model outranks it — so the
 * role is released back to `inherit` when it would keep winning, which is
 * exactly what the settings screen's 「默认模型」 control does. Without it,
 * picking a model here would change the live session and nothing else.
 *
 * The config save is fire-and-forget on purpose: the switch has already taken
 * effect in the live slot, and failing to persist a preference must not read as
 * a failed switch.
 *
 * `persist` is false for a coordination lane, whose model is its own
 * `modelOverride`: remembering that pick would retarget every project's next
 * main session.
 */
export function switchModel(deps: ModelSwitchDeps, input: string, persist = true): SetModelResult {
  const modelKey = deps.config.resolveModelInput(input)
  if (!modelKey) {
    return {
      ok: false,
      message: input.trim().toLowerCase() === 'inherit'
        ? '/model inherit is not supported. inherit is only valid in routing/subagent settings.'
        : `未知模型：${input}`,
      availableModels: availableModels(deps),
    }
  }
  const result = activateModelKey(deps, modelKey)
  if (result.ok && persist) {
    deps.config.setDefaultModel(modelKey)
    const routing = deps.config.getRouting()
    if (routing.main !== undefined && routing.main !== 'inherit' && routing.main !== modelKey) {
      deps.config.setRouting({ ...routing, main: 'inherit' })
    }
    void deps.config.save().catch(() => {})
  }
  return result
}
