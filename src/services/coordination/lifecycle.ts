/**
 * Time-based lifecycle for coordination threads. Pure: no I/O, no clock reads.
 *
 * Rules:
 * - `running`, `needs-you`, `resolved` and `stale` are never changed by time.
 * - For every other status, age = now - lastActivityAt.
 *   - autoResolveDays > 0 and age >= autoResolveDays  -> `resolved`
 *   - else quietDays > 0 and age >= quietDays          -> `quiet`
 *   - else the stored status. Time only promotes a status, never demotes a
 *     stored `quiet` back to something fresher.
 * - An unparseable lastActivityAt returns the stored status unchanged.
 * - A negative or non-finite setting is treated as the default; 0 disables that rule.
 */

import { DEFAULT_AUTO_RESOLVE_DAYS, DEFAULT_QUIET_DAYS, type CoordinationDays } from '../../config/coordination.js'
import type { ThreadStatus } from './types.js'

export type { ThreadStatus }

export { DEFAULT_AUTO_RESOLVE_DAYS, DEFAULT_QUIET_DAYS }

export type LifecycleSettings = CoordinationDays

const MS_PER_DAY = 24 * 60 * 60 * 1000

const TIME_FREE_STATUSES: ReadonlySet<ThreadStatus> = new Set<ThreadStatus>([
  'running',
  'needs-you',
  'resolved',
  'stale',
])

function daysSetting(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return fallback
  return value
}

export function effectiveThreadStatus(
  thread: { status: ThreadStatus; lastActivityAt: string },
  now: Date,
  settings: LifecycleSettings = {},
): ThreadStatus {
  if (TIME_FREE_STATUSES.has(thread.status)) return thread.status
  const lastActivity = Date.parse(thread.lastActivityAt)
  if (Number.isNaN(lastActivity)) return thread.status

  const age = now.getTime() - lastActivity
  const quietDays = daysSetting(settings.quietDays, DEFAULT_QUIET_DAYS)
  const autoResolveDays = daysSetting(settings.autoResolveDays, DEFAULT_AUTO_RESOLVE_DAYS)

  if (autoResolveDays > 0 && age >= autoResolveDays * MS_PER_DAY) return 'resolved'
  if (quietDays > 0 && age >= quietDays * MS_PER_DAY) return 'quiet'
  return thread.status
}

export function applyLifecycle<T extends { status: ThreadStatus; lastActivityAt: string }>(
  threads: readonly T[],
  now: Date,
  settings?: LifecycleSettings,
): T[] {
  return threads.map((thread) => ({
    ...thread,
    status: effectiveThreadStatus(thread, now, settings),
  }))
}
