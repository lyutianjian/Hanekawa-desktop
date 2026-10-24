/**
 * Coordination defaults and the shape of the global `agent.coordination` group.
 *
 * These live under `config/` rather than beside the thread lifecycle because the
 * values are account-level configuration: every project reads the same group out
 * of `~/.myagent/config.json`. `services/coordination/lifecycle.ts` re-exports
 * the day defaults for the callers that only need them there.
 */

import type { EffortLevel } from './effort.js'

/** Threads quiet for this many days are shown as 安静. */
export const DEFAULT_QUIET_DAYS = 3
/** Threads quiet for this many days are resolved automatically. */
export const DEFAULT_AUTO_RESOLVE_DAYS = 7

/**
 * Model roles a coordination session can follow. Both resolve through
 * `routing.<role>` and fall back to the main model on `inherit`.
 */
export type CoordinationRole = 'coordinator' | 'thread'

/** The `agent.coordination` group as written, with no defaults applied. */
export interface CoordinationConfig {
  coordinatorEffort?: EffortLevel
  threadEffort?: EffortLevel
  /** Non-negative; 0 disables. */
  quietDays?: number
  /** Non-negative; 0 disables. */
  autoResolveDays?: number
}

/** The group with day defaults filled in; 0 still means "off". */
export interface ResolvedCoordinationConfig extends CoordinationConfig {
  quietDays: number
  autoResolveDays: number
}

/** Only the two day counts — what a lifecycle decision actually reads. */
export interface CoordinationDays {
  quietDays?: number
  autoResolveDays?: number
}

export function resolveCoordination(config: CoordinationConfig | undefined): ResolvedCoordinationConfig {
  return {
    ...config,
    quietDays: config?.quietDays ?? DEFAULT_QUIET_DAYS,
    autoResolveDays: config?.autoResolveDays ?? DEFAULT_AUTO_RESOLVE_DAYS,
  }
}