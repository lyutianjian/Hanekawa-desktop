/** Electron-free contract. Bindings and snapshots belong to the calling chat. */
export type ComputerObservationScope = 'window' | 'application'

export type ComputerWaitCondition =
  | { kind: 'element'; state: 'present' | 'absent'; role?: string; labelIncludes?: string; valueIncludes?: string }
  | ({ kind: 'window'; state: 'present' | 'absent' } & ({ windowId: string; titleIncludes?: never } | { titleIncludes: string; windowId?: never }))

export type ComputerTextSelection = { start: number; length: number } | { text: string; prefix?: string; suffix?: string }

export type ComputerOperation =
  | { operation: 'status' }
  | { operation: 'list_apps' }
  | { operation: 'bind'; app: string; windowId?: string }
  | { operation: 'get_state'; appId: string; windowId?: string; disableDiffing?: boolean; rootRef?: string; scope?: ComputerObservationScope; includeScreenshot?: boolean }
  | { operation: 'wait_for'; appId: string; windowId?: string; condition: ComputerWaitCondition; waitMs: number; scope?: ComputerObservationScope }
  | { operation: 'screenshot'; appId: string; windowId?: string }
  | { operation: 'click'; appId: string; ref: string }
  | { operation: 'focus'; appId: string; ref: string }
  | { operation: 'select_text'; appId: string; ref: string; selection: ComputerTextSelection }
  | { operation: 'set_value'; appId: string; ref: string; value: string }
  | { operation: 'perform_action'; appId: string; ref: string; action: string }
  | { operation: 'click_at'; appId: string; snapshotId: string; x: number; y: number; button?: 'left' | 'right'; clickCount?: number }
  | { operation: 'press_key'; appId: string; snapshotId: string; key: string; ref?: string }
  | { operation: 'type_text'; appId: string; snapshotId: string; text: string; ref?: string }
  | { operation: 'scroll'; appId: string; snapshotId: string; direction: 'up' | 'down' | 'left' | 'right'; amount?: number; ref?: string }
  | { operation: 'release'; appId: string }

export interface ComputerRequest {
  sessionId: string
  input: ComputerOperation
  timeoutMs: number
  signal?: AbortSignal
}
export interface ComputerDiagnostics {
  requestId: string; sessionId: string; operation: string; appId?: string; snapshotId?: string
  queueMs: number; hostElapsedMs: number; nativeRequests: number; observations: number
  stages: Record<string, { count: number; elapsedMs: number }>
  textChars?: number; imageBytes?: number; mode?: 'full' | 'diff'
  errorCode?: string; delivery?: string; verified?: boolean
}
export interface ComputerResponse {
  diagnostics?: ComputerDiagnostics
  envelope: { ok: boolean; [key: string]: unknown }
  image?: { bytes: Buffer; name: string }
}
export interface ComputerHost {
  run(request: ComputerRequest): Promise<ComputerResponse>
}
