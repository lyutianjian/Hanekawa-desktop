import assert from 'node:assert/strict'
import test from 'node:test'

import { createSheetStore, createWorkingMark, type SpriteSheets } from '../src/desktop/renderer/dom/workingMarkView.js'
import type { ActivityRun, ActivityStep } from '../src/desktop/renderer/model/transcript.js'
import {
  clipOf,
  LOOP_HANDOFF_MS,
  loopHandoff,
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

test('loopHandoff: dedicated bodies wait for the next seam or play out, even with a long remainder', () => {
  const think = SHEETS['think.loop']
  const code = SHEETS['code.loop']
  assert.deepEqual(loopHandoff('think', 'read', 10 * think.speed), { kind: 'seam', delayMs: 54 * think.speed - 10 * think.speed })
  assert.deepEqual(loopHandoff('code', 'read', 19 * code.speed), { kind: 'seam', delayMs: 37 * code.speed - 19 * code.speed })
  assert.equal(loopHandoff('think', 'read', 55 * think.speed), undefined, 'no seam ahead, despite >1.5s left')
  assert.equal(loopHandoff('write', 'read', 0), undefined, 'a body without seams plays its whole loop')
  assert.equal(loopHandoff('think', 'think', 0), undefined, 'the current body needs no handoff')
})

test('loopHandoff: default/blocked bypass seams without an extra hold, using tail only above 1.5s', () => {
  const duration = SHEETS['think.loop'].frames * SHEETS['think.loop'].speed
  for (const target of ['default', 'blocked'] as const) {
    assert.deepEqual(loopHandoff('think', target, 0), { kind: 'tail' })
    assert.deepEqual(loopHandoff('think', target, duration - LOOP_HANDOFF_MS - 1), { kind: 'tail' })
    assert.equal(loopHandoff('think', target, duration - LOOP_HANDOFF_MS), undefined, 'exactly 1.5s plays out')
    assert.equal(loopHandoff('think', target, duration - LOOP_HANDOFF_MS + 1), undefined)
  }
  assert.equal(loopHandoff('default', 'code', 0), undefined, 'default is already shorter than 1.5s')
  assert.equal(loopHandoff('blocked', 'think', 0), undefined, 'blocked plays out its short loop')
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

test('markSpecFor: with nothing running the mark holds the latest call; think only while a thought streams', () => {
  const working = (body: MarkBody) => ({ body, state: 'working' })
  assert.deepEqual(markSpecFor(run(call('Read', 'a', { pending: false }), thinking(true))), working('think'))
  assert.deepEqual(markSpecFor(run(thinking(false))), working('default'))
  assert.deepEqual(markSpecFor(run(thinking(false), call('Read', 'a', { pending: false }))), working('read'))
  assert.deepEqual(markSpecFor(undefined), working('default'))
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
  assert.equal(write('.hanekawa/rules/style.md'), 'write')
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
  return { dom, store, decoded, published, tick: (ms: number) => t.mock.timers.tick(ms) }
}

test('the store decodes once the renderer is idle, the first bodies of a turn first', async (t) => {
  const { store, decoded, published, tick } = storeHarness(t)
  store.prefetch()
  await settle()
  assert.equal(decoded.length, 0, 'nothing before the idle callback')
  assert.equal(published.length, 0, 'and so nothing resident')

  tick(32)
  await settle()
  assert.equal(published.length, 1, 'only the priority batch is published before another idle callback')
  assert.equal(decoded.length, 10, 'grow and the three priority bodies only')
  assert.deepEqual(published[0], { default: true, think: true, blocked: true, search: false, read: false, write: false, compose: false, code: false })
  tick(32)
  await settle()
  assert.equal(published.length, 2)
  assert.ok(Object.values(published[1]!).every(Boolean))
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
  const { dom, store, published, tick } = storeHarness(t, (src) => src.endsWith('/code.out.png'))
  store.prefetch()
  tick(32)
  await settle()
  tick(32)
  await settle()
  assert.equal(published.at(-1)?.code, false)
  assert.equal(published.at(-1)?.read, true)
  assert.equal(store.resident?.has('code.loop'), true)
  ;(dom.documentElement() as { dataset: Record<string, string> }).dataset.reducedMotion = 'true'
  const mark = createWorkingMark(store)
  t.after(() => mark.dispose())
  const host = dom.createContainer('line-mark')
  mark.attach(host, WORKING('code'))
  assert.equal((dom.inspect(host).children[0]!.node as { dataset: Record<string, string> }).dataset.clip, 'default.loop', 'the incomplete body falls back to default')
})

test('a failed default sheet leaves the mark as a dot even when other bodies decode', async (t) => {
  const { dom, store, tick } = storeHarness(t, (src) => src.endsWith('/default.loop.png'))
  const mark = createWorkingMark(store)
  t.after(() => mark.dispose())
  const host = dom.createContainer('line-mark')
  mark.attach(host, WORKING('think'))
  store.prefetch()
  tick(32)
  await settle()
  tick(32)
  await settle()
  assert.equal(store.resident?.ready('think'), true)
  const node = dom.inspect(host).children[0]!
  assert.equal(node.classes.includes('is-dot'), true)
  assert.equal(node.children.length, 0, 'no failed sheet is put on screen')
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
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 })
  const store = createSheetStore()
  const load = async () => {
    store.prefetch()
    t.mock.timers.tick(32)
    await settle()
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

test('a cold mark waits two animation frames after decoding; repainting and moving do not restart the wait', async (t) => {
  const pending = new Map<number, FrameRequestCallback>()
  let sequence = 0
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = (run) => { pending.set(++sequence, run); return sequence }
  globalThis.cancelAnimationFrame = (id) => { pending.delete(id) }
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel })
  const paint = () => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const callback of callbacks) callback(0)
  }
  const h = await markHarness(t, { resident: false })
  h.mark.attach(h.hostA, WORKING('default'))
  await h.load()
  assert.equal(h.current().dot, true, 'decoded sheets do not replace the dot yet')
  assert.equal(pending.size, 1)
  paint()
  assert.equal(h.current().dot, true, 'the first animation frame still shows the dot')
  const node = h.node(h.hostA)!.node
  h.mark.attach(h.hostB, WORKING('think'))
  h.mark.setSpec(WORKING('think'))
  assert.equal(pending.size, 1, 'repaint and migration leave the second frame pending')
  paint()
  assert.equal(h.node(h.hostB)!.node, node)
  assert.deepEqual(h.current(h.hostB), { clip: 'grow', frame: 0, dot: false })
  h.frames(SHEETS.grow.frames)
  assert.equal(h.current(h.hostB).clip, 'think.in', 'the latest activity wins')

  h.mark.end()
  h.mark.attach(h.hostB, WORKING('code'))
  paint()
  h.mark.syncMotion(true)
  assert.equal(pending.size, 0, 'window hiding cancels the pending entry frame')
  h.frames(100)
  assert.equal(h.current(h.hostB).dot, true)
  h.mark.syncMotion(false)
  paint()
  assert.equal(h.current(h.hostB).dot, true)
  paint()
  assert.deepEqual(h.current(h.hostB), { clip: 'grow', frame: 0, dot: false })

  h.mark.end()
  h.mark.attach(h.hostB, WORKING('default'))
  assert.equal(pending.size, 1)
  h.mark.end()
  assert.equal(pending.size, 0, 'ending cancels entry as well as playback')
  h.mark.attach(h.hostB, WORKING('default'))
  h.mark.dispose()
  assert.equal(pending.size, 0, 'disposing leaves no entry callback')
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

test('a dedicated body without seams plays out its loop before switching', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'write')
  h.frames(2)
  h.mark.setSpec(WORKING('read'))
  assert.deepEqual(h.current(), { clip: 'write.loop', frame: 2, dot: false })
  h.frames(SHEETS['write.loop'].frames - 3)
  assert.equal(h.current().clip, 'write.loop', 'no early tail or extra 2s hold')
  h.frames(1)
  assert.equal(h.current().clip, 'write.out')
})

test('a dedicated body past its last seam plays out a long remainder', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  h.frames(55)
  h.mark.setSpec(WORKING('read'))
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: 55, dot: false })
  h.frames(SHEETS['think.loop'].frames - 55)
  assert.equal(h.current().clip, 'think.out')
})

test('default/blocked handoffs bypass a pending seam and play the last 20 frames immediately', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  h.frames(2)
  h.mark.setSpec(WORKING('read'))
  h.mark.setSpec({ body: 'write', state: 'blocked' })
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: SHEETS['think.loop'].frames - 20, dot: false })
  h.frames(20)
  assert.equal(h.current().clip, 'think.out')
  h.frames(SHEETS['think.out'].frames)
  assert.equal(h.current().clip, 'blocked.in')
  h.mark.end()
  toLoop(h, 'think')
  h.mark.setSpec(WORKING('default'))
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: SHEETS['think.loop'].frames - 20, dot: false })
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

test('blocked round trips play each required out/in once, even when the activity changes while blocked', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  const node = h.node(h.hostA)!.node
  h.frames(2)
  h.mark.setSpec({ body: 'write', state: 'blocked' })
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: SHEETS['think.loop'].frames - 20, dot: false })
  h.frames(20)
  assert.equal(h.current().clip, 'think.out')
  h.frames(SHEETS['think.out'].frames)
  assert.equal(h.current().clip, 'blocked.in')
  h.frames(SHEETS['blocked.in'].frames)
  assert.deepEqual(h.current(), { clip: 'blocked.loop', frame: 0, dot: false })

  h.frames(5)
  h.mark.setSpec({ body: 'read', state: 'blocked' })
  h.mark.attach(h.hostA, { body: 'code', state: 'blocked' })
  assert.deepEqual(h.current(), { clip: 'blocked.loop', frame: 5, dot: false }, 'activity updates do not re-enter blocked')
  h.mark.setSpec(WORKING('code'))
  assert.deepEqual(h.current(), { clip: 'blocked.loop', frame: 5, dot: false }, 'the short blocked loop plays out')
  h.frames(SHEETS['blocked.loop'].frames - 5)
  assert.equal(h.current().clip, 'blocked.out')
  h.frames(SHEETS['blocked.out'].frames)
  assert.equal(h.current().clip, 'code.in')
  h.frames(SHEETS['code.in'].frames)
  assert.deepEqual(h.current(), { clip: 'code.loop', frame: 0, dot: false })
  assert.equal(h.node(h.hostA)!.node, node, 'approval never resets the mark or replays grow')
})

test('an approval withdrawn during the tail returns to working without entering blocked', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  h.mark.setSpec({ body: 'think', state: 'blocked' })
  h.frames(5)
  h.mark.setSpec(WORKING('think'))
  h.frames(15)
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: 0, dot: false }, 'no stale blocked target or redundant out/in')
  h.frames(55)
  assert.deepEqual(h.current(), { clip: 'think.loop', frame: 55, dot: false }, 'no old seam timer can interrupt the resumed loop')
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

test('a hide of up to 500ms resumes the held loop on the same node and re-arms its seam', async (t) => {
  const h = await markHarness(t)
  toLoop(h, 'think')
  h.frames(10)
  h.mark.setSpec(WORKING('code'))
  const before = h.current()
  const moved = h.node(h.hostA)!.node
  h.mark.hide()
  t.mock.timers.tick(250)
  h.mark.hide()
  h.mark.setSpec(WORKING('read'))
  h.mark.syncMotion(false)
  t.mock.timers.tick(250)
  assert.deepEqual(h.current(), before, 'hidden marks stay held; repeated hide does not restart the grace period')

  h.mark.attach(h.hostB, WORKING('read'))
  assert.equal(h.node(h.hostA), undefined)
  assert.equal(h.node(h.hostB)!.node, moved)
  assert.deepEqual(h.current(h.hostB), before, 'exactly 500ms still resumes')
  h.frames(43)
  assert.deepEqual(h.current(h.hostB), { clip: 'think.loop', frame: 53, dot: false })
  h.frames(1)
  assert.equal(h.current(h.hostB).clip, 'think.out')
  h.frames(SHEETS['think.out'].frames)
  assert.equal(h.current(h.hostB).clip, 'read.in', 'the target received while hidden wins')
})

test('after 500ms hidden mid-turn it comes back with `in`; end immediately resets to grow', async (t) => {
  const { mark, hostA, current, frames } = await markHarness(t)
  mark.attach(hostA, WORKING('default'))
  frames(3)
  mark.hide()
  t.mock.timers.tick(501)
  mark.hide()
  mark.attach(hostA, WORKING('code'))
  assert.deepEqual(current(), { clip: 'code.in', frame: 0, dot: false })
  mark.end()
  mark.attach(hostA, WORKING('code'))
  assert.deepEqual(current(), { clip: 'grow', frame: 0, dot: false })
})

test('hide/end cancel a pending seam before another body starts', async (t) => {
  const h = await markHarness(t)
  for (const leave of [() => h.mark.hide(), () => h.mark.end()]) {
    h.mark.end()
    toLoop(h, 'think')
    h.mark.setSpec(WORKING('code'))
    const before = h.current()
    leave()
    h.frames(60)
    assert.deepEqual(h.current(), before, 'the pending seam cannot run while hidden')
    h.mark.attach(h.hostA, WORKING('read'))
    h.frames(55)
    assert.equal(h.current().clip, 'read.loop', 'the old thinking seam cannot take over')
  }
})

test('reduced motion holds the wanted body\'s rest frame and follows the spec', async (t) => {
  const { dom, mark, hostA, current, frames } = await markHarness(t)
  const previousRaf = globalThis.requestAnimationFrame
  const previousCancel = globalThis.cancelAnimationFrame
  globalThis.requestAnimationFrame = () => assert.fail('reduced motion must not wait for entry frames')
  globalThis.cancelAnimationFrame = () => assert.fail('no entry frame was scheduled')
  t.after(() => { globalThis.requestAnimationFrame = previousRaf; globalThis.cancelAnimationFrame = previousCancel })
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
  h.dom.setHidden(true)
  h.mark.syncMotion(true)
  h.mark.setSpec(WORKING('think'))
  h.frames(200)
  assert.deepEqual(h.current(), { clip: 'default.loop', frame: 7, dot: false })
  h.dom.setHidden(false)
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

test('WAAPI holds frames across pauses and schedules seams from the precise animation time', async (t) => {
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

  const finish = async () => { animations.at(-1)!.finish(); await settle() }
  h.mark.setSpec(WORKING('think'))
  await finish()
  assert.equal(h.current().clip, 'default.out')
  await finish()
  await finish()
  assert.equal(h.current().clip, 'think.loop')
  const loop = animations.at(-1)!
  loop.currentTime = FRAME * 10.5
  h.mark.setSpec(WORKING('read'))
  const delay = FRAME * 54 - loop.currentTime
  t.mock.timers.tick(delay - 1)
  assert.equal(h.current().clip, 'think.loop')
  t.mock.timers.tick(1)
  assert.equal(h.current().clip, 'think.out', 'no half-frame delay from rounding the animation time')
  assert.equal(loop.cancelled, true)

  const out = animations.at(-1)!
  out.currentTime = FRAME * 5.5
  const moved = h.node(h.hostA)!.node
  h.mark.hide()
  assert.equal(out.cancelled, true)
  assert.deepEqual(h.current(), { clip: 'think.out', frame: 5, dot: false })
  t.mock.timers.tick(500)
  h.mark.attach(h.hostB, WORKING('code'))
  const continued = animations.at(-1)!
  assert.equal(h.node(h.hostB)!.node, moved)
  assert.deepEqual(h.current(h.hostB), { clip: 'think.out', frame: 5, dot: false })
  assert.equal(continued.keyframes.length, SHEETS['think.out'].frames - 5)
  assert.equal(continued.keyframes[0]!.transform, `translateY(${(-100 * 5) / SHEETS['think.out'].frames}%)`)
  out.finish()
  await settle()
  assert.equal(animations.at(-1), continued, 'the cancelled animation cannot advance the resumed stage')
  await finish()
  assert.equal(h.current(h.hostB).clip, 'code.in')
})
