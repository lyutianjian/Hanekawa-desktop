import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

import { installDomStub, type DomStub, type StubView } from './helpers/domStub.js'
import { trackAnimationStarts, trackIdentity } from './helpers/motion.js'
import { createTranscriptView } from '../src/desktop/renderer/dom/transcriptView.js'
import { createTextSwap, createWidthTween, TEXT_SWAP_MS, TEXT_SWAP_EASING } from '../src/desktop/renderer/dom/textSwap.js'
import { createNumberTween, NUMBER_TWEEN_MS } from '../src/desktop/renderer/dom/numberTween.js'
import { icon } from '../src/desktop/renderer/dom/icons.js'
import { NO_DISCLOSURE } from '../src/desktop/renderer/model/thinking.js'
import type { DisclosureState } from '../src/desktop/renderer/model/thinking.js'
import type { TranscriptItem, TranscriptState } from '../src/desktop/renderer/model/transcript.js'
import { applySessionEvent, createTranscriptState, presentationTranscript } from '../src/desktop/renderer/model/transcript.js'
import type { SessionEvent } from '../src/runtime/sessionController.js'
import type { ImageAttachmentRef } from '../src/media/types.js'
import { ANCHOR_REST_PX } from '../src/desktop/renderer/model/transcriptAnchor.js'
import type { WaitingInput } from '../src/desktop/renderer/model/waiting.js'
import type { TaskCard } from '../src/desktop/renderer/model/tasks.js'
import type { WireCommandInfo } from '../src/runtime/protocol/wire.js'
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
  const first = { ...tool, id: 'first', pending: false }
  const open = new Map([['run:first', true]])
  view.render(transcript([first, tool]), open, activity)
  const run = runOf(view).node
  const head = runOf(view).children[0]!.node
  const card = runOf(view).children[1]!.node
  view.render(transcript([first, { ...tool, pending: undefined }]), open, activity)
  view.render(transcript([first, { ...tool, pending: undefined }, { ...tool, id: 'b' }]), open, activity)
  assert.equal(runOf(view).node, run)
  assert.equal(runOf(view).children[0]!.node, head)
  assert.equal(runOf(view).children[1]!.node, card, 'the card is not rebuilt under a growing run')
  // The reader's fold outranks the next step arriving.
  view.render(transcript([first, tool, { ...tool, id: 'b' }]), new Map([['run:first', false]]), activity)
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
  assert.deepEqual(view.toggled.at(-1), ['th', false], 'reset restores the new default, not the previous disclosure ref')
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
  apply({ type: 'stream', event: { type: 'thinking_delta', thinking: 'Reasoning. More.' } })
  const head = trackIdentity(view.column, '.run-line').sample()
  const body = trackIdentity(view.column, '.line-text').sample()
  assert.ok(head)
  assert.ok(body)
  const text = 'Stable paragraph.\n\n~~~ts\nconst value = 1\n~~~\n\n$E=mc^2$\n\nMore.'
  apply({ type: 'stream', event: { type: 'text_delta', text } })
  const owner = trackIdentity(view.column, '.assistant').sample()
  const children = [...(owner as HTMLElement).childNodes]
  view.stub.focus(head)
  apply({ type: 'record', record: { type: 'message', id: 'a1', role: 'assistant', content: text,
    thinkingBlocks: [{ type: 'thinking', thinking: 'Reasoning. More.' }], turnId: 't1', createdAt } })
  assert.equal(trackIdentity(view.column, '.run-line').sample(), head)
  assert.equal(trackIdentity(view.column, '.line-text').sample(), body)
  assert.equal(view.stub.activeElement(), head)
  assert.equal(trackIdentity(view.column, '.assistant').sample(), owner)
  apply({ type: 'record', record: { type: 'tool_use', id: 'tool1', tool: 'Read', input: { filePath: 'a.ts' }, turnId: 't1', createdAt, riskLevel: 'safe' } })
  assert.equal(trackIdentity(view.column, '.assistant').sample(), owner, 'the prose keeps its carrier when a tool follows it')
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

test('a thought opens to a body under its line, and focus stays on the line', (t) => {
  // The whole text is a sibling of the toggle, not the toggle's own text: prose
  // inside a <button> could not be selected, showed its markdown raw, and was
  // the button's accessible name in full.
  const view = mount(t)
  const item: TranscriptItem = { id: 'a', kind: 'thinking', text: '首句。\n\n**后文**。', turnId: 't1' }
  const paint = (open: boolean) => view.render(transcript([item]), new Map([['a', open]]))
  paint(false)
  const head = runOf(view).children[0]!.children[0]!.node as HTMLElement
  view.stub.focus(head)
  paint(true)
  const line = runOf(view).children[0]!
  assert.equal(line.children.length, 2, 'the line, then the body')
  assert.equal(line.children[0]!.node, head, 'the line is kept, not rebuilt')
  assert.equal(line.children[0]!.children[0]!.text, '首句。', 'the line keeps its first sentence')
  const body = line.children[1]!
  assert.deepEqual(body.classes, ['thinking-body', 'md', 'presence', 'presence-none', 'presence-entering'])
  assert.notEqual(body.tagName, 'BUTTON')
  assert.doesNotMatch(body.text, /首句/, 'the body continues after the line, not repeating it')
  assert.ok(body.children.some((child) => child.children.some((part) => part.tagName === 'STRONG')), 'markdown, not raw text')
  assert.equal(view.stub.activeElement(), head)
  paint(false)
  assert.equal((body.node as HTMLElement).getAttribute('inert'), '')
  assert.equal((body.node as HTMLElement).classList.contains('presence-closing'), true)
  assert.equal(view.stub.activeElement(), head)
  paint(true)
  assert.equal(runOf(view).children[0]!.children[1]!.node, body.node, 'reversing keeps the same body')
  assert.equal((body.node as HTMLElement).classList.contains('presence-entering'), true)
  paint(false)
  view.stub.dispatch(body.node, 'transitionend', { propertyName: 'height' })
  assert.equal(runOf(view).children[0]!.children.length, 1, 'after the exit: the body is absent, not hidden')
  paint(false)
  assert.equal(runOf(view).children[0]!.children.length, 1, 'an unchanged fold cannot remount the exiting body')
  assert.equal(view.stub.activeElement(), head)
})

test('an open live thought follows new text after scrolling to its bottom and pauses when reading back', (t) => {
  const view = mount(t)
  let text = `首句。${'思考内容。\n'.repeat(30)}`
  const opened = new Map([['s', true]])
  const paint = (pending = true): void => {
    view.render(transcript([{ id: 's', kind: 'thinking', text, turnId: 't1', pending }]), opened, RUNNING_T1)
  }
  paint()
  const body = runOf(view).children[0]!.children[1]!.node as HTMLElement
  view.stub.dispatch(body, 'transitionend', { propertyName: 'height' })
  view.stub.setMetrics(body, { clientHeight: 320 })
  // Model layout growth during the paint, after the old bottom was measured.
  Object.defineProperty(body, 'scrollHeight', { get: () => body.textContent!.length * 10 })
  assert.equal(body.scrollTop, 0, 'opening starts at the beginning')
  text += '新增内容。'
  paint()
  assert.equal(body.scrollTop, 0, 'reading the beginning does not jump to the end')

  for (let index = 0; index < 2; index += 1) {
    view.stub.setMetrics(body, { scrollTop: body.scrollHeight - body.clientHeight })
    view.stub.dispatch(body, 'scroll')
    text += '继续思考。'
    paint()
    assert.equal(body.scrollTop, body.scrollHeight, 'each update follows the new bottom')
  }

  view.stub.setMetrics(body, { scrollTop: body.scrollHeight - body.clientHeight - 4 })
  view.stub.dispatch(body, 'scroll')
  const readingTop = body.scrollTop
  text += '更多内容。'
  paint()
  assert.equal(body.scrollTop, readingTop, 'even a small upward scroll pauses following')

  view.stub.setMetrics(body, { scrollTop: body.scrollHeight - body.clientHeight })
  view.stub.dispatch(body, 'scroll')
  text += '**结束思考**。'
  paint(false)
  assert.equal(body.scrollTop, body.scrollHeight, 'returning to the bottom resumes follow through sealing')
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
  assert.equal(later!.classes.includes('open'), false, 'a new thought stays folded without changing the earlier answer')
  const folded = new Map([['a', false]])
  view.render(transcript([{ ...first, text: 'first. more' }, { ...first, id: 'b', text: 'next' }]), folded, RUNNING_T1)
  assert.equal(view.items()[0]!.children[0]!.classes.includes('open'), false, 'deltas do not reopen a manual fold')
  view.render(transcript([{ ...first, pending: false, durationMs: 5_000 }, { ...first, id: 'b', pending: false }]), folded)
  assert.equal(view.items()[0]!.children[0]!.children[0]!.attributes.get('aria-label'), 'first', 'sealing and completion keep the first sentence and the fold')
})

test('a live thought keeps its first sentence and plain remaining text until sealing, reusing the head and body', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 's', kind: 'thinking', text: '第一行。\n\n**第二行**。', turnId: 't1', pending: true }
  view.render(transcript([item]), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 7_000 })
  const line = runOf(view).children[0]!
  assert.deepEqual(line.classes, ['thinking', 'live'])
  const head = line.children[0]!
  assert.deepEqual(head.classes, ['run-line', 'activity-line'])
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  assert.equal(line.children.length, 1, 'the body stays folded')
  assert.equal(statusText(runOf(view)).label, '第一行。')
  view.stub.click(head.node)
  assert.deepEqual(view.toggled, [['s', false]])

  const opened = new Map([['s', true]])
  view.render(transcript([item]), opened, RUNNING_T1)
  const open = runOf(view).children[0]!
  assert.equal(open.classes.includes('open'), true)
  assert.equal(open.children.length, 2)
  const body = open.children[1]!.node as HTMLElement
  assert.deepEqual(open.children[1]!.classes, ['thinking-body', 'live', 'presence', 'presence-none', 'presence-entering'])
  assert.equal(body.textContent, '**第二行**。', 'the body continues after the first sentence without repeating it')
  assert.equal(body.childNodes.length, 1, 'only a text node, no parsed blocks')
  assert.equal((body.firstChild as Text).data, '**第二行**。')
  const textNode = body.firstChild
  view.stub.dispatch(body, 'transitionend', { propertyName: 'height' })
  view.render(transcript([item]), opened, RUNNING_T1)
  assert.equal(body.firstChild, textNode, 'an unchanged snapshot does not rewrite textContent')

  const grown = { ...item, text: `${item.text}\n\n第三行。` }
  view.render(transcript([grown]), opened, RUNNING_T1)
  assert.equal(runOf(view).children[0]!.children[0]!.node, head.node)
  assert.equal(statusText(runOf(view)).label, '第一行。', 'later sentences never become the status label')
  assert.equal(runOf(view).children[0]!.children[1]!.node, body)
  assert.equal(body.textContent, '**第二行**。\n\n第三行。')
  assert.equal(body.childNodes.length, 1)
  assert.equal((body.firstChild as Text).data, '**第二行**。\n\n第三行。')

  const { pending: _pending, ...sealed } = grown
  view.render(transcript([sealed]), opened)
  const done = runOf(view).children[0]!
  assert.equal(done.classes.includes('live'), false)
  assert.equal(done.children[0]!.node, head.node)
  assert.equal(done.children[0]!.attributes.get('aria-label'), '第一行。')
  assert.equal(done.children[0]!.children[0]!.text, '第一行。')
  assert.equal(done.children[1]!.node, body, 'sealing changes contents, not the carrier')
  assert.deepEqual(done.children[1]!.classes, ['thinking-body', 'presence', 'presence-none', 'presence-open', 'md'])
  assert.doesNotMatch(body.textContent!, /第一行|\*\*/)
  assert.ok(done.children[1]!.children.some((child) => child.children.some((part) => part.tagName === 'STRONG')))
  assert.match(body.textContent!, /第三行/)
  const blocks = [...body.childNodes]
  view.render(transcript([sealed]), opened)
  assert.deepEqual([...body.childNodes], blocks, 'unchanged sealed text keeps the rendered markdown blocks')
  view.render(transcript([sealed]), NO_DISCLOSURE)
  assert.equal(runOf(view).children[0]!.children[0]!.children[0]!.text, '第一行。')
})

test('a folded thought keeps its first sentence when duration arrives', (t) => {
  const view = mount(t)
  const head = (): StubView => runOf(view).children[0]!.children[0]!
  const item: TranscriptItem = { id: 's', kind: 'thinking', text: 'why', turnId: 't1' }
  view.render(transcript([{ ...item, durationMs: 12_000 }]))
  assert.deepEqual(head().children.map((child) => child.classes.join(' ')), ['line-text text-swap'])
  assert.equal(head().attributes.get('aria-label'), 'why')
  const folded = new Map([['s', false]])
  view.render(transcript([item]), folded)
  const node = head().node
  assert.equal(head().attributes.get('aria-label'), 'why')
  view.render(transcript([{ ...item, durationMs: 12_000 }]), folded)
  assert.equal(head().node, node)
  assert.equal(head().attributes.get('aria-label'), 'why')
  view.render(transcript([{ ...item, text: '', durationMs: 12_000 }]), folded)
  assert.equal(head().attributes.get('aria-label'), '思考过程')
})

test('an earlier pending thought also keeps its first sentence and remaining body', (t) => {
  const view = mount(t)
  const item: TranscriptItem = { id: 's', kind: 'thinking', text: '先读目录。再读文件。', pending: true }
  view.render(transcript([item]), new Map([['s', true]]))
  const line = runOf(view).children[0]!
  assert.equal(line.children[0]!.attributes.get('aria-label'), '先读目录。')
  assert.equal(line.children[1]!.text, '再读文件。')
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
  readonly focusedRequests: readonly string[]
  /** `[path, line]` per clicked search row, the `open-in-editor` payload. */
  readonly opened: ReadonlyArray<readonly [string, number | undefined]>
  /** `[imageId, name]` per clicked image line under a user bubble (S12). */
  readonly viewedImages: ReadonlyArray<readonly [string, string]>
  /** The thumbnail the pane would hand back, per image id; the test fills it. */
  readonly thumbs: Map<string, string>
  /** The screenshots' screen-sized copies, as the pane hands them over on demand. */
  readonly views: Map<string, string>
  /** What each 复制 click handed the pane for the clipboard. */
  readonly copied: readonly string[]
  readonly rewound: readonly string[]
  readonly editedPending: readonly string[]
  /** Every `Agent` row click, by id. */
  readonly openedSubagents: readonly string[]
  /** The plan text each plan-receipt click handed the pane. */
  readonly openedPlans: ReadonlyArray<string | undefined>
  /** The slash registry the bubble decorates by — the pane's, read live. */
  setCommands(next: readonly WireCommandInfo[]): void
  /** The working directory the rows name their files from — the pane's, read live. */
  setCwd(next: string | undefined): void
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
  const editedPending: string[] = []
  const viewedImages: Array<readonly [string, string]> = []
  const thumbs = new Map<string, string>()
  const views = new Map<string, string>()
  const openedSubagents: string[] = []
  const openedPlans: Array<string | undefined> = []
  let backgroundOpens = 0
  const focusedRequests: string[] = []
  // Replaced rather than mutated, exactly as the pane's own `commands` is on a
  // reload: the bubble's signature reads its identity, so the replacement is
  // what makes an already-painted bubble repaint.
  let commands: readonly WireCommandInfo[] = []
  let cwd: string | undefined
  const view = createTranscriptView(container, host, {
    onToggle: (id, expanded) => toggled.push([id, expanded]),
    onOpenPlan: (content) => openedPlans.push(content),
    onOpenPath: (path, line) => opened.push([path, line]),
    onViewImage: (image) => viewedImages.push([image.id, image.name]),
    imageThumbUrl: (imageId) => thumbs.get(imageId),
    imageViewUrl: (imageId) => views.get(imageId),
    commands: () => commands,
    cwd: () => cwd,
    onCopy: async (text) => { copied.push(text); return true },
    onRewind: (id) => rewound.push(id),
    onEditPending: (id) => editedPending.push(id),
    onOpenSubagent: (id) => openedSubagents.push(id),
    onOpenBackgroundTasks: () => { backgroundOpens += 1 },
    onFocusRequest: (kind) => focusedRequests.push(kind),
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
    focusedRequests,
    setCommands: (next) => { commands = next },
    setCwd: (next) => { cwd = next },
    toggled,
    opened,
    viewedImages,
    thumbs,
    views,
    copied,
    rewound,
    editedPending,
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

test('scrolling up reveals the float button beyond 200px and the bottom fade beyond 8px', (t) => {
  const { jump, stub, container } = mount(t)

  scrolledUpBy(stub, container, 200)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
  assert.equal(stub.inspect(container).classes.includes('has-bottom-fade'), true)

  scrolledUpBy(stub, container, 201)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, false)

  scrolledUpBy(stub, container, 9)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
  assert.equal(stub.inspect(container).classes.includes('has-bottom-fade'), true)
  scrolledUpBy(stub, container, 8)
  stub.dispatch(container, 'scroll')
  assert.equal(stub.inspect(container).classes.includes('has-bottom-fade'), false)

  stub.setMetrics(container, { scrollTop: 800 })
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
  assert.equal(stub.inspect(container).classes.includes('has-bottom-fade'), false)
})

test('a slow wheel inside the 24px slack is not pulled back to the tail', (t) => {
  const { render, stub, container, jump } = mount(t)

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'x' }]))
  scrolledUpBy(stub, container, 4)
  stub.dispatch(container, 'scroll')
  render(transcript([{ id: 'a', kind: 'assistant', text: 'xy' }]))
  assert.equal(stub.inspect(container).scrollTop, 796)
  assert.equal(jump().hidden, true, 'not following, but still within the jump threshold')
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

test('clicking the float button jumps to the tail and pins subsequent growth, without smooth scrolling under reduced motion', (t) => {
  const { render, jump, stub, container } = mount(t)
  const behaviors: Array<ScrollBehavior | undefined> = []
  const scrollTo = container.scrollTo.bind(container)
  t.mock.method(container, 'scrollTo', (options: ScrollToOptions) => {
    behaviors.push(options.behavior)
    scrollTo(options)
  })

  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  stub.click(jump().node)

  assert.equal(stub.inspect(container).scrollTop, 1000)
  assert.deepEqual(behaviors, ['auto'], 'keep the existing explicit-jump policy')
  // The stub fires `scroll` from `scrollTo`, as the browser does.
  assert.equal(jump().hidden, true)
  assert.equal(stub.inspect(container).classes.includes('has-bottom-fade'), false)

  stub.setMetrics(container, { scrollHeight: 1400 })
  render(transcript([{ id: 'a', kind: 'assistant', text: 'more' }]))
  assert.equal(stub.inspect(container).scrollTop, 1400, 'the click restores follow, not just position')
  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  document.documentElement.dataset.reducedMotion = 'true'
  stub.click(jump().node)
  assert.deepEqual(behaviors, ['auto', 'auto'])
  assert.equal(stub.inspect(container).scrollTop, 1000)
})

test('a running turn parks its working mark in the float button while the reader looks back', (t) => {
  const { render, jump, stub, container, items } = mount(t)
  const inButton = (): StubView | undefined =>
    jump().children.find((child) => child.classes.includes('jump-mark'))?.children[0]
  const onLine = (): StubView | undefined =>
    items().at(-1) && statusMain(items().at(-1)!)?.children.find((child) => child.classes.includes('line-mark'))?.children[0]

  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(transcript([{ id: 'u1', kind: 'user', text: 'go', turnId: 't1' }]), NO_DISCLOSURE, RUNNING_T1)
  const mark = onLine()
  assert.ok(mark, 'following the tail: the status line carries it')
  assert.equal(inButton(), undefined)

  // The status line is below the fold now, so the button is the only place the
  // mark can be seen at all.
  scrolledUpBy(stub, container, 400)
  stub.dispatch(container, 'scroll')
  assert.equal(jump().classes.includes('is-working'), true)
  assert.equal(inButton()?.node, mark.node, 'the same mark, moved rather than rebuilt')
  assert.equal(onLine(), undefined)

  // Back within 200px: the button stands down and the line takes the mark back.
  stub.setMetrics(container, { scrollTop: 650 })
  stub.dispatch(container, 'scroll')
  assert.equal(jump().hidden, true)
  assert.equal(onLine()?.node, mark.node)
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
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, stub, container, jump, column } = mount(t)
  stub.onLayout((node) => {
    if (node.node === container) return { top: 0, bottom: 200 }
    if (node.classes.includes('run-line')) return { top: 100, bottom: 120 }
    return undefined
  })
  const thought = (text: string): TranscriptState => transcript([
    { id: 'a', kind: 'thinking', text, turnId: 't1', pending: true },
  ])
  stub.setMetrics(container, { scrollHeight: 1000, clientHeight: 200, scrollTop: 800 })
  render(thought('x'), NO_DISCLOSURE, RUNNING_T1)
  const head = trackIdentity(column, '.run-line').sample()
  assert.ok(head)
  for (const [index, expanded] of [true, false].entries()) {
    stub.setMetrics(container, { scrollTop: 800 + index * 400 })
    stub.click(head)
    stub.setMetrics(container, { scrollHeight: 1400 + index * 400 })
    const disclosure = new Map([['a', expanded]])
    render(thought('x'), disclosure, RUNNING_T1)
    t.mock.timers.tick(200)
    render(thought('xy'), disclosure, RUNNING_T1)
    assert.equal(stub.inspect(container).scrollTop, 1400 + index * 400, 'disclosure never cancels following')
    assert.equal(jump().hidden, true)
  }
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
    { id: 'd', kind: 'duration', text: '已处理 1 秒', durationMs: 1000, turnId: 't1' },
    { id: 'e', kind: 'notice', text: 'Interrupted.', interrupt: true },
  ]), NO_DISCLOSURE, IDLE_ACTIVITY)

  assert.deepEqual(items().map((item) => item.classes), [
    ['item', 'user'],
    ['item', 'notice'],
    ['item', 'error', 'failed'],
    ['item-meta', 'turn-foot'],
    ['item', 'notice', 'interrupt'],
  ])
  assert.deepEqual(items().map((item) => item.text), ['hi显示更多', '上下文已压缩', 'boom', '用时 1 秒', '已中断'])
  for (const at of [1, 2, 4]) {
    assert.equal(items()[at]?.children[0]?.tagName.toLowerCase(), 'svg')
    assert.ok(items()[at]?.children[1]?.classes.includes('notice-text'))
  }
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
  assert.deepEqual(factsOf(items().find((item) => item.classes.includes('assistant'))!), ['用时 5 秒'], 'settled: the span of the records, as replay has no measured time')
})

// --- the thinking line -------------------------------------------------------

const sealedThinking: TranscriptItem = {
  id: 'thinking-0', kind: 'thinking', text: '推理。然后呢。', durationMs: 458_000,
}

test('a thought with no tool has a separate folded entry', (t) => {
  const view = mount(t)
  view.render(transcript([sealedThinking]))
  const line = runOf(view).children[0]!
  assert.deepEqual(line.classes, ['thinking'])
  assert.equal(line.children[0]!.attributes.get('aria-expanded'), 'false')
  assert.equal(line.children[0]!.attributes.get('aria-label'), '推理。')
  assert.equal(line.children.length, 1)
})

test('the pane’s absolute answer outranks the default, both ways', (t) => {
  const { render, items } = mount(t)
  const line = (): StubView => items()[0]!.children[0]!

  render(transcript([sealedThinking]), new Map([['thinking-0', true]]))
  assert.equal(line().classes.includes('open'), true)
  assert.equal(line().children.length, 2)
  assert.match(line().children[1]!.text, /^然后呢。$/)

  render(transcript([sealedThinking]), new Map([['thinking-0', false]]))
  assert.equal(line().classes.includes('open'), false)
  assert.equal(line().children[0]!.children[0]!.text, '推理。', 'folding keeps the first sentence')
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

/** A run of two reads: settled, it keeps its summary line, where a run of one is its row alone. */
function pairItems(overrides: { pending?: boolean } = {}): TranscriptItem[] {
  const [user, first] = turnItems(overrides)
  return [user!, first!, { ...first!, id: 'call-2', tool: { ...first!.tool!, useSummary: 'b.ts' } }]
}

/** Opens the run holding `ids[0]` and each of `ids`. */
function opened(...ids: string[]): DisclosureState {
  return new Map([[`run:${ids[0]}`, true], ...ids.map((id): [string, boolean] => [id, true])])
}

const runOf = (rendered: Rendered): StubView => {
  const found = rendered.items().find((item) => item.classes.includes('run'))
  assert.ok(found, 'no run was painted')
  return found
}

/**
 * A body's parts with each tool output unwrapped to its block: the output's
 * copy button and 「显示全部」 ride in a `.step-output` wrapper, and these tests
 * are about the block inside it.
 */
function parts(view: StubView | undefined): StubView[] {
  return (view?.children ?? []).map((child) => (child.classes.includes('step-output') ? child.children[0]! : child))
}

/** The first row of the first run: its only step once settled alone, else the first of its card. */
const rowOf = (rendered: Rendered): StubView => {
  const run = runOf(rendered)
  const row = run.classes.includes('single') ? run.children[0] : run.children[1]?.children[0]
  assert.ok(row, 'the run is folded, or has no rows')
  return row
}

test('a settled run is one summary line, folded', (t) => {
  const view = mount(t)
  view.render(transcript(pairItems()))

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run'])
  const run = runOf(view)
  assert.deepEqual(run.classes, ['run'])
  const head = run.children[0]!
  assert.equal(head.tagName, 'BUTTON')
  assert.deepEqual(head.children.map((child) => [child.className, child.text]), [['line-text', '读取 2 个文件'], ['icon', '']])
  assert.equal(head.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(head.attributes.get('aria-label'), '读取 2 个文件')
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  // The transcript is an `aria-live` region: a folded run must not be readable.
  assert.equal(run.children.length, 1, 'nothing but the line')
  assert.equal(run.text.includes('line one'), false)
})

test('a settled run of one step is that step’s row alone, folded', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()))
  const run = runOf(view)
  assert.deepEqual(run.classes, ['run', 'single'])
  assert.deepEqual(run.children.map((child) => child.classes.join(' ')), ['step tool done collapsed'])
  assert.equal(run.text.includes('line one'), false)
})

test('a failed call is counted in red beside the counts, and an edit’s patch counts ride the line', (t) => {
  const view = mount(t)
  const [user, first, second] = pairItems()
  view.render(transcript([user!, first!, { ...second!, failed: true }]))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '读取 2 个文件'], ['line-fail', '· 1 个失败'], ['icon', '']],
  )
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 2 个文件 · 1 个失败')

  view.render(transcript([{ ...editStep({ detail: EDIT_PATCH }), id: 'e1' }, { ...editStep({ detail: EDIT_PATCH }), id: 'e2' }]))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '编辑 1 个文件'], ['line-meta', '+2 −2'], ['icon', '']],
  )

  const cut: TranscriptItem[] = [...pairItems({ pending: true }), { id: 'stop', kind: 'notice', text: 'Interrupted.', turnId: 't1', interrupt: true }]
  view.render(transcript(cut))
  assert.deepEqual(
    runOf(view).children[0]!.children.map((child) => [child.className, child.text]),
    [['line-text', '读取 2 个文件'], ['line-meta', '· 已中断'], ['icon', '']],
  )
})

test('a collapsed tool group owns the live status and retains its disclosure', (t) => {
  const view = mount(t)
  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 6_000, outputTokens: 1_234 })
  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run'])
  const head = runOf(view).children[0]!
  assert.equal(head.classes.includes('activity-line'), true)
  assert.deepEqual(statusText(head), { label: '读取 b.ts', meta: ['6 秒', '·', '1.2k token'] })
  assert.equal(head.attributes.get('aria-expanded'), 'false')
  view.stub.click(head.node)
  assert.deepEqual(view.toggled, [[RUN, false]])
})

test('a single tool holds its live status through the request gap, then settles immediately', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const row = rowOf(view).node
  const mark = findView(rowOf(view), 'mark')!.node
  view.render(transcript(turnItems()), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(rowOf(view).node, row)
  assert.equal(findView(rowOf(view), 'mark')!.node, mark)
  assert.equal(rowOf(view).children[0]!.classes.includes('activity-line'), true)
  assert.equal(view.items().some((entry) => entry.classes.includes('waiting')), false)
  view.render(transcript(turnItems()), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.equal(rowOf(view).node, row)
  assert.equal(rowOf(view).children[0]!.classes.includes('activity-line'), false)
  assert.equal(findView(view.column(), 'line-mark'), undefined)
})

test('the thinking status itself unfolds its body, with no separate thinking entry above it', (t) => {
  const view = mount(t)
  const user: TranscriptItem = { id: 'u1', kind: 'user', text: 'go', turnId: 't1' }
  const thought: TranscriptItem = { id: 'th1', kind: 'thinking', text: '先看看。下一句。', turnId: 't1', pending: true }
  const input = { ...RUNNING_T1, startedAt: Date.now() - 6_000, outputTokens: 1_234 }
  view.render(transcript([user, thought]), NO_DISCLOSURE, input)
  assert.deepEqual(view.items().map((entry) => entry.classes.join(' ')), ['item user', 'run thinking-run'])
  const line = runOf(view).children[0]!
  const head = line.children[0]!.node
  const mark = findView(line, 'mark')!.node
  const clock = findView(line, 'line-meta-values')!.node
  assert.deepEqual(statusText(line), { label: '先看看。', meta: ['6 秒', '·', '1.2k token'] })
  assert.equal(statusMain(line).attributes.get('aria-expanded'), 'false')
  assert.equal(line.children.length, 1, 'the status starts folded')
  view.stub.click(head)
  assert.deepEqual(view.toggled, [['th1', false]])
  view.render(transcript([user, thought]), new Map([['th1', true]]), input)
  const open = runOf(view).children[0]!
  assert.equal(open.children[0]!.node, head)
  assert.equal(open.children[0]!.attributes.get('aria-expanded'), 'true')
  assert.equal(open.children[1]!.text, '下一句。', 'the body belongs to this status row and does not repeat the sentence in its header')
  assert.equal(findView(open, 'mark')!.node, mark)
  assert.equal(findView(open, 'line-meta-values')!.node, clock)
  assert.deepEqual(statusText(open).meta, ['6 秒', '·', '1.2k token'])
  view.stub.click(head)
  assert.deepEqual(view.toggled.at(-1), ['th1', true])
  view.render(transcript([user, thought]), new Map([['th1', false]]), input)
  const body = findView(runOf(view), 'thinking-body')!
  view.stub.dispatch(body.node, 'transitionend', { propertyName: 'height' })
  assert.equal(findView(runOf(view), 'thinking-body'), undefined)
  const next = { ...thought, pending: false }
  const current = { ...thought, id: 'th2', text: '再核对接口。其余细节。' }
  view.render(transcript([user, next, current]), NO_DISCLOSURE, input)
  assert.equal(statusText(view.items().at(-1)!).label, '再核对接口。', 'a new segment immediately replaces the previous sentence')
  assert.equal(findView(view.column(), 'thinking-body'), undefined)
  assert.equal(findView(view.column(), 'waiting'), undefined)
})

test('opening a tool group keeps its single spinner and clock in the status header', (t) => {
  const view = mount(t)
  const state = transcript(pairItems({ pending: true }))
  const input = { ...RUNNING_T1, startedAt: Date.now() - 6_000, outputTokens: 1_234 }
  view.render(state, NO_DISCLOSURE, input)
  const head = runOf(view).children[0]!.node
  const mark = findView(view.column(), 'mark')!.node
  const clock = findView(view.column(), 'line-meta-values')!.node
  view.render(state, new Map([[RUN, true]]), input)
  const run = runOf(view)
  assert.equal(run.children[0]!.node, head)
  assert.equal(run.children[0]!.classes.includes('activity-line'), true)
  assert.equal(findView(run.children[0]!, 'mark')!.node, mark)
  assert.equal(findView(run.children[0]!, 'line-meta-values')!.node, clock)
  assert.deepEqual(statusText(run.children[0]!).meta, ['6 秒', '·', '1.2k token'])
  const card = run.children[1]!
  assert.equal(findView(card, 'line-mark'), undefined, 'no spinner moves into the steps')
  assert.equal(findView(card, 'line-meta-values'), undefined)
  assert.ok(card.children.every((row) => row.classes.includes('running')), 'parallel tools remain marked running')
  const [user, first, second] = pairItems({ pending: true })
  view.render(transcript([user!, { ...first!, pending: false }, second!]), new Map([[RUN, true]]), input)
  const updated = runOf(view)
  assert.equal(updated.children[1]!.children[0]!.classes.includes('running'), false, 'completed tools lose their running style')
  assert.equal(updated.children[1]!.children[1]!.classes.includes('running'), true)
  assert.equal(findView(updated.children[0]!, 'mark')!.node, mark)
  view.render(state, NO_DISCLOSURE, input)
  assert.equal(findView(runOf(view).children[0]!, 'mark')!.node, mark)
})

test('a grouped running agent uses the group spinner and keeps its own details link', (t) => {
  const view = mount(t)
  const [user, first, second] = pairItems({ pending: true })
  const agent: TranscriptItem = { ...second!, toolName: 'Agent', tool: { displayName: 'Agent', useSummary: '检查依赖', description: '检查依赖' } }
  view.render(transcript([user!, first!, agent]), new Map([[RUN, true]]), RUNNING_T1)
  const run = runOf(view)
  assert.ok(findView(run.children[0]!, 'mark'))
  assert.equal(findView(run.children[1]!, 'agent-mark'), undefined, 'the grouped agent does not add a second spinner')
  view.stub.click(findView(run.children[1]!, 'agent-description')!.node)
  assert.deepEqual(view.openedSubagents, [agent.id])
})

test('a memory save names the memory and trails its description', (t) => {
  const view = mount(t)
  const [user, read] = turnItems()
  const save: TranscriptItem = {
    ...read!,
    toolName: 'Write',
    tool: { ...read!.tool!, displayName: 'Write', useSummary: '/home/.hanekawa/projects/p/memory/user-role.md', memory: true, memoryNote: '用户是后端工程师' },
  }
  view.render(transcript([user!, save]), NO_DISCLOSURE)
  const head = rowOf(view).children[0]
  assert.equal(head?.children[0]?.text, '保存记忆 user-role用户是后端工程师')
  assert.equal(head?.attributes.get('aria-label'), '保存记忆 user-role · 用户是后端工程师 · 完成')
})

test('a tool row is a button whose body exists only while it is open', (t) => {
  const view = mount(t)
  view.render(transcript(turnItems()), opened('call-1'))
  const tool = rowOf(view)

  const head = tool.children[0]
  assert.equal(head?.tagName, 'BUTTON')
  assert.equal(head?.attributes.get('aria-expanded'), 'true')
  assert.deepEqual(head?.children.map((part) => [part.className, part.text]), [['step-label', '读取 a.ts'], ['icon', '']])
  // The state reaches a screen reader as words, because colour is not a name.
  assert.equal(head?.attributes.get('aria-label'), '读取 a.ts · 完成')
  // 兜底 body: the result's own summary over `detail ?? content` (§6.2).
  assert.deepEqual(
    parts(tool.children[1]).map((part) => [part.className, part.text]),
    [['step-body-head', 'Read 240 lines'], ['step-body-text', 'line one']],
  )

  view.render(transcript(turnItems()), new Map([[RUN, true]]))
  view.stub.dispatch(rowOf(view).children[1]?.node, 'transitionend', { propertyName: 'height' })
  const folded = rowOf(view)
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
  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 b.ts')

  view.render(transcript(pairItems()))
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 2 个文件')
})

test('the run survives the turn ending, and its line is kept and reports what it showed', (t) => {
  // The browser's scroll anchoring can only hold a reader's place while the node
  // the anchor points at outlives the paint.
  const view = mount(t)
  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  const before = runOf(view).node
  const head = runOf(view).children[0]!.node

  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(runOf(view).children[0]!.node, head, 'an unchanged line is not rebuilt')

  view.render(transcript(pairItems()))
  assert.equal(runOf(view).node, before, 'the run is refilled in place, not replaced')
  assert.equal(runOf(view).children[0]!.node, head, 'the line survives the turn ending')
  assert.equal(runOf(view).children[0]!.attributes.get('aria-expanded'), 'false')

  view.stub.click(head)
  assert.deepEqual(view.toggled, [[RUN, false]], 'the kept head reports the paint that is on screen')
})

test('the run and its rows report their own id and what they showed', (t) => {
  const view = mount(t)
  view.render(transcript(pairItems()))
  view.stub.click(runOf(view).children[0]?.node)
  assert.deepEqual(view.toggled, [[RUN, false]], 'the run answers under its own id')

  view.render(transcript(pairItems()), new Map([[RUN, true]]))
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
    row: rowOf(view).node,
  }

  // A later paint of the same turn, with the tool now settled: fresh item objects
  // throughout, as the model mints them.
  view.render(transcript(turnItems()), new Map([[RUN, true]]))
  assert.equal(view.column().node, before.column)
  assert.equal(view.items()[0]?.node, before.message, 'an untouched message is not rebuilt')
  assert.equal(runOf(view).node, before.run)
  assert.equal(rowOf(view).node, before.row, 'the row is refilled in place')

  // And a node whose entry is gone does not linger in the cache: `transcript-reset`
  // restarts the id counter, so a kept node would come back holding another
  // block's content.
  view.render(transcript([{ id: 'reset-notice-0', kind: 'notice', text: '已清空' }]))
  view.render(transcript(turnItems({ pending: true })), new Map([[RUN, true]]), RUNNING_T1)
  assert.notEqual(rowOf(view).node, before.row)
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
  // `编辑 a.ts` and its counts (§6.2): for this family they *are* the result's
  // note, and they sit against the name, left of the chevron.
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '编辑 a.ts'], ['step-right', '+1 −1'], ['icon', '']],
  )
  assert.equal(head?.attributes.get('aria-label'), '编辑 a.ts · +1 −1 · 完成')
  assert.deepEqual(head?.children[1]?.children.map((part) => [part.className, part.text]), [['stat-add', '+1'], ['stat-del', '−1']])

  // The body is the file's full path over the same diff the permission dialog
  // paints — the result summary is not repeated over it.
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  assert.deepEqual(parts(body).map((child) => [child.className, child.className === 'diff' ? '' : child.text]), [['step-path', 'a.ts'], ['diff', '']])
  const diff = parts(body)[1]
  assert.equal(diff?.className, 'diff')
  assert.deepEqual(diff?.children.map((row) => row.classes), [
    ['diff-row', 'ctx'],
    ['diff-row', 'ctx'],
    ['diff-row', 'del'],
    ['diff-row', 'add'],
    ['diff-row', 'ctx'],
  ])
  assert.deepEqual(diff?.children[2]?.children.map((part) => [part.className, part.text]), [
    // Line numbers pad to the widest one in the hunk (here one digit), not a
    // fixed three, so a short diff does not open with a wide blank margin.
    ['gutter', '3   -'],
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
  assert.deepEqual(parts(body).map((part) => [part.className, part.text]), [
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
  assert.equal(parts(body)[0]?.className, 'step-terminal')
  assert.equal(parts(body)[0]?.text, EDIT_PATCH)
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

test('a long output draws its first 200 lines, unfolds on request, and copies whole', async (t) => {
  // The block already scrolled inside its height; the fold is about layout: a
  // build log of thousands of lines was laid out in full the moment it opened.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(t)
  const output = Array.from({ length: 250 }, (_, i) => `line ${i + 1}`).join('\n')
  view.render(transcript([bashStep({ content: output })]), opened('bash-1'))

  const wrap = rowOf(view)?.children[1]?.children.find((child) => child.classes.includes('step-output'))
  assert.ok(wrap)
  const [pre, copy, more] = wrap.children
  assert.equal(pre?.text.split('\n').length, 200)
  assert.equal(more?.text, '显示全部 250 行')

  view.stub.click(copy!.node)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(view.copied, [output], 'the copy takes what was folded away too')

  view.stub.click(more!.node)
  const after = rowOf(view)?.children[1]?.children.find((child) => child.classes.includes('step-output'))
  assert.equal(after?.children[0]?.text, output)
  assert.equal(after?.children.some((child) => child.classes.includes('step-output-more')), false)
})

test('a Bash step opens into a terminal block with its output ANSI-stripped', (t) => {
  const view = mount(t)
  view.render(transcript([bashStep()]), opened('bash-1'))

  const step = rowOf(view)
  assert.deepEqual(step?.classes, ['step', 'tool', 'done'])
  // The block is the command's own output and nothing else — the head already
  // said what ran and how long, so there is no summary line above it (§6.2).
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  assert.deepEqual(parts(body).map((child) => child.className), ['step-terminal'])
  assert.equal(parts(body)[0]?.tagName, 'PRE')
  // §6.4: the sequences are stripped, not printed — a real `npm test` line, not
  // the `[32m` garbage the raw string would show.
  assert.equal(parts(body)[0]?.text, 'ok 42 passed\n3 failed')
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
    parts(body).map((child) => [child.className, child.text]),
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
    parts(body).map((child) => [child.className, child.text]),
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
  assert.deepEqual(parts(body).map((child) => child.className), ['step-command', 'step-error', 'step-terminal'])
  const bubble = parts(body)[0]!
  assert.equal(bubble.children[0]?.text, `$ ${command}`)
  assert.equal(parts(body)[2]?.text, 'ok 42 passed\n3 failed')
  view.stub.click(bubble.children[1]!.node)
  assert.deepEqual(view.copied, [command])
  await Promise.resolve()
  t.mock.timers.tick(5000)
})

test('the bubble colours the command by shell syntax behind a plain prompt, and copies it bare', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const view = mount(t)
  const command = 'git commit -m "msg"'
  view.render(transcript([bashStep({ command })]), opened('bash-1'))

  const bubble = parts(rowOf(view)?.children[1])[0]!
  const text = bubble.children[0]!
  assert.equal(text.className, 'step-command-text')
  assert.equal(text.children[0]?.className, 'step-command-prompt')
  assert.equal(text.children[0]?.text, '$ ')
  assert.ok(text.children.some((child) => child.className === 'syn-function' && child.text.includes('git')))
  assert.ok(text.children.some((child) => child.className === 'syn-string' && child.text.includes('"msg"')))
  assert.equal(text.text, `$ ${command}`)
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
  assert.deepEqual(parts(step?.children[1]).map((child) => child.className), ['step-command', 'step-terminal'])

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
  // the reader — the task id and output file are what they need.
  view.render(
    transcript([bashStep({ content: 'Task ID: bg-1\nPID: 123', detail: 'PID: 123' })]),
    opened('bash-1'),
  )

  const body = rowOf(view)?.children[1]
  assert.equal(parts(body)[0]?.className, 'step-terminal')
  assert.equal(parts(body)[0]?.text, 'Task ID: bg-1\nPID: 123')
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
  // own, left of the chevron — the same place the edit family puts its `+12 −3`.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '搜索 pattern: "turnId"'], ['step-right', '3 处 / 2 文件'], ['icon', '']],
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
    parts(step?.children[1]).map((part) => [part.className, part.text]),
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
  // `读取 src/a.ts` and nothing else (§6.2): how long the file is says nothing
  // about the call, so the head carries no count.
  const head = step?.children[0]
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '读取 src/a.ts'], ['icon', '']],
  )
  assert.equal(head?.attributes.get('aria-label'), '读取 src/a.ts · 完成')

  // The body is the file's own lines, one row each with its own number — and
  // no highlighting of any kind: the row is exactly the text the tool read.
  const body = step?.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  const block = parts(body)[0]
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

test('a read inside the workspace is named from it, one outside keeps its full path', (t) => {
  const view = mount(t)
  view.setCwd('/work/proj')
  const step = { ...readStep(), tool: { ...readStep().tool!, useSummary: '/work/proj/src/a.ts' } }
  view.render(transcript([step]), opened('read-1'))
  assert.equal(rowOf(view).children[0]?.children[0]?.text, '读取 src/a.ts')

  // The same row, before `hello` has named the directory: the path is all it has.
  view.setCwd(undefined)
  view.render(transcript([step]), opened('read-1'))
  assert.equal(rowOf(view).children[0]?.children[0]?.text, '读取 /work/proj/src/a.ts')

  // Another project's file is not this workspace's to shorten.
  const elsewhere = { ...step, tool: { ...step.tool, useSummary: '/elsewhere/b.ts' } }
  view.setCwd('/work/proj')
  view.render(transcript([elsewhere]), opened('read-1'))
  assert.equal(rowOf(view).children[0]?.children[0]?.text, '读取 /elsewhere/b.ts')
})

test('a Read step numbers its rows from the tool’s own prefix, offset included', (t) => {
  const view = mount(t)
  const content = '    20\tone\n    21\ttwo\n\n[Showing lines 20-21 of 40. Use offset/limit to read another range.]'
  view.render(transcript([readStep({ content })]), opened('read-1'))

  const block = parts(rowOf(view)?.children[1])[0]
  assert.deepEqual(
    block?.children.map((row) => [row.children[0]?.text, row.children[1]?.text]),
    [['20', 'one'], ['21', 'two']],
  )
})

/** An icon's path data, as `icons.ts` drew it. */
const pathOf = (svg: SVGSVGElement): string | null => svg.children[0]?.getAttribute('d') ?? null

/** The Agent step: alone, it is the whole of its single-step run. */
const agentRowOf = (rendered: Rendered): StubView => {
  const step = runOf(rendered).children[0]
  assert.ok(step, 'no Agent step was painted')
  return step
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
      description: '扫一遍 tools/',
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

test('a running Agent step is one row of prose, its mark turning, and only the description opens the run', (t) => {
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
      description: '扫一遍 tools/',
      agentType: 'explore',
      task: '找用法',
      live: { tool: 'Read', summary: 'src/a.ts', toolCount: 3 },
    },
  }
  view.render(transcript([running]), new Map([['run:agent-1', true], ['agent-1', false]]))

  const step = agentRowOf(view)
  const head = step?.children[0]
  // No capsule around the row: a quiet verb and the description, like any tool line.
  assert.equal(head?.className, 'step-head agent-ran')
  assert.deepEqual(
    head?.children.map((part) => [part.className, part.text]),
    [['step-label', '正在运行子 agent 扫一遍 tools/']],
  )
  const label = head?.children[0]
  assert.deepEqual(
    label?.children.map((part) => [part.className, part.text]),
    [['agent-mark', ''], ['agent-verb', '正在运行子 agent '], ['agent-description', '扫一遍 tools/']],
  )

  // The row is prose, not a button: only the description is the link.
  view.stub.click(head!.node)
  assert.deepEqual(view.openedSubagents, [])
  view.stub.click(label!.children[2]!.node)
  assert.deepEqual(view.openedSubagents, ['agent-1'])
  assert.equal(label?.children[2]?.attributes.get('aria-label'), 'explore · 扫一遍 tools/ · 执行中')

  // The mark is the spinner — the thread list's own shape, turned by the sheet off
  // the step's own `running` class, so 「still going」 looks the same in both places.
  assert.ok(step?.classes.includes('running'))
  assert.deepEqual(
    [label?.children[0]?.children[0]?.children[0]?.attributes.get('d'), label?.children[0]?.children[0]?.children[0]?.tagName],
    [pathOf(icon('spinner')), 'path'],
  )
  assert.notEqual(label?.children[0]?.children[0]?.children[0]?.attributes.get('d'), pathOf(icon('agent')))
})

test('an Agent step is a link to the side panel, with the run in the head', (t) => {
  const view = mount(t)
  view.render(transcript([agentStep()]), opened('agent-1'))

  const step = agentRowOf(view)
  // Only the short description is linked; model and tool counts live in the detail.
  const head = step?.children[0]
  assert.equal(head?.className, 'step-head agent-ran')
  const label = head?.children[0]
  assert.deepEqual(
    label?.children.map((part) => [part.className, part.text]),
    [['agent-verb', '已运行子 agent '], ['agent-description', '扫一遍 tools/']],
  )
  assert.equal(label?.children[1]?.attributes.get('aria-label'), 'explore · 扫一遍 tools/ · opus · 12 工具 · 完成')

  // Never a fold: the run lives in the side panel, even when the disclosure
  // says open, and a click asks for that panel instead of toggling.
  assert.equal(step?.children.some((child) => child.classes.includes('step-body')), false)
  view.stub.click(head!.node)
  assert.deepEqual(view.openedSubagents, [])
  view.stub.click(label!.children[1]!.node)
  assert.deepEqual(view.openedSubagents, ['agent-1'])
  assert.deepEqual(view.toggled, [])

  view.render(transcript([agentStep()]), new Map([['run:agent-1', true]]), undefined, 'agent-1')
  const selected = agentRowOf(view)
  assert.equal(selected?.classes.includes('selected'), true)
})

test('an Agent call is a step of the work around it and is counted in the run summary', (t) => {
  const view = mount(t)
  const read = (id: string): TranscriptItem => ({ id, kind: 'tool', text: id, toolName: 'Read', turnId: 't1', tool: { displayName: 'Read', useSummary: `${id}.ts` } })
  const other = { ...agentStep(), id: 'agent-2' }
  view.render(transcript([read('r1'), read('r1b'), agentStep(), read('r2'), other, { ...agentStep(), id: 'agent-3' }]), NO_DISCLOSURE)
  assert.deepEqual(view.items().map((entry) => entry.classes.join(' ')), ['run'])
  assert.equal(runOf(view).children[0]!.attributes.get('aria-label'), '读取 3 个文件，运行 3 个子代理')
})

test('a failed Agent step keeps its plain row and says so in words', (t) => {
  const view = mount(t)
  const failed = { ...agentStep(), failed: true }
  view.render(transcript([failed]), opened('agent-1'))
  const head = agentRowOf(view).children[0]
  assert.equal(head?.className, 'step-head agent-ran')
  const label = head?.children[0]
  assert.equal(label?.text.endsWith('失败'), true)
  assert.equal(label?.children[1]?.className, 'agent-description')
  view.stub.click(label!.children[1]!.node)
  assert.deepEqual(view.openedSubagents, ['agent-1'])
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
    parts(body).map((part) => part.className),
    ['step-body-head', 'step-web md'],
  )
  const article = parts(body)[1]
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
    parts(failedBody).map((part) => [part.className, part.text]),
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

// --- the command a message opened with --------------------------------------

/** The bubble's inner text host, where the command token and the mentions land. */
const bubbleText = (item: StubView | undefined): StubView | undefined =>
  item?.children.find((child) => child.classes.includes('user-bubble'))?.children[0]

test('a skill keeps the composer\'s own drawing in the bubble it was sent from', (t) => {
  const { render, items, setCommands } = mount(t)
  setCommands([{ name: 'slides', description: 'Build a deck', isSkill: true }])
  render(transcript([{ id: 'm1', kind: 'user', text: '/slides 三页' }]))

  const text = bubbleText(items()[0])
  assert.deepEqual(text?.nodes?.map((node) => (typeof node === 'string' ? node : node.className)), ['user-command skill', ' 三页'])
  const token = text?.children[0]
  assert.equal(token?.tagName, 'SPAN', 'read-only: the command already ran')
  // The mark takes the slash's place, then the name — the composer's own order.
  assert.equal(token?.children[0]?.className, 'user-command-mark')
  assert.equal(token?.children[0]?.children[0]?.tagName, 'svg')
  assert.deepEqual(token?.nodes[1], 'slides', 'the slash is gone, the name is text')
})

test('a built-in command is the accent token it was while being typed', (t) => {
  const { render, items, setCommands } = mount(t)
  setCommands([{ name: 'compact', description: 'Compact the conversation' }])
  render(transcript([{ id: 'm1', kind: 'user', text: '/compact' }]))

  const token = bubbleText(items()[0])?.children[0]
  assert.equal(token?.className, 'user-command', 'not the skill variant')
  assert.deepEqual(token?.nodes, ['/compact'], 'no mark: the slash is the label')
  assert.equal(token?.children.length, 0)
})

test('an unregistered slash stays plain text, as the composer left it', (t) => {
  const { render, items } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '/usr/bin/env node' }]))

  assert.deepEqual(bubbleText(items()[0])?.nodes, ['/usr/bin/env node'])
})

test('a bubble drawn before the registry arrived repaints once it does', (t) => {
  // A resumed session paints its history before `listCommands()` answers, and a
  // skill's mark is the registry's answer. The list's identity is in the bubble's
  // signature, so the arrival is exactly one refill — and a repaint that changes
  // nothing afterwards still rebuilds nothing.
  const { render, items, setCommands } = mount(t)
  render(transcript([{ id: 'm1', kind: 'user', text: '/review this' }]))
  const plain = bubbleText(items()[0])
  assert.deepEqual(plain?.nodes, ['/review this'])

  setCommands([{ name: 'review', description: 'Review the diff', isSkill: true }])
  render(transcript([{ id: 'm1', kind: 'user', text: '/review this' }]))
  const drawn = bubbleText(items()[0])
  assert.deepEqual(drawn?.nodes?.map((node) => (typeof node === 'string' ? node : node.className)), ['user-command skill', ' this'])

  const kept = drawn?.node
  render(transcript([{ id: 'm1', kind: 'user', text: '/review this' }]))
  assert.equal(bubbleText(items()[0])?.node, kept, 'an unchanged registry rebuilds nothing')
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

test('the card takes the status off the running row, so the line stays at the bottom', (t) => {
  const view = mount(t)
  const state = transcript(turnItems({ pending: true }))
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 5_000 }
  view.render(state, NO_DISCLOSURE, activity)
  assert.equal(statusText(runOf(view)).label, '读取 a.ts', 'without a card the running call carries the line')

  view.render(state, NO_DISCLOSURE, { ...activity, taskCard: CARD })
  const items = view.items()
  assert.equal(findView(view.column(), 'activity-line'), undefined, 'no row carries the line beside the card')
  assert.ok(items.at(-2)?.classes.includes('task-card'))
  assert.ok(items.at(-1)?.classes.includes('waiting'))
  assert.equal(statusText(items.at(-1)!).label, '读取 a.ts', 'the line moved down whole, words and all')
  assert.ok(findView(items.at(-1)!, 'mark'), 'the mark moved with it')
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

test('unsent bubbles offer withdrawal and only accepted messages display a read receipt', (t) => {
  const view = mount(t)
  const base: TranscriptItem = { id: 'queued:q1', kind: 'user', text: '补充一下', createdAt: new Date().toISOString() }
  const has = (name: string) => (view.items()[0]!.node as HTMLElement).querySelector(`.${name}`)
  for (const delivery of ['queued', 'staged'] as const) {
    view.render(transcript([{ ...base, delivery }]))
    assert.equal(has('item-read'), null)
    assert.equal(has('item-rewind'), null)
    const retract = has('item-retract')!
    assert.equal(retract.getAttribute('aria-label'), '撤回并编辑')
    view.stub.click(retract)
  }
  assert.deepEqual(view.editedPending, [base.id, base.id])
  view.render(transcript([base]))
  assert.ok(has('item-read'))
  assert.ok(has('item-rewind'))
  assert.equal(has('item-retract'), null)
})

test('a message carries a meta row: 复制, its model, its time — and a draft carries none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { render, items, copied, rewound, stub } = mount(t)
  const meta = (item: StubView): StubView | undefined =>
    item.children.find((child) => child.classes.includes('item-meta'))
  // Five minutes ago: the stamp reads the window's one time label, which counts
  // up for the first hour.
  const at = new Date(Date.now() - 5 * 60_000).toISOString()

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
    [['item-copy', ''], ['item-model', 'glm-5.3'], ['item-time', '5 分钟前']],
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
  // A successful copy turns the glyph into a tick for one glance — the same
  // 1.2s receipt as a code block's, where it had been five seconds here — and
  // names the button 已复制 for a screen reader too, not only in its title.
  await Promise.resolve()
  assert.equal((row.children[0]!.node as HTMLButtonElement).title, '已复制')
  assert.equal((row.children[0]!.node as HTMLButtonElement).getAttribute('aria-label'), '已复制')
  t.mock.timers.tick(1200)
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
    [['item-time', '5 分钟前'], ['item-read', ''], ['item-copy', ''], ['item-rewind', '']],
  )
  assert.equal(userRow.children[1]!.attributes.get('aria-label'), '已读')
  stub.click(userRow.children[2]!.node)
  assert.deepEqual(copied, ['part done', 'go'])
  await Promise.resolve()
  t.mock.timers.tick(1200)
  // 回退 addresses the checkpoint by the user record's id.
  stub.click(userRow.children[3]!.node)
  assert.deepEqual(rewound, ['u1'])
})

test('copying a user message copies their words, not the attached-paths block', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // The paths after the words are drawn as tiles; pasting the raw block
  // elsewhere pasted markup the user never saw.
  const { render, items, copied, stub } = mount(t)
  const at = new Date(2026, 4, 7, 14, 32).toISOString()
  render(transcript([{ id: 'u1', kind: 'user', text: 'look\n\n<attached-paths>\nfile: /p/a.ts\n</attached-paths>', createdAt: at }]))
  const row = items()[0]!.children.find((child) => child.classes.includes('item-meta'))!
  stub.click(row.children.find((child) => child.classes.includes('item-copy'))!.node)
  await Promise.resolve()
  assert.deepEqual(copied, ['look'])
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

// --- text morph --------------------------------------------------------------

test('text changes crossfade once, cancel obsolete fades, and survive host reuse', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const host = stub.createContainer('line-text')
  const animations: Array<{ finished: Promise<void>; resolve(): void; cancelled: boolean; cancel(): void }> = []
  const prototype = Element.prototype
  Reflect.set(prototype, 'animate', (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    assert.ok(keyframes[0]!.opacity === 0 || keyframes[0]!.opacity === 1)
    assert.deepEqual(options, { duration: TEXT_SWAP_MS, easing: TEXT_SWAP_EASING })
    let resolve!: () => void
    const finished = new Promise<void>((done) => { resolve = done })
    const animation = { finished, resolve, cancelled: false, cancel() { this.cancelled = true } }
    animations.push(animation)
    return animation
  })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))
  const swap = createTextSwap(host, 'line-label')
  t.after(swap.finish)
  swap.set('A')
  swap.set('BB')
  swap.set('CCC')
  assert.equal(host.children.length, 2, 'one arriving label and one departing label')
  assert.equal(host.children[0]!.textContent, 'CCC')
  assert.equal(host.children[1]!.getAttribute('aria-hidden'), 'true')
  assert.equal(animations[0]!.cancelled, true)
  animations[0]!.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(animations[2]!.cancelled, false, 'old completion does not cancel a new fade')
  animations[2]!.resolve()
  animations[3]!.resolve()
  await new Promise<void>((resolve) => queueMicrotask(resolve))
  assert.equal(animations[2]!.cancelled, true)
  assert.equal(host.children.length, 1, 'the departing label is removed after the crossfade')
  host.replaceChildren()
  swap.set('CCC')
  assert.equal(host.textContent, 'CCC', 'a reused host cannot lose its words')
})

test('text replacement is immediate without animation APIs, with reduced motion, and while hidden', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const host = stub.createContainer('line-text')
  const swap = createTextSwap(host, 'line-label')
  swap.set('A')
  swap.set('BB')
  assert.equal(host.textContent, 'BB')
  const prototype = Element.prototype
  Reflect.set(prototype, 'animate', () => { assert.fail('must not animate') })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))
  document.documentElement.dataset.reducedMotion = 'true'
  swap.set('C')
  assert.equal(host.textContent, 'C')
  document.documentElement.dataset.reducedMotion = 'false'
  stub.setHidden(true)
  swap.set('D')
  assert.equal(host.textContent, 'D')
  assert.equal(host.children.length, 1)
})

// --- number tween -------------------------------------------------------------

test('whole labels replace immediately while counters glide in both directions and retarget from their displayed position', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const row = stub.createContainer('activity-line')
  const host = stub.createContainer('line-text')
  const counters = stub.createContainer('line-elapsed')
  row.appendChild(host)
  row.appendChild(counters)
  let offset = 0
  const frames: Keyframe[][] = []
  const targets: HTMLElement[] = []
  const prototype = Element.prototype
  stub.onLayout((node) => {
    const labelWidth = (host.children[0]?.textContent?.length ?? 0) * 10
    const left = node.node === counters ? labelWidth + offset : 0
    return { top: 0, bottom: 20, left, right: left + (node.node === host ? labelWidth : node.text.length * 10) }
  })
  Reflect.set(prototype, 'animate', function (this: HTMLElement, keyframes: Keyframe[]) {
    frames.push(keyframes)
    targets.push(this)
    const moving = keyframes[0]!.translate !== undefined
    if (moving) offset = Number.parseFloat(String(keyframes[0]!.translate))
    return { finished: new Promise(() => {}), cancel() { if (moving) offset = 0 } }
  })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))
  const swap = createTextSwap(host, 'line-label')
  t.after(swap.finish)
  swap.set('A')
  swap.set('AB')
  assert.equal(host.children[0]!.textContent, 'AB', 'the complete new label is present at once')
  assert.deepEqual(frames[0], [{ opacity: 0 }, { opacity: 1 }])
  assert.deepEqual(frames[2], [{ translate: '-10px 0' }, { translate: '0px 0' }])
  offset = -5
  swap.set('ABC')
  assert.deepEqual(frames[5], [{ translate: '-15px 0' }, { translate: '0px 0' }])
  swap.set('ABC')
  assert.equal(frames.length, 6, 'an unchanged snapshot leaves the glide running')
  swap.set('A')
  assert.deepEqual(frames[8], [{ translate: '5px 0' }, { translate: '0px 0' }], 'shrinking uses the same transition as growing')
  assert.ok(targets.every((target) => target !== host), 'label width is never animated to reveal characters')
})

test('counter width is measured before a digit changes and preserves an unchanged animation target', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const host = stub.createContainer('line-meta-seat')
  const content = stub.createContainer('line-meta-values')
  host.appendChild(content)
  content.textContent = '9s'
  let displayed: number | undefined
  const animations: Array<{ frames: Keyframe[]; cancelled: boolean }> = []
  const prototype = Element.prototype
  stub.onLayout((node) => ({ top: 0, bottom: 20, left: 0,
    right: node.node === host ? displayed ?? content.textContent!.length * 10 : node.text.length * 10 }))
  Reflect.set(prototype, 'animate', (frames: Keyframe[]) => {
    const animation = { frames, cancelled: false }
    animations.push(animation)
    displayed = Number.parseFloat(String(frames[0]!.width))
    return { finished: new Promise(() => {}), cancel() { animation.cancelled = true; displayed = undefined } }
  })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))
  const tween = createWidthTween(host, content)
  t.after(tween.finish)
  tween.update(() => { content.textContent = '10s' })
  assert.deepEqual(animations[0]!.frames, [{ width: '20px' }, { width: '30px' }])
  displayed = 25
  tween.update(() => { content.textContent = '11s' })
  assert.equal(animations.length, 1, 'equal-width digits do not restart the glide')
  assert.equal(animations[0]!.cancelled, false)
  tween.update(() => { content.textContent = '100s' })
  assert.deepEqual(animations[1]!.frames, [{ width: '25px' }, { width: '40px' }])
  assert.equal(animations[0]!.cancelled, true)
  document.documentElement.dataset.reducedMotion = 'true'
  tween.update(() => { content.textContent = '101s' })
  assert.equal(animations[1]!.cancelled, true)
  assert.equal(animations.length, 2)
})

function tweenFrames(t: TestContext) {
  let now = 0
  let sequence = 0
  const frames = new Map<number, FrameRequestCallback>()
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  t.mock.method(performance, 'now', () => now)
  globalThis.requestAnimationFrame = (run) => { frames.set(++sequence, run); return sequence }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel })
  return {
    pending: () => frames.size,
    advance(ms: number) {
      now += ms
      for (const [id, run] of [...frames]) {
        frames.delete(id)
        run(now)
      }
    },
  }
}

test('number tween uses 400ms cubic-out, keeps unchanged targets, and retargets from the shown integer', (t) => {
  const stub = installDomStub()
  const values: number[] = []
  const tween = createNumberTween((value) => values.push(value))
  t.after(() => { tween.finish(); stub.uninstall() })
  const frames = tweenFrames(t)
  tween.set(100)
  tween.set(140)
  assert.deepEqual(values, [100], 'the initial number lands immediately')
  frames.advance(NUMBER_TWEEN_MS / 2)
  assert.equal(values.at(-1), 135, 'halfway is 87.5% of the delta')
  tween.set(140)
  frames.advance(NUMBER_TWEEN_MS / 2)
  assert.equal(values.at(-1), 140, 'an unchanged target does not extend the segment')
  assert.equal(frames.pending(), 0)
  tween.set(180)
  frames.advance(200)
  assert.equal(values.at(-1), 175)
  tween.set(190)
  assert.equal(values.at(-1), 175, 'interrupting does not snap to the old target')
  assert.equal(frames.pending(), 1, 'the old segment is cancelled')
  frames.advance(200)
  assert.equal(values.at(-1), 188)
  frames.advance(200)
  assert.equal(values.at(-1), 190)
  assert.equal(frames.pending(), 0)
})

test('number tween jumps above 50%, but animates at the boundary', (t) => {
  const stub = installDomStub()
  let shown = 0
  const tween = createNumberTween((value) => { shown = value })
  t.after(() => { tween.finish(); stub.uninstall() })
  const frames = tweenFrames(t)
  tween.set(100)
  tween.set(150)
  assert.equal(shown, 100, 'exactly 50% still animates')
  frames.advance(400)
  assert.equal(shown, 150)
  tween.set(226)
  assert.equal(shown, 226, 'more than 50% jumps')
  assert.equal(frames.pending(), 0)
  tween.set(200)
  tween.set(10)
  assert.equal(shown, 10, 'a large decrease also cancels an in-flight segment')
  assert.equal(frames.pending(), 0)
  tween.set(0)
  tween.set(1)
  assert.equal(shown, 1, 'there is no relative tween from zero')
})

test('number tween settles without frame APIs, with disabled motion, or when finished', (t) => {
  const stub = installDomStub()
  let shown = 0
  const tween = createNumberTween((value) => { shown = value })
  t.after(() => { tween.finish(); stub.uninstall() })
  const frames = tweenFrames(t)
  tween.set(100)
  tween.set(120)
  tween.finish()
  assert.equal(shown, 120)
  assert.equal(frames.pending(), 0)
  tween.set(140)
  document.documentElement.dataset.reducedMotion = 'true'
  tween.set(140)
  assert.equal(shown, 140, 'an unchanged target settles when reduced motion changes')
  assert.equal(frames.pending(), 0)
  tween.set(160)
  assert.equal(shown, 160)
  document.documentElement.dataset.reducedMotion = 'false'
  tween.set(180)
  stub.setHidden(true)
  frames.advance(100)
  assert.equal(shown, 180, 'a hidden document settles on the next frame')
  assert.equal(frames.pending(), 0)
  stub.setHidden(false)
  Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  tween.set(200)
  assert.equal(shown, 200, 'no frame API falls back to immediate replacement')
})

// --- the live status -----------------------------------------------------------

/** What the pane hands the view about the turn in flight. */
function waiting(state: TranscriptState, startedAt: number | undefined, outputTokens?: number): WaitingInput {
  return { isStreaming: true, startedAt, turnId: state.turnId, ...(outputTokens === undefined ? {} : { outputTokens }) }
}

function findView(view: StubView, className: string): StubView | undefined {
  if (view.classes.includes(className)) return view
  for (const child of view.children) {
    const found = findView(child, className)
    if (found) return found
  }
  return undefined
}

function statusMain(row: StubView): StubView {
  return findView(row, 'activity-line') ?? findView(row, 'waiting-main')!
}

function statusText(row: StubView): { label: string; meta: string[] } {
  const main = statusMain(row)
  return { label: findView(main, 'line-text')!.text, meta: findView(main, 'line-meta-values')!.children.map((part) => part.text) }
}

test('the fallback starts with the mark and words; time and tokens appear after two seconds', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u', kind: 'user', text: 'go', turnId: 't1' }])
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 500, outputTokens: 1_234 }
  view.render(state, NO_DISCLOSURE, activity)
  const row = view.items().at(-1)!
  assert.deepEqual(row.classes, ['waiting'])
  assert.deepEqual(statusMain(row).children.map((part) => part.classes[0]), ['line-mark', 'line-text', 'line-meta'])
  assert.deepEqual(statusText(row), { label: '处理中', meta: [] })
  view.render(state, NO_DISCLOSURE, { ...activity, startedAt: Date.now() - 5_000 })
  assert.deepEqual(statusText(view.items().at(-1)!), { label: '处理中', meta: ['5 秒', '·', '1.2k token'] })
  const main = statusMain(view.items().at(-1)!)
  assert.equal(main.children[0]!.attributes.get('aria-hidden'), 'true')
  assert.equal(main.children[2]!.attributes.get('aria-hidden'), 'true')
})

test('the live clock survives carrier moves while the new status fades once, then stops on completion', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_700_000_000_000 })
  const view = mount(t)
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 3_000, outputTokens: 123 }
  const thought: TranscriptItem = { id: 'th', kind: 'thinking', text: 'Thinking', turnId: 't1', pending: true }
  const a: TranscriptItem = { id: 'a', kind: 'tool', text: 'read', turnId: 't1', pending: true, toolName: 'Read', tool: { displayName: 'Read', useSummary: 'a.ts' } }
  view.render(transcript([thought]), NO_DISCLOSURE, activity)
  const clock = findView(view.column(), 'line-meta-values')!.node
  const label = findView(findView(view.column(), 'activity-line')!, 'line-text')!.node
  const prototype = Element.prototype
  const fades: Keyframe[][] = []
  Reflect.set(prototype, 'animate', (frames: Keyframe[]) => {
    fades.push(frames)
    return { finished: new Promise(() => {}), cancel() {} }
  })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))
  view.render(transcript([{ ...thought, pending: false }, a]), NO_DISCLOSURE, activity)
  view.render(transcript([{ ...thought, pending: false }, a]), NO_DISCLOSURE, activity)
  assert.equal(findView(view.column(), 'line-meta-values')!.node, clock)
  assert.equal(findView(view.column(), 'line-text')!.node, label, 'the settled thought keeps its own label')
  assert.deepEqual(fades, [[{ opacity: 0 }, { opacity: 1 }]], 'switching from thought to tool fades the new status once')
  t.mock.timers.tick(1_000)
  assert.match((clock as HTMLElement).textContent!, /4 秒/)
  view.render(transcript([{ ...thought, pending: false }, { ...a, pending: false }]), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.equal(findView(view.column(), 'activity-line'), undefined)
  assert.equal(findView(view.column(), 'waiting'), undefined)
  assert.equal(findView(view.column(), 'mark'), undefined)
  const final = view.column().text
  t.mock.timers.tick(3_000)
  assert.equal(view.column().text, final, 'there is no completion linger or running clock')
})

test('tool labels settle inside the same collapsed group without a duplicate bottom line', (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1_700_000_000_000 })
  const view = mount(t)
  const activity = { ...RUNNING_T1, startedAt: Date.now() }
  const a: TranscriptItem = { id: 'a', kind: 'tool', text: '', turnId: 't1', toolName: 'Read', pending: false, tool: { displayName: 'Read', useSummary: 'a.ts' } }
  const b = { ...a, id: 'b', pending: true, tool: { ...a.tool!, useSummary: 'b.ts' } }
  const c = { ...b, id: 'c', tool: { ...a.tool!, useSummary: 'c.ts' } }
  view.render(transcript([a, b]), NO_DISCLOSURE, activity)
  const head = runOf(view).children[0]!.node
  t.mock.timers.tick(100)
  view.render(transcript([a, { ...b, pending: false }, c]), NO_DISCLOSURE, activity)
  assert.equal(statusText(runOf(view)).label, '读取 b.ts')
  t.mock.timers.tick(1_900)
  assert.equal(statusText(runOf(view)).label, '读取 c.ts')
  assert.equal(runOf(view).children[0]!.node, head)
  assert.equal(findView(view.column(), 'waiting'), undefined)
})

test('a pending request takes the mark immediately and releases it back to the work', (t) => {
  const view = mount(t)
  const state = transcript(turnItems({ pending: true }))
  const activity = { ...RUNNING_T1, startedAt: Date.now() - 5_000, outputTokens: 1_234 }
  view.render(state, NO_DISCLOSURE, activity)
  const mark = findView(view.column(), 'mark')!.node
  view.render(state, NO_DISCLOSURE, { ...activity, awaitingApproval: true })
  assert.equal(findView(view.column(), 'activity-line'), undefined)
  assert.match(statusText(view.items().at(-1)!).label, /等待你确认/)
  assert.deepEqual(statusText(view.items().at(-1)!).meta, ['5 秒', '·', '1.2k token'], 'user waits keep the clock and count visible')
  assert.equal(findView(view.items().at(-1)!, 'mark')!.node, mark)
  view.stub.click(statusMain(view.items().at(-1)!).node)
  assert.deepEqual(view.focusedRequests, ['permission'])
  view.render(state, NO_DISCLOSURE, { ...activity, asking: '数据库' })
  assert.match(statusText(view.items().at(-1)!).label, /数据库/)
  view.stub.click(statusMain(view.items().at(-1)!).node)
  assert.deepEqual(view.focusedRequests, ['permission', 'ask-user-question'])
  view.render(state, NO_DISCLOSURE, activity)
  assert.equal(findView(view.column(), 'waiting'), undefined)
  assert.equal(findView(runOf(view), 'mark')!.node, mark)
  assert.equal(statusText(runOf(view)).label, '读取 a.ts')
})

test('retry, compaction, failure and a new turn cannot leave a stale tool label', (t) => {
  const view = mount(t)
  const state = transcript(turnItems({ pending: true }))
  view.render(state, NO_DISCLOSURE, RUNNING_T1)
  for (const phase of [{ kind: 'retrying', attempt: 2, reason: 'overload' }, { kind: 'compacting' }] as const) {
    view.render(state, NO_DISCLOSURE, { ...RUNNING_T1, phase })
    assert.equal(findView(runOf(view), 'mark'), undefined)
    assert.match(statusText(view.items().at(-1)!).label, /重试|压缩/)
  }
  view.render(transcript(turnItems().map((item) => item.kind === 'tool' ? { ...item, failed: true } : item)), NO_DISCLOSURE, RUNNING_T1)
  assert.equal(statusText(view.items().at(-1)!).label, '处理中')
  view.render(transcript(turnItems()), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.equal(findView(view.column(), 'waiting'), undefined)
  const next = transcript([...turnItems(), { id: 'u2', kind: 'user', text: 'next', turnId: 't2' }])
  view.render(next, NO_DISCLOSURE, { isStreaming: true, turnId: 't2', startedAt: undefined })
  assert.equal(statusText(view.items().at(-1)!).label, '处理中')
})

test('the mark moves to the jump button and returns to the same work row', (t) => {
  const view = mount(t)
  const state = transcript(pairItems({ pending: true }))
  view.render(state, NO_DISCLOSURE, RUNNING_T1)
  const mark = findView(view.column(), 'mark')!.node
  scrolledUpBy(view.stub, view.container, 400)
  view.stub.dispatch(view.container, 'scroll')
  assert.equal(findView(view.jump(), 'mark')!.node, mark)
  view.stub.click(view.jump().node)
  assert.equal(findView(runOf(view), 'mark')!.node, mark)
  assert.equal(view.jump().hidden, true)
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
  assert.deepEqual(view.toggled, [['th1', false]], 'folded by default, so the click asks to open')

  disclosure.set('th1', true)
  paint()
  view.stub.click(head().node)
  assert.deepEqual(view.toggled, [['th1', false], ['th1', true]], 'opened, so the same node asks to close')
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

// --- the browser family --------------------------------------------------------

function browserCall(overrides: {
  operation?: string
  input?: Record<string, unknown>
  images?: readonly ImageAttachmentRef[]
  content?: string
} = {}): TranscriptItem {
  const operation = overrides.operation ?? 'page.screenshot'
  return {
    id: 'b1',
    kind: 'tool',
    text: 'Browser',
    toolName: 'Browser',
    turnId: 't1',
    tool: {
      displayName: 'Browser',
      useSummary: operation,
      captioned: true,
      browser: { operation, input: overrides.input ?? {} },
      content: overrides.content ?? 'Screenshot of the visible area of tab tab-1.',
      resultSummary: 'Screenshot 1280x800',
      ...(overrides.images === undefined ? {} : { images: overrides.images }),
    },
  }
}

const shotRef: ImageAttachmentRef = {
  id: 'shot-1', ownerSessionId: 'session-1', name: 'screenshot.png', mimeType: 'image/png',
  width: 1280, height: 800, byteLength: 2048,
}

test('a browser row says what it did, and a screenshot keeps a sliver of itself', (t) => {
  const view = mount(t)
  const step = browserCall({ images: [shotRef] })
  view.render(transcript([step]))

  const head = rowOf(view).children[0]
  // Words, chevron, then the sliver pinned to the row's right end.
  assert.deepEqual(head?.children.map((part) => [part.className, part.text]), [
    ['step-label', '截取页面'], ['icon', ''], ['step-right step-shot-thumb', ''],
  ])
  const thumb = head?.children[2]?.children[0]
  assert.equal(thumb?.className, 'step-thumb')
  // The pixels are the pane's to hand over; until they arrive the box is empty
  // and the title says what the picture is.
  assert.equal(thumb?.attributes.has('src'), false)
  assert.equal(thumb?.attributes.get('title'), '截图 1280×800')
  assert.equal(thumb?.attributes.get('alt'), '', 'the row already says it; the sliver is decoration')

  view.thumbs.set('shot-1', 'data:image/png;base64,THUMB')
  view.render(transcript([step]))
  assert.equal(
    rowOf(view).children[0]?.children[2]?.children[0]?.attributes.get('src'),
    'data:image/png;base64,THUMB',
  )
})

test('an opened screenshot is the picture itself, and a press opens the viewer', (t) => {
  const view = mount(t)
  const step = browserCall({ images: [shotRef] })
  view.render(transcript([step]), opened('b1'))

  const row = rowOf(view)
  const body = row.children[1]
  assert.equal(body?.classes.includes('step-body'), true)
  // The caption block is written for the model — coordinates and all — so the
  // body is the frame alone, with no result summary over it.
  assert.deepEqual(body?.children.map((child) => child.className), ['step-shot'])
  const frame = body!.children[0]!
  assert.equal(frame.attributes.get('aria-label'), '查看 截图 screenshot.png，1280×800')

  view.stub.click(frame.node)
  assert.deepEqual(view.viewedImages, [['shot-1', 'screenshot.png']])

  // The screen-sized copy lands later: the same frame repaints onto the bigger
  // pixels rather than keeping the 256px sliver it fell back to.
  const picture = () => rowOf(view).children[1]?.children[0]?.children[0]
  assert.equal(picture()?.attributes.has('src'), false)
  view.views.set('shot-1', 'data:image/png;base64,BIG')
  view.render(transcript([step]), opened('b1'))
  assert.equal(picture()?.attributes.get('src'), 'data:image/png;base64,BIG')
})

test('an action lists its arguments, and the answer written for the model stays out', (t) => {
  const view = mount(t)
  const step = browserCall({ operation: 'page.type', input: { ref: 'e3', text: 'hello' }, content: 'Typed into e3.' })
  view.render(transcript([step]), opened('b1'))

  const row = rowOf(view)
  assert.equal(row.children[0]?.children[0]?.text, '输入文本 e3')
  const body = row.children[1]!
  // The tab dump that answers the model says nothing a reader needs: the row is
  // the operation, and the arguments are what produced it.
  assert.deepEqual(body.children.map((child) => child.className), ['step-params'])
  assert.deepEqual(body.children[0]?.children.map((param) => param.children.map((part) => part.text)), [
    ['目标', 'e3'],
    ['文本', 'hello'],
  ])
})

test('a call with nothing to show offers no body at all', (t) => {
  const view = mount(t)
  const step = browserCall({ operation: 'browser.close_tab', input: { tabId: 'tab-1' }, content: 'Closed tab tab-1.' })
  view.render(transcript([step]))

  const row = rowOf(view)
  // No chevron, nothing to press: an empty body would be a row that opens to a gap.
  assert.deepEqual(row.children[0]?.classes, ['step-head', 'static'])
  assert.equal(row.children.length, 1)
})

test('a batch opens as its steps, one row each, with the picture on the step that took it', (t) => {
  const view = mount(t)
  const step = browserCall({
    operation: 'batch',
    input: {
      steps: [
        { operation: 'tab.wait_for_load', tabId: 'tab-1' },
        { operation: 'tab.emulate', preset: 'desktop' },
        { operation: 'page.screenshot', tabId: 'tab-1' },
      ],
    },
    content: [
      '[1/3] tab.wait_for_load: tabId\turl\ttitle\tflags',
      'tab-1\thttp://127.0.0.1:64318/pelican-bike.html\t海风骑行\t',
      '[2/3] tab.emulate: tab tab-1 now emulates desktop (1280x800 @1x); innerWidth=1280.',
      '[3/3] page.screenshot: Screenshot of the visible area of tab tab-1.',
    ].join('\n'),
    images: [shotRef],
  })
  view.render(transcript([step]), opened('b1'))

  const row = rowOf(view)
  assert.equal(row.children[0]?.children[0]?.text, '执行 3 步浏览器操作')
  const body = row.children[1]!
  // Three operations are three rows; the numbered English answer is gone.
  assert.deepEqual(body.children.map((child) => child.className), ['step-run', 'step-run', 'step-run', 'step-shot'])
  assert.deepEqual(body.children.slice(0, 3).map((run) => run.children.map((part) => part.text)), [
    ['1', '等待加载'],
    ['2', '模拟 desktop'],
    ['3', '截取页面'],
  ])
})

test('a batch that stopped marks the step that failed and the ones it never reached', (t) => {
  const view = mount(t)
  const step = browserCall({
    operation: 'batch',
    input: {
      steps: [
        { operation: 'tab.wait_for_load', tabId: 'tab-1' },
        { operation: 'page.click', ref: 'e9' },
        { operation: 'page.screenshot', tabId: 'tab-1' },
      ],
    },
    content: [
      '[1/3] tab.wait_for_load: tabId\turl\ttitle\tflags',
      '[2/3] page.click failed: No element matches e9.',
      'Stopped; the remaining 1 step was not run.',
    ].join('\n'),
  })
  view.render(transcript([{ ...step, failed: true }]), opened('b1'))

  const body = rowOf(view).children[1]!.children
  const runs = body.filter((child) => child.className.startsWith('step-run'))
  assert.deepEqual(runs.map((run) => run.className), ['step-run', 'step-run failed', 'step-run skipped'])
  // The failed step keeps the tool's reason, and the steps after it were asked
  // for and never ran — said in words, not only in colour.
  assert.equal(body.find((child) => child.className === 'step-output')?.children[0]?.text,
    'No element matches e9.\nStopped; the remaining 1 step was not run.')
  assert.equal(runs.at(-1)?.children.at(-1)?.text, '未执行')
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
  // Its default is taken: the viewer focuses its close button, and the same
  // Enter's keypress would press it and shut the viewer at once.
  assert.equal(stub.dispatch(tiles[0]!.node, 'keydown', { key: 'Enter' }).defaultPrevented, true)
  assert.deepEqual(viewedImages.length, 3)
  // And Space, as every `role="button"` answers, without scrolling the page.
  assert.equal(stub.dispatch(tiles[1]!.node, 'keydown', { key: ' ' }).defaultPrevented, true)
  assert.deepEqual(viewedImages.length, 4)
  assert.equal(stub.dispatch(tiles[1]!.node, 'keydown', { key: 'a' }).defaultPrevented, false)
  assert.deepEqual(viewedImages.length, 4)

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
    onViewImage: () => {}, imageThumbUrl: () => undefined, imageViewUrl: () => undefined, onCopy: async () => true,
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
    onViewImage: () => {}, imageThumbUrl: () => undefined, imageViewUrl: () => undefined, onCopy: async () => true,
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

test('a context failure offers 压缩对话 in place of the provider settings, and a long message unfolds', async (t) => {
  let compacted = 0
  const copied: string[] = []
  const stub = installDomStub()
  const container = stub.createContainer('transcript')
  const host = stub.createContainer('pane')
  const real = createTranscriptView(container, host, {
    onToggle: () => {}, onOpenPlan: () => {}, onOpenSubagent: () => {}, onOpenPath: () => {},
    onViewImage: () => {}, imageThumbUrl: () => undefined, imageViewUrl: () => undefined,
    onCopy: async (text) => { copied.push(text); return true },
    onOpenProviderSettings: () => {},
    onRetryTurn: () => {},
    onCompactConversation: () => { compacted += 1 },
  })
  t.after(() => {
    real.dispose()
    stub.uninstall()
  })
  const detail = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n')
  const find = (cls: string): StubView[] => (function walk(n: StubView): StubView[] {
    return [...(n.classes.includes(cls) ? [n] : []), ...n.children.flatMap(walk)]
  })(stub.inspect(container))
  real.render({
    ...createTranscriptState(),
    items: [{
      id: 'f1', kind: 'turn-failure', text: '对话超出了模型的上下文',
      failure: {
        id: 'f1', kind: 'context', reason: '对话超出了模型的上下文', hint: '压缩。', detail, userMessageId: 'u1', retryable: true,
      },
    }],
  }, NO_DISCLOSURE)

  // Provider settings cannot fix an overflow; compacting can.
  const actions = find('failure-action')
  assert.deepEqual(actions.map((action) => action.text), ['压缩对话', '重试'])
  stub.dispatch(actions[0]!.node, 'click', {})
  assert.equal(compacted, 1)

  const fold = find('failure-fold')[0]!
  assert.equal(fold.attributes.get('aria-expanded'), 'false')
  stub.dispatch(fold.node, 'click', {})
  assert.equal(find('failure-fold')[0]!.attributes.get('aria-expanded'), 'true')
  assert.equal(find('failure-fold')[0]!.text, '收起')
  assert.ok(find('failure-detail')[0]!.classes.includes('open'))

  // The receipt's reset is a timer; held, so it cannot fire after the stub is gone.
  t.mock.timers.enable({ apis: ['setTimeout'] })
  stub.dispatch(find('failure-copy')[0]!.node, 'click', {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(copied, [`对话超出了模型的上下文\n${detail}`])
  assert.equal(find('failure-copy')[0]!.attributes.get('aria-label'), '已复制')
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
    { id: 'd', kind: 'duration', text: '已处理 24 分 0 秒', durationMs: 1_440_000, turnId: 't1' },
  ]
  render(transcript(turn), NO_DISCLOSURE, { ...IDLE_ACTIVITY, outputTokens: 3200, outputTokenTurnId: 't1' })
  assert.deepEqual(items().map((item) => item.classes[1]), ['user', 'assistant'])
  const row = items()[1]!.children.find((child) => child.classes.includes('item-meta'))!
  assert.deepEqual(row.children.map((child) => child.text), ['', '刚刚', '用时 24 分 0 秒', '3.2k token'])
  assert.match(row.children[1]!.attributes.get('title') ?? '', /^\d{4}-\d\d-\d\d \d\d:\d\d$/)

  // No count for a replayed turn, and none while another turn streams.
  render(transcript(turn), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.deepEqual(factsOf(items()[1]!), ['用时 24 分 0 秒'])
  render(transcript(turn), NO_DISCLOSURE, { ...IDLE_ACTIVITY, isStreaming: true, turnId: 't2', startedAt: Date.now(), outputTokens: 90 })
  assert.deepEqual(factsOf(items()[1]!), ['用时 24 分 0 秒'])
  // Output tokens that belong to another (interrupted) turn stay off this footer.
  render(transcript(turn), NO_DISCLOSURE, { ...IDLE_ACTIVITY, outputTokens: 90, outputTokenTurnId: 't2' })
  assert.deepEqual(factsOf(items()[1]!), ['用时 24 分 0 秒'])
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
    { id: 'd', kind: 'duration', text: '已处理 5 秒', durationMs: 5000, turnId: 't1' },
  ]), NO_DISCLOSURE, IDLE_ACTIVITY)
  const assistants = items().filter((item) => item.classes.includes('assistant'))
  assert.deepEqual(assistants.map(meta), [false, true])
})

test('a turn with no answer hangs its footer under its last entry; side views draw none', (t) => {
  const { render, items } = mount(t)
  const turn: TranscriptItem[] = [
    { id: 'u', kind: 'user', text: 'go', turnId: 't1' },
    { id: 'e', kind: 'error', text: 'boom', failed: true, turnId: 't1' },
    { id: 'd', kind: 'duration', text: '已处理 3 秒', durationMs: 3000, turnId: 't1' },
  ]
  render(transcript(turn), NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.deepEqual(items().map((item) => item.classes.join(' ')), ['item user', 'item error failed', 'item-meta turn-foot'])
  assert.deepEqual(factsOf(items()[2]!), ['用时 3 秒'])

  // The subagent panel and the thread detail render without an activity.
  render(transcript(turn))
  assert.deepEqual(items().map((item) => item.classes.join(' ')), ['item user', 'item error failed'])
})

test('status request actions outrank tools and tasks, while the sibling task button stays independent', (t) => {
  const view = mount(t)
  const state = transcript(pairItems({ pending: true }))
  const activity = { ...RUNNING_T1, backgroundTasks: 2 }
  const main = () => statusMain(view.items().at(-1)!)
  view.render(state, NO_DISCLOSURE, { ...activity, awaitingApproval: true })
  const button = main().node
  assert.equal(main().attributes.get('aria-label'), '查看待确认请求')
  view.stub.click(button)
  assert.deepEqual(view.focusedRequests, ['permission'])
  assert.deepEqual(view.toggled, [])
  view.stub.click(view.items().at(-1)!.children[1]!.node)
  assert.equal(view.backgroundOpens(), 1)
  assert.equal(view.focusedRequests.length, 1, 'task clicks never invoke the status action')

  view.render(state, NO_DISCLOSURE, { ...activity, asking: '选一个', awaitingApproval: true })
  view.stub.click(button)
  assert.deepEqual(view.focusedRequests, ['permission', 'ask-user-question'], 'the kept button reads the current context')

  view.render(state, NO_DISCLOSURE, { ...RUNNING_T1, phase: { kind: 'compacting' } })
  assert.equal(main().disabled, true)
  assert.equal(main().attributes.has('aria-label'), false)
  view.render(state, NO_DISCLOSURE, IDLE_ACTIVITY)
  assert.equal(findView(view.column(), 'waiting'), undefined, 'completion has no live status')
})

test('the approval jump uses the current request, restores follow and focuses after scrolling', (t) => {
  const view = mount(t)
  const state = transcript(pairItems({ pending: true }).slice(1))
  const jumpNode = view.jump().node
  view.render(state, NO_DISCLOSURE, RUNNING_T1)
  scrolledUpBy(view.stub, view.container, 400)
  view.stub.dispatch(view.container, 'scroll')
  assert.equal(view.jump().classes.includes('is-working'), true)

  view.render(state, NO_DISCLOSURE, { ...RUNNING_T1, awaitingApproval: true })
  const request = () => view.jump().children.find((child) => child.classes.includes('jump-request'))!
  assert.equal(view.jump().hidden, false)
  assert.equal(view.jump().node, jumpNode)
  assert.equal(view.jump().classes.includes('needs-input'), true)
  assert.equal(view.jump().classes.includes('is-working'), false, 'the accent dot replaces the working mark')
  assert.equal(request().hidden, false)
  assert.equal(request().text, '需要你的确认')
  assert.match(view.jump().attributes.get('aria-label')!, /聚焦请求卡/)

  const scrollTo = view.container.scrollTo.bind(view.container)
  const scroll = t.mock.method(view.container, 'scrollTo', (options: ScrollToOptions) => {
    assert.equal(view.focusedRequests.length, 0, 'scroll precedes request focus')
    scrollTo(options)
  })
  view.stub.click(jumpNode)
  scroll.mock.restore()
  assert.equal(view.container.scrollTop, 1000)
  assert.deepEqual(view.focusedRequests, ['permission'])
  assert.equal(view.jump().hidden, true)
  view.stub.setMetrics(view.container, { scrollHeight: 1400 })
  view.render(state, NO_DISCLOSURE, { ...RUNNING_T1, awaitingApproval: true })
  assert.equal(view.container.scrollTop, 1400, 'approval clicks also restore following')

  scrolledUpBy(view.stub, view.container, 400)
  view.render(state, NO_DISCLOSURE, { ...RUNNING_T1, asking: '选一个', awaitingApproval: true })
  view.stub.click(jumpNode)
  assert.deepEqual(view.focusedRequests, ['permission', 'ask-user-question'])

  scrolledUpBy(view.stub, view.container, 400)
  view.render(state, NO_DISCLOSURE, RUNNING_T1)
  assert.equal(request().hidden, true)
  assert.equal(view.jump().classes.includes('needs-input'), false)
  assert.equal(view.jump().classes.includes('is-working'), true)
  assert.equal(view.jump().attributes.get('aria-label'), '回到最新')
  view.stub.click(jumpNode)
  assert.equal(view.focusedRequests.length, 2, 'settled requests are not focused again')
})

test('the background-task button ends the status line and opens the task list', (t) => {
  const view = mount(t)
  const state = transcript([{ id: 'u1', kind: 'user', text: 'go' }], { turnId: 't1' })
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now() - 5000), backgroundTasks: 2 })

  const row = view.items().at(-1)!
  assert.deepEqual(row.children.map((child) => child.classes.join(' ')), ['waiting-main', 'line-tasks'])
  assert.equal(row.tagName, 'DIV', 'the live region is outside both buttons')
  assert.equal(row.children[0]!.tagName, 'BUTTON')
  const tasks = row.children[1]!
  assert.equal(tasks.text, '2 个后台任务')
  assert.equal(tasks.attributes.get('aria-label'), '2 个后台任务，查看')
  view.stub.click(tasks.node)
  assert.equal(view.backgroundOpens(), 1)

  // A new count refills the button in place; the mark and counter stay mounted.
  const pieces = statusMain(row).children
  view.render(state, NO_DISCLOSURE, { ...waiting(state, Date.now() - 5000), backgroundTasks: 3 })
  const again = view.items().at(-1)!
  assert.equal(again.children[1]!.text, '3 个后台任务')
  assert.equal(again.children[1]!.node, tasks.node)
  for (const index of [0, 1, 2]) assert.equal(statusMain(again).children[index]!.node, pieces[index]!.node)

  // None left: the button goes, the rest of the line stays.
  view.render(state, NO_DISCLOSURE, waiting(state, Date.now() - 5000))
  assert.equal(view.items().at(-1)!.children.length, 1)
})

test('a running tool group leaves the background-task button at the transcript’s tail', (t) => {
  const view = mount(t)
  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 6_000, backgroundTasks: 1 })

  assert.deepEqual(view.items().map((entry) => entry.classes[0]), ['item', 'run', 'waiting'])
  assert.equal(runOf(view).children[0]!.classes.includes('activity-line'), true)
  const row = view.items().at(-1)!
  assert.deepEqual(row.children.map((child) => child.classes[0]), ['line-tasks'])
  assert.equal(row.children[0]!.text, '1 个后台任务')
  view.stub.click(row.children[0]!.node)
  assert.equal(view.backgroundOpens(), 1)

  view.render(transcript(pairItems({ pending: true })), NO_DISCLOSURE, { ...RUNNING_T1, startedAt: Date.now() - 6_000 })
  assert.equal(view.items().some((entry) => entry.classes.includes('waiting')), false)
  assert.equal(runOf(view).children[0]!.classes.includes('activity-line'), true)
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
  assert.deepEqual(view.items().at(-1)!.children.map((child) => child.classes[0]), ['waiting-main', 'line-tasks'])
})
