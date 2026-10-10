import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { trackAnimationStarts, trackIdentity } from './helpers/motion.js'
import { createTranscriptView } from '../src/desktop/renderer/dom/transcriptView.js'
import { NO_DISCLOSURE } from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type { TranscriptItem, TranscriptState } from '../src/desktop/renderer/model/transcript.js'
import { applySessionEvent, createTranscriptState, presentationTranscript } from '../src/desktop/renderer/model/transcript.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import { ANCHOR_REST_PX } from '../src/desktop/renderer/model/transcriptAnchor.js'
import type { WaitingInput } from '../src/desktop/renderer/model/waiting.js'
import type { ToolErrorCode } from '../src/harness/types.js'

/**
 * The third `dom/` unit test, and the one that covers the renderer's only scroll
 * logic. See `test/rendererWelcomeView.test.ts` for why this file is excluded from
 * the base TypeScript program and checked by `tsconfig.domtest.json` instead.
 *
 * The float button is the reason a DOM test is worth it here: whether it is
 * visible depends on three layout numbers, and `model/` cannot see any of them.
 */

const RENDERER = path.join(import.meta.dirname, '..', 'src', 'desktop', 'renderer')
const RUNNING_T1: WaitingInput = { isStreaming: true, turnId: 't1', startedAt: undefined }

// M03: a tool result is not the end of its live turn.
test('M03 keeps the activity group mounted between short tools', (t) => {
  const view = mount(t)
  const identity = trackIdentity(view.column, '.group-steps')
  const activity = { isStreaming: true, turnId: 't1', startedAt: Date.now() }
  const tool: TranscriptItem = { id: 'a', kind: 'tool', text: 'read', turnId: 't1', pending: true,
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts' } }
  view.render(transcript([tool]), NO_DISCLOSURE, activity)
  const steps = identity.sample()
  const group = view.items()[0]!.node
  const first = view.items()[0]!.children[1]!.children[0]!.node
  assert.ok(steps)
  view.render(transcript([{ ...tool, pending: undefined }]), NO_DISCLOSURE, activity)
  assert.equal(identity.sample(), steps)
  view.render(transcript([{ ...tool, pending: undefined }, { ...tool, id: 'b' }]), NO_DISCLOSURE, activity)
  assert.equal(identity.sample(), steps)
  assert.equal(identity.replacements, 0)
  assert.equal(view.items()[0]!.node, group)
  assert.equal(view.items()[0]!.children[1]!.children[0]!.node, first)
  assert.equal(view.items()[0]!.classes.includes('done'), false)
  assert.equal(view.items()[0]!.classes.includes('collapsed'), false)
  view.render(transcript([tool]), new Map([['t1', false]]), activity)
  view.render(transcript([tool, { ...tool, id: 'b' }]), new Map([['t1', false]]), activity)
  assert.equal(view.stub.inspect(steps).attributes.has('inert'), true)
  view.stub.dispatch(steps, 'transitionend', { propertyName: 'height' })
  assert.equal(identity.sample(), undefined, 'a manual fold survives the next step')
})

// M04: an unchanged parent paint must keep its nested head cache alive.
test('M04 keeps the thinking head through an unchanged streaming snapshot', (t) => {
  const view = mount(t)
  const identity = trackIdentity(view.column, '.thinking-step-head')
  const starts = trackAnimationStarts(view.column, '.step-rule', view.stub.observeMotion)
  t.after(starts.dispose)
  let head: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([{ id: 'th', kind: 'thinking', text, turnId: 't1', pending: true }]),
      NO_DISCLOSURE, { isStreaming: true, turnId: 't1', startedAt: undefined })
    head ??= identity.sample()
    assert.ok(head)
    assert.equal(identity.sample(), head)
  }
  assert.equal(starts.starts, 0)
  const items: TranscriptItem[] = [{ id: 'th', kind: 'thinking', text: 'ABC', turnId: 't1', pending: true }]
  view.render(transcript(items), new Map([['th:live', true]]), RUNNING_T1)
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled, [['th:live', true]], 'the surviving head reads the current ref')
  view.render(transcript(items, { generation: 1 }), NO_DISCLOSURE, RUNNING_T1)
  assert.notEqual(identity.sample(), head, 'a reset with reused ids clears the nested cache')
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled.at(-1), ['th:live', false], 'reset does not inherit the previous disclosure ref')
})

test('M05 keeps the thinking body and settled assistant blocks across deltas', (t) => {
  const view = mount(t)
  const body = trackIdentity(view.column, '.step-body')
  let firstBody: unknown
  let firstParagraph: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([
      { id: 'th', kind: 'thinking', text, turnId: 't1', pending: true },
      { id: 'answer', kind: 'assistant', text: `Stable.\n\n${text}`, pending: true },
    ]), NO_DISCLOSURE, RUNNING_T1)
    firstBody ??= body.sample()
    firstParagraph ??= view.items()[1]!.children[0]!.node
    assert.equal(body.sample(), firstBody)
    assert.equal(view.items()[1]!.children[0]!.node, firstParagraph)
    assert.equal(view.items()[1]!.children.some((node) => node.className === 'item-meta'), false)
  }
})

test('M21 real stream records retain thinking, Markdown and manual disclosure through commit and demotion', (t) => {
  const view = mount(t)
  let state = createTranscriptState()
  let manual: DisclosureState = NO_DISCLOSURE
  const apply = (event: SessionEvent): void => {
    state = applySessionEvent(state, event).state
    view.render(presentationTranscript(state), manual, RUNNING_T1)
  }
  const createdAt = '2026-09-10T00:00:00.000Z'
  apply({ type: 'record', record: { type: 'message', id: 'u1', role: 'user', content: 'go', turnId: 't1', createdAt } })
  apply({ type: 'stream', event: { type: 'message_start' } })
  apply({ type: 'stream', event: { type: 'thinking_delta', thinking: 'Reasoning.' } })
  const head = trackIdentity(view.column, '.thinking-step-head').sample()
  const body = trackIdentity(view.column, '.step-body').sample()
  assert.ok(head)
  assert.ok(body)
  const text = 'Stable paragraph.\n\n~~~ts\nconst value = 1\n~~~\n\n$E=mc^2$\n\nMore.'
  apply({ type: 'stream', event: { type: 'text_delta', text } })
  const owner = trackIdentity(view.column, '.md').sample()
  const children = [...(owner as HTMLElement).childNodes]
  view.stub.focus(head)
  manual = new Map([['thinking-0', true]])
  apply({ type: 'record', record: { type: 'message', id: 'a1', role: 'assistant', content: text,
    thinkingBlocks: [{ type: 'thinking', thinking: 'Reasoning.' }], turnId: 't1', createdAt } })
  assert.equal(trackIdentity(view.column, '.thinking-step-head').sample(), head)
  assert.equal(trackIdentity(view.column, '.step-body').sample(), body)
  assert.equal(view.stub.activeElement(), head)
  assert.equal(trackIdentity(view.column, '.md').sample(), owner)
  apply({ type: 'record', record: { type: 'tool_use', id: 'tool1', tool: 'Read', input: { filePath: 'a.ts' }, turnId: 't1', createdAt, riskLevel: 'safe' } })
  assert.equal(trackIdentity(view.column, '.md').sample(), owner, 'prose demotion uses the same carrier')
  assert.deepEqual([...(owner as HTMLElement).childNodes], children)
  view.stub.click(head)
  assert.deepEqual(view.toggled.at(-1), ['thinking-0', true], 'the retained head and manual map still use the same identity')
})

test('M09 completion plays once on the live edge and never on historical disclosure', (t) => {
  const view = mount(t)
  const starts = trackAnimationStarts(view.column, '.step-bead', view.stub.observeMotion, 'completing')
  t.after(starts.dispose)
  const tool: TranscriptItem = { id: 'tool', kind: 'tool', turnId: 't1', text: 'read',
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts', content: 'a' } }
  const paint = (pending: boolean, open: boolean): void => view.render(
    transcript([{ ...tool, pending }]), new Map([['t1', true], ['tool', open]]), RUNNING_T1,
  )
  paint(false, false)
  const identity = trackIdentity(view.column, '.step-bead')
  const statusBead = identity.sample()
  for (const open of [true, false, true]) paint(false, open)
  assert.equal(identity.sample(), statusBead)
  assert.equal(starts.starts, 0, 'history and reopening do not complete anything')
  paint(true, true)
  paint(false, true)
  assert.equal(starts.classStarts, 1)
  paint(false, false)
  paint(false, true)
  assert.equal(identity.sample(), statusBead)
  assert.equal(starts.classStarts, 1)
  view.stub.dispatch(statusBead as HTMLElement, 'animationend', { animationName: 'breathe' })
  assert.ok(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'))
  view.stub.dispatch(statusBead as HTMLElement, 'animationend', { animationName: 'bead-pop' })
  assert.equal(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'), false)
  paint(true, true)
  paint(false, true)
  view.stopClock()
  assert.equal(view.stub.inspect(statusBead as HTMLElement).classes.includes('completing'), false, 'hidden panes cancel feedback')
})

// A thinking step is not here: its fold is the preview's clamp, a class change
// on a body that never leaves (see `a thinking step folds to a preview`).
for (const kind of ['tool', 'subagent'] as const) {
  test(`M13 ${kind} collapse returns focus immediately and reverses with the same body`, (t) => {
    const view = mount(t)
    const item: TranscriptItem = { id: 's', kind, text: 'body', turnId: 't1',
      ...(kind === 'tool' ? { tool: { displayName: 'Read', useSummary: '', content: 'body' } } : {}) }
    const paint = (open: boolean) => view.render(transcript([item]), new Map([['t1', true], ['s', open]]))
    paint(true)
    const head = groupOf(view).children[1]!.children[0]!.children[0]!.node as HTMLElement
    const body = groupOf(view).children[1]!.children[0]!.children[1]!.node as HTMLElement
    const focusable = view.stub.createContainer()
    body.appendChild(focusable)
    focusable.focus()
    paint(false)
    assert.equal(view.stub.activeElement(), head)
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    assert.equal(body.getAttribute('inert'), '')
    assert.equal(body.classList.contains('presence-closing'), true)
    view.stub.dispatch(body, 'transitionend', { propertyName: 'opacity' })
    assert.ok(body.parentElement, 'unrelated transitions do not remove the body')
    paint(true)
    assert.equal(groupOf(view).children[1]!.children[0]!.children[1]!.node, body)
    assert.equal(body.classList.contains('presence-entering'), true)
    paint(false)
    view.stopClock()
    assert.equal(body.parentElement, null, 'pane hiding finishes and removes the closing body')
    paint(true)
    assert.equal(groupOf(view).children[1]!.children[0]!.children[0]!.node, head)
  })
}

for (const reason of ['focus', 'selection', 'reading'] as const) {
  test(`M14 completion folds the turn even under ${reason}`, (t) => {
    const view = mount(t)
    const item: TranscriptItem = { id: 's', kind: 'thinking', text: 'reading', turnId: 't1', pending: true }
    view.render(transcript([item]), NO_DISCLOSURE, RUNNING_T1)
    const body = groupOf(view).children[1]!.children[0]!.children[1]!.node
    if (reason === 'focus') view.stub.focus(body)
    if (reason === 'selection') view.stub.setSelection(body)
    if (reason === 'reading') {
      view.stub.dispatch(view.container, 'wheel', { deltaY: -100 })
      view.stub.setMetrics(view.container, { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 })
    }
    view.render(transcript([{ ...item, pending: false }]))
    // Only a click keeps a turn open past its end; looking at it does not.
    assert.equal(groupOf(view).classes.includes('collapsed'), true)
  })
}

test('M14 advancing the current step keeps an opened thought open without replay', (t) => {
  const view = mount(t)
  const first: TranscriptItem = { id: 'a', kind: 'thinking', text: 'first', turnId: 't1', pending: true }
  const opened = new Map([['a', true]])
  view.render(transcript([first]), opened, RUNNING_T1)
  const body = groupOf(view).children[1]!.children[0]!.children[1]!.node
  view.render(transcript([{ ...first, pending: false }, { ...first, id: 'b', text: 'next' }]), opened, RUNNING_T1)
  const earlier = groupOf(view).children[1]!.children[0]!
  assert.equal(earlier.classes.includes('collapsed'), false)
  assert.equal(earlier.children[1]!.node, body)
  assert.equal(view.stub.inspect(body).classes.includes('preview'), false)
})

test('a live thinking step folds to a two-line preview, its preview opens it, and sealing folds it away', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 's', kind: 'thinking', text: '第一行\n第二行\n第三行', turnId: 't1', pending: true }
  // The running turn's current step, and still folded: a thought is never
  // unfolded for the reader.
  view.render(transcript([item]), NO_DISCLOSURE, RUNNING_T1)
  const step = groupOf(view).children[1]!.children[0]!
  assert.equal(step.classes.includes('collapsed'), true)
  const body = step.children[1]!
  assert.deepEqual(body.classes, ['step-body', 'thinking-text', 'preview'])
  assert.equal(body.text, '第一行\n第二行\n第三行', 'the clamp is CSS; the text is whole')

  view.stub.click(body.node)
  assert.deepEqual(view.toggled, [['s:live', false]])

  view.render(transcript([item]), new Map([['s:live', true]]), RUNNING_T1)
  const open = groupOf(view).children[1]!.children[0]!.children[1]!
  assert.equal(open.node, body.node, 'the fold is a class change, not a rebuild')
  assert.deepEqual(open.classes, ['step-body', 'thinking-text'])
  view.stub.click(open.node)
  assert.equal(view.toggled.length, 1, 'clicking open text (to select it) does not fold it')

  const { pending: _pending, ...sealed } = item
  view.render(transcript([sealed]), new Map([['s:live', true], ['t1', true]]))
  const folded = groupOf(view).children[1]!.children[0]!.children[1]!
  assert.deepEqual(folded.classes, ['step-body', 'thinking-text', 'folded'], 'opened mid-stream, still folded once sealed')
})

test('a sealed thought puts its measured time at the head’s right, and a replayed one shows none', (t) => {
  const view = mount(t)
  const head = (): StubView => groupOf(view).children[1]!.children[0]!.children[0]!
  view.render(transcript([{ id: 's', kind: 'thinking', text: 'why', turnId: 't1', durationMs: 12_000 }]), new Map([['t1', true]]))
  assert.deepEqual(head().children.map((child) => child.className || child.tagName), ['btn-label', 'icon', 'step-duration'])
  assert.equal(head().children.at(-1)?.text, '12s')
  assert.equal(head().attributes.get('aria-label'), '思考过程 · 用时 12s')

  view.render(transcript([{ id: 's', kind: 'thinking', text: 'why', turnId: 't1' }]), new Map([['t1', true]]))
  assert.deepEqual(head().children.map((child) => child.className || child.tagName), ['btn-label', 'icon'])
  assert.equal(head().attributes.get('aria-label'), '思考过程')
})

function transcript(items: readonly TranscriptItem[] = [], overrides: Partial<TranscriptState> = {}): TranscriptState {
  return { items, generation: 0, toolProgress: undefined, isThinking: false, thinkingCount: 0, ...overrides }
}

interface Rendered {
  readonly stub: DomStub
  readonly container: HTMLElement
  readonly host: HTMLElement
  /** `[id, what the row showed when it was clicked]`, the absolute-answer pair. */
  readonly toggled: Array<readonly [string, boolean]>
  /** How many times a `TodoWrite` row asked the task panel to flash. */
  readonly taskClicks: () => number
  /** `[path, line]` per clicked search row, the `open-in-editor` payload. */
  readonly opened: ReadonlyArray<readonly [string, number | undefined]>
  /** `[imageId, name]` per clicked image line under a user bubble (S12). */
  readonly viewedImages: ReadonlyArray<readonly [string, string]>
  /** The thumbnail the pane would hand back, per image id; the test fills it. */
  readonly thumbs: Map<string, string>
  /** What each 复制 click handed the pane for the clipboard. */
  readonly copied: readonly string[]
  readonly rewound: readonly string[]
  /** Every `Agent` row click, by id. */
  readonly openedSubagents: readonly string[]
  render(state: TranscriptState, disclosure?: DisclosureState, activity?: WaitingInput, selectedSubagent?: string, header?: HTMLElement): void
  stopClock(): void
  dispose(): void
  jump(): StubView
  items(): readonly StubView[]
  column(): StubView
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const toggled: Array<readonly [string, boolean]> = []
  const opened: Array<readonly [string, number | undefined]> = []
  const copied: string[] = []
  const rewound: string[] = []
  const viewedImages: Array<readonly [string, string]> = []
  const thumbs = new Map<string, string>()
  const openedSubagents: string[] = []
  let taskClicks = 0
  const view = createTranscriptView(container, host, {
    onToggle: (id, expanded) => toggled.push([id, expanded]),
    onTaskStep: () => { taskClicks += 1 },
    onOpenPath: (path, line) => opened.push([path, line]),
    onViewImage: (image) => viewedImages.push([image.id, image.name]),
    imageThumbUrl: (imageId) => thumbs.get(imageId),
    onCopy: (text) => copied.push(text),
    onRewind: (id) => rewound.push(id),
    onOpenSubagent: (id) => openedSubagents.push(id),
  })
  const jump = (): StubView => {
    const found = stub.inspect(host).children.find((child) => child.classes.includes('scroll-bottom'))
    assert.ok(found, 'no .scroll-bottom in the float host')
    return found
  }
  const column = (): StubView => {
    const children = stub.inspect(container).children
    const found = children.find((child) => child.classes.includes('transcript-column'))
    assert.ok(found, `no .transcript-column in the scroller (children: ${children.length})`)
    return found
  }
  return {
    stub,
    container,
    host,
    taskClicks: () => taskClicks,
    toggled,
    opened,
    viewedImages,
    thumbs,
    copied,
    rewound,
    openedSubagents,
    render: (state, disclosure = NO_DISCLOSURE, activity, selectedSubagent, header) => view.render(state, disclosure, activity, selectedSubagent, header),
    stopClock: () => view.stopClock(),
    dispose: () => view.dispose(),
    jump,
    // Through `.transcript-column`, the one box the items live in: the scroller
    // stays full width (its scrollbar belongs at the panel's edge) while the text
    // is capped at a reading measure. `the items paint inside one reading column`
    // below is what keeps this indirection honest.
    items: () => column().children,
    column,
  }
}

/** Places the reader `distance` px above the tail of a 1000px scroller. */
/**
 * The reader scrolls up: a wheel, then the geometry it leaves behind. The view
 * stops following the tail on the reader's own input only — content that grows
 * under a reader who is following is not them scrolling away (see `following`).
 */
function scrolledUpBy(stub: DomStub, container: HTMLElement, distance: number): void {
  stub.dispatch(container, 'wheel', { deltaY: -distance })
  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 - distance })
}

test('the float button is built once, outside the scroller, and starts hidden', (t) => {
  const { render, jump, stub, container, host } = mount(t)

  const before = jump().node
  assert.equal(jump().hidden, true, 'at the bottom of an empty transcript there is nowhere to jump to')
  assert.equal(jump().attributes.get('aria-label'), '回到最新')

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'user', text: 'hi' }]))

  // Identity across a repaint: the button lives in the host, and `replace()` on
  // the scroller must not be able to reach it.
  assert.equal(jump().node, before)
  assert.equal(stub.inspect(host).children.filter((c) => c.classes.includes('scroll-bottom')).length, 1)
  assert.equal(stub.inspect(container).children.some((c) => c.classes.includes('scroll-bottom')), false)
})

test('scrolling up reveals the float button and returning to the tail hides it', (t) => {
  const { jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, false)

  // Inside the 24px slack the reader counts as being at the tail.
  scrolledUpBy(stub, container, 10)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
})

test('a paint re-decides visibility, because the content can move the verdict', (t) => {
  const { render, jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  assert.equal(jump().hidden, false)

  // A `turn-end` dropping its draft shortens the scroller under the reader, who is
  // now at the tail without ever having scrolled. No `scroll` event is fired here
  // on purpose: this is what the paint-time recompute is for.
  stub.setMetrics(container, { scrollHeight: 400 })
  render(transcript())
  assert.equal(jump().hidden, true)
})

test('clicking the float button jumps to the tail', (t) => {
  const { jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  stub.click(jump().node)

  assert.equal(stub.inspect(container).scrollTop, 1000)
  // The stub fires `scroll` from `scrollTo`, as the browser does, so the button
  // hides through the same path it takes for real rather than from the handler.
  assert.equal(jump().hidden, true)
})

test('the transcript follows the tail only when the reader is already there', (t) => {
  const { render, stub, container } = mount(t)

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  assert.equal(stub.inspect(container).scrollTop, 1000, 'at the tail: follow it')

  scrolledUpBy(stub, container, 400)
  render(transcript([{ id: 'a', kind: 'assistant', text: 'xy' }]))
  assert.equal(stub.inspect(container).scrollTop, 400, 'reading back: stay put')
})

test('content that grows after a paint does not unhook a reader following the tail', (t) => {
  // The long-turn bug: a paint pinned the scroller to the end, a step's unfold
  // then grew the content by more than the 24px slack with no scroll event, and
  // the next paint read the reader as 「scrolled up」 — so the tail was never
  // followed again and the final answer landed below the viewport.
  const { render, stub, container, jump } = mount(t)

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  stub.setMetrics(container, { scrollHeight: 1400 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'xy' }]))
  assert.equal(stub.inspect(container).scrollTop, 1400, 'still following')
  assert.equal(jump().hidden, true)
})

test('the items paint inside one reading column, and the scroller stays bare', (t) => {
  // The reading measure (design_guidance 四.2) is a box, not a `max-width` on the
  // scroller: the user bubble is right-aligned with `margin-left: auto`, which
  // only means "the right edge of the column" while the column is a real element,
  // and the scrollbar has to stay at the panel's edge rather than at 760px.
  // Verified by mutation: rendering the items straight into the scroller reds this.
  const { render, column, container, stub } = mount(t)

  render(transcript([
    { id: 'a', kind: 'user', text: 'hi' },
    { id: 'b', kind: 'assistant', text: 'ok' },
  ]))

  const children = stub.inspect(container).children
  // Also load-bearing since todo V2: the scroller is a flex column and the
  // column's `margin-top: auto` claims *all* of its free space. A second child
  // would split that space and a short conversation would stop meeting the
  // composer.
  assert.equal(children.length, 1, 'the scroller holds the column and nothing else')
  // By class, not by the whole `className`: an idle paint also carries
  // `settling`, the class that lets the pad sink when a turn ends.
  assert.ok(children[0]?.classes.includes('transcript-column'))
  assert.deepEqual(column().children.map((item) => item.classes[0]), ['item', 'item'])

  // And it is rebuilt, not accumulated: `replace()` empties the scroller, so a
  // second paint must not leave two columns behind.
  render(transcript([{ id: 'a', kind: 'user', text: 'hi' }]))
  assert.equal(stub.inspect(container).children.length, 1)
})

test('loose items paint the way they always did', (t) => {
  const { render, items } = mount(t)

  render(transcript([
    { id: 'a', kind: 'user', text: 'hi' },
    { id: 'b', kind: 'tool', text: 'Bash(ls)', pending: true },
    { id: 'c', kind: 'tool', text: 'Bash failed', failed: true },
  ]))

  assert.deepEqual(items().map((item) => item.classes), [
    ['item', 'user'],
    ['item', 'tool', 'pending'],
    ['item', 'tool', 'failed'],
  ])
  assert.deepEqual(items().map((item) => item.text), ['hi', 'Bash(ls)', 'Bash failed'])
})

// --- the thinking disclosure (5d) -------------------------------------------

const liveThinking: TranscriptItem = { id: 'thinking-0', kind: 'thinking', text: '推理', pending: true }
const sealedThinking: TranscriptItem = {
  id: 'thinking-0', kind: 'thinking', text: '推理', durationMs: 458_000,
}

const thinking = (items: readonly StubView[]): StubView => {
  const found = items.find((item) => item.classes.includes('thinking'))
  assert.ok(found, 'no thinking item was painted')
  return found
}

test('a streaming block shows the live label over a preview of the thought', (t) => {
  const { render, items } = mount(t)
  render(transcript([liveThinking]))
  const block = thinking(items())

  assert.deepEqual(block.classes, ['item', 'thinking', 'pending', 'collapsed', 'live'])
  const header = block.children[0]
  assert.equal(header?.tagName, 'BUTTON')
  assert.equal(header?.text, '正在思考')
  assert.equal(header?.attributes.get('aria-expanded'), 'false')
  assert.deepEqual(block.children[1]?.classes, ['thinking-body', 'thinking-text', 'preview'])
  assert.equal(block.children[1]?.text, '推理')
})

test('a sealed block names itself, shows the measured time, and folds its text away', (t) => {
  const { render, items } = mount(t)
  render(transcript([sealedThinking]))
  const block = thinking(items())

  assert.deepEqual(block.classes, ['item', 'thinking', 'collapsed'])
  assert.equal(block.children[0]?.attributes.get('aria-label'), '思考过程 · 用时 7m 38s')
  assert.equal(block.children[0]?.attributes.get('aria-expanded'), 'false')
  // The caret follows the label (design_guidance 四.3) and the time trails both.
  assert.deepEqual(
    block.children[0]?.children.map((child) => child.className || child.tagName),
    ['btn-label', 'icon', 'thinking-duration'],
  )
  assert.equal(block.children[0]?.children.at(-1)?.text, '7m 38s')
  assert.deepEqual(block.children[1]?.classes, ['thinking-body', 'thinking-text', 'folded'])
})

test('the pane is absolute answer outranks the default, both ways', (t) => {
  const { render, items } = mount(t)

  render(transcript([sealedThinking]), new Map([['thinking-0', true]]))
  assert.equal(thinking(items()).classes.includes('collapsed'), false)
  assert.deepEqual(thinking(items()).children[1]?.classes, ['thinking-body', 'thinking-text'])

  render(transcript([liveThinking]), new Map([['thinking-0:live', false]]))
  assert.equal(thinking(items()).classes.includes('collapsed'), true)
  assert.equal(thinking(items()).children[1]?.classes.includes('preview'), true)
})

test('clicking the header reports the block id and what it showed', (t) => {
  const { render, items, stub, toggled } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: 'hi' }, sealedThinking]))

  // The second half is what makes the answer absolute: the pane stores the
  // opposite of what the row showed, so the first click always does the visible
  // thing whether or not a default was in force.
  stub.click(thinking(items()).children[0]?.node)
  assert.deepEqual(toggled, [['thinking-0', false]])
})

// --- activity groups (T7) ----------------------------------------------------

/**
 * A turn's items, the way the model hands them over: everything stamped with the
 * same `turnId` is one group, and the user's message stays outside it (§4.1, §4.4).
 */
function turnItems(overrides: { pending?: boolean } = {}): TranscriptItem[] {
  const tool: TranscriptItem = {
    id: 'call-1',
    kind: 'tool',
    text: 'Read a.ts',
    toolName: 'Read',
    turnId: 't1',
    ...(overrides.pending === true ? { pending: true } : {}),
    tool: {
      displayName: 'Read',
      useSummary: 'a.ts',
      ...(overrides.pending === true
        ? {}
        : { headerSuffix: '240 行', resultSummary: 'Read 240 lines', detail: 'line one', durationMs: 400 }),
    },
  }
  return [
    { id: 'm1', kind: 'user', text: 'hi', turnId: 't1' },
    { id: 'th1', kind: 'thinking', text: '先看看这个文件', durationMs: 2000, turnId: 't1' },
    tool,
  ]
}

const groupOf = (rendered: Rendered): StubView => {
  const found = rendered.items().find((item) => item.classes.includes('activity-group'))
  assert.ok(found, 'no activity group was painted')
  return found
}

test('a turn is one group: the user message outside it, its steps within', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'activity-group', 'waiting'])
  const group = groupOf(view)
  // Running, so the group is open and the steps are real nodes under it.
  assert.deepEqual(group.classes, ['activity-group', 'running', 'live'])
  const head = group.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  // One *action* — the tool call. The thinking step above it is a row in the
  // group but not work the turn did, and it is not counted.
  assert.equal(head?.children.find((node) => node.className === 'btn-label')?.text, '工作中 · 1 步')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  assert.equal(group.children[1]?.classes.includes('group-steps'), true)
  assert.deepEqual(
    group.children[1]?.children.map((step) => step.classes),
    [['step', 'thinking', 'collapsed'], ['step', 'tool', 'running', 'collapsed']],
    'a running read stays one line',
  )
})

test('the thinking step’s head keeps its hairline only while the thought is live', (t) => {
  const view = mount(t)
  const thinkingStepOf = (): StubView => {
    const found = groupOf(view).children[1]?.children[0]
    assert.ok(found)
    return found
  }
  // The same turn twice — a pending tool below keeps the group open across both —
  // with the thought still arriving in the first paint and sealed in the second.
  const sealedTurn = turnItems({ pending: true })
  const liveTurn = sealedTurn.map((item) =>
    item.id === 'th1' ? { ...item, pending: true, durationMs: undefined } : item)

  view.render(transcript(liveTurn), NO_DISCLOSURE, RUNNING_T1)
  const head = thinkingStepOf().children[0]
  assert.deepEqual(head?.classes, ['step-head', 'thinking-step-head'])
  // Its own head class is what the sheet hangs the quiet resting state, the
  // text-only hover and the chevron's reveal on — a tool's head keeps the fill.
  // The hairline runs on from the chevron, and carries the sheen.
  assert.deepEqual(
    head?.children.map((child) => child.className || child.tagName),
    ['btn-label', 'icon', 'step-rule'],
  )

  // Sealed: the line was the waiting, so it goes, and the measured time takes
  // its place. The head node itself stays — that is what lets the sheen run
  // instead of restarting once per token.
  view.render(transcript(sealedTurn), NO_DISCLOSURE, RUNNING_T1)
  const sealed = thinkingStepOf().children[0]
  assert.equal(sealed?.node, head?.node, 'the head is kept across the seal')
  assert.deepEqual(
    sealed?.children.map((child) => child.className || child.tagName),
    ['btn-label', 'icon', 'step-duration'],
  )

  view.stub.click(sealed?.node)
  assert.deepEqual(view.toggled, [['th1', false]])
})

test('a finished group collapses, and its steps are absent rather than hidden', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))
  const group = groupOf(view)

  assert.equal(group.classes.includes('collapsed'), true)
  assert.equal(group.children[0]?.attributes.get('aria-expanded'), 'false')
  // The transcript is an `aria-live` region: a folded turn must not be readable.
  assert.equal(group.children.length, 1, 'a collapsed group holds nothing but its head')
  assert.equal(group.text.includes('line one'), false)
  // No bead strip: a dot per step along a finished head's right edge was a
  // second, wordless report of what the steps below already say — and beside
  // 「已处理」 it read as a verdict on the turn.
  const head = group.children[0]!
  assert.deepEqual(head.children.map((child) => child.className), ['btn-label', 'icon'])
  assert.equal(head.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.match(head.children[0]!.text, /^已完成|^已处理/)
})

test('a step head is a button whose body exists only while it is open', (t) => {
  const view = mount(t)
  // Opened by hand: an absolute answer, so the sealed turn's default is overruled.
  view.render(transcript(turnItems()), new Map([['t1', true], ['call-1', true]]))
  const steps = groupOf(view).children[1]
  const tool = steps?.children[1]

  const head = tool?.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  // The bead is decoration; the state reaches a screen reader as words instead.
  assert.equal(head?.children[0]?.className, 'step-bead done')
  assert.equal(head?.children[0]?.attributes.get('aria-hidden'), 'true')
  assert.equal(head?.attributes.get('aria-label'), 'Read · a.ts · 240 行 · 完成')
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Read'], ['step-summary', 'a.ts'], ['step-suffix', '240 行']],
  )
  // 兜底 body: the result's own summary over `detail ?? content` (§6.2).
  assert.deepEqual(
    tool?.children[1]?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 240 lines'], ['step-body-text', 'line one']],
  )

  view.render(transcript(turnItems()), new Map([['t1', true]]))
  view.stub.dispatch(groupOf(view).children[1]?.children[1]?.children[1]?.node, 'transitionend', { propertyName: 'height' })
  const collapsed = groupOf(view).children[1]?.children[1]
  assert.equal(collapsed?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(collapsed?.children[0]?.attributes.get('aria-expanded'), 'false')
})

test('the group head reads out a stable name while its visible label tracks activity', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const running = groupOf(view).children[0]

  // Visible: the counter. Read out: the status alone — the label is out of the
  // accessibility tree, because this subtree is an `aria-live` region and the
  // count moves once per step (§8).
  assert.equal(running?.attributes.get('aria-label'), '工作中')
  const label = running?.children.find((child) => child.classes.includes('btn-label'))
  assert.equal(label?.text, '工作中 · 1 步')
  assert.equal(label?.attributes.get('aria-hidden'), 'true')

  // Sealed, the head is written once, so it names the totals it now carries.
  view.render(transcript(turnItems()))
  const done = groupOf(view).children[0]
  assert.equal(done?.attributes.get('aria-label'), '已完成 · 1 步')
})

test('the group survives the automatic collapse it performs at turn end', (t) => {
  // The other half of §8's anchoring rule: the steps folding away is content
  // *disappearing* above the reader, and the browser can only hold their place
  // while the node the anchor points at outlives the paint.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const before = groupOf(view).node
  assert.equal(groupOf(view).children.length, 2)

  view.render(transcript(turnItems()))
  assert.equal(groupOf(view).node, before, 'the group is refilled in place, not replaced')
  assert.equal(groupOf(view).children[1]?.classes.includes('presence-closing'), true)
  view.stub.dispatch(groupOf(view).children[1]?.node, 'transitionend', { propertyName: 'height' })
  assert.equal(groupOf(view).children.length, 1, 'and it folded itself while doing so')
})

test('both disclosure levels report their own id and what they showed', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))

  const group = groupOf(view)
  view.stub.click(group.children[0]?.node)
  assert.deepEqual(view.toggled, [['t1', false]], 'the group answers under its turn id')

  view.render(transcript(turnItems()), new Map([['t1', true]]))
  const steps = groupOf(view).children[1]
  view.stub.click(steps?.children[0]?.children[0]?.node)
  view.stub.click(steps?.children[1]?.children[0]?.node)
  assert.deepEqual(view.toggled.slice(1), [['th1', false], ['call-1', false]])
})

test('nodes are kept by id across paints, so the scroll anchor survives', (t) => {
  // The reason this stopped being a performance question: steps collapse *by
  // themselves* when the turn ends, and `overflow-anchor` can only absorb that
  // while the node it points at outlives the paint. Verified by mutation:
  // rebuilding the column every render reds every identity assertion below.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const before = {
    column: view.column().node,
    message: view.items()[0]?.node,
    group: groupOf(view).node,
    step: groupOf(view).children[1]?.children[0]?.node,
  }

  // A later paint of the same turn, with the tool now settled: fresh item objects
  // throughout, as the model mints them.
  view.render(transcript(turnItems()), new Map([['t1', true]]))
  assert.equal(view.column().node, before.column)
  assert.equal(view.items()[0]?.node, before.message, 'an untouched message is not rebuilt')
  assert.equal(groupOf(view).node, before.group)
  assert.equal(groupOf(view).children[1]?.children[0]?.node, before.step, 'the step is refilled in place')

  // And a node whose entry is gone does not linger in the cache: `transcript-reset`
  // restarts the id counter, so a kept node would come back holding another
  // block's content.
  view.render(transcript([{ id: 'reset-notice-0', kind: 'notice', text: '已清空' }]))
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.notEqual(groupOf(view).children[1]?.children[0]?.node, before.step)
})

/**
 * Counts how many children `node` loses from here on.
 *
 * Keeping the *element* across paints is only half of the anchoring rule: it also
 * has to stay attached. A node that leaves the document — even for the rest of one
 * script turn — has its CSS animations cancelled and restarted, and stops being a
 * node `overflow-anchor` can hold a scroll position by. Identity assertions cannot
 * see that, because a node removed and re-appended in the same paint is still the
 * same object; only the removal itself is observable.
 */
function countDetaches(node: unknown): () => number {
  const element = node as { removeChild(child: unknown): void }
  const original = element.removeChild.bind(element)
  let count = 0
  element.removeChild = (child: unknown): void => {
    count += 1
    original(child)
  }
  return () => count
}

test('a streaming paint detaches nothing, so the open step keeps its fold and its anchor', (t) => {
  // The bug this is the regression for: the column was `replaceChildren`-ed and
  // the group `replace()`-d on every paint, so the open thinking step was pulled
  // out of the page and put back once per streamed token. `unfold` is 220ms and
  // the tokens are faster than that, so the body pumped up from zero height for
  // the whole turn and threw everything below it around.
  const streaming = (thought: string, answer: string): TranscriptItem[] => [
    { id: 'm1', kind: 'user', text: 'hi', turnId: 't1' },
    { id: 'thinking-0', kind: 'thinking', text: thought, pending: true, turnId: 't1' },
    ...(answer === ''
      ? []
      : [{ id: 'draft', kind: 'assistant', text: answer, pending: true, turnId: 't1' } as TranscriptItem]),
  ]

  const view = mount(t)
  view.render(transcript(streaming('先', '')), NO_DISCLOSURE, RUNNING_T1)
  const group = groupOf(view)
  const steps = group.children[1]
  const step = steps?.children[0]
  assert.deepEqual(step?.classes, ['step', 'thinking', 'live', 'collapsed'], 'a thought streams as its preview')

  const detached = {
    column: countDetaches(view.column().node),
    group: countDetaches(group.node),
    steps: countDetaches(steps?.node),
  }

  // The block streams on, and then the answer starts arriving under it.
  view.render(transcript(streaming('先看看', '')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好')), NO_DISCLOSURE, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好的，')), NO_DISCLOSURE, RUNNING_T1)

  assert.equal(detached.column(), 1, 'the column re-orders in place; only the status row leaves, as the answer starts')
  assert.equal(detached.group(), 0, 'a refill of the group leaves the children it hands back where they are')
  assert.equal(detached.steps(), 0, 'and the streaming step never leaves its box')
  assert.equal(groupOf(view).children[1]?.children[0]?.node, step?.node, 'still the same step')
  assert.deepEqual(
    view.items().map((entry) => entry.classes[0]),
    ['item', 'activity-group', 'item'],
    'the answer joined the column at the end, outside the group',
  )
})

test('the group head is kept across paints, and still reports what it showed', (t) => {
  // It used to be rebuilt every paint because it closes over the disclosure it
  // reports; it reads that through a ref instead, so a reader who tabbed to it
  // does not lose focus once per token — and the ref, not the paint that built
  // the node, is what the click reports.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const head = groupOf(view).children[0]?.node
  assert.ok(head)

  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(groupOf(view).children[0]?.node, head, 'an unchanged head is not rebuilt')

  // Sealed: the same node, renamed, and now reporting the collapse it performed.
  view.render(transcript(turnItems()))
  assert.equal(groupOf(view).children[0]?.node, head, 'the head survives the turn ending')
  assert.equal(groupOf(view).children[0]?.attributes.get('aria-label'), '已完成 · 1 步')
  assert.equal(groupOf(view).children[0]?.attributes.get('aria-expanded'), 'false')

  view.stub.click(head)
  assert.deepEqual(view.toggled, [['t1', false]], 'the kept head reports the paint that is on screen')
})

// --- the edit family's real diff (T13) ---------------------------------------

/**
 * The unified patch an editing tool ships in `display.detail` (T12): one hunk,
 * one change — `+1 −1` on the head, five rows in the body.
 */
const EDIT_PATCH = [
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -1,4 +1,4 @@',
  ' one',
  ' two',
  '-three',
  '+THREE',
  ' four',
].join('\n')

/** Two hunks, so both the skipped head and the gap between them are elided. */
const GAP_PATCH = [
  '--- a/b.ts',
  '+++ b/b.ts',
  '@@ -10,3 +10,3 @@',
  ' x',
  '-y',
  '+Y',
  ' z',
  '@@ -40,3 +40,3 @@',
  ' p',
  '-q',
  '+Q',
  ' r',
].join('\n')

function editStep(overrides: { detail?: string; toolName?: string } = {}): TranscriptItem {
  return {
    id: 'edit-1',
    kind: 'tool',
    text: 'Edit a.ts',
    toolName: overrides.toolName ?? 'Edit',
    turnId: 't1',
    tool: {
      displayName: 'Edit',
      useSummary: 'a.ts',
      resultSummary: 'Edited a.ts',
      ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
      content: 'Edited a.ts',
      durationMs: 200,
    },
  }
}

test('an edit step carries its patch counts in the head and a real diff below', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), new Map([['t1', true], ['edit-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  const head = step?.children[0]
  // `Edit src/foo.ts · +12 −3` (§6.2): the counts sit where a suffix would,
  // because for this family they *are* the result's note.
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Edit'], ['step-summary', 'a.ts'], ['step-suffix', '+1 −1']],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Edit · a.ts · +1 −1 · 完成')

  // The body is the same diff the permission dialog paints: gutters with both
  // line numbers, and nothing else — the result summary is not repeated over it.
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  assert.equal(body?.children.length, 1)
  const diff = body?.children[0]
  assert.equal(diff?.className, 'diff')
  assert.deepEqual(diff?.children.map((row) => row.classes), [
    ['diff-row', 'ctx'],
    ['diff-row', 'ctx'],
    ['diff-row', 'del'],
    ['diff-row', 'add'],
    ['diff-row', 'ctx'],
  ])
  assert.deepEqual(diff?.children[2]?.children.map((part) => [part.className, part.text]), [
    ['gutter', '  3     -'],
    ['text', 'three'],
  ])
})

test('a folded edit head keeps the counts, and the diff is absent rather than hidden', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), new Map([['t1', true], ['edit-1', false]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.equal(step?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), true)
  assert.equal(step?.text.includes('one'), false, 'an `aria-live` region must not read the folded rows')
})

test('an edit record without a patch falls back to the plain body, without erroring', (t) => {
  const view = mount(t)
  view.render(transcript([editStep()]), new Map([['t1', true], ['edit-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // No patch to count, so no suffix — the head is what it was before T13.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
  // And the body is the fallback family (§6.2 兜底): the summary over `content`.
  const body = step?.children[1]
  assert.deepEqual(body?.children.map((part) => [part.className, part.text]), [
    ['step-body-head', 'Edited a.ts'],
    ['step-body-text', 'Edited a.ts'],
  ])
})

test("a Bash output that happens to be a patch stays a terminal block, not a diff", (t) => {
  const view = mount(t)
  // `git diff` genuinely prints a unified patch — with colours, even. The family
  // is the design's own assignment by tool name (§6.2), so the output is the
  // terminal block's text, rows and all, and never a parsed `.diff`.
  view.render(
    transcript([bashStep({ content: EDIT_PATCH })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const body = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(body?.children.some((child) => child.classes.includes('diff')), false)
  assert.equal(body?.children[0]?.className, 'step-terminal')
  assert.equal(body?.children[0]?.text, EDIT_PATCH)
})

test('skipped lines draw as dashed rules with the count, never as glyphs', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: GAP_PATCH })]), new Map([['t1', true], ['edit-1', true]]))

  const diff = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]
  const elided = diff?.children.filter((row) => row.classes.includes('elided'))
  // Both the file head the first hunk skipped and the gap between the hunks.
  assert.deepEqual(elided?.map((row) => row.text), ['省略 9 行', '省略 27 行'])
  for (const row of elided ?? []) {
    // The rule is a span the sheet paints, and no gutter — an elided row is not
    // a line of the file.
    assert.deepEqual(row.children.map((part) => part.className), ['rule', 'text'])
  }
  // §3: the elision glyph is gone from the block entirely, in any form.
  assert.equal(diff?.text.includes('…'), false)
  assert.equal(diff?.text.includes('⋯'), false)
})

// --- the shell family's terminal block (T14) --------------------------------

/**
 * The output of a command that used its terminal — colours, a progress line's
 * erase-and-jump, the lot. Exactly what prints as `[32m` garbage unstripped.
 */
const ANSI_OUTPUT = '\x1b[32mok\x1b[0m 42 passed\n\x1b[2K\x1b[1G\x1b[31m3 failed\x1b[0m'

function bashStep(overrides: {
  failed?: boolean
  errorCode?: ToolErrorCode
  content?: string
  detail?: string
} = {}): TranscriptItem {
  return {
    id: 'bash-1',
    kind: 'tool',
    text: 'Bash npm test',
    toolName: 'Bash',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Bash',
      useSummary: 'npm test',
      content: overrides.content ?? ANSI_OUTPUT,
      ...(overrides.detail === undefined ? {} : { detail: overrides.detail }),
      ...(overrides.errorCode === undefined ? {} : { errorCode: overrides.errorCode }),
      durationMs: 3200,
    },
  }
}

test('a Bash step opens into a terminal block with its output ANSI-stripped', (t) => {
  const view = mount(t)
  view.render(transcript([bashStep()]), new Map([['t1', true], ['bash-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // The block is the command's own output and nothing else — the head already
  // said what ran and how long, so there is no summary line above it (§6.2).
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  assert.deepEqual(body?.children.map((child) => child.className), ['step-terminal'])
  assert.equal(body?.children[0]?.tagName, 'PRE')
  // §6.4: the sequences are stripped, not printed — a real `npm test` line, not
  // the `[32m` garbage the raw string would show.
  assert.equal(body?.children[0]?.text, 'ok 42 passed\n3 failed')
  assert.equal(body?.text.includes('\x1b'), false)
})

test('a failed Bash step names its error code on its own line and reddens the whole block', (t) => {
  const view = mount(t)
  view.render(
    transcript([bashStep({ failed: true, errorCode: 'command_failed' })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  // `failed` is the class the stylesheet keys the whole terminal block's danger
  // colour on (`.step.failed .step-terminal`): the colour is never the only
  // carrier — the code is right there in words, above the output it failed on.
  assert.deepEqual(step?.classes, ['step', 'tool', 'failed'])
  const body = step?.children[1]
  assert.deepEqual(
    body?.children.map((child) => [child.className, child.text]),
    [['step-error', '命令失败（非零退出）'], ['step-terminal', 'ok 42 passed\n3 failed']],
  )
})

test('a failed Bash step with no output is one line, not an empty terminal', (t) => {
  const view = mount(t)
  view.render(
    transcript([bashStep({ failed: true, errorCode: 'command_failed', content: '(no output)' })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const body = groupOf(view).children[1]?.children[0]?.children[1]
  assert.deepEqual(
    body?.children.map((child) => [child.className, child.text]),
    [['step-error', '命令失败（非零退出），无输出']],
  )
})

test('the terminal shows what the command printed, not the collapsed line’s extract', (t) => {
  const view = mount(t)
  // A backgrounded shell's `detail` is the one-line extract the collapsed row
  // reads; the full start message in `content` is the transcript the block owes
  // the reader — the task id is what they need to call BashOutput with.
  view.render(
    transcript([bashStep({ content: 'Task ID: bg-1\nPID: 123', detail: 'PID: 123' })]),
    new Map([['t1', true], ['bash-1', true]]),
  )

  const body = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(body?.children[0]?.className, 'step-terminal')
  assert.equal(body?.children[0]?.text, 'Task ID: bg-1\nPID: 123')
})

// --- the search family's grouped list (T15) ---------------------------------

/**
 * The `Grep` payload the tool actually prints: ripgrep rows (`path:line:text`,
 * no space), the Node fallback's `path:line: text` (one space), and — when the
 * result was paginated — the tool's own notice after a blank line.
 */
const GREP_CONTENT = [
  'src/harness/types.ts:39:  readonly turnId?: string',
  'src/harness/types.ts:52:  turnId: string',
  'src/desktop/renderer/model/transcript.ts:52:  turnId?: string',
  '',
  '[Showing results 1..3 of 812 total matches]',
].join('\n')

const GLOB_CONTENT = ['test/a.test.ts', 'test/b.test.ts', 'src/c.ts'].join('\n')

function searchStep(overrides: {
  toolName?: string
  content?: string
  failed?: boolean
} = {}): TranscriptItem {
  const toolName = overrides.toolName ?? 'Grep'
  return {
    id: 'search-1',
    kind: 'tool',
    text: `Search "turnId"`,
    toolName,
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Search',
      useSummary: 'pattern: "turnId"',
      resultSummary: 'Found 3 matches across 2 files',
      content: overrides.content ?? GREP_CONTENT,
      durationMs: 1200,
    },
  }
}

test('a Grep step carries its counts in the head and its hits grouped by file below', (t) => {
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // `Grep "turnId" · 3 处 / 2 文件` (§6.2): the counts are the parsed list's
  // own, sitting where a suffix would — the same place the edit family puts
  // its `+12 −3`.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [
      ['step-name', 'Search'],
      ['step-summary', 'pattern: "turnId"'],
      ['step-suffix', '3 处 / 2 文件'],
      ['step-duration', '1s'],
    ],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Search · pattern: "turnId" · 3 处 / 2 文件 · 完成')

  // The body: two file groups in first-seen order, the hits under their own
  // file, and the tool's truncation notice as the footnote — a truncated list
  // that looks complete is a lie about coverage.
  const list = step?.children[1]?.children[0]
  assert.equal(list?.className, 'step-search')
  const groups = list?.children.filter((child) => child.classes.includes('search-file')) ?? []
  assert.equal(groups.length, 2)
  assert.equal(groups[0]?.children[0]?.text, 'src/harness/types.ts')
  assert.equal(groups[0]?.children.length, 3, 'the head and two hits')
  assert.equal(groups[1]?.children[0]?.text, 'src/desktop/renderer/model/transcript.ts')
  assert.equal(list?.children.at(-1)?.className, 'step-search-note')
  assert.equal(list?.children.at(-1)?.text, '[Showing results 1..3 of 812 total matches]')
})

test('a hit row shows its line and its text, and names the file:line a click means', (t) => {
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const groups = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]?.children ?? []
  const hit = groups[0]?.children[1]
  assert.equal(hit?.tagName, 'BUTTON')
  assert.equal(hit?.className, 'search-hit')
  // The accessible name is the goto argument itself — the one string that
  // cannot be misread about what a click opens.
  assert.equal(hit?.attributes.get('aria-label'), 'src/harness/types.ts:39')
  assert.deepEqual(hit?.children.map((part) => [part.className, part.text]), [
    ['search-hit-line', '39'],
    ['search-hit-text', '  readonly turnId?: string'],
  ])
})

test('clicking a path and a hit emits the open-in-editor payload', (t) => {
  // The acceptance case for T15: the click leaves the view as exactly what the
  // tool printed — a cwd-relative path, plus the hit's own line — and the pane
  // turns that into the shell command. A file header has no line; a hit does.
  const view = mount(t)
  view.render(transcript([searchStep()]), new Map([['t1', true], ['search-1', true]]))

  const list = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]
  view.stub.click(list?.children[0]?.children[0]?.node)
  view.stub.click(list?.children[0]?.children[1]?.node)

  assert.deepEqual(view.opened, [
    ['src/harness/types.ts', undefined],
    ['src/harness/types.ts', 39],
  ])
})

test('a Glob step is a flat list of clickable paths, counted in files', (t) => {
  const view = mount(t)
  view.render(
    transcript([searchStep({ toolName: 'Glob', content: GLOB_CONTENT })]),
    new Map([['t1', true], ['search-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  // `N 个文件`, not `N 处 / M 文件` — a Glob's file *is* its hit.
  assert.equal(
    step?.children[0]?.children.find((part) => part.classes.includes('step-suffix'))?.text,
    '3 个文件',
  )
  const list = step?.children[1]?.children[0]
  assert.equal(list?.children.length, 3)
  assert.deepEqual(
    list?.children.map((row) => [row.className, row.children[0]?.text]),
    [
      ['search-file', 'test/a.test.ts'],
      ['search-file', 'test/b.test.ts'],
      ['search-file', 'src/c.ts'],
    ],
  )

  view.stub.click(list?.children[1]?.children[0]?.node)
  assert.deepEqual(view.opened, [['test/b.test.ts', undefined]])
})

test('an unparseable search payload falls back to the plain body, without erroring', (t) => {
  const view = mount(t)
  // A failed Grep's error string, or a multiline `-U` match with its `--`
  // separators: not a search list, and the family must not half-parse it into
  // groups nobody clicked. §6.2 兜底 draws it instead.
  view.render(
    transcript([searchStep({ content: 'Error: Invalid regular expression pattern.', failed: true })]),
    new Map([['t1', true], ['search-1', true]]),
  )

  const step = groupOf(view).children[1]?.children[0]
  assert.equal(step?.children[1]?.children.some((child) => child.classes.includes('step-search')), false)
  assert.deepEqual(
    step?.children[1]?.children.map((part) => [part.className, part.text]),
    [
      ['step-body-head', 'Found 3 matches across 2 files'],
      ['step-body-text', 'Error: Invalid regular expression pattern.'],
    ],
  )
  // And no counts were invented for a head that has no list behind it.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
})

// --- the read, agent and web families' bodies (T16) --------------------------

function readStep(overrides: { content?: string; failed?: boolean } = {}): TranscriptItem {
  return {
    id: 'read-1',
    kind: 'tool',
    text: 'Read a.ts',
    toolName: 'Read',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Read',
      useSummary: 'src/a.ts',
      resultSummary: 'Read 2 lines',
      content: overrides.content ?? 'one\ntwo\n',
      durationMs: 400,
    },
  }
}

test('a Read step opens into the file as a line-numbered code block', (t) => {
  const view = mount(t)
  view.render(transcript([readStep()]), new Map([['t1', true], ['read-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // `Read src/foo.ts · 240 行` (§6.2): the count is the block's own, so the head
  // and the body can never disagree about how long the file is.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Read'], ['step-summary', 'src/a.ts'], ['step-suffix', '2 行']],
  )
  assert.equal(head?.attributes.get('aria-label'), 'Read · src/a.ts · 2 行 · 完成')

  // The body is the file's own lines, one row each with its own number — and
  // no highlighting of any kind: the row is exactly the text the tool read.
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  const block = body?.children[0]
  assert.equal(block?.className, 'step-code')
  // A trailing newline is the last line's terminator, not an extra empty row:
  // the tool counts `one\ntwo\n` as 2 lines, and so does the block.
  assert.deepEqual(
    block?.children.map((row) => [
      row.children[0]?.text,
      row.children[1]?.text,
      row.children[1]?.className,
    ]),
    [['1', 'one', 'step-code-text'], ['2', 'two', 'step-code-text']],
  )
})

test('a Read step numbers its rows from the tool’s own prefix, offset included', (t) => {
  const view = mount(t)
  const content = '    20\tone\n    21\ttwo\n\n[Showing lines 20-21 of 40. Use offset/limit to read another range.]'
  view.render(transcript([readStep({ content })]), new Map([['t1', true], ['read-1', true]]))

  const block = groupOf(view).children[1]?.children[0]?.children[1]?.children[0]
  assert.deepEqual(
    block?.children.map((row) => [row.children[0]?.text, row.children[1]?.text]),
    [['20', 'one'], ['21', 'two']],
  )
})

function agentStep(): TranscriptItem {
  return {
    id: 'agent-1',
    kind: 'tool',
    text: 'explore agent 扫一遍 tools/',
    toolName: 'Agent',
    turnId: 't1',
    tool: {
      displayName: 'explore agent',
      useSummary: '扫一遍 tools/',
      task: '找到 display 的**所有**用法',
      // As the tool writes it for the model: the report, then its notices.
      content: '22 个工具返回了 **display.summary**，其中 6 个带 detail。'
        + '\n\n[Sub-agent output may be incomplete.]'
        + '\n\nAgent ID: explore-1. Use SendMessage with this agent_id to continue the same sub-agent.',
      resultSummary: 'Done (12 tool uses · 34k tokens · 5s)',
      headerSuffix: 'opus',
      durationMs: 41_000,
      subagent: {
        subagentType: 'explore',
        model: 'opus',
        toolUseCount: 12,
        // The run's own 8k-capped record of the same answer: the fuller
        // result content is what the body owes the reader.
        summary: '22 个工具返回了 display.summary。',
      },
    },
  }
}

test('a running Agent step says what its sub-agent is doing, even folded', (t) => {
  const view = mount(t)
  const running: TranscriptItem = {
    id: 'agent-1',
    kind: 'tool',
    text: '子代理 扫一遍 tools/',
    toolName: 'Agent',
    turnId: 't1',
    pending: true,
    tool: {
      displayName: '子代理',
      useSummary: '扫一遍 tools/',
      agentType: 'explore',
      task: '找用法',
      live: { tool: 'Read', summary: 'src/a.ts', toolCount: 3 },
    },
  }
  view.render(transcript([running]), new Map([['t1', true], ['agent-1', false]]))

  const step = groupOf(view).children[1]?.children[0]
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [
      ['step-name', '子代理'],
      ['step-tag', 'explore'],
      ['step-summary', '扫一遍 tools/'],
      ['step-suffix', '3 工具'],
    ],
  )
  const live = step?.children[1]
  assert.equal(live?.className, 'step-live')
  assert.deepEqual(live?.children.map((part) => part.text), ['↳', 'Read', 'src/a.ts'])
})

test('an Agent step is a link to the side panel, with the run in the head', (t) => {
  const view = mount(t)
  view.render(transcript([agentStep()]), new Map([['t1', true], ['agent-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // `Agent explore · opus · 12 工具` (§6.2): the run's model and tool count are
  // one suffix unit — and the result's own `headerSuffix` carries that same
  // model, so it stands down rather than saying `opus` twice on the row.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [
      ['step-name', 'explore agent'],
      ['step-summary', '扫一遍 tools/'],
      ['step-suffix', 'opus · 12 工具'],
      ['step-duration', '41s'],
    ],
  )
  assert.equal(head?.attributes.get('aria-label'), 'explore agent · 扫一遍 tools/ · opus · 12 工具 · 完成')
  assert.equal(
    head?.children.filter((part) => part.classes.includes('step-suffix')).length,
    1,
    'the model is not drawn twice',
  )

  // Never a fold: the run lives in the side panel, even when the disclosure
  // says open, and a click asks for that panel instead of toggling.
  assert.equal(step?.children.some((child) => child.classes.includes('step-body')), false)
  view.stub.click(head!.node)
  assert.deepEqual(view.openedSubagents, ['agent-1'])
  assert.deepEqual(view.toggled, [])

  view.render(transcript([agentStep()]), new Map([['t1', true]]), undefined, 'agent-1')
  const selected = groupOf(view).children[1]?.children[0]
  assert.equal(selected?.classes.includes('selected'), true)
  assert.equal(selected?.children[0]?.attributes.get('aria-pressed'), 'true')
})

function webStep(overrides: { failed?: boolean; errorCode?: ToolErrorCode } = {}): TranscriptItem {
  return {
    id: 'web-1',
    kind: 'tool',
    text: 'Fetch example.com',
    toolName: 'WebFetch',
    turnId: 't1',
    ...(overrides.failed === true ? { failed: true } : {}),
    tool: {
      displayName: 'Fetch',
      useSummary: 'example.com',
      resultSummary: 'Fetched example.com (24.3KB)',
      content: '# Title\n\nsome prose',
      ...(overrides.errorCode === undefined ? {} : { errorCode: overrides.errorCode }),
      durationMs: 1200,
    },
  }
}

test('a WebFetch step opens into the page as the markdown the tool made of it', (t) => {
  const view = mount(t)
  view.render(transcript([webStep()]), new Map([['t1', true], ['web-1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  // The web family has no counts of its own — the fetch's own note stays where
  // the fallback put it, above the body.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.slice(1).map((part) => [part.className, part.text]),
    [['step-name', 'Fetch'], ['step-summary', 'example.com'], ['step-duration', '1s']],
  )

  // The body is the article: the tool already converted the page to markdown,
  // and rendering it as the `pre` the fallback uses would print `#` and `**`
  // as markers instead of the heading and emphasis they are.
  const body = step?.children[1]
  assert.deepEqual(
    body?.children.map((part) => part.className),
    ['step-body-head', 'step-web md'],
  )
  const article = body?.children[1]
  assert.equal(article?.children[0]?.tagName, 'H1')
  assert.equal(article?.children[0]?.text, 'Title')
  assert.equal(article?.children[1]?.tagName, 'P')
  assert.equal(article?.children[1]?.text, 'some prose')
})

test('the fallback body still serves the new families when their data is absent', (t) => {
  const view = mount(t)

  // A failed fetch is a failure first: its own text drawn by the fallback —
  // under the step's `failed` class and its danger colour — not an article.
  view.render(
    transcript([webStep({ failed: true, errorCode: 'execution_failed' })]),
    new Map([['t1', true], ['web-1', true]]),
  )
  const failedBody = groupOf(view).children[1]?.children[0]?.children[1]
  assert.equal(failedBody?.children.some((child) => child.classes.includes('step-web')), false)
  assert.deepEqual(
    failedBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Fetched example.com (24.3KB)'], ['step-body-text', '# Title\n\nsome prose']],
  )

  // A Read that read nothing has no lines to number: no code block, and no
  // invented `0 行` — the count is the block's own, and there is no block.
  view.render(transcript([readStep({ content: '' })]), new Map([['t1', true], ['read-1', true]]))
  const emptyRead = groupOf(view).children[1]?.children[0]
  assert.equal(emptyRead?.children[0]?.children.some((part) => part.classes.includes('step-suffix')), false)
  const emptyBody = emptyRead?.children[1]
  assert.equal(emptyBody?.children.some((child) => child.classes.includes('step-code')), false)
  assert.deepEqual(
    emptyBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 2 lines']],
  )
})

// --- inline file pills (5d) --------------------------------------------------

test('a mention in the user bubble is a pill, interleaved with the text as typed', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '把 @a.ts 搬到 @"b c.ts"' }]))
  // The item is the column; the bubble is the node inside it that the meta row
  // hangs off of.
  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))
  assert.ok(bubble)

  const shapes = bubble.nodes.map((node) => (typeof node === 'string' ? node : node.className))
  assert.deepEqual(shapes, ['把 ', 'file-chip', ' 搬到 ', 'file-chip'])
  const chips = bubble.children
  assert.deepEqual(chips.map((chip) => chip.tagName), ['SPAN', 'SPAN'], 'read-only, so not a button')
  assert.deepEqual(chips.map((chip) => chip.text), ['a.ts', 'b c.ts'])
  // The icon comes first, then the label — and the icon is a real SVG node.
  assert.equal(chips[0]?.children[0]?.tagName, 'svg')
  assert.equal(chips[0]?.children[1]?.className, 'file-chip-label')
})

test('a bubble with no mention is still a single text node', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: 'mail me at foo@bar.com' }]))

  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))
  assert.deepEqual(bubble?.nodes, ['mail me at foo@bar.com'])
})

/**
 * The `TodoWrite` row (T10). It never opens — the checklist is drawn once, above
 * the composer — so it is a control that points at that panel instead.
 */
test('a TodoWrite step is a bodyless button that flashes the task panel', (t) => {
  const view = mount(t)
  view.render(transcript(
    [{
      id: 'todo-1',
      kind: 'tool',
      text: 'TodoWrite 3/6',
      toolName: 'TodoWrite',
      turnId: 't1',
      tool: { displayName: 'TodoWrite', useSummary: '3/6', detail: '- [x] one' },
    }],
    { toolProgress: undefined },
  ), new Map([['t1', true]]))

  const step = groupOf(view).children[1]?.children[0]
  assert.deepEqual(step?.classes, ['step', 'task', 'done'])
  const head = step?.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  // No `aria-expanded`: nothing here opens, and a disclosure that never opens is
  // a lie to a screen reader.
  assert.equal(head?.attributes.get('aria-expanded'), undefined)
  // And no body, even though the result carried a `detail` the tool family would
  // have drawn.
  assert.equal(step?.children.length, 1)

  assert.equal(view.taskClicks(), 0)
  view.stub.click(head?.node)
  assert.equal(view.taskClicks(), 1)
  assert.deepEqual(view.toggled, [], 'the row folds nothing')
})

test('only the user bubble grows pills', (t) => {
  const { render, items } = mount(t)
  render(transcript([
    { id: 'a1', kind: 'assistant', text: 'see @a.ts' },
    { id: 't1', kind: 'tool', text: 'Read(@a.ts)' },
    { id: 'n1', kind: 'notice', text: 'wrote @a.ts' },
  ]))

  for (const item of items()) {
    assert.equal(item.children.some((child) => child.classes.includes('file-chip')), false, item.className)
  }
})

test('a message carries a meta row: 复制, its model, its time — and a draft carries none', (t) => {
  const { render, items, copied, rewound, stub } = mount(t)
  const meta = (item: StubView): StubView | undefined =>
    item.children.find((child) => child.classes.includes('item-meta'))
  // Local time, so the expectation is derived the same way the view derives it.
  const at = new Date(2026, 4, 7, 14, 32).toISOString()

  // The streaming draft has neither a model nor a stamp, so there is no row at
  // all — an empty one would reserve height under a message that is still
  // growing.
  render(transcript([{ id: 'draft', kind: 'assistant', text: 'part', pending: true }]))
  assert.equal(meta(items()[0]!), undefined)

  render(transcript([{ id: 'a1', kind: 'assistant', text: 'part done', model: 'glm-5.3', createdAt: at }]))
  const row = meta(items()[0]!)
  assert.ok(row, 'the committed answer draws its meta row')
  assert.deepEqual(
    row.children.map((child) => [child.classes.join(' '), child.text]),
    [['item-copy', ''], ['item-model', 'glm-5.3'], ['item-time', '14:32']],
    '复制 first, the model in the middle, the time last',
  )
  // The transcript is `aria-live="polite"`: the labels are not what a reader
  // asked to have read out alongside the answer. The button is a real control
  // and names itself.
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[2]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[0]!.attributes.get('aria-hidden'), undefined)
  assert.equal(row.children[0]!.attributes.get('aria-label'), '复制')

  stub.click(row.children[0]!.node)
  assert.deepEqual(copied, ['part done'], 'the pane is handed the message, not the rendered markdown')

  // The user's bubble has a time and a copy button, and no model to name.
  render(transcript([{ id: 'u1', kind: 'user', text: 'go', createdAt: at }]))
  const userRow = meta(items()[0]!)
  assert.ok(userRow)
  // Outside the bubble, under it: the row is a sibling of the surface, not one
  // of the things inside it.
  assert.deepEqual(
    items()[0]!.children.map((child) => child.className),
    ['user-bubble', 'item-meta'],
  )
  assert.deepEqual(
    userRow.children.map((child) => [child.classes.join(' '), child.text]),
    [['item-copy', ''], ['item-rewind', ''], ['item-time', '14:32']],
  )
  stub.click(userRow.children[0]!.node)
  assert.deepEqual(copied, ['part done', 'go'])
  // 回退 addresses the checkpoint by the user record's id.
  stub.click(userRow.children[1]!.node)
  assert.deepEqual(rewound, ['u1'])
})

test('the stub carries every document member the dom helpers reach for', (t) => {
  const { stub } = mount(t)
  const sources = ['dom.ts', 'controls.ts', 'icons.ts', 'transcriptView.ts', 'markdownView.ts'].map((name) =>
    readFileSync(path.join(RENDERER, 'dom', name), 'utf8'),
  )
  const members = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(/\bdocument\.(\w+)/g)) members.add(match[1]!)
  }

  assert.ok(members.size >= 4, [...members].join(', '))
  for (const member of members) {
    assert.equal(stub.hasDocumentMember(member), true, `the stub is missing document.${member}`)
  }
})

// --- the waiting row ---------------------------------------------------------

/** What the pane hands the view about the turn in flight. */
function waiting(state: TranscriptState, startedAt: number | undefined): WaitingInput {
  return { isStreaming: true, startedAt, turnId: state.turnId }
}

test('the waiting row is the transcript’s tail while a turn is running and nothing is arriving', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: '改一下侧栏' }])

  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 5000))

  const row = items()[items().length - 1]!
  assert.deepEqual(row.classes, ['waiting'], 'the row is the last thing in the column')
  assert.deepEqual(
    row.children.map((child) => [child.classes.join(' '), child.text]),
    [['waiting-bead', ''], ['waiting-label', '正在思考'], ['waiting-elapsed', '5s'], ['waiting-hint', 'Esc 中断']],
    'bead, label, elapsed, hint — in that order, and the clock is painted on the first frame',
  )
  // `.transcript` is `aria-live="polite"`: the label is what may be announced,
  // the counter must not be (it changes ten times a second) and neither the
  // bead nor the key hint is what a reader asked to hear alongside the answer.
  assert.equal(row.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), undefined)
  assert.equal(row.children[2]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[3]!.attributes.get('aria-hidden'), 'true')
})

test('once the turn opens a group, the row stays at the tail and the head goes quiet', (t) => {
  const view = mount(t)
  const live = turnItems({ pending: true })
  const startedAt = Date.now() - 6_000

  view.render(transcript(live, { turnId: 't1' }), NO_DISCLOSURE, {
    isStreaming: true,
    startedAt,
    turnId: 't1',
  })

  // The status is the transcript's last row for the whole turn: a long turn
  // scrolls its own top away, and the tail is where the reader is looking.
  const row = view.items().at(-1)!
  assert.deepEqual(row.classes, ['waiting'])
  assert.deepEqual(
    row.children.map((child) => [child.classes.join(' '), child.text]),
    [['waiting-bead', ''], ['waiting-label', '读取 a.ts'], ['waiting-elapsed', '6s'], ['waiting-hint', 'Esc 中断']],
    'the running tool’s own name, with the bead, counter and hint',
  )
  // It tracks the turn from tool to tool, so it is not what gets announced:
  // each step's own head says what is new.
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), 'true')

  // The head is quiet: a count and no second clock or bead.
  const head = groupOf(view).children[0]!
  assert.ok(head.classes.includes('live'))
  assert.deepEqual(head.children.map((child) => [child.classes.join(' '), child.text]), [['btn-label', '工作中 · 1 步'], ['icon', '']])
  assert.equal(head.attributes.get('aria-label'), '工作中')

  // The tool settles and the turn keeps running: the row falls back to
  // 「正在思考」 while all four pieces stay mounted, preserving the breath.
  const between = turnItems()
  view.render(transcript(between, { turnId: 't1' }), NO_DISCLOSURE, { isStreaming: true, startedAt, turnId: 't1' })
  const still = view.items().at(-1)!
  assert.equal(still.node, row.node, 'the row is kept across the step settling')
  for (let i = 0; i < row.children.length; i += 1) assert.equal(still.children[i]!.node, row.children[i]!.node)
  assert.equal(still.children[1]!.text, '正在思考')
  assert.match(groupOf(view).children[0]!.text, /^工作中/, 'a settled step does not seal a running turn')

  // Only the end of the turn seals it, and the row goes.
  view.render(transcript(between, { turnId: undefined }), NO_DISCLOSURE, {
    isStreaming: false,
    startedAt: undefined,
    turnId: undefined,
  })
  assert.equal(view.items().some((item) => item.classes.includes('waiting')), false)
  const sealed = groupOf(view).children[0]!
  assert.equal(sealed.classes.includes('live'), false)
  assert.match(sealed.text, /^已完成|^已处理/)
})

test('M18 keeps the breathing bead and clock mounted across tool handoffs and unchanged paints', (t) => {
  const view = mount(t)
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 6000 }
  const starts = trackAnimationStarts(view.column, '.waiting-bead', view.stub.observeMotion)
  t.after(starts.dispose)
  let pieces: readonly StubView[] | undefined
  const labels: Record<string, string> = { Read: '读取 a.ts', Grep: '搜索 a.ts', Edit: '编辑 a.ts' }
  for (const toolName of ['Read', undefined, undefined, 'Grep', undefined, 'Edit']) {
    const item: TranscriptItem = { id: 'tool', kind: 'tool', turnId: 't1', text: '',
      toolName: toolName ?? 'Read', pending: toolName !== undefined,
      tool: { displayName: toolName ?? 'Read', useSummary: 'a.ts' } }
    view.render(transcript([item]), NO_DISCLOSURE, activity)
    const row = view.items().at(-1)!
    pieces ??= row.children
    for (let i = 0; i < pieces.length; i += 1) assert.equal(row.children[i]!.node, pieces[i]!.node)
    assert.equal(row.children[1]!.text, toolName ? labels[toolName] : '正在思考')
    assert.equal(row.children[2]!.text, '6s')
  }
  assert.equal(starts.starts, 0, 'label updates never detach or reactivate the bead')
})

test('the waiting row keeps its node while it waits, and leaves when the answer starts', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const startedAt = Date.now() - 1000

  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  const first = items()[items().length - 1]!.node
  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  assert.equal(items()[items().length - 1]!.node, first, 'a repaint must not rebuild the row under the reader')

  // The first delta lands: `model/waiting.ts` withdraws the row, and the view
  // has to take it off the page rather than leave a second indicator beside the
  // text that is now arriving.
  const arriving = transcript([
    { id: 'u1', kind: 'user', text: 'go' },
    { id: '__draft__', kind: 'assistant', text: '好', pending: true },
  ])
  render(arriving, NO_DISCLOSURE, waiting(arriving, startedAt))
  assert.equal(items().some((item) => item.classes.includes('waiting')), false)
})

test('the waiting clock ticks by itself, and stopClock stops it', async (t) => {
  const { render, items, stopClock } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const elapsed = (): string => {
    const row = items()[items().length - 1]!
    return row.children.find((child) => child.classes.includes('waiting-elapsed'))!.text
  }

  // Started just under the five-second threshold: the counter is empty on the
  // first paint and fills itself as the clock crosses it — the string moves
  // without a paint, which is the whole reason the row owns a timer.
  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 4_900))
  assert.equal(elapsed(), '', 'a short wait is not worth a number')
  await new Promise((resolve) => setTimeout(resolve, 260))
  const ticked = elapsed()
  assert.notEqual(ticked, '', 'past five seconds the counter appears on its own')

  stopClock()
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(elapsed(), ticked, 'a stopped clock keeps its last value')
})

test('the kept thinking head reports the disclosure it is showing, both ways', (t) => {
  // The regression the kept head introduced: its click closure is built once, so
  // it reads a mutable ref — and a ref whose key no `node()` claims is pruned and
  // rebuilt every paint, which left the head reporting 「folded」 forever and a row
  // that opened but would not close.
  const view = mount(t)
  const disclosure = new Map<string, boolean>()
  const items = turnItems({ pending: true })
  const paint = (): void => view.render(transcript(items), disclosure, RUNNING_T1)
  const head = (): StubView => {
    const found = groupOf(view).children[1]?.children[0]?.children[0]
    assert.ok(found)
    return found
  }

  paint()
  view.stub.click(head().node)
  assert.deepEqual(view.toggled, [['th1', false]], 'folded, so the click asks to open')

  disclosure.set('th1', true)
  paint()
  view.stub.click(head().node)
  assert.deepEqual(view.toggled, [['th1', false], ['th1', true]], 'open, so the same node asks to close')
})

// --- the newest question's place on screen ------------------------------------

/**
 * A 600px scroller with an 8px inset, holding a conversation `content` px tall,
 * with the newest bubble 72px into the column.
 *
 * Installed as a *rule* rather than written onto nodes: the bubble whose box
 * decides everything here does not exist until the paint that measures it, so
 * there is no earlier moment at which a test could have given it one. See
 * `DomStub.onLayout`.
 *
 * The rule moves with `scrollTop` and grows the column's box by the pad the view
 * last wrote — between them the stub answers the way a browser would, which is
 * the only way the two quantities the view subtracts can be checked at all.
 */
function laidOut(view: Rendered, content = 184): void {
  view.stub.setMetrics(view.container, { clientHeight: 600, scrollHeight: 600, scrollTop: 0 })
  view.stub.onLayout((node) => {
    if (node.classes.includes('transcript')) return { top: 100, bottom: 700 }
    const scrolled = view.container.scrollTop
    if (node.classes.includes('transcript-column')) {
      const pad = Number.parseFloat(node.styleProperties.get('--transcript-pad') ?? '0')
      return { top: 108 - scrolled, bottom: 108 + content + pad - scrolled }
    }
    if (node.classes.includes('user')) return { top: 180 - scrolled, bottom: 220 - scrolled }
    return undefined
  })
}

/**
 * A paint with a turn in flight.
 *
 * The lift is a *streaming* behaviour: the pad exists so the question being
 * answered can own the screen while the answer arrives, and a paint with no
 * turn running rests the pad on its floor instead (see the settling tests
 * below). So every test about where a new question lands has to say that a turn
 * is running, exactly as the pane does.
 */
function live(state: TranscriptState): WaitingInput {
  return waiting(state, undefined)
}

/** The pad the view wrote this paint, as the CSS length it wrote. */
function pad(view: Rendered): string | undefined {
  return view.column().styleProperties.get('--transcript-pad')
}

function currentPad(view: Rendered): number {
  return Number.parseFloat(pad(view) ?? '0')
}

test('a new question is lifted to the top of the viewport, and the pad is what lets it', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  // The bubble starts 80px below the scroller's top edge, and it is the first
  // thing in the session — so it goes up to the scroller's own 8px padding, a
  // travel of 72px.
  assert.equal(view.container.scrollTop, 72, 'the scroller was not moved to the anchor')
  // 600 (the viewport) − 8 (the gap left above it) − 120 (the bubble's top to
  // the end of the scrollable content). Without it the scroller could not move.
  assert.equal(pad(view), '472px')
  // And the pad is *exactly* enough: the anchor's new offset is the scroller's
  // maximum, so a streaming turn's tail-follow lands on the same pixel rather
  // than a few past it.
  // 200 of conversation plus a 472 pad, less the 600 on screen.
  assert.equal(200 + 472 - 600, view.container.scrollTop)
})

test('a header above the entries does not shift the anchor off the newest question', (t) => {
  const view = mount(t)
  laidOut(view)
  const header = document.createElement('div')
  header.className = 'coordinator-welcome'

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked), undefined, header)

  assert.equal(view.items()[0]!.classes.includes('coordinator-welcome'), true, 'the header leads the column')
  // The bubble is lifted (it was measured), and not as the first thing in the session: the header sits above it.
  assert.equal(view.container.scrollTop, 16)
})

test('a question with a turn above it keeps 64px of that turn on screen', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([
    { id: 'a', kind: 'user', text: '你好' },
    { id: 'b', kind: 'assistant', text: '你好呀' },
    { id: 'c', kind: 'user', text: '你是谁' },
  ])
  view.render(asked, undefined, live(asked))

  // 80px to the top, less the 64px of the previous answer left visible above it.
  assert.equal(view.container.scrollTop, 16)
  assert.equal(pad(view), '416px', 'and the pad is 56px shorter for the same reason')
})

test('the lift runs once per question, not once per streamed token', (t) => {
  const view = mount(t)
  laidOut(view)
  const items: TranscriptItem[] = [{ id: 'a', kind: 'user', text: '你好' }]

  const asked = transcript(items)
  view.render(asked, undefined, live(asked))
  assert.equal(view.container.scrollTop, 72)

  // The answer arriving must not re-run the lift: the reader may have scrolled
  // away, and a paint that hauls them back to the anchor on every chunk is the
  // yank the tail-follow has always been careful not to be.
  // 184 of conversation, 16 of scroller inset and the 472 pad the lift wrote —
  // the scroller now has somewhere to be scrolled *from*, and the reader has
  // gone back to the top of it.
  view.stub.dispatch(view.container, 'wheel', { deltaY: -72 })
  view.stub.setMetrics(view.container, { scrollTop: 0, scrollHeight: 672 })
  const answering = transcript([...items, { id: 'b', kind: 'assistant', text: '你好呀', pending: true }])
  view.render(answering, undefined, live(answering))
  assert.equal(view.container.scrollTop, 0, 'a repaint under the same question re-scrolled')
  // The pad is still rewritten, and unchanged because nothing under the anchor
  // grew. That is the regression this pins: `scrollHeight` carries the pad, so a
  // measurement that forgot to subtract it would read this paint's own blank as
  // content and drive the pad to its floor on the second frame of a turn.
  assert.equal(pad(view), '472px')
})

test('M15 reading history defers end padding recovery in the same paint as disclosure', (t) => {
  const view = mount(t)
  laidOut(view)
  const items: TranscriptItem[] = [{ id: 'a', kind: 'user', text: 'question', turnId: 't1' },
    { id: 's', kind: 'thinking', text: 'body', turnId: 't1', pending: true }]
  view.render(transcript(items), NO_DISCLOSURE, RUNNING_T1)
  const before = pad(view)
  view.stub.dispatch(view.container, 'wheel', { deltaY: -72 })
  view.stub.setMetrics(view.container, { scrollTop: 0, scrollHeight: 672 })
  view.render(transcript(items.map((item) => ({ ...item, pending: false }))))
  assert.equal(pad(view), before, 'reading content and its space remain together')
  assert.equal(view.column().classes.includes('settling'), false)
  // The turn still folds at its end: reading holds the pad, not the disclosure.
  assert.equal(groupOf(view).classes.includes('collapsed'), true)
  assert.equal(view.container.scrollTop, 0)
})

test('M15 a disclosure keeps its triggering head at the same viewport offset and yields to a wheel', (t) => {
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  const frames = new Map<number, FrameRequestCallback>()
  let sequence = 0
  globalThis.requestAnimationFrame = (run) => { frames.set(++sequence, run); return sequence }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel })
  const view = mount(t)
  let shift = 0
  view.stub.dispatch(view.container, 'wheel', { deltaY: -100 })
  view.stub.setMetrics(view.container, { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 })
  view.stub.onLayout((node) => {
    if (node.node === view.container) return { top: 0, bottom: 400 }
    if (node.classes.includes('step-head')) return { top: 200 + shift - view.container.scrollTop, bottom: 220 + shift - view.container.scrollTop }
    return undefined
  })
  const items: TranscriptItem[] = [{ id: 's', kind: 'thinking', text: 'body', turnId: 't1' }]
  view.render(transcript(items), new Map([['t1', true], ['s', true]]))
  const head = groupOf(view).children[1]!.children[0]!.children[0]!.node
  view.stub.click(head)
  view.render(transcript(items), new Map([['t1', true], ['s', false]]))
  shift = -35
  const [id, frame] = [...frames][0]!
  frames.delete(id)
  frame(16)
  assert.equal(view.container.scrollTop, 65)
  assert.equal(200 + shift - view.container.scrollTop, 100, 'the title stays under the pointer')
  view.stub.dispatch(view.container, 'wheel')
  assert.equal(frames.size, 0, 'user input cancels every owed anchor frame')
  view.stopClock()
})

test('the pad shrinks as the answer grows, so the bubble holds still while it streams', (t) => {
  const view = mount(t)
  // The same conversation 200px longer.
  laidOut(view, 384)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  assert.equal(pad(view), '272px', '472 − 200: exactly what the answer took')
})

test('a transcript with no question in it carries no pad', (t) => {
  const view = mount(t)
  laidOut(view)

  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px')

  // `transcript-reset` and a pane showing only startup notices land here. The
  // pad has to go with the conversation, or the reset leaves a screenful of
  // blank under a transcript that has nothing holding it up.
  view.render(transcript([{ id: 'n', kind: 'notice', text: '会话已重置' }]))
  assert.equal(pad(view), '0px')
})

test('a pane with no layout writes nothing rather than a pad measured from nothing', (t) => {
  const view = mount(t)
  // No `onLayout` and no metrics: a background pane, whose every reading is zero
  // or `NaN`. Writing from that would leave a stale pad for the paint that
  // brings the pane back.
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))

  assert.equal(pad(view), undefined)
  assert.equal(view.container.scrollTop, 0)
})

test('a question painted before the pane had layout is lifted on the paint that can', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'a', kind: 'user', text: '你好' }])

  // A pane built in the background paints its first message with nothing to
  // measure. If that paint spent the anchor, the question would be stranded
  // wherever the flow left it for the whole of its turn.
  view.render(state, undefined, live(state))
  assert.equal(pad(view), undefined)

  laidOut(view)
  view.render(state, undefined, live(state))
  assert.equal(view.container.scrollTop, 72, 'the question was never lifted')
  assert.equal(pad(view), '472px')
})

test('the pad follows the viewport, which moves without the transcript repainting', (t) => {
  // Two real ones: the canvas header is `hidden` until the lane has a name, so
  // the first paint of a restored session measures a taller scroller than it
  // ends up in; and the composer takes a line off the transcript every time the
  // draft wraps. Neither repaints this view.
  const resizes: Array<() => void> = []
  const previous = (globalThis as { ResizeObserver?: unknown }).ResizeObserver
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(run: () => void) { resizes.push(run) }
    observe(): void {}
    disconnect(): void {}
  }
  t.after(() => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = previous })

  const view = mount(t)
  laidOut(view)
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])
  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px')

  // 36px of canvas header arrives. A pad still measured against the old height
  // leaves the scroller 36px of travel it should not have, and the next
  // tail-follow spends it by sliding the question off its gap.
  view.stub.setMetrics(view.container, { clientHeight: 564 })
  for (const resize of resizes) resize()

  assert.equal(pad(view), '436px')
  assert.equal(view.container.scrollTop, 72, 'a resize is not a new question and must not re-scroll')
})

test('M19 transcript resize observation pauses on hiding, resumes on paint and ends on disposal', (t) => {
  const previous = globalThis.ResizeObserver
  let observed = 0
  let disconnected = 0
  globalThis.ResizeObserver = class {
    observe() { observed += 1 }
    disconnect() { disconnected += 1 }
    unobserve() {}
  }
  t.after(() => { globalThis.ResizeObserver = previous })
  const view = mount(t)
  const state = transcript([{ id: 'a', kind: 'user', text: 'hello' }])
  view.render(state)
  view.render(state)
  // Two targets: the scroller, and the column whose content moves under it.
  assert.equal(observed, 2)
  view.stopClock()
  assert.equal(disconnected, 1)
  view.stub.setHidden(true)
  view.render(state)
  assert.equal(observed, 2, 'hidden windows do not start observing again')
  view.stub.setHidden(false)
  view.render(state)
  assert.equal(observed, 4)
  view.dispose()
  assert.equal(disconnected, 2)
})

test('the turn ending hands the pad back, so the tail is not a screenful of blank', (t) => {
  const view = mount(t)
  laidOut(view)
  const asked = transcript([{ id: 'a', kind: 'user', text: '你好' }])

  view.render(asked, undefined, live(asked))
  assert.equal(pad(view), '472px', 'while the turn runs the question owns the screen')
  assert.equal(view.column().classes.includes('settling'), false, 'a pad that moves every token must not animate')

  // `turn-end`: the pane paints once more with `isStreaming` false. The room
  // above the question was for an answer that has now arrived, and keeping it
  // is what put a screenful of nothing between the last line and the composer.
  view.render(asked)
  assert.equal(pad(view), `${ANCHOR_REST_PX}px`)
  assert.ok(view.column().classes.includes('settling'), 'the drop is a sink, and the sheet needs the class to make it one')

  // And the next turn takes it straight back, with the transition off again.
  const again = transcript([...asked.items, { id: 'b', kind: 'user', text: '再问一句' }])
  view.render(again, undefined, live(again))
  assert.equal(view.column().classes.includes('settling'), false)
  assert.notEqual(pad(view), `${ANCHOR_REST_PX}px`)
})

test('a session opened with no turn running lands on its tail, not on its last question', (t) => {
  const view = mount(t)
  laidOut(view)
  view.stub.setMetrics(view.container, { scrollHeight: 2000 })

  // `/resume`, a session switch, a pane painted for the first time: the anchor
  // is new (nothing has been painted yet) but nothing is running. Lifting here
  // would open the conversation on its last question with the whole canvas
  // empty underneath it.
  view.render(transcript([
    { id: 'a', kind: 'user', text: '你好' },
    { id: 'b', kind: 'assistant', text: '你好呀' },
  ]))

  assert.equal(view.container.scrollTop, 2000, 'a restored session opens where the reader left off')
  assert.equal(pad(view), `${ANCHOR_REST_PX}px`)
})

// --- a user message's images (S12) ---------------------------------------------

test('the images a user message carried draw as clickable thumbnails above the bubble', (t) => {
  const { render, items, stub, viewedImages, thumbs } = mount(t)
  const image = (id: string, name: string, width: number, height: number): ImageAttachmentRef => ({
    id, ownerSessionId: 'session-1', name, mimeType: 'image/png', width, height, byteLength: 1024,
  })
  const images = [
    image('img-1', 'shot.png', 1920, 1080),
    image('img-2', 'loop.gif', 640, 480),
  ]
  render(transcript([{ id: 'm1', kind: 'user', text: '看这两张', images }]))

  const item = items()[0]!
  const strip = item.children.find((child) => child.classes.includes('user-images'))
  assert.ok(strip, 'the images ride their own row')
  assert.equal(
    item.children.indexOf(strip) < item.children.findIndex((child) => child.classes.includes('user-bubble')),
    true,
    'the pictures come before the words',
  )
  const tiles = strip.children.filter((child) => child.classes.includes('user-image-thumb'))
  // No URL in hand yet: the box is empty and the alt carries the facts the
  // line here used to spell out, so the live region reads the same either way.
  assert.deepEqual(tiles.map((tile) => tile.attributes.has('src')), [false, false])
  assert.deepEqual(tiles.map((tile) => tile.attributes.get('alt')), [
    '图片 1：shot.png，1920×1080',
    '图片 2：loop.gif，640×480',
  ])
  assert.deepEqual(tiles.map((tile) => tile.attributes.get('role')), ['button', 'button'])

  stub.click(tiles[0]!.node)
  stub.click(tiles[1]!.node)
  assert.deepEqual(viewedImages, [['img-1', 'shot.png'], ['img-2', 'loop.gif']])

  // Enter works too — the tile is a real control, not a mouse-only affordance.
  stub.dispatch(tiles[0]!.node, 'keydown', { key: 'Enter' })
  assert.deepEqual(viewedImages.length, 3)

  // The item's own node is refilled rather than replaced — it is what the
  // scroll anchor points at — so the repaint discipline is asserted one level
  // down, on the tiles. A paint that changed nothing touches none of them.
  const tileNodes = () => items()[0]!.children
    .find((child) => child.classes.includes('user-images'))!
    .children.filter((child) => child.classes.includes('user-image-thumb'))
  const before = tileNodes().map((tile) => tile.node)
  render(transcript([{ id: 'm1', kind: 'user', text: '看这两张', images }]))
  const after = tileNodes().map((tile) => tile.node)
  assert.equal(after.length, before.length)
  // Identity, one by one: a deep compare would walk the parent chain instead.
  after.forEach((node, index) => assert.equal(node, before[index], 'nothing changed, nothing rebuilt'))

  // The URL arriving is a signature change: the row repaints once, and the src
  // lands on the tile that gained it.
  thumbs.set('img-1', 'data:image/png;base64,AA')
  render(transcript([{ id: 'm1', kind: 'user', text: '看这两张', images }]))
  assert.deepEqual(
    tileNodes().map((tile) => tile.attributes.get('src')),
    ['data:image/png;base64,AA', undefined],
  )
})

test('a user item without images paints no image row, and a repaint keeps the node', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '纯文字' }]))
  assert.deepEqual(items()[0]!.children.filter((child) => child.classes.includes('user-images')), [])

  // Unchanged repaint: the item's node is reused, the painter's own rule — so
  // a streaming turn cannot rebuild a row the pointer is on.
  const before = items()[0]!.node
  render(transcript([{ id: 'm1', kind: 'user', text: '纯文字' }]))
  assert.equal(items()[0]!.node, before)
})

test('T6 thread note cards: head, status label, and 查看 only with a thread id', (t) => {
  const opened: string[] = []
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const real = createTranscriptView(container, host, {
    onToggle: () => {}, onTaskStep: () => {}, onOpenSubagent: () => {}, onOpenPath: () => {},
    onViewImage: () => {}, imageThumbUrl: () => undefined, onCopy: () => {},
    onOpenThread: (id) => opened.push(id),
  })
  const item: TranscriptItem = {
    id: 'w', kind: 'thread-notes', text: 'wake',
    threadNotes: { wake: { count: 2, limit: 10, reason: 'converged' }, cards: [
      { threadId: 'thr_0123456789ab', status: 'idle', title: 'A', report: 'done' },
      { status: 'weird', title: 'B' },
    ] },
  }
  real.render({ ...createTranscriptState(), items: [item] }, NO_DISCLOSURE)
  const root = stub.inspect(container)
  const text = root.text
  assert.ok(text.includes('自动唤醒 · 2/10'))
  assert.ok(text.includes('空闲'))
  assert.ok(text.includes('weird'))
  const buttons = (function walk(n: StubView): StubView[] {
    return [...(n.classes.includes('thread-note-open') ? [n] : []), ...n.children.flatMap(walk)]
  })(root)
  assert.equal(buttons.length, 2)
  stub.dispatch(buttons[0]!.node, 'click', {})
  assert.deepEqual(opened, ['thr_0123456789ab'])
  assert.equal(buttons[1]!.disabled, true)
  real.dispose()
})
