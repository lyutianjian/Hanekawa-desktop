import test from 'node:test'
import assert from 'node:assert/strict'
import { createReadSessionTool, readSessionInputSchema } from '../src/tools/ReadSessionTool/ReadSessionTool.js'
import { getBuiltinTools } from '../src/tools/index.js'
import { getToolDisplay } from '../src/tools/display.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { SessionRecord } from '../src/harness/types.js'
import type { SessionReferenceHost, SessionReadResult } from '../src/runtime/protocol/sessionReferences.js'
import { applySessionEvent, createTranscriptState, groupTranscript } from '../src/desktop/renderer/model/transcript.js'
import { callParts } from '../src/desktop/renderer/model/toolPhrases.js'
import { buildAnthropicTools } from '../src/config/providers/anthropicPayload.js'
import { buildOpenAITools } from '../src/config/providers/openaiPayload.js'
import { buildResponsesPayload } from '../src/config/providers/responsesPayload.js'
import { toolToAPISchema } from '../src/harness/toolApiSchema.js'
import type { JsonSchema } from '../src/harness/toolValidation.js'

const id = '11111111-1111-4111-8111-111111111111'
const context = { cwd: '/tmp', sessionId: 'caller', readFiles: new Set<string>() }
const result: SessionReadResult = {
  schemaVersion: 1,
  session: { sessionId: id, uri: `hanekawa://session/${id}`, title: '来源真标题', projectRoot: '/tmp', projectName: '项目', projectIsGlobal: false, updatedAt: '2026-10-31T00:00:00Z', state: 'unknown' },
  page: { direction: 'earlier', hasMore: true, truncated: false, nextCursor: 'next' },
  items: [{ messageId: 'm1', role: 'user', createdAt: '2026-10-31T00:00:00Z', content: 'saved content SECRET' }],
  diagnostics: [],
}
function host(read: SessionReferenceHost['read'] = async () => result): SessionReferenceHost {
  return {
    read,
    search: async () => ({ schemaVersion: 1, results: [], complete: false, nextCursor: 'next', coverage: { sessionsScanned: 1, bytesScanned: 4, totalSessions: 2 } }),
    resolve: async () => result.session,
  }
}

test('ReadSession publishes an object schema in all provider requests while runtime keeps strict action validation', () => {
  const tools = getBuiltinTools()
  assert.equal(tools[0]?.name, 'ReadSession')
  const anthropic = buildAnthropicTools(tools)[0]!
  const openai = buildOpenAITools(tools)[0]!
  const responses = buildResponsesPayload({ cacheSource: 'agent:read-session-schema', model: 'fixture', messages: [], tools }).tools![0]!
  const schema = toolToAPISchema(tools[0]!)
  for (const published of [schema, anthropic.input_schema, openai.function.parameters, responses.parameters] as JsonSchema[]) {
    assert.equal(published.type, 'object')
    assert.deepEqual(published.required, ['action'])
    assert.equal(published.additionalProperties, false)
    assert.deepEqual(published.properties?.action?.enum, ['search', 'read'])
    assert.equal('anyOf' in published, false)
    assert.equal('oneOf' in published, false)
    assert.equal(JSON.stringify(published).includes('"$ref"'), false)
  }
  assert.deepEqual(Object.keys(schema.properties ?? {}).sort(), [
    'action', 'anchorMessageId', 'cursor', 'from', 'includeTools', 'limit',
    'projectRoot', 'query', 'ref', 'scope', 'updatedAfter', 'updatedBefore',
  ])
  assert.equal(schema.properties?.limit?.maximum, 50)
  assert.equal(readSessionInputSchema.safeParse({ action: 'search' }).success, false)
  assert.equal(readSessionInputSchema.safeParse({ action: 'read' }).success, false)
  assert.equal(readSessionInputSchema.safeParse({ action: 'search', query: 'x', limit: 21 }).success, false)
  assert.equal(readSessionInputSchema.safeParse({ action: 'read', ref: id, query: 'x' }).success, false)
})

test('ReadSession is a builtin with strict action schemas and valid mutually exclusive read positions', () => {
  assert.ok(getBuiltinTools().some((tool) => tool.name === 'ReadSession' && tool.isReadOnly && tool.riskLevel === 'safe'))
  for (const input of [
    { action: 'read', ref: '../anything' },
    { action: 'read', ref: id, query: 'x' },
    { action: 'search', query: 'x', ref: id },
    { action: 'search', scope: 'content', query: ' ' },
    { action: 'search', query: 'x', updatedAfter: 'wrong' },
    { action: 'search', query: 'x', updatedAfter: '2026-10-31T00:00:00Z', updatedBefore: '2026-10-30T00:00:00Z' },
    { action: 'read', ref: id, from: 'latest', cursor: 'x' },
    { action: 'read', ref: id, from: 'start', anchorMessageId: 'x' },
    { action: 'read', ref: id, anchorMessageId: 'x', cursor: 'y' },
    { action: 'read', ref: id, limit: 51 },
    { action: 'search', query: 'x', limit: 21 },
  ]) assert.equal(readSessionInputSchema.safeParse(input).success, false, JSON.stringify(input))
  assert.equal(readSessionInputSchema.safeParse({ action: 'read', ref: id }).success, true)
  assert.equal(readSessionInputSchema.safeParse({ action: 'search', query: '' }).success, true)
  assert.equal(getToolDisplay('ReadSession', { action: 'search', query: '缓存' }).name, '查找会话')
  assert.equal(getToolDisplay('ReadSession', { action: 'read', ref: id }).summary, id.slice(0, 8))
})

test('ReadSession uses the formal tool records, forwards caller/cancellation, redacts outputs and replays its resolved title', async () => {
  const records: SessionRecord[] = []
  const controller = new AbortController()
  const tool = createReadSessionTool(host(async (input, call) => {
    assert.equal(input.ref, id)
    assert.equal(call?.sessionId, 'caller')
    assert.equal(call?.signal, controller.signal)
    return result
  }))
  const runner = new ToolRunner([tool], new PermissionGate(async () => { assert.fail('readonly should not ask') }), {
    onRecord: async (record) => { records.push(record) },
  }, {}, (text) => text.replaceAll('SECRET', '[redacted]'))
  const saved = await runner.run({ id: 'r1', name: 'ReadSession', input: { action: 'read', ref: id } }, context, controller.signal, 'turn')
  assert.equal(saved.ok, true)
  assert.deepEqual(records.map((record) => record.type), ['tool_use', 'tool_approval', 'tool_result'])
  assert.doesNotMatch(JSON.stringify(saved), /SECRET/)
  assert.match(saved.content, /saved content/)
  assert.match(saved.display?.summary ?? '', /来源真标题.*1 条内容.*后续页/)
  let live = createTranscriptState()
  for (const record of records) {
    live = applySessionEvent(live, { type: 'record', record }, () => ({ displayName: '读取会话', useSummary: id.slice(0, 8) })).state
  }
  const replay = createTranscriptState(records, () => ({ displayName: '读取会话', useSummary: id.slice(0, 8) }))
  assert.deepEqual(live.items, replay.items)
  const item = live.items.find((item) => item.toolName === 'ReadSession' && item.tool?.content)
  assert.ok(item?.tool)
  assert.equal(callParts({ kind: 'tool', toolName: 'ReadSession', tool: item.tool } as Parameters<typeof callParts>[0]).target, '来源真标题')
  assert.ok(groupTranscript(live.items).length > 0)
})

test('ReadSession settles deny, hook block, missing source, and cancellation through ToolRunner', async () => {
  for (const scenario of ['deny', 'hook', 'missing', 'cancel'] as const) {
    const records: SessionRecord[] = []
    let reads = 0
    const controller = new AbortController()
    const tool = createReadSessionTool(host(async () => {
      reads++
      if (scenario === 'missing') throw new Error('会话不存在或已删除')
      if (scenario === 'cancel') { controller.abort(); throw new DOMException('Cancelled', 'AbortError') }
      return result
    }))
    const gate = new PermissionGate(async () => false, scenario === 'deny' ? [{ toolName: 'ReadSession', behavior: 'deny', source: 'config' }] : [])
    const runner = new ToolRunner([tool], gate, { onRecord: async (record) => { records.push(record) } }, scenario === 'hook' ? {
      preToolUse: [{ matcher: 'ReadSession', command: `${JSON.stringify(process.execPath)} -e "process.exit(7)"` }],
    } : {})
    const saved = await runner.run({ id: scenario, name: 'ReadSession', input: { action: 'read', ref: id } }, context, controller.signal)
    assert.equal(saved.ok, false, scenario)
    assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
    assert.equal(reads, scenario === 'deny' || scenario === 'hook' ? 0 : 1)
    if (scenario === 'cancel') assert.equal(saved.errorCode, 'aborted')
    if (scenario === 'missing') assert.match(saved.content, /不存在或已删除/)
  }
})

test('search has its own activity and incomplete-coverage display', async () => {
  const tool = createReadSessionTool(host())
  const saved = await tool.execute({ action: 'search', query: 'cache', scope: 'content' }, context)
  assert.equal(saved.ok, true)
  assert.match(saved.metadata?.display?.summary ?? '', /尚未搜索完/)
  assert.match(tool.getActivityDescription?.({ action: 'search', query: 'cache' }) ?? '', /查找会话 cache/)
})

test('an explicit ReadSession ask rule still prompts, and a locked readonly researcher refuses it', async () => {
  for (const mode of ['default', 'readonly'] as const) {
    let prompts = 0
    let reads = 0
    const tool = createReadSessionTool(host(async () => { reads++; return result }))
    const records: SessionRecord[] = []
    const gate = new PermissionGate(async () => { prompts++; return true }, [
      { toolName: 'ReadSession', behavior: 'ask', source: 'config' },
    ], { mode, lockMode: mode === 'readonly' })
    const runner = new ToolRunner([tool], gate, { onRecord: async (record) => { records.push(record) } })
    const saved = await runner.run({ id: mode, name: 'ReadSession', input: { action: 'read', ref: id } }, context)
    assert.equal(saved.ok, mode === 'default')
    assert.equal(prompts, mode === 'default' ? 1 : 0)
    assert.equal(reads, mode === 'default' ? 1 : 0)
    assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  }
})

test('a referenced saved conversation flows through loop search, anchored read, continuation and transcript without source writes', async () => {
  const { mkdtemp, mkdir, readFile, writeFile, rm } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const { getSessionsDir } = await import('../src/utils/paths.js')
  const { createSessionReferenceHost } = await import('../src/runtime/sessionReferences.js')
  const { AgentLoop } = await import('../src/harness/loop.js')
  const { ContextBuilder } = await import('../src/harness/contextBuilder.js')
  const root = await mkdtemp(join(tmpdir(), 'reference-loop-'))
  const sourceRoot = join(root, 'other-project')
  const dir = getSessionsDir(sourceRoot)
  const sourceFile = join(dir, `${id}.jsonl`)
  await mkdir(dir, { recursive: true })
  const source = [
    { type: 'message', id: 'hit', role: 'user', content: 'needle: saved task details', createdAt: '2026-10-31T00:00:00Z' },
    { type: 'message', id: 'reply', role: 'assistant', content: 'saved answer', createdAt: '2026-10-31T00:00:01Z' },
  ].map((record) => JSON.stringify(record)).join('\n') + '\n'
  await writeFile(sourceFile, source)
  await writeFile(join(dir, 'index.json'), JSON.stringify({ sessions: [{ id, title: '来源标题', updatedAt: '2026-10-31T00:00:01Z', messageCount: 2 }] }))
  try {
    const savedHost = createSessionReferenceHost({ cwd: root, listProjectRoots: async () => [sourceRoot] })
    let nextCursor: string | undefined
    const tool = createReadSessionTool({ ...savedHost, read: async (...args) => {
      const page = await savedHost.read(...args)
      nextCursor = page.page.nextCursor
      return page
    } })
    const records: SessionRecord[] = []
    let round = 0
    const runner = new ToolRunner([tool], new PermissionGate(async () => true), { onRecord: async (record) => { records.push(record) } })
    const loop = new AgentLoop({
      model: 'fixture', tools: [tool], toolRunner: runner, contextBuilder: new ContextBuilder(),
      toolContext: { cwd: root, sessionId: 'caller', readFiles: new Set() },
      recordStream: { load: async () => records, append: async (record) => { records.push(record) } },
      provider: { name: 'fixture', createMessage: async (request) => {
        assert.match(JSON.stringify(request.messages), /session-references/)
        const inputs = [
          { action: 'search', query: 'needle', scope: 'content' },
          { action: 'read', ref: id, anchorMessageId: 'hit', limit: 1 },
          { action: 'read', ref: id, cursor: nextCursor, limit: 1 },
        ]
        const input = inputs[round++]
        return input ? { content: '', toolCalls: [{ id: `call-${round}`, name: 'ReadSession', input }] } : { content: '已按保存内容继续', toolCalls: [] }
      } },
    })
    await loop.run({ text: `参考 [来源标题](hanekawa://session/${id}) 继续` })
    assert.equal(records.filter((record) => record.type === 'session_reference_context').length, 1)
    const results = records.filter((record) => record.type === 'tool_result')
    assert.equal(results.length, 3)
    assert.ok(results.every((record) => record.ok))
    assert.match(results[0]!.content, /needle.*saved task details/)
    assert.match(results[1]!.content, /saved task details/)
    assert.match(results[2]!.content, /saved answer/)
    assert.equal(createTranscriptState(records).items.filter((item) => item.toolName === 'ReadSession').length, 3)
    assert.equal(await readFile(sourceFile, 'utf8'), source)
  } finally { await rm(root, { recursive: true, force: true }) }
})
