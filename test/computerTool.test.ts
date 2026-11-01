import assert from 'node:assert/strict'
import test from 'node:test'
import type { ToolContext } from '../src/harness/types.js'
import type { ComputerHost, ComputerRequest, ComputerResponse } from '../src/runtime/protocol/computerHost.js'
import { createComputerTool } from '../src/tools/ComputerTool/ComputerTool.js'
import { computerCommand, computerInputSchema } from '../src/tools/ComputerTool/schema.js'
import { assertNoImageBytes, makeImageAttachmentRef } from './helpers/imageFixtures.js'

function fixture(response: ComputerResponse = { envelope: { ok: true, data: { complete: false, tree: {} } } }) {
  const calls: ComputerRequest[] = []
  const host: ComputerHost = { run: async (request) => { calls.push(request); return response } }
  const context: ToolContext = { cwd: '/scratch', sessionId: 'chat-1', readFiles: new Set() }
  return { tool: createComputerTool(host), calls, context }
}

test('Computer passes canonical arguments and the caller signal without invoking a shell', async () => {
  const { tool, calls, context } = fixture()
  const controller = new AbortController()
  context.abortSignal = controller.signal
  const result = await tool.execute({ operation: 'type', args: ['@s1:e8', '$(touch /tmp/no); `echo nope`'] }, context)
  assert.equal(result.ok, true)
  assert.deepEqual(calls, [{
    sessionId: 'chat-1', command: 'type', args: ['--', '@s1:e8', '$(touch /tmp/no); `echo nope`'],
    headed: false, timeoutMs: 30_000, signal: controller.signal,
  }])
  assert.match(result.content, /"complete":false/)
  assert.equal(tool.getToolUseSummary?.({ operation: 'type', args: ['@s1:e8', 'secret'] }), 'type')
})

test('Computer preserves negative coordinates, repeated modifiers and literal option-looking text', () => {
  const parse = (input: unknown) => computerCommand(computerInputSchema.parse(input))
  assert.deepEqual(parse({ operation: 'mouse-click', args: ['--xy', '-100,50', '--modifiers', 'cmd', '--modifiers=shift'], headed: true }), {
    command: 'mouse-click', args: ['--xy=-100,50', '--modifiers=cmd', '--modifiers=shift'],
  })
  assert.deepEqual(parse({ operation: 'type', args: ['--', '@s1:e8', '--headed'] }), {
    command: 'type', args: ['--', '@s1:e8', '--headed'],
  })
  assert.deepEqual(parse({ operation: 'snapshot', args: ['--app=Finder', '-i'] }).args, ['--app=Finder', '--interactive-only'])
})

test('Computer refuses namespace overrides, extra commands, file outputs and launch injection before host access', async () => {
  const { tool, calls, context } = fixture()
  for (const input of [
    { operation: 'snapshot', args: ['--session', 'another-chat'] },
    { operation: 'snapshot', args: ['--agent-id=other'] },
    { operation: 'snapshot', args: ['--trace=/tmp/log'] },
    { operation: 'snapshot', args: ['--screenshot=/tmp/debug.html'] },
    { operation: 'snapshot', args: ['--headed'] },
    { operation: 'screenshot', args: ['/tmp/write.png'] },
    { operation: 'clipboard-get', args: ['--out=/tmp/write.png'] },
    { operation: 'clipboard-set', args: ['--image=/etc/private'] },
    { operation: 'launch', args: ['Terminal', '--arg=-c'] },
    { operation: 'launch', args: ['Terminal', '--env=FOO=bar'] },
    { operation: 'status', args: ['click', '@s1:e1'] },
    { operation: 'batch', args: ['[]'] },
    { operation: 'session', args: ['start'] },
    { operation: 'key-down', args: ['cmd'] },
    { operation: 'type', args: ['@s1:e1'] },
    { operation: 'find', args: ['--text'] },
    { operation: 'help', args: ['toString'] },
    { operation: 'docs', args: ['platform', '../../private'] },
    { operation: 'status', timeoutMs: 0 },
    { operation: 'type', args: ['@s1:e1', '\0'] },
    { operation: 'status', extra: true },
  ]) {
    const result = await tool.execute(input, context)
    assert.equal(tool.validateInput?.(input).ok, false, 'reject invalid arguments before asking permission')
    assert.equal(result.ok, false, JSON.stringify(input))
    assert.equal(result.errorCode, 'invalid_input', JSON.stringify(input))
  }
  assert.equal(calls.length, 0)
})

test('Computer help and docs read the bundled version and platform guides', async () => {
  const { tool, calls, context } = fixture()
  await tool.execute({ operation: 'help', args: ['snapshot'] }, context)
  await tool.execute({ operation: 'help' }, context)
  await tool.execute({ operation: 'docs', args: ['platform'] }, context)
  await tool.execute({ operation: 'docs', args: ['desktop', 'commands-interaction'] }, context)
  assert.deepEqual(calls.map(({ command, args }) => [command, args]), [
    ['snapshot', ['--help']], ['', ['--help']], ['skills', ['get', 'platform']],
    ['skills', ['get', 'desktop', 'commands-interaction']],
  ])
})

test('native delivery evidence survives tool error translation and never causes an automatic retry', async () => {
  const error = { code: 'ACTION_FAILED', message: 'Readback failed', disposition: { delivery: 'delivered_unverified', retry: 'unsafe' } }
  const { tool, calls, context } = fixture({ envelope: { ok: false, error } })
  const result = await tool.execute({ operation: 'click', args: ['@s1:e1'] }, context)
  assert.equal(result.ok, false)
  assert.deepEqual(result.errorDetails, error)
  assert.deepEqual(JSON.parse(result.content).error.disposition, error.disposition)
  assert.equal(calls.length, 1)
})

test('stopped calls never reach the host and report unknown delivery', async () => {
  const { tool, calls, context } = fixture()
  context.abortSignal = AbortSignal.abort()
  const result = await tool.execute({ operation: 'click', args: ['@s1:e1'] }, context)
  assert.equal(result.errorCode, 'aborted')
  assert.equal(calls.length, 0)
  assert.match(result.content, /observe the live UI/)
})

test('screenshots require image capability and import bytes as an attachment without base64 in records', async () => {
  const { tool, calls, context } = fixture({
    envelope: { ok: true, data: { width: 800, height: 600 } },
    image: { bytes: Buffer.from('pixels'), name: 'desktop-screenshot.png' },
  })
  assert.equal((await tool.execute({ operation: 'screenshot' }, context)).errorCode, 'precondition_failed')
  assert.equal(calls.length, 0)
  const ref = makeImageAttachmentRef({ name: 'desktop-screenshot.png' })
  context.getSupportsImageInput = () => true
  context.imageAttachments = { importImage: async (sessionId, bytes, name) => {
    assert.equal(sessionId, 'chat-1')
    assert.equal(bytes.toString(), 'pixels')
    assert.equal(name, 'desktop-screenshot.png')
    return {
      ok: true,
      value: { ref, metadata: { originalWidth: 800, originalHeight: 600, sentWidth: ref.width, sentHeight: ref.height, localPath: '/scratch/shot.png' }, animated: false },
    }
  } }
  const result = await tool.execute({ operation: 'screenshot', args: ['--app', 'TextEdit'] }, context)
  assert.equal(result.ok, true)
  assert.deepEqual(result.images, [ref])
  assert.match(result.content, /not absolute OS screen coordinates/)
  assertNoImageBytes(result)
})
