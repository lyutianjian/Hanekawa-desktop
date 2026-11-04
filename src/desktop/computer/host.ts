import { randomUUID } from 'node:crypto'
import { z } from 'zod/v3'
import type { ComputerHost, ComputerRequest, ComputerResponse, ComputerOperation, ComputerObservationScope } from '../../runtime/protocol/computerHost.js'
import { ComputerClient } from './client.js'
import { ComputerTrace } from './diagnostics.js'
import { ComputerError } from './errors.js'
import { appSchema, helloSchema, observationSchema, screenshotSchema, statusSchema, windowSchema, type ComputerNode, type ComputerObservation } from './nativeSchema.js'
import { renderObservation, type ObservationBaseline } from './observation.js'
import { checkCondition, pollObservation, stableObservation, type ObservationSample } from './wait.js'

interface Binding {
  id: string; sessionId: string; lane: string; client: ComputerClient
  app?: z.infer<typeof helloSchema>; windowId?: string
  lastRevision?: number
  snapshot?: { id: string; revision: number; nodes: ComputerNode[]; scope: ComputerObservationScope }
  previousScope?: ComputerObservationScope
  previous?: ObservationBaseline
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
  private desktop = new AbortController()
  private unavailable = new Set<'suspended' | 'locked'>()
  private bindings = new Map<string, Binding>()
  private clients = new Map<ComputerClient, string>()
  private closing = new Map<ComputerClient, Promise<void>>()
  private queued = 0
  private trace?: ComputerTrace
  constructor(private readonly options: DesktopComputerOptions) {}

  async run(request: ComputerRequest): Promise<ComputerResponse> {
    if (this.unavailable.size) throw new ComputerError('DESKTOP_UNAVAILABLE', 'The desktop is asleep or locked. Wake and unlock it, then bind again.')
    if (this.queued >= 64) throw new ComputerError('TARGET_BUSY', 'Too many queued desktop calls.')
    const trace = new ComputerTrace(request)
    const lane = this.lane(request.sessionId)
    const deadline = new AbortController()
    const timer = setTimeout(() => deadline.abort(new ComputerError('ETIMEDOUT', 'Computer deadline expired. Bind again and observe before repeating input.', 'unknown')), request.timeoutMs)
    const signal = AbortSignal.any([this.lifetime.signal, this.desktop.signal, deadline.signal, ...(request.signal ? [request.signal] : [])])
    this.queued++
    let started = false
    let actionDelivered = false
    const pending = this.tail.then(async () => {
      signal.throwIfAborted()
      await this.reapClosedSessions()
      await Promise.all(this.closing.values())
      signal.throwIfAborted()
      if (this.lane(request.sessionId) !== lane) throw new ComputerError('SESSION_CLOSED', 'The calling pane has changed.')
      trace.data.queueMs = Math.round(performance.now() - trace.started)
      this.trace = trace
      started = true
      if ((this.options.platform ?? process.platform) !== 'darwin') throw new ComputerError('UNSUPPORTED', 'The native Computer backend currently supports macOS only. Browser remains available.')
      return this.execute(request, lane, signal, () => { actionDelivered = true })
    }).finally(() => { this.queued--; if (this.trace === trace) this.trace = undefined })
    // The queue waits for process cleanup, even when a caller aborts promptly.
    this.tail = pending.catch(() => {})
    try {
      const response = await abortable(pending, signal)
      return { ...response, diagnostics: trace.finish(response) }
    }
    catch (error) {
      if (!started) trace.data.queueMs = Math.round(performance.now() - trace.started)
      let failure = error
      if (signal.aborted) {
        const reason = signal.reason as { code?: string; message?: string }
        failure = new ComputerError(typeof reason?.code === 'string' ? reason.code : 'ABORTED', reason?.message ?? 'Computer operation cancelled.', actionDelivered ? 'delivered_unverified' : started ? 'unknown' : 'not_delivered')
      }
      const result = failure instanceof ComputerError ? failure : new ComputerError('DRIVER_LOST', message(failure), 'unknown')
      result.diagnostics = trace.finish(undefined, result)
      throw result
    } finally { clearTimeout(timer) }
  }
  async reapClosedSessions(): Promise<void> {
    const laneForSession = this.options.laneForSession
    const stale = [...this.bindings.values()].filter(binding => binding.client.isBroken || (laneForSession && laneForSession(binding.sessionId) !== binding.lane))
    for (const binding of stale) { this.bindings.delete(binding.id); binding.snapshot = undefined }
    await Promise.all(stale.map(binding => this.close(binding.client)))
  }
  closeLane(lane: string): void {
    for (const binding of this.bindings.values()) if (binding.lane === lane) this.drop(binding)
    for (const [client, owner] of this.clients) if (owner === lane) void this.close(client)
  }
  /** Both edges invalidate queued work, including a resume whose suspend was missed. */
  setDesktopUnavailable(reason: 'suspended' | 'locked', unavailable: boolean): void {
    if (this.lifetime.signal.aborted) return
    if (unavailable) this.unavailable.add(reason)
    else this.unavailable.delete(reason)
    const old = this.desktop
    this.desktop = new AbortController()
    old.abort(new ComputerError('DESKTOP_UNAVAILABLE', 'Desktop availability changed. Wake and unlock it, then bind again and observe before continuing.', 'unknown'))
    for (const binding of this.bindings.values()) this.drop(binding)
    for (const client of this.clients.keys()) void this.close(client)
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
    const trace = this.trace
    const client = new ComputerClient(this.options.executable, ms => trace?.stage('helper_spawn', ms))
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
  private async native(client: ComputerClient, method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    const trace = this.trace
    const start = performance.now()
    if (trace) { trace.data.nativeRequests++; if (method === 'observe' || method === 'observe_with_screenshot') trace.data.observations++ }
    try { return await client.request(method, params, signal) }
    finally { trace?.stage(method, performance.now() - start) }
  }
  private async execute(request: ComputerRequest, lane: string, signal: AbortSignal, onActionDelivered: () => void): Promise<ComputerResponse> {
    const input = request.input
    if (input.operation === 'status' || input.operation === 'list_apps') {
      const client = this.client(lane)
      try {
        const raw = await this.native(client, input.operation, {}, signal)
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
      if (input.operation === 'get_state') {
        if (input.includeScreenshot) return await this.observeWithScreenshot(binding, input, signal)
        return ok(await this.observe(binding, input, signal))
      }
      if (input.operation === 'wait_for') {
        const read = input.condition.kind === 'window' ? async (): Promise<ObservationSample> => {
          binding.snapshot = undefined
          const previousWindow = binding.windowId
          await this.selectWindow(binding, input.windowId, signal)
          if (previousWindow !== binding.windowId) binding.previous = undefined
          return { windows: binding.app!.windows }
        } : () => this.sample(binding, input.windowId, signal, input.scope)
        const start = performance.now()
        const result = await pollObservation(read, sample => checkCondition(input.condition, sample), input.waitMs, signal)
        this.trace?.stage('condition_wait', performance.now() - start)
        return ok({ ...this.publish(binding, result.sample.observation), wait: result.wait })
      }
      if (input.operation === 'screenshot') {
        binding.snapshot = undefined; binding.previous = undefined
        const selected = await this.selectWindow(binding, input.windowId, signal)
        if (!selected) return ok(this.describe(binding))
        const shot = screenshotSchema.parse(await this.native(binding.client, 'screenshot', { windowId: selected }, signal))
        this.checkPID(binding, shot.processId)
        if (shot.windowId !== selected) throw new ComputerError('TARGET_CHANGED', 'Captured window changed.')
        this.checkRevision(binding, shot.revision)
        const bytes = pngBytes(shot)
        const id = `s${randomUUID()}`
        binding.snapshot = { id, revision: shot.revision, nodes: [], scope: 'window' }
        return { envelope: { ok: true, data: { ...this.describe(binding), snapshotId: id, revision: shot.revision, sampledAt: shot.sampledAt, windowId: shot.windowId, windowNumber: shot.windowNumber, boundsInPoints: shot.bounds, imageSizeInPixels: { width: shot.width, height: shot.height }, coordinateSpace: 'window-local-points' } }, image: { bytes, name: 'computer-window.png' } }
      }
      // Consume references on every attempt, even a stale/unsupported action.
      const snapshot = binding.snapshot
      binding.snapshot = undefined
      if (!snapshot) throw new ComputerError('STALE_SNAPSHOT', 'Read get_state or screenshot before acting.')
      if (snapshot.scope === 'application' && ['click_at', 'press_key', 'type_text', 'scroll'].includes(input.operation)) throw new ComputerError('UNSUPPORTED', 'Physical input requires a window snapshot. Read get_state with window scope first.')
      const params: Record<string, unknown> = { revision: snapshot.revision }
      if ('snapshotId' in input && input.snapshotId !== snapshot.id) throw new ComputerError('STALE_SNAPSHOT', 'Snapshot expired. Read the app again.')
      if ('ref' in input && input.ref !== undefined) params.index = this.index(snapshot, input.ref)
      switch (input.operation) {
        case 'click': case 'focus': break
        case 'select_text': params.selection = input.selection; break
        case 'set_value': params.value = input.value; break
        case 'perform_action': params.action = input.action; break
        case 'click_at': Object.assign(params, { x: input.x, y: input.y, button: input.button ?? 'left', clickCount: input.clickCount ?? 1 }); break
        case 'press_key': params.key = input.key; break
        case 'type_text': params.text = input.text; break
        case 'scroll': Object.assign(params, { direction: input.direction, amount: input.amount ?? 400 }); break
      }
      z.object({ performed: z.literal(true), observeRequired: z.literal(true) }).strict().parse(await this.native(binding.client, input.operation, params, signal))
      onActionDelivered()
      try {
        const start = performance.now()
        const result = await pollObservation(() => this.sampleAfterAction(binding, snapshot.scope, signal), stableObservation(), 1000, signal)
        this.trace?.stage('stability_wait', performance.now() - start)
        return ok({ ...this.publish(binding, result.sample.observation), wait: result.wait, action: { performed: true, delivery: 'delivered_unverified', verified: false } })
      } catch (error) {
        // Input has already happened. Never turn failed observation into a
        // retryable action, or lose the action receipt.
        throw new ComputerError((error as ComputerError).code ?? 'DRIVER_LOST', `Action delivered, but fresh observation failed: ${message(error)}`, 'delivered_unverified')
      }
    } catch (error) {
      binding.snapshot = undefined
      const code = (error as ComputerError).code
      if (signal.aborted || ['DRIVER_LOST', 'TARGET_CHANGED', 'PERMISSION_REQUIRED'].includes(code) || error instanceof z.ZodError) {
        this.bindings.delete(binding.id)
        await this.close(binding.client)
      }
      if (error instanceof z.ZodError) throw new ComputerError('DRIVER_LOST', 'Invalid computer helper response. Bind again.', 'unknown')
      throw error
    }
  }
  private async observeWithScreenshot(binding: Binding, input: Extract<ComputerOperation, { operation: 'get_state' }>, signal: AbortSignal): Promise<ComputerResponse> {
    binding.snapshot = undefined; binding.previous = undefined
    if (input.scope === 'application' || input.rootRef !== undefined) throw new ComputerError('INVALID_INPUT', 'Combined screenshots require a complete window read.')
    const selected = await this.selectWindow(binding, input.windowId, signal)
    if (!selected) return ok(this.describe(binding))
    const raw = z.object({ screenshot: screenshotSchema, observation: observationSchema }).strict().parse(
      await this.native(binding.client, 'observe_with_screenshot', { windowId: selected }, signal))
    const { screenshot: shot, observation: observation } = raw
    this.checkPID(binding, shot.processId); this.checkPID(binding, observation.processId)
    if (shot.windowId !== selected || observation.windowId !== selected || observation.scope !== 'window'
      || !observation.bounds || !sameBounds(shot.bounds, observation.bounds)) throw new ComputerError('TARGET_CHANGED', 'Window changed between screenshot and AX sampling.')
    this.checkRevision(binding, shot.revision); this.checkRevision(binding, observation.revision)
    const bytes = pngBytes(shot)
    binding.app!.windows = observation.windows
    return { envelope: { ok: true, data: { ...this.publish(binding, observation, true),
      screenshot: { revision: shot.revision, sampledAt: shot.sampledAt, windowId: shot.windowId, processId: shot.processId, windowNumber: shot.windowNumber },
      atomic: false, imageSizeInPixels: { width: shot.width, height: shot.height } } }, image: { bytes, name: 'computer-window.png' } }
  }
  private async bind(sessionId: string, lane: string, input: Extract<ComputerOperation, { operation: 'bind' }>, signal: AbortSignal): Promise<ComputerResponse> {
    if (this.bindings.size >= 32 || [...this.bindings.values()].filter(b => b.sessionId === sessionId).length >= 8) throw new ComputerError('TARGET_BUSY', 'Release unused app bindings before opening more.')
    const binding: Binding = { id: `app-${randomUUID()}`, sessionId, lane, client: this.client(lane) }
    this.bindings.set(binding.id, binding)
    try {
      binding.app = helloSchema.parse(await this.native(binding.client, 'bind', { app: input.app }, signal))
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
  private checkRevision(binding: Binding, revision: number): void {
    if (binding.lastRevision !== undefined && revision <= binding.lastRevision) throw new ComputerError('DRIVER_LOST', 'Computer observation revision did not advance. Bind again.', 'unknown')
    binding.lastRevision = revision
  }
  private async selectWindow(binding: Binding, explicit: string | undefined, signal: AbortSignal): Promise<string | undefined> {
    const windows = z.array(windowSchema).max(100).parse(await this.native(binding.client, 'list_windows', {}, signal))
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
  private async observe(binding: Binding, input: { windowId?: string; disableDiffing?: boolean; rootRef?: string; scope?: ComputerObservationScope }, signal: AbortSignal): Promise<Record<string, unknown>> {
    return this.publish(binding, await this.readObservation(binding, input, signal), input.disableDiffing || input.rootRef !== undefined, input.rootRef !== undefined)
  }
  private async sample(binding: Binding, windowId: string | undefined, signal: AbortSignal, scope?: ComputerObservationScope): Promise<ObservationSample> {
    const observation = await this.readObservation(binding, { windowId, scope }, signal)
    return { ...(observation ? { observation } : {}), windows: binding.app!.windows }
  }
  private async sampleAfterAction(binding: Binding, scope: ComputerObservationScope, signal: AbortSignal): Promise<ObservationSample> {
    const selected = binding.windowId
    try { return await this.sample(binding, undefined, signal, scope) }
    catch (error) {
      if (scope !== 'window' || !selected || (error as ComputerError).code !== 'TARGET_CHANGED') throw error
      // A submitted editor can disappear between list_windows and observe.
      // Confirm its closure in the pinned process without replaying the action.
      const windows = z.array(windowSchema).max(100).parse(await this.native(binding.client, 'list_windows', {}, signal))
      if (windows.some(window => window.id === selected)) throw error
      binding.app!.windows = windows
      binding.windowId = undefined
      binding.previous = undefined
      return { windows }
    }
  }
  private async readObservation(binding: Binding, input: { windowId?: string; rootRef?: string; scope?: ComputerObservationScope }, signal: AbortSignal): Promise<ComputerObservation | undefined> {
    const old = binding.snapshot
    binding.snapshot = undefined
    let rootIndex: number | undefined
    if (input.rootRef) {
      if (!old) throw new ComputerError('STALE_SNAPSHOT', 'rootRef requires a current AX snapshot.')
      rootIndex = this.index(old, input.rootRef)
    }
    const scope = input.scope ?? (input.rootRef ? old?.scope : undefined) ?? 'window'
    if (scope === 'application' && input.windowId !== undefined) throw new ComputerError('INVALID_INPUT', 'Application scope does not select a window.')
    if (rootIndex !== undefined && scope !== old!.scope) throw new ComputerError('STALE_SNAPSHOT', 'Cannot use rootRef with a different observation scope.')
    const previousWindow = binding.windowId
    const selected = scope === 'window' ? await this.selectWindow(binding, input.windowId, signal) : undefined
    if ((scope === 'window' && previousWindow !== selected) || binding.previousScope !== scope) binding.previous = undefined
    if (scope === 'window' && !selected) return undefined
    if (scope === 'window' && rootIndex !== undefined && selected !== previousWindow) throw new ComputerError('STALE_SNAPSHOT', 'Cannot use rootRef with a different window.')
    const data = observationSchema.parse(await this.native(binding.client, 'observe', { scope, ...(selected ? { windowId: selected } : {}), ...(rootIndex === undefined ? {} : { rootIndex, revision: old!.revision }) }, signal))
    this.checkPID(binding, data.processId)
    if (data.scope !== scope || data.windowId !== selected) throw new ComputerError('TARGET_CHANGED', 'Observed window changed.')
    this.checkRevision(binding, data.revision)
    binding.app!.windows = data.windows
    return data
  }
  private publish(binding: Binding, data: ComputerObservation | undefined, full = false, subtree = false): Record<string, unknown> {
    if (!data) return { ...this.describe(binding), complete: false, text: 'Select windowId from windows, or open a window in the target application, then call get_state.' }
    const id = `s${randomUUID()}`
    const rendered = renderObservation(id, data.revision, data.nodes, full || data.truncated ? undefined : binding.previous)
    binding.snapshot = { id, revision: data.revision, nodes: data.nodes, scope: data.scope }
    binding.previousScope = data.scope
    // Only complete reads of the same scope can seed a diff.
    binding.previous = data.truncated || rendered.truncated || subtree ? undefined : { snapshotId: id, revision: data.revision, nodes: data.nodes }
    return { ...this.describe(binding), snapshotId: id, scope: data.scope, sampledAt: data.sampledAt, windowId: data.windowId, revision: data.revision, baseRevision: rendered.baseRevision, mode: rendered.mode, ...(data.scope === 'window' ? { boundsInPoints: data.bounds, coordinateSpace: 'window-local-points' } : {}),
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

function sameBounds(a: { x: number; y: number; width: number; height: number }, b: typeof a): boolean {
  return ['x', 'y', 'width', 'height'].every(key => Math.abs(a[key as keyof typeof a] - b[key as keyof typeof b]) < 1)
}
function pngBytes(shot: z.infer<typeof screenshotSchema>): Buffer {
  const bytes = Buffer.from(shot.png, 'base64')
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.readUInt32BE(16) !== shot.width || bytes.readUInt32BE(20) !== shot.height)
    throw new ComputerError('DRIVER_LOST', 'Invalid native PNG.', 'unknown')
  return bytes
}
