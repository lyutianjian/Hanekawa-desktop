import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { ComputerHost, ComputerRequest, ComputerResponse, ComputerOperation } from '../../runtime/protocol/computerHost.js'
import { ComputerClient } from './client.js'
import { ComputerError } from './errors.js'
import { appSchema, helloSchema, observationSchema, screenshotSchema, statusSchema, windowSchema, type ComputerNode } from './nativeSchema.js'
import { renderObservation } from './observation.js'

interface Binding {
  id: string; sessionId: string; lane: string; client: ComputerClient
  app?: z.infer<typeof helloSchema>; windowId?: string
  snapshot?: { id: string; revision: number; nodes: ComputerNode[] }
  previous?: ComputerNode[]
}
export interface DesktopComputerOptions {
  executable: string
  /** Absence rejects a caller after its pane has closed. Tests can omit this. */
  laneForSession?: (sessionId: string) => string | undefined
  platform?: string
}

/** One desktop queue, private persistent helpers and references per app/chat. */
export class DesktopComputerHost implements ComputerHost {
  private tail: Promise<unknown> = Promise.resolve()
  private lifetime = new AbortController()
  private bindings = new Map<string, Binding>()
  private clients = new Map<ComputerClient, string>()
  private closing = new Map<ComputerClient, Promise<void>>()
  private queued = 0
  constructor(private readonly options: DesktopComputerOptions) {}

  async run(request: ComputerRequest): Promise<ComputerResponse> {
    if (this.queued >= 64) throw new ComputerError('TARGET_BUSY', 'Too many queued desktop calls.')
    const lane = this.lane(request.sessionId)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new ComputerError('ETIMEDOUT', 'Computer deadline expired. Bind again and observe before repeating input.', 'unknown')), request.timeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, deadline.signal, ...(request.signal ? [request.signal] : [])])
    this.queued++
    let started = false
    const pending = this.tail.then(async () => {
      signal.throwIfAborted()
      await this.reapClosedSessions()
      await Promise.all(this.closing.values())
      signal.throwIfAborted()
      if (this.lane(request.sessionId) !== lane) throw new ComputerError('SESSION_CLOSED', 'The calling pane has changed.')
      started = true
      if ((this.options.platform ?? process.platform) !== 'darwin') throw new ComputerError('UNSUPPORTED', 'The native Computer backend currently supports macOS only. Browser remains available.')
      return this.execute(request, lane, signal)
    }).finally(() => { this.queued-- })
    // The queue waits for process cleanup, even when a caller aborts promptly.
    this.tail = pending.catch(() => {})
    try { return await abortable(pending, signal) }
    catch (error) {
      if (signal.aborted) {
        const reason = signal.reason as { code?: string; message?: string }
        throw new ComputerError(typeof reason?.code === 'string' ? reason.code : 'ABORTED', reason?.message ?? 'Computer operation cancelled.', started ? 'unknown' : 'not_delivered')
      }
      throw error
    } finally { clearTimeout(timer) }
  }
  async reapClosedSessions(): Promise<void> {
    if (!this.options.laneForSession) return
    const stale = [...this.bindings.values()].filter(binding => this.options.laneForSession!(binding.sessionId) !== binding.lane)
    for (const binding of stale) { this.bindings.delete(binding.id); binding.snapshot = undefined }
    await Promise.all(stale.map(binding => this.close(binding.client)))
  }
  closeLane(lane: string): void {
    for (const binding of this.bindings.values()) if (binding.lane === lane) this.drop(binding)
    for (const [client, owner] of this.clients) if (owner === lane) void this.close(client)
  }
  async dispose(): Promise<void> {
    this.lifetime.abort(new ComputerError('ABORTED', 'Computer host has closed.', 'unknown'))
    const clients = [...this.clients.keys()]
    this.bindings.clear()
    await Promise.all(clients.map(client => this.close(client)))
    await this.tail
  }
  private lane(sessionId: string): string {
    if (this.lifetime.signal.aborted) throw new ComputerError('SESSION_CLOSED', 'Computer host has closed.')
    const lane = this.options.laneForSession ? this.options.laneForSession(sessionId) : sessionId
    if (!lane) throw new ComputerError('SESSION_CLOSED', 'Computer caller has no live pane.')
    return lane
  }
  private client(lane: string): ComputerClient {
    const client = new ComputerClient(this.options.executable)
    this.clients.set(client, lane)
    return client
  }
  private close(client: ComputerClient): Promise<void> {
    const held = this.closing.get(client)
    if (held) return held
    const closed = client.close().finally(() => {
      this.clients.delete(client)
      this.closing.delete(client)
    })
    this.closing.set(client, closed)
    return closed
  }
  private drop(binding: Binding): void {
    binding.snapshot = undefined
    this.bindings.delete(binding.id)
    void this.close(binding.client)
  }
  private async execute(request: ComputerRequest, lane: string, signal: AbortSignal): Promise<ComputerResponse> {
    const input = request.input
    if (input.operation === 'status' || input.operation === 'list_apps') {
      const client = this.client(lane)
      try {
        const raw = await client.request(input.operation, {}, signal)
        const data = input.operation === 'status'
          ? { ...statusSchema.parse(raw), permissionSettings: {
            accessibility: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
            screenRecording: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
          } }
          : z.array(appSchema).max(500).parse(raw)
        return ok(data)
      } finally { await this.close(client) }
    }
    if (input.operation === 'bind') return this.bind(request.sessionId, lane, input, signal)
    const binding = this.bindings.get(input.appId)
    if (!binding || binding.sessionId !== request.sessionId || binding.lane !== lane) throw new ComputerError('SESSION_CLOSED', 'App binding is missing or belongs to another chat. Bind again.')
    try {
      if (input.operation === 'release') {
        this.bindings.delete(binding.id)
        await this.close(binding.client)
        return ok({ appId: binding.id, released: true })
      }
      if (input.operation === 'get_state') return ok(await this.observe(binding, input, signal))
      if (input.operation === 'screenshot') {
        binding.snapshot = undefined; binding.previous = undefined
        const selected = await this.selectWindow(binding, input.windowId, signal)
        if (!selected) return ok(this.describe(binding))
        const shot = screenshotSchema.parse(await binding.client.request('screenshot', { windowId: selected }, signal))
        this.checkPID(binding, shot.processId)
        const bytes = Buffer.from(shot.png, 'base64')
        if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== shot.width || bytes.readUInt32BE(20) !== shot.height) throw new ComputerError('DRIVER_LOST', 'Invalid native PNG.', 'unknown')
        const id = `s${randomUUID()}`
        binding.snapshot = { id, revision: shot.revision, nodes: [] }
        return { envelope: { ok: true, data: { ...this.describe(binding), snapshotId: id, windowId: shot.windowId, windowNumber: shot.windowNumber, boundsInPoints: shot.bounds, imageSizeInPixels: { width: shot.width, height: shot.height }, coordinateSpace: 'window-local-points' } }, image: { bytes, name: 'computer-window.png' } }
      }
      // Consume references on every attempt, even a stale/unsupported action.
      const snapshot = binding.snapshot
      binding.snapshot = undefined
      if (!snapshot) throw new ComputerError('STALE_SNAPSHOT', 'Read get_state or screenshot before acting.')
      const params: Record<string, unknown> = { revision: snapshot.revision }
      if ('snapshotId' in input && input.snapshotId !== snapshot.id) throw new ComputerError('STALE_SNAPSHOT', 'Snapshot expired. Read the app again.')
      if ('ref' in input && input.ref !== undefined) params.index = this.index(snapshot, input.ref)
      switch (input.operation) {
        case 'click': break
        case 'set_value': params.value = input.value; break
        case 'perform_action': params.action = input.action; break
        case 'click_at': Object.assign(params, { x: input.x, y: input.y, button: input.button ?? 'left', clickCount: input.clickCount ?? 1 }); break
        case 'press_key': params.key = input.key; break
        case 'type_text': params.text = input.text; break
        case 'scroll': Object.assign(params, { direction: input.direction, amount: input.amount ?? 400 }); break
      }
      z.object({ performed: z.literal(true), observeRequired: z.literal(true) }).strict().parse(await binding.client.request(input.operation, params, signal))
      try {
        return ok({ ...await this.observe(binding, {}, signal), action: { performed: true, delivery: 'delivered_unverified', verified: false } })
      } catch (error) {
        // Input has already happened. Never turn failed observation into a
        // retryable action, or lose the action receipt.
        throw new ComputerError((error as ComputerError).code ?? 'DRIVER_LOST', `Action delivered, but fresh observation failed: ${message(error)}`, 'delivered_unverified')
      }
    } catch (error) {
      binding.snapshot = undefined
      const code = (error as ComputerError).code
      if (signal.aborted || ['DRIVER_LOST', 'TARGET_CHANGED'].includes(code) || error instanceof z.ZodError) {
        this.bindings.delete(binding.id)
        await this.close(binding.client)
      }
      if (error instanceof z.ZodError) throw new ComputerError('DRIVER_LOST', 'Invalid computer helper response. Bind again.', 'unknown')
      throw error
    }
  }
  private async bind(sessionId: string, lane: string, input: Extract<ComputerOperation, { operation: 'bind' }>, signal: AbortSignal): Promise<ComputerResponse> {
    if (this.bindings.size >= 32 || [...this.bindings.values()].filter(b => b.sessionId === sessionId).length >= 8) throw new ComputerError('TARGET_BUSY', 'Release unused app bindings before opening more.')
    const binding: Binding = { id: `app-${randomUUID()}`, sessionId, lane, client: this.client(lane) }
    this.bindings.set(binding.id, binding)
    try {
      binding.app = helloSchema.parse(await binding.client.request('bind', { app: input.app }, signal))
      signal.throwIfAborted()
      if (this.lane(sessionId) !== lane || !this.bindings.has(binding.id)) throw new ComputerError('SESSION_CLOSED', 'The calling pane has closed.')
      const held = [...this.bindings.values()].find(b => b !== binding && b.app?.processId === binding.app!.processId)
      if (held) {
        if (held.sessionId !== sessionId) throw new ComputerError('TARGET_BUSY', 'This app is controlled by another chat. Release it there first.')
        this.bindings.delete(binding.id); await this.close(binding.client)
        return ok(await this.observe(held, { windowId: input.windowId, disableDiffing: true }, signal))
      }
      return ok(await this.observe(binding, { windowId: input.windowId, disableDiffing: true }, signal))
    } catch (error) {
      this.bindings.delete(binding.id)
      await this.close(binding.client)
      throw error
    }
  }
  private describe(binding: Binding): Record<string, unknown> {
    return { appId: binding.id, app: binding.app?.name, bundleId: binding.app?.bundleId, processId: binding.app?.processId,
      windows: binding.app?.windows, ...(binding.windowId ? { windowId: binding.windowId } : {}) }
  }
  private checkPID(binding: Binding, processId: number): void {
    if (binding.app?.processId !== processId) throw new ComputerError('TARGET_CHANGED', 'Target process changed. Bind again.')
  }
  private async selectWindow(binding: Binding, explicit: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    const windows = z.array(windowSchema).max(100).parse(await binding.client.request('list_windows', {}, signal))
    binding.app!.windows = windows
    const selected = explicit ?? binding.windowId ?? (windows.length === 1 ? windows[0]!.id : undefined)
    if (selected && windows.some(w => w.id === selected)) { binding.windowId = selected; return selected }
    binding.windowId = undefined
    binding.previous = undefined
    return undefined
  }
  private index(snapshot: NonNullable<Binding['snapshot']>, ref: string): number {
    const prefix = `${snapshot.id}:e`
    const index = Number(ref.slice(prefix.length))
    if (!ref.startsWith(prefix) || !Number.isInteger(index) || !snapshot.nodes.some(n => n.index === index)) throw new ComputerError('STALE_SNAPSHOT', 'Element is not in the latest AX snapshot. Read get_state again.')
    return index
  }
  private async observe(binding: Binding, input: { windowId?: string; disableDiffing?: boolean; rootRef?: string }, signal: AbortSignal): Promise<Record<string, unknown>> {
    const old = binding.snapshot
    binding.snapshot = undefined
    let rootIndex: number | undefined
    if (input.rootRef) {
      if (!old) throw new ComputerError('STALE_SNAPSHOT', 'rootRef requires a current AX snapshot.')
      rootIndex = this.index(old, input.rootRef)
    }
    const previousWindow = binding.windowId
    const selected = await this.selectWindow(binding, input.windowId, signal)
    if (!selected) return { ...this.describe(binding), complete: false, text: 'Select windowId from windows, or open a window in the target application, then call get_state.' }
    if (rootIndex !== undefined && selected !== previousWindow) throw new ComputerError('STALE_SNAPSHOT', 'Cannot use rootRef with a different window.')
    const data = observationSchema.parse(await binding.client.request('observe', { windowId: selected, ...(rootIndex === undefined ? {} : { rootIndex, revision: old!.revision }) }, signal))
    this.checkPID(binding, data.processId)
    if (data.windowId !== selected) throw new ComputerError('TARGET_CHANGED', 'Observed window changed.')
    const id = `s${randomUUID()}`
    const rendered = renderObservation(id, data.nodes, input.disableDiffing || rootIndex !== undefined || previousWindow !== selected ? undefined : binding.previous)
    binding.snapshot = { id, revision: data.revision, nodes: data.nodes }
    binding.previous = rendered.truncated ? undefined : data.nodes
    binding.app!.windows = data.windows
    return { ...this.describe(binding), snapshotId: id, boundsInPoints: data.bounds, coordinateSpace: 'window-local-points',
      complete: !data.truncated && !rendered.truncated, truncated: data.truncated || rendered.truncated, text: rendered.text }
  }
}
function ok(data: unknown): ComputerResponse { return { envelope: { ok: true, data } } }
function message(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    if (signal.aborted) { aborted(); return }
    signal.addEventListener('abort', aborted, { once: true })
    pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted))
  })
}
