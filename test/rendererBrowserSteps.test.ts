import test from 'node:test'
import assert from 'node:assert/strict'
import { browserParams, browserRow, browserStepOf, type BrowserStep } from '../src/desktop/renderer/model/browserSteps.js'
import { callParts, type CallStep } from '../src/desktop/renderer/model/toolPhrases.js'

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
  assert.deepEqual(browserRow(step('batch', { steps: [{}, {}, {}] })), { verb: '执行', target: '3 步浏览器操作' })
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