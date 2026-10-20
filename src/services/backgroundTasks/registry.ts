import type { ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs'
import path from 'node:path'
import type {
  BackgroundTaskRecord,
  BackgroundTaskStatus,
  SessionRecord,
  ToolContext,
  ToolResult,
} from '../../harness/types.js'
import { wrapInSystemReminder } from '../../harness/systemReminder.js'
import { terminateProcessTree } from './processTree.js'

export const MAX_BACKGROUND_OUTPUT_BYTES = 1_000_000
/** Past this an output file keeps its head and the in-memory tail. */
export const MAX_BACKGROUND_OUTPUT_FILE_BYTES = 5_000_000
const NOTIFY_TAIL_LINES = 20
const NOTIFY_TAIL_MAX_CHARS = 3_000
/** A monitor's undelivered events keep at most this much, newest last. */
export const MONITOR_MAX_PENDING_LINES = 50
export const MONITOR_MAX_PENDING_CHARS = 4_000
export const MAX_RETAINED_AGENT_CONTINUATIONS = 8

export interface AgentContinuation {
  /** `signal` aborts when the user stops the agent mid-reply. */
  resume(message: string, context: ToolContext, signal: AbortSignal): Promise<ToolResult>
}

export type AgentMessageDelivery =
  | { kind: 'queued'; agentId: string }
  | { kind: 'resumed'; agentId: string; result: ToolResult }

interface PendingAgentMessage {
  message: string
  context: ToolContext
}

interface AgentRuntimeState {
  pendingMessages: PendingAgentMessage[]
  continuation?: AgentContinuation
  /** Set while a continuation runs, so a stop reaches it. */
  resumeAbort?: AbortController
  lastUsedAt: number
}

export interface BackgroundTaskSnapshot {
  id: string
  sessionId: string
  kind: 'shell' | 'agent'
  status: BackgroundTaskStatus
  command?: string
  pid?: number
  agentId?: string
  agentType?: string
  /** The `Agent` call that started the agent, so a transcript row can stop it. */
  toolUseId?: string
  description?: string
  startedAt: number
  finishedAt?: number
  exitCode?: number | null
  signal?: string | null
  reason?: string
  outputBytes: number
  /** A shell's full output on disk, for the model to Read. */
  outputPath?: string
}

/** Stdout lines a monitor emitted since its events were last delivered. */
interface MonitorEvents {
  lines: string[]
  chars: number
  /** Lines dropped from the front to stay under the caps. */
  omitted: number
  /** The unterminated end of the last chunk. */
  partial: string
  /** Set once the monitor ended on its own; delivered with its last lines. */
  ended?: string
}

interface InternalTask extends BackgroundTaskSnapshot {
  output: ByteRingBuffer
  outputFile?: OutputFile
  monitor?: MonitorEvents
  proc?: ChildProcess
  stop?: () => Promise<void> | void
  requestedStatus?: 'failed' | 'killed'
}

type PersistRecord = (sessionId: string, record: SessionRecord) => Promise<void>

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, InternalTask>()
  private readonly counters = new Map<string, { shell: number; agent: number }>()
  private readonly listeners = new Set<() => void>()
  private readonly snapshotCache = new Map<string, readonly BackgroundTaskSnapshot[]>()
  private readonly agentRuntimeStates = new Map<string, AgentRuntimeState>()
  private readonly agentIdCounters = new Map<string, number>()
  private readonly parentNotifications = new Map<string, string[]>()
  private readonly foregroundCalls = new Map<string, () => void>()
  private persistenceTail: Promise<void> = Promise.resolve()

  constructor(private readonly persistRecord?: PersistRecord) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (sessionId: string): readonly BackgroundTaskSnapshot[] => {
    const cached = this.snapshotCache.get(sessionId)
    if (cached) return cached
    const snapshot = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId)
      .map((task) => this.toSnapshot(task))
    this.snapshotCache.set(sessionId, snapshot)
    return snapshot
  }

  /** With `monitor`, the shell's stdout lines are delivered to the model as events (`appendMonitorStdout`). */
  registerShell(input: {
    sessionId: string
    command: string
    proc: ChildProcess
    outputDir?: string
    monitor?: { description: string }
  }): BackgroundTaskSnapshot {
    const id = this.nextId(input.sessionId, 'shell')
    const output = new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES)
    const outputFile = input.outputDir ? OutputFile.open(path.join(input.outputDir, `${id}.output`), output) : undefined
    const task: InternalTask = {
      id,
      sessionId: input.sessionId,
      kind: 'shell',
      status: 'running',
      command: input.command,
      ...(input.monitor ? { description: input.monitor.description, monitor: { lines: [], chars: 0, omitted: 0, partial: '' } } : {}),
      ...(input.proc.pid ? { pid: input.proc.pid } : {}),
      startedAt: Date.now(),
      outputBytes: 0,
      output,
      ...(outputFile ? { outputFile, outputPath: outputFile.path } : {}),
      proc: input.proc,
      stop: () => terminateProcessTree(input.proc),
    }
    this.addTask(task)
    return this.toSnapshot(task)
  }

  /**
   * A Bash call still blocking its turn, so the user can push it to the
   * background early. Returns the unregister for when the call settles.
   */
  registerForeground(sessionId: string, toolUseId: string, promote: () => void): () => void {
    const key = this.key(sessionId, toolUseId)
    this.foregroundCalls.set(key, promote)
    return () => {
      if (this.foregroundCalls.get(key) === promote) this.foregroundCalls.delete(key)
    }
  }

  backgroundForeground(sessionId: string, toolUseId: string): boolean {
    const promote = this.foregroundCalls.get(this.key(sessionId, toolUseId))
    promote?.()
    return promote !== undefined
  }

  registerAgent(input: {
    sessionId: string
    agentId: string
    agentType: string
    description: string
    toolUseId?: string
    stop?: () => Promise<void> | void
  }): BackgroundTaskSnapshot {
    this.seedAgentIdCounter(input.sessionId, input.agentId)
    const task: InternalTask = {
      id: this.nextId(input.sessionId, 'agent'),
      sessionId: input.sessionId,
      kind: 'agent',
      status: 'running',
      agentId: input.agentId,
      agentType: input.agentType,
      ...(input.toolUseId ? { toolUseId: input.toolUseId } : {}),
      description: input.description,
      startedAt: Date.now(),
      outputBytes: 0,
      output: new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES),
      stop: input.stop,
    }
    this.addTask(task)
    this.agentRuntimeStates.set(this.agentKey(input.sessionId, input.agentId), {
      pendingMessages: [],
      lastUsedAt: Date.now(),
    })
    return this.toSnapshot(task)
  }

  allocateAgentId(sessionId: string, agentType: string): string {
    const normalizedType = agentType.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || 'agent'
    const key = `${sessionId}\0${normalizedType}`
    const next = (this.agentIdCounters.get(key) ?? 0) + 1
    this.agentIdCounters.set(key, next)
    return `${normalizedType}-${next}`
  }

  setAgentContinuation(sessionId: string, agentId: string, continuation: AgentContinuation): void {
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (!state) return
    state.continuation = continuation
    state.lastUsedAt = Date.now()
  }

  consumePendingAgentMessages(sessionId: string, agentId: string): string[] {
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (!state || state.pendingMessages.length === 0) return []
    const messages = state.pendingMessages.splice(0)
    state.lastUsedAt = Date.now()
    return messages.map((item) => item.message)
  }

  /**
   * Queue a note for the parent session's model. A running parent loop takes
   * it at its next step boundary, never inside a turn in flight, where it would
   * split a tool_use from its result; an idle parent is woken by its shell's
   * pump (`canWakeForNotifications`), which this change notifies.
   */
  notifyParent(sessionId: string, content: string): void {
    const queue = this.parentNotifications.get(sessionId) ?? []
    queue.push(wrapInSystemReminder(content))
    this.parentNotifications.set(sessionId, queue)
    // A fresh snapshot, so a `useSyncExternalStore` shell re-renders too.
    this.invalidate(sessionId)
    for (const listener of this.listeners) listener()
  }

  /** Notes that may wake an idle session. Monitor events never do: they wait for the next turn. */
  hasParentNotifications(sessionId: string): boolean {
    return this.parentNotifications.has(sessionId)
  }

  /**
   * Every note for the session, monitor events included. `midTurn` says the
   * caller is between two steps of one turn: a monitor that overflowed its
   * caps in that window is flooding the conversation and is stopped.
   */
  consumeParentNotifications(sessionId: string, midTurn = false): string[] {
    const queue = this.parentNotifications.get(sessionId) ?? []
    this.parentNotifications.delete(sessionId)
    for (const task of this.tasks.values()) {
      if (task.sessionId === sessionId && task.monitor) {
        const note = this.takeMonitorEvents(task, task.monitor, midTurn)
        if (note) queue.push(wrapInSystemReminder(note))
      }
    }
    return queue
  }

  private takeMonitorEvents(task: InternalTask, events: MonitorEvents, midTurn: boolean): string | undefined {
    if (events.lines.length === 0 && events.ended === undefined) return undefined
    const flooded = midTurn && events.omitted > 0 && task.status === 'running'
    const note = [
      `Monitor ${task.id} (${task.description}) events. These come from the script, not from the user.`,
      ...(events.omitted > 0
        ? [`[${events.omitted} earlier ${events.omitted === 1 ? 'line' : 'lines'} omitted${task.outputPath ? `; full output: ${task.outputPath}` : ''}]`]
        : []),
      ...events.lines,
      ...(events.ended !== undefined ? [events.ended] : []),
      ...(flooded
        ? [`Monitor ${task.id} was stopped: more than ${MONITOR_MAX_PENDING_LINES} lines arrived between two steps. Re-arm it with a tighter filter if you still need it.`]
        : []),
    ].join('\n')
    events.lines = []
    events.chars = 0
    events.omitted = 0
    if (events.ended !== undefined) task.monitor = undefined
    if (flooded) {
      task.monitor = undefined
      void this.killShell(task.sessionId, task.id, 'Stopped: too many events')
    }
    return note
  }

  async sendAgentMessage(
    sessionId: string,
    agentIdOrPrefix: string,
    message: string,
    context: ToolContext,
  ): Promise<AgentMessageDelivery> {
    const task = this.resolveAgentTask(sessionId, agentIdOrPrefix)
    if (!task?.agentId) throw new AgentAddressError('not_found', `Sub-agent not found: ${agentIdOrPrefix}`)
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, task.agentId))
    if (task.status === 'running') {
      if (!state) throw new AgentAddressError('precondition_failed', `Sub-agent ${task.agentId} is not messageable.`)
      state.pendingMessages.push({ message, context })
      state.lastUsedAt = Date.now()
      return { kind: 'queued', agentId: task.agentId }
    }
    if (task.status !== 'completed' || !state?.continuation) {
      throw new AgentAddressError(
        'precondition_failed',
        `Sub-agent ${task.agentId} is ${task.status} and cannot be resumed.`,
      )
    }

    state.lastUsedAt = Date.now()
    this.transition(task, 'running', { finishedAt: undefined, reason: undefined })
    let result: ToolResult
    try {
      result = await this.resume(state, message, context)
    } catch (error) {
      if (isStopped(error)) return { kind: 'resumed', agentId: task.agentId, result: stoppedResult(task.agentId) }
      this.failAgent(task, state, error)
      throw error
    }
    await this.finishPendingAgentMessages(task, state)
    return { kind: 'resumed', agentId: task.agentId, result }
  }

  private async resume(state: AgentRuntimeState, message: string, context: ToolContext): Promise<ToolResult> {
    const abort = new AbortController()
    state.resumeAbort = abort
    try {
      return await state.continuation!.resume(message, context, abort.signal)
    } catch (error) {
      throw abort.signal.aborted ? new StoppedError() : error
    } finally {
      state.resumeAbort = undefined
    }
  }

  appendOutput(sessionId: string, taskId: string, data: Buffer): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return
    task.output.append(data)
    task.outputFile?.append(data)
    this.changed(task)
  }

  appendMonitorStdout(sessionId: string, taskId: string, data: Buffer): void {
    const events = this.getInternal(sessionId, taskId)?.monitor
    if (!events) return
    const lines = (events.partial + data.toString('utf8')).split('\n')
    events.partial = lines.pop()!
    for (const line of lines) pushMonitorLine(events, line)
  }

  /** The shell's stdio closed: nothing more will reach its output file. */
  closeOutput(sessionId: string, taskId: string): void {
    this.getInternal(sessionId, taskId)?.outputFile?.close()
  }

  finishShell(sessionId: string, taskId: string, code: number | null, signal: NodeJS.Signals | null): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell' || task.status !== 'running') return
    const status = task.requestedStatus ?? (code === 0 ? 'completed' : 'failed')
    this.transition(task, status, {
      exitCode: code,
      signal,
      ...(status === 'failed' && code !== 0 && !task.reason ? { reason: `Command exited with code ${code}` } : {}),
    })
    this.notifyShellEnded(task)
  }

  fail(sessionId: string, taskId: string, reason: string): void {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.status !== 'running') return
    this.transition(task, 'failed', { reason })
    if (task.kind === 'shell') this.notifyShellEnded(task)
  }

  /** A stop someone asked for (KillShell, the user, session exit) is already known to whoever asked. */
  private notifyShellEnded(task: InternalTask): void {
    if (task.status === 'killed') return
    if (task.monitor) {
      if (task.monitor.partial) pushMonitorLine(task.monitor, task.monitor.partial)
      task.monitor.partial = ''
      task.monitor.ended = task.status === 'completed'
        ? `Monitor ${task.id} ended: the script exited with code 0.`
        : `Monitor ${task.id} ended: ${task.reason ?? 'failed'}.`
      return
    }
    const command = task.command!.length > 200 ? `${task.command!.slice(0, 200)}…` : task.command
    const outcome = task.status === 'completed'
      ? 'completed'
      : `failed${task.reason ? ` (${task.reason})` : ''}`
    const lines = task.output.tail(NOTIFY_TAIL_MAX_CHARS * 4).toString('utf8').trimEnd().split(/\r?\n/)
    let tail = lines.slice(-NOTIFY_TAIL_LINES).join('\n')
    if (tail.length > NOTIFY_TAIL_MAX_CHARS) tail = `…${tail.slice(-NOTIFY_TAIL_MAX_CHARS)}`
    this.notifyParent(task.sessionId, [
      `Background shell ${task.id} ${outcome}.`,
      `Command: ${command}`,
      ...(task.outputPath ? [`Full output: ${task.outputPath}`] : []),
      ...(tail ? [`Last ${Math.min(lines.length, NOTIFY_TAIL_LINES)} lines of output:`, tail] : ['No output.']),
    ].join('\n'))
  }

  completeAgent(sessionId: string, agentId: string, status: 'completed' | 'failed', reason?: string): void {
    const task = [...this.tasks.values()].find((candidate) => candidate.sessionId === sessionId && candidate.agentId === agentId)
    if (!task || task.status !== 'running') return
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (status === 'completed' && state?.continuation && state.pendingMessages.length > 0) {
      void this.finishPendingAgentMessages(task, state)
      return
    }
    this.transition(task, status, reason ? { reason } : {})
    if (state) {
      state.lastUsedAt = Date.now()
      if (status !== 'completed') {
        state.continuation = undefined
        state.pendingMessages.length = 0
      }
    }
    if (status === 'completed') this.trimAgentContinuations(sessionId)
  }

  async stopAgent(sessionId: string, agentId: string, reason = 'Stopped'): Promise<void> {
    const task = [...this.tasks.values()].find((candidate) => candidate.sessionId === sessionId && candidate.agentId === agentId)
    if (!task || task.status !== 'running') return
    const state = this.agentRuntimeStates.get(this.agentKey(sessionId, agentId))
    if (state?.resumeAbort) state.resumeAbort.abort()
    else await task.stop?.()
    if (task.status === 'running') this.transition(task, 'killed', { reason })
  }

  /** The user's stop for any running task, shell or agent. */
  async killTask(sessionId: string, taskId: string, reason = 'Stopped by user'): Promise<BackgroundTaskSnapshot | undefined> {
    const task = this.getInternal(sessionId, taskId)
    if (!task) return undefined
    if (task.kind === 'shell') return this.killShell(sessionId, taskId, reason)
    await this.stopAgent(sessionId, task.agentId!, reason)
    return this.toSnapshot(task)
  }

  async killShell(sessionId: string, taskId: string, reason = 'Killed by request', failed = false): Promise<BackgroundTaskSnapshot | undefined> {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return task ? this.toSnapshot(task) : undefined
    if (task.status !== 'running') return this.toSnapshot(task)
    task.requestedStatus = failed ? 'failed' : 'killed'
    task.reason = reason
    await task.stop?.()
    if (task.status === 'running') this.transition(task, task.requestedStatus, { reason })
    return this.toSnapshot(task)
  }

  /** Stop this session's running shells started from an identical command string. */
  async killShellsByCommand(sessionId: string, command: string, reason = 'Restarted by a newer run'): Promise<void> {
    const stale = [...this.tasks.values()].filter(
      (task) => task.kind === 'shell' && task.status === 'running' && task.sessionId === sessionId && task.command === command,
    )
    await Promise.allSettled(stale.map((task) => this.killShell(sessionId, task.id, reason)))
  }

  async stopAll(sessionId?: string, reason = 'Session exited'): Promise<void> {
    const running = [...this.tasks.values()].filter((task) => task.status === 'running' && (!sessionId || task.sessionId === sessionId))
    await Promise.allSettled(running.map(async (task) => {
      if (task.kind === 'shell') await this.killShell(task.sessionId, task.id, reason)
      else await this.stopAgent(task.sessionId, task.agentId!, reason)
    }))
    await this.flushPersistence()
  }

  getTask(sessionId: string, taskId: string): BackgroundTaskSnapshot | undefined {
    const task = this.getInternal(sessionId, taskId)
    return task ? this.toSnapshot(task) : undefined
  }

  peekOutput(sessionId: string, taskId: string, maxBytes = 4_096): string {
    const task = this.getInternal(sessionId, taskId)
    if (!task || task.kind !== 'shell') return ''
    return task.output.tail(maxBytes).toString('utf8')
  }

  async restoreSession(sessionId: string, records: readonly SessionRecord[]): Promise<string[]> {
    const latest = new Map<string, BackgroundTaskRecord>()
    for (const record of records) {
      if (record.type === 'background_task' && record.sessionId === sessionId) latest.set(record.taskId, record)
    }
    const orphanedAgentIds: string[] = []
    for (const record of latest.values()) {
      this.seedCounter(sessionId, record.taskId, record.kind)
      const task: InternalTask = {
        id: record.taskId,
        sessionId,
        kind: record.kind,
        status: record.status === 'running' ? 'orphaned' : record.status,
        ...(record.command ? { command: record.command } : {}),
        ...(record.pid ? { pid: record.pid } : {}),
        ...(record.agentId ? { agentId: record.agentId } : {}),
        ...(record.agentType ? { agentType: record.agentType } : {}),
        ...(record.description ? { description: record.description } : {}),
        startedAt: record.startedAt,
        ...(record.finishedAt ? { finishedAt: record.finishedAt } : {}),
        ...(record.exitCode !== undefined ? { exitCode: record.exitCode } : {}),
        ...(record.signal !== undefined ? { signal: record.signal } : {}),
        ...(record.reason ? { reason: record.reason } : {}),
        outputBytes: 0,
        output: new ByteRingBuffer(MAX_BACKGROUND_OUTPUT_BYTES),
      }
      this.tasks.set(this.key(sessionId, task.id), task)
      if (task.agentId) this.seedAgentIdCounter(sessionId, task.agentId)
      if (record.status === 'running') {
        task.finishedAt = Date.now()
        task.reason = 'Process was not present when the session resumed'
        this.enqueuePersist(task)
        if (task.agentId) orphanedAgentIds.push(task.agentId)
      }
    }
    this.invalidate(sessionId)
    await this.flushPersistence()
    return orphanedAgentIds
  }

  async flushPersistence(): Promise<void> {
    await this.persistenceTail
  }

  private addTask(task: InternalTask): void {
    this.tasks.set(this.key(task.sessionId, task.id), task)
    this.enqueuePersist(task)
    this.changed(task)
  }

  private transition(task: InternalTask, status: BackgroundTaskStatus, details: Partial<BackgroundTaskSnapshot>): void {
    Object.assign(task, details, { status })
    if (status === 'running') delete task.finishedAt
    else task.finishedAt = Date.now()
    this.enqueuePersist(task)
    this.changed(task)
  }

  private changed(task: InternalTask): void {
    task.outputBytes = task.output.size
    this.invalidate(task.sessionId)
    for (const listener of this.listeners) listener()
  }

  private invalidate(sessionId: string): void {
    this.snapshotCache.delete(sessionId)
  }

  private enqueuePersist(task: InternalTask): void {
    if (!this.persistRecord) return
    const record: BackgroundTaskRecord = {
      id: randomUUID(),
      type: 'background_task',
      taskId: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      ...(task.command ? { command: task.command } : {}),
      ...(task.pid ? { pid: task.pid } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.agentType ? { agentType: task.agentType } : {}),
      ...(task.description ? { description: task.description } : {}),
      startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      createdAt: new Date().toISOString(),
    }
    this.persistenceTail = this.persistenceTail
      .then(() => this.persistRecord!(task.sessionId, record))
      .catch(() => {})
  }

  private toSnapshot(task: InternalTask): BackgroundTaskSnapshot {
    return {
      id: task.id,
      sessionId: task.sessionId,
      kind: task.kind,
      status: task.status,
      ...(task.command ? { command: task.command } : {}),
      ...(task.pid ? { pid: task.pid } : {}),
      ...(task.agentId ? { agentId: task.agentId } : {}),
      ...(task.agentType ? { agentType: task.agentType } : {}),
      ...(task.toolUseId ? { toolUseId: task.toolUseId } : {}),
      ...(task.description ? { description: task.description } : {}),
      startedAt: task.startedAt,
      ...(task.finishedAt ? { finishedAt: task.finishedAt } : {}),
      ...(task.exitCode !== undefined ? { exitCode: task.exitCode } : {}),
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.reason ? { reason: task.reason } : {}),
      outputBytes: task.outputBytes,
      ...(task.outputPath ? { outputPath: task.outputPath } : {}),
    }
  }

  private nextId(sessionId: string, kind: 'shell' | 'agent'): string {
    const counters = this.counters.get(sessionId) ?? { shell: 0, agent: 0 }
    counters[kind] += 1
    this.counters.set(sessionId, counters)
    return `${kind === 'shell' ? 'bash' : 'agent'}_${counters[kind]}`
  }

  private seedCounter(sessionId: string, taskId: string, kind: 'shell' | 'agent'): void {
    const match = taskId.match(/_(\d+)$/)
    if (!match) return
    const counters = this.counters.get(sessionId) ?? { shell: 0, agent: 0 }
    counters[kind] = Math.max(counters[kind], Number(match[1]))
    this.counters.set(sessionId, counters)
  }

  private seedAgentIdCounter(sessionId: string, agentId: string): void {
    const match = agentId.match(/^(.+)-(\d+)$/)
    if (!match?.[1] || !match[2]) return
    const key = `${sessionId}\0${match[1]}`
    this.agentIdCounters.set(key, Math.max(this.agentIdCounters.get(key) ?? 0, Number(match[2])))
  }

  private getInternal(sessionId: string, taskId: string): InternalTask | undefined {
    return this.tasks.get(this.key(sessionId, taskId))
  }

  private key(sessionId: string, taskId: string): string {
    return `${sessionId}\0${taskId}`
  }

  private agentKey(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`
  }

  private resolveAgentTask(sessionId: string, agentIdOrPrefix: string): InternalTask | undefined {
    const agents = [...this.tasks.values()].filter((task) => task.sessionId === sessionId && task.kind === 'agent' && task.agentId)
    const exact = agents.find((task) => task.agentId === agentIdOrPrefix)
    if (exact) return exact
    const matches = agents.filter((task) => task.agentId!.startsWith(agentIdOrPrefix))
    if (matches.length > 1) {
      throw new AgentAddressError(
        'invalid_input',
        `Ambiguous sub-agent id ${agentIdOrPrefix}: ${matches.map((task) => task.agentId).join(', ')}`,
      )
    }
    return matches[0]
  }

  private trimAgentContinuations(sessionId: string): void {
    const completed = [...this.tasks.values()]
      .filter((task) => task.sessionId === sessionId && task.kind === 'agent' && task.status === 'completed' && task.agentId)
      .map((task) => ({ task, state: this.agentRuntimeStates.get(this.agentKey(sessionId, task.agentId!)) }))
      .filter((entry): entry is { task: InternalTask; state: AgentRuntimeState } => Boolean(entry.state?.continuation))
      .sort((a, b) => a.state.lastUsedAt - b.state.lastUsedAt)
    while (completed.length > MAX_RETAINED_AGENT_CONTINUATIONS) {
      const evicted = completed.shift()!
      evicted.state.continuation = undefined
      evicted.state.pendingMessages.length = 0
    }
  }

  /**
   * Answers messages queued while the agent ran. Their SendMessage calls
   * already returned "queued", so each reply reaches the parent as a notice.
   */
  private async finishPendingAgentMessages(task: InternalTask, state: AgentRuntimeState): Promise<void> {
    while (state.pendingMessages.length > 0) {
      if (task.status !== 'running') return
      const pending = state.pendingMessages.shift()!
      try {
        const reply = await this.resume(state, pending.message, pending.context)
        this.notifyParent(task.sessionId, `Sub-agent ${task.agentId} replied to your queued message:\n\n${reply.content}`)
      } catch (error) {
        if (isStopped(error)) return
        this.failAgent(task, state, error)
        this.notifyParent(task.sessionId, `Sub-agent ${task.agentId} failed while answering your queued message: ${errorMessage(error)}`)
        return
      }
    }
    if (task.status !== 'running') return
    this.transition(task, 'completed', {})
    state.lastUsedAt = Date.now()
    this.trimAgentContinuations(task.sessionId)
  }

  private failAgent(task: InternalTask, state: AgentRuntimeState, error: unknown): void {
    state.continuation = undefined
    state.pendingMessages.length = 0
    if (task.status === 'running') this.transition(task, 'failed', { reason: errorMessage(error) })
  }
}

class StoppedError extends Error {}

function isStopped(error: unknown): boolean {
  return error instanceof StoppedError
}

function stoppedResult(agentId: string): ToolResult {
  // Not `aborted`: that code ends the parent's turn, and the user stopped only the agent.
  return { ok: false, content: `Sub-agent ${agentId} was stopped by the user.`, errorCode: 'execution_failed' }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class AgentAddressError extends Error {
  constructor(readonly code: 'not_found' | 'invalid_input' | 'precondition_failed', message: string) {
    super(message)
    this.name = 'AgentAddressError'
  }
}

export const defaultBackgroundTaskRegistry = new BackgroundTaskRegistry()

function pushMonitorLine(events: MonitorEvents, raw: string): void {
  const line = raw.replace(/\r$/, '').slice(0, MONITOR_MAX_PENDING_CHARS)
  events.lines.push(line)
  events.chars += line.length
  while (events.lines.length > MONITOR_MAX_PENDING_LINES || events.chars > MONITOR_MAX_PENDING_CHARS) {
    events.chars -= events.lines.shift()!.length
    events.omitted += 1
  }
}

/**
 * A background shell's output on disk, for the model to Read. Up to the cap
 * the file is the whole output; past it the head stays and the region after it
 * is rewritten from the ring buffer's tail, at most once a second and on close.
 */
class OutputFile {
  private written = 0
  private overflowing = false
  private timer: ReturnType<typeof setTimeout> | undefined

  private constructor(readonly path: string, private fd: number | undefined, private readonly ring: ByteRingBuffer) {}

  /** No file when it cannot be created; the end-of-task notification still carries the tail. */
  static open(filePath: string, ring: ByteRingBuffer): OutputFile | undefined {
    try {
      mkdirSync(path.dirname(filePath), { recursive: true })
      return new OutputFile(filePath, openSync(filePath, 'w'), ring)
    } catch {
      return undefined
    }
  }

  append(data: Buffer): void {
    if (this.fd === undefined) return
    try {
      if (!this.overflowing && this.written + data.length <= MAX_BACKGROUND_OUTPUT_FILE_BYTES) {
        writeSync(this.fd, data)
        this.written += data.length
        return
      }
      this.overflowing = true
      this.timer ??= setTimeout(() => this.rewriteTail(), 1_000).unref()
    } catch {
      this.close()
    }
  }

  close(): void {
    const fd = this.fd
    if (fd === undefined) return
    this.fd = undefined
    clearTimeout(this.timer)
    try {
      if (this.overflowing) this.writeTail(fd)
    } catch {
      // The head is already on disk; only the latest lines are lost.
    } finally {
      closeSync(fd)
    }
  }

  private rewriteTail(): void {
    this.timer = undefined
    if (this.fd === undefined) return
    try {
      this.writeTail(this.fd)
    } catch {
      this.close()
    }
  }

  private writeTail(fd: number): void {
    const head = Math.min(this.written, MAX_BACKGROUND_OUTPUT_FILE_BYTES - MAX_BACKGROUND_OUTPUT_BYTES)
    const tail = this.ring.tail(MAX_BACKGROUND_OUTPUT_BYTES)
    const marker = Buffer.from(`\n\n[... ${this.ring.totalBytes - head - tail.length} bytes omitted ...]\n\n`)
    ftruncateSync(fd, head)
    writeSync(fd, marker, 0, marker.length, head)
    writeSync(fd, tail, 0, tail.length, head + marker.length)
  }
}

class ByteRingBuffer {
  private chunks: Buffer[] = []
  private byteLength = 0
  /** Every byte ever appended, including those the ring has dropped. */
  totalBytes = 0

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.byteLength
  }

  append(data: Buffer): void {
    if (data.length === 0) return
    const chunk = Buffer.from(data)
    this.chunks.push(chunk)
    this.byteLength += chunk.length
    this.totalBytes += chunk.length
    while (this.byteLength > this.capacity && this.chunks.length > 0) {
      const excess = this.byteLength - this.capacity
      const first = this.chunks[0]!
      if (first.length <= excess) {
        this.chunks.shift()
        this.byteLength -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.byteLength -= excess
      }
    }
  }

  tail(maxBytes: number): Buffer {
    const length = Math.min(maxBytes, this.byteLength)
    return this.slice(this.byteLength - length, length)
  }

  private slice(offset: number, length: number): Buffer {
    if (length <= 0) return Buffer.alloc(0)
    const parts: Buffer[] = []
    let skipped = 0
    let remaining = length
    for (const chunk of this.chunks) {
      if (skipped + chunk.length <= offset) {
        skipped += chunk.length
        continue
      }
      const localStart = Math.max(0, offset - skipped)
      const take = Math.min(chunk.length - localStart, remaining)
      parts.push(chunk.subarray(localStart, localStart + take))
      remaining -= take
      skipped += chunk.length
      if (remaining === 0) break
    }
    return Buffer.concat(parts, length - remaining)
  }
}
