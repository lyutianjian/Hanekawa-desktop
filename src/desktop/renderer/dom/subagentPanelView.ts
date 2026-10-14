/**
 * The side panel's 「子代理」 tab: the session's sub-agents as a list, and one of
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
import { markdownChildren } from './markdownView.js'
import { createTranscriptView, type TranscriptView } from './transcriptView.js'
import type { SessionRecord } from '../../../harness/types.js'
import type { SubagentEntry } from '../model/subagentPanel.js'
import { createTranscriptState, formatWorkedDuration, toolStatusLabel, type TranscriptState } from '../model/transcript.js'

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
  /** Stops the run started by this `Agent` call; the parent's turn goes on. */
  onStop(id: string): void
  /** A failure with no place of its own in the page (a copy that did not happen). */
  onError?(message: string): void
}

export interface SubagentPanelView {
  render(model: SubagentPanelModel): void
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
  let page: { id: string; agentId: string | undefined; view: TranscriptView } | undefined
  let state: TranscriptState | undefined
  let recordsSeen: string | undefined
  /** The user's folds; every turn is open until they say otherwise. */
  let manual = new Map<string, boolean>()
  let pollTimer: ReturnType<typeof setInterval> | undefined

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

  function meta(entry: SubagentEntry, withStatus: boolean): HTMLElement {
    const parts = [
      withStatus ? toolStatusLabel(entry.status) : undefined,
      entry.model,
      entry.toolCount === undefined ? undefined : `${entry.toolCount} 工具`,
    ].filter((part) => part !== undefined && part.length > 0)
    return el('div', 'subagent-meta', parts.join(' · '), duration(entry))
  }

  function heading(entry: SubagentEntry): Child[] {
    const bead = el('span', `step-bead ${entry.status}`)
    bead.setAttribute('aria-hidden', 'true')
    return [
      bead,
      el('span', 'subagent-name', entry.name),
      entry.agentType === undefined ? undefined : el('span', 'step-tag', entry.agentType),
    ]
  }

  function liveLine(entry: SubagentEntry): HTMLElement | undefined {
    if (entry.live === undefined) return undefined
    return el(
      'div',
      'step-live',
      el('span', 'step-live-arrow', '↳'),
      el('span', 'step-name', entry.live.tool),
      entry.live.summary.length > 0 ? el('span', 'step-summary', entry.live.summary) : undefined,
    )
  }

  function row(entry: SubagentEntry): HTMLElement {
    const node = button('subagent-row', '', `${entry.name} · ${entry.description} · ${toolStatusLabel(entry.status)}`, () => handlers.onSelect(entry.id))
    replace(
      node,
      el('div', 'subagent-title', ...heading(entry)),
      entry.description.length > 0 ? el('div', 'subagent-desc', entry.description) : undefined,
      meta(entry, false),
      liveLine(entry),
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
    page.view.render(state, disclosure)
  }

  function fetchRecords(): void {
    const current = page
    if (current?.agentId === undefined) return
    const agentId = current.agentId
    void handlers.loadTranscript(agentId).then((records) => {
      if (page !== current || records.length === 0) return
      const seen = `${records.length}:${records.at(-1)?.id}`
      if (seen === recordsSeen) return
      recordsSeen = seen
      state = createTranscriptState(records)
      show(timeline, true)
      show(fallback, false)
      paintTimeline()
    }).catch(() => {})
  }

  function closePage(): void {
    page?.view.dispose()
    page = undefined
    state = undefined
    recordsSeen = undefined
    manual = new Map()
    if (pollTimer !== undefined) clearInterval(pollTimer)
    pollTimer = undefined
  }

  function openPage(entry: SubagentEntry): void {
    closePage()
    replace(timeline)
    replace(floatHost)
    show(timeline, false)
    show(fallback, true)
    page = {
      id: entry.id,
      agentId: entry.agentId,
      view: createTranscriptView(timeline, floatHost, {
        onToggle: (id, expanded) => {
          manual.set(id, !expanded)
          paintTimeline()
        },
        onTaskStep: () => {},
        onOpenPlan: () => {},
        onOpenPath: handlers.onOpenPath,
        onViewImage: () => {},
        imageThumbUrl: () => undefined,
        onCopy: (text) => {
          void copyText(text).then((ok) => { if (!ok) handlers.onError?.('复制失败：无法写入剪贴板。') })
        },
        onOpenSubagent: () => {},
      }),
    }
    replace(container, pageHead, timeline, fallback, floatHost)
    container.scrollTop = 0
  }

  function renderDetail(entry: SubagentEntry): void {
    if (page?.id !== entry.id) openPage(entry)
    else if (page.agentId === undefined && entry.agentId !== undefined) page.agentId = entry.agentId
    replace(
      pageHead,
      el(
        'div',
        'subagent-page-bar',
        button('subagent-back', '← 全部子代理', '返回子代理列表', () => handlers.onSelect(undefined)),
        entry.finished ? undefined : button('subagent-stop', '停止', '停止这个子代理，父代理继续', () => handlers.onStop(entry.id)),
      ),
      el('div', 'subagent-title', ...heading(entry)),
      entry.description.length > 0 ? el('div', 'subagent-desc', entry.description) : undefined,
      meta(entry, true),
      liveLine(entry),
      entry.notes.length === 0 ? undefined : el('div', 'subagent-notes', entry.notes.join(' · ')),
    )
    replace(fallback, ...fallbackBody(entry))
    // Once more on every change the parent saw — the last one is the run ending —
    // and once a second until then.
    fetchRecords()
    if (!entry.finished) pollTimer ??= setInterval(fetchRecords, POLL_MS)
    else if (pollTimer !== undefined) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
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
    if (clocks.length > 0) clockTimer ??= setInterval(tick, 1000)
    else if (clockTimer !== undefined) {
      clearInterval(clockTimer)
      clockTimer = undefined
    }
  }

  return { render }
}
