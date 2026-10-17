import { stripAnsi } from '../model/ansi.js'
import { parseUnifiedPatch, patchPath, type PatchRows } from '../model/diffRows.js'
import { parseSearchResults, searchStats, type SearchResults } from '../model/searchResults.js'
import {
  EDIT_TOOLS,
  failureLabel,
  isExpanded,
  runHasTools,
  summarizeRun,
  thoughtLabel,
  thoughtLiveLabel,
  type DisclosureState,
  type RunSummary,
} from '../model/thinking.js'
import {
  formatMessageTime,
  groupTranscript,
  isAgentCall,
  toStep,
  toolStatusLabel,
  type ActivityRun,
  type ActivityStep,
  type Receipt,
  type SubagentLive,
  type SubagentRun,
  type TranscriptEntry,
  type TranscriptItem,
  type TranscriptState,
} from '../model/transcript.js'
import { absoluteTime, footerFacts, relativeTime, splitTurnFooters, type TurnFooter } from '../model/turnFooter.js'
import { collectTurnEdits, type TurnEdits } from '../model/turnEdits.js'
import { anchorPadding, anchorTopGap, TRANSCRIPT_PAD_VARIABLE, viewportPolicy } from '../model/transcriptAnchor.js'
import { PRESENCE_FALLBACK_MS } from '../model/presence.js'
import { splitFileMentions } from '../model/userMessage.js'
import { splitAttachedPaths } from '../../../media/attachedPaths.js'
import { pathTileNode } from './pathTile.js'
import { AGENT_TOOL } from '../model/subagentPanel.js'
import type { ImageAttachmentRef } from '../../../media/types.js'
import type { ToolErrorCode } from '../../../harness/types.js'
import {
  rowLabel as statusLabel,
  settleLabel,
  statusMeta,
  turnActivity,
  type LabelGate,
  type WaitingInput,
  type WaitingRow,
} from '../model/waiting.js'
import { callParts } from '../model/toolPhrases.js'
import { THREAD_STATUS_LABEL, threadTone } from '../model/coordinationStatus.js'
import type { ThreadNoteCard } from '../model/threadNotes.js'
import type { TurnFailureCard } from '../model/turnFailure.js'
import type { WireThreadStatus } from '../../shellProtocol.js'
import { pausedTaskCard, TASK_LOCATE_FALLBACK_MS, type TaskCard, type TaskRowStatus } from '../model/tasks.js'
import { button } from './controls.js'
import { diffNode, diffStatNode, fileBadgeNode } from './diffView.js'
import { append, el, reconcile, show, type Child } from './dom.js'
import { icon, type IconName } from './icons.js'
import { markdownChildren } from './markdownView.js'
import { createPresence, finishPresenceWithin, type Presence } from './presence.js'
import { motionDelay, motionPolicy } from './motion.js'
import { createWorkingMark, type WorkingMark } from './workingMarkView.js'

/**
 * Paints the transcript: loose items interleaved with activity runs.
 *
 * A run is the work between two pieces of prose, folded to one summary line
 * (「已运行 2 个命令，读取 2 个文件」) that opens into a card with a row per step; a
 * row opens again into the tool's own output. While the turn runs, the last line
 * of the transcript is its live status. Every head is a `<button>` with
 * `aria-expanded`, and a folded body is **absent rather than `hidden`**: the
 * transcript is `aria-live="polite"`, so a hidden-but-present streaming block is
 * text a screen reader announces that nobody asked for.
 *
 * ## Nodes are reused by id
 *
 * Each entry and each step keeps its element across paints, keyed by id. An
 * unchanged item is left untouched (its markdown is not even re-parsed); a changed
 * one is refilled *in place*, so the node the browser's scroll anchor points at is
 * still there. Keeping the *element* is only half of it: it also has to stay
 * **attached** — a node that leaves the document has its CSS animations restarted
 * and stops being an anchor — so every insertion here goes through `reconcile`,
 * which touches only the children that moved.
 *
 * The jump-to-bottom button is built here rather than in `paneSession.ts` because
 * every piece of scroll knowledge in the renderer already lives in this file. It is
 * appended to a host *outside* the scroller: an absolutely positioned child of a
 * scroll container would anchor to the bottom of the content rather than to the
 * viewport.
 */
export interface TranscriptView {
  /**
   * `disclosure` is the pane's absolute answer for every run and step.
   * `activity` is what the pane knows about the turn in flight — whether one is
   * running, when it started and which turn it is — and `model/waiting.ts` turns
   * that into 「which run carries the live status」 and 「what the status line of
   * its own reads」. `undefined` is an idle session: no status is drawn. `header` is fixed above every entry,
   * `trailer` below the last.
   */
  render(state: TranscriptState, disclosure: DisclosureState, activity?: WaitingInput, selectedSubagent?: string, header?: HTMLElement, trailer?: HTMLElement): void
  /**
   * Stops the live status's clock.
   *
   * The live line's elapsed time is the one thing in this view that changes without a
   * paint, so it is the one thing with a timer — and a pane that goes to the
   * background or is disposed keeps its DOM, so nothing else would ever stop it.
   * The next `render` starts it again from the same `startedAt`.
   */
  stopClock(): void
  /**
   * `true` while the pane or the window is out of sight: the live mark stops
   * where it is (and the clock with it). `false` resumes the mark from that
   * frame, re-reading reduced motion; the next `render` restarts the clock.
   */
  syncMotion(hidden: boolean): void
  dispose(): void
  /** Capture the reading position before the composer or another region resizes. */
  beginLayoutChange(): void
}

export interface TranscriptHandlers {
  /** `expanded` is what the row shows now, so the first click always inverts it. */
  onToggle(id: string, expanded: boolean): void
  /**
   * A plan receipt was clicked. `planContent` is the plan it was decided on, when
   * the record kept it; the pane opens the plan tab on it.
   */
  onOpenPlan(planContent: string | undefined): void
  /** An `Agent` row was clicked: its run opens in the side panel, not in place. */
  onOpenSubagent(id: string): void
  /** The status line's 「N 个后台任务」 button: opens (or closes) the background-task list. */
  onOpenBackgroundTasks?(): void
  /**
   * A path in a search result was clicked (§6.2 检索). `path` is relative to the
   * session's cwd — exactly what the tool printed — and `line` is the hit's own
   * line, `undefined` when the row is the file itself (a `Glob` row, or a Grep
   * file header). The pane turns it into the `open-in-editor` command.
   */
  onOpenPath(path: string, line: number | undefined): void
  /**
   * An image beside a user bubble was clicked (S12). The pane opens the
   * window's fullscreen viewer, which asks the host for a screen-sized copy —
   * no `file://` read is opened to the renderer either way.
   */
  onViewImage(image: ImageAttachmentRef): void
  /**
   * The thumbnail the pane already holds for one attachment id, or `undefined`
   * while its on-demand load is still out. A *lookup*, not a map: the pane owns
   * the LRU behind it, and this file stays free of the fetch.
   */
  imageThumbUrl(imageId: string): string | undefined
  /**
   * A message's 复制 button. The pane owns the clipboard call: `navigator` is a
   * host object, and this file is the one under test against a hand-written DOM
   * stub. Resolves `true` once the text is on the clipboard.
   */
  onCopy(text: string): Promise<boolean>
  /**
   * A user message's 回退 button: `/rewind`, opened on that message's
   * checkpoint. Absent (the sub-agent panel) draws no button.
   */
  onRewind?(messageId: string): void
  /** A thread note card's 查看: open that thread's session. Absent draws the button inert. */
  onOpenThread?(threadId: string): void
  /** A failed turn's 「打开服务商设置」. Absent (the sub-agent panel) draws no button. */
  onOpenProviderSettings?(): void
  /** A failed turn's 「重试」: run the turn again on its own message. Absent draws no button. */
  onRetryTurn?(failureId: string): void
  /** An edited-files card's row or 查看全部: the turn's changes in the side panel, `path` scrolled to. Absent draws no card. */
  onViewEdits?(edits: TurnEdits, path: string | undefined): void
}

export function createTranscriptView(
  container: HTMLElement,
  floatHost: HTMLElement,
  handlers: TranscriptHandlers,
): TranscriptView {
  const jump = button(
    'scroll-bottom',
    '',
    '回到最新',
    () => {
      stopViewportMotion()
      following = true
      if (viewportPolicy({ event: 'return-latest', atBottom: false, streaming: false, measurable: true }) === 'follow-tail') {
        container.scrollTo({ top: container.scrollHeight, behavior: motionPolicy().scrollBehavior })
      }
      syncJump()
    },
    { icon: 'arrow-down' },
  )
  jump.hidden = true
  floatHost.appendChild(jump)

  // One column inside the scroller, not a `max-width` on the scroller itself: the
  // reading column is ~760px (design_guidance 四.2) while the scrollbar has to stay
  // at the panel's edge, and the user bubble's right alignment is `margin-left:
  // auto` — which only means "right of the column" if the column is a real box.
  //
  // Built once and kept: it is the scroller's only child, and rebuilding it would
  // undo the node reuse below at the very first level.
  const column = el('div', 'transcript-column')
  container.appendChild(column)

  const cache = new Map<string, CachedNode>()
  const refs = new Map<string, DisclosureRef>()
  const disclosures = new Map<string, { node: HTMLElement; presence: Presence }>()
  const seenDisclosures = new Set<string>()
  let generation: number | undefined
  type ReadingPosition = { node: HTMLElement; offset: number }
  let readingPosition: ReadingPosition | undefined
  let guardedPosition: ReadingPosition | undefined
  let viewportFrame: number | undefined
  let viewportTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether the reader is following the tail — an *intent*, not a measurement.
   *
   * It used to be re-measured on every paint (「is the scroller within 24px of
   * its end」), and that broke on the turns that needed it most: a paint pins the
   * scroller to the end, then a step's unfold animation — or a sibling folding
   * away — moves the content by more than 24px *after* the paint, and the next
   * paint read the reader as 「scrolled up, reading history」. From then on the
   * tail was never followed again, the turn-end fold was withheld as 「being
   * read」, and the final answer landed below the viewport.
   *
   * So it is cleared only by the reader: a wheel or key that scrolls up, or a
   * drag of the scrollbar that leaves the end. Reaching the end again by any
   * means sets it, as do 「回到最新」 and a new question.
   */
  let following = true
  let dragging = false

  function positionOf(node: HTMLElement | undefined): ReadingPosition | undefined {
    const viewport = box(container)
    const rect = node && box(node)
    return node && viewport && rect ? { node, offset: rect.top - viewport.top } : undefined
  }

  function readingReference(): ReadingPosition | undefined {
    const viewport = box(container)
    if (!viewport) return undefined
    const candidates = [...column.querySelectorAll<HTMLElement>('.step-head, .run-line, p, .md-code, .item')]
    const node = candidates.find((candidate) => {
      const rect = box(candidate)
      return rect && rect.top >= viewport.top && rect.top < viewport.bottom
    }) ?? candidates.find((candidate) => {
      const rect = box(candidate)
      return rect && rect.bottom > viewport.top && rect.top < viewport.bottom
    })
    return positionOf(node)
  }

  function keepReadingPosition(position: ReadingPosition | undefined): void {
    if (!position || !column.contains(position.node)) return
    const current = positionOf(position.node)
    if (current && Math.abs(current.offset - position.offset) > 0.5) {
      // Correct only the residual after native scroll anchoring, never twice.
      container.scrollTop += current.offset - position.offset
    }
  }

  function stopViewportMotion(): void {
    if (viewportFrame !== undefined) cancelAnimationFrame(viewportFrame)
    viewportFrame = undefined
    clearTimeout(viewportTimer)
    viewportTimer = undefined
    guardedPosition = undefined
  }

  function beginLayoutChange(node?: HTMLElement): void {
    stopViewportMotion()
    if (document.hidden) return
    const policy = viewportPolicy({ event: node ? 'disclosure' : 'layout', atBottom: isScrolledToBottom(container), streaming: !anchorSettled, measurable: box(container) !== undefined })
    if (policy !== 'preserve-anchor') return
    guardedPosition = positionOf(node) ?? readingReference()
    if (!guardedPosition) return
    const frame = (): void => {
      keepReadingPosition(guardedPosition)
      viewportFrame = requestAnimationFrame(frame)
    }
    if (motionPolicy().animate && typeof requestAnimationFrame === 'function') viewportFrame = requestAnimationFrame(frame)
    viewportTimer = setTimeout(() => {
      keepReadingPosition(guardedPosition)
      stopViewportMotion()
      // A step the reader opened by hand is being read: if holding its head
      // still left the end, the tail stops pulling the viewport away from it.
      if (node) following = isScrolledToBottom(container)
    }, motionDelay(PRESENCE_FALLBACK_MS.layout))
    ;(viewportTimer as unknown as { unref?: () => void }).unref?.()
  }

  // A wheel, scrollbar press or keyboard navigation immediately owns the view.
  container.addEventListener('wheel', (event) => {
    stopViewportMotion()
    if (event.deltaY < 0) following = false
  }, { passive: true })
  container.addEventListener('pointerdown', (event) => {
    stopViewportMotion()
    // The scrollbar is the container's own box; a press on content is a click
    // or a selection, not a scroll.
    if (event.target === container) dragging = true
  })
  const endDrag = (): void => { dragging = false }
  window.addEventListener('pointerup', endDrag)
  window.addEventListener('pointercancel', endDrag)
  container.addEventListener('keydown', (event) => {
    if (['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(event.key)) stopViewportMotion()
    if (['PageUp', 'Home', 'ArrowUp'].includes(event.key)) following = false
  })

  // Re-arming takes the true end, not `isScrolledToBottom`'s 24px slack: a slow
  // wheel moves a few px per tick, and the slack would re-arm the follow after
  // each one, so the next paint snapped the reader straight back down.
  function atTail(): boolean {
    if (container.scrollHeight - container.scrollTop - container.clientHeight < 1) following = true
    return following
  }

  function followTail(): void {
    container.scrollTop = container.scrollHeight
  }

  // The status line's pieces. Kept rather than looked up: the line is a node
  // reused by key like every other, so the elements its fill built are still the
  // ones on screen, and the clock is the only thing that writes into them.
  let clockNode: HTMLElement | undefined
  let labelNode: HTMLElement | undefined
  let status: { readonly row: WaitingRow; readonly tokens: number | undefined } | undefined
  let gate: LabelGate | undefined
  let metaShown = ''
  let clock: ReturnType<typeof setInterval> | undefined
  let clockFrom: number | undefined
  // The mark's carrier, kept the way `clockNode` is. One controller, created at
  // the first status line.
  let markHost: HTMLElement | undefined
  let mark: WorkingMark | undefined

  function stopClock(): void {
    if (clock === undefined) return
    clearInterval(clock)
    clock = undefined
    clockFrom = undefined
  }

  function paintStatus(): void {
    if (!status || !labelNode || !clockNode) return
    const { row, tokens } = status
    const now = Date.now()
    const settled = settleLabel(gate, statusLabel(row, now), row.startedAt, now)
    gate = settled.gate
    if (labelNode.textContent !== settled.label) labelNode.textContent = settled.label
    // Empty under the model's threshold: a short wait is not worth a number.
    const meta = row.startedAt === undefined ? [] : statusMeta(now - row.startedAt, tokens)
    const shown = meta.join('\n')
    if (shown === metaShown) return
    metaShown = shown
    clockNode.replaceChildren(...meta.flatMap((part) => [el('span', undefined, part), el('span', 'line-sep', '·')]))
  }

  /**
   * 100ms, so the sub-second tenth `formatWorkedDuration` prints actually moves;
   * above a second the string only changes once a second, and a write is skipped
   * while what is shown is what it would say. It also carries the label gate's
   * recheck, so the gate needs no timer of its own.
   *
   * Restarted only when the turn it counts changed, or a still-running clock
   * would be torn down and rebuilt once per repaint. `unref` is Node's, not the
   * browser's: it keeps a test process from being held open by a clock the view
   * legitimately still has running (`setInterval` returns a number in the
   * browser, where the call simply is not there).
   */
  function runClock(startedAt: number | undefined): void {
    paintStatus()
    if (startedAt === undefined || document.hidden) {
      stopClock()
      return
    }
    if (clock !== undefined && clockFrom === startedAt) return
    stopClock()
    clockFrom = startedAt
    clock = setInterval(paintStatus, 100)
    ;(clock as unknown as { unref?: () => void }).unref?.()
  }

  function syncJump(): void {
    show(jump, !atTail())
  }

  /**
   * The user message the last paint anchored on. `undefined` until the first one
   * arrives, and again after a `transcript-reset` clears the pane — a session
   * switch back into a conversation therefore anchors once, which is the same
   * thing the scroll-to-bottom below it used to do on its own.
   */
  let anchorId: string | undefined
  /**
   * The pad written last paint. Kept because the measurement it feeds is taken
   * against `scrollHeight`, which *includes* the pad: without subtracting it
   * every paint would count the blank it wrote last time as content, and the pad
   * would collapse to its floor on the second frame of every turn. Remembering
   * the number is exact and costs nothing; zeroing the pad to measure without it
   * would cost a second layout and let the browser clamp `scrollTop` against the
   * shorter scroller in between.
   */
  let pad = 0
  /** The anchor's node and its gap, for a re-measurement between paints. */
  let anchorNode: HTMLElement | undefined
  let anchorFirst = false
  /**
   * Whether the last paint found no turn in flight. Kept for the same reason
   * `anchorFirst` is: the resize path re-runs the pad without a paint to tell
   * it what the session is doing, and a resize that recomputed a settled
   * transcript as a streaming one would put the screenful of blank back.
   */
  let anchorSettled = true
  let anchorHoldPadding = false

  // Both halves are needed, and they share the one predicate so they cannot
  // disagree at its 24px boundary. `scroll` is the obvious trigger; the paint
  // below is the other one, because the *content* can move the verdict with no
  // scroll event at all — a `turn-end` dropping a draft or a `transcript-reset`
  // shortens the scroller under a reader who is then already at the tail.
  container.addEventListener('scroll', () => {
    container.classList.toggle('scrolled', container.scrollTop > 0)
    if (dragging && !isScrolledToBottom(container)) following = false
    syncJump()
    if (!guardedPosition) readingPosition = atTail() ? undefined : readingReference()
  })

  /**
   * The pad again, without the scroll: the length it should be depends on the
   * viewport, and the viewport moves without the transcript repainting.
   *
   * Twice, at least. The canvas header is `hidden` until the lane has an
   * identity, so the first paint of a restored session measures a scroller some
   * 36px taller than the one it ends up in — and nothing repaints the transcript
   * when the header arrives. The composer is the other: it grows a line at a
   * time as the user types, and every line of it comes off the transcript.
   * Either way a stale pad is a scroller with travel left in it, which the tail
   * follow then spends by sliding the question off its gap.
   *
   * `moved: false` — a resize is not a new question, and hauling the reader back
   * to the anchor because they opened a panel is exactly the yank this file
   * avoids everywhere else.
   */
  const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
      if (document.hidden) return
      const policy = viewportPolicy({ event: 'resize', atBottom: atTail(), streaming: !anchorSettled, measurable: true })
      if (anchorNode !== undefined) {
        pad = liftAnchor(container, column, anchorNode, {
          first: anchorFirst,
          moved: false,
          settled: anchorSettled,
          pad,
          holdPadding: anchorHoldPadding,
        }).pad
      }
      // The content is observed too: a step unfolding or folding runs for a few
      // frames after the paint that started it, and a reader following the tail
      // stays on it for every one of them.
      if (following && !guardedPosition) {
        if (!isScrolledToBottom(container)) followTail()
      } else if (policy === 'preserve-anchor') keepReadingPosition(guardedPosition ?? readingPosition)
      syncJump()
    }) : undefined
  // A clamped user bubble only knows it overflows after layout, and the answer changes with the column's width.
  const overflowObserver = typeof ResizeObserver === 'function' ? new ResizeObserver((entries) => {
    for (const { target } of entries) {
      target.parentElement?.classList.toggle('overflow', target.scrollHeight > target.clientHeight + 1)
    }
  }) : undefined
  let observing = false
  let taskFlash: ReturnType<typeof setTimeout> | undefined

  function finishTaskFlash(): void {
    clearTimeout(taskFlash)
    taskFlash = undefined
    cache.get(TASK_CARD_KEY)?.node.classList.remove('flash')
  }

  /** Brings the card into view and pulses its outline; nothing when no card is drawn. */
  function locateTaskCard(): void {
    const card = cache.get(TASK_CARD_KEY)?.node
    if (!card) return
    finishTaskFlash()
    card.scrollIntoView({ block: 'nearest', behavior: motionPolicy().scrollBehavior })
    // A layout read between removing and re-adding the class restarts the pulse.
    card.getBoundingClientRect()
    card.classList.add('flash')
    taskFlash = setTimeout(finishTaskFlash, motionDelay(TASK_LOCATE_FALLBACK_MS))
    ;(taskFlash as unknown as { unref?: () => void }).unref?.()
  }

  function stopMotion(): void {
    stopClock()
    stopViewportMotion()
    finishPresenceWithin(container)
    resizeObserver?.disconnect()
    observing = false
  }

  return {
    beginLayoutChange: () => beginLayoutChange(),
    stopClock: stopMotion,
    syncMotion(hidden) {
      if (hidden) stopMotion()
      mark?.syncMotion(hidden)
    },
    dispose() {
      stopMotion()
      overflowObserver?.disconnect()
      clearTimeout(taskFlash)
      mark?.dispose()
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      for (const entry of disclosures.values()) entry.presence.dispose()
      disclosures.clear()
      cache.clear()
      refs.clear()
      seenDisclosures.clear()
    },
    render(state, disclosure, activity, selectedSubagent, header, trailer) {
      if (!document.hidden && !observing) {
        resizeObserver?.observe(container)
        resizeObserver?.observe(column)
        observing = true
      }
      if (generation !== state.generation) {
        stopViewportMotion()
        readingPosition = undefined
        for (const entry of disclosures.values()) entry.presence.dispose()
        disclosures.clear()
        seenDisclosures.clear()
        cache.clear()
        refs.clear()
        clockNode = labelNode = markHost = undefined
        status = gate = undefined
        metaShown = ''
        anchorId = undefined
        generation = state.generation
      }
      const atBottom = atTail()
      const before = guardedPosition ?? (!atBottom ? readingReference() : undefined)
      const wasSettled = anchorSettled
      let entries = groupTranscript(state.items)
      // A turn that is still streaming has no elapsed line yet; the replay-made one
      // for its records so far is not it.
      const tail = entries[entries.length - 1]
      if (tail?.kind === 'item' && tail.item.kind === 'duration' && activity?.isStreaming === true
        && tail.item.turnId !== undefined && tail.item.turnId === activity.turnId) {
        entries = entries.slice(0, -1)
      }
      const split = splitTurnFooters(entries, activity?.isStreaming === true ? undefined : activity?.outputTokens)
      entries = split.entries
      const footers = activity === undefined ? new Map<number, TurnFooter>() : split.footers
      const live = turnActivity(entries, activity ?? IDLE)
      const focused = new Set<string>()
      const selected = new Set<string>()
      const selection = window.getSelection?.()
      for (const entry of entries) {
        const id = entry.kind === 'run' ? entry.run.id : entry.item.id
        const key = entry.kind === 'run' ? id : itemKey(entry.item)
        const node = cache.get(key)?.node
        if (!node) continue
        if (node.contains(document.activeElement)) focused.add(id)
        if (selection && !selection.isCollapsed
          && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) selected.add(id)
      }
      const afterPaint: Array<() => void> = []
      const painter = createPainter(cache, refs, disclosures, seenDisclosures, disclosure, {
        ...handlers,
        onToggle(id, expanded) {
          const head = cache.get(`run-head:${id}`)?.node ?? cache.get(`thinking-head:${id}`)?.node
            ?? cache.get(`tool-head:${id}`)?.node ?? cache.get(`item:${id}`)?.node
          beginLayoutChange(head)
          handlers.onToggle(id, expanded)
        },
      }, {
        selectedSubagent,
        keepClock: (span) => { clockNode = span },
        keepLabel: (span) => { labelNode = span },
        keepMark: (host) => { markHost = host },
        locateTaskCard,
        afterPaint: (run) => afterPaint.push(run),
        observeOverflow: (node) => overflowObserver?.observe(node),
      })
      const edits = handlers.onViewEdits ? collectTurnEdits(entries, new Set(footers.keys())) : new Map<number, TurnEdits>()
      // 撤销 rewinds to the turn's opening message, so only the newest settled turn offers it.
      const lastTurn = activity?.isStreaming === true ? undefined : Math.max(-1, ...footers.keys())
      const cards = new Map([...edits].map(([index, turn]) => [index, editsCardNode(painter, turn, index === lastTurn)]))
      const nodes = entries.map((entry, index) => entryNode(painter, entry, footers.get(index), activity !== undefined, cards.get(index)))
      // Built before `prune`, or its key would count as dead on the very paint
      // that asked for it. A kept line keeps the spans its fill handed over.
      status = live.row ? { row: live.row, tokens: activity?.outputTokens } : undefined
      const tasks = activity?.backgroundTasks ?? 0
      // `blocked` is the mark's word for a turn waiting on the user: a question or an approval.
      const card = activity?.taskCard && (live.mark?.state === 'blocked' ? pausedTaskCard(activity.taskCard) : activity.taskCard)
      if (card) nodes.push(taskCardNode(painter, card))
      if (live.row) nodes.push(waitingNode(painter, tasks))
      else if (tasks > 0 && painter.onOpenBackgroundTasks) nodes.push(idleStatusNode(painter, tasks))
      if (!live.row) {
        clockNode = labelNode = markHost = undefined
        gate = undefined
        metaShown = ''
      }
      painter.prune()
      const placed = nodes.flatMap((node, index) => {
        const footer = footers.get(index)
        const entry = entries[index]
        if (!footer || (entry?.kind === 'item' && entry.item.kind === 'assistant')) return [node]
        const card = cards.get(index)
        return card ? [node, card, footerNode(painter, footer)] : [node, footerNode(painter, footer)]
      })
      reconcile(column, [...(header ? [header] : []), ...placed, ...(trailer ? [trailer] : [])])
      for (const run of afterPaint) run()
      runClock(live.row?.startedAt)
      // After the reconcile, so the carrier is in the document when the mark moves in.
      if (live.mark && markHost) (mark ??= createWorkingMark()).attach(markHost, live.mark)
      else if (activity?.isStreaming === true) mark?.hide()
      else mark?.end()

      // The turn the reader is looking at: the newest user message. Read off the
      // *entries* rather than off `state.items`, because what the lift needs is
      // the node, and only this list is in node order.
      const at = lastUserEntry(entries)
      const anchor = at === undefined ? undefined : entries[at]
      const next = anchor?.kind === 'item' ? anchor.item.id : undefined
      const moved = next !== undefined && next !== anchorId
      if (moved) {
        stopViewportMotion()
        following = true
      }
      // The pane's own flag rather than anything `turnActivity` decided: the
      // session's `isStreaming` is the one honest source for 「the turn is over」.
      const settled = activity?.isStreaming !== true
      anchorSettled = settled
      anchorHoldPadding = settled && !moved && (!atBottom || focused.size > 0 || selected.size > 0)
      // The transition is attached only while the pad is resting. During a turn
      // it shortens on every token, and an animated `padding-bottom` would lag
      // the tail follow by a frame each time — a transcript that shivers for as
      // long as the answer runs.
      column.classList.toggle('settling', settled && !anchorHoldPadding)
      // A transcript with no user message — a reset pane, or one showing only
      // startup notices — drops the pad rather than keeping the last one it was
      // given; nothing in it is anchored, so there is nothing to hold up.
      let lifted = false
      if (at === undefined) {
        pad = 0
        anchorId = undefined
        anchorNode = undefined
        column.style.setProperty(TRANSCRIPT_PAD_VARIABLE, '0px')
      } else {
        anchorNode = nodes[at]!
        anchorFirst = at === 0 && !header
        const lift = liftAnchor(container, column, nodes[at]!, { first: at === 0 && !header, moved, settled, pad, holdPadding: anchorHoldPadding })
        pad = lift.pad
        lifted = lift.lifted
        // The anchor is only *spent* once it could actually be measured. A pane
        // painted before it has any layout — still hidden, or built in the
        // background — would otherwise use up the one paint that was allowed to
        // lift the question and leave it wherever the flow had put it.
        if (lift.measured) anchorId = next
      }

      // Follow the tail only if the user was already there, so reading back
      // through a long turn is not yanked away on every token. Skipped when the
      // lift already placed the scroller — it put the anchor at the top, which
      // *is* the end of the padded content, and running both would be one
      // assignment fighting the other.
      const policy = viewportPolicy({
        event: guardedPosition ? 'disclosure' : settled && !wasSettled ? 'turn-end' : 'stream',
        atBottom, streaming: !settled, measurable: box(container) !== undefined,
      })
      if (!lifted && policy === 'follow-tail') followTail()
      else if (!lifted && policy === 'preserve-anchor') keepReadingPosition(before)
      readingPosition = policy === 'preserve-anchor' ? readingReference() : undefined
      syncJump()
    },
  }
}

/** An idle session: no turn, no clock, no live line. */
const IDLE: WaitingInput = { isStreaming: false, startedAt: undefined, turnId: undefined }

/**
 * The status line, the transcript's last while the turn runs: mark, counter and
 * words, whatever the steps above it are. Built once and filled by the clock
 * (`paintStatus`), so the words can be held back from flickering.
 *
 * `.transcript` is `aria-live="polite"`, so the label is spoken and the counter
 * is `aria-hidden`, or a screen reader would read a new number ten times a second.
 */
function waitingNode(painter: Painter, tasks: number): HTMLElement {
  return painter.node('waiting', 'waiting', [tasks], () => [
    markNode(painter, 'waiting'),
    elapsedNode(painter, 'waiting'),
    painter.node('waiting:text', 'line-text', [], (span) => {
      painter.keepLabel(span)
      return []
    }, () => el('span')),
    tasksButton(painter, tasks),
  ])
}

/** The status line between turns: no mark, no clock, only the button for tasks that outlived the turn. */
function idleStatusNode(painter: Painter, tasks: number): HTMLElement {
  return painter.node('waiting', 'waiting idle', [tasks], () => [tasksButton(painter, tasks)])
}

/** 「N 个后台任务」, the status line's last element; absent with no tasks or no one to open them. */
function tasksButton(painter: Painter, tasks: number): HTMLElement | undefined {
  const open = painter.onOpenBackgroundTasks
  if (tasks === 0 || !open) return undefined
  const text = `${tasks} 个后台任务`
  return painter.node('waiting:tasks', 'line-tasks', [tasks], (node) => {
    node.setAttribute('aria-label', `${text}，查看`)
    return [text]
  }, () => {
    const node = el('button', 'line-tasks')
    node.type = 'button'
    node.title = '查看后台任务'
    node.addEventListener('click', open)
    return node
  })
}

/**
 * The working mark's carrier, empty as painted: the view moves its one live mark
 * in after the paint (`dom/workingMarkView.ts`). Decoration, so hidden from readers.
 */
function markNode(painter: Painter, key: string): HTMLElement {
  const node = painter.node(`${key}:mark`, 'line-mark', [], (span) => {
    span.setAttribute('aria-hidden', 'true')
    return []
  }, () => el('span'))
  painter.keepMark(node)
  return node
}

/** The elapsed span, empty until the wait is worth a number; hidden, or a reader would hear it ten times a second. */
function elapsedNode(painter: Painter, key: string): HTMLElement {
  const node = painter.node(`${key}:elapsed`, 'line-meta line-elapsed', [], (span) => {
    span.setAttribute('aria-hidden', 'true')
    return []
  }, () => el('span'))
  painter.keepClock(node)
  return node
}

/** A line's words. `hidden` where the line is a button whose accessible name says them already. */
function lineText(painter: Painter, key: string, text: string, hidden: boolean): HTMLElement {
  return painter.node(`${key}:text`, 'line-text', [text], (node) => {
    if (hidden) node.setAttribute('aria-hidden', 'true')
    return [text]
  }, () => el('span'))
}

// --- node reuse --------------------------------------------------------------

interface CachedNode {
  readonly node: HTMLElement
  readonly className: string
  /** What the node was last painted from; compared by identity, member by member. */
  signature: readonly unknown[]
  /** Keys registered inside this fill; a cache hit keeps the entire subtree alive. */
  readonly children: readonly string[]
}

/**
 * What a kept head shows *now*, read at click time.
 *
 * A head built once outlives every disclosure it is painted under, so it cannot
 * close over `expanded`: the answer it reported would be the one from the paint
 * that happened to build it. `onToggle` takes 「what the row showed」 so the first
 * click always inverts what the user sees, and this is where that value lives
 * between paints.
 */
interface DisclosureRef {
  expanded: boolean
}

/** What this paint knows about the turn in flight, for the line that shows it. */
interface LivePaint {
  /** The `Agent` row whose run the side panel is showing. */
  readonly selectedSubagent: string | undefined
  /** Handed the elapsed span whichever carrier built it, so the clock can fill it. */
  keepClock(span: HTMLElement): void
  /** Likewise the span for the status words. */
  keepLabel(span: HTMLElement): void
  /** Likewise the mark's carrier, so the view can move its mark in. */
  keepMark(host: HTMLElement): void
  /** A task row was clicked: point at the task card, if one is drawn. */
  locateTaskCard(): void
  afterPaint(run: () => void): void
  observeOverflow(node: HTMLElement): void
}

interface Painter extends TranscriptHandlers, LivePaint {
  readonly disclosure: DisclosureState
  /**
   * The node for `key`, refilled only when `signature` changed.
   *
   * Every member of a signature is compared with `===`, which is why it is made of
   * the model's own values: an unchanged item hands back the same `text` *string
   * reference*, so an untouched entry costs one identity check rather than a
   * re-parse of its markdown. A signature member may equally be another kept
   * *node*, which is how a container says 「my children are the same objects」.
   *
   * `fill` is handed the node so it can write the attributes that are not
   * children — a head's accessible name, its `aria-expanded` — on a node it may
   * not have built itself. `create` builds the element on the first paint only;
   * without it the node is a `div`.
   */
  node(
    key: string,
    className: string,
    signature: readonly unknown[],
    fill: (node: HTMLElement) => Child[],
    create?: () => HTMLElement,
  ): HTMLElement
  /** The mutable disclosure a kept head reads at click time. */
  ref(key: string, expanded: boolean): DisclosureRef
  disclose(key: string, expanded: boolean, head: HTMLElement, body: () => HTMLElement | undefined): HTMLElement | undefined
  prune(): void
}

function createPainter(
  cache: Map<string, CachedNode>,
  refs: Map<string, DisclosureRef>,
  disclosures: Map<string, { node: HTMLElement; presence: Presence }>,
  seenDisclosures: Set<string>,
  disclosure: DisclosureState,
  handlers: TranscriptHandlers,
  paint: LivePaint,
): Painter {
  const live = new Set<string>()
  const filling: string[][] = []
  function keep(key: string): void {
    if (live.has(key)) return
    live.add(key)
    for (const child of cache.get(key)?.children ?? []) keep(child)
  }
  return {
    disclosure,
    selectedSubagent: paint.selectedSubagent,
    keepClock: paint.keepClock,
    keepLabel: paint.keepLabel,
    keepMark: paint.keepMark,
    locateTaskCard: paint.locateTaskCard,
    afterPaint: paint.afterPaint,
    observeOverflow: paint.observeOverflow,
    onToggle: handlers.onToggle,
    onOpenPlan: handlers.onOpenPlan,
    onOpenSubagent: handlers.onOpenSubagent,
    onOpenBackgroundTasks: handlers.onOpenBackgroundTasks,
    onOpenPath: handlers.onOpenPath,
    onViewImage: handlers.onViewImage,
    imageThumbUrl: handlers.imageThumbUrl,
    onCopy: handlers.onCopy,
    onRewind: handlers.onRewind,
    onOpenThread: handlers.onOpenThread,
    onOpenProviderSettings: handlers.onOpenProviderSettings,
    onRetryTurn: handlers.onRetryTurn,
    onViewEdits: handlers.onViewEdits,
    node(key, className, signature, fill, create) {
      filling.at(-1)?.push(key)
      const cached = cache.get(key)
      if (cached && cached.className === className && sameSignature(cached.signature, signature)) {
        keep(key)
        return cached.node
      }
      live.add(key)
      // Reused even when the content changed: it is the node the scroll anchor
      // points at, so it is refilled rather than replaced — and refilled through
      // `reconcile`, so the children it hands back keep *their* place too.
      const node = cached?.node ?? create?.() ?? el('div', className)
      // Transient presentation classes belong to their lifecycle, not the data
      // signature. A content-only refill must not cancel completion feedback.
      if (cached?.className !== className) node.className = className
      const children: string[] = []
      filling.push(children)
      try {
        reconcile(node, fill(node))
      } finally {
        filling.pop()
      }
      cache.set(key, { node, className, signature, children })
      return node
    },
    ref(key, expanded) {
      const existing = refs.get(key)
      if (existing) {
        existing.expanded = expanded
        return existing
      }
      const created = { expanded }
      refs.set(key, created)
      return created
    },
    disclose(key, expanded, head, build) {
      const seen = seenDisclosures.has(key)
      seenDisclosures.add(key)
      filling.at(-1)?.push(key)
      keep(key)
      let entry = disclosures.get(key)
      if (expanded) {
        const node = build()
        if (!node) return undefined
        if (!entry) {
          const presence = createPresence(node, {
            kind: 'disclosure', direction: 'none', property: 'height',
            onClosed() {
              finishPresenceWithin(node)
              node.remove()
              cache.delete(key)
              disclosures.delete(key)
            },
          })
          entry = { node, presence }
          disclosures.set(key, entry)
          // History appears in its final state. A user opening a previously
          // closed body starts only after reconciliation has attached it.
          if (seen) paint.afterPaint(() => presence.set(true))
          else presence.set(true, true)
        } else entry.presence.set(true)
      } else if (entry) {
        // Keep the exiting subtree in the same cache graph until settlement.
        const returnFocus = entry.node.contains(document.activeElement)
        entry.presence.set(false)
        if (returnFocus) head.focus()
      }
      return entry?.node
    },
    prune() {
      for (const key of [...cache.keys()]) {
        if (!live.has(key)) cache.delete(key)
      }
      for (const key of [...refs.keys()]) {
        if (!live.has(key)) refs.delete(key)
      }
      for (const [key, entry] of disclosures) {
        if (live.has(key)) continue
        entry.presence.dispose()
        disclosures.delete(key)
      }
      for (const key of seenDisclosures) if (!live.has(key)) seenDisclosures.delete(key)
    },
  }
}

function sameSignature(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// --- entries -----------------------------------------------------------------

function entryNode(painter: Painter, entry: TranscriptEntry, footer: TurnFooter | undefined, inTurn: boolean, card: HTMLElement | undefined): HTMLElement {
  return entry.kind === 'run' ? runNode(painter, entry.run) : itemNode(painter, entry.item, footer, inTurn, card)
}

/**
 * A run of work: one summary line, which opens into a card of rows.
 *
 * Two kept nodes under one: the line and the card. The run's signature is the
 * *identity* of its own children, so a paint that changed nothing inside touches
 * nothing here, and a paint that rebuilt the line re-inserts the line alone — the
 * card, and every animation and scroll anchor under it, is left where it stands.
 * A run with no tool in it is just its thoughts, each a line of its own.
 */
function runNode(painter: Painter, run: ActivityRun): HTMLElement {
  if (!runHasTools(run)) {
    const lines = run.steps.map((step) => thinkingLine(painter, step as Extract<ActivityStep, { kind: 'thinking' }>))
    return painter.node(run.id, 'run thinking-run', lines, () => lines)
  }
  const expanded = isExpanded(painter.disclosure, run.id)
  const classes = ['run']
  if (expanded) classes.push('open')
  const head = runLine(painter, run, summarizeRun(run), expanded)
  const card = painter.disclose(`card:${run.id}`, expanded, head, () => cardNode(painter, run))
  return painter.node(run.id, classes.join(' '), [head, card], () => [head, card])
}

/** The card's rows, kept so they are not re-inserted with their run. */
function cardNode(painter: Painter, run: ActivityRun): HTMLElement {
  const rows = run.steps.map((step) => stepNode(painter, step))
  return painter.node(`card:${run.id}`, 'run-card', rows, () => rows)
}

/**
 * The run's line: its summary, which a screen reader gets as the button's name —
 * the visible text is hidden from it, because this subtree sits in an `aria-live`
 * region and a summary that grows with every tool would be read out once per step.
 */
function runLine(
  painter: Painter,
  run: ActivityRun,
  summary: RunSummary,
  expanded: boolean,
): HTMLElement {
  const headKey = `run-head:${run.id}`
  const ref = painter.ref(headKey, expanded)
  const text = summary.text
  const failed = summary.failed > 0 ? failureLabel(summary.failed) : undefined
  const name = [summary.text, failed, summary.aborted ? '已中断' : undefined].filter(Boolean).join(' · ')
  const { diff } = summary
  return painter.node(
    headKey,
    'run-line',
    [text, diff?.added, diff?.deleted, summary.failed, summary.aborted, expanded],
    (node) => {
      // `button()` writes these at build time only, and this node outlives the text
      // it was built with.
      node.title = name
      node.setAttribute('aria-label', name)
      node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      return [
        lineText(painter, headKey, text, true),
        diff === undefined ? undefined : el('span', 'line-meta', ...diffStat(diff.added, diff.deleted)),
        failed === undefined ? undefined : quiet('line-fail', `· ${failed}`),
        summary.aborted ? quiet('line-meta', '· 已中断') : undefined,
        icon('chevron-right'),
      ]
    },
    () => button('run-line', '', name, () => painter.onToggle(run.id, ref.expanded)),
  )
}

/** `+12 −3`, each count in its own colour. */
function diffStat(added: number, deleted: number): Child[] {
  return [el('span', 'stat-add', `+${added}`), ' ', el('span', 'stat-del', `−${deleted}`)]
}

/**
 * A thought: one line showing its first sentence, opening in place to the whole
 * text. While it arrives the line shimmers (`.live`) instead of following the stream.
 */
function thinkingLine(
  painter: Painter,
  step: Extract<ActivityStep, { kind: 'thinking' }>,
): HTMLElement {
  const expanded = isExpanded(painter.disclosure, step.id)
  const classes = ['thinking']
  if (expanded) classes.push('open')
  if (step.pending === true) classes.push('live')
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, step.pending, expanded], () => {
    const headKey = `thinking-head:${step.id}`
    const ref = painter.ref(headKey, expanded)
    const label = step.pending === true ? thoughtLiveLabel(step.text) : thoughtLabel(step.text)
    const shown = expanded ? step.text : label
    const head = painter.node(
      headKey,
      'run-line',
      [shown, label, expanded],
      (node) => {
        node.title = label
        node.setAttribute('aria-label', label)
        node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
        return [lineText(painter, headKey, shown, true)]
      },
      () => button('run-line', '', label, () => painter.onToggle(step.id, ref.expanded)),
    )
    return [head]
  })
}

// --- steps -------------------------------------------------------------------

function stepNode(painter: Painter, step: ActivityStep): HTMLElement {
  switch (step.kind) {
    case 'thinking':
      return thinkingLine(painter, step)
    case 'tool':
    case 'subagent':
      return toolRow(painter, step)
    case 'task':
      return taskRow(painter, step)
  }
}

/**
 * A `TodoWrite` row: one line, no body, ever. The checklist is drawn once, as the
 * task card at the transcript's tail, so clicking the row points at that card
 * rather than repeating the list here.
 *
 * A `<button>` with no `aria-expanded`, because nothing here opens: the row is a
 * pointer, not a disclosure.
 */
function taskRow(painter: Painter, step: Extract<ActivityStep, { kind: 'task' }>): HTMLElement {
  return painter.node(`step:${step.id}`, `step task ${step.status}`, [step.text, step.status], () => {
    const head = button('step-head', '', `${step.text} · ${toolStatusLabel(step.status)}`, () => painter.locateTaskCard())
    append(head, [el('span', 'step-label', step.text)])
    return [head]
  })
}

const TASK_CARD_KEY = 'task-card'

const TASK_STATUS_LABEL: Record<TaskRowStatus, string> = {
  pending: '未开始',
  in_progress: '进行中',
  paused: '已搁置',
  completed: '已完成',
}

/**
 * The checklist card above the status line, drawn while a turn runs. Read-only:
 * the list belongs to the model, so no row is a control. The card node is kept
 * across paints, so its entrance plays when the list appears, not per token.
 */
function taskCardNode(painter: Painter, card: TaskCard): HTMLElement {
  const rows = card.rows.map((task) => painter.node(
    `${TASK_CARD_KEY}:row:${task.id}`,
    `task-row ${task.status}`,
    [task.label, task.status],
    () => [taskMark(task.status), el('span', 'task-label', task.label)],
    () => el('li'),
  ))
  const list = painter.node(`${TASK_CARD_KEY}:list`, 'task-list', rows, () => rows, () => el('ul'))
  return painter.node(TASK_CARD_KEY, 'task-card', [list, card.hiddenBefore, card.openAfter], () => [
    card.hiddenBefore > 0 ? el('p', 'task-more', `更早的 ${card.hiddenBefore} 项`) : undefined,
    list,
    card.openAfter > 0 ? el('p', 'task-more', `还有 ${card.openAfter} 项`) : undefined,
  ])
}

const TASK_MARK_ICON: Record<TaskRowStatus, IconName> = {
  pending: 'circle',
  in_progress: 'progress-ring',
  paused: 'circle-ellipsis',
  completed: 'check-circle',
}

function taskMark(status: TaskRowStatus): HTMLElement {
  const mark = el('span', `task-mark ${status}`)
  mark.setAttribute('role', 'img')
  mark.setAttribute('aria-label', TASK_STATUS_LABEL[status])
  mark.appendChild(icon(TASK_MARK_ICON[status]))
  return mark
}

type ToolLike = Extract<ActivityStep, { kind: 'tool' | 'subagent' }>

/**
 * The edit family (§6.2): tools whose result ships a unified patch in
 * `display.detail`. The family is the design's own assignment — a `Bash` output
 * that happens to parse as a diff stays a terminal block, not a diff — and a
 * member whose `detail` does not parse (an old record, a foreign tool with the
 * same name) simply falls back to the plain body.
 */
/**
 * The family's own body data, or `undefined` when this step is not one of its
 * patches. Parsed once per fill — the painter's signature already holds the tool
 * detail, so a repaint that changes nothing costs nothing.
 */
function editPatch(step: ToolLike): PatchRows | undefined {
  if (step.kind !== 'tool' || step.toolName === undefined || !EDIT_TOOLS.has(step.toolName)) return undefined
  return step.tool.detail === undefined ? undefined : parseUnifiedPatch(step.tool.detail)
}

/** `+12 −3` — the patch's own two counts, the head's suffix (§6.2). */
function patchStats(patch: PatchRows): string {
  return `+${patch.added} −${patch.deleted}`
}

/**
 * The shell family (§6.2): `Bash`, whose body is a terminal block — the
 * command's own output, monospaced on the card surface, scrolling inside
 * itself. The family is an assignment by tool name, exactly as the edit family
 * is: a foreign tool named `Bash` degrades to a terminal block, never to a diff.
 *
 * The text is **`content` first**, unlike the fallback's `detail ?? content`: a
 * terminal shows what the command printed, and a shell result's `detail` is a
 * one-line extract for the collapsed row (a backgrounded shell's `PID`) — the
 * full start message in `content` is the richer and truer transcript.
 *
 * The escapes are stripped here (§6.4): they would print as `[32m` garbage, and
 * colour rendering waits for a DOM-side ANSI→span pure function. Stripping at
 * paint time leaves the raw output on the item, so a future coloured body reads
 * the same field this one does.
 */
function shellOutput(step: Extract<ToolLike, { kind: 'tool' }>): string | undefined {
  if (step.toolName !== 'Bash') return undefined
  const raw = step.tool.content ?? step.tool.detail
  if (raw === undefined || raw.length === 0) return undefined
  return stripAnsi(raw)
}

/** What `BashTool` prints when a command wrote nothing to either stream. */
const SHELL_NO_OUTPUT = '(no output)'

/** A failed call's `errorCode`, in the interface's own language (§6.2 共通). */
const TOOL_ERROR_LABELS: Record<ToolErrorCode, string> = {
  invalid_input: '参数无效',
  permission_denied: '权限被拒绝',
  precondition_failed: '前置条件不满足',
  stale_file: '文件已被外部修改',
  not_found: '未找到',
  timeout: '超时',
  command_failed: '命令失败（非零退出）',
  execution_failed: '执行出错',
  aborted: '已中断',
}

/** The search family (§6.2): the two tools whose result is a list of files. */
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])

/** The read family (§6.2 读取): `Read`, whose body is the file it read. */
const READ_TOOL = 'Read'

/** The web family (§6.2 Web): the two tools whose result is fetched prose. */
const WEB_TOOLS = new Set(['WebFetch', 'WebSearch'])

/** One numbered line of the read family's code block. */
interface CodeRow {
  /** 1-based, the line's own place in the file. */
  readonly line: number
  readonly text: string
}

/** What the families of this step parsed its records into, computed once per fill. */
interface FamilyData {
  readonly patch: PatchRows | undefined
  readonly found: SearchResults | undefined
  readonly rows: readonly CodeRow[] | undefined
  readonly agent: SubagentRun | undefined
}

/**
 * The search family's own body data, or `undefined` when this step is not one
 * of its lists. Parsed once per fill — the painter's signature already holds
 * the tool detail, so a repaint that changes nothing costs nothing.
 *
 * A failed call is excluded before parsing: a Grep's error string fails the row
 * pattern on its own, but any short text is a plausible `Glob` path, so the
 * gate has to live where the status is known (§6.2 共通 draws the failure
 * instead, through the fallback body).
 */
function searchResults(step: ToolLike): SearchResults | undefined {
  if (step.kind !== 'tool' || step.failed === true) return undefined
  if (step.toolName === undefined || !SEARCH_TOOLS.has(step.toolName)) return undefined
  return parseSearchResults(step.toolName, step.tool.content)
}

/**
 * The read family's own body data (§6.2 读取): the file the tool read, as
 * numbered rows. A failed read is excluded before parsing, exactly as the
 * search family is — the failure's own text is the fallback body's to draw,
 * under the step's `failed` class.
 *
 * The trailing newline's empty row is dropped, mirroring the tool's own line
 * count, or the head's `N 行` would disagree with the block by one. A trailing
 * `\r` goes with it: it is half of a CRLF the split already broke on, not a
 * character of the line.
 */
function readRows(step: ToolLike): readonly CodeRow[] | undefined {
  if (step.kind !== 'tool' || step.failed === true) return undefined
  if (step.toolName !== READ_TOOL) return undefined
  const content = step.tool.content
  if (content === undefined || content.length === 0) return undefined
  const lines = (content.endsWith('\n') ? content.slice(0, -1) : content).split('\n')
    .map((text) => (text.endsWith('\r') ? text.slice(0, -1) : text))
  // The tool numbers its own lines (`     20\tline`), from the offset it read at.
  // Those numbers are the file's, so they are the gutter; the prefix goes. What
  // carries none — the `[Showing lines …]` notice and the blank line before it —
  // is the tool talking, not the file. An image read has no numbering at all and
  // keeps counting from 1.
  const numbered = lines.flatMap((text) => {
    const match = READ_LINE_PREFIX.exec(text)
    return match ? [{ line: Number(match[1]), text: text.slice(match[0].length) }] : []
  })
  if (numbered.length > 0) return numbered
  return lines.map((text, index) => ({ line: index + 1, text }))
}

/** `FileReadTool`'s line prefix: the number right-aligned in six columns, then a tab. */
const READ_LINE_PREFIX = /^ *(\d+)\t/

/** The Agent family's run facts, when this step is one of its calls. */
function agentRun(step: ToolLike): SubagentRun | undefined {
  if (step.kind !== 'tool' || step.toolName !== AGENT_TOOL) return undefined
  return step.tool.subagent
}

/**
 * The read family's own note (§6.2): `240 行` — the parsed block's own count,
 * so the head and the body can never disagree.
 */
function readStats(rows: readonly CodeRow[]): string {
  return `${rows.length} 行`
}

/**
 * The Agent family's own note (§6.2): `opus · 12 工具` — the model the run used
 * and the calls it made, composed from the run's own record. The model is the
 * same string the result's `headerSuffix` carries, so while this unit stands
 * the generic suffix stands down (see `headParts`) rather than saying it twice.
 */
function agentStats(run: SubagentRun | undefined): string | undefined {
  if (run === undefined) return undefined
  const parts = [run.model, run.toolUseCount === undefined ? undefined : `${run.toolUseCount} 工具`]
    .filter((part) => part !== undefined && part.length > 0)
  return parts.length > 0 ? parts.join(' · ') : undefined
}

/** Every family's parsed data for one step, in the order the bodies draw them. */
function familyData(step: ToolLike): FamilyData {
  return {
    patch: editPatch(step),
    found: searchResults(step),
    rows: readRows(step),
    agent: agentRun(step),
  }
}

/** The family's own counts, sitting where a suffix would (§6.2). */
function familyStats(family: FamilyData): string | undefined {
  // An old capped patch's counts are partial — `+0 −17` on a whole-file rewrite
  // whose adds were cut — so the suffix stays off rather than lying. A search
  // list is never capped by the parser (only by the tool itself, which says so
  // in the notice), so its counts are the list's own and always honest.
  if (family.patch !== undefined && !family.patch.partial) return patchStats(family.patch)
  if (family.found !== undefined) return searchStats(family.found)
  if (family.rows !== undefined) return readStats(family.rows)
  return agentStats(family.agent)
}

/**
 * A tool's row in an opened run: 「读取 **pricing.js**」, with what the result adds
 * (the patch's counts, the lines read, the files found, or the time it took) on the
 * right. It opens into the tool's own output when there is any; a row with nothing
 * to show is a plain line, and a sub-agent's row opens its run in the side panel.
 */
function toolRow(painter: Painter, step: ToolLike): HTMLElement {
  const status = step.kind === 'tool' ? step.status : step.pending === true ? 'running' : 'done'
  const agent = step.kind === 'tool' && step.toolName === AGENT_TOOL
  const selected = agent && painter.selectedSubagent === step.id
  // Running: a bordered capsule that says only which agent. Finished: one line of prose.
  const capsule = agent && (status === 'running' || status === 'awaiting-approval')
  const expanded = isExpanded(painter.disclosure, step.id) && !agent
  const classes = ['step', step.kind, status]
  if (!expanded) classes.push('collapsed')
  if (selected) classes.push('selected')
  // `step.tool` is the item's own detail object, so it changes reference exactly
  // when the result merges in; `toStep` mints the step itself anew every paint.
  const detail = step.kind === 'tool' ? step.tool : undefined
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, detail, status, expanded, selected], () => {
    const family = familyData(step)
    const live = subagentLive(step, status)
    // A running sub-agent has no run record yet; its live count stands in.
    const stats = familyStats(family) ?? (live === undefined ? undefined : `${live.toolCount} 工具`)
    const body = agent ? undefined : stepBody(step, family, painter)
    const label = rowLabel(step)
    const name = stepAccessibleName(step, label, status, stats)
    const ran = agent && status === 'done' ? ranAgentLabel(step, family.agent) : undefined
    const toggles = body !== undefined
    const headKey = `${toggles ? 'tool-head' : 'tool-static'}:${step.id}`
    const ref = painter.ref(headKey, expanded)
    const right = capsule || ran ? undefined : rowRight(family, stats)
    const headClass = capsule ? 'step-head agent-chip' : ran ? 'step-head agent-ran' : toggles || agent ? 'step-head' : 'step-head static'
    const head = painter.node(headKey, headClass, [name, detail, step.text, expanded, selected], (node) => {
      node.title = name
      node.setAttribute('aria-label', name)
      if (agent) node.setAttribute('aria-pressed', selected ? 'true' : 'false')
      else if (toggles) node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      if (capsule) return [icon('agent'), el('span', 'step-label', agentName(step)), icon('chevron-right')]
      return [
        el('span', 'step-label', ...(ran ?? label.parts)),
        toggles ? icon('chevron-right') : undefined,
        right,
      ]
    }, () => {
      if (!toggles && !agent) return el('div', 'step-head static')
      return button('step-head', '', name, () => {
        if (agent) painter.onOpenSubagent(step.id)
        else painter.onToggle(step.id, ref.expanded)
      })
    })
    const bodyKey = `tool-body:${step.id}`
    const shown = body === undefined ? undefined : painter.disclose(bodyKey, expanded, head, () => {
      const content = body()
      return painter.node(bodyKey, 'step-body', [step.text, detail], () => [...content.childNodes])
    })
    return [head, live === undefined ? undefined : liveLine(live), shown]
  })
}

/** The latest tool of a running sub-agent, drawn under its step's head. */
function subagentLive(step: ToolLike, status: string): SubagentLive | undefined {
  if (step.kind !== 'tool' || step.toolName !== AGENT_TOOL || status !== 'running') return undefined
  return step.tool.live
}

/** `↳ Read notes.txt` — outside the disclosure, so a folded step still says what it is doing. */
function liveLine(live: SubagentLive): HTMLElement {
  const node = el(
    'div',
    'step-live',
    el('span', 'step-live-arrow', '↳'),
    el('span', 'step-name', live.tool),
    live.summary.length > 0 ? el('span', 'step-summary', live.summary) : undefined,
  )
  node.setAttribute('aria-live', 'off')
  return node
}

/**
 * A row's words: verb and object, the object in the stronger ink. The shell has no
 * verb — its description, or the command, already says it — and a failure says so
 * in words too, because the red is not the only carrier.
 */
function rowLabel(step: ToolLike): { readonly text: string; readonly parts: Child[] } {
  if (step.kind === 'subagent') return { text: step.text, parts: [step.text] }
  const failed = step.status === 'failed' ? ' 失败' : step.status === 'interrupted' ? ' 已中断' : ''
  const mark = step.status === 'failed' ? el('span', 'step-fail', failed) : failed
  if (step.toolName === AGENT_TOOL) {
    const target = [step.tool.agentType, step.tool.useSummary].filter(Boolean).join(' · ')
    return { text: `${step.tool.displayName} ${target}${failed}`, parts: [step.tool.displayName, ' ', el('strong', '', target), mark] }
  }
  const { verb, target, bare } = callParts(step, step.toolName === undefined || !EDIT_TOOLS.has(step.toolName))
  if (target.length === 0) return { text: `${verb}${failed}`, parts: step.status === 'failed' ? [verb, mark] : [`${verb}${failed}`] }
  if (bare) return { text: `${target}${failed}`, parts: [target, mark] }
  return { text: `${verb} ${target}${failed}`, parts: [`${verb} `, el('strong', '', target), mark] }
}

/** What the Agent call is called to the reader: the task it was given, else its type. */
function agentName(step: ToolLike): string {
  if (step.kind !== 'tool') return step.text
  return step.tool.useSummary || step.tool.agentType || step.tool.displayName
}

/** 「已运行子代理 名称 · 模型」: the verb and the model quiet, the name carrying the line. */
function ranAgentLabel(step: ToolLike, run: SubagentRun | undefined): Child[] {
  const model = run?.model
  return [
    el('span', 'agent-verb', '已运行子代理 '),
    el('strong', '', agentName(step)),
    model ? el('span', 'agent-model', ` · ${model}`) : undefined,
  ].filter((part) => part !== undefined)
}

/** The right edge of a row: the family's counts, if it has any. */
function rowRight(family: FamilyData, stats: string | undefined): HTMLElement | undefined {
  if (stats === undefined) return undefined
  const patch = family.patch !== undefined && !family.patch.partial ? family.patch : undefined
  return el('span', 'step-right', ...(patch ? diffStat(patch.added, patch.deleted) : [stats]))
}

/** The state in words, because colour is not a name. */
function stepAccessibleName(step: ToolLike, label: { readonly text: string }, status: string, stats: string | undefined): string {
  return [label.text, stats, toolStatusLabel(status as Parameters<typeof toolStatusLabel>[0])]
    .filter((part) => part && part.length > 0)
    .join(' · ')
}

/**
 * A step's expanded body, by family (§6.2).
 *
 * The edit family is a real diff: the unified patch the tools ship in
 * `display.detail` (T12), parsed back into the same rows the permission dialog
 * paints — line gutters included. Its result summary is not repeated above the
 * rows; the head already says what file and how much.
 *
 * The shell family is a terminal block (T14): the command's own output with its
 * ANSI escapes stripped, on the card surface. Its head already says what ran and
 * how long, so the body is the output alone — except a failure's error code,
 * which §6.2 gives a line of its own above the block. The whole block reddens
 * with the step's `failed` class, the stylesheet's half of that rule.
 *
 * The search family (T15) is the grouped list: a `Grep`'s hits under their own
 * file, a `Glob`'s paths one row each, every path a jump into the editor
 * (`open-in-editor`, via the pane). The rows are controls, like every step
 * head — hover is the whole affordance, and the accessible name says what a
 * click opens.
 *
 * The read family (T16) is the file itself, as a code block with its own line
 * numbers — no syntax highlighting (§6.4 暂不做); the structure a code body
 * owes is lines and numbers, and colour would have to be a highlighter's.
 *
 * The Agent family (T16) is the conversation the call stands for: the task the
 * parent handed the sub-agent and the sub-agent's answer — prose, so markdown,
 * not a terminal — with the run's own model and tool count already in the head.
 *
 * The web family (T16) is the fetched page, which arrives *as* markdown — the
 * tool converts before it returns — rendered as the article it is rather than
 * the marker soup a plain body would print.
 *
 * Everything else is still the fallback family (§6.2 兜底): the result's own
 * summary over `detail ?? content` — which is also what an edit step without a
 * parseable patch gets, an old record's `Edited x` among them (§10), without
 * erroring.
 *
 * Nothing to show yields no body at all rather than an empty box: a call with no
 * result yet is the common case, and an empty disclosure is noise.
 */
function stepBody(step: ToolLike, family: FamilyData, painter: Painter): (() => HTMLElement) | undefined {
  if (step.kind === 'subagent') return () => el('div', 'step-body', step.text)
  if (family.patch !== undefined) {
    // The row names the file; the body gives its full path above the change.
    const path = step.kind === 'tool' && step.tool.detail !== undefined ? patchPath(step.tool.detail) : undefined
    return () => el('div', 'step-body', path === undefined ? undefined : el('div', 'step-path', path), diffNode(family.patch!.rows))
  }
  if (family.found !== undefined) return () => el('div', 'step-body', searchBody(family.found!, painter))
  const terminal = shellOutput(step)
  const command = step.toolName === 'Bash' ? step.tool.command : undefined
  if (terminal !== undefined || command !== undefined) {
    const { errorCode } = step.tool
    const error = errorCode === undefined ? undefined : TOOL_ERROR_LABELS[errorCode]
    // The row says what the command is for, or only its first word; the whole command gets its own bubble.
    const bubble = (): HTMLElement | undefined => command === undefined
      ? undefined
      : el(
        'div',
        'step-command',
        el('pre', 'step-command-text', `$ ${command}`),
        copyButton(painter, 'step-command-copy', '复制命令', command),
      )
    // Still running: the command alone, so the abbreviated row can always be opened.
    if (terminal === undefined) return () => el('div', 'step-body', bubble())
    // The shell's `(no output)` placeholder is not output: one line, no empty box.
    if (terminal.trim() === SHELL_NO_OUTPUT) {
      return () => el('div', 'step-body', bubble(), el('div', error === undefined ? 'step-body-head' : 'step-error',
        error === undefined ? '无输出' : `${error}，无输出`))
    }
    return () => el(
      'div',
      'step-body',
      bubble(),
      error === undefined ? undefined : el('div', 'step-error', error),
      el('pre', 'step-terminal', terminal),
    )
  }
  if (family.rows !== undefined) {
    return () => el('div', 'step-body', el('div', 'step-code', ...family.rows!.map((row) => el(
      'div',
      'step-code-row',
      el('span', 'step-code-line', String(row.line)),
      el('span', 'step-code-text', row.text),
    ))))
  }
  if (isWebProse(step)) return () => webBody(step)
  const { resultSummary, detail, content } = step.tool
  const text = detail ?? content
  if (resultSummary === undefined && (text === undefined || text.length === 0)) return undefined
  return () => el(
    'div',
    'step-body',
    resultSummary === undefined ? undefined : el('div', 'step-body-head', resultSummary),
    // Clipping is the stylesheet's: `max-height` plus scrolling *inside* the
    // block, so a long output never turns the run card into a scroll window.
    text === undefined || text.length === 0 ? undefined : el('pre', 'step-body-text', text),
  )
}

/**
 * Whether the web family claims this step: a successful fetch or search whose
 * result is prose. A failed fetch is the fallback body's to draw, under the step's
 * `failed` class.
 */
function isWebProse(step: Extract<ToolLike, { kind: 'tool' }>): boolean {
  if (step.failed === true || step.toolName === undefined || !WEB_TOOLS.has(step.toolName)) return false
  const { content } = step.tool
  return content !== undefined && content.length > 0
}

/** The web family's body: the fetched page as the markdown the tool already made of it. */
function webBody(step: Extract<ToolLike, { kind: 'tool' }>): HTMLElement {
  const { resultSummary, content } = step.tool
  return el(
    'div',
    'step-body',
    resultSummary === undefined ? undefined : el('div', 'step-body-head', resultSummary),
    el('div', 'step-web md', ...markdownChildren(content!)),
  )
}

/**
 * The search family's list: one group per file, its hits under it — a `Glob`
 * row is the group with no hits, which is why the two members share one shape.
 *
 * Both rows are `<button>`s: the file header opens the file, a hit opens it at
 * the hit's own line, and the accessible name is the `file:line` a click means
 * (the goto argument itself, the one string that cannot be misread).
 */
function searchBody(results: SearchResults, painter: Painter): HTMLElement {
  return el(
    'div',
    'step-search',
    ...results.files.map((file) => el(
      'div',
      'search-file',
      button(
        'search-file-head',
        file.path,
        `打开 ${file.path}`,
        () => painter.onOpenPath(file.path, undefined),
      ),
      ...file.matches.map((match) => {
        const hit = button(
          'search-hit',
          '',
          `${file.path}:${match.line}`,
          () => painter.onOpenPath(file.path, match.line),
        )
        append(hit, [
          el('span', 'search-hit-line', String(match.line)),
          el('span', 'search-hit-text', match.text),
        ])
        return hit
      }),
    )),
    results.truncatedNote === undefined
      ? undefined
      : el('div', 'step-search-note', results.truncatedNote),
  )
}

// --- loose items -------------------------------------------------------------

/** Text can become a staged step after a tool call; its carrier stays the same. */
function itemKey(item: TranscriptItem): string {
  return `${item.kind === 'assistant' ? 'text' : 'item'}:${item.id}`
}

/**
 * What a settled question or plan leaves behind: a thin-bordered card. A question
 * lists what was asked in quiet type and the answer under it; a plan is one line
 * that opens the plan tab.
 */
function receiptNode(painter: Painter, receipt: Receipt, classes: string[], key: string): HTMLElement {
  if (receipt.kind === 'plan') {
    const { text, planContent } = receipt
    return painter.node(key, `${classes.join(' ')} plan ${receipt.accepted ? 'accepted' : 'rejected'}`, [text, planContent], () => {
      const head = button('receipt-head', '', `${text} · 打开计划`, () => painter.onOpenPlan(planContent))
      append(head, [el('span', 'receipt-text', text), icon('chevron-right')])
      return [head]
    })
  }
  const { rows } = receipt
  return painter.node(key, `${classes.join(' ')} question`, [rows.map((row) => `${row.question}\n${row.answer ?? ''}`).join('\n\n')], () => (
    rows.length === 0
      ? [el('div', 'receipt-row', el('span', 'receipt-answer none', '未回答'))]
      : rows.map((row) => el(
        'div',
        'receipt-row',
        el('span', 'receipt-question', row.question),
        el('span', row.answer === undefined ? 'receipt-answer none' : 'receipt-answer', row.answer ?? '未回答'),
      ))
  ))
}

/**
 * `inTurn`: the main transcript, where an assistant message only carries its
 * meta row as the settled turn's answer — prose between tool calls is not one.
 */
function itemNode(painter: Painter, item: TranscriptItem, footer: TurnFooter | undefined, inTurn: boolean, card?: HTMLElement): HTMLElement {
  const classes = ['item', item.kind]
  if (item.pending) classes.push('pending')
  if (item.failed) classes.push('failed')
  const key = itemKey(item)
  // Only the assistant writes markdown. A tool line, a user message and a notice
  // are commands, paths and diagnostics — they have to read back character for
  // character, so `*` stays a `*` there.
  //
  // The draft is rendered the same way while it streams: a half-written fence is
  // just a code block whose end has not arrived, and the parse cache means the
  // cost is one parse of the draft rather than one of every settled message.
  if (item.kind === 'assistant') {
    return painter.node(key, `${classes.join(' ')} md`, [item.text, item.model, item.createdAt, footer?.durationMs, footer?.tokens, footer && relativeTime(item.createdAt, Date.now()), card], (node) => [
      ...markdownChildren(item.text, node),
      card,
      inTurn && footer === undefined ? undefined : metaRow(painter, item, footer),
    ])
  }
  if (item.kind === 'thread-notes' && item.threadNotes) return threadNotesNode(painter, item, classes, key)
  if (item.kind === 'receipt' && item.receipt) return receiptNode(painter, item.receipt, classes, key)
  if (item.kind === 'turn-failure' && item.failure) return turnFailureNode(painter, item.failure, classes, key)
  if (item.kind === 'compaction') {
    return painter.node(key, classes.join(' '), [item.text], () => [icon('fold-vertical'), el('span', 'line-text', item.text)])
  }
  if (isAgentCall(item)) {
    const row = toolRow(painter, toStep(item) as ToolLike)
    return painter.node(`agent:${item.id}`, 'run agent-entry', [row], () => [row])
  }
  if (item.kind === 'user') {
    // The item is the *column* here, not the bubble: the bubble is its own node,
    // so the meta row sits under it rather than inside it — a control tucked in
    // with the user's own words reads as part of the message.
    //
    // The images a user message was submitted with (S12) draw as thumbnails
    // *above* the bubble, right-aligned with it: what was sent was a picture,
    // and a line of text naming it is a description of the message rather than
    // the message.
    //
    // This used to be a facts-only line, on the grounds that the transcript is
    // `aria-live` and repaints at the stream rate — the one place an on-demand
    // data URL would keep being re-requested. That worry belongs to the pane,
    // and `beginPreviewLoad` answers it: one request per id, whatever the
    // repaint rate. The URLs join the signature so the arrival repaints the
    // node once, and a repaint that changes nothing still rebuilds nothing.
    //
    // Joined into one string, not left as an array: signatures are compared
    // element by element with `===`, and a fresh array per paint would never
    // match itself — every streamed chunk would refill this node.
    const thumbs = item.images?.map((image) => painter.imageThumbUrl(image.id) ?? '').join(' ')
    const expanded = isExpanded(painter.disclosure, item.id)
    return painter.node(
      key,
      classes.join(' '),
      [item.text, item.createdAt, item.images, thumbs, expanded],
      () => {
        const { text, paths } = splitAttachedPaths(item.text)
        return [
          paths.length > 0 ? el('div', 'user-paths', ...paths.map(pathTileNode)) : undefined,
          item.images !== undefined && item.images.length > 0
            ? el('div', 'user-images', ...item.images.map((image, index) =>
              imageTileNode(painter, image, index)))
            : undefined,
          text.trim().length > 0 || paths.length === 0 ? userBubble(painter, item.id, text, expanded) : undefined,
          metaRow(painter, item),
        ]
      },
    )
  }
  // The interruption is said once, in the turn's own words: 「已中断」, the way a
  // finished turn says 「已处理 …」.
  const text = item.interrupt === true ? '已中断' : item.text
  return painter.node(key, item.interrupt === true ? `${classes.join(' ')} interrupt` : classes.join(' '), [text], () => [text])
}

/**
 * A turn that ended on a provider error: what went wrong in plain words, which
 * model and endpoint were involved, what to try, and the provider's own message
 * underneath (clamped; the card is not the place for a stack trace).
 *
 * The buttons are the newest failure's alone (`retryable`): an older one's
 * message has long since been answered or re-sent.
 */
function turnFailureNode(painter: Painter, failure: TurnFailureCard, classes: string[], key: string): HTMLElement {
  const { onRetryTurn, onOpenProviderSettings } = painter
  const retry = failure.retryable && onRetryTurn !== undefined
  return painter.node(
    key,
    classes.join(' '),
    [failure.reason, failure.hint, failure.target, failure.detail, retry, onOpenProviderSettings !== undefined],
    () => [
      el('div', 'failure-reason', failure.reason),
      failure.target === undefined ? undefined : el('div', 'failure-target', failure.target),
      el('div', 'failure-hint', failure.hint),
      failure.detail === '' ? undefined : el('div', 'failure-detail', failure.detail),
      retry || onOpenProviderSettings !== undefined
        ? el(
          'div',
          'failure-actions',
          onOpenProviderSettings === undefined
            ? undefined
            : button('failure-action', '打开服务商设置', '打开服务商设置', () => onOpenProviderSettings()),
          retry ? button('failure-action primary', '重试', '重新发送这次请求', () => onRetryTurn(failure.id)) : undefined,
        )
        : undefined,
    ],
  )
}

/**
 * An automatic wake or coordination update: a muted 「自动唤醒 · n/limit」 line,
 * then one compact card per thread note. 查看 is inert without a thread id.
 */
function threadNotesNode(painter: Painter, item: TranscriptItem, classes: string[], key: string): HTMLElement {
  const data = item.threadNotes!
  return painter.node(key, classes.join(' '), [item.text], () => [
    data.wake === undefined
      ? undefined
      : el('div', 'thread-notes-head', `自动唤醒 · ${data.wake.count}/${data.wake.limit}`),
    ...data.cards.map((card) => threadNoteCard(painter, card)),
  ])
}

function threadNoteCard(painter: Painter, card: ThreadNoteCard): HTMLElement {
  const known = Object.hasOwn(THREAD_STATUS_LABEL, card.status)
  const status = card.status as WireThreadStatus
  const open = card.threadId
  return el(
    'div',
    'thread-note-card',
    el('span', 'thread-note-title', card.title),
    el('span', known ? `thread-note-status tone-${threadTone(status)}` : 'thread-note-status',
      known ? THREAD_STATUS_LABEL[status] : card.status),
    card.report === undefined ? undefined : el('span', 'thread-note-report', card.report),
    button('thread-note-open', '查看', '查看该线程', () => {
      if (open !== undefined) painter.onOpenThread?.(open)
    }, { enabled: open !== undefined }),
  )
}

/** A copy button whose glyph turns into a tick for a few seconds once the text is on the clipboard. */
function copyButton(painter: Painter, className: string, title: string, text: string): HTMLButtonElement {
  let reset: ReturnType<typeof setTimeout> | undefined
  const node = button(className, '', title, () => {
    void painter.onCopy(text).then((ok) => {
      if (!ok) return
      node.replaceChildren(icon('check'))
      node.title = '已复制'
      clearTimeout(reset)
      reset = setTimeout(() => {
        node.replaceChildren(icon('copy'))
        node.title = title
      }, COPIED_MS)
    })
  }, { icon: 'copy' })
  return node
}

const COPIED_MS = 5000

/**
 * A message's meta row: 复制 · which model wrote it · when it settled.
 *
 * One row rather than three affordances, and one order on both sides of the
 * conversation — copy first because it is the only *control* here, then the two
 * facts, with the time at the end where a reader scanning down the column finds
 * a column of times rather than a ragged one.
 *
 * The model name used to be a line of its own in the stream: a `Switched to …`
 * notice the controller emitted at the end of *every* turn, whether or not
 * anything had switched. It rides on the message now.
 *
 * Absent, not empty, when there is nothing to say — a streaming draft has no
 * record yet, so it has neither model nor stamp, and an empty row would still
 * reserve its height under a message that is still growing.
 *
 * The two labels are `aria-hidden` (like the group head's visible label and the
 * beads): the transcript is `aria-live="polite"`, and neither is what a reader
 * asked to have read out alongside the answer. The button is not hidden — it is
 * the row's only real control, and it names itself.
 */
function metaRow(painter: Painter, item: TranscriptItem, footer?: TurnFooter): HTMLElement | undefined {
  const time = footer ? relativeTime(item.createdAt, Date.now()) : formatMessageTime(item.createdAt)
  const model = item.kind === 'assistant' ? item.model : undefined
  // A draft has no stamp of its own; copying half a sentence is not the offer.
  if (time === undefined && model === undefined) return undefined
  const copy = copyButton(painter, 'item-copy', '复制', item.text)
  const onRewind = painter.onRewind
  const timeLabel = time === undefined ? undefined : timeNode(time, item.createdAt)
  // The user's row hangs off the bubble's right edge, read right to left: the controls end it.
  if (item.kind === 'user') {
    const rewind = onRewind
      ? button('item-rewind', '', '回退到此消息之前', () => onRewind(item.id), { icon: 'rewind' })
      : undefined
    return el('div', 'item-meta', timeLabel, copy, rewind)
  }
  return el(
    'div',
    'item-meta',
    copy,
    model === undefined ? undefined : quiet('item-model', model),
    timeLabel,
    ...(footer ? footerFacts(footer).map((fact) => quiet('item-fact', fact)) : []),
  )
}

function timeNode(text: string, createdAt: string | undefined): HTMLElement {
  const node = quiet('item-time', text)
  if (createdAt !== undefined) node.setAttribute('title', absoluteTime(createdAt))
  return node
}

/** Rows the card lists before 查看全部 takes over the rest. */
const EDITS_CARD_ROWS = 5

/**
 * 已编辑 N 个文件: one row per file with its counts, 查看全部 with the turn's
 * totals, and 撤销 on the newest turn. Every row opens the side panel's 改动 page.
 */
function editsCardNode(painter: Painter, turn: TurnEdits, undoable: boolean): HTMLElement {
  return painter.node(
    `edits:${turn.key}`,
    'edits-card',
    [undoable, turn.userMessageId, turn.files.length, ...turn.files.flatMap((file) => [file.path, file.added, file.deleted])],
    () => {
      const view = (path: string | undefined): void => painter.onViewEdits?.(turn, path)
      const shown = turn.files.slice(0, EDITS_CARD_ROWS)
      const hidden = turn.files.length - shown.length
      const rewind = painter.onRewind
      const messageId = turn.userMessageId
      const undo = undoable && messageId !== undefined && rewind
        ? button('edits-undo', '撤销', '撤销本轮的文件改动', () => rewind(messageId))
        : undefined
      const rows = shown.map((file) => {
        const row = button('edits-row', '', `查看 ${file.name} 的改动`, () => view(file.path))
        append(row, [fileBadgeNode(file.name), el('span', 'edits-name', file.name), diffStatNode(file.added, file.deleted)])
        return row
      })
      const all = button('edits-row edits-all', '', '在侧栏查看全部改动', () => view(undefined))
      append(all, [
        el('span', 'edits-name', '查看全部'),
        hidden > 0 ? el('span', 'edits-more', `另有 ${hidden} 个文件`) : undefined,
        diffStatNode(turn.added, turn.deleted),
      ])
      return [
        el('div', 'edits-head', el('span', 'edits-title', `已编辑 ${turn.files.length} 个文件`), undo),
        el('div', 'edits-rows', ...rows, all),
      ]
    },
  )
}

/** The tail of a turn that ends in something other than an answer: its time and facts, under the last entry. */
function footerNode(painter: Painter, footer: TurnFooter): HTMLElement {
  const time = relativeTime(footer.createdAt, Date.now())
  return painter.node(
    `foot:${footer.createdAt ?? ''}:${footer.durationMs}`,
    'item-meta turn-foot',
    [footer.tokens, time],
    () => [
      time === undefined ? undefined : timeNode(time, footer.createdAt),
      ...footerFacts(footer).map((fact) => quiet('item-fact', fact)),
    ],
  )
}

/** A meta label: visible, and out of the live region's announcements. */
function quiet(className: string, text: string): HTMLElement {
  const node = el('span', className, text)
  node.setAttribute('aria-hidden', 'true')
  return node
}

/** The bubble around the user's words: a long one is clamped, with 显示更多 under it once it overflows. */
function userBubble(painter: Painter, id: string, source: string, expanded: boolean): HTMLElement {
  const text = el('div', 'user-text', ...userParts(source))
  const label = expanded ? '收起' : '显示更多'
  const more = button('user-more', label, label, () => painter.onToggle(id, expanded))
  const bubble = el('div', expanded ? 'user-bubble' : 'user-bubble clamped', text, more)
  if (!expanded) painter.observeOverflow(text)
  return bubble
}

/**
 * The user's bubble, with every `@` mention drawn as a pill in place.
 *
 * Still character-for-character: the pill's label is the mention's own substring and
 * nothing around it is touched, which is what `splitFileMentions` guarantees. A
 * `<span>`, not a `<button>`: clicking it does nothing, and a control that does
 * nothing is a worse lie than plain text (the same call 5c made for the context
 * pills).
 */
function userParts(text: string): Child[] {
  return splitFileMentions(text).map((segment) =>
    segment.kind === 'text'
      ? segment.text
      : el('span', 'file-chip', icon('file'), el('span', 'file-chip-label', segment.label)),
  )
}

/**
 * One image thumbnail above a user bubble (S12).
 *
 * The pixels are the pane's on-demand data URL; until it settles the box is
 * empty and the `alt` carries the same facts the line here used to spell out —
 * `图片 1：name，W×H`, the TUI's own wording — so what the live region reads is
 * unchanged by the picture arriving. Clicking opens the window's fullscreen
 * viewer, which asks the host for a screen-sized copy of its own.
 */
function imageTileNode(painter: Painter, image: ImageAttachmentRef, index: number): HTMLElement {
  const facts = `图片 ${index + 1}：${image.name}，${image.width}×${image.height}`
  const thumb = el('img', 'user-image-thumb')
  const url = painter.imageThumbUrl(image.id)
  if (url !== undefined) thumb.setAttribute('src', url)
  thumb.setAttribute('alt', facts)
  thumb.title = facts
  thumb.setAttribute('role', 'button')
  thumb.setAttribute('tabindex', '0')
  const open = () => painter.onViewImage(image)
  thumb.addEventListener('click', open)
  thumb.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Enter') return
    open()
  })
  return thumb
}

export function isScrolledToBottom(container: HTMLElement): boolean {
  // A few pixels of slack: fractional scroll heights never land exactly.
  return container.scrollHeight - container.scrollTop - container.clientHeight < 24
}

/** The newest user message's index in `entries`, which is also its node's. */
function lastUserEntry(entries: readonly TranscriptEntry[]): number | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!
    if (entry.kind === 'item' && entry.item.kind === 'user') return index
  }
  return undefined
}

/**
 * Pads the column so the anchor *can* reach the top of the viewport, and scrolls
 * it there when the anchor is new.
 *
 * The pad is written on every paint and the scroll only on the paint that
 * introduced the message: while a turn streams the scroller is already at its
 * end, so the tail-follow in `render` holds the bubble at its gap for free as
 * this shrinks underneath it. See `model/transcriptAnchor.ts` for the
 * arithmetic — everything here is measurement.
 *
 * A **settled** transcript is not lifted at all: it rests on the floor, and a
 * new anchor under it goes to the tail instead of to the top. That second half
 * is what a restored session is — `/resume`, a session switch, a pane painted
 * for the first time all arrive with `moved` true and no turn running — and
 * lifting there would open the conversation on its last question with a
 * screenful of nothing beneath it, which is the very blank this rest removes.
 */
function liftAnchor(
  container: HTMLElement,
  column: HTMLElement,
  anchor: HTMLElement,
  state: {
    readonly first: boolean
    readonly moved: boolean
    readonly settled: boolean
    readonly pad: number
    readonly holdPadding?: boolean
  },
): { readonly pad: number; readonly lifted: boolean; readonly measured: boolean } {
  const viewport = container.clientHeight
  const view = box(container)
  const content = box(column)
  const top = box(anchor)
  // A pane in the background has no layout at all and every reading is zero.
  // Writing a pad from that would leave a stale one behind for the paint that
  // brings it back, so nothing is written until there is a viewport to reason
  // about — which is also what keeps this working under a DOM stub that was
  // given no layout rule.
  if (!(viewport > 0) || view === undefined || content === undefined || top === undefined) {
    return { pad: state.pad, lifted: false, measured: false }
  }
  const topGap = anchorTopGap(state.first)
  // The scroller's leading padding, counted as its trailing one too. The leading
  // inset is larger by `--transcript-tuck` (the scroller starts that far up under
  // the title bar), and counting it at the bottom lowers the lift by the same
  // amount — so `topGap` lands measured from the canvas's top, not the
  // scroller's. Measured rather than named, so a retuned inset needs no edit
  // here — and measurable at any scroll position because the column no longer
  // has an auto margin to sit anywhere but the top.
  const inset = container.scrollTop + (content.top - view.top)
  // Everything under the anchor's top edge, to the end of the scrollable area.
  // Not `scrollHeight`: a conversation that does not fill its scroller reports a
  // `scrollHeight` clamped up to `clientHeight`, which is exactly the case a
  // short session is. The column's box has no such floor — but it *does* carry
  // the pad already written, which is what comes off it here.
  const below = content.bottom - state.pad - top.top + inset
  const pad = state.holdPadding ? state.pad : anchorPadding({ viewport, below, topGap, settled: state.settled })
  column.style.setProperty(TRANSCRIPT_PAD_VARIABLE, `${pad}px`)
  const policy = viewportPolicy({ event: state.moved ? 'new-question' : 'resize', atBottom: false, streaming: !state.settled, measurable: true })
  if (policy === 'preserve-anchor' || policy === 'none') return { pad, lifted: false, measured: true }
  // A new anchor with nothing running is a conversation being opened, not a
  // question being asked: the tail is where the reader left off.
  if (policy === 'follow-tail') {
    container.scrollTop = container.scrollHeight
    return { pad, lifted: true, measured: true }
  }
  // Relative, not absolute: `top` is viewport-relative, and the difference is
  // exactly how far this scroller has to travel to put the anchor at its gap.
  container.scrollTop += top.top - view.top - topGap
  return { pad, lifted: true, measured: true }
}

interface Box {
  readonly top: number
  readonly bottom: number
}

/**
 * A node's box, or `undefined` when it has none to give. Both coordinates are
 * checked rather than assumed: they are `NaN` inside a `display: none` subtree,
 * and `test/helpers/domStub.ts` answers the same way for a test that installed
 * no layout rule.
 */
function box(node: HTMLElement): Box | undefined {
  const read: unknown = node.getBoundingClientRect
  if (typeof read !== 'function') return undefined
  const rect = node.getBoundingClientRect()
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom)) return undefined
  return { top: rect.top, bottom: rect.bottom }
}
