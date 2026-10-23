/**
 * Where a new turn sits: the arithmetic behind the transcript's bottom pad.
 *
 * Sending a message used to squeeze the turn into whatever height was left under
 * the previous one — `.transcript-column`'s `margin-top: auto` pins a short
 * conversation against the composer, so the bubble appeared at the bottom of the
 * canvas and the answer had a few lines to grow into. The turn in flight is the
 * thing the reader is actually looking at, so it should own the screen: the new
 * bubble rises to the top of the viewport and the answer streams down the empty
 * canvas below it.
 *
 * A scroller cannot scroll past its content, so lifting the last bubble to the
 * top means putting something under it. That something is the reading column's
 * bottom padding — a written number rather than a spacer element, because a new
 * last child would be a scroll-anchor candidate and the sheet's
 * `overflow-anchor` invariant forbids switching that off to compensate. It
 * travels as a custom property, the same door `--context-ratio` uses: the
 * declaration and its fallback stay in the stylesheet, and only the number no
 * stylesheet can compute comes from here.
 *
 * This file owns the number and nothing else. Pure and DOM-free like the rest of
 * `model/`; `dom/transcriptView.ts` does the measuring and the writing.
 */

/**
 * The gap above the anchor when it is the session's first message. There is
 * nothing above it to reveal, so this is the scroller's own top padding and
 * nothing else: the first message is *already* laid out that far down, and
 * scrolling it any higher would mean sending it visibly nudged the bubble up by
 * a few pixels for no reason the reader could name.
 */
export const ANCHOR_TOP_FIRST_PX = 8
/**
 * …and the gap when something precedes it. A line or two of the previous answer
 * stays visible, which is what makes the jump read as a scroll rather than as
 * the conversation having been wiped.
 */
export const ANCHOR_TOP_PX = 64
/**
 * The pad never falls below this *while a turn runs*, however long the answer
 * gets. It is breathing room under a moving tail: the last line of a
 * full-screen answer keeps its distance from the composer while more of it is
 * still arriving.
 */
export const ANCHOR_FLOOR_PX = 96
/**
 * …and where the pad rests once the turn is over.
 *
 * A quarter of the streaming floor, because the two are not the same gap. The
 * floor is clearance under text that is still moving; this is the margin at the
 * end of a conversation that has stopped, and there it reads as the transcript's
 * own bottom inset rather than as room for anything. Anything larger is blank
 * the reader has to scroll through to reach nothing.
 *
 * The pad therefore *does* shorten at the end of a turn, which it used not to.
 * That shortening is a sink rather than a jump: `.transcript-column.settling`
 * transitions `padding-bottom`, and a scroller pinned to its end follows the
 * shrinking content down one frame at a time.
 */
export const ANCHOR_REST_PX = 24

/** The custom property `.transcript-column`'s `padding-bottom` reads. */
export const TRANSCRIPT_PAD_VARIABLE = '--transcript-pad'

export interface AnchorMetrics {
  /** The scroller's `clientHeight`. */
  readonly viewport: number
  /**
   * From the anchor's top edge to the end of the scrollable area, in px — the
   * scroller's own trailing padding included, and the pad already written
   * excluded.
   */
  readonly below: number
  /** `ANCHOR_TOP_FIRST_PX` or `ANCHOR_TOP_PX`. */
  readonly topGap: number
  /**
   * Whether no turn is in flight. A settled transcript is not holding a
   * question up for an answer that is still coming, so it rests on
   * `ANCHOR_REST_PX` and the measurements above go unread.
   */
  readonly settled?: boolean
}

/**
 * The reading column's `padding-bottom`.
 *
 * The anchor sits `topGap` below the scroller's top once the scroller is at its
 * end, which is to say when `maxScrollTop === anchorTop - topGap`. A scroller's
 * `maxScrollTop` is `contentHeight + pad - viewport`, and `below` is
 * `contentHeight - anchorTop`, so the two together give
 * `pad = viewport - topGap - below` — no `anchorTop` in the answer, which is why
 * the caller never has to measure one.
 *
 * That value shrinks by exactly as much as the answer grows, which is what keeps
 * the bubble still while a turn streams: the scroller is at its end after the
 * anchored scroll, so every later frame follows the tail into a pad that is
 * getting shorter at the same rate. The floor is where the two part company, and
 * from there the answer scrolls the bubble off the top like any other content.
 *
 * `settled` short-circuits all of it, down to `ANCHOR_REST_PX`. The room above
 * only has to exist while something is being waited for; once the turn is over
 * the arithmetic is describing a question nobody is watching arrive, and what it
 * leaves behind is a screenful of blank between the last line and the composer.
 */
export function anchorPadding(metrics: AnchorMetrics): number {
  const { viewport, below, topGap } = metrics
  if (metrics.settled === true) return ANCHOR_REST_PX
  // A measurement that is not a number means the caller has no layout to reason
  // about — mid-animation, or a pane that has never been on screen. The floor is
  // the honest answer there: it is the one part of the pad that does not depend
  // on where anything is.
  if (!Number.isFinite(viewport) || !Number.isFinite(below) || !Number.isFinite(topGap)) {
    return ANCHOR_FLOOR_PX
  }
  return Math.max(ANCHOR_FLOOR_PX, Math.round(viewport - topGap - below))
}

/**
 * The gap to leave above the anchor. `first` is whether the anchor is the very
 * first thing in the transcript — spelled here rather than at the call site so
 * the two constants are only ever read together.
 */
export function anchorTopGap(first: boolean): number {
  return first ? ANCHOR_TOP_FIRST_PX : ANCHOR_TOP_PX
}

export type ViewportEvent = 'new-question' | 'stream' | 'tool-gap' | 'reading'
  | 'disclosure' | 'resize' | 'turn-end' | 'return-latest' | 'activate' | 'layout'
export type ViewportAction = 'none' | 'follow-tail' | 'locate-anchor' | 'preserve-anchor'

/** One policy for all viewport changes. Content growth never queues smooth
 * scrolling; explicit return-to-latest is immediate and has no tail animation
 * left to fight a wheel, drag, or second navigation. */
export function viewportPolicy(input: {
  event: ViewportEvent
  atBottom: boolean
  streaming: boolean
  measurable: boolean
}): ViewportAction {
  switch (input.event) {
    case 'new-question':
      return !input.measurable ? 'none' : input.streaming ? 'locate-anchor' : 'follow-tail'
    case 'return-latest':
      return 'follow-tail'
    case 'stream':
    case 'tool-gap':
    case 'turn-end':
      return input.atBottom ? 'follow-tail' : 'preserve-anchor'
    case 'reading':
    case 'disclosure':
    case 'resize':
    case 'activate':
    case 'layout':
      return 'preserve-anchor'
  }
}

export interface VerticalBox {
  readonly top: number
  readonly bottom: number
}

/**
 * Which reading candidate holds the reader's place: the first whose top lies
 * inside the viewport, else the first that straddles it.
 *
 * Candidates come in document order, so their tops only grow, and the first
 * case is a binary search: a long session used to pay one layout read per
 * candidate on every scroll event. `boxAt` is undefined for a node with no box
 * (hidden, or a test without layout); those are skipped, never compared. The
 * straddling fallback stays a scan — it only runs when no line starts on
 * screen, which takes one block taller than the viewport.
 */
export function readingCandidate(
  count: number,
  boxAt: (index: number) => VerticalBox | undefined,
  viewport: VerticalBox,
): number | undefined {
  const boxed = (from: number, to: number): number | undefined => {
    for (let index = from; index < to; index++) if (boxAt(index)) return index
    return undefined
  }
  // Invariant: every boxed index below `low` starts above the viewport, and
  // every boxed index from `high` on starts at or below its top.
  let low = 0
  let high = count
  while (low < high) {
    const middle = (low + high) >>> 1
    const probe = boxed(middle, high)
    if (probe === undefined) {
      high = middle
      continue
    }
    if (boxAt(probe)!.top < viewport.top) low = probe + 1
    else high = middle
  }
  const first = boxed(low, count)
  if (first !== undefined && boxAt(first)!.top < viewport.bottom) return first
  for (let index = 0; index < count; index++) {
    const rect = boxAt(index)
    if (rect && rect.bottom > viewport.top && rect.top < viewport.bottom) return index
  }
  return undefined
}
