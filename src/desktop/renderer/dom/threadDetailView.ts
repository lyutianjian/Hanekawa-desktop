/**
 * The side panel's page for one coordination thread: its conversation, read
 * from the session file and never written to. A running thread's file is
 * re-read on a timer; the host answers "unchanged" while it has not grown, so
 * the same timeline keeps its nodes across reads.
 */

import { button } from './controls.js'
import { icon } from './icons.js'
import { el, replace, show } from './dom.js'
import { createTranscriptView, isScrolledToBottom, type TranscriptView } from './transcriptView.js'
import type { WireShellThreadTranscriptResult } from '../../shellProtocol.js'
import type { ThreadPage } from '../model/threadDetail.js'
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
  // The head stays put; only the conversation under it scrolls.
  const body = el('div', 'thread-detail-body', timeline, empty, floatHost)
  let drawn: string | undefined
  let current: { threadId: string; view: TranscriptView; token: string | undefined; busy: boolean; again: boolean } | undefined
  let state: TranscriptState | undefined
  let manual = new Map<string, boolean>()
  let pollTimer: ReturnType<typeof setInterval> | undefined

  function paint(): void {
    if (current === undefined || state === undefined) return
    const disclosure = new Map(manual)
    for (const item of state.items) {
      if (item.turnId !== undefined && !disclosure.has(item.turnId)) disclosure.set(item.turnId, true)
    }
    current.view.render(state, disclosure)
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
      if (current !== page || result.unchanged) return
      page.token = result.token
      const displays: ToolDisplayLookup = (recordId) => result.toolDisplays?.[recordId]
      state = createTranscriptState(result.records, displays)
      show(timeline, result.records.length > 0)
      show(empty, result.records.length === 0)
      // A reader at the tail follows the thread; one who scrolled up keeps their place.
      const following = isScrolledToBottom(body)
      paint()
      if (following) body.scrollTop = body.scrollHeight
    }).catch(() => {}).finally(() => {
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
      view: createTranscriptView(timeline, floatHost, {
        onToggle: (id, expanded) => {
          manual.set(id, !expanded)
          paint()
        },
        onTaskStep: () => {},
        onOpenPlan: () => {},
        onOpenPath: handlers.onOpenPath,
        onViewImage: () => {},
        imageThumbUrl: () => undefined,
        onCopy: (text) => { void navigator.clipboard?.writeText(text).catch(() => {}) },
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
    replace(
      head,
      el(
        'div',
        'subagent-page-bar',
        button('subagent-back', '← 返回', '返回线程列表', handlers.onBack),
        el(
          'div',
          'thread-detail-actions',
          button('thread-row-open', '在主画布打开', '在主画布打开这个线程', () => handlers.onOpen(page.sessionId)),
          page.canStop
            ? button('thread-row-stop', '停止', '停止这个线程', () => handlers.onStop(page.threadId), { enabled: !page.stopPending })
            : undefined,
        ),
      ),
      el(
        'div',
        'subagent-title',
        el('span', 'subagent-name', page.title),
        el('span', `thread-status tone-${page.tone}`, page.tone === 'running' ? icon('spinner') : undefined, page.statusLabel),
      ),
      page.needsYou
        ? button('thread-detail-needs-you', '需要你处理 · 去处理', '在主画布处理这个线程的请求', () => handlers.onOpen(page.sessionId))
        : undefined,
    )
    // Once per change the push saw — the last one is the thread settling — and on the timer until then.
    fetchRecords()
    if (page.poll) pollTimer ??= setInterval(fetchRecords, POLL_MS)
    else stopPolling()
  }

  return { render }
}
