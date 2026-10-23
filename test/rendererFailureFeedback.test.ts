import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

import { copyText } from '../src/desktop/renderer/dom/clipboard.js'
import { markdownNode } from '../src/desktop/renderer/dom/markdownView.js'
import { createPlanPanelView } from '../src/desktop/renderer/dom/planPanelView.js'
import { showStartupFailure } from '../src/desktop/renderer/dom/startupFailureView.js'
import { installDomStub, type StubView } from './helpers/domStub.js'

/**
 * Actions whose result used to be assumed: a copy button that said 「已复制」
 * whether or not the clipboard took the text, and the startup page that was a
 * line of text with nothing to press. Checked by `tsconfig.domtest.json`.
 */

const REAL_NAVIGATOR = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
test.afterEach(() => {
  if (REAL_NAVIGATOR) Object.defineProperty(globalThis, 'navigator', REAL_NAVIGATOR)
  else delete (globalThis as { navigator?: unknown }).navigator
})

/** Stands in for `navigator.clipboard`; `undefined` is a window with none. Restored after each test. */
function withClipboard(writeText: ((text: string) => Promise<void>) | undefined): string[] {
  const written: string[] = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: writeText === undefined ? {} : { clipboard: { writeText: (text: string) => { written.push(text); return writeText(text) } } },
  })
  return written
}

const descendants = (view: StubView): StubView[] => [view, ...view.children.flatMap(descendants)]
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

test('copyText says whether the text reached the clipboard', async (t) => {
  const written = withClipboard(async () => {})
  assert.equal(await copyText('a'), true)
  assert.deepEqual(written, ['a'])

  withClipboard(async () => { throw new Error('denied') })
  assert.equal(await copyText('a'), false, 'a refused write')

  withClipboard(undefined)
  assert.equal(await copyText('a'), false, 'no clipboard at all')
})

test('the plan\'s 复制 reads 已复制 only when the clipboard took it', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const container = stub.createContainer('plan')
  const view = createPlanPanelView(container)
  view.render({ planContent: '# 计划', planFilePath: '/tmp/plan.md' })
  const label = (): string => descendants(stub.inspect(container)).find((node) => node.classes.includes('plan-panel-copy'))!.text
  const copy = (): unknown => descendants(stub.inspect(container)).find((node) => node.classes.includes('plan-panel-copy'))!.node

  withClipboard(async () => {})
  stub.click(copy())
  await flush()
  assert.equal(label(), '已复制')
  t.mock.timers.tick(1500)
  assert.equal(label(), '复制')

  withClipboard(async () => { throw new Error('denied') })
  stub.click(copy())
  await flush()
  assert.equal(label(), '复制失败', 'a copy that did not happen is not 已复制')
  t.mock.timers.tick(1500)
  assert.equal(label(), '复制')

  withClipboard(undefined)
  stub.click(copy())
  await flush()
  assert.equal(label(), '复制失败', 'no clipboard is a failure too')
})

test('a code block\'s copy button marks a failed copy instead of staying silent', async (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const block = markdownNode('```ts\nlet a = 1\n```')
  // Looked up afresh each time: an inspected view is a snapshot.
  const find = (): StubView => descendants(stub.inspect(block)).find((node) => node.classes.includes('md-code-copy'))!
  const copy = find()

  withClipboard(async () => {})
  stub.click(copy.node)
  await flush()
  assert.equal(find().classes.includes('failed'), false)
  // The receipt is the accessible name too, not only the glyph and the title:
  // a screen reader heard 复制代码 again after a copy that had worked.
  assert.equal(find().attributes.get('aria-label'), '已复制')
  t.mock.timers.tick(1200)
  assert.equal(find().attributes.get('aria-label'), '复制代码')

  withClipboard(async () => { throw new Error('denied') })
  stub.click(copy.node)
  await flush()
  assert.equal(find().classes.includes('failed'), true)
  assert.equal(find().attributes.get('aria-label'), '复制失败')
  t.mock.timers.tick(1200)
  assert.equal(find().classes.includes('failed'), false, 'the mark clears with the receipt')
  assert.equal(find().attributes.get('aria-label'), '复制代码')
})

test('the startup failure page names the failure and 重试 lifts it and asks again', (t) => {
  const stub = installDomStub()
  t.after(() => stub.uninstall())
  const body = stub.createContainer('body')
  let retries = 0
  showStartupFailure(body, 'Connection refused', () => { retries += 1 })

  const page = stub.inspect(body).children[0]!
  assert.equal(page.attributes.get('role'), 'alert')
  const text = descendants(page).map((node) => node.classes.find((cls) => cls.startsWith('startup-failure-')) === undefined ? '' : node.text)
  assert.ok(text.includes('启动失败'))
  assert.ok(text.includes('Connection refused'))

  const retry = descendants(page).find((node) => node.classes.includes('startup-failure-retry'))!
  assert.equal(retry.text, '重试')
  stub.click(retry.node)
  assert.equal(retries, 1)
  assert.equal(stub.inspect(body).children.length, 0, 'the page is gone before the second attempt')
})

test('a pane reports a failed click through the shell, not as a note in the conversation', () => {
  // About twenty failures — a picker that would not open, an image that would
  // not attach, a send the host refused — used to land as error notes in the
  // transcript, where they outlived the moment and sat in a pane that might be
  // behind another screen. They go through `fail()` to the shell's
  // `reportError` path now. The one error note left is a rewind that restored
  // only part of the files: that is part of the session's own history.
  const source = readFileSync(new URL('../src/desktop/renderer/paneSession.ts', import.meta.url), 'utf8')
  const errorNotes = [...source.matchAll(/\bnote\(([^\n]*)\)/g)]
    .map((match) => match[1]!)
    .filter((args) => args.includes("'error'") && !/\w: /.test(args))
  assert.deepEqual(errorNotes, ["text, 'error'", "result.message, result.partial ? 'error' : 'system'"])
  assert.match(source, /onActionError\?: \(text: string\) => void/)
})

test('the transcript is a log that holds its announcement while a turn streams', () => {
  // A plain `aria-live` region re-announced every streamed half-sentence. As a
  // `log` that is `aria-busy` mid-turn, a screen reader reads the settled answer
  // once. Checked in the source because the pane needs a live client to build.
  const source = readFileSync(new URL('../src/desktop/renderer/paneSession.ts', import.meta.url), 'utf8')
  assert.match(source, /transcriptEl\.setAttribute\('role', 'log'\)/)
  assert.match(source, /if \(isStreaming\) transcriptEl\.setAttribute\('aria-busy', 'true'\)\n\s*else transcriptEl\.removeAttribute\('aria-busy'\)/)
})

/**
 * A source check because the IME's event order only exists in a real Chromium:
 * mid-composition the composer holds romanisation, so `@zhong` must not be sent
 * as a file query on the way to `@中`, and the settled text is looked up on
 * `compositionend`, which Chromium fires after the composition's last `input`.
 */
test('the composer looks nothing up while an IME composition is open', () => {
  const app = readFileSync(new URL('../src/desktop/renderer/app.ts', import.meta.url), 'utf8')
  assert.match(app, /addEventListener\('input', \(event\) => \{\n\s+activePane\(\)\?\.onComposerInput\(\(event as InputEvent\)\.isComposing\)/)
  assert.match(app, /addEventListener\('compositionend', \(\) => \{\n\s+activePane\(\)\?\.onComposerInput\(\)/)
  const pane = readFileSync(new URL('../src/desktop/renderer/paneSession.ts', import.meta.url), 'utf8')
  assert.match(pane, /if \(!composing\) refreshCompletions\(\)/)
})

/**
 * A source check, like the IME one above: the tick is a window timer. Without
 * it a 「刚刚」 stayed up for hours whenever nothing else repainted.
 */
test('relative stamps are recomputed on a minute tick, and the tick stops with the page', () => {
  const app = readFileSync(new URL('../src/desktop/renderer/app.ts', import.meta.url), 'utf8')
  assert.match(app, /const timeTicker = setInterval\(\(\) => \{[\s\S]*?activePane\(\)\?\.refreshTimes\(\)[\s\S]*?\}, RELATIVE_TIME_REFRESH_MS\)/)
  assert.match(app, /clearInterval\(timeTicker\)/)
})
