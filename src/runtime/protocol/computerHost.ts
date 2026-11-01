/** The desktop owns native processes; the tool knows only this contract. */
export interface ComputerRequest {
  sessionId: string
  command: string
  args: string[]
  headed: boolean
  timeoutMs: number
  signal?: AbortSignal
}

export interface ComputerResponse {
  /** The native JSON envelope, including delivery/retry evidence on failures. */
  envelope: {
    ok: boolean
    [key: string]: unknown
  }
  image?: { bytes: Buffer; name: string }
}

export interface ComputerHost {
  run(request: ComputerRequest): Promise<ComputerResponse>
}
