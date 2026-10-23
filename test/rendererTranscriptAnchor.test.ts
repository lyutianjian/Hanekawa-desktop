import test from 'node:test'
import assert from 'node:assert/strict'

import {
  anchorPadding,
  anchorTopGap,
  ANCHOR_FLOOR_PX,
  ANCHOR_REST_PX,
  ANCHOR_TOP_FIRST_PX,
  ANCHOR_TOP_PX,
  readingCandidate,
  TRANSCRIPT_PAD_VARIABLE,
  viewportPolicy,
  type ViewportEvent,
} from '../src/desktop/renderer/model/transcriptAnchor.js'

/**
 * The transcript's bottom pad, as arithmetic.
 *
 * Pure, and deliberately the main coverage for this behaviour: the DOM half in
 * `dom/transcriptView.ts` is three `getBoundingClientRect` reads and one
 * `setProperty`, while every judgement about *where a turn sits* is here.
 */

test('one viewport policy covers new questions, streaming, reading, disclosure and layout', () => {
  const input = { atBottom: true, streaming: true, measurable: true }
  assert.equal(viewportPolicy({ ...input, event: 'new-question' }), 'locate-anchor')
  assert.equal(viewportPolicy({ ...input, event: 'new-question', measurable: false }), 'none', 'defer the single placement until measurable')
  assert.equal(viewportPolicy({ ...input, event: 'new-question', streaming: false }), 'follow-tail', 'restored history opens without a streaming pad')
  for (const event of ['stream', 'tool-gap', 'turn-end'] satisfies ViewportEvent[]) {
    assert.equal(viewportPolicy({ ...input, event }), 'follow-tail', event)
    assert.equal(viewportPolicy({ ...input, event, atBottom: false }), 'preserve-anchor', event)
  }
  for (const event of ['reading', 'disclosure', 'resize', 'activate', 'layout'] satisfies ViewportEvent[]) {
    assert.equal(viewportPolicy({ ...input, event }), 'preserve-anchor', event)
  }
  assert.equal(viewportPolicy({ ...input, event: 'return-latest', atBottom: false }), 'follow-tail')
})

test('the first question in a session is lifted to the very top', () => {
  // A fresh session: nothing above the bubble to reveal, so the gap is the
  // scroller's own padding — where the flow had already put it.
  assert.equal(anchorTopGap(true), ANCHOR_TOP_FIRST_PX)
  assert.equal(anchorTopGap(true), 8)

  // A 900px viewport with a bubble and 「正在思考」 under it — 120px of content
  // from the bubble's top down. The pad is the rest of the screen, so the
  // scroller can travel far enough to put that bubble against its top edge.
  assert.equal(anchorPadding({ viewport: 900, below: 120, topGap: anchorTopGap(true) }), 772)
})

test('a question with history above it stops short, so the previous turn stays visible', () => {
  assert.equal(anchorTopGap(false), ANCHOR_TOP_PX)
  // The same turn in a session that already has one: the pad is 56px shorter —
  // the difference between the two gaps, which is the strip of the previous
  // answer left on screen.
  assert.equal(anchorPadding({ viewport: 900, below: 120, topGap: anchorTopGap(false) }), 716)
})

test('the pad shrinks by what the answer grows, which is what holds the bubble still', () => {
  const of = (below: number) => anchorPadding({ viewport: 900, below, topGap: ANCHOR_TOP_PX })
  // 200px of answer arrives; the scroller is at its end throughout, so the tail
  // follow in `dom/transcriptView.ts` lands the bubble back on the same pixel.
  assert.equal(of(120) - of(320), 200)
})

test('a full-screen answer floors the pad instead of letting the last line touch the composer', () => {
  // Past the floor the arithmetic wants a *negative* pad — the anchor is already
  // above the viewport — and the answer scrolls it off the top like any other
  // content.
  assert.equal(anchorPadding({ viewport: 900, below: 2000, topGap: ANCHOR_TOP_PX }), ANCHOR_FLOOR_PX)
  // And the boundary itself: below = 900 - 64 - 96 is the last measurement the
  // lift still has room for.
  assert.equal(anchorPadding({ viewport: 900, below: 740, topGap: ANCHOR_TOP_PX }), ANCHOR_FLOOR_PX)
  assert.equal(anchorPadding({ viewport: 900, below: 739, topGap: ANCHOR_TOP_PX }), 97)
})

test('a settled transcript rests on a margin, whatever the measurements say', () => {
  // The room above the question is for an answer that is still arriving. Once
  // the turn is over it is a screenful of blank between the last line and the
  // composer, so the pad goes back to a bottom margin — below the streaming
  // floor, which is clearance under a moving tail rather than an end.
  assert.equal(anchorPadding({ viewport: 900, below: 120, topGap: ANCHOR_TOP_PX, settled: true }), ANCHOR_REST_PX)
  assert.ok(ANCHOR_REST_PX < ANCHOR_FLOOR_PX, 'a conversation that has stopped needs less room than one that has not')
  // Not merely a cap: the same conversation streaming wants 716, and the two
  // numbers differing by a screenful is the whole point of the drop.
  assert.equal(anchorPadding({ viewport: 900, below: 120, topGap: ANCHOR_TOP_PX, settled: false }), 716)
})

test('an unmeasurable layout falls back to the floor rather than to a bad number', () => {
  // `NaN` is what a background pane and the DOM stub both produce. It must not
  // reach the stylesheet as `NaNpx`, which is an invalid length the whole
  // declaration would be dropped for.
  for (const metrics of [
    { viewport: Number.NaN, below: 120, topGap: 0 },
    { viewport: 900, below: Number.NaN, topGap: 0 },
    { viewport: 900, below: 120, topGap: Number.NaN },
    { viewport: Number.POSITIVE_INFINITY, below: 120, topGap: 0 },
  ]) {
    assert.equal(anchorPadding(metrics), ANCHOR_FLOOR_PX)
  }
})

test('the pad is a whole number of pixels', () => {
  // Fractional rects are the norm; a pad written to sub-pixel precision would
  // make `isScrolledToBottom`'s 24px slack the only thing standing between a
  // streaming turn and a scroller that never quite reaches its end.
  assert.equal(anchorPadding({ viewport: 900.4, below: 120.3, topGap: 0 }), 780)
})

test('the pad travels as a custom property the stylesheet declares', () => {
  // Paired with `:root`'s declaration and `.transcript-column`'s use of it in
  // `rendererStyleTokens.test.ts`; this end is what keeps the name from drifting.
  assert.equal(TRANSCRIPT_PAD_VARIABLE, '--transcript-pad')
})

/**
 * The reading anchor is found by binary search, because a linear scan read the
 * layout of every candidate in a long session on every scroll event. These
 * pin the old scan's answers, and that the search reads O(log n) boxes.
 */
const rows = (tops: Array<number | undefined>, height = 20) => (index: number) => {
  const top = tops[index]
  return top === undefined ? undefined : { top, bottom: top + height }
}

test('the reading candidate is the first line that starts inside the viewport', () => {
  const tops = [0, 20, 40, 60, 80, 100, 120]
  assert.equal(readingCandidate(tops.length, rows(tops), { top: 50, bottom: 110 }), 3)
  assert.equal(readingCandidate(tops.length, rows(tops), { top: 60, bottom: 110 }), 3, 'a top on the edge is inside')
  assert.equal(readingCandidate(tops.length, rows(tops), { top: -10, bottom: 30 }), 0)
})

test('boxless candidates are skipped, never compared', () => {
  const tops = [0, undefined, undefined, 60, undefined, 100]
  assert.equal(readingCandidate(tops.length, rows(tops), { top: 50, bottom: 110 }), 3)
  assert.equal(readingCandidate(tops.length, rows(tops), { top: 61, bottom: 110 }), 5)
  assert.equal(readingCandidate(3, () => undefined, { top: 0, bottom: 100 }), undefined)
})

test('with no line starting on screen, the first block straddling it holds the place', () => {
  // One code block taller than the viewport, inside its message item.
  const boxes = [{ top: 0, bottom: 2000 }, { top: 10, bottom: 1990 }, { top: 2000, bottom: 2020 }]
  assert.equal(readingCandidate(boxes.length, (i) => boxes[i], { top: 500, bottom: 900 }), 0)
  assert.equal(readingCandidate(boxes.length, (i) => boxes[i], { top: 3000, bottom: 3400 }), undefined, 'past the end')
})

test('the search reads a logarithmic number of boxes', () => {
  const tops = Array.from({ length: 4096 }, (_, index) => index * 20)
  let reads = 0
  const at = rows(tops)
  const index = readingCandidate(tops.length, (i) => { reads++; return at(i) }, { top: 40_010, bottom: 40_400 })
  assert.equal(index, 2001)
  assert.ok(reads < 40, `${reads} reads`)
})
