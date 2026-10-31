import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserParams,
  browserRow,
  browserRuns,
  browserStepOf,
  type BrowserStep,
} from '../src/desktop/renderer/model/browserSteps.js'
import { callParts, type CallStep } from '../src/desktop/renderer/model/toolPhrases.js'
import type { ImageAttachmentRef } from '../src/media/types.js'

/**
 * The browser family's words: an operation id is the model's vocabulary, and a
 * row has to say what the call did instead — 「截取页面」, 「打开 example.com」.
 */

function step(operation: string, input: Record<string, unknown> = {}): BrowserStep {
  return { operation, input }
}

test('a browser row names the operation, and the object it acted on', () => {
  assert.deepEqual(browserRow(step('page.screenshot')), { verb: '截取页面', target: '' })
  assert.deepEqual(browserRow(step('page.elements.snapshot')), { verb: '读取页面元素', target: '' })
  assert.deepEqual(browserRow(step('tab.navigate', { url: 'https://example.com/a/b?c=1' })), {
    verb: '打开',
    target: 'example.com',
  })
  // A ref is what the model read, so it is what tells two clicks apart.
  assert.deepEqual(browserRow(step('page.click', { ref: 'e12' })), { verb: '点击', target: 'e12' })
  assert.deepEqual(browserRow(step('page.click', { selector: 'button.submit' })), { verb: '点击', target: 'button.submit' })
  assert.deepEqual(browserRow(step('page.click_at', { x: 300, y: 200 })), { verb: '点击', target: '(300, 200)' })
  assert.deepEqual(browserRow(step('page.type', { ref: 'e3', text: 'hi' })), { verb: '输入文本', target: 'e3' })
  assert.deepEqual(browserRow(step('page.press_key', { keys: ['Control', 'a'] })), { verb: '按下', target: 'Control + a' })
  assert.deepEqual(browserRow(step('page.set_checked', { ref: 'e9', checked: false })), { verb: '取消勾选', target: 'e9' })
  assert.deepEqual(browserRow(step('tab.emulate', { preset: 'iphone' })), { verb: '模拟', target: 'iphone' })
  assert.deepEqual(browserRow(step('tab.emulate', { reset: true })), { verb: '清除设备模拟', target: '' })
  const batch = step('batch', {
    steps: [
      { operation: 'page.screenshot' },
      { operation: 'page.click', ref: 'e1' },
      { operation: 'tab.emulate', preset: 'iphone' },
    ],
  })
  assert.deepEqual(browserRow(batch), { verb: '执行', target: '3 步浏览器操作' })
  // A step that names no operation is not a step: the row counts what will run.
  assert.deepEqual(browserRow(step('batch', { steps: [{}, { operation: 'tab.reload' }] })), {
    verb: '执行',
    target: '1 步浏览器操作',
  })
  // An operation this build does not know still says something rather than nothing.
  assert.deepEqual(browserRow(step('page.something_new')), { verb: 'page.something_new', target: '' })
})

test('a browser call reaches the transcript row through its own words', () => {
  const activity = (input: Record<string, unknown>): CallStep => ({
    kind: 'tool',
    id: 'b1',
    text: 'Browser',
    toolName: 'Browser',
    status: 'done',
    tool: { displayName: 'Browser', useSummary: 'page.screenshot', ...browserStepOf(input) },
  })
  assert.deepEqual(callParts(activity({ operation: 'page.screenshot', tabId: 'tab-1' })), {
    verb: '截取页面',
    target: '',
    bare: false,
  })
  // A record the desktop cannot read the operation of keeps the old shape.
  const older: CallStep = {
    kind: 'tool',
    id: 'b2',
    text: 'Browser',
    toolName: 'Browser',
    status: 'done',
    tool: { displayName: 'Browser', useSummary: 'page.screenshot' },
  }
  assert.deepEqual(callParts(older), { verb: '浏览器', target: 'page.screenshot', bare: false })
})

test('the expanded body lists the arguments that produced the result', () => {
  assert.deepEqual(browserParams(step('tab.navigate', { tabId: 't', url: 'https://example.com/a' })), [
    { label: '网址', value: 'https://example.com/a' },
  ])
  assert.deepEqual(browserParams(step('page.type', { tabId: 't', ref: 'e3', text: 'hello', submit: true })), [
    { label: '目标', value: 'e3' },
    { label: '文本', value: 'hello' },
    { label: '回车提交', value: '是' },
  ])
  assert.deepEqual(browserParams(step('page.scroll', { tabId: 't', direction: 'bottom' })), [
    { label: '方向', value: '到底部' },
  ])
  assert.deepEqual(browserParams(step('page.wait_for', { tabId: 't', selector: '#ready', stableForMs: 500 })), [
    { label: '选择器', value: '#ready' },
    { label: '稳定', value: '500 ms' },
  ])
  // A screenshot's only argument is whether it waited, which the picture answers.
  assert.deepEqual(browserParams(step('page.screenshot', { tabId: 't', settle: true })), [])
})

/** A parameter line is a line: a field typed into must not become a document. */
test('a long typed text is clipped, and an absent one draws no row', () => {
  const long = browserParams(step('page.type', { tabId: 't', text: 'a'.repeat(2000) }))
  assert.equal(long[0]?.value.length, 600)
  assert.equal(long[0]?.value.endsWith('…'), true)
  assert.deepEqual(browserParams(step('page.type', { tabId: 't', text: '' })), [])
})

test('the operation survives a round trip through a record input, and garbage yields none', () => {
  assert.deepEqual(browserStepOf({ operation: 'page.click', ref: 'e1', tabId: 't' }), {
    browser: { operation: 'page.click', input: { ref: 'e1', tabId: 't' } },
  })
  assert.deepEqual(browserStepOf({ operation: '' }), {})
  assert.deepEqual(browserStepOf({ ref: 'e1' }), {})
  assert.deepEqual(browserStepOf('page.click'), {})
  assert.deepEqual(browserStepOf(null), {})
})

/**
 * A run is one step as the window draws it: the operation in words, and only the
 * part of the answer a person is reading that step for.
 */

const shot: ImageAttachmentRef = {
  id: 'shot-1',
  ownerSessionId: 'session-1',
  name: 'screenshot.png',
  mimeType: 'image/png',
  width: 1280,
  height: 800,
  byteLength: 2048,
}

/** What a batch answers with, one numbered line per step. */
function batchAnswer(entries: readonly (readonly [number, string])[]): string {
  return entries.map(([at, line]) => `[${at}/3] ${line}`).join('\n')
}

test('a single call keeps only the answer a person reads', () => {
  // A screenshot's answer is the picture; its caption block is written for the model.
  assert.deepEqual(browserRuns(step('page.screenshot', { tabId: 't' }), [shot], 'Screenshot of tab t.', false), [
    { row: { verb: '截取页面', target: '' }, image: shot },
  ])
  // An action that went through is its row and its arguments — the tab dump is
  // what the model needs, not what the reader does.
  assert.deepEqual(browserRuns(step('page.type', { ref: 'e3', text: 'hi' }), undefined, 'Typed into e3.', false), [
    { row: { verb: '输入文本', target: 'e3' } },
  ])
  // A read's answer is the document the reader came for.
  assert.deepEqual(browserRuns(step('page.text.snapshot', { tabId: 't' }), undefined, '海风骑行', false), [
    { row: { verb: '读取页面文本', target: '' }, text: '海风骑行' },
  ])
  // A failure always says why, in the tool's own words.
  assert.deepEqual(browserRuns(step('page.click', { ref: 'e1' }), undefined, 'No element matches e1.', true), [
    { row: { verb: '点击', target: 'e1' }, text: 'No element matches e1.', failed: true },
  ])
})

/** A page's own console is the only explanation for a click that did nothing. */
test("a page's console errors survive an action, and its tab dump does not", () => {
  const answer = 'tabId\turl\ttitle\tflags\nt\tu\tT\t\n\nConsole errors the page logged:\n- boom (app.js:12)'
  assert.deepEqual(browserRuns(step('page.click', { ref: 'e1' }), undefined, answer, false), [
    { row: { verb: '点击', target: 'e1' }, text: 'Console errors the page logged:\n- boom (app.js:12)' },
  ])
})

test('a batch is its steps, one row each, with the machine answer left out', () => {
  const batch = step('batch', {
    steps: [
      { operation: 'tab.wait_for_load', tabId: 't' },
      { operation: 'tab.emulate', preset: 'desktop' },
      { operation: 'page.screenshot', tabId: 't' },
    ],
  })
  const answer = batchAnswer([
    [1, 'tab.wait_for_load: tabId\turl\ttitle\tflags'],
    [2, 'tab.emulate: tab t now emulates desktop (1280x800 @1x); innerWidth=1280.'],
    [3, 'page.screenshot: Screenshot of the visible area of tab t.'],
  ])
  assert.deepEqual(browserRuns(batch, [shot], answer, false), [
    { index: 1, row: { verb: '等待加载', target: '' } },
    { index: 2, row: { verb: '模拟', target: 'desktop' } },
    // The picture belongs to the step that took it, not to the batch.
    { index: 3, row: { verb: '截取页面', target: '' }, image: shot },
  ])
})

test('a batch that fails names the step it stopped at, and a read inside it keeps its text', () => {
  const batch = step('batch', {
    steps: [
      { operation: 'page.text.snapshot', tabId: 't' },
      { operation: 'page.click', ref: 'e1' },
      { operation: 'page.screenshot', tabId: 't' },
    ],
  })
  const answer = [
    batchAnswer([[1, 'page.text.snapshot: 海风骑行，慢慢骑。']]),
    batchAnswer([[2, 'page.click failed: No element matches e1.']]),
    'Stopped; the remaining 1 step was not run.',
  ].join('\n')
  assert.deepEqual(browserRuns(batch, undefined, answer, true), [
    { index: 1, row: { verb: '读取页面文本', target: '' }, text: '海风骑行，慢慢骑。' },
    {
      index: 2,
      row: { verb: '点击', target: 'e1' },
      text: 'No element matches e1.\nStopped; the remaining 1 step was not run.',
      failed: true,
    },
    // Asked for and never reached: the tool stops at the first step that fails.
    { index: 3, row: { verb: '截取页面', target: '' }, skipped: true },
  ])
})