import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolContext } from '../src/harness/types.js'
import type { ComputerHost, ComputerRequest, ComputerResponse } from '../src/runtime/protocol/computerHost.js'
import { createComputerTool } from '../src/tools/ComputerTool/ComputerTool.js'
import { computerApiInputSchema } from '../src/tools/ComputerTool/schema.js'
import { assertNoImageBytes, makeImageAttachmentRef } from './helpers/imageFixtures.js'
const appId = 'app-11111111-1111-4111-8111-111111111111'
const snapshotId = 's11111111-1111-4111-8111-111111111111'
const ref = `${snapshotId}:e1`
function fixture(response: ComputerResponse = { envelope: { ok: true, data: { complete: false } } }) {
  const calls: ComputerRequest[] = []
  const host: ComputerHost = { run: async request => { calls.push(request); return response } }
  const context: ToolContext = { cwd: '/scratch', sessionId: 'chat-1', readFiles: new Set() }
  return { tool: createComputerTool(host), calls, context }
}
test('Computer passes structured input and caller identity; summaries omit typed content', async () => {
  const { tool, calls, context } = fixture()
  context.abortSignal = new AbortController().signal
  const input = { operation: 'set_value', appId, ref, value: '$(touch /tmp/no); `echo nope`' }
  const result = await tool.execute(input, context)
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{ sessionId: 'chat-1', input, timeoutMs: 30_000, signal: context.abortSignal }])
  assert.equal(tool.getToolUseSummary?.(input), 'set_value')
  assert.match(result.content, /"complete":false/)
  assert.equal(computerApiInputSchema.type, 'object')
  assert.equal(computerApiInputSchema.additionalProperties, false)
  assert.ok(computerApiInputSchema.properties?.snapshotId)
})
test('legacy CLI commands, incomplete targets and unknown fields fail before host access or approval', async () => {
  const { tool, calls, context } = fixture()
  for (const input of [
    { operation: 'snapshot', args: ['--app', 'Finder'] }, { operation: 'bind', app: 'Finder', headed: true },
    { operation: 'bind', app: '' }, { operation: 'bind', app: 'a\0b' },
    { operation: 'click', appId, ref: 'e1' }, { operation: 'click', appId },
    { operation: 'click_at', appId, snapshotId, x: -1, y: 2 },
    { operation: 'click_at', appId, snapshotId, x: 1, y: 2, clickCount: 4 },
    { operation: 'type_text', appId, snapshotId, text: 'x'.repeat(4097) },
    { operation: 'get_state', appId, sessionId: 'other' },
    { operation: 'screenshot', appId, path: '/tmp/write.png' },
    { operation: 'status', timeoutMs: 0 }, { operation: 'status', timeoutMs: NaN },
    { operation: 'wait_for', appId, condition: { kind: 'element', state: 'present' } },
    { operation: 'wait_for', appId, condition: { kind: 'element', state: 'present', labelIncludes: '' } },
    { operation: 'wait_for', appId, condition: { kind: 'window', state: 'present', windowId: 'w1', titleIncludes: 'Example' } },
    { operation: 'wait_for', appId, condition: { kind: 'window', state: 'present' } },
    { operation: 'wait_for', appId, condition: { kind: 'element', state: 'absent', role: 'AXButton' }, waitMs: 0 },
    { operation: 'wait_for', appId, condition: { kind: 'element', state: 'absent', role: 'AXButton' }, ref },
  ]) {
    assert.equal(tool.validateInput?.(input).ok, false, JSON.stringify(input))
    assert.equal((await tool.execute(input, context)).errorCode, 'invalid_input')
  }
  assert.equal(calls.length, 0)
})
test('wait_for validates matchers, supplies its local default, and remains a readonly operation', async () => {
  const { tool, calls, context } = fixture()
  const condition = { kind: 'element', state: 'present', role: 'AXStaticText', valueIncludes: 'Ready' }
  const input = { operation: 'wait_for', appId, condition }
  assert.equal(tool.validateInput?.(input).ok, true)
  assert.equal(tool.isReadOnlyInput?.(input), true)
  assert.equal((await tool.execute(input, context)).ok, true)
  assert.deepEqual(calls[0]?.input, { ...input, waitMs: 5000 })
  assert.ok(computerApiInputSchema.properties?.condition)
  assert.ok(computerApiInputSchema.properties?.waitMs)
})
test('native delivery evidence survives translation without an automatic retry', async () => {
  const { tool, calls, context } = fixture({ envelope: { ok: false, error: { code: 'NATIVE_ERROR', message: 'Readback failed', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } } } })
  const result = await tool.execute({ operation: 'click', appId, ref }, context)
  assert.equal(result.ok, false)
  assert.deepEqual(result.errorDetails, { code: 'NATIVE_ERROR', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } })
  assert.equal(calls.length, 1)
})
test('stopped calls never reach the host', async () => {
  const { tool, calls, context } = fixture()
  context.abortSignal = AbortSignal.abort()
  const result = await tool.execute({ operation: 'click', appId, ref }, context)
  assert.equal(result.errorCode, 'aborted')
  assert.equal(calls.length, 0)
})
test('screenshots import real pixels, keep coordinate mapping and never record base64', async () => {
  const { tool, calls, context } = fixture({ envelope: { ok: true, data: { snapshotId, boundsInPoints: { x: -100, y: 20, width: 800, height: 600 } } }, image: { bytes: Buffer.from('pixels'), name: 'computer-window.png' } })
  assert.equal((await tool.execute({ operation: 'screenshot', appId }, context)).errorCode, 'precondition_failed')
  assert.equal(calls.length, 0)
  const image = makeImageAttachmentRef({ name: 'computer-window.png' })
  context.getSupportsImageInput = () => true
  context.imageAttachments = { importImage: async (sessionId, bytes) => {
    assert.equal(sessionId, 'chat-1'); assert.equal(bytes.toString(), 'pixels')
    return { ok: true, value: { ref: image, metadata: { originalWidth: 800, originalHeight: 600, sentWidth: image.width, sentHeight: image.height, localPath: '/scratch/shot.png' }, animated: false } }
  } }
  const result = await tool.execute({ operation: 'screenshot', appId }, context)
  assert.equal(result.ok, true)
  assert.deepEqual(result.images, [image])
  assert.match(result.content, /window-local points/)
  assertNoImageBytes(result)
})

test('application and combined observations validate scope and require image capability before host access', async () => {
  const { tool, calls, context } = fixture()
  for (const input of [
    { operation: 'get_state', appId, scope: 'application', windowId: 'w1' },
    { operation: 'get_state', appId, scope: 'application', includeScreenshot: true },
    { operation: 'get_state', appId, rootRef: ref, includeScreenshot: true },
  ]) assert.equal(tool.validateInput?.(input).ok, false)
  assert.equal((await tool.execute({ operation: 'get_state', appId, includeScreenshot: true }, context)).errorCode, 'precondition_failed')
  assert.equal(calls.length, 0)
  const input = { operation: 'get_state', appId, scope: 'application' }
  assert.equal(tool.isReadOnlyInput?.(input), true)
  assert.equal((await tool.execute(input, context)).ok, true)
  assert.equal(calls.length, 1)
})

test('text selection has explicit range or exact match semantics and remains a normal semantic action', async () => {
  const { tool, context, calls } = fixture()
  for (const selection of [{ start: -1, length: 1 }, { start: 1.5, length: 1 }, { start: 1, length: 1, text: 'x' }, { text: '' }, { text: 'x', prefix: '' }])
    assert.equal(tool.validateInput?.({ operation: 'select_text', appId, ref, selection }).ok, false)
  const selection = { text: '重复', prefix: '乙 ', suffix: ' 丙' }
  assert.equal((await tool.execute({ operation: 'select_text', appId, ref, selection }, context)).ok, true)
  assert.deepEqual(calls[0]?.input, { operation: 'select_text', appId, ref, selection })
})

test('unknown delivery explains fresh observation instead of recommending an automatic retry', async () => {
  const { tool, context } = fixture({ envelope: { ok: false, error: { code: 'NATIVE_ERROR', message: 'Readback failed', disposition: { delivery: 'unknown' } } } })
  const result = await tool.execute({ operation: 'click', appId, ref }, context)
  assert.match(result.content, /may already have happened; do not blindly repeat/)
  assert.match(result.content, /observe the live UI/)
})

test('desktop interruption preserves delivery and explains user-controlled recovery without replay', async () => {
  for (const delivery of ['not_delivered', 'unknown', 'delivered_unverified']) {
    const tool = createComputerTool({ run: async () => { throw Object.assign(new Error('Desktop changed'), { code: 'DESKTOP_UNAVAILABLE', delivery }) } })
    const result = await tool.execute({ operation: 'click', appId, ref }, fixture().context)
    assert.equal(result.errorCode, 'precondition_failed')
    assert.deepEqual(result.errorDetails, { code: 'DESKTOP_UNAVAILABLE', disposition: { delivery, retry: delivery === 'not_delivered' ? 'safe' : 'unsafe' } })
    assert.match(result.content, /user to wake and unlock/)
    assert.match(result.content, /fresh binding and observe/)
    assert.match(result.content, /do not automatically replay/)
    assert.equal(result.content.includes('may already have happened'), delivery !== 'not_delivered')
  }
})
