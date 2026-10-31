/**
 * The agent's half of the browser: one tool, one operation enum, no Electron.
 *
 * Everything that touches a real tab is behind {@link BrowserHost}, which is a
 * type and nothing else — the TUI never constructs one, so the tool simply does
 * not exist there (`main.ts` injects it through `extraTools`). What is left in
 * this file is dispatch, error translation, and the image hand-off.
 *
 * Failures from the host carry a `code`, read structurally rather than by
 * importing the error class from the desktop half. The mapping to
 * `ToolErrorCode` is deliberately coarse: the model acts on the message, and
 * the code only has to tell the runner whether this was the model's fault.
 */

import path from 'node:path'

import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { classifyPath, isSameOrInside, realPath } from '../../harness/risk/paths.js'
import { maxTier, type RiskTier } from '../../harness/risk/types.js'
import type {
  BrowserActionResult,
  BrowserCaller,
  BrowserHost,
  BrowserLoadState,
  BrowserSnapshot,
  BrowserTabState,
} from '../../runtime/protocol/browserHost.js'
import { formatImageCaption } from '../imageFile.js'
import {
  BROWSER_TOOL_NAME,
  OPERATIONS_NEEDING_TAB,
  READ_ONLY_OPERATIONS,
  WAIT_FOR_DEFAULT_MS,
  WAIT_FOR_LOAD_DEFAULT_MS,
} from './constants.js'
import { describeTab, hostOf, renderConsoleErrors, renderTabs, summarizeTabs } from './encode.js'
import { DESCRIPTION } from './prompt.js'
import { browserApiInputSchema, browserInputSchema, type BrowserInput } from './schema.js'
import { validateBrowserInput } from './validate.js'

/** A `BrowserHostError` as seen from here: a code, a message, maybe retryable. */
interface HostFailure {
  code: string
  message: string
  retryable: boolean
}

function hostFailure(error: unknown): HostFailure | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  if (typeof code !== 'string') return undefined
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: (error as { retryable?: unknown }).retryable === true,
  }
}

function errorCodeFor(failure: HostFailure): ToolResult['errorCode'] {
  switch (failure.code) {
    case 'TAB_NOT_FOUND':
    case 'SNAPSHOT_EXPIRED':
      return 'not_found'
    case 'INVALID_REQUEST':
    case 'OUTPUT_LIMIT':
    case 'UNSUPPORTED_ELEMENT':
      return 'invalid_input'
    case 'PAGE_NOT_READY':
    case 'BROWSER_UNAVAILABLE':
    case 'BROWSER_USER_TAKEOVER':
      return 'precondition_failed'
    case 'WAIT_TIMEOUT':
      return 'timeout'
    case 'OPERATION_ABORTED':
      return 'aborted'
    default:
      return 'execution_failed'
  }
}

function snapshotResult(operation: string, snapshot: BrowserSnapshot): ToolResult {
  const more = snapshot.cursor === undefined ? '' : ' (more available)'
  return {
    ok: true,
    content: withConsoleErrors(snapshot.text, snapshot.consoleErrors),
    metadata: {
      display: {
        summary: `${operation === 'page.text.snapshot' ? 'Read' : 'Scanned'} ${snapshot.total}${more}`,
      },
    },
  }
}

/** A result's text, plus whatever the page said on its console since the last read. */
function withConsoleErrors(text: string, errors: readonly string[] | undefined): string {
  const block = renderConsoleErrors(errors ?? [])
  return block === '' ? text : `${text}\n\n${block}`
}

function tabResult(tab: BrowserTabState, summary: string): ToolResult {
  const content = tab.settle === undefined ? describeTab(tab) : `${describeTab(tab)}\n${tab.settle}`
  return { ok: true, content, metadata: { display: { summary } } }
}

/** Read-only is decided per step for a batch: every step has to be. */
function isReadOnlyInput(input: unknown): boolean {
  const { operation, steps } = (input ?? {}) as { operation?: unknown; steps?: unknown }
  if (operation === 'batch') return Array.isArray(steps) && steps.length > 0 && steps.every(isReadOnlyInput)
  return typeof operation === 'string' && READ_ONLY_OPERATIONS.has(operation)
}

function failureResult(error: unknown): ToolResult {
  const failure = hostFailure(error)
  if (!failure) {
    return {
      ok: false,
      content: `Browser operation failed: ${error instanceof Error ? error.message : String(error)}`,
      errorCode: 'execution_failed',
    }
  }
  return {
    ok: false,
    content: failure.retryable ? `${failure.message} (retryable)` : failure.message,
    errorCode: errorCodeFor(failure),
    errorDetails: { code: failure.code, retryable: failure.retryable },
  }
}

/** An action's evidence line, verbatim. It never carries what was typed. */
function actionResult(result: BrowserActionResult, summary: string): ToolResult {
  return { ok: true, content: result.text, metadata: { display: { summary } } }
}

export function createBrowserTool(host: BrowserHost): Tool {
  return {
    name: BROWSER_TOOL_NAME,
    description: DESCRIPTION,
    searchHint: 'browse web pages click read rendered page logged in',
    inputSchema: browserInputSchema,
    apiInputSchema: browserApiInputSchema,
    validateInput: validateBrowserInput,
    // Not `safe`, for `WebFetch`'s reason and one more: a navigation carries the
    // user's real cookies to whatever host the model picked.
    riskLevel: 'confirm',
    shouldDefer: true,
    maxResultSizeChars: 32_000,
    isConcurrencySafeInput: isReadOnlyInput,
    classifyRisk: (input, context) => {
      const base: RiskTier = isReadOnlyInput(input) ? 'readonly' : 'normal'
      const files = localPathsIn(input)
      if (files.length === 0) return base
      let tier: RiskTier = base
      for (const raw of files) {
        const absolute = path.resolve(context.cwd, raw)
        // A page on disk is the one read that can be pointed anywhere, and the
        // page's own scripts read whatever the server serves: outside the
        // workspace that is the user's call, every time. `realPath` because the
        // workspace roots already are, and a symlinked cwd must still count.
        if (!context.workspaceRoots.some((root) => isSameOrInside(root, realPath(absolute)))) tier = maxTier(tier, 'risky')
        for (const reason of classifyPath({ raw, abs: absolute }, 'read', context)) tier = maxTier(tier, reason.level)
      }
      return tier
    },
    userFacingName: () => 'Browser',
    getToolUseSummary(input) {
      const parsed = asInput(input)
      if (!parsed) return null
      const local = localPathOf(parsed)
      if (local !== undefined) return path.basename(local)
      if (parsed.operation === 'tab.navigate' || (parsed.operation === 'browser.create_tab' && parsed.url)) {
        return hostOf(parsed.url as string)
      }
      if (parsed.operation === 'batch') return `${parsed.steps.length} steps`
      return parsed.operation
    },
    getActivityDescription(input) {
      const parsed = asInput(input)
      if (!parsed) return 'Using the browser'
      switch (parsed.operation) {
        case 'tab.navigate':
          return `Opening ${localPathOf(parsed) === undefined ? hostOf(parsed.url as string) : path.basename(localPathOf(parsed) as string)}`
        case 'browser.create_tab':
          if (localPathOf(parsed) !== undefined) return 'Opening a local page'
          return parsed.url === undefined ? 'Opening a browser tab' : `Opening ${hostOf(parsed.url)}`
        case 'page.screenshot':
          return 'Taking a screenshot'
        case 'tab.go_back':
          return 'Going back'
        case 'tab.go_forward':
          return 'Going forward'
        case 'tab.reload':
          return 'Reloading the page'
        case 'tab.wait_for_load':
          return 'Waiting for the page to load'
        case 'tab.emulate':
          return parsed.reset === true ? 'Clearing device emulation' : 'Emulating a device'
        case 'page.click':
        case 'page.click_at':
          return 'Clicking the page'
        case 'page.type':
          return 'Typing into the page'
        case 'page.press_key':
          return 'Pressing keys'
        case 'page.select_option':
          return 'Choosing an option'
        case 'page.set_checked':
          return parsed.checked ? 'Checking a box' : 'Unchecking a box'
        case 'page.hover':
          return 'Hovering over the page'
        case 'page.scroll':
          return 'Scrolling the page'
        case 'page.wait_for':
          return 'Waiting for the page'
        case 'batch':
          return `Running ${parsed.steps.length} browser steps`
        default:
          return 'Reading the page'
      }
    },
    shouldDisplayResult: () => true,
    async execute(rawInput, context) {
      // Validation first, and not only as a schema check: the cross-field rules
      // ("a ref or a selector") live there, and `execute` is reachable without
      // the runner's own `validateInput` pass.
      const validation = validateBrowserInput(rawInput)
      if (!validation.ok) {
        return {
          ok: false,
          content: validation.errors.map((error) => error.message).join('\n'),
          errorCode: 'invalid_input',
        }
      }
      const parsed = browserInputSchema.safeParse(rawInput)
      if (!parsed.success) {
        return {
          ok: false,
          content: parsed.error.issues.map((issue) => issue.message).join('\n'),
          errorCode: 'invalid_input',
        }
      }

      const input = parsed.data
      if (input.operation === 'batch') return runBatch(host, input, context)
      try {
        return await run(host, input, context)
      } catch (error) {
        return failureResult(error)
      }
    },
  }
}

function asInput(input: unknown): BrowserInput | undefined {
  const parsed = browserInputSchema.safeParse(input)
  return parsed.success ? parsed.data : undefined
}

type BatchInput = Extract<BrowserInput, { operation: 'batch' }>
type StepInput = Exclude<BrowserInput, BatchInput>

/**
 * The steps in order, stopping at the first that fails — the steps after it
 * were written for a page that step was meant to produce.
 *
 * The answer is every step's own answer, numbered, so a batch reads the same
 * as the calls it replaces; the failure and what was skipped close it. Images
 * from the steps that ran are kept either way.
 */
async function runBatch(host: BrowserHost, batch: BatchInput, context: ToolContext): Promise<ToolResult> {
  const total = batch.steps.length
  const lines: string[] = []
  const images: NonNullable<ToolResult['images']> = []
  // A step with no tabId means the tab the batch names, or the latest it opened.
  let current = batch.tabId
  for (const [index, raw] of batch.steps.entries()) {
    const label = `[${index + 1}/${total}]`
    const operation = String(raw['operation'])
    const skipped = total - index - 1
    const stop = (result: ToolResult): ToolResult => {
      lines.push(`${label} ${operation} failed: ${result.content}`)
      if (skipped > 0) lines.push(`Stopped; the remaining ${skipped} step${skipped === 1 ? ' was' : 's were'} not run.`)
      return {
        ...result,
        content: lines.join('\n'),
        ...(images.length > 0 ? { images } : {}),
        metadata: { display: { summary: `Failed at step ${index + 1} of ${total}` } },
      }
    }
    if (context.abortSignal?.aborted === true) {
      return stop({ ok: false, content: 'The batch was cancelled.', errorCode: 'aborted' })
    }
    const filled = raw['tabId'] === undefined && OPERATIONS_NEEDING_TAB.has(operation) ? { ...raw, tabId: current } : raw
    const step = browserInputSchema.safeParse(filled)
    if (!step.success || step.data.operation === 'batch') {
      return stop({ ok: false, content: 'The step is not valid Browser input.', errorCode: 'invalid_input' })
    }
    let result: ToolResult
    try {
      if (step.data.operation === 'browser.create_tab') {
        const local = step.data.path === undefined ? undefined : localPage(step.data.path, context)
        const tab = local === undefined
          ? await host.createTab(callerOf(context), step.data.url)
          : await host.openLocal(callerOf(context), local)
        current = tab.tabId
        result = tabResult(tab, local === undefined ? 'Opened a tab' : `Opened ${fileLabel(local.path, context)}`)
      } else {
        result = await run(host, step.data, context, images.length + 1)
      }
    } catch (error) {
      result = failureResult(error)
    }
    if (!result.ok) return stop(result)
    images.push(...(result.images ?? []))
    lines.push(`${label} ${operation}: ${result.content}`)
  }
  return {
    ok: true,
    content: lines.join('\n'),
    ...(images.length > 0 ? { images } : {}),
    metadata: { display: { summary: `Ran ${total} steps` } },
  }
}

/**
 * Session *and* turn: the host blocks a session that the user took the browser
 * from, and only a new turn lifts that, so the turn has to travel with the call.
 */
function callerOf(context: ToolContext): BrowserCaller {
  return {
    sessionId: context.sessionId,
    ...(context.currentTurnId === undefined ? {} : { turnId: context.currentTurnId }),
  }
}

/** The `path` a create-tab or navigate call names; `undefined` for the url form. */
function localPathOf(input: BrowserInput): string | undefined {
  if (input.operation !== 'browser.create_tab' && input.operation !== 'tab.navigate') return undefined
  return input.path
}

/** Every local page a call opens, including the steps of a batch. */
function localPathsIn(input: unknown): string[] {
  const { operation, steps, path: file } = (input ?? {}) as { operation?: unknown; steps?: unknown; path?: unknown }
  if (operation === 'batch' && Array.isArray(steps)) return steps.flatMap((step) => localPathsIn(step))
  const navigates = operation === 'browser.create_tab' || operation === 'tab.navigate'
  return navigates && typeof file === 'string' && file !== '' ? [file] : []
}

/**
 * The absolute path a call names, and the directory its page may read: the
 * workspace when the page is inside it, otherwise the page's own directory.
 */
function localPage(file: string, context: ToolContext): { path: string; root: string } {
  const absolute = path.resolve(context.cwd, file)
  const inside = isSameOrInside(realPath(context.cwd), realPath(absolute))
  return { path: absolute, root: inside ? context.cwd : path.dirname(absolute) }
}

/** A path as the transcript should read it: relative while it is inside the workspace. */
function fileLabel(file: string, context: ToolContext): string {
  const relative = path.relative(context.cwd, file)
  return relative === '' || relative.startsWith('..') ? file : relative
}

/** `imageIndex` numbers a screenshot's caption among the images of one result. */
async function run(host: BrowserHost, input: StepInput, context: ToolContext, imageIndex = 1): Promise<ToolResult> {
  const session = callerOf(context)
  switch (input.operation) {
    case 'browser.get_state': {
      const tabs = await host.listTabs(session)
      return { ok: true, content: renderTabs(tabs), metadata: { display: { summary: summarizeTabs(tabs) } } }
    }
    case 'browser.create_tab': {
      if (input.path !== undefined) {
        const page = localPage(input.path, context)
        const tab = await host.openLocal(session, page)
        return tabResult(tab, `Opened ${fileLabel(page.path, context)}`)
      }
      const tab = await host.createTab(session, input.url)
      return tabResult(tab, input.url === undefined ? 'Opened a tab' : `Opened ${hostOf(input.url)}`)
    }
    case 'browser.close_tab': {
      await host.closeTab(session, input.tabId)
      return { ok: true, content: `Closed tab ${input.tabId}.`, metadata: { display: { summary: 'Closed the tab' } } }
    }
    case 'tab.navigate': {
      if (input.path !== undefined) {
        const page = localPage(input.path, context)
        const tab = await host.openLocal(session, { ...page, tabId: input.tabId })
        return tabResult(tab, `Opening ${fileLabel(page.path, context)}`)
      }
      const tab = await host.navigate(session, input.tabId, input.url as string)
      return tabResult(tab, `Navigating to ${hostOf(input.url as string)}`)
    }
    case 'tab.go_back':
    case 'tab.go_forward':
    case 'tab.reload': {
      const action = HISTORY_ACTIONS[input.operation]
      const tab = await host.history(session, input.tabId, action.action)
      return tabResult(tab, action.summary)
    }
    case 'tab.wait_for_load': {
      const options: { timeoutMs: number; until?: BrowserLoadState; signal?: AbortSignal } = {
        timeoutMs: input.timeoutMs ?? WAIT_FOR_LOAD_DEFAULT_MS,
      }
      if (input.until !== undefined) options.until = input.until
      if (context.abortSignal) options.signal = context.abortSignal
      const tab = await host.waitForLoad(session, input.tabId, options)
      const loaded = input.until === 'domcontentloaded' && tab.loading ? 'DOM ready' : 'Page loaded'
      return tabResult(tab, tab.error === undefined ? loaded : 'Load failed')
    }
    case 'tab.emulate': {
      const result = await host.emulate(session, input.tabId, action({
        preset: input.preset,
        width: input.width,
        height: input.height,
        deviceScaleFactor: input.deviceScaleFactor,
        mobile: input.mobile,
        userAgent: input.userAgent,
        reset: input.reset,
      }, context))
      return actionResult(result, input.reset === true ? 'Cleared emulation' : `Emulating ${input.preset ?? `${input.width}x${input.height}`}`)
    }
    case 'page.elements.snapshot': {
      const snapshot = input.cursor === undefined
        ? await host.elements(session, input.tabId, stripUndefined({
          scope: input.scope,
          role: input.role,
          text: input.text,
          interactiveOnly: input.interactiveOnly,
          visibleOnly: input.visibleOnly,
          includeBounds: input.includeBounds,
          limit: input.limit,
          maxChars: input.maxChars,
        }))
        : await host.readSnapshot(session, input.tabId, input.cursor, input.maxChars)
      return snapshotResult(input.operation, snapshot)
    }
    case 'page.text.snapshot': {
      const snapshot = input.cursor === undefined
        ? await host.text(session, input.tabId, stripUndefined({
          scope: input.scope,
          visibleOnly: input.visibleOnly,
          limit: input.limit,
          maxChars: input.maxChars,
        }))
        : await host.readSnapshot(session, input.tabId, input.cursor, input.maxChars)
      return snapshotResult(input.operation, snapshot)
    }
    case 'page.screenshot':
      return screenshot(host, session, input.tabId, context, input.settle !== false, imageIndex)
    case 'page.click': {
      const result = await host.click(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        button: input.button,
        clickCount: input.clickCount,
      }, context))
      return actionResult(result, 'Clicked')
    }
    case 'page.click_at': {
      const result = await host.clickAt(session, input.tabId, action({
        x: input.x,
        y: input.y,
        button: input.button,
        clickCount: input.clickCount,
      }, context))
      return actionResult(result, 'Clicked a point')
    }
    case 'page.type': {
      const result = await host.type(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        text: input.text,
        clear: input.clear,
        submit: input.submit,
      }, context))
      return actionResult(result, 'Typed')
    }
    case 'page.press_key': {
      const result = await host.pressKey(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        keys: input.keys,
      }, context))
      return actionResult(result, 'Pressed keys')
    }
    case 'page.select_option': {
      const result = await host.selectOption(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        value: input.value,
        label: input.label,
        index: input.index,
      }, context))
      return actionResult(result, 'Selected an option')
    }
    case 'page.set_checked': {
      const result = await host.setChecked(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        checked: input.checked,
      }, context))
      return actionResult(result, input.checked ? 'Checked' : 'Unchecked')
    }
    case 'page.hover': {
      const result = await host.hover(session, input.tabId, action({ ref: input.ref, selector: input.selector }, context))
      return actionResult(result, 'Hovered')
    }
    case 'page.scroll': {
      const result = await host.scroll(session, input.tabId, action({
        ref: input.ref,
        selector: input.selector,
        direction: input.direction,
        amount: input.amount,
      }, context))
      return actionResult(result, 'Scrolled')
    }
    case 'page.wait_for': {
      const result = await host.waitFor(session, input.tabId, action({
        selector: input.selector,
        text: input.text,
        state: input.state,
        stableForMs: input.stableForMs,
        url: input.url,
        urlMatch: input.urlMatch,
        timeoutMs: input.timeoutMs ?? WAIT_FOR_DEFAULT_MS,
      }, context))
      return actionResult(result, 'Waited for the page')
    }
  }
}

const HISTORY_ACTIONS = {
  'tab.go_back': { action: 'back', summary: 'Went back' },
  'tab.go_forward': { action: 'forward', summary: 'Went forward' },
  'tab.reload': { action: 'reload', summary: 'Reloading' },
} as const

/** A request with its absent fields dropped and the turn's abort signal added. */
function action<T extends object>(value: T, context: ToolContext): T & { signal?: AbortSignal } {
  const request = stripUndefined(value) as T & { signal?: AbortSignal }
  if (context.abortSignal) request.signal = context.abortSignal
  return request
}

/**
 * The capability checks first, in `Read`'s order and for its reason: the most
 * useful error is the one that changes the model's strategy, and image bytes
 * never come back as text no matter what went wrong.
 */
async function screenshot(
  host: BrowserHost,
  caller: BrowserCaller,
  tabId: string,
  context: ToolContext,
  settle: boolean,
  imageIndex: number,
): Promise<ToolResult> {
  if (context.getSupportsImageInput?.() !== true) {
    return {
      ok: false,
      content:
        'Cannot take a screenshot: the current model does not accept image input. Use page.text.snapshot or page.elements.snapshot instead, or switch to an image-capable model.',
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'model-not-capable' },
    }
  }
  const store = context.imageAttachments
  if (!store) {
    return {
      ok: false,
      content: 'Cannot take a screenshot: no attachment store is available in this context.',
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'attachment-store-unavailable' },
    }
  }

  const shot = await host.screenshot(caller, tabId, action({ settle }, context))
  const imported = await store.importImage(context.sessionId, shot.bytes, shot.name)
  if (!imported.ok) {
    return {
      ok: false,
      content: `Cannot attach the screenshot: ${imported.message}`,
      errorCode: imported.reason === 'store-write-failed' ? 'execution_failed' : 'invalid_input',
      errorDetails: { reason: imported.reason },
    }
  }

  const { ref, metadata } = imported.value
  const caption = formatImageCaption(
    {
      name: ref.name,
      animated: false,
      orientedOriginalWidth: metadata.originalWidth,
      orientedOriginalHeight: metadata.originalHeight,
      width: ref.width,
      height: ref.height,
      scaleX: metadata.originalWidth / ref.width,
      scaleY: metadata.originalHeight / ref.height,
    },
    { index: imageIndex, localPath: metadata.localPath },
  )

  return {
    ok: true,
    content: [
      `Screenshot of the visible area of tab ${tabId}.`,
      ...(shot.settle === undefined ? [] : [shot.settle]),
      caption,
      ...coordinateLines(shot, ref.width),
      'The picture is attached as pixels; no text was extracted from it.',
      ...(shot.consoleErrors === undefined ? [] : ['', renderConsoleErrors(shot.consoleErrors)]),
    ].join('\n'),
    images: [ref],
    metadata: { display: { summary: `Screenshot ${shot.width}x${shot.height}` } },
  }
}

/**
 * How the picture maps onto the page, for `page.click_at`.
 *
 * Two scales stack: the capture's own (device pixels per CSS pixel, 2 on a
 * HiDPI screen) and the attachment store's downscale. The model only ever sees
 * the attached picture, so the factor it needs is the product, stated once.
 */
export function coordinateLines(
  shot: { width: number; cssWidth?: number; cssHeight?: number },
  attachedWidth: number,
): string[] {
  if (shot.cssWidth === undefined || shot.cssHeight === undefined || attachedWidth <= 0) return []
  const scale = shot.width / shot.cssWidth
  const factor = shot.cssWidth / attachedWidth
  return [
    `Viewport: cssWidth=${shot.cssWidth} cssHeight=${shot.cssHeight}; scale=${round(scale)} (captured pixels per CSS pixel).`,
    `For page.click_at, multiply a point in the attached picture by ${round(factor)} to get CSS pixels.`,
  ]
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000
}

/** Optional fields the host must see as absent, not as `undefined` keys. */
function stripUndefined<T extends object>(value: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item
  }
  return out as T
}

export { BROWSER_TOOL_NAME }
