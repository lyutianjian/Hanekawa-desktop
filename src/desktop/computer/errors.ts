import type { ComputerDiagnostics } from '../../runtime/protocol/computerHost.js'
export type Delivery = 'not_delivered' | 'unknown' | 'delivered_unverified'
export class ComputerError extends Error {
  diagnostics?: ComputerDiagnostics
  constructor(readonly code: string, message: string, readonly delivery: Delivery = 'not_delivered') { super(message) }
}
