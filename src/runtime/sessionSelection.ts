/**
 * The one place a session's model and effort are decided.
 *
 * Every path that puts a runtime behind a session — a new session, reopening
 * one, a settings refresh, an app restart, a coordinator or a thread delivered
 * to cold — goes through here, so the answer cannot differ by how the session
 * arrived. The order is the plan's: an explicit session pick, then the global
 * role, then the main model.
 *
 * An explicit pick that no longer resolves is an *error*, not a fallback: a
 * renamed or deleted model must be visible in the session, not quietly replaced
 * by the main model.
 */

import { clampEffort, type EffortLevel } from '../config/effort.js'
import type { ConfigService } from '../config/service.js'
import { logDiagnostics } from '../harness/diagnostics.js'
import type { SessionMeta } from '../sessions/service.js'
import type { RuntimeConfigurationIssue } from './errors.js'

export interface SessionModelSelection {
  modelKey?: string
  /** Already clamped to what `modelKey` accepts; the preference itself is untouched. */
  effort: EffortLevel
  /** Set when a configured model could not be honoured. */
  issue?: RuntimeConfigurationIssue
}

export function resolveSessionModelSelection(
  config: ConfigService,
  session: Pick<SessionMeta, 'coordination'>,
  options: { defaultEffort: EffortLevel },
): SessionModelSelection {
  const coordination = session.coordination
  const { modelKey, issue } = resolveModel(config, coordination)

  const roleEffort =
    coordination?.role === 'coordinator'
      ? config.getCoordination().coordinatorEffort
      : coordination?.role === 'thread'
        ? config.getCoordination().threadEffort
        : undefined
  const requested = coordination?.effortOverride ?? roleEffort ?? options.defaultEffort
  const effort = clampEffort(requested, modelKey ? config.getModel(modelKey)?.supportedEfforts : undefined) as EffortLevel

  return { ...(modelKey ? { modelKey } : {}), effort, ...(issue ? { issue } : {}) }
}

function resolveModel(
  config: ConfigService,
  coordination: SessionMeta['coordination'],
): { modelKey?: string; issue?: RuntimeConfigurationIssue } {
  const override = coordination?.modelOverride?.trim()
  if (override) {
    const modelKey = config.resolveModelReference(override)
    return modelKey
      ? { modelKey }
      : {
          issue: { code: 'unknown_model', message: `会话指定的模型 ${override} 已不存在，请重新选择。` },
        }
  }

  const role = coordination?.role
  if (role === 'coordinator' || role === 'thread') {
    const routed = config.resolveCoordinationModelKey(role)
    if (routed.invalid) {
      return {
        issue: {
          code: 'unknown_model',
          message: `routing.${role} 指向的模型 ${routed.invalid} 已不存在，请在「模型与服务商」中重新选择。`,
        },
      }
    }
    return routed.modelKey ? { modelKey: routed.modelKey } : {}
  }

  const modelKey = config.resolveModelKeyFor({ kind: 'main' }, { currentModelKey: config.get().defaultModel })
  return modelKey ? { modelKey } : {}
}

/**
 * One line per runtime build: which role and which model.
 *
 * Logged where a runtime is actually installed (a pane opening, a settings
 * refresh), not inside the pure resolver.
 */
export function logSessionSelection(
  session: Pick<SessionMeta, 'coordination'>,
  selection: SessionModelSelection,
): void {
  logDiagnostics([{
    code: 'session_model_selection',
    severity: 'info',
    message: [
      `role=${session.coordination?.role ?? 'main'}`,
      `model=${selection.modelKey ?? '(none)'}`,
      ...(selection.issue ? [`issue=${selection.issue.code}`] : []),
    ].join(' '),
  }])
}