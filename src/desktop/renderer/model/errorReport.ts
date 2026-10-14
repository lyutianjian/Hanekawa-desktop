/**
 * Where a failed action says so. An error belongs next to what failed when that
 * place is on screen; when it is not (the user has moved on, or the action has
 * no place of its own) it goes to the window's toast stack — never to a
 * transcript that may be behind another screen.
 */

export type ErrorPlace = 'projects-page' | 'thread-panel' | 'merge-bar' | 'toast'

export interface ErrorSite {
  /** What was being attempted, as a noun phrase: 「删除会话」. */
  readonly action: string
  /** Where the failure is drawn when that place is on screen. */
  readonly place?: Exclude<ErrorPlace, 'toast'>
  /** The detail is already a full sentence (a refusal the host worded itself). */
  readonly bare?: boolean
}

export function errorText(site: ErrorSite, detail: string): string {
  return site.bare === true ? detail : `${site.action}失败：${detail}`
}

export function errorPlace(site: ErrorSite, visible: ReadonlySet<ErrorPlace>): ErrorPlace {
  return site.place !== undefined && visible.has(site.place) ? site.place : 'toast'
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
