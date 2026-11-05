export interface NativeObservation {
  snapshotId: string
  revision: number
  mode: 'full' | 'diff'
  baseRevision: number | null
  complete: boolean
  truncated: boolean
  text: string
}

export function fixtureBusinessWindows(windows: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>>
export function assertCompleteFull(observation: NativeObservation): Map<number, string>
export function restoreCompleteDiff(before: NativeObservation, diff: NativeObservation): Map<number, string>
export function assertRestoredDiff(before: NativeObservation, diff: NativeObservation, full: NativeObservation): void
export function refFromCompleteDiff(before: NativeObservation, diff: NativeObservation, label: string, role?: string): string
export function assertTruncatedFull(observation: NativeObservation): void
