import { stripAnsi } from '../model/ansi.js'
import { parseUnifiedPatch, type PatchRows } from '../model/diffRows.js'
import { parseSearchResults, searchStats, type SearchResults } from '../model/searchResults.js'
import {
  groupFailureLabel,
  groupHeaderLabel,
  groupHeaderName,
  groupRunningLabel,
  isGroupExpanded,
  isLooseThinkingExpanded,
  isStepCollapsible,
  isStepExpanded,
  EDIT_TOOLS,
  resolveDisclosure,
  thinkingDisclosureId,
  thinkingDurationLabel,
  thinkingHeaderLabel,
  thinkingHeaderName,
  STEP_COMPLETION_FALLBACK_MS,
  THINKING_DONE_FALLBACK,
  type DisclosureState,
} from '../model/thinking.js'
import {
  formatMessageTime,
  formatWorkedDuration,
  groupTranscript,
  toolStatusLabel,
  type ActivityGroup,
  type ActivityStep,
  type SubagentLive,
  type SubagentRun,
  type TranscriptEntry,
  type TranscriptItem,
  type TranscriptState,
} from '../model/transcript.js'
import { anchorPadding, anchorTopGap, TRANSCRIPT_PAD_VARIABLE, viewportPolicy } from '../model/transcriptAnchor.js'
import { PRESENCE_FALLBACK_MS } from '../model/presence.js'
import { splitFileMentions } from '../model/userMessage.js'
import { AGENT_TOOL } from '../model/subagentPanel.js'
import type { ImageAttachmentRef } from '../../../media/types.js'
import type { ToolErrorCode } from '../../../harness/types.js'
import {
  turnActivity,
  waitingElapsedLabel,
  type WaitingInput,
  type WaitingRow,
} from '../model/waiting.js'
import { THREAD_STATUS_LABEL, threadTone } from '../model/coordinationStatus.js'
import type { ThreadNoteCard } from '../model/threadNotes.js'
import type { WireThreadStatus } from '../../shellProtocol.js'
import { button } from './controls.js'
import { diffNode } from './diffView.js'
import { append, el, reconcile, show, type Child } from './dom.js'
import { icon } from './icons.js'
import { markdownChildren } from './markdownView.js'
import { createPresence, finishPresenceWithin, type Presence } from './presence.js'
import { motionDelay, motionPolicy } from './motion.js'

/**
 * Paints the transcript: loose items interleaved with activity groups (§2).
 *
 * There is no in-flight tool line any more. It was a singleton strip under the
 * scroller that named whatever tool was running, which since T4 is something the
 * running step's own head says — with its bead, its arguments and its elapsed
 * time — one line above where the strip used to sit. Two places saying the same
 * thing is one place too many, and the strip was the one that could not say
 * *which* of a batch's calls it meant.
 *
 * ## Two layers of disclosure
 *
 * A group is a whole turn: its head carries the boundary and the total, and each
 * step inside opens on its own. Every head is a `<button>` with `aria-expanded`,
 * and a folded body is **absent rather than `hidden`**: the transcript is
 * `aria-live="polite"`, so a hidden-but-present streaming block is text a screen
 * reader announces that nobody asked for (§8).
 *
 * ## Nodes are reused by id
 *
 * The file used to rebuild the whole subtree on every paint, and its header said
 * the fix — keying by id — could wait for a profile. §8 brought that day forward
 * for a correctness reason instead: steps now collapse *by themselves* when the
 * turn ends, which shortens the content above the reader. The browser's
 * `overflow-anchor` absorbs exactly that, but only while the anchor node survives
 * the paint; a `replace()` of the whole column destroys it and the reader is
 * thrown to a different place in the conversation.
 *
 * So each entry and each step keeps its element across paints, keyed by id. An
 * unchanged item is left untouched (its markdown is not even re-parsed); a changed
 * one is refilled *in place*, so the node the anchor points at is still there.
 *
 * Keeping the *element* is only half of it: it also has to stay **attached**. A
 * `replaceChildren` of the column, or a `replace()` of a group's contents, removes
 * every child and puts it back — and a node that leaves the document has its CSS
 * animations cancelled and restarted, and stops being an anchor the browser can
 * hold a scroll position by. That is what made `unfold` (220ms, on every open
 * step) replay once per streamed token: the open thinking body pumped up from zero
 * height on every delta and shoved the answer below it around. Every insertion
 * here goes through `reconcile`, which touches only the children that moved, and
 * the group's own children are keyed nodes for exactly that reason.
 *
 * The jump-to-bottom button is built here rather than in `paneSession.ts` because
 * every piece of scroll knowledge in the renderer already lives in this file, and
 * `paneSession.ts` has no unit tests. It is appended to a host *outside* the
 * scroller: an absolutely positioned child of a scroll container would anchor to
 * the bottom of the content rather than to the viewport.
 */
export interface TranscriptView {
  /**
   * `disclosure` is the pane's absolute answer for every group and step (§5.2).
   * `activity` is what the pane knows about the turn in flight — whether one is
   * running, when it started and which turn it is — and `model/waiting.ts` turns
   * that into 「which group is live」 and 「what the tail row reads」. `undefined`
   * is an idle session: no row is drawn.
   */
  render(state: TranscriptState, disclosure: DisclosureState, activity?: WaitingInput, selectedSubagent?: string): void
  /**
   * Stops the live status's clock.
   *
   * The row's elapsed time is the one thing in this view that changes without a
   * paint, so it is the one thing with a timer — and a pane that goes to the
   * background or is disposed keeps its DOM, so nothing else would ever stop it.
   * The next `render` starts it again from the same `startedAt`.
   */
  stopClock(): void
  dispose(): void
  /** Capture the reading position before the composer or another region resizes. */
  beginLayoutChange(): void
}

export interface TranscriptHandlers {
  /** `expanded` is what the row shows now, so the first click always inverts it. */
  onToggle(id: string, expanded: boolean): void
  /**
   * A `TodoWrite` row was clicked. It has no body — the checklist is drawn once,
   * above the composer — so the row's whole job is to point at it (§7.3).
   */
  onTaskStep(): void
  /** An `Agent` row was clicked: its run opens in the side panel, not in place. */
  onOpenSubagent(id: string): void
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
   * stub.
   */
  onCopy(text: string): void
  /**
   * A user message's 回退 button: `/rewind`, opened on that message's
   * checkpoint. Absent (the sub-agent panel) draws no button.
   */
  onRewind?(messageId: string): void
  /** A thread note card's 查看: open that thread's session. Absent draws the button inert. */
  onOpenThread?(threadId: string): void
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
  const feedback = new Map<string, StepFeedback>()
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
    const candidates = [...column.querySelectorAll<HTMLElement>('.step-head, .group-head, p, .md-code, .item')]
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

  function atTail(): boolean {
    if (isScrolledToBottom(container)) following = true
    return following
  }

  function followTail(): void {
    container.scrollTop = container.scrollHeight
  }

  // The live status's clock. The span is kept rather than looked up: the tail
  // row is a node reused by key like every other, so the element its fill built
  // is still the one on screen,
  // and it is only refilled when the status itself changed, which is exactly
  // when this is reassigned.
  let clockNode: HTMLElement | undefined
  let clock: ReturnType<typeof setInterval> | undefined
  let clockFrom: number | undefined

  function stopClock(): void {
    if (clock === undefined) return
    clearInterval(clock)
    clock = undefined
    clockFrom = undefined
  }

  function paintClock(startedAt: number): void {
    // Empty under the model's threshold: a short wait is not worth a number.
    if (clockNode) clockNode.textContent = waitingElapsedLabel(Date.now() - startedAt)
  }

  /**
   * 100ms, so the sub-second tenth `formatWorkedDuration` prints actually moves;
   * above a second the string only changes once a second and the extra writes
   * are `textContent` assignments to one span.
   *
   * Restarted only when the turn it counts changed, or a still-running clock
   * would be torn down and rebuilt once per repaint. `unref` is Node's, not the
   * browser's: it keeps a test process from being held open by a clock the view
   * legitimately still has running (`setInterval` returns a number in the
   * browser, where the call simply is not there).
   */
  function runClock(startedAt: number | undefined): void {
    if (startedAt === undefined || document.hidden) {
      stopClock()
      return
    }
    paintClock(startedAt)
    if (clock !== undefined && clockFrom === startedAt) return
    stopClock()
    clockFrom = startedAt
    clock = setInterval(() => paintClock(startedAt), 100)
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
  let observing = false

  function stopMotion(): void {
    stopClock()
    stopViewportMotion()
    for (const entry of feedback.values()) settleFeedback(entry)
    finishPresenceWithin(container)
    resizeObserver?.disconnect()
    observing = false
  }

  return {
    beginLayoutChange: () => beginLayoutChange(),
    stopClock: stopMotion,
    dispose() {
      stopMotion()
      window.removeEventListener('pointerup', endDrag)
      window.removeEventListener('pointercancel', endDrag)
      for (const entry of disclosures.values()) entry.presence.dispose()
      disclosures.clear()
      cache.clear()
      feedback.clear()
      refs.clear()
      seenDisclosures.clear()
    },
    render(state, disclosure, activity, selectedSubagent) {
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
        for (const entry of feedback.values()) settleFeedback(entry)
        feedback.clear()
        clockNode = undefined
        anchorId = undefined
        generation = state.generation
      }
      const atBottom = atTail()
      const before = guardedPosition ?? (!atBottom ? readingReference() : undefined)
      const wasSettled = anchorSettled
      const entries = groupTranscript(state.items)
      const live = turnActivity(entries, activity ?? IDLE)
      const focused = new Set<string>()
      const selected = new Set<string>()
      const selection = window.getSelection?.()
      for (const entry of entries) {
        const id = entry.kind === 'group' ? entry.group.turnId : entry.item.id
        const key = entry.kind === 'group' ? `group:${id}` : itemKey(entry.item)
        const node = cache.get(key)?.node
        if (!node) continue
        if (node.contains(document.activeElement)) focused.add(id)
        if (selection && !selection.isCollapsed
          && (node.contains(selection.anchorNode) || node.contains(selection.focusNode))) selected.add(id)
      }
      const resolvedDisclosure = resolveDisclosure(entries, disclosure, live.liveGroupId)
      const afterPaint: Array<() => void> = []
      const painter = createPainter(cache, refs, feedback, disclosures, seenDisclosures, resolvedDisclosure, {
        ...handlers,
        onToggle(id, expanded) {
          const head = cache.get(`head:${id}`)?.node ?? cache.get(`thinking-head:${id}`)?.node
            ?? cache.get(`tool-head:${id}`)?.node ?? cache.get(`loose-thinking-head:${id}`)?.node
          beginLayoutChange(head)
          handlers.onToggle(id, expanded)
        },
      }, {
        liveGroupId: live.liveGroupId,
        startedAt: activity?.startedAt,
        selectedSubagent,
        keepClock: (span) => { clockNode = span },
        afterPaint: (run) => afterPaint.push(run),
      })
      const nodes = entries.map((entry) => entryNode(painter, entry))
      // Built before `prune`, or its key would count as dead on the very paint
      // that asked for it. A kept row keeps the span its fill handed over.
      if (live.row) nodes.push(waitingNode(painter, live.row))
      else clockNode = undefined
      painter.prune()
      reconcile(column, nodes)
      for (const run of afterPaint) run()
      runClock(live.row ? activity?.startedAt : undefined)

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
      // The pane's own flag rather than anything `turnActivity` decided:
      // `model/waiting.ts` reports `IDLE` while a draft is arriving — it means
      // 「no waiting row to draw」 there — and a pad released mid-answer would
      // drop the question the reader is watching being answered.
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
        anchorFirst = at === 0
        const lift = liftAnchor(container, column, nodes[at]!, { first: at === 0, moved, settled, pad, holdPadding: anchorHoldPadding })
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

/** An idle session: no turn, no clock, no live head. */
const IDLE: WaitingInput = { isStreaming: false, startedAt: undefined, turnId: undefined }

/**
 * The live status row: a breathing bead, the label, the elapsed time and the
 * interrupt key, on one line at the tail of the transcript, for the whole turn.
 *
 * What is announced and what is not follows the rest of this file: `.transcript`
 * is `aria-live="polite"`, so the label is spoken only in the gap before the
 * first step (`WaitingRow.announce`) — once it follows the turn from tool to
 * tool, each step's own head says what is new — and the counter is `aria-hidden` or a
 * screen reader would read a new number ten times a second. The bead is
 * `aria-hidden` for the same reason the step beads are: it is decoration over a
 * state the label already says in words. The hint is hidden too — `Esc` is
 * discoverable to the keyboard user without being read out mid-answer.
 */
function waitingNode(painter: Painter, row: WaitingRow): HTMLElement {
  return painter.node('waiting', 'waiting', [row.label, row.hint, row.startedAt, row.announce], () => [
    ...liveParts(painter, 'waiting', row.label, row.hint, row.announce),
  ])
}

/**
 * The live status's four pieces.
 *
 * The elapsed span starts empty rather than at 「0s」: the view's clock fills it
 * on the same tick it starts, and a hard-coded first value would be the one
 * string here that could disagree with `formatWorkedDuration`. It also *stays*
 * empty until the wait passes `waitingElapsedLabel`'s threshold, which is why the
 * sheet hides an empty counter rather than leaving its gap behind.
 */
function liveParts(painter: Painter, key: string, label: string, hint: string, announce = true): HTMLElement[] {
  const part = (name: string, text: string, hidden = true): HTMLElement => painter.node(
    `${key}:${name}`, `waiting-${name}`, [text, hidden], (node) => {
      if (hidden) node.setAttribute('aria-hidden', 'true')
      return name === 'label' ? [text, sheenNode(text)] : [text]
    }, () => el('span'),
  )
  const bead = part('bead', '')
  const elapsed = part('elapsed', '')
  painter.keepClock(elapsed)
  return [bead, part('label', label, !announce), elapsed, part('hint', hint)]
}

/**
 * The label's sheen: a window sliding over the words that shows them again in
 * the brighter colour. Its copy is generated content (`attr(data-label)`), so
 * the label's text and accessible name stay the words once.
 */
function sheenNode(text: string): HTMLElement {
  const node = el('span', 'waiting-sheen')
  node.dataset.label = text
  node.setAttribute('aria-hidden', 'true')
  return node
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
  /** The id a click answers under, when it is not the row's own (a live thought). */
  id?: string
}

interface StepFeedback {
  status: string
  readonly node: HTMLElement
  timer?: ReturnType<typeof setTimeout>
}

function settleFeedback(entry: StepFeedback): void {
  clearTimeout(entry.timer)
  entry.timer = undefined
  entry.node.classList.remove('completing')
}

/** What this paint knows about the turn in flight, for the head that shows it. */
interface LivePaint {
  readonly liveGroupId: string | undefined
  readonly startedAt: number | undefined
  /** The `Agent` row whose run the side panel is showing. */
  readonly selectedSubagent: string | undefined
  /** Handed the elapsed span whichever carrier built it, so the clock can fill it. */
  keepClock(span: HTMLElement): void
  afterPaint(run: () => void): void
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
  ref(key: string, expanded: boolean, id?: string): DisclosureRef
  feedback(key: string, node: HTMLElement, status: string): void
  disclose(key: string, expanded: boolean, head: HTMLElement, body: () => HTMLElement | undefined): HTMLElement | undefined
  prune(): void
}

function createPainter(
  cache: Map<string, CachedNode>,
  refs: Map<string, DisclosureRef>,
  feedback: Map<string, StepFeedback>,
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
    liveGroupId: paint.liveGroupId,
    startedAt: paint.startedAt,
    selectedSubagent: paint.selectedSubagent,
    keepClock: paint.keepClock,
    afterPaint: paint.afterPaint,
    onToggle: handlers.onToggle,
    onTaskStep: handlers.onTaskStep,
    onOpenSubagent: handlers.onOpenSubagent,
    onOpenPath: handlers.onOpenPath,
    onViewImage: handlers.onViewImage,
    imageThumbUrl: handlers.imageThumbUrl,
    onCopy: handlers.onCopy,
    onRewind: handlers.onRewind,
    onOpenThread: handlers.onOpenThread,
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
    ref(key, expanded, id) {
      const existing = refs.get(key)
      if (existing) {
        existing.expanded = expanded
        existing.id = id
        return existing
      }
      const created = { expanded, id }
      refs.set(key, created)
      return created
    },
    feedback(key, node, status) {
      const previous = feedback.get(key)
      if (!previous) {
        const entry: StepFeedback = { node, status }
        feedback.set(key, entry)
        node.addEventListener('animationend', (event) => {
          if (event.target === node && event.animationName === 'bead-pop') settleFeedback(entry)
        })
        return // History and first paint initialise; they are never completions.
      }
      const completing = previous.status === 'running' && (status === 'done' || status === 'failed')
      previous.status = status
      if (!completing) return
      settleFeedback(previous)
      node.classList.add('completing')
      previous.timer = setTimeout(() => settleFeedback(previous), motionDelay(STEP_COMPLETION_FALLBACK_MS))
      ;(previous.timer as unknown as { unref?: () => void }).unref?.()
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
      // Keyed by the group's own node key, so a turn that left the transcript
      // takes its head's state with it.
      for (const key of [...refs.keys()]) {
        if (!live.has(key)) refs.delete(key)
      }
      for (const [key, entry] of feedback) {
        if (live.has(key)) continue
        settleFeedback(entry)
        feedback.delete(key)
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

function entryNode(painter: Painter, entry: TranscriptEntry): HTMLElement {
  return entry.kind === 'group' ? groupNode(painter, entry.group) : itemNode(painter, entry.item)
}

/**
 * A turn as one group: a head that summarises it, and its steps.
 *
 * Three kept nodes rather than one, and the split is what stops the fold from
 * replaying: the group's signature is the *identity* of its own two children, so a
 * paint that changed nothing inside touches nothing here, and a paint that
 * rebuilt the head re-inserts the head alone — the steps box, and every animation
 * and scroll anchor under it, is left where it stands.
 *
 * The head used to be rebuilt unconditionally, because it closes over the
 * disclosure it reports. It keeps itself now and reads that through
 * `painter.ref`, so a reader who has tabbed to it does not lose focus once per
 * streamed token.
 */
function groupNode(painter: Painter, group: ActivityGroup): HTMLElement {
  const live = painter.liveGroupId === group.turnId
  const expanded = isGroupExpanded(group, painter.disclosure, live)
  const classes = ['activity-group', live ? 'running' : group.status]
  if (live) classes.push('live')
  if (!expanded) classes.push('collapsed')
  const head = groupHead(painter, group, expanded, live)
  const steps = painter.disclose(`steps:${group.turnId}`, expanded, head, () => stepsNode(painter, group))
  return painter.node(`group:${group.turnId}`, classes.join(' '), [head, steps], () => [head, steps])
}

/** The steps box, kept so its children are not re-inserted with their group. */
function stepsNode(painter: Painter, group: ActivityGroup): HTMLElement {
  const steps = group.steps.map((step, index) => stepNode(painter, group, step, index))
  return painter.node(`steps:${group.turnId}`, 'group-steps', steps, () => steps)
}

/**
 * The turn's head: 「工作中 · N 步」 while the turn runs, sealing to
 * `groupHeaderLabel`'s 「已处理 …」 when it ends.
 *
 * Deliberately quiet while live — no bead, no clock. The live status is the
 * transcript's last row (`waitingNode`), where the reader following the tail can
 * see it; a second copy up here scrolled out of view on every long turn and
 * repeated 「正在思考」 right above the thinking step that already said it.
 */
function groupHead(painter: Painter, group: ActivityGroup, expanded: boolean, live: boolean): HTMLElement {
  const ref = painter.ref(`group:${group.turnId}`, expanded)
  const name = groupHeaderName(group, live)
  const label = live ? groupRunningLabel(group) : groupHeaderLabel(group)
  const counts = live ? groupRunningLabel(group, false) : groupHeaderLabel(group, false)
  const failures = groupFailureLabel(group)
  return painter.node(
    `head:${group.turnId}`,
    live ? 'group-head live' : 'group-head',
    [name, label, expanded, live],
    (head) => {
      // `button()` writes these at build time only, and this node outlives the
      // turn's status: a sealed group's name is not the running one's.
      head.title = label
      head.setAttribute('aria-label', name)
      head.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      // The label is a child rather than `button()`'s own so it can be
      // `aria-hidden`: a live one's step count moves as the turn works, and this
      // subtree sits in an `aria-live` region (§8). The name is
      // `groupHeaderName`'s stable one instead. The chevron is the fold said in a
      // shape: a folded turn's head is a quiet line that did not read as a switch.
      return [
        quiet('btn-label', counts),
        failures === undefined ? undefined : quiet('group-failures', failures),
        icon('chevron-right'),
      ]
    },
    () => button('group-head', '', name, () => painter.onToggle(group.turnId, ref.expanded)),
  )
}

function stepPending(step: ActivityStep): boolean {
  return 'pending' in step && step.pending === true
}

/**
 * The bead — the tool's only *visual* status vocabulary (§3), which is exactly
 * why it is `aria-hidden`: the state also reaches the accessible name of the head
 * in words, because colour may not be the only carrier.
 */
function bead(step: ActivityStep, className: string): HTMLElement {
  const node = el('span', `${className} ${beadStatus(step)}`)
  node.setAttribute('aria-hidden', 'true')
  return node
}

function beadStatus(step: ActivityStep): string {
  return 'status' in step ? step.status : stepPending(step) ? 'running' : 'done'
}

// --- steps -------------------------------------------------------------------

function stepNode(painter: Painter, group: ActivityGroup, step: ActivityStep, index: number): HTMLElement {
  const expanded = isStepExpanded(group, index, painter.disclosure)
  switch (step.kind) {
    case 'thinking':
      return thinkingStep(painter, step, expanded)
    case 'tool':
    case 'subagent':
      return toolStep(painter, step, expanded)
    case 'task':
      return taskStep(painter, step)
    case 'text':
      // Staged prose: full markdown, shown whole, never folded (§4.4).
      return painter.node(`text:${step.id}`, 'step text md', [step.text], (node) => markdownChildren(step.text, node))
    case 'system':
      return painter.node(
        `step:${step.id}`,
        step.failed === true ? 'step system failed' : 'step system',
        [step.text],
        () => [el('span', 'step-label', step.text), rule()],
      )
  }
}

/**
 * A `TodoWrite` row: one line, no body, ever (§4.4). The checklist it wrote is
 * drawn once — above the composer, where it stays useful after the group folds —
 * so clicking the row flashes *that* panel rather than repeating the list here.
 *
 * A `<button>` with no `aria-expanded`, because nothing here opens: the row is a
 * pointer, not a disclosure.
 */
function taskStep(painter: Painter, step: Extract<ActivityStep, { kind: 'task' }>): HTMLElement {
  return painter.node(`step:${step.id}`, `step task ${step.status}`, [step.text, step.status], () => {
    const label = `${step.text} · ${toolStatusLabel(step.status)}`
    const head = button('step-head', '', label, () => painter.onTaskStep())
    append(head, [bead(step, 'step-bead'), el('span', 'step-label', step.text)])
    return [head]
  })
}

/**
 * A thinking step: no bead — it is not an execution and has no outcome (§3).
 *
 * The hairline is the *live* row's status and only that: while the thought is
 * still arriving it runs from the label to the chevron with a sheen travelling
 * along it, and the moment the thought seals it is gone, leaving the time the
 * model spent (when the live stream measured one) at the row's right end.
 *
 * The body is always drawn. Folded, it is a two-line preview of the thought's
 * *opening* — stable while tokens arrive, so the row does not grow or scroll
 * under the reader — cut with an ellipsis; open, it is the whole text, capped in
 * height and scrolling inside itself like a tool's output. Clicking the preview
 * opens it too; clicking open text does not fold it, or selecting a sentence
 * would.
 *
 * The head is a **kept node**, which is what makes the sheen watchable. Its own
 * signature is the label, the disclosure and the live flag — none of which move
 * while tokens arrive — so the row's growing text refills the body underneath a
 * head that stays put. Rebuilding it per delta, as it did before, would take the
 * hairline out of the document and restart its running cycle ten times a second,
 * which is the same reason the group's head is kept (§8).
 */
function thinkingStep(painter: Painter, step: Extract<ActivityStep, { kind: 'thinking' }>, expanded: boolean): HTMLElement {
  const classes = ['step', 'thinking']
  const live = step.pending === true
  if (live) classes.push('live')
  if (!expanded) classes.push('collapsed')
  // Fields rather than the step object: `toStep` mints a new one on every paint,
  // so an object identity would mean 「always different」 and no reuse at all. The
  // strings it carries *are* the item's own, so `===` still settles in one compare.
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, step.durationMs, expanded, live], () => {
    // Not 「正在思考」 while live: inside a group the tail row already says that,
    // one line below, and the hairline is this head's own sign of life.
    const label = THINKING_DONE_FALLBACK
    const duration = thinkingDurationLabel(step)
    const name = thinkingHeaderName(label, duration)
    // The kept head outlives the paint that built it, so its click reads the
    // disclosure from the mutable ref rather than from a closed-over boolean.
    //
    // Keyed by the *head's own node key*, and that is load-bearing: `prune()`
    // drops every ref whose key no `node()` call claimed this paint, so a ref
    // under a key of its own is thrown away and rebuilt every render — leaving
    // the head holding the first paint's object, forever reporting 「folded」.
    const headKey = `thinking-head:${step.id}`
    const ref = painter.ref(headKey, expanded, thinkingDisclosureId(step))
    const head = painter.node(
      headKey,
      'step-head thinking-step-head',
      [name, expanded, live],
      (node) => {
        // `button()` writes these at build time only, and this node outlives the
        // label it was built with: the time lands once the thought seals.
        node.title = name
        node.setAttribute('aria-label', name)
        node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
        return [
          el('span', 'btn-label', label),
          icon('chevron-right'),
          live ? rule() : duration === undefined ? undefined : quiet('step-duration', duration),
        ]
      },
      () => button('step-head thinking-step-head', '', label, () => painter.onToggle(ref.id!, ref.expanded)),
    )
    return [head, thinkingText(painter, `thinking-body:${step.id}`, 'step-body', step.text, expanded, live, ref)]
  })
}

/**
 * The thought itself, shared by the step and the loose block: the whole text while
 * open; folded, a preview while it streams (CSS clamps it) and nothing once it
 * seals. The node is kept across the fold so the toggle is a class change, not a
 * rebuild.
 */
function thinkingText(
  painter: Painter,
  key: string,
  base: string,
  text: string,
  expanded: boolean,
  live: boolean,
  ref: DisclosureRef,
): HTMLElement {
  const fold = expanded ? '' : live ? ' preview' : ' folded'
  return painter.node(key, `${base} thinking-text${fold}`, [text], (node) => {
    node.textContent = text
    return [...node.childNodes]
  }, () => {
    const node = el('div', '')
    node.addEventListener('click', () => {
      if (!ref.expanded) painter.onToggle(ref.id!, false)
    })
    return node
  })
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
  // A capped patch's counts are partial — `+0 −17` on a whole-file rewrite
  // whose adds were cut — so the suffix stays off rather than lying. A search
  // list is never capped by the parser (only by the tool itself, which says so
  // in the notice), so its counts are the list's own and always honest.
  if (family.patch !== undefined && !family.patch.capped) return patchStats(family.patch)
  if (family.found !== undefined) return searchStats(family.found)
  if (family.rows !== undefined) return readStats(family.rows)
  return agentStats(family.agent)
}

function toolStep(painter: Painter, step: ToolLike, disclosed: boolean): HTMLElement {
  const status = step.kind === 'tool' ? step.status : step.pending === true ? 'running' : 'done'
  // A sub-agent's run lives in the side panel; its row is a link there, never a fold.
  const agent = step.kind === 'tool' && step.toolName === AGENT_TOOL
  const expanded = disclosed && !agent
  const selected = agent && painter.selectedSubagent === step.id
  const classes = ['step', step.kind, status]
  if (!expanded) classes.push('collapsed')
  if (selected) classes.push('selected')
  // `step.tool` is the item's own detail object, so it changes reference exactly
  // when the result merges in — see `thinkingStep` for why not the step itself.
  const detail = step.kind === 'tool' ? step.tool : undefined
  return painter.node(`step:${step.id}`, classes.join(' '), [step.text, detail, status, expanded, selected], () => {
    const family = familyData(step)
    const live = subagentLive(step, status)
    // A running sub-agent has no run record yet; its live count stands in.
    const stats = familyStats(family) ?? (live === undefined ? undefined : `${live.toolCount} 工具`)
    const beadKey = `tool-bead:${step.id}`
    const statusBead = painter.node(beadKey, `step-bead ${status}`, [status], (node) => {
      node.setAttribute('aria-hidden', 'true')
      return []
    }, () => el('span'))
    painter.feedback(beadKey, statusBead, status)
    const headKey = `tool-head:${step.id}`
    const ref = painter.ref(headKey, expanded)
    const name = stepAccessibleName(step, status, stats)
    const head = painter.node(headKey, 'step-head', [name, detail, step.text, expanded, selected], (node) => {
      node.title = name
      node.setAttribute('aria-label', name)
      if (agent) node.setAttribute('aria-pressed', selected ? 'true' : 'false')
      else node.setAttribute('aria-expanded', expanded ? 'true' : 'false')
      return [statusBead, ...headParts(step, stats)]
    }, () => button('step-head', '', name, () => {
      if (agent) painter.onOpenSubagent(step.id)
      else painter.onToggle(step.id, ref.expanded)
    }))
    const bodyKey = `tool-body:${step.id}`
    const body = painter.disclose(bodyKey, expanded, head, () => {
      const content = stepBody(step, family, painter)
      return content ? painter.node(bodyKey, 'step-body', [step.text, detail], () => [...content.childNodes]) : undefined
    })
    return [head, live === undefined ? undefined : liveLine(live), body]
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
 * `Read` + `src/a.ts` + the result's own suffix + the call's elapsed time — the
 * head reads left to right as 「什么工具、对什么、结果如何、花了多久」 (§4.5).
 * The families insert their own counts where a suffix would sit, because for
 * those tools the counts *are* the result's note.
 */
function headParts(step: ToolLike, stats: string | undefined): Child[] {
  if (step.kind === 'subagent') return [el('span', 'step-name', step.text)]
  const { displayName, useSummary, headerSuffix, durationMs } = step.tool
  // The Agent family's suffix is one unit — `opus · 12 工具` — built from the
  // run's own record, which names the same model the result's `headerSuffix`
  // carries. While the unit stands, the generic suffix stands down; keeping
  // both would say `opus` twice on one row.
  const agentUnit = step.kind === 'tool' && step.toolName === AGENT_TOOL && stats !== undefined
  const agentType = step.toolName === AGENT_TOOL ? step.tool.agentType : undefined
  return [
    el('span', 'step-name', displayName),
    agentType === undefined ? undefined : el('span', 'step-tag', agentType),
    useSummary ? el('span', 'step-summary', useSummary) : undefined,
    stats === undefined ? undefined : el('span', 'step-suffix', stats),
    headerSuffix === undefined || agentUnit ? undefined : el('span', 'step-suffix', headerSuffix),
    // Under a second is not worth a number: every quick Read would carry a `0s`.
    durationMs === undefined || durationMs < 1000
      ? undefined
      : el('span', 'step-duration', formatWorkedDuration(durationMs)),
  ]
}

/** The state in words, because the bead is `aria-hidden` and colour is not a name. */
function stepAccessibleName(step: ToolLike, status: string, stats: string | undefined): string {
  const label = toolStatusLabel(status as Parameters<typeof toolStatusLabel>[0])
  if (step.kind === 'subagent') return `${step.text} · ${label}`
  const { displayName, useSummary, headerSuffix } = step.tool
  // The same stand-down as `headParts`: the Agent family's suffix unit already
  // names the model the `headerSuffix` would repeat.
  const agentUnit = step.toolName === AGENT_TOOL && stats !== undefined
  return [displayName, useSummary, stats, agentUnit ? undefined : headerSuffix, label]
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
function stepBody(step: ToolLike, family: FamilyData, painter: Painter): HTMLElement | undefined {
  if (step.kind === 'subagent') return el('div', 'step-body', step.text)
  if (family.patch !== undefined) return el('div', 'step-body', diffNode(family.patch.rows))
  if (family.found !== undefined) return el('div', 'step-body', searchBody(family.found, painter))
  const terminal = shellOutput(step)
  if (terminal !== undefined) {
    const { errorCode } = step.tool
    const error = errorCode === undefined ? undefined : TOOL_ERROR_LABELS[errorCode]
    // The shell's `(no output)` placeholder is not output: one line, no empty box.
    if (terminal.trim() === SHELL_NO_OUTPUT) {
      return el('div', 'step-body', el('div', error === undefined ? 'step-body-head' : 'step-error',
        error === undefined ? '无输出' : `${error}，无输出`))
    }
    return el(
      'div',
      'step-body',
      error === undefined ? undefined : el('div', 'step-error', error),
      el('pre', 'step-terminal', terminal),
    )
  }
  if (family.rows !== undefined) {
    return el('div', 'step-body', el('div', 'step-code', ...family.rows.map((row) => el(
      'div',
      'step-code-row',
      el('span', 'step-code-line', String(row.line)),
      el('span', 'step-code-text', row.text),
    ))))
  }
  const web = webBody(step)
  if (web !== undefined) return web
  const { resultSummary, detail, content } = step.tool
  const text = detail ?? content
  if (resultSummary === undefined && (text === undefined || text.length === 0)) return undefined
  return el(
    'div',
    'step-body',
    resultSummary === undefined ? undefined : el('div', 'step-body-head', resultSummary),
    // Clipping is the stylesheet's (T8): `max-height` plus scrolling *inside* the
    // block, so a long output never turns the group itself into a scroll window.
    text === undefined || text.length === 0 ? undefined : el('pre', 'step-body-text', text),
  )
}

/**
 * The web family's body: the fetched page as the markdown the tool already
 * made of it. A failed fetch is the fallback body's to draw, under the step's
 * `failed` class — the family only claims results that are prose.
 */
function webBody(step: ToolLike): HTMLElement | undefined {
  if (step.kind !== 'tool' || step.failed === true) return undefined
  if (step.toolName === undefined || !WEB_TOOLS.has(step.toolName)) return undefined
  const { resultSummary, content } = step.tool
  if (content === undefined || content.length === 0) return undefined
  return el(
    'div',
    'step-body',
    resultSummary === undefined ? undefined : el('div', 'step-body-head', resultSummary),
    el('div', 'step-web md', ...markdownChildren(content)),
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

/** The hairline that stands in for a bead on a row that has no outcome (§3). */
function rule(): HTMLElement {
  const node = el('span', 'step-rule')
  node.setAttribute('aria-hidden', 'true')
  return node
}

// --- loose items -------------------------------------------------------------

/** Text can become a staged step after a tool call; its carrier stays the same. */
function itemKey(item: TranscriptItem): string {
  return `${item.kind === 'assistant' ? 'text' : 'item'}:${item.id}`
}

function itemNode(painter: Painter, item: TranscriptItem): HTMLElement {
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
    return painter.node(key, `${classes.join(' ')} md`, [item.text, item.model, item.createdAt], (node) => [
      ...markdownChildren(item.text, node),
      metaRow(painter, item),
    ])
  }
  if (item.kind === 'thinking') return looseThinkingNode(painter, item, classes, key)
  if (item.kind === 'thread-notes' && item.threadNotes) return threadNotesNode(painter, item, classes, key)
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
    return painter.node(
      key,
      classes.join(' '),
      [item.text, item.createdAt, item.images, thumbs],
      () => [
        item.images !== undefined && item.images.length > 0
          ? el('div', 'user-images', ...item.images.map((image, index) =>
            imageTileNode(painter, image, index)))
          : undefined,
        el('div', 'user-bubble', ...userParts(item)),
        metaRow(painter, item),
      ],
    )
  }
  return painter.node(key, classes.join(' '), [item.text], () => [item.text])
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
function metaRow(painter: Painter, item: TranscriptItem): HTMLElement | undefined {
  const time = formatMessageTime(item.createdAt)
  const model = item.kind === 'assistant' ? item.model : undefined
  // A draft has no stamp of its own; copying half a sentence is not the offer.
  if (time === undefined && model === undefined) return undefined
  const copy = button('item-copy', '', '复制', () => painter.onCopy(item.text), { icon: 'copy' })
  const onRewind = painter.onRewind
  const rewind = item.kind === 'user' && onRewind
    ? button('item-rewind', '', '回退到此消息之前', () => onRewind(item.id), { icon: 'rewind' })
    : undefined
  return el(
    'div',
    'item-meta',
    copy,
    rewind,
    model === undefined ? undefined : quiet('item-model', model),
    time === undefined ? undefined : quiet('item-time', time),
  )
}

/** A meta label: visible, and out of the live region's announcements. */
function quiet(className: string, text: string): HTMLElement {
  const node = el('span', className, text)
  node.setAttribute('aria-hidden', 'true')
  return node
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
function userParts(item: TranscriptItem): Child[] {
  return splitFileMentions(item.text).map((segment) =>
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

/**
 * A thinking block from a record with no `turnId` — it joins no group, so it keeps
 * the standalone disclosure it has always had.
 */
function looseThinkingNode(
  painter: Painter,
  item: TranscriptItem,
  classes: string[],
  key: string,
): HTMLElement {
  const expanded = isLooseThinkingExpanded(item, painter.disclosure)
  if (!expanded) classes.push('collapsed')
  // Driven by the item, never by `TranscriptState.isThinking`: that flag goes false
  // on `thinking_stop` while the block is still arriving.
  if (item.pending === true) classes.push('live')
  return painter.node(key, classes.join(' '), [item.text, item.pending, item.durationMs, expanded], () => {
    const label = thinkingHeaderLabel(item)
    const duration = thinkingDurationLabel(item)
    const name = thinkingHeaderName(label, duration)
    // 「思考过程 `⌵` 12s」 (design_guidance 四.3): the glyph follows the label and
    // still flips to point up while the block is open — that rule matches on the
    // class, not on the position.
    const headKey = `loose-thinking-head:${item.id}`
    const ref = painter.ref(headKey, expanded, thinkingDisclosureId(item))
    const header = painter.node(headKey, 'thinking-header', [name, expanded], (node) => {
      node.setAttribute('aria-expanded', String(expanded))
      node.setAttribute('aria-label', name)
      node.title = name
      return [
        el('span', 'btn-label', label),
        icon('chevron-down'),
        duration === undefined ? undefined : quiet('thinking-duration', duration),
      ]
    }, () => button('thinking-header', '', label, () => painter.onToggle(ref.id!, ref.expanded)))
    return [header, thinkingText(painter, `loose-thinking-body:${item.id}`, 'thinking-body', item.text, expanded, item.pending === true, ref)]
  })
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
  // The scroller's leading padding, which is also its trailing one: `.transcript`
  // gives its two vertical insets in one value, and `rendererStyleTokens` keeps
  // it that way. Measured rather than named, so a retuned inset needs no edit
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
