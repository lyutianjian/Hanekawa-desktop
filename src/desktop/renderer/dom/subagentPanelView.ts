/**
 * The task panel's sub-agents as a list, and one of
 * them as a page — its own conversation, read from the run's transcript file.
 *
 * Rebuilt only when what it shows changed: the pane repaints on every stream
 * delta, and a page rebuilt under the reader would drop their selection. A
 * running agent's clock ticks in place, and its transcript is re-read once a
 * second into the same timeline, which keeps its own nodes across reads.
 */

import { button } from './controls.js'
import { copyText } from './clipboard.js'
import { el, replace, show, type Child } from './dom.js'
import { icon } from './icons.js'
import { markdownChildren } from './markdownView.js'
import { TONE_ICON } from './threadPanelView.js'
import { createTranscriptView, isScrolledToBottom, type TranscriptView } from './transcriptView.js'
import type { SessionRecord } from '../../../harness/types.js'
import { subagentTone, type SubagentEntry } from '../model/subagentPanel.js'
import { createTranscriptState, formatWorkedDuration, toolStatusLabel, type TranscriptState } from '../model/transcript.js'
import { modelName } from '../model/modelNames.js'
import { replayActivity } from '../model/waiting.js'
import { formatTokens } from '../model/usage.js'

export interface SubagentPanelModel {
  readonly entries: readonly SubagentEntry[]
  /** The run on its own page; `undefined` (or a run no longer listed) is the list. */
  readonly selected: string | undefined
}

export interface SubagentPanelHandlers {
  onSelect(id: string | undefined): void
  /** The run's records so far; empty when it never wrote a transcript. */
  loadTranscript(agentId: string): Promise<readonly SessionRecord[]>
  onOpenPath(path: string, line: number | undefined): void
  /** A failure with no place of its own in the page (a copy that did not happen). */
  onError?(message: string): void
}

export interface SubagentPanelView {
  render(model: SubagentPanelModel): void
  /**
   * Whether the panel is on screen.
   *
   * `render` is only called while it is, which used to be the whole story: the
   * page it had built kept its own `setInterval` and went on re-reading the
   * run's transcript every second, for as long as the user stayed anywhere else
   * in the app — and kept ticking clocks nobody could see. The panel cannot tell
   * a hidden body from an unchanged one, so the screen state that knows
   * (`renderSubagents`) says so: hiding stops both timers and invalidates what
   * is in flight, showing refreshes once and restarts exactly one of each.
   */
  setVisible(visible: boolean): void
}

const POLL_MS = 1000

export function createSubagentPanelView(container: HTMLElement, handlers: SubagentPanelHandlers): SubagentPanelView {
  let drawn: string | undefined
  let clocks: Array<{ node: HTMLElement; startedAt: number }> = []
  let clockTimer: ReturnType<typeof setInterval> | undefined

  // --- the detail page, kept while one run is on screen ---------------------------
  const pageHead = el('div', 'subagent-page-head')
  const timeline = el('div', 'transcript subagent-transcript')
  const floatHost = el('div', 'subagent-float')
  const fallback = el('div', 'subagent-fallback')
  const failure = el('div', 'load-error')
  failure.setAttribute('role', 'alert')
  show(failure, false)
  const pageBody = el('div', 'subagent-page-body', failure, fallback, timeline, floatHost)
  let failureShown: string | undefined
  let page: { id: string; agentId: string | undefined; finished: boolean; startedAt: number | undefined; view: TranscriptView } | undefined
  let state: TranscriptState | undefined
  let recordsSeen: string | undefined
  /** The user's folds; every turn is open until they say otherwise. */
  let manual = new Map<string, boolean>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let visible = false
  /** Whether the run on the page is still live, so the page wants its poll. */
  let polling = false
  /**
   * Bumped whenever what is on screen stops being what was asked for: a hide, or
   * a page closing. A read carries the value it started under, so one that lands
   * after its page left the screen is dropped instead of painting over the page
   * that replaced it.
   */
  let epoch = 0
  /** The epoch whose read is still on the wire; one read at a time. */
  let inFlight: number | undefined

  function tick(): void {
    for (const clock of clocks) clock.node.textContent = formatWorkedDuration(Date.now() - clock.startedAt)
  }

  /** The run's time: fixed once it has one, counting while it runs. */
  function duration(entry: SubagentEntry): HTMLElement | undefined {
    if (entry.durationMs !== undefined) return el('span', 'subagent-time', formatWorkedDuration(entry.durationMs))
    if (entry.status !== 'running' || entry.startedAt === undefined) return undefined
    const node = el('span', 'subagent-time')
    clocks.push({ node, startedAt: entry.startedAt })
    return node
  }

  /** The list shows token usage; the detail shows status, model and elapsed time. */
  function meta(entry: SubagentEntry, detail: boolean): HTMLElement {
    const facts = [
      detail ? toolStatusLabel(entry.status) : undefined,
      entry.model === undefined ? undefined : modelName(entry.model),
      !detail && entry.tokens !== undefined ? `${formatTokens(entry.tokens)} token` : undefined,
    ].filter((part) => part !== undefined && part.length > 0)
    const time = detail ? duration(entry) : undefined
    const lead = facts.length === 0 ? undefined : time === undefined ? facts.join(' · ') : `${facts.join(' · ')} · `
    return el('div', 'subagent-meta', lead, time)
  }

  /**
   * The row's leading mark: the thread list's, glyph for glyph. A running run
   * turns the same spinner the status line does, so 「still going」 is one shape
   * everywhere — the breathing dot it replaces said nothing the words did not.
   */
  function mark(entry: SubagentEntry): HTMLElement {
    const tone = subagentTone(entry.status)
    const node = el('span', `subagent-mark tone-${tone}`, icon(TONE_ICON[tone]))
    node.setAttribute('aria-hidden', 'true')
    return node
  }

  function heading(entry: SubagentEntry): Child[] {
    return [
      mark(entry),
      el('span', 'subagent-name', entry.description),
    ]
  }

  function row(entry: SubagentEntry): HTMLElement {
    const node = button('subagent-row', '', `${entry.description} · ${toolStatusLabel(entry.status)}`, () => handlers.onSelect(entry.id))
    replace(
      node,
      el('div', 'subagent-title', ...heading(entry)),
      meta(entry, false),
    )
    return node
  }

  function section(label: string, ...body: Child[]): HTMLElement {
    return el('section', 'subagent-section', el('div', 'subagent-label', label), ...body)
  }

  /** Task and reply from the parent's own records: a run whose transcript is not (yet) readable. */
  function fallbackBody(entry: SubagentEntry): Child[] {
    const running = entry.status === 'running' || entry.status === 'awaiting-approval'
    return [
      entry.task === undefined ? undefined : section('任务', el('div', 'md', ...markdownChildren(entry.task))),
      entry.reply !== undefined
        ? section('回复', el('div', 'md', ...markdownChildren(entry.reply)))
        : running ? el('p', 'subagent-empty', '运行中，完成后在这里显示回复') : undefined,
    ]
  }

  // --- the timeline -------------------------------------------------------------------

  function paintTimeline(): void {
    if (page === undefined || state === undefined) return
    // A run's turns stay open here: the page exists to show what it did.
    const disclosure = new Map(manual)
    for (const item of state.items) {
      if (item.turnId !== undefined && !disclosure.has(item.turnId)) disclosure.set(item.turnId, true)
    }
    // The page shows one turn, still open while the run is: `replayActivity` is what
    // gives the turn its footer — time, model, copy, once, at the end — and, while
    // it runs, the status line a thread's page draws instead of a finished footer.
    page.view.render(state, disclosure, { ...replayActivity(state, !page.finished, page.startedAt), statusAtEnd: true })
    page.view.syncMotion(!visible)
  }

  function fetchRecords(): void {
    const current = page
    if (current?.agentId === undefined) return
    // One read at a time: a clock tick during a slow read is dropped rather than
    // queued behind it — the next tick asks again, and a failed read is retried
    // by the poll or by the 重试 it just drew.
    if (inFlight === epoch) return
    const agentId = current.agentId
    const at = epoch
    inFlight = at
    const settleRead = (): void => {
      if (inFlight === at) inFlight = undefined
    }
    void handlers.loadTranscript(agentId).then((records) => {
      settleRead()
      if (at !== epoch || page !== current) return
      showFailure(undefined)
      if (records.length === 0) return
      const seen = `${records.length}:${records.at(-1)?.id}`
      if (seen === recordsSeen) return
      recordsSeen = seen
      state = createTranscriptState(records)
      show(timeline, true)
      show(fallback, false)
      const following = isScrolledToBottom(pageBody)
      paintTimeline()
      if (following) pageBody.scrollTop = pageBody.scrollHeight
    }, (error: unknown) => {
      settleRead()
      // A failure for a page that is no longer up is not news: it would put an
      // error under whatever the user is looking at now.
      if (at !== epoch || page !== current) return
      showFailure(error instanceof Error ? error.message : String(error))
    })
  }

  /**
   * The timers this panel runs, and nothing else: the poll while a live run is on
   * a page the user can see, and the clocks of every running run. One of each,
   * and only while visible — `??=` is what keeps a redraw of an unchanged page
   * from stacking a second interval on the first.
   */
  function syncTimers(): void {
    if (visible && polling) pollTimer ??= setInterval(fetchRecords, POLL_MS)
    else if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    if (visible && clocks.length > 0) clockTimer ??= setInterval(tick, 1000)
    else if (clockTimer !== undefined) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }

  // The poll retries on its own while the run is live; 重试 is for one that has
  // ended, whose page would otherwise sit on the fallback with no word why.
  function showFailure(message: string | undefined): void {
    if (message === failureShown) return
    failureShown = message
    show(failure, message !== undefined)
    if (message === undefined) replace(failure)
    else replace(failure, el('span', 'load-error-text', `无法读取子代理对话：${message}`), button('load-retry', '重试', '重新读取子代理对话', fetchRecords))
  }

  function closePage(): void {
    epoch += 1
    page?.view.dispose()
    page = undefined
    state = undefined
    recordsSeen = undefined
    showFailure(undefined)
    manual = new Map()
    polling = false
    syncTimers()
  }

  function openPage(entry: SubagentEntry): void {
    closePage()
    replace(timeline)
    replace(floatHost)
    show(timeline, true)
    show(fallback, true)
    state = createTranscriptState([])
    page = {
      id: entry.id,
      agentId: entry.agentId,
      finished: entry.finished,
      startedAt: entry.startedAt,
      view: createTranscriptView(timeline, floatHost, {
        onToggle: (id, expanded) => {
          manual.set(id, !expanded)
          paintTimeline()
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
    replace(container, pageHead, pageBody)
    pageBody.scrollTop = 0
  }

  function renderDetail(entry: SubagentEntry): void {
    if (page?.id !== entry.id) openPage(entry)
    else if (page.agentId === undefined && entry.agentId !== undefined) page.agentId = entry.agentId
    // The run ending is the one change the transcript cannot see: no record says
    // it, and the page was drawing a live turn a moment ago. Repaint before the
    // read so the status line goes and the turn's footer takes its place.
    if (page !== undefined) {
      page.finished = entry.finished
      page.startedAt = entry.startedAt
    }
    replace(
      pageHead,
      el(
        'div',
        'subagent-page-bar',
        button('subagent-back', '全部任务', '返回任务列表', () => handlers.onSelect(undefined), { icon: 'arrow-left' }),
      ),
      el('div', 'subagent-title', ...heading(entry)),
      meta(entry, true),
      entry.notes.length === 0 ? undefined : el('div', 'subagent-notes', entry.notes.join(' · ')),
    )
    replace(fallback, ...fallbackBody(entry))
    paintTimeline()
    // Once more on every change the parent saw — the last one is the run ending —
    // then once a second while it runs and the page is on screen.
    polling = !entry.finished
    fetchRecords()
    syncTimers()
  }

  function render(model: SubagentPanelModel): void {
    const entry = model.selected === undefined ? undefined : model.entries.find((e) => e.id === model.selected)
    const signature = JSON.stringify(entry ?? model.entries)
    if (signature === drawn) return
    drawn = signature
    clocks = []
    if (entry !== undefined) renderDetail(entry)
    else {
      const wasPage = page !== undefined
      closePage()
      if (model.entries.length === 0) replace(container, el('p', 'subagent-empty', '当前会话还没有子代理'))
      else replace(container, ...model.entries.map(row))
      if (wasPage) container.scrollTop = 0
    }
    tick()
    syncTimers()
  }

  function setVisible(next: boolean): void {
    if (next === visible) return
    visible = next
    page?.view.syncMotion(!visible)
    if (!visible) {
      // Whatever is on the wire was asked for a page the user has just left.
      epoch += 1
      syncTimers()
      return
    }
    // Back on screen: the clocks read the time that passed while they were off,
    // and the transcript catches up in one read rather than one per hidden
    // second. `fetchRecords` drops it instead if the page changed meanwhile.
    tick()
    fetchRecords()
    syncTimers()
  }

  return { render, setVisible }
}
