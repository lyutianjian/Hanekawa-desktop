import assert from 'node:assert/strict'
import test from 'node:test'

import { createSheetStore, createWorkingMark, type SpriteSheets } from '../src/desktop/renderer/dom/workingMarkView.js'
import type { ActivityRun, ActivityStep } from '../src/desktop/renderer/model/transcript.js'
import {
  clipOf,
  MARK_BODIES,
  markSpecFor,
  nextStage,
  restStage,
  SHEETS,
  wantBody,
  type MarkBody,
} from '../src/desktop/renderer/model/workingMark.js'
import { installDomStub } from './helpers/domStub.js'

/**
 * The working mark: the stage machine, the still frame and which body an
 * activity shows (`model/workingMark.ts`), and the sheets and controller that
 * play it (`dom/workingMarkView.ts`).
 */

interface CallExtra {
  pending?: boolean
  awaitingApproval?: boolean
  useSummary?: string
  description?: string
}

function call(toolName: string, id = toolName, extra: CallExtra = {}): ActivityStep {
  return {
    kind: 'tool',
    id,
    text: toolName,
    toolName,
    pending: extra.pending ?? true,
    status: 'running',
    tool: {
      displayName: toolName,
      useSummary: extra.useSummary ?? '',
      ...(extra.awaitingApproval ? { awaitingApproval: true } : {}),
      ...(extra.description ? { description: extra.description } : {}),
    },
  } as ActivityStep
}

const thinking = (pending: boolean): ActivityStep => ({ kind: 'thinking', id: 'th', text: '想想', pending })

function run(...steps: ActivityStep[]): ActivityRun {
  return { id: 'run:1', turnId: 't1', steps, status: 'running', failedCount: 0 }
}

test('every body has in, loop and out sheets; seams and rest frames sit inside their loop', () => {
  for (const body of MARK_BODIES) {
    for (const kind of ['in', 'loop', 'out'] as const) assert.ok(SHEETS[`${body}.${kind}`], `${body}.${kind}`)
    const loop = SHEETS[`${body}.loop`]
    for (const frame of [loop.rest ?? 0, ...(loop.seams ?? [])]) assert.ok(frame >= 0 && frame < loop.frames)
  }
})

test('clipOf: grow is its own sheet, tail plays the loop sheet', () => {
  assert.equal(clipOf({ kind: 'grow' }), 'grow')
  assert.equal(clipOf({ kind: 'in', body: 'read' }), 'read.in')
  assert.equal(clipOf({ kind: 'tail', body: 'code' }), 'code.loop')
  assert.equal(clipOf({ kind: 'out', body: 'think' }), 'think.out')
})

test('nextStage: grow → in → loop ⇄ out → in, never a hard cut', () => {
  assert.deepEqual(nextStage({ kind: 'grow' }, 'think'), { kind: 'in', body: 'think' })
  assert.deepEqual(nextStage({ kind: 'in', body: 'think' }, 'think'), { kind: 'loop', body: 'think' })
  assert.deepEqual(nextStage({ kind: 'loop', body: 'think' }, 'think'), { kind: 'loop', body: 'think' })
  assert.deepEqual(nextStage({ kind: 'loop', body: 'think' }, 'read'), { kind: 'out', body: 'think' })
  assert.deepEqual(nextStage({ kind: 'tail', body: 'think' }, 'read'), { kind: 'out', body: 'think' })
  // The activity came back while the tail played: stay.
  assert.deepEqual(nextStage({ kind: 'tail', body: 'think' }, 'think'), { kind: 'loop', body: 'think' })
  assert.deepEqual(nextStage({ kind: 'out', body: 'think' }, 'read'), { kind: 'in', body: 'read' })
  // The original jumped to the new body's first `in` frame here.
  assert.deepEqual(nextStage({ kind: 'in', body: 'think' }, 'read'), { kind: 'out', body: 'think' })
})

test('wantBody: blocked outranks the activity; an undecoded body falls back to default', () => {
  assert.equal(wantBody({ body: 'read', state: 'working' }), 'read')
  assert.equal(wantBody({ body: 'read', state: 'blocked' }), 'blocked')
  const decoded = new Set<MarkBody>(['default', 'think', 'blocked'])
  const ready = (body: MarkBody) => decoded.has(body)
  assert.equal(wantBody({ body: 'think', state: 'working' }, ready), 'think')
  assert.equal(wantBody({ body: 'code', state: 'working' }, ready), 'default')
  assert.equal(wantBody({ body: 'code', state: 'blocked' }, ready), 'blocked')
})

test('restStage: the wanted body\'s loop at its rest frame', () => {
  assert.deepEqual(restStage('think'), { stage: { kind: 'loop', body: 'think' }, frame: 95 })
  assert.deepEqual(restStage('blocked'), { stage: { kind: 'loop', body: 'blocked' }, frame: 0 })
})

test('markSpecFor maps each running tool to its body', () => {
  const table: Record<string, MarkBody> = {
    WebFetch: 'search', WebSearch: 'search', Browser: 'search',
    Read: 'read', Grep: 'read', Glob: 'read', BashOutput: 'read',
    Edit: 'write', MultiEdit: 'write', NotebookEdit: 'write', Write: 'write', Delete: 'write',
    TodoWrite: 'write', TaskCreate: 'write', TaskGet: 'write', TaskList: 'write', TaskUpdate: 'write',
    Config: 'write', EnterPlanMode: 'write', ExitPlanMode: 'write',
    Bash: 'code', KillShell: 'code',
    Agent: 'default', Skill: 'default', AskUserQuestion: 'default', mcp__x__y: 'default',
    // Unknown names read by their words.
    SendMessage: 'write', ToolSearch: 'read', mcp__github__create_issue: 'write', mcp__db__runQuery: 'code', mcp__search__list_items: 'read',
  }
  for (const [tool, body] of Object.entries(table)) {
    assert.deepEqual(markSpecFor(run(call(tool))), { body, state: 'working' }, tool)
  }
})

test('markSpecFor: the last running call decides; a settled one does not count', () => {
  assert.deepEqual(markSpecFor(run(call('Read', 'a'), call('Bash', 'b'))), { body: 'code', state: 'working' })
  assert.deepEqual(markSpecFor(run(call('Read', 'a'), call('Bash', 'b', { pending: false }))), { body: 'read', state: 'working' })
})

test('markSpecFor: a call awaiting approval outranks later calls and blocks the mark', () => {
  const spec = markSpecFor(run(call('Edit', 'a', { awaitingApproval: true }), call('Read', 'b')))
  assert.deepEqual(spec, { body: 'write', state: 'blocked' })
})

test('markSpecFor: with nothing running the mark holds the latest step, and starts at think', () => {
  const working = (body: MarkBody) => ({ body, state: 'working' })
  assert.deepEqual(markSpecFor(run(call('Read', 'a', { pending: false }), thinking(true))), working('think'))
  assert.deepEqual(markSpecFor(run(thinking(false))), working('think'))
  assert.deepEqual(markSpecFor(run(thinking(false), call('Read', 'a', { pending: false }))), working('read'))
  assert.deepEqual(markSpecFor(undefined), working('think'))
})

test('markSpecFor: Bash reads its description\'s verb', () => {
  const bash = (description: string) => markSpecFor(run(call('Bash', 'b', { description }))).body
  assert.equal(bash('List files in the repo'), 'read')
  assert.equal(bash('Finding the config'), 'read')
  assert.equal(bash('Creates the build dir'), 'write')
  assert.equal(bash('Run the tests'), 'code')
  assert.equal(bash('跑测试'), 'code')
})

test('markSpecFor: a running write to a document composes; settled, it writes', () => {
  const write = (useSummary: string, pending = true) =>
    markSpecFor(run(call('Write', 'w', { useSummary, pending }))).body
  assert.equal(write('docs/guide.md'), 'compose')
  assert.equal(write('notes.TXT'), 'compose')
  assert.equal(write('src/a.ts'), 'write')
  assert.equal(write('AGENTS.md'), 'write')
  assert.equal(write('pkg/CLAUDE.local.md'), 'write')
  assert.equal(write('.myagent/rules/style.md'), 'write')
  assert.equal(write('docs/guide.md', false), 'write')
})

test('markSpecFor: the call whose arguments are streaming shows before its record', () => {
  const draft = (name: string, input: string) => markSpecFor(run(thinking(false)), { name, input }).body
  assert.equal(draft('Write', '{"filePath":"README.md","content":"# Hi'), 'compose')
  assert.equal(draft('Write', '{"file_path":"src/a.ts"'), 'write')
  assert.equal(draft('Write', '{"filePath":"READ'), 'write')
  assert.equal(draft('Bash', '{"command":"ls","description":"List files"}'), 'read')
  assert.equal(draft('Grep', '{"pat'), 'read')
  // A recorded running call still outranks it.
  assert.equal(markSpecFor(run(call('Bash')), { name: 'Read', input: '' }).body, 'code')
})

// ---- Sheet store -------------------------------------------------------------

const settle = () => new Promise((resolve) => setImmediate(resolve))

function storeHarness(t: import('node:test').TestContext, broken: (src: string) => boolean = () => false) {
  const dom = installDomStub()
  t.after(() => dom.uninstall())
  const decoded: string[] = []
  dom.breakImages((src) => { decoded.push(src); return broken(src) })
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = createSheetStore()
  const published: Array<Record<MarkBody, boolean>> = []
  const snapshot = (sheets: SpriteSheets) =>
    Object.fromEntries(MARK_BODIES.map((body) => [body, sheets.ready(body)])) as Record<MarkBody, boolean>
  store.subscribe((sheets) => published.push(snapshot(sheets)))
  return { store, decoded, published, tick: (ms: number) => t.mock.timers.tick(ms) }
}

test('the store decodes once the renderer is idle, the first bodies of a turn first', async (t) => {
  const { store, decoded, published, tick } = storeHarness(t)
  store.prefetch()
  await settle()
  assert.equal(decoded.length, 0, 'nothing before the idle callback')
  assert.equal(published.length, 0, 'and so nothing resident')

  tick(32)
  await settle()
  assert.equal(published.length, 2)
  const [first, second] = published
  assert.deepEqual(first, { default: true, think: true, blocked: true, search: false, read: false, write: false, compose: false, code: false })
  assert.ok(Object.values(second!).every(Boolean))
  assert.ok(store.resident?.has('grow'))
  assert.equal(store.resident?.url('code.loop'), 'sprites/code.loop.png')
  assert.equal(decoded.length, Object.keys(SHEETS).length)
})

test('prefetch starts one load however often it is called', async (t) => {
  const { store, decoded, tick } = storeHarness(t)
  store.prefetch()
  store.prefetch()
  tick(32)
  await settle()
  store.prefetch()
  tick(32)
  await settle()
  assert.equal(decoded.length, Object.keys(SHEETS).length)
})

test('a sheet that fails to decode leaves only its body unready, silently', async (t) => {
  const { store, published, tick } = storeHarness(t, (src) => src.endsWith('/code.out.png'))
  store.prefetch()
  tick(32)
  await settle()
  assert.equal(published.at(-1)?.code, false)
  assert.equal(published.at(-1)?.read, true)
  assert.equal(store.resident?.has('code.loop'), true)
})

test('a late subscriber hears the resident sheets at once; an unsubscribed one hears nothing', async (t) => {
  const { store, tick } = storeHarness(t)
  store.prefetch()
  let calls = 0
  const off = store.subscribe(() => { calls += 1 })
  off()
  tick(32)
  await settle()
  assert.equal(calls, 0)
  store.subscribe(() => { calls += 1 })
  assert.equal(calls, 1)
})

// ---- Controller --------------------------------------------------------------

const FRAME = 33.3333

/**
 * A controller on a resident store, on the stub's timer path (it has no
 * `Element.animate`) unless a test installs one. Every frame is a mock-timer tick.
 */
async function markHarness(t: import('node:test').TestContext, options: { resident?: boolean } = {}) {
  const dom = installDomStub()
  t.after(() => dom.uninstall())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const store = createSheetStore()
  const load = async () => {
    store.prefetch()
    t.mock.timers.tick(32)
    await settle()
  }
  if (options.resident !== false) await load()
  const mark = createWorkingMark(store)
  t.after(() => mark.dispose())
  const hostA = dom.createContainer('line-mark')
  const hostB = dom.createContainer('line-mark')
  const node = (host: HTMLElement) => dom.inspect(host).children[0]
  const current = (host = hostA) => {
    const view = node(host)!
    const layer = view.children.find((child) => !child.classes.includes('is-warm'))
    return {
      clip: (view.node as { dataset: Record<string, string> }).dataset.clip,
      frame: Number(layer?.children[0]?.styleProperties.get('--mark-frame')),
      dot: view.classes.includes('is-dot'),
    }
  }
  const frames = (n: number) => { for (let i = 0; i < n; i++) t.mock.timers.tick(FRAME + 0.0001) }
  return { dom, store, mark, hostA, hostB, node, current, frames, load }
}

const WORKING = (body: MarkBody) => ({ body, state: 'working' as const })

test('a mark attached before the sheets decode is a dot, then grows in', async (t) => {
  const { mark, hostA, current, frames, load } = await markHarness(t, { resident: false })
  mark.attach(hostA, WORKING('think'))
  assert.equal(current().dot, true)
  await load()
  assert.deepEqual(current(), { clip: 'grow', frame: 0, dot: false })
  frames(SHEETS.grow.frames)
  assert.equal(current().clip, 'think.in')
  frames(SHEETS['think.in'].frames)
  assert.deepEqual(current(), { clip: 'think.loop', frame: 0, dot: false })
})

test('repeating the same spec every paint changes nothing', async (t) => {
  const { mark, hostA, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('default'))
  frames(5)
  const before = current()
  mark.attach(hostA, WORKING('default'))
  mark.setSpec(WORKING('default'))
  assert.deepEqual(current(), before)
  frames(1)
  assert.equal(current().frame, before.frame + 1)
})

/** Brings the mark to `body.loop` frame 0. */
function toLoop(h: Awaited<ReturnType<typeof markHarness>>, body: MarkBody) {
  h.mark.attach(h.hostA, WORKING(body))
  h.frames(SHEETS.grow.frames + SHEETS[`${body}.in`].frames)
  assert.deepEqual(h.current(), { clip: `${body}.loop`, frame: 0, dot: false })
}

test('mid-loop the switch waits for the next seam, and only one switch is ever pending', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  h.frames(10)
  h.mark.setSpec(WORKING('read'))
  h.mark.setSpec(WORKING('code'))
  h.frames(43)
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: 53, dot: false }, 'no cut before the seam')
  h.frames(1)
  assert.deepEqual(h.current(), { clip: 'think.out', frame: 0, dot: false })
  h.frames(SHEETS['think.out'].frames)
  assert.equal(h.current().clip, 'code.in', 'the last target wins')
})

test('a switch changed back before its seam is called off', async (t) => {
  const back = await markHarness(t)
  toLoop(back, 'think')
  back.mark.setSpec(WORKING('read'))
  back.mark.setSpec(WORKING('think'))
  back.frames(SHEETS['think.loop'].frames + 5)
  assert.equal(back.current().clip, 'think.loop')
  assert.equal(back.current().frame, 5, 'the loop simply played on')
})

test('a long loop with no seam ahead leaves through its tail', async (t) => {
  const long = await markHarness(t)
  toLoop(long, 'write')
  long.frames(2)
  long.mark.setSpec(WORKING('read'))
  assert.deepEqual(long.current(), { clip: 'write.loop', frame: SHEETS['write.loop'].frames - 20, dot: false })
  long.frames(20)
  assert.equal(long.current().clip, 'write.out')
})

test('a short loop with no seam ahead plays out first', async (t) => {
  const short = await markHarness(t)
  toLoop(short, 'default')
  short.frames(2)
  short.mark.setSpec(WORKING('read'))
  assert.deepEqual(short.current(), { clip: 'default.loop', frame: 2, dot: false })
  short.frames(SHEETS['default.loop'].frames - 2)
  assert.equal(short.current().clip, 'default.out')
})

test('a target that changes during `in` goes out after it, not to the new body\'s first frame', async (t) => {
  const { mark, hostA, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('read'))
  frames(SHEETS.grow.frames + 3)
  mark.setSpec(WORKING('code'))
  assert.deepEqual(current(), { clip: 'read.in', frame: 3, dot: false })
  frames(SHEETS['read.in'].frames - 3)
  assert.equal(current().clip, 'read.out')
  frames(SHEETS['read.out'].frames)
  assert.equal(current().clip, 'code.in')
})

test('blocked outranks the activity', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'default')
  h.mark.setSpec({ body: 'write', state: 'blocked' })
  h.frames(SHEETS['default.loop'].frames + SHEETS['default.out'].frames)
  assert.equal(h.current().clip, 'blocked.in')
})

test('moving to another carrier keeps the same node and the frame it was on', async (t) => {
  const { mark, hostA, hostB, node, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('default'))
  frames(4)
  const moved = node(hostA)!.node
  mark.attach(hostB, WORKING('default'))
  assert.equal(node(hostA), undefined)
  assert.equal(node(hostB)!.node, moved)
  assert.deepEqual(current(hostB), { clip: 'grow', frame: 4, dot: false })
})

test('hidden mid-turn it comes back with `in`; after the turn it grows again', async (t) => {
  const { mark, hostA, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('default'))
  frames(3)
  mark.hide()
  frames(100)
  mark.attach(hostA, WORKING('code'))
  assert.deepEqual(current(), { clip: 'code.in', frame: 0, dot: false })
  mark.end()
  mark.attach(hostA, WORKING('code'))
  assert.deepEqual(current(), { clip: 'grow', frame: 0, dot: false })
})

test('reduced motion holds the wanted body\'s rest frame and follows the spec', async (t) => {
  const { dom, mark, hostA, current, frames } = await markHarness(t)
  ;(dom.documentElement() as { dataset: Record<string, string> }).dataset.reducedMotion = 'true'
  mark.attach(hostA, WORKING('think'))
  assert.deepEqual(current(), { clip: 'think.loop', frame: SHEETS['think.loop'].rest, dot: false })
  frames(50)
  assert.equal(current().frame, SHEETS['think.loop'].rest, 'still')
  mark.setSpec(WORKING('code'))
  assert.deepEqual(current(), { clip: 'code.loop', frame: SHEETS['code.loop'].rest, dot: false })

  ;(dom.documentElement() as { dataset: Record<string, string> }).dataset.reducedMotion = 'false'
  mark.syncMotion(false)
  frames(1)
  assert.deepEqual(current(), { clip: 'code.loop', frame: 0, dot: false }, 'it plays on from the rest frame, the loop\'s last')
})

test('a paused mark runs no timers and resumes on the frame it stopped at, with what changed meanwhile', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'default')
  h.frames(7)
  h.mark.syncMotion(true)
  h.mark.setSpec(WORKING('think'))
  h.frames(200)
  assert.deepEqual(h.current(), { clip: 'default.loop', frame: 7, dot: false })
  h.mark.syncMotion(false)
  h.frames(1)
  assert.deepEqual(h.current(), { clip: 'default.loop', frame: 8, dot: false })
  h.frames(SHEETS['default.loop'].frames - 8)
  assert.equal(h.current().clip, 'default.out')
})

test('dispose leaves no timer and no node behind', async (t) => {
  const { mark, hostA, node, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('default'))
  frames(2)
  const last = current()
  mark.dispose()
  assert.equal(node(hostA), undefined)
  frames(100)
  assert.deepEqual(last, { clip: 'grow', frame: 2, dot: false })
})

test('with WAAPI each stage is one stepped animation that holds its last frame; a pause keeps its frame', async (t) => {
  const h = await markHarness(t)
  interface FakeAnimation {
    readonly keyframes: Keyframe[]
    readonly options: KeyframeAnimationOptions
    readonly finished: Promise<void>
    finish(): void
    currentTime: number
    cancelled: boolean
    cancel(): void
  }
  const animations: FakeAnimation[] = []
  const prototype = (globalThis as unknown as { Element: { prototype: object } }).Element.prototype
  Reflect.set(prototype, 'animate', (keyframes: Keyframe[], options: KeyframeAnimationOptions) => {
    let finish!: () => void
    const finished = new Promise<void>((resolve) => { finish = resolve })
    const animation: FakeAnimation = {
      keyframes, options, finished, finish, currentTime: 0, cancelled: false,
      cancel() { this.cancelled = true },
    }
    animations.push(animation)
    return animation
  })
  t.after(() => Reflect.deleteProperty(prototype, 'animate'))

  h.mark.attach(h.hostA, WORKING('default'))
  const grow = animations[0]!
  assert.equal(grow.keyframes.length, SHEETS.grow.frames)
  assert.deepEqual(grow.options, { duration: FRAME * SHEETS.grow.frames, easing: `steps(${SHEETS.grow.frames}, jump-none)`, fill: 'forwards' })
  assert.equal(grow.keyframes[1]!.transform, `translateY(${-100 / SHEETS.grow.frames}%)`)
  grow.finish()
  await settle()
  assert.equal(h.current().clip, 'default.in')

  const enter = animations[1]!
  enter.currentTime = FRAME * 5.5
  h.mark.syncMotion(true)
  assert.equal(enter.cancelled, true)
  assert.deepEqual(h.current(), { clip: 'default.in', frame: 5, dot: false })
  h.mark.syncMotion(false)
  const resumed = animations[2]!
  assert.equal(resumed.keyframes.length, SHEETS['default.in'].frames - 5)
  assert.equal(resumed.keyframes[0]!.transform, `translateY(${(-100 * 5) / SHEETS['default.in'].frames}%)`)
  // A cancelled animation's settling never advances the stage.
  enter.finish()
  await settle()
  assert.equal(animations.length, 3)
})
