/**
 * The side panel's page for one coordination thread: its conversation, read
 * from the session file and never written to. A running thread's file is
 * re-read on a timer; the host answers "unchanged" while it has not grown, so
 * the same timeline keeps its nodes across reads.
 */

import { button } from './controls.js'
import { copyText } from './clipboard.js'
import { icon } from './icons.js'
import { el, replace, show } from './dom.js'
import { TONE_ICON } from './threadPanelView.js'
import { createTranscriptView, isScrolledToBottom, type TranscriptView } from './transcriptView.js'
import type { WireShellThreadTranscriptResult } from '../../shellProtocol.js'
import { describeError } from '../model/errorReport.js'
import { splitThreadBrief, threadActivity, type ThreadPage } from '../model/threadDetail.js'
import { createTranscriptState, type ToolDisplayLookup, type TranscriptState } from '../model/transcript.js'

type DetailPage = Extract<ThreadPage, { kind: 'detail' }>

export interface ThreadDetailHandlers {
  onBack(): void
  /** Opens the thread in the main canvas, where it can be answered. */
  onOpen(sessionId: string): void
  onStop(threadId: string): void
  /** `since` is the token of the last copy; the reply says whether the file moved on. */
  loadTranscript(threadId: string, since: string | undefined): Promise<WireShellThreadTranscriptResult>
  onOpenPath(path: string, line: number | undefined): void
  /** A failure with no place of its own in the page (a copy that did not happen). */
  onError?(message: string): void
}

export interface ThreadDetailView {
  /** `undefined` leaves the page: the timer stops and the transcript is dropped. */
  render(page: DetailPage | undefined): void
}

const POLL_MS = 1500

export function createThreadDetailView(container: HTMLElement, handlers: ThreadDetailHandlers): ThreadDetailView {
  const head = el('div', 'thread-detail-head')
  const timeline = el('div', 'transcript thread-detail-transcript')
  const empty = el('p', 'subagent-empty', '这个线程还没有对话')
  const floatHost = el('div', 'subagent-float')
  // Why the conversation could not be read, with a way to ask again. Without it
  // a failed first read leaves the page blank, which reads as an empty thread.
  const failure = el('div', 'thread-detail-error')
  failure.setAttribute('role', 'alert')
  show(failure, false)
  // The head stays put; only the conversation under it scrolls.
  const body = el('div', 'thread-detail-body', failure, timeline, empty, floatHost)
  let drawn: string | undefined
  let failureShown: string | undefined
  let current: {
    threadId: string
    view: TranscriptView
    token: string | undefined
    busy: boolean
    again: boolean
    running: boolean
    brief?: { text: string; node: HTMLElement }
  } | undefined
  let state: TranscriptState | undefined
  let manual = new Map<string, boolean>()
  let pollTimer: ReturnType<typeof setInterval> | undefined

  function paint(): void {
    if (current === undefined || state === undefined) return
    const disclosure = new Map(manual)
    for (const item of state.items) {
      if (item.turnId !== undefined && !disclosure.has(item.turnId)) disclosure.set(item.turnId, true)
    }
    const split = splitThreadBrief(state)
    if (split.brief === undefined) current.brief = undefined
    else if (current.brief?.text !== split.brief) current.brief = { text: split.brief, node: briefCard(split.brief) }
    current.view.render(split.state, disclosure, threadActivity(state, current.running), undefined, current.brief?.node)
  }

  function showFailure(message: string | undefined): void {
    // A poll that fails the same way again must not rebuild the button under the pointer.
    if (message === failureShown) return
    failureShown = message
    show(failure, message !== undefined)
    if (message === undefined) replace(failure)
    else replace(failure, el('span', 'thread-detail-error-text', `无法读取线程对话：${message}`), button('thread-detail-retry', '重试', '重新读取线程对话', fetchRecords))
  }

  function fetchRecords(): void {
    const page = current
    if (page === undefined) return
    if (page.busy) {
      page.again = true
      return
    }
    page.busy = true
    void handlers.loadTranscript(page.threadId, page.token).then((result) => {
      if (current !== page) return
      showFailure(undefined)
      if (result.unchanged) return
      page.token = result.token
      const displays: ToolDisplayLookup = (recordId) => result.toolDisplays?.[recordId]
      state = createTranscriptState(result.records, displays)
      show(timeline, result.records.length > 0)
      show(empty, result.records.length === 0)
      // A reader at the tail follows the thread; one who scrolled up keeps their place.
      const following = isScrolledToBottom(body)
      paint()
      if (following) body.scrollTop = body.scrollHeight
    }).catch((error: unknown) => {
      if (current === page) showFailure(describeError(error))
    }).finally(() => {
      page.busy = false
      if (page.again && current === page) {
        page.again = false
        fetchRecords()
      }
    })
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
  }

  function close(): void {
    stopPolling()
    current?.view.dispose()
    current = undefined
    state = undefined
    manual = new Map()
    drawn = undefined
    showFailure(undefined)
  }

  function open(threadId: string): void {
    close()
    replace(timeline)
    replace(floatHost)
    show(timeline, false)
    show(empty, false)
    current = {
      threadId,
      token: undefined,
      busy: false,
      again: false,
      running: false,
      view: createTranscriptView(timeline, floatHost, {
        onToggle: (id, expanded) => {
          manual.set(id, !expanded)
          paint()
        },
        onOpenPlan: () => {},
        onOpenPath: handlers.onOpenPath,
        onViewImage: () => {},
        imageThumbUrl: () => undefined,
        onCopy: (text) => copyText(text).then((ok) => {
          if (!ok) handlers.onError?.('复制失败：无法写入剪贴板。')
          return ok
        }),
        onOpenSubagent: () => {},
      }),
    }
    replace(container, head, body)
    body.scrollTop = 0
  }

  function render(page: DetailPage | undefined): void {
    if (page === undefined) {
      close()
      return
    }
    const signature = JSON.stringify(page)
    if (signature === drawn) return
    drawn = signature
    if (current?.threadId !== page.threadId) {
      open(page.threadId)
      drawn = signature
    }
    const mark = el('span', `thread-row-mark tone-${page.tone}`, icon(TONE_ICON[page.tone]))
    mark.title = page.statusLabel
    const name = el('span', 'thread-detail-name', page.title)
    name.title = page.title
    replace(
      head,
      el(
        'div',
        'thread-detail-bar',
        button('thread-detail-icon thread-detail-back', '', '返回线程列表', handlers.onBack, { icon: 'arrow-left' }),
        button('thread-detail-icon thread-detail-open', '', '在主画布打开', () => handlers.onOpen(page.sessionId), { icon: 'external' }),
        page.canStop
          ? button('thread-detail-icon thread-detail-stop', '', '停止这个线程', () => handlers.onStop(page.threadId), { icon: 'stop', enabled: !page.stopPending })
          : undefined,
      ),
      el('div', 'thread-detail-title', mark, name),
      page.needsYou
        ? button('thread-detail-needs-you', '需要你处理 · 去处理', '在主画布处理这个线程的请求', () => handlers.onOpen(page.sessionId))
        : undefined,
    )
    // The status line comes and goes with the thread's own state, which a read that finds the file unchanged would not repaint.
    if (current !== undefined && current.running !== page.poll) {
      current.running = page.poll
      paint()
    }
    // Once per change the push saw — the last one is the thread settling — and on the timer until then.
    fetchRecords()
    if (page.poll) pollTimer ??= setInterval(fetchRecords, POLL_MS)
    else stopPolling()
  }

  return { render }
}

/** The coordinator's brief: collapsed to its first line, opened to read in full. */
function briefCard(text: string): HTMLElement {
  return el(
    'details',
    'thread-brief',
    el('summary', 'thread-brief-head', el('span', 'thread-brief-label', '任务说明'), el('span', 'thread-brief-preview', text.split('\n', 1)[0]!)),
    el('div', 'thread-brief-text', text),
  )
}
