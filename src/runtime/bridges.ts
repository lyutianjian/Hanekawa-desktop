import type { PermissionPrompt, PermissionRequest } from '../harness/permissions.js'
import type {
  AskUserQuestionRequest,
  AskUserQuestionResult,
  ModelStreamEvent,
  SessionRecord,
  SteerSource,
  TokenUsage,
  ToolProgressEvent,
} from '../harness/types.js'
import type { ExitDialogInput, ExitPlanDecision } from '../harness/planModeManager.js'

/**
 * The complete human-in-the-loop surface of the runtime.
 *
 * Every proxy here is a stable object created before any UI exists, holding a
 * mutable handler that the UI installs once it is ready and removes when it
 * goes away. The runtime only ever sees the function signatures, so the same
 * assembly works for the Ink TUI, a desktop shell, or a headless caller.
 *
 * Two directions are represented: `record` is a one-way push out of the
 * runtime, the other four are blocking request/response calls into the UI.
 * The pre-mount fallbacks are deliberately different per bridge — see each
 * factory — and must not be unified.
 *
 * `prompt` is the one bridge that *parks* rather than answering while no UI is
 * attached: a permission request that arrives too early waits for a UI instead
 * of being silently denied. The other three answer immediately, because
 * headless callers (PlanModeManager driven directly, unit tests with no React
 * tree) depend on that and would otherwise hang.
 *
 * All four settle their in-flight work through `drainPending()` when the UI is
 * gone for good. That backstop is load-bearing: `ToolRunner.run` does not pass
 * its abort signal into `PermissionGate.approve`, so a prompt that never
 * settles hangs the tool call forever no matter what the user cancels.
 */

export interface RecordProxy {
  onRecord: (record: SessionRecord) => void
  setHandler: (fn: (record: SessionRecord) => void) => void
  onProgress: (event: ToolProgressEvent) => void
  setProgressHandler: (fn: (event: ToolProgressEvent) => void) => void
  onStreamEvent: (event: ModelStreamEvent) => void
  setStreamEventHandler: (fn: (event: ModelStreamEvent) => void) => void
  /**
   * The usage of one *completed provider request*, pushed as soon as the
   * response lands rather than waiting for the turn to finish.
   *
   * This is what the context gauge is measured from, and a turn that runs ten
   * tool iterations sends ten requests — reporting only the last one at
   * `run()`'s return left the readout a whole turn behind. Carries the request's
   * own numbers, never a running total: the session totals stay on the
   * end-of-run accounting so nothing is counted twice.
   */
  onRequestUsage: (usage: TokenUsage, anchorRecordId?: string) => void
  setRequestUsageHandler: (fn: (usage: TokenUsage, anchorRecordId?: string) => void) => void
  /**
   * Usage spent outside the foreground requests — a compaction summary, a
   * subagent transcript, a side call — pushed as it lands. It counts toward the
   * session total and never toward the context readout's last request.
   */
  onAuxUsage: (usage: TokenUsage) => void
  setAuxUsageHandler: (fn: (usage: TokenUsage) => void) => void
}

export function createRecordProxy(): RecordProxy {
  let handler: (record: SessionRecord) => void = () => {}
  let progressHandler: (event: ToolProgressEvent) => void = () => {}
  let streamEventHandler: (event: ModelStreamEvent) => void = () => {}
  let requestUsageHandler: (usage: TokenUsage, anchorRecordId?: string) => void = () => {}
  let auxUsageHandler: (usage: TokenUsage) => void = () => {}
  return {
    onRecord: (record) => handler(record),
    setHandler: (fn) => { handler = fn },
    onProgress: (event) => progressHandler(event),
    setProgressHandler: (fn) => { progressHandler = fn },
    onStreamEvent: (event) => streamEventHandler(event),
    setStreamEventHandler: (fn) => { streamEventHandler = fn },
    onRequestUsage: (usage, anchorRecordId) => requestUsageHandler(usage, anchorRecordId),
    setRequestUsageHandler: (fn) => { requestUsageHandler = fn },
    onAuxUsage: (usage) => auxUsageHandler(usage),
    setAuxUsageHandler: (fn) => { auxUsageHandler = fn },
  }
}

/**
 * Bridges the imperative PermissionGate with whatever UI renders the prompt.
 *
 * Usage:
 * 1. Call `createPromptProxy()` to get a stable PermissionPrompt function
 * 2. Pass it to the PermissionGate constructor
 * 3. In the UI, install the real handler via `setPrompt`
 *
 * Requests arriving before step 3 park until a UI attaches. Denying them
 * silently — the old behavior — is invisible in a terminal, where the window is
 * a few milliseconds, but a desktop renderer can take seconds to come up and
 * would auto-deny real tool calls. `drainPending()` is the escape hatch for a
 * UI that is never coming.
 */
export interface PermissionPromptProxy {
  prompt: PermissionPrompt
  setPrompt: (fn: PermissionPrompt) => void
  /** Detaches the UI; later requests park again rather than auto-denying. */
  clearPrompt: () => void
  /** Denies everything still parked, for a UI that will never attach. */
  drainPending: () => void
}

export function createPromptProxy(): PermissionPromptProxy {
  let currentPrompt: PermissionPrompt | undefined
  let parked: Array<{
    request: PermissionRequest
    resolve: (value: boolean | PromiseLike<boolean>) => void
  }> = []

  const takeParked = () => {
    const waiting = parked
    parked = []
    return waiting
  }

  return {
    prompt: (request: PermissionRequest) => {
      if (currentPrompt) return currentPrompt(request)
      return new Promise<boolean>((resolve) => {
        parked.push({ request, resolve })
      })
    },
    setPrompt: (fn: PermissionPrompt) => {
      currentPrompt = fn
      // Taken before dispatching: `fn` may park a follow-up request of its own.
      for (const { request, resolve } of takeParked()) resolve(fn(request))
    },
    clearPrompt: () => {
      currentPrompt = undefined
    },
    drainPending: () => {
      for (const { resolve } of takeParked()) resolve(false)
    },
  }
}

/**
 * Bridges PlanModeManager.openExitDialog with the UI.
 *
 * Before the UI installs a handler the proxy auto-rejects with empty feedback
 * so the manager can still drive a clean test run.
 */
export interface ExitPlanPromptProxy {
  open(input: ExitDialogInput): Promise<ExitPlanDecision>
  setOpen(fn: (input: ExitDialogInput) => Promise<ExitPlanDecision>): void
}

export function createExitPlanProxy(): ExitPlanPromptProxy {
  let currentOpen: (input: ExitDialogInput) => Promise<ExitPlanDecision> = async () => ({
    kind: 'reject',
    feedback: '',
  })
  return {
    open: (input) => currentOpen(input),
    setOpen: (fn) => { currentOpen = fn },
  }
}

/**
 * Bridges PlanModeManager.openEnterPrompt with the UI.
 *
 * Before the UI installs a handler the proxy auto-approves entry, mirroring
 * the fallback in PlanModeManager.processEnterRequest where a missing
 * openEnterPrompt was implicitly treated as "approve". This keeps headless /
 * unit-test paths that never mount a UI working, and is deliberately the
 * opposite polarity of the permission bridge — entering plan mode only ever
 * restricts what the agent may do.
 */
export interface EnterPlanPromptProxy {
  open(): Promise<boolean>
  setOpen(fn: () => Promise<boolean>): void
}

export function createEnterPlanProxy(): EnterPlanPromptProxy {
  let currentOpen: () => Promise<boolean> = async () => true
  return {
    open: () => currentOpen(),
    setOpen: (fn) => { currentOpen = fn },
  }
}

/**
 * Bridges the AskUserQuestion tool with the UI.
 *
 * Before the UI installs a handler the proxy auto-rejects so the tool surfaces
 * a clean error instead of hanging.
 */
export interface AskUserQuestionProxy {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionResult>
  setOpen(fn: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult>): void
}

export function createAskUserQuestionProxy(): AskUserQuestionProxy {
  let currentOpen: (request: AskUserQuestionRequest) => Promise<AskUserQuestionResult> = async () => ({
    kind: 'rejected',
    feedback: 'AskUserQuestion UI is not mounted.',
  })
  return {
    ask: (request) => currentOpen(request),
    setOpen: (fn) => { currentOpen = fn },
  }
}

/**
 * Bridges the loop's steering step with the shell's message queue.
 *
 * With no queue attached the loop sees nothing pending, so a headless run
 * simply never steers.
 */
export interface SteerProxy extends SteerSource {
  setSource(source: SteerSource | undefined): void
}

export function createSteerProxy(): SteerProxy {
  let current: SteerSource | undefined
  return {
    pending: () => current?.pending() ?? [],
    consume: async (messageId) => current?.consume(messageId),
    setSource: (source) => { current = source },
  }
}

export interface UiBridges {
  prompt: PermissionPromptProxy
  record: RecordProxy
  exitPlan: ExitPlanPromptProxy
  enterPlan: EnterPlanPromptProxy
  askUserQuestion: AskUserQuestionProxy
  steer: SteerProxy
}

export function createUiBridges(): UiBridges {
  return {
    prompt: createPromptProxy(),
    record: createRecordProxy(),
    exitPlan: createExitPlanProxy(),
    enterPlan: createEnterPlanProxy(),
    askUserQuestion: createAskUserQuestionProxy(),
    steer: createSteerProxy(),
  }
}
