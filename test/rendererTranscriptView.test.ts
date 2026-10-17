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
import type { TaskCard } from '../src/desktop/renderer/model/tasks.js'
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
const IDLE_ACTIVITY: WaitingInput = { isStreaming: false, startedAt: undefined, turnId: undefined }
const RUNNING_T1: WaitingInput = { isStreaming: true, turnId: 't1', startedAt: undefined }

// M03: a tool result is not the end of its live turn.
test('M03 keeps the run mounted between short tools', (t) => {
  const view = mount(t)
  const activity = { isStreaming: true, turnId: 't1', startedAt: Date.now() }
  const tool: TranscriptItem = { id: 'a', kind: 'tool', text: 'read', turnId: 't1', pending: true,
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts' } }
  const open = new Map([['run:a', true]])
  view.render(transcript([tool]), open, activity)
  const run = runOf(view).node
  const head = runOf(view).children[0]!.node
  const card = runOf(view).children[1]!.node
  view.render(transcript([{ ...tool, pending: undefined }]), open, activity)
  view.render(transcript([{ ...tool, pending: undefined }, { ...tool, id: 'b' }]), open, activity)
  assert.equal(runOf(view).node, run)
  assert.equal(runOf(view).children[0]!.node, head)
  assert.equal(runOf(view).children[1]!.node, card, 'the card is not rebuilt under a growing run')
  // The reader's fold outranks the next step arriving.
  view.render(transcript([tool, { ...tool, id: 'b' }]), new Map([['run:a', false]]), activity)
  assert.equal(view.stub.inspect(card).attributes.has('inert'), true)
  view.stub.dispatch(card, 'transitionend', { propertyName: 'height' })
  assert.equal(runOf(view).children.length, 1, 'a manual fold survives the next step')
})

// M04: an unchanged parent paint must keep its nested head cache alive.
test('M04 keeps the thinking line through an unchanged streaming snapshot', (t) => {
  const view = mount(t)
  const identity = trackIdentity(view.column, '.run-line')
  const starts = trackAnimationStarts(view.column, '.line-mark', view.stub.observeMotion)
  t.after(starts.dispose)
  let head: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([{ id: 'th', kind: 'thinking', text, turnId: 't1', pending: true }]),
      NO_DISCLOSURE, { isStreaming: true, turnId: 't1', startedAt: undefined })
    head ??= identity.sample()
    assert.ok(head)
    assert.equal(identity.sample(), head)
  }
  assert.equal(starts.starts, 0, 'the spark keeps turning while the words change')
  const items: TranscriptItem[] = [{ id: 'th', kind: 'thinking', text: 'ABC', turnId: 't1', pending: true }]
  view.render(transcript(items), new Map([['th', true]]), RUNNING_T1)
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled, [['th', true]], 'the surviving head reads the current ref')
  view.render(transcript(items, { generation: 1 }), NO_DISCLOSURE, RUNNING_T1)
  assert.notEqual(identity.sample(), head, 'a reset with reused ids clears the nested cache')
  view.stub.click(identity.sample() as HTMLElement)
  assert.deepEqual(view.toggled.at(-1), ['th', false], 'reset does not inherit the previous disclosure ref')
})

test('M05 keeps the thought text node and settled assistant blocks across deltas', (t) => {
  const view = mount(t)
  const body = trackIdentity(view.column, '.line-text')
  let firstBody: unknown
  let firstParagraph: unknown
  for (const text of ['A', 'AB', 'AB', 'ABC']) {
    view.render(transcript([
      { id: 'th', kind: 'thinking', text, turnId: 't1', pending: true },
      { id: 'answer', kind: 'assistant', text: `Stable.\n\n${text}`, pending: true },
    ]), new Map([['th', true]]), RUNNING_T1)
    firstBody ??= body.sample()
    firstParagraph ??= view.items()[1]!.children[0]!.node
    assert.ok(firstBody)
    assert.equal(body.sample(), firstBody)
    assert.equal(view.items()[1]!.children[0]!.node, firstParagraph)
    assert.equal(view.items()[1]!.children.some((node) => node.className === 'item-meta'), false)
  }
})

test('M21 real stream records retain thinking, Markdown and manual disclosure through commit and demotion', (t) => {
  const view = mount(t)
  let state = createTranscriptState()
  const manual: DisclosureState = new Map([['thinking-0', true]])
  const apply = (event: SessionEvent): void => {
    state = applySessionEvent(state, event).state
    view.render(presentationTranscript(state), manual, RUNNING_T1)
  }
  const createdAt = '2026-09-10T00:00:00.000Z'
  apply({ type: 'record', record: { type: 'message', id: 'u1', role: 'user', content: 'go', turnId: 't1', createdAt } })
  apply({ type: 'stream', event: { type: 'message_start' } })
  apply({ type: 'stream', event: { type: 'thinking_delta', thinking: 'Reasoning.' } })
  const head = trackIdentity(view.column, '.run-line').sample()
  const body = trackIdentity(view.column, '.line-text').sample()
  assert.ok(head)
  assert.ok(body)
  const text = 'Stable paragraph.\n\n~~~ts\nconst value = 1\n~~~\n\n$E=mc^2$\n\nMore.'
  apply({ type: 'stream', event: { type: 'text_delta', text } })
  const owner = trackIdentity(view.column, '.md').sample()
  const children = [...(owner as HTMLElement).childNodes]
  view.stub.focus(head)
  apply({ type: 'record', record: { type: 'message', id: 'a1', role: 'assistant', content: text,
    thinkingBlocks: [{ type: 'thinking', thinking: 'Reasoning.' }], turnId: 't1', createdAt } })
  assert.equal(trackIdentity(view.column, '.run-line').sample(), head)
  assert.equal(trackIdentity(view.column, '.line-text').sample(), body)
  assert.equal(view.stub.activeElement(), head)
  assert.equal(trackIdentity(view.column, '.md').sample(), owner)
  apply({ type: 'record', record: { type: 'tool_use', id: 'tool1', tool: 'Read', input: { filePath: 'a.ts' }, turnId: 't1', createdAt, riskLevel: 'safe' } })
  assert.equal(trackIdentity(view.column, '.md').sample(), owner, 'the prose keeps its carrier when a tool follows it')
  // The commit adds the meta row after the text; every paragraph before it is the same node.
  assert.deepEqual([...(owner as HTMLElement).childNodes].slice(0, children.length), children)
  view.stub.click(head)
  assert.deepEqual(view.toggled.at(-1), ['thinking-0', true], 'the retained head and manual map still use the same identity')
})

for (const kind of ['tool', 'subagent'] as const) {
  test(`M13 ${kind} collapse returns focus immediately and reverses with the same body`, (t) => {
    const view = mount(t)
    const item: TranscriptItem = { id: 's', kind, text: 'body', turnId: 't1',
      ...(kind === 'tool' ? { tool: { displayName: 'Read', useSummary: '', content: 'body' } } : {}) }
    const paint = (open: boolean) => view.render(transcript([item]), new Map([['run:s', true], ['s', open]]))
    paint(true)
    const head = rowOf(view).children[0]!.node as HTMLElement
    const body = rowOf(view).children[1]!.node as HTMLElement
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
    assert.equal(rowOf(view).children[1]!.node, body)
    assert.equal(body.classList.contains('presence-entering'), true)
    paint(false)
    view.stopClock()
    assert.equal(body.parentElement, null, 'pane hiding finishes and removes the closing body')
    paint(true)
    assert.equal(rowOf(view).children[0]!.node, head)
  })
}

test('a finished turn stays folded, however it was read', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 's', kind: 'tool', text: 'read', turnId: 't1', pending: true,
    toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts', content: 'reading' } }
  view.render(transcript([item]), NO_DISCLOSURE, RUNNING_T1)
  view.stub.dispatch(view.container, 'wheel', { deltaY: -100 })
  view.stub.setMetrics(view.container, { scrollTop: 100, scrollHeight: 2000, clientHeight: 400 })
  view.render(transcript([{ ...item, pending: false }]))
  assert.equal(runOf(view).classes.includes('open'), false)
  assert.equal(runOf(view).children.length, 1, 'only the summary line')
})

test('a thought opens in place: the whole text on the line, no body, focus stays', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 'a', kind: 'thinking', text: '首句。\n后文。', turnId: 't1' }
  const paint = (open: boolean) => view.render(transcript([item]), new Map([['a', open]]))
  paint(false)
  const head = runOf(view).children[0]!.children[0]!.node as HTMLElement
  view.stub.focus(head)
  paint(true)
  assert.equal(runOf(view).children[0]!.children[0]!.children[0]!.text, '首句。\n后文。')
  assert.equal(runOf(view).children[0]!.children.length, 1)
  assert.equal(view.stub.activeElement(), head)
  paint(false)
  assert.equal(runOf(view).children[0]!.children[0]!.children[0]!.text, '首句。')
  assert.equal(view.stub.activeElement(), head)
})

test('M14 advancing the current thought keeps an opened one open without replay', (t) => {
  const view = mount(t)
  const first: TranscriptItem = { id: 'a', kind: 'thinking', text: 'first', turnId: 't1', pending: true }
  const opened = new Map([['a', true]])
  view.render(transcript([first]), opened, RUNNING_T1)
  const head = runOf(view).children[0]!.children[0]!.node
  view.render(transcript([{ ...first, pending: false }, { ...first, id: 'b', text: 'next' }]), opened, RUNNING_T1)
  const [earlier, later] = view.items().map((item) => item.children[0]!)
  assert.equal(earlier!.classes.includes('open'), true)
  assert.equal(earlier!.children[0]!.node, head, 'the open line stays where it is')
  assert.equal(later!.classes.includes('open'), false, 'the new thought starts folded')
})

test('a live thought shimmers on its first sentence, and opens to the whole text', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 's', kind: 'thinking', text: '第一行。\n第二行。\n第三行。', turnId: 't1', pending: true }
  view.render(transcript([item]), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 7_000 })
  const line = runOf(view).children[0]!
  assert.deepEqual(line.classes, ['thinking', 'live'])
  const head = line.children[0]!
  assert.deepEqual(head.classes, ['run-line'])
  assert.deepEqual(
    head.children.map((part) => [part.classes.join(' '), part.text]),
    [['line-text', '第一行。']],
  )
  assert.equal(head.attributes.get('aria-label'), '第一行。')
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  assert.equal(line.children.length, 1, 'folded: no body in the page')

  view.stub.click(head.node)
  assert.deepEqual(view.toggled, [['s', false]])

  view.render(transcript([item]), new Map([['s', true]]), RUNNING_T1)
  const open = runOf(view).children[0]!
  assert.equal(open.classes.includes('open'), true)
  assert.equal(open.children.length, 1, 'no body node: the line itself opens')
  assert.equal(open.children[0]!.children[0]!.text, '第一行。\n第二行。\n第三行。', 'the whole text, not the sentence')

  // Sealed: the line says the first sentence.
  const { pending: _pending, ...sealed } = item
  view.render(transcript([sealed]), new Map([['s', true]]))
  const done = runOf(view).children[0]!.children[0]!
  assert.equal(runOf(view).children[0]!.classes.includes('live'), false, 'sealed: the shimmer stops')
  assert.deepEqual(done.children.map((part) => part.classes.join(' ')), ['line-text'])
  assert.equal(done.children[0]!.text, '第一行。\n第二行。\n第三行。')
  view.render(transcript([sealed]), NO_DISCLOSURE)
  assert.equal(runOf(view).children[0]!.children[0]!.children[0]!.text, '第一行。')
})

test('a sealed thought shows no time, measured or not', (t) => {
  const view = mount(t)
  const head = (): StubView => runOf(view).children[0]!.children[0]!
  view.render(transcript([{ id: 's', kind: 'thinking', text: 'why', turnId: 't1', durationMs: 12_000 }]))
  assert.deepEqual(head().children.map((child) => child.classes.join(' ')), ['line-text'])
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
  /** How many times the status line's background-task button was pressed. */
  readonly backgroundOpens: () => number
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
  /** The plan text each plan-receipt click handed the pane. */
  readonly openedPlans: ReadonlyArray<string | undefined>
  render(state: TranscriptState, disclosure?: DisclosureState, activity?: WaitingInput, selectedSubagent?: string, header?: HTMLElement): void
  stopClock(): void
  dispose(): void
  jump(): StubView
  items(): readonly StubView[]
  column(): StubView
}

function mount(t: { after(fn: () => void): void }): Rendered {
  const stub = installDomStub()
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const toggled: Array<readonly [string, boolean]> = []
  const opened: Array<readonly [string, number | undefined]> = []
  const copied: string[] = []
  const rewound: string[] = []
  const viewedImages: Array<readonly [string, string]> = []
  const thumbs = new Map<string, string>()
  const openedSubagents: string[] = []
  const openedPlans: Array<string | undefined> = []
  let backgroundOpens = 0
  const view = createTranscriptView(container, host, {
    onToggle: (id, expanded) => toggled.push([id, expanded]),
    onOpenPlan: (content) => openedPlans.push(content),
    onOpenPath: (path, line) => opened.push([path, line]),
    onViewImage: (image) => viewedImages.push([image.id, image.name]),
    imageThumbUrl: (imageId) => thumbs.get(imageId),
    onCopy: async (text) => { copied.push(text); return true },
    onRewind: (id) => rewound.push(id),
    onOpenSubagent: (id) => openedSubagents.push(id),
    onOpenBackgroundTasks: () => { backgroundOpens += 1 },
  })
  // Disposed before the stub goes: a live mark's frame timers outlive the test otherwise.
  t.after(() => {
    view.dispose()
    stub.uninstall()
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
    backgroundOpens: () => backgroundOpens,
    toggled,
    opened,
    viewedImages,
    thumbs,
    copied,
    rewound,
    openedSubagents,
    openedPlans,
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

  stub.setMetrics(container, { scrollTop: 800 })
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
})

test('a slow wheel inside the 24px slack is not pulled back to the tail', (t) => {
  const { render, stub, container, jump } = mount(t)

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  scrolledUpBy(stub, container, 4)
  stub.dispatch(container, 'scroll')
  render(transcript([{ id: 'a', kind: 'assistant', text: 'xy' }]))
  assert.equal(stub.inspect(container).scrollTop, 796)
  assert.equal(jump().hidden, false)
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

test('loose items paint as items: messages, notices and 已中断; the duration is not a row', (t) => {
  const { render, items } = mount(t)

  render(transcript([
    { id: 'a', kind: 'user', text: 'hi' },
    { id: 'b', kind: 'notice', text: '上下文已压缩' },
    { id: 'c', kind: 'error', text: 'boom', failed: true },
    { id: 'd', kind: 'duration', text: '已处理 1s', durationMs: 1000, turnId: 't1' },
    { id: 'e', kind: 'notice', text: 'Interrupted.', interrupt: true },
  ]), NO_DISCLOSURE, IDLE_ACTIVITY)

  assert.deepEqual(items().map((item) => item.classes), [
    ['item', 'user'],
    ['item', 'notice'],
    ['item', 'error', 'failed'],
    ['item-meta', 'turn-foot'],
    ['item', 'notice', 'interrupt'],
  ])
  assert.deepEqual(items().map((item) => item.text), ['hi显示更多', '上下文已压缩', 'boom', '用时 1s', '已中断'])
})

test('a duration made from a streaming turn’s records is not drawn until the turn ends', (t) => {
  const { render, items } = mount(t)
  const stamped = (id: string, kind: TranscriptItem['kind'], at: string, extra: Partial<TranscriptItem> = {}): TranscriptItem =>
    ({ id, kind, text: id, turnId: 't1', createdAt: at, ...extra })
  const turn = [
    stamped('u1', 'user', '2026-01-01T00:00:00.000Z'),
    stamped('a1', 'assistant', '2026-01-01T00:00:05.000Z'),
  ]
  render(transcript(turn), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: undefined })
  assert.equal(items().some((item) => item.classes.includes('duration')), false)
  render(transcript(turn), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.equal(items().some((item) => item.classes.includes('duration')), false, 'never a row')
  assert.deepEqual(factsOf(items().at(-1)!), ['用时 5s'], 'settled: the span of the records, as replay has no measured time')
})

// --- the thinking line -------------------------------------------------------

const sealedThinking: TranscriptItem = {
  id: 'thinking-0', kind: 'thinking', text: '推理。然后呢。', durationMs: 458_000,
}

test('a thought with no tool is a line of its own, folded until opened', (t) => {
  const { render, items } = mount(t)
  render(transcript([sealedThinking]))

  assert.deepEqual(items()[0]!.classes, ['run', 'thinking-run'])
  const line = items()[0]!.children[0]!
  assert.deepEqual(line.classes, ['thinking'])
  const head = line.children[0]!
  assert.equal(head.tagName, 'BUTTON')
  assert.equal(head.attributes.get('aria-label'), '推理。')
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  // The first sentence alone: no time, no caret.
  assert.deepEqual(head.children.map((child) => [child.className, child.text]), [['line-text', '推理。']])
  assert.equal(line.children.length, 1, 'the whole text is absent, not hidden')
})

test('the pane’s absolute answer outranks the default, both ways', (t) => {
  const { render, items } = mount(t)
  const line = (): StubView => items()[0]!.children[0]!

  render(transcript([sealedThinking]), new Map([['thinking-0', true]]))
  assert.equal(line().classes.includes('open'), true)
  assert.equal(line().children.length, 1)
  assert.equal(line().children[0]!.children[0]!.text, '推理。然后呢。')

  render(transcript([sealedThinking]), new Map([['thinking-0', false]]))
  assert.equal(line().classes.includes('open'), false)
  assert.equal(line().children[0]!.children[0]!.text, '推理。', 'folded back to the first sentence')
})

test('clicking the line reports the thought’s id and what it showed', (t) => {
  const { render, items, stub, toggled } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: 'hi' }, sealedThinking]))

  // The pane stores the opposite of what the row showed, so the first click
  // always does the visible thing.
  stub.click(items()[1]!.children[0]!.children[0]!.node)
  assert.deepEqual(toggled, [['thinking-0', false]])
})

// --- runs of work ------------------------------------------------------------

/** A turn's items: the user message, then a tool call — one run. */
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
    tool,
  ]
}

/** The run's id is `run:` + its first step's, and that is the key of its own fold. */
const RUN = 'run:call-1'

/** Opens the run holding `ids[0]` and each of `ids`. */
function opened(...ids: string[]): DisclosureState {
  return new Map([[`run:${ids[0]}`, true], ...ids.map((id): [string, boolean] => [id, true])])
}

const runOf = (rendered: Rendered): StubView => {
  const found = rendered.items().find((item) => item.classes.includes('run'))
  assert.ok(found, 'no run was painted')
  return found
}

/** The first row of the first run's card. */
const rowOf = (rendered: Rendered): StubView => {
  const row = runOf(rendered).children[1]?.children[0]
  assert.ok(row, 'the run is folded, or has no rows')
  return row
}

test('a settled run is one summary line, folded', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run'])
  const run = runOf(view)
  assert.deepEqual(run.classes, ['run'])
  const head = run.children[0]!
  assert.equal(head.tagName, 'BUTTON')
  assert.deepEqual(head.children.map((child) => [child.className, child.text]), [['line-text', '读取 1 个文件'], ['icon', '']])
  assert.equal(head.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(head.attributes.get('aria-label'), '读取 1 个文件')
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  // The transcript is an `aria-live` region: a folded run must not be readable.
  assert.equal(run.children.length, 1, 'nothing but the line')
  assert.equal(run.text.includes('line one'), false)
})

test('a failed call is counted in red beside the counts, and an edit’s patch counts ride the line', (t) => {
  const view = mount(t)
  const failed: TranscriptItem = { ...turnItems()[1]!, failed: true }
  view.render(transcript([turnItems()[0]!, failed]))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '读取 1 个文件'], ['line-fail', '· 1 个失败'], ['icon', '']],
  )
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 1 个文件 · 1 个失败')

  view.render(transcript([{ ...editStep({ detail: EDIT_PATCH }), id: 'e1' }]))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '编辑 1 个文件'], ['line-meta', '+1 −1'], ['icon', '']],
  )

  const cut: TranscriptItem[] = [turnItems()[0]!, { ...turnItems({ pending: true })[1]!, pending: true }, { id: 'stop', kind: 'notice', text: 'Interrupted.', turnId: 't1', interrupt: true }]
  view.render(transcript(cut))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '读取 1 个文件'], ['line-meta', '· 已中断'], ['icon', '']],
  )
})

test('a running run’s line is its summary; the status is the line below it', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 6_000 })

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run', 'waiting'])
  const run = runOf(view)
  assert.deepEqual(run.classes, ['run'])
  const head = run.children[0]!
  assert.deepEqual(head.classes, ['run-line'])
  assert.deepEqual(head.children.map((child) => child.classes.join(' ')), ['line-text', 'icon'], 'no mark, no clock')
  assert.equal(head.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(head.attributes.get('aria-label'), head.children[0]!.text)
  assert.equal(head.attributes.get('aria-expanded'), 'false', 'folded while it runs, too')
})

test('opened, a run is a card with a row per step; a thought between tools is a line of its own', (t) => {
  const view = mount(t)
  const [user, tool] = turnItems({ pending: true })
  const thought: TranscriptItem = { id: 'th1', kind: 'thinking', text: '先看看这个文件。', turnId: 't1' }
  view.render(transcript([user!, thought, tool!]), new Map([[RUN, true]]), RUNNING_T1)

  assert.deepEqual(view.items().map((entry) => entry.classes.join(' ')), ['item user', 'run thinking-run', 'run open', 'waiting'])
  const run = view.items()[2]!
  assert.equal(run.children[1]!.classes.includes('run-card'), true)
  assert.deepEqual(run.children[1]!.children.map((row) => row.classes), [['step', 'tool', 'running', 'collapsed']])
})

test('a tool row is a button whose body exists only while it is open', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()), opened('call-1'))
  const tool = runOf(view).children[1]!.children[0]!

  const head = tool.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  assert.deepEqual(head?.children.map((part) => [part.className, part.text]), [['step-label', '读取 a.ts'], ['icon', '']])
  // The state reaches a screen reader as words, because colour is not a name.
  assert.equal(head?.attributes.get('aria-label'), '读取 a.ts · 完成')
  // 兜底 body: the result's own summary over `detail ?? content` (§6.2).
  assert.deepEqual(
    tool.children[1]?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 240 lines'], ['step-body-text', 'line one']],
  )

  view.render(transcript(turnItems()), new Map([[RUN, true]]))
  view.stub.dispatch(runOf(view).children[1]?.children[0]?.children[1]?.node, 'transitionend', { propertyName: 'height' })
  const folded = runOf(view).children[1]?.children[0]
  assert.equal(folded?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(folded?.children[0]?.attributes.get('aria-expanded'), 'false')
})

test('a row with nothing to show is a plain line, not a button that does nothing', (t) => {
  const view = mount(t)
  const bare: TranscriptItem = { id: 'sk', kind: 'tool', text: 'Skill', toolName: 'Skill', turnId: 't1', tool: { displayName: 'Skill', useSummary: 'web-designer' } }
  view.render(transcript([bare]), opened('sk'))
  const head = rowOf(view).children[0]!
  assert.equal(head.tagName, 'DIV')
  assert.deepEqual(head.classes, ['step-head', 'static'])
  assert.deepEqual(head.children.map((part) => part.text), ['使用技能 web-designer'])
})

test('the run line names its summary, and keeps it when the turn ends', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const running = runOf(view).children[0]!.attributes.get('aria-label')
  assert.ok(running)

  view.render(transcript(turnItems()))
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 1 个文件')
})

test('the run survives the turn ending, and its line is kept and reports what it showed', (t) => {
  // The browser's scroll anchoring can only hold a reader's place while the node
  // the anchor points at outlives the paint.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const before = runOf(view).node
  const head = runOf(view).children[0]!.node

  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(runOf(view).children[0]!.node, head, 'an unchanged line is not rebuilt')

  view.render(transcript(turnItems()))
  assert.equal(runOf(view).node, before, 'the run is refilled in place, not replaced')
  assert.equal(runOf(view).children[0]!.node, head, 'the line survives the turn ending')
  assert.equal(runOf(view).children[0]!.attributes.get('aria-expanded'), 'false')

  view.stub.click(head)
  assert.deepEqual(view.toggled, [[RUN, false]], 'the kept head reports the paint that is on screen')
})

test('the run and its rows report their own id and what they showed', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))
  view.stub.click(runOf(view).children[0]?.node)
  assert.deepEqual(view.toggled, [[RUN, false]], 'the run answers under its own id')

  view.render(transcript(turnItems()), new Map([[RUN, true]]))
  const card = runOf(view).children[1]
  view.stub.click(card?.children[0]?.children[0]?.node)
  assert.deepEqual(view.toggled.slice(1), [['call-1', false]])
})

test('nodes are kept by id across paints, so the scroll anchor survives', (t) => {
  // Verified by mutation: rebuilding the column every render reds every
  // identity assertion below.
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), new Map([[RUN, true]]), RUNNING_T1)
  const before = {
    column: view.column().node,
    message: view.items()[0]?.node,
    run: runOf(view).node,
    row: runOf(view).children[1]?.children[0]?.node,
  }

  // A later paint of the same turn, with the tool now settled: fresh item objects
  // throughout, as the model mints them.
  view.render(transcript(turnItems()), new Map([[RUN, true]]))
  assert.equal(view.column().node, before.column)
  assert.equal(view.items()[0]?.node, before.message, 'an untouched message is not rebuilt')
  assert.equal(runOf(view).node, before.run)
  assert.equal(runOf(view).children[1]?.children[0]?.node, before.row, 'the row is refilled in place')

  // And a node whose entry is gone does not linger in the cache: `transcript-reset`
  // restarts the id counter, so a kept node would come back holding another
  // block's content.
  view.render(transcript([{ id: 'reset-notice-0', kind: 'notice', text: '已清空' }]))
  view.render(transcript(turnItems({ pending: true })), new Map([[RUN, true]]), RUNNING_T1)
  assert.notEqual(runOf(view).children[1]?.children[0]?.node, before.row)
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

test('a streaming paint detaches nothing, so the open thought keeps its place and its anchor', (t) => {
  const streaming = (thought: string, answer: string): TranscriptItem[] => [
    { id: 'm1', kind: 'user', text: 'hi', turnId: 't1' },
    { id: 'thinking-0', kind: 'thinking', text: thought, pending: true, turnId: 't1' },
    ...(answer === ''
      ? []
      : [{ id: 'draft', kind: 'assistant', text: answer, pending: true, turnId: 't1' } as TranscriptItem]),
  ]

  const view = mount(t)
  const open = new Map([['thinking-0', true]])
  view.render(transcript(streaming('先', '')), open, RUNNING_T1)
  const run = runOf(view)
  const line = run.children[0]!
  assert.deepEqual(line.classes, ['thinking', 'open', 'live'])

  const detached = {
    column: countDetaches(view.column().node),
    run: countDetaches(run.node),
    line: countDetaches(line.node),
  }

  // The thought streams on, and then the answer starts arriving under it.
  view.render(transcript(streaming('先看看', '')), open, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '')), open, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好')), open, RUNNING_T1)
  view.render(transcript(streaming('先看看这个文件', '好的，')), open, RUNNING_T1)

  assert.equal(detached.column(), 0, 'the column re-orders in place; the answer joins the end')
  assert.equal(detached.run(), 0, 'a refill of the run leaves the children it hands back where they are')
  assert.equal(detached.line(), 0, 'and the streaming thought never leaves its line')
  assert.equal(runOf(view).children[0]?.node, line.node, 'still the same line')
  assert.deepEqual(
    view.items().map((entry) => entry.classes[0]),
    ['item', 'run', 'item', 'waiting'],
    'the answer joined the column before the status line, outside the run',
  )
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
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), opened('edit-1'))

  const step = rowOf(view)
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  const head = step?.children[0]
  // `编辑 a.ts` and its counts on the right (§6.2): for this family they *are*
  // the result's note.
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '编辑 a.ts'], ['icon', ''], ['step-right', '+1 −1']],
  )
  assert.equal(head?.attributes.get('aria-label'), '编辑 a.ts · +1 −1 · 完成')
  assert.deepEqual(head?.children[2]?.children.map((part) => [part.className, part.text]), [['stat-add', '+1'], ['stat-del', '−1']])

  // The body is the file's full path over the same diff the permission dialog
  // paints — the result summary is not repeated over it.
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  assert.deepEqual(body?.children.map((child) => [child.className, child.className === 'diff' ? '' : child.text]), [['step-path', 'a.ts'], ['diff', '']])
  const diff = body?.children[1]
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
  view.render(transcript([editStep({ detail: EDIT_PATCH })]), new Map([['run:edit-1', true], ['edit-1', false]]))

  const step = rowOf(view)
  assert.equal(step?.children.length, 1, 'folded: the head and nothing else')
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-right')), true)
  assert.equal(step?.text.includes('one'), false, 'an `aria-live` region must not read the folded rows')
})

test('an edit record without a patch falls back to the plain body, without erroring', (t) => {
  const view = mount(t)
  view.render(transcript([editStep()]), opened('edit-1'))

  const step = rowOf(view)
  // No patch to count, so nothing on the right.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-right')), false)
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
    opened('bash-1'),
  )

  const body = rowOf(view)?.children[1]
  assert.equal(body?.children.some((child) => child.classes.includes('diff')), false)
  assert.equal(body?.children[0]?.className, 'step-terminal')
  assert.equal(body?.children[0]?.text, EDIT_PATCH)
})

test('skipped lines draw as dashed rules with the count, never as glyphs', (t) => {
  const view = mount(t)
  view.render(transcript([editStep({ detail: GAP_PATCH })]), opened('edit-1'))

  const diff = rowOf(view)?.children[1]?.children[1]
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
  description?: string
  command?: string
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
      ...(overrides.description === undefined ? {} : { description: overrides.description }),
      ...(overrides.command === undefined ? {} : { command: overrides.command }),
      durationMs: 3200,
    },
  }
}

test('a Bash step opens into a terminal block with its output ANSI-stripped', (t) => {
  const view = mount(t)
  view.render(transcript([bashStep()]), opened('bash-1'))

  const step = rowOf(view)
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
    opened('bash-1'),
  )

  const step = rowOf(view)
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
    opened('bash-1'),
  )

  const body = rowOf(view)?.children[1]
  assert.deepEqual(
    body?.children.map((child) => [child.className, child.text]),
    [['step-error', '命令失败（非零退出），无输出']],
  )
})

test('a described Bash step puts the full command in its own bubble above the output, with a copy button', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(t)
  const command = 'npm test \\\n  -- --grep "a long pattern"'
  view.render(
    transcript([bashStep({ description: 'Run the tests', command, failed: true, errorCode: 'command_failed' })]),
    opened('bash-1'),
  )

  const body = rowOf(view)?.children[1]
  assert.deepEqual(body?.children.map((child) => child.className), ['step-command', 'step-error', 'step-terminal'])
  const bubble = body!.children[0]!
  assert.equal(bubble.children[0]?.text, `$ ${command}`)
  assert.equal(body!.children[2]?.text, 'ok 42 passed\n3 failed')
  view.stub.click(bubble.children[1]!.node)
  assert.deepEqual(view.copied, [command])
  await Promise.resolve()
  t.mock.timers.tick(5000)
})

test('an undescribed Bash step names only its first word; the bubble holds the command, even while it runs', (t) => {
  const view = mount(t)
  view.render(transcript([bashStep({ command: 'npm test' })]), opened('bash-1'))
  const step = rowOf(view)
  assert.equal(step?.children[0]?.children[0]?.text, '运行 npm…')
  assert.deepEqual(step?.children[1]?.children.map((child) => child.className), ['step-command', 'step-terminal'])

  const running = bashStep({ command: 'npm test' })
  view.render(transcript([{ ...running, pending: true, tool: { ...running.tool!, content: undefined } }]), opened('bash-1'))
  assert.deepEqual(rowOf(view)?.children[1]?.children.map((child) => child.className), ['step-command'])
})

test('an edit step names the file and opens on its full path', (t) => {
  const view = mount(t)
  const detail = EDIT_PATCH.replaceAll('a/a.ts', 'a//repo/src/a.ts').replaceAll('b/a.ts', 'b//repo/src/a.ts')
  view.render(transcript([editStep({ detail })]), opened('edit-1'))
  const step = rowOf(view)
  assert.equal(step?.children[0]?.children[0]?.text, '编辑 a.ts')
  assert.equal(step?.children[1]?.children[0]?.text, '/repo/src/a.ts')
})

test('the terminal shows what the command printed, not the collapsed line’s extract', (t) => {
  const view = mount(t)
  // A backgrounded shell's `detail` is the one-line extract the collapsed row
  // reads; the full start message in `content` is the transcript the block owes
  // the reader — the task id is what they need to call BashOutput with.
  view.render(
    transcript([bashStep({ content: 'Task ID: bg-1\nPID: 123', detail: 'PID: 123' })]),
    opened('bash-1'),
  )

  const body = rowOf(view)?.children[1]
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
  view.render(transcript([searchStep()]), opened('search-1'))

  const step = rowOf(view)
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // `Grep "turnId" · 3 处 / 2 文件` (§6.2): the counts are the parsed list's
  // own, sitting where a suffix would — the same place the edit family puts
  // its `+12 −3`.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '搜索 pattern: "turnId"'], ['icon', ''], ['step-right', '3 处 / 2 文件']],
  )
  assert.equal(head?.attributes.get('aria-label'), '搜索 pattern: "turnId" · 3 处 / 2 文件 · 完成')

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
  view.render(transcript([searchStep()]), opened('search-1'))

  const groups = rowOf(view)?.children[1]?.children[0]?.children ?? []
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
  view.render(transcript([searchStep()]), opened('search-1'))

  const list = rowOf(view)?.children[1]?.children[0]
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
    opened('search-1'),
  )

  const step = rowOf(view)
  // `N 个文件`, not `N 处 / M 文件` — a Glob's file *is* its hit.
  assert.equal(
    step?.children[0]?.children.find((part) => part.classes.includes('step-right'))?.text,
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
    opened('search-1'),
  )

  const step = rowOf(view)
  assert.equal(step?.children[1]?.children.some((child) => child.classes.includes('step-search')), false)
  assert.deepEqual(
    step?.children[1]?.children.map((part) => [part.className, part.text]),
    [
      ['step-body-head', 'Found 3 matches across 2 files'],
      ['step-body-text', 'Error: Invalid regular expression pattern.'],
    ],
  )
  // And no counts were invented for a head that has no list behind it: nothing sits on the right edge.
  assert.equal(step?.children[0]?.children.some((part) => part.classes.includes('step-right')), false)
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
  view.render(transcript([readStep()]), opened('read-1'))

  const step = rowOf(view)
  // `读取 src/a.ts` and `2 行` (§6.2): the count is the block's own, so the head
  // and the body can never disagree about how long the file is.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '读取 src/a.ts'], ['icon', ''], ['step-right', '2 行']],
  )
  assert.equal(head?.attributes.get('aria-label'), '读取 src/a.ts · 2 行 · 完成')

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
  view.render(transcript([readStep({ content })]), opened('read-1'))

  const block = rowOf(view)?.children[1]?.children[0]
  assert.deepEqual(
    block?.children.map((row) => [row.children[0]?.text, row.children[1]?.text]),
    [['20', 'one'], ['21', 'two']],
  )
})

/** The Agent row: a standalone entry of its own, never a row of a run card. */
const agentRowOf = (rendered: Rendered): StubView => {
  const found = rendered.items().find((item) => item.classes.includes('agent-entry'))
  assert.ok(found, 'no Agent entry was painted')
  return found.children[0]!
}

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
  view.render(transcript([running]), new Map([['run:agent-1', true], ['agent-1', false]]))

  const step = agentRowOf(view)
  const head = step?.children[0]
  // A bordered capsule — diamond, name, chevron — with the count left to the live line.
  assert.equal(head?.className, 'step-head agent-chip')
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['icon', ''], ['step-label', '扫一遍 tools/'], ['icon', '']],
  )
  assert.equal(head?.attributes.get('aria-label'), '子代理 explore · 扫一遍 tools/ · 3 工具 · 执行中')
  const live = step?.children[1]
  assert.equal(live?.className, 'step-live')
  assert.deepEqual(live?.children.map((part) => part.text), ['↳', 'Read', 'src/a.ts'])
})

test('an Agent step is a link to the side panel, with the run in the head', (t) => {
  const view = mount(t)
  view.render(transcript([agentStep()]), opened('agent-1'))

  const step = agentRowOf(view)
  // The run's model and tool count are one unit on the right — and the result's
  // own `headerSuffix` carries that same model, so it is not drawn twice.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '已运行子代理 扫一遍 tools/ · opus']],
  )
  assert.equal(head?.className, 'step-head agent-ran')
  assert.deepEqual(
    head?.children[0]?.children.map((part) => [part.className, part.text]),
    [['agent-verb', '已运行子代理 '], ['', '扫一遍 tools/'], ['agent-model', ' · opus']],
  )
  assert.equal(head?.attributes.get('aria-label'), 'explore agent 扫一遍 tools/ · opus · 12 工具 · 完成')

  // Never a fold: the run lives in the side panel, even when the disclosure
  // says open, and a click asks for that panel instead of toggling.
  assert.equal(step?.children.some((child) => child.classes.includes('step-body')), false)
  view.stub.click(head!.node)
  assert.deepEqual(view.openedSubagents, ['agent-1'])
  assert.deepEqual(view.toggled, [])

  view.render(transcript([agentStep()]), new Map([['run:agent-1', true]]), undefined, 'agent-1')
  const selected = agentRowOf(view)
  assert.equal(selected?.classes.includes('selected'), true)
  assert.equal(selected?.children[0]?.attributes.get('aria-pressed'), 'true')
})

test('an Agent call splits the work around it and is counted in no run summary', (t) => {
  const view = mount(t)
  const read = (id: string): TranscriptItem => ({ id, kind: 'tool', text: id, toolName: 'Read', turnId: 't1', tool: { displayName: 'Read', useSummary: `${id}.ts` } })
  const other = { ...agentStep(), id: 'agent-2' }
  view.render(transcript([read('r1'), agentStep(), read('r2'), other, { ...agentStep(), id: 'agent-3' }]), NO_DISCLOSURE)
  assert.deepEqual(view.items().map((entry) => entry.classes.join(' ')), ['run', 'run agent-entry', 'run', 'run agent-entry', 'run agent-entry'])
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 1 个文件')
})

test('a failed Agent step keeps its plain row and says so in words', (t) => {
  const view = mount(t)
  const failed = { ...agentStep(), failed: true }
  view.render(transcript([failed]), opened('agent-1'))
  const head = agentRowOf(view).children[0]
  assert.equal(head?.className, 'step-head')
  assert.equal(head?.children[0]?.text.endsWith('失败'), true)
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
  view.render(transcript([webStep()]), opened('web-1'))

  const step = rowOf(view)
  // The web family has no counts of its own — the fetch's own note stays where
  // the fallback put it, above the body, and the right edge stays empty.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '抓取 example.com'], ['icon', '']],
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
    opened('web-1'),
  )
  const failedBody = rowOf(view)?.children[1]
  assert.equal(failedBody?.children.some((child) => child.classes.includes('step-web')), false)
  assert.deepEqual(
    failedBody?.children.map((part) => [part.className, part.text]),
    [['step-body-head', 'Fetched example.com (24.3KB)'], ['step-body-text', '# Title\n\nsome prose']],
  )

  // A Read that read nothing has no lines to number: no code block, and no
  // invented `0 行` — the count is the block's own, and there is no block.
  view.render(transcript([readStep({ content: '' })]), opened('read-1'))
  const emptyRead = rowOf(view)
  assert.equal(emptyRead?.children[0]?.children.some((part) => part.classes.includes('step-right')), false)
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
  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))?.children[0]
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

  const bubble = items()[0]?.children.find((child) => child.classes.includes('user-bubble'))?.children[0]
  assert.deepEqual(bubble?.nodes, ['mail me at foo@bar.com'])
})

test('dropped paths draw as tiles above the bubble, out of its text', (t) => {
  const { render, items } = mount(t)
  const block = '<attached-paths>\nfile: /a/tsconfig.base.json\nfolder: /a/pi-main\n</attached-paths>'
  render(transcript([
    { id: 'm1', kind: 'user', text: `看看\n\n${block}` },
    { id: 'm2', kind: 'user', text: block },
  ]))
  const [withText, pathsOnly] = items()
  const tiles = (item: StubView | undefined) =>
    item?.children.find((child) => child.classes.includes('user-paths'))?.children.map((tile) => tile.text)
  const bubble = (item: StubView | undefined) => item?.children.find((child) => child.classes.includes('user-bubble'))
  assert.deepEqual(tiles(withText), ['/a/tsconfig.base.jsonJSON', '/a/pi-main文件夹'])
  assert.equal(bubble(withText)?.children[0]?.text, '看看')
  assert.ok(tiles(pathsOnly))
  assert.equal(bubble(pathsOnly), undefined, 'no empty bubble under paths alone')
})

const TODO_STEP: TranscriptItem = {
  id: 'todo-1',
  kind: 'tool',
  text: 'TodoWrite 3/6',
  toolName: 'TodoWrite',
  turnId: 't1',
  tool: { displayName: 'TodoWrite', useSummary: '3/6', detail: '- [x] one' },
}

const CARD: TaskCard = {
  rows: [
    { id: '1', status: 'completed', label: 'Read the design' },
    { id: '2', status: 'in_progress', label: 'Wiring the card' },
    { id: '3', status: 'pending', label: 'Style it' },
  ],
  hiddenBefore: 0,
  openAfter: 0,
}

function cardOf(view: Rendered): StubView | undefined {
  return view.items().find((child) => child.classes.includes('task-card'))
}

/**
 * The `TodoWrite` row. It never opens — the checklist is drawn once, as the task
 * card — so it is a control that points at that card instead.
 */
test('a TodoWrite step is a bodyless button that points at the task card', (t) => {
  const view = mount(t)
  const state = transcript([TODO_STEP], { toolProgress: undefined })
  view.render(state, new Map([['run:todo-1', true]]))

  const step = rowOf(view)
  assert.deepEqual(step?.classes, ['step', 'task', 'done'])
  const head = step?.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  // No `aria-expanded`: nothing here opens, and a disclosure that never opens is
  // a lie to a screen reader.
  assert.equal(head?.attributes.get('aria-expanded'), undefined)
  // And no body, even though the result carried a `detail` the tool family would
  // have drawn.
  assert.equal(step?.children.length, 1)
  view.stub.click(head?.node)
  assert.deepEqual(view.toggled, [], 'the row folds nothing')

  view.render(state, new Map([['run:todo-1', true]]), { ...waiting(state, Date.now()), taskCard: CARD })
  assert.equal(cardOf(view)?.classes.includes('flash'), false)
  view.stub.click(rowOf(view)?.children[0]?.node)
  assert.equal(cardOf(view)?.classes.includes('flash'), true, 'the click pulses the card')
})

test('the task card sits above the status line, one row and mark per task', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now()), taskCard: CARD })

  const items = view.items()
  const card = cardOf(view)!
  assert.equal(items.at(-2)?.node, card.node)
  assert.ok(items.at(-1)?.classes.includes('waiting'))
  const list = card.children.find((child) => child.tagName === 'UL')!
  assert.deepEqual(list.children.map((row) => [row.tagName, row.classes.join(' '), row.text]), [
    ['LI', 'task-row completed', 'Read the design'],
    ['LI', 'task-row in_progress', 'Wiring the card'],
    ['LI', 'task-row pending', 'Style it'],
  ])
  assert.deepEqual(
    list.children.map((row) => row.children[0]?.attributes.get('aria-label')),
    ['已完成', '进行中', '未开始'],
    'each mark says its state in words',
  )

  // Kept across paints, so the entrance does not replay per token.
  const node = card.node
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now()), taskCard: { ...CARD } })
  assert.equal(cardOf(view)?.node, node)

  view.render(state, NO_DISCLOSURE, { isStreaming: false, startedAt: undefined, turnId: undefined })
  assert.equal(cardOf(view), undefined, 'no card between turns')
})

test('a windowed card summarises what it does not show', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now()), taskCard: { ...CARD, hiddenBefore: 4, openAfter: 2 } })
  const notes = cardOf(view)!.children.filter((child) => child.tagName === 'P').map((child) => child.text)
  assert.deepEqual(notes, ['更早的 4 项', '还有 2 项'])
})

test('while the turn waits on the user, the running row is drawn paused', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const marks = () => cardOf(view)!.children.find((child) => child.tagName === 'UL')!.children
    .map((row) => row.children[0]?.attributes.get('aria-label'))
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now()), taskCard: CARD, asking: '选哪个' })
  assert.deepEqual(marks(), ['已完成', '已搁置', '未开始'])
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now()), taskCard: CARD })
  assert.deepEqual(marks(), ['已完成', '进行中', '未开始'])
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

test('a message carries a meta row: 复制, its model, its time — and a draft carries none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
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
  // A successful copy turns the glyph into a tick for five seconds.
  await Promise.resolve()
  assert.equal((row.children[0]!.node as HTMLButtonElement).title, '已复制')
  t.mock.timers.tick(5000)
  assert.equal((row.children[0]!.node as HTMLButtonElement).title, '复制')

  // The user's bubble has a time and a copy button, and no model to name.
  render(transcript([{ id: 'u1', kind: 'user', text: 'go', createdAt: at }]))
  const userRow = meta(items()[0]!)
  assert.ok(userRow)
  // Outside the bubble, under it: the row is a sibling of the surface, not one
  // of the things inside it.
  assert.deepEqual(
    items()[0]!.children.map((child) => child.className),
    ['user-bubble clamped', 'item-meta'],
  )
  // At the bubble's right edge, the time first and the controls ending the row.
  assert.deepEqual(
    userRow.children.map((child) => [child.classes.join(' '), child.text]),
    [['item-time', '14:32'], ['item-copy', ''], ['item-rewind', '']],
  )
  stub.click(userRow.children[1]!.node)
  assert.deepEqual(copied, ['part done', 'go'])
  await Promise.resolve()
  t.mock.timers.tick(5000)
  // 回退 addresses the checkpoint by the user record's id.
  stub.click(userRow.children[2]!.node)
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

// --- the live status -----------------------------------------------------------

/** What the pane hands the view about the turn in flight. */
function waiting(state: TranscriptState, startedAt: number | undefined, outputTokens?: number): WaitingInput {
  return { isStreaming: true, startedAt, turnId: state.turnId, ...(outputTokens === undefined ? {} : { outputTokens }) }
}

/** The status line's words and counter, as the reader sees them. */
function statusText(row: StubView): { label: string; meta: string[] } {
  const part = (name: string): StubView => row.children.find((child) => child.classes.includes(name))!
  return { label: part('line-text').text, meta: part('line-meta').children.map((child) => child.text) }
}

test('before the first step the status is a line of its own, at the tail', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: '改一下侧栏' }])

  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 5000, 1_234))

  const row = items()[items().length - 1]!
  assert.deepEqual(row.classes, ['waiting'], 'the line is the last thing in the column')
  assert.deepEqual(
    row.children.map((child) => child.classes.join(' ')),
    ['line-mark', 'line-meta line-elapsed', 'line-text'],
    'mark, counter, words — and the clock is painted on the first frame',
  )
  assert.deepEqual(statusText(row), { label: '处理中', meta: ['5s', '·', '1.2k tokens', '·'] })
  // `.transcript` is `aria-live="polite"`: the words may be announced, the
  // counter must not be (it changes ten times a second), and neither is the mark.
  assert.equal(row.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[1]!.attributes.get('aria-hidden'), 'true')
  assert.equal(row.children[2]!.attributes.get('aria-hidden'), undefined)
})

test('the counter is empty on a short wait, and tokens come only beside the seconds', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 500, 90))
  assert.deepEqual(statusText(items().at(-1)!).meta, [])
  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 3_000))
  assert.deepEqual(statusText(items().at(-1)!).meta, ['3s', '·'], 'no tokens reported yet')
})

test('the status line stays last while a run works, and its pieces survive the step settling', (t) => {
  const view = mount(t)
  const startedAt = Date.now() - 6_000
  const paint = (items: TranscriptItem[]): void => view.render(
    transcript(items, { turnId: 't1' }), NO_DISCLOSURE, waiting(transcript(items, { turnId: 't1' }), startedAt))

  paint(turnItems({ pending: true }))
  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run', 'waiting'])
  const row = view.items().at(-1)!
  assert.equal(statusText(row).label, '读取 a.ts')
  const pieces = row.children

  // The tool settles and the turn keeps running: the words fall back to
  // 「正在思考」 once the gate lets them, while the mark and counter stay mounted.
  paint(turnItems())
  const still = view.items().at(-1)!
  assert.equal(still.node, row.node)
  for (const index of [0, 1, 2]) assert.equal(still.children[index]!.node, pieces[index]!.node)
  assert.equal(statusText(still).label, '读取 a.ts', 'a new label waits out its delay')

  // Only the end of the turn takes the line away, and the run is its summary.
  view.render(transcript(turnItems(), { turnId: undefined }), NO_DISCLOSURE, {
    isStreaming: false,
    startedAt: undefined,
    turnId: undefined,
  })
  assert.equal(view.items().some((item) => item.classes.includes('waiting')), false)
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 1 个文件')
})

test('a draft arriving does not take the status line away: it reads 正在输出, still last', (t) => {
  const view = mount(t)
  const items = [...turnItems(), { id: 'a1', kind: 'assistant', text: '看完了。', turnId: 't1', pending: true } as TranscriptItem]
  const state = transcript(items, { turnId: 't1' })
  view.render(state, NO_DISCLOSURE, waiting(state, Date.now() - 3_000))
  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run', 'item', 'waiting'])
  assert.equal(statusText(view.items().at(-1)!).label, '正在输出')
})

test('M18 keeps the mark and clock mounted across tool handoffs and unchanged paints', (t) => {
  const view = mount(t)
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 6000 }
  const starts = trackAnimationStarts(view.column, '.line-mark', view.stub.observeMotion)
  t.after(starts.dispose)
  let pieces: readonly StubView[] | undefined
  for (const toolName of ['Read', undefined, undefined, 'Grep', undefined, 'Edit']) {
    const item: TranscriptItem = { id: 'tool', kind: 'tool', turnId: 't1', text: '',
      toolName: toolName ?? 'Read', pending: toolName !== undefined,
      tool: { displayName: toolName ?? 'Read', useSummary: 'a.ts' } }
    view.render(transcript([item]), NO_DISCLOSURE, activity)
    const row = view.items().at(-1)!
    assert.deepEqual(row.classes, ['waiting'])
    pieces ??= row.children
    for (const index of [0, 1, 2]) assert.equal(row.children[index]!.node, pieces[index]!.node)
    assert.deepEqual(statusText(row).meta.slice(0, 2), ['6s', '·'])
  }
  assert.equal(starts.starts, 0, 'label updates never detach or restart the mark')
})

test('one working mark lives on the status line, and ends with the turn', (t) => {
  const view = mount(t)
  const markIn = (carrier: StubView | undefined) => carrier?.children.find((child) => child.classes.includes('line-mark'))?.children[0]
  const marks = (): number => {
    const count = (node: StubView): number => (node.classes.includes('mark') ? 1 : 0) + node.children.reduce((n, child) => n + count(child), 0)
    return view.items().reduce((n, item) => n + count(item), 0)
  }
  const user: TranscriptItem = { id: 'u1', kind: 'user', text: 'go', turnId: 't1' }
  const tool: TranscriptItem = { id: 'call', kind: 'tool', text: '', toolName: 'Read', turnId: 't1', pending: true,
    tool: { displayName: 'Read', useSummary: 'a.ts' } }

  view.render(transcript([user]), NO_DISCLOSURE, RUNNING_T1)
  const mark = markIn(view.items().at(-1))
  assert.ok(mark && mark.classes.includes('mark'), 'the status line carries it')
  assert.equal(mark.attributes.get('aria-hidden'), 'true')

  view.render(transcript([user, tool]), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(marks(), 1, 'the run head carries none')
  assert.equal(markIn(view.items().at(-1))?.node, mark.node)

  // A draft arriving leaves the line in place, with the same mark.
  const draft: TranscriptItem = { id: '__draft__', kind: 'assistant', text: '好', pending: true }
  view.render(transcript([user, { ...tool, pending: undefined }, draft]), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(marks(), 1)
  assert.equal(markIn(view.items().at(-1))?.node, mark.node)

  view.render(transcript([user, { ...tool, pending: undefined }]), NO_DISCLOSURE, { isStreaming: false, turnId: undefined, startedAt: undefined })
  assert.equal(marks(), 0, 'an idle session shows none')
})

test('the status line keeps its node while it waits, and the answer starting does not remove it', (t) => {
  const { render, items } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const startedAt = Date.now() - 1000

  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  const first = items()[items().length - 1]!.node
  render(state, NO_DISCLOSURE, waiting(state, startedAt))
  assert.equal(items()[items().length - 1]!.node, first, 'a repaint must not rebuild the line under the reader')

  const arriving = transcript([
    { id: 'u1', kind: 'user', text: 'go' },
    { id: '__draft__', kind: 'assistant', text: '好', pending: true },
  ])
  render(arriving, NO_DISCLOSURE, waiting(arriving, startedAt))
  assert.equal(items().at(-1)!.node, first, 'the same line, now saying it is writing')
})

test('the status clock ticks by itself, and stopClock stops it', async (t) => {
  const { render, items, stopClock } = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }])
  const elapsed = (): string => statusText(items().at(-1)!).meta.join('')

  // Started just under the two-second threshold: the counter is empty on the
  // first paint and fills itself as the clock crosses it — the string moves
  // without a paint, which is the whole reason the view owns a timer.
  render(state, NO_DISCLOSURE, waiting(state, Date.now() - 1_900))
  assert.equal(elapsed(), '', 'a short wait is not worth a number')
  await new Promise((resolve) => setTimeout(resolve, 260))
  const ticked = elapsed()
  assert.notEqual(ticked, '', 'past two seconds the counter appears on its own')

  stopClock()
  await new Promise((resolve) => setTimeout(resolve, 260))
  assert.equal(elapsed(), ticked, 'a stopped clock keeps its last value')
})

test('the status words change only after the gate lets them, on the clock', async (t) => {
  const { render, items } = mount(t)
  const user: TranscriptItem = { id: 'u1', kind: 'user', text: 'go', turnId: 't1' }
  const tool: TranscriptItem = { id: 'call', kind: 'tool', text: '', toolName: 'Read', turnId: 't1', pending: true,
    tool: { displayName: 'Read', useSummary: 'a.ts' } }
  const startedAt = Date.now() - 1_000
  const paint = (list: TranscriptItem[]): void => {
    const state = transcript(list, { turnId: 't1' })
    render(state, NO_DISCLOSURE, waiting(state, startedAt))
  }
  paint([user])
  assert.equal(statusText(items().at(-1)!).label, '处理中')
  paint([user, tool])
  assert.equal(statusText(items().at(-1)!).label, '处理中', 'a new label is held back at first')
  await new Promise((resolve) => setTimeout(resolve, 800))
  assert.equal(statusText(items().at(-1)!).label, '读取 a.ts', 'and lands on the clock, with no further paint')
})

test('a kept thought row reports the disclosure it is showing, both ways', (t) => {
  // The regression the kept head introduced: its click closure is built once, so
  // it reads a mutable ref — and a ref whose key no `node()` claims is pruned and
  // rebuilt every paint, which left the head reporting 「folded」 forever and a row
  // that opened but would not close.
  const view = mount(t)
  const disclosure = new Map<string, boolean>()
  const items: TranscriptItem[] = [{ id: 'th1', kind: 'thinking', text: '先看看这个文件。', turnId: 't1', pending: true }]
  const paint = (): void => view.render(transcript(items), disclosure, RUNNING_T1)
  const head = (): StubView => {
    const found = runOf(view).children[0]?.children[0]
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
    if (node.classes.includes('run-line')) return { top: 200 + shift - view.container.scrollTop, bottom: 220 + shift - view.container.scrollTop }
    return undefined
  })
  const items: TranscriptItem[] = [{ id: 's', kind: 'thinking', text: 'body', turnId: 't1' }]
  view.render(transcript(items), new Map([['s', true]]))
  const head = runOf(view).children[0]!.children[0]!.node
  view.stub.click(head)
  view.render(transcript(items), new Map([['s', false]]))
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
    constructor(run: (entries: unknown[]) => void) { resizes.push(() => run([])) }
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
  // Not a user message: its bubble would add the clamp observer's own target.
  const state = transcript([{ id: 'a', kind: 'notice', text: 'hello' }])
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
  // The scroller's observer and the user-bubble clamp's.
  assert.equal(disconnected, 3)
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
    onToggle: () => {}, onOpenPlan: () => {}, onOpenSubagent: () => {}, onOpenPath: () => {},
    onViewImage: () => {}, imageThumbUrl: () => undefined, onCopy: async () => true,
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

test('a failed turn draws a card: reason, target, hint, the provider\'s words, and the two actions', (t) => {
  const retried: string[] = []
  let providerSettings = 0
  const stub = installDomStub()
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const real = createTranscriptView(container, host, {
    onToggle: () => {}, onOpenPlan: () => {}, onOpenSubagent: () => {}, onOpenPath: () => {},
    onViewImage: () => {}, imageThumbUrl: () => undefined, onCopy: async () => true,
    onOpenProviderSettings: () => { providerSettings += 1 },
    onRetryTurn: (id) => retried.push(id),
  })
  t.after(() => {
    real.dispose()
    stub.uninstall()
  })
  const failure = (retryable: boolean): TranscriptItem => ({
    id: 'f1', kind: 'turn-failure', text: '连不上服务商',
    failure: {
      id: 'f1', kind: 'network', reason: '连不上服务商', hint: '检查网络。', target: '模型 m · 服务商 h/v1',
      detail: 'Connection error.', userMessageId: 'u1', retryable,
    },
  })
  const find = (cls: string): StubView[] => (function walk(n: StubView): StubView[] {
    return [...(n.classes.includes(cls) ? [n] : []), ...n.children.flatMap(walk)]
  })(stub.inspect(container))

  real.render({ ...createTranscriptState(), items: [failure(true)] }, NO_DISCLOSURE)
  assert.deepEqual(
    ['failure-reason', 'failure-target', 'failure-hint', 'failure-detail'].map((cls) => find(cls)[0]?.text),
    ['连不上服务商', '模型 m · 服务商 h/v1', '检查网络。', 'Connection error.'],
  )
  const actions = find('failure-action')
  assert.deepEqual(actions.map((action) => action.text), ['打开服务商设置', '重试'])
  stub.dispatch(actions[0]!.node, 'click', {})
  stub.dispatch(actions[1]!.node, 'click', {})
  assert.equal(providerSettings, 1)
  assert.deepEqual(retried, ['f1'])

  // Once something has been sent since, the card keeps its words and loses 重试.
  real.render({ ...createTranscriptState(), items: [failure(false)] }, NO_DISCLOSURE)
  assert.deepEqual(find('failure-action').map((action) => action.text), ['打开服务商设置'])
})

test('receipts: a question card lists asks and answers, a plan card opens the plan', (t) => {
  const view = mount(t)
  const ask: TranscriptItem = {
    id: 'q1', kind: 'tool', text: '', toolName: 'AskUserQuestion', turnId: 't1',
    tool: { displayName: 'Ask', useSummary: '', questions: ['用哪个库？', '要测试吗？'], answers: { '用哪个库？': 'dayjs' } },
  }
  const plan: TranscriptItem = {
    id: 'p1', kind: 'tool', text: '', toolName: 'ExitPlanMode', turnId: 't1',
    tool: { displayName: 'Plan', useSummary: '', plan: { decision: 'approve_auto_keep', planContent: '# 计划' } },
  }
  view.render(transcript([ask, plan]))
  const cards = view.items().filter((node) => node.classes.includes('receipt'))
  assert.equal(cards.length, 2)
  const [question, planCard] = cards as [StubView, StubView]
  assert.deepEqual(question.children.map((row) => row.children.map((cell) => cell.text)), [
    ['用哪个库？', 'dayjs'],
    ['要测试吗？', '未回答'],
  ])
  assert.equal(planCard.text, '已接受计划 · 自动执行')
  view.stub.click(planCard.children[0]?.node)
  assert.deepEqual(view.openedPlans, ['# 计划'])
})

const factsOf = (node: StubView): string[] =>
  (node.children.find((child) => child.classes.includes('item-meta')) ?? node).children
    .filter((child) => child.classes.includes('item-fact')).map((child) => child.text)

test('the turn footer rides on the answer: 复制 · 刚刚 · 用时 · tokens, with the absolute time as title', (t) => {
  const { render, items } = mount(t)
  const at = new Date(Date.now() - 5_000).toISOString()
  const turn: TranscriptItem[] = [
    { id: 'u', kind: 'user', text: 'go', turnId: 't1' },
    { id: 'a', kind: 'assistant', text: 'done', turnId: 't1', createdAt: at },
    { id: 'd', kind: 'duration', text: '已处理 24m 0s', durationMs: 1_440_000, turnId: 't1' },
  ]
  render(transcript(turn), NO_DISCLOSURE, { ...IDLE_ACTIVITY, outputTokens: 3200 })
  assert.deepEqual(items().map((item) => item.classes[1]), ['user', 'assistant'])
  const row = items()[1]!.children.find((child) => child.classes.includes('item-meta'))!
  assert.deepEqual(row.children.map((child) => child.text), ['', '刚刚', '用时 24m 0s', '3.2k tokens'])
  assert.match(row.children[1]!.attributes.get('title') ?? '', /^\d{4}-\d\d-\d\d \d\d:\d\d$/)

  // No count for a replayed turn, and none while another turn streams.
  render(transcript(turn), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.deepEqual(factsOf(items()[1]!), ['用时 24m 0s'])
  render(transcript(turn), NO_DISCLOSURE, { ...IDLE_ACTIVITY, isStreaming: true, turnId: 't2', startedAt: Date.now(), outputTokens: 90 })
  assert.deepEqual(factsOf(items()[1]!), ['用时 24m 0s'])
})

test('prose between tool calls carries no meta row; only the settled turn\'s answer does', (t) => {
  const { render, items } = mount(t)
  const at = new Date(Date.now() - 5_000).toISOString()
  const meta = (item: StubView): boolean => item.children.some((child) => child.classes.includes('item-meta'))
  const running: TranscriptItem[] = [
    { id: 'u', kind: 'user', text: 'go', turnId: 't1' },
    { id: 'a1', kind: 'assistant', text: 'looking first', model: 'm', turnId: 't1', createdAt: at },
    { id: 'b', kind: 'tool', text: 'ls', toolName: 'Bash', turnId: 't1', createdAt: at },
  ]
  render(transcript(running, { turnId: 't1' }), NO_DISCLOSURE, { isStreaming: true, startedAt: Date.now(), turnId: 't1' })
  assert.equal(meta(items()[1]!), false)

  render(transcript([
    ...running,
    { id: 'a2', kind: 'assistant', text: 'done', model: 'm', turnId: 't1', createdAt: at },
    { id: 'd', kind: 'duration', text: '已处理 5s', durationMs: 5000, turnId: 't1' },
  ]), NO_DISCLOSURE, IDLE_ACTIVITY)
  const assistants = items().filter((item) => item.classes.includes('assistant'))
  assert.deepEqual(assistants.map(meta), [false, true])
})

test('a turn with no answer hangs its footer under its last entry; side views draw none', (t) => {
  const { render, items } = mount(t)
  const turn: TranscriptItem[] = [
    { id: 'u', kind: 'user', text: 'go', turnId: 't1' },
    { id: 'e', kind: 'error', text: 'boom', failed: true, turnId: 't1' },
    { id: 'd', kind: 'duration', text: '已处理 3s', durationMs: 3000, turnId: 't1' },
  ]
  render(transcript(turn), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.deepEqual(items().map((item) => item.classes.join(' ')), ['item user', 'item error failed', 'item-meta turn-foot'])
  assert.deepEqual(factsOf(items()[2]!), ['用时 3s'])

  // The subagent panel and the thread detail render without an activity.
  render(transcript(turn))
  assert.deepEqual(items().map((item) => item.classes.join(' ')), ['item user', 'item error failed'])
})

test('the background-task button ends the status line and opens the task list', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }], { turnId: 't1' })
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now() - 5000), backgroundTasks: 2 })

  const row = view.items().at(-1)!
  assert.deepEqual(row.children.map((child) => child.classes.join(' ')), ['line-mark', 'line-meta line-elapsed', 'line-text', 'line-tasks'])
  const tasks = row.children[3]!
  assert.equal(tasks.text, '2 个后台任务')
  assert.equal(tasks.attributes.get('aria-label'), '2 个后台任务，查看')
  view.stub.click(tasks.node)
  assert.equal(view.backgroundOpens(), 1)

  // A new count refills the button in place; the mark and counter stay mounted.
  const pieces = row.children
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now() - 5000), backgroundTasks: 3 })
  const again = view.items().at(-1)!
  assert.equal(again.children[3]!.text, '3 个后台任务')
  assert.equal(again.children[3]!.node, tasks.node)
  for (const index of [0, 1, 2]) assert.equal(again.children[index]!.node, pieces[index]!.node)

  // None left: the button goes, the rest of the line stays.
  view.render(state, NO_DISCLOSURE, waiting(state, Date.now() - 5000))
  assert.equal(view.items().at(-1)!.children.length, 3)
})

test('with tasks still running, an idle session keeps the button alone as its status line', (t) => {
  const view = mount(t)
  const state = transcript(turnItems(), { turnId: undefined })
  const idle = { isStreaming: false, startedAt: undefined, turnId: undefined }
  view.render(state, NO_DISCLOSURE, { ...idle, backgroundTasks: 1 })

  const row = view.items().at(-1)!
  assert.deepEqual(row.classes, ['waiting', 'idle'])
  assert.deepEqual(row.children.map((child) => [child.classes.join(' '), child.text]), [['line-tasks', '1 个后台任务']])
  view.stub.click(row.children[0]!.node)
  assert.equal(view.backgroundOpens(), 1)

  view.render(state, NO_DISCLOSURE, idle)
  assert.equal(view.items().some((item) => item.classes.includes('waiting')), false)
})

test('a turn starting over an idle task button swaps it for the full status line', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }], { turnId: undefined })
  view.render(state, NO_DISCLOSURE, { isStreaming: false, startedAt: undefined, turnId: undefined, backgroundTasks: 1 })
  const running = transcript([{ id: 'u1', kind: 'user', text: 'go' }], { turnId: 't1' })
  view.render(running, NO_DISCLOSURE, { ...waiting(running, Date.now() - 3000), backgroundTasks: 1 })
  assert.deepEqual(view.items().at(-1)!.children.map((child) => child.classes[0]), ['line-mark', 'line-meta', 'line-text', 'line-tasks'])
})
