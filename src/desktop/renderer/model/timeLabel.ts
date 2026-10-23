/**
 * The one way the window says when something happened.
 *
 * There were three: the transcript's footers said 「今天 14:32」 and 「5月7日」,
 * a message's own stamp said a bare 「14:32」 whatever day it was from, and the
 * thread list and projects page counted 「3 小时前」 and 「2 天前」. Now every
 * stamp is this, and the exact minute is the hover's (`absoluteTime`).
 *
 * The first hour counts up (刚刚, N 分钟前), because "how long ago" is the
 * question then; after it the clock and the day answer better than a growing
 * count. A stamp from a later year carries its year.
 */
export function relativeTime(createdAt: string | undefined, now: number): string | undefined {
  const at = createdAt === undefined ? undefined : new Date(createdAt)
  if (at === undefined || Number.isNaN(at.getTime())) return undefined
  // Clock skew between the host and this window reads as just now, never as a
  // negative count.
  const minutes = Math.floor(Math.max(0, now - at.getTime()) / 60_000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const today = new Date(now)
  if (sameDay(at, today)) return `今天 ${clock(at)}`
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  if (sameDay(at, yesterday)) return `昨天 ${clock(at)}`
  const date = `${at.getMonth() + 1}月${at.getDate()}日`
  return at.getFullYear() === today.getFullYear() ? date : `${at.getFullYear()}年${date}`
}

/** The hover title: 「2026-05-07 14:32」. */
export function absoluteTime(createdAt: string): string {
  const at = new Date(createdAt)
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${clock(at)}`
}

/**
 * How often an on-screen relative stamp is recomputed. A minute is the label's
 * own resolution; without it a 「刚刚」 stayed up for as long as nothing else
 * repainted the window.
 */
export const RELATIVE_TIME_REFRESH_MS = 60_000

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
}

function clock(at: Date): string {
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}
