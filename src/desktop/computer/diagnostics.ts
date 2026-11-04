import { randomUUID } from 'node:crypto'
import type { ComputerDiagnostics, ComputerRequest, ComputerResponse } from '../../runtime/protocol/computerHost.js'

/** Numeric timings and opaque identifiers only; never retain application content. */
export class ComputerTrace {
  readonly started = performance.now()
  readonly data: ComputerDiagnostics
  constructor(request: ComputerRequest) {
    this.data = { requestId: randomUUID(), sessionId: request.sessionId, operation: request.input.operation,
      ...('appId' in request.input ? { appId: request.input.appId } : {}), stages: {}, nativeRequests: 0, observations: 0,
      queueMs: 0, hostElapsedMs: 0 }
  }
  stage(name: string, elapsedMs: number): void {
    const old = this.data.stages[name] ?? { count: 0, elapsedMs: 0 }
    this.data.stages[name] = { count: old.count + 1, elapsedMs: Math.round(old.elapsedMs + elapsedMs) }
  }
  finish(response?: ComputerResponse, error?: { code?: string; delivery?: string }): ComputerDiagnostics {
    this.data.hostElapsedMs = Math.round(performance.now() - this.started)
    if (response) {
      const result = response.envelope.data as Record<string, unknown> | undefined
      if (typeof result?.appId === 'string') this.data.appId = result.appId
      if (typeof result?.snapshotId === 'string') this.data.snapshotId = result.snapshotId
      if (typeof result?.text === 'string') this.data.textChars = result.text.length
      if (result?.mode === 'full' || result?.mode === 'diff') this.data.mode = result.mode
      this.data.imageBytes = response.image?.bytes.length ?? 0
      const action = result?.action as { delivery?: string; verified?: boolean } | undefined
      if (action) { this.data.delivery = action.delivery; this.data.verified = action.verified }
    }
    if (error) { this.data.errorCode = error.code; this.data.delivery = error.delivery }
    return this.data
  }
}
