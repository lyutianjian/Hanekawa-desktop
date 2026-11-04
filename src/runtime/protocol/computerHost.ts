/** Electron-free contract. Bindings and snapshots belong to the calling chat. */
export type ComputerOperation =
  | { operation: 'status' }
  | { operation: 'list_apps' }
  | { operation: 'bind'; app: string; windowId?: string }
  | { operation: 'get_state'; appId: string; windowId?: string; disableDiffing?: boolean; rootRef?: string }
  | { operation: 'screenshot'; appId: string; windowId?: string }
  | { operation: 'click'; appId: string; ref: string }
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
export interface ComputerResponse {
  envelope: { ok: boolean; [key: string]: unknown }
  image?: { bytes: Buffer; name: string }
}
export interface ComputerHost {
  run(request: ComputerRequest): Promise<ComputerResponse>
}
