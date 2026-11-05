import type { ComputerOperation } from '../src/runtime/protocol/computerHost.js'
import type { WaitStatus } from '../src/desktop/computer/wait.js'
import type { NativeObservation } from './computer-native-observation.mjs'

export interface FinderNameWaitState {
  wait: { status: WaitStatus; elapsedMs: number }
  complete?: boolean
  truncated?: boolean
}
export interface FinderNameWaitEvidence {
  budgetMs?: number
  attempts?: Array<{ field: 'labelIncludes' | 'valueIncludes'; waitMs: number;
    status?: WaitStatus; elapsedMs?: number; complete?: boolean; truncated?: boolean; failed?: boolean }>
  remainingMsBeforeValue?: number
  valueWaitSkippedForBudget?: boolean
}
export function waitForFinderName<T extends FinderNameWaitState>(
  call: (input: Extract<ComputerOperation, { operation: 'wait_for' }>) => Promise<T>,
  target: { appId: string; windowId: string; name: string }, evidence: FinderNameWaitEvidence,
  now?: () => number
): Promise<T>
export interface FinderNameMatches {
  labelMatches: number
  valueMatches: number
  roles: Array<{ role: string; labelMatches: number; valueMatches: number }>
}
export function finderNameMatches(rows: Array<{ role: string; label: string; value: string }>, name: string): FinderNameMatches

export interface ComputerAppRow {
  ref: string
  role: string
  label: string
  value: string
  line: string
  windowId?: string
}
export function computerRows(state: { text?: string }): ComputerAppRow[]
export interface FinderNameObservationState extends NativeObservation {
  appId: string
  windowId?: string
  scope: 'window' | 'application'
}
export interface FinderNameObservationSummary extends FinderNameMatches {
  complete: boolean
  truncated: boolean
  full: boolean
  appMatches: boolean
  windowMatches: boolean
  candidateCount: number
}
export interface FinderNameObservationEvidence {
  windowObservation?: FinderNameObservationSummary
  targetSubtree?: FinderNameObservationSummary
}
export function observeFinderName<T extends FinderNameObservationState>(
  call: (input: Extract<ComputerOperation, { operation: 'get_state' }>) => Promise<T>,
  target: { appId: string; windowId: string; name: string }, evidence: FinderNameObservationEvidence
): Promise<T>
