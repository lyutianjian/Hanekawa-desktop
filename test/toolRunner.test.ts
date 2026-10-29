import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod/v3'
import { PermissionGate, type PermissionRequest } from '../src/harness/permissions.js'
import { prepareRecordsForRequest } from '../src/harness/requestPrep.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { applySessionEvent, createTranscriptState, groupTranscript } from '../src/desktop/renderer/model/transcript.js'
import { turnActivity } from '../src/desktop/renderer/model/waiting.js'
import { countTextTokens } from '../src/prompts/budget.js'
import type { SessionRecord, Tool, ToolProgressEvent } from '../src/harness/types.js'
import { makeImageAttachmentRef } from './helpers/imageFixtures.js'

test('permission exceptions settle one failed tool result and finish progress', async () => {
  const records: SessionRecord[] = []
  const progress: ToolProgressEvent[] = []
  const tool: Tool = {
    name: 'guarded', description: 'guarded', inputSchema: z.object({}).strict(), riskLevel: 'confirm',
    execute: async () => { throw new Error('must not execute') },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => { throw new Error('approval failed') }), {
    onRecord: async (record) => { records.push(record) }, onProgress: (event) => { progress.push(event) },
  })
  const result = await runner.run({ id: 'approval-error', name: tool.name, input: {} }, { cwd: process.cwd(), sessionId: 's', readFiles: new Set() })
  assert.equal(result.ok, false)
  assert.match(result.content, /approval failed/)
  assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  assert.deepEqual(progress.map((event) => event.phase), ['started', 'finished'])
})

test('persistence failures are reported without retrying or duplicating tool results', async () => {
  for (const failType of ['tool_use', 'tool_approval', 'tool_result', 'message']) {
    const records: SessionRecord[] = []
    let failedWrites = 0
    const tool: Tool = {
      name: 'save', description: 'save', inputSchema: z.object({}).strict(), riskLevel: 'safe',
      execute: async () => ({ ok: true, content: 'done', metadata: { assistantMessageContent: 'reported' } }),
    }
    const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
      onRecord: async (record) => {
        if (record.type === failType) { failedWrites++; throw new Error('disk failed') }
        records.push(record)
      },
    })
    await assert.rejects(runner.run({ id: 'save-failed', name: tool.name, input: {} }, { cwd: process.cwd(), sessionId: 's', readFiles: new Set() }), /disk failed/)
    assert.equal(failedWrites, 1)
    assert.ok(records.filter((record) => record.type === 'tool_result').length <= 1)
  }
})

test('tool runner executes safe tool without prompting', async () => {
  let prompted = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    prompted = true
    return true
  }), {
    onRecord: async (record) => { records.push(record) },
  })
  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(prompted, false)
  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(records.length, 3)
})

test('automatic approvals never show a user wait, even before the approval record arrives', async () => {
  for (const mode of ['auto', 'bypass', 'default'] as const) {
    const tool: Tool = {
      name: 'autoTool', description: 'auto', inputSchema: z.object({}).strict(), riskLevel: 'confirm',
      execute: async () => ({ ok: true, content: 'done' }),
    }
    let state = createTranscriptState()
    const labels: string[] = []
    const gate = new PermissionGate(async () => { assert.fail('the call should be approved without asking') },
      mode === 'default' ? [{ toolName: tool.name, behavior: 'allow', source: 'config' }] : [], { mode })
    const runner = new ToolRunner([tool], gate, {
      onRecord: async (record) => {
        state = applySessionEvent(state, { type: 'record', record }).state
        const activity = turnActivity(groupTranscript(state.items), { isStreaming: true, startedAt: 0, turnId: 't1' })
        labels.push(activity.row!.label)
        assert.equal(activity.mark?.state, 'working', `${mode}: ${record.type}`)
      },
    })
    const result = await runner.run({ id: 'automatic', name: tool.name, input: {} },
      { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() }, undefined, 't1')
    assert.equal(result.ok, true)
    assert.equal(labels[0], '正在运行工具', 'the tool_use paint before approval is already a tool activity')
    assert.ok(labels.every((label) => !label.includes('等待你确认')), mode)
  }
})

test('tool runner denies dangerous tool when permission is false', async () => {
  let request: PermissionRequest | undefined
  const tool: Tool = {
    name: 'Delete',
    description: 'delete',
    inputSchema: z.object({
      filePath: z.string(),
    }).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'deleted' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async (next) => { request = next; return false }), {
    onRecord: async () => {},
  })
  const result = await runner.run({ id: 'call1', name: 'Delete', input: { filePath: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })
  assert.equal(result.ok, false)
  assert.equal(request?.toolUseId, 'call1', 'a human prompt names exactly the blocked call')
  assert.match(result.content, /denied/)
})

test('tool runner returns structured validation errors before prompting or executing', async () => {
  let prompted = false
  let executed = false
  const tool: Tool = {
    name: 'validatedTool',
    description: 'validated',
    inputSchema: z.object({
      filePath: z.string(),
    }).strict(),
    riskLevel: 'confirm',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    prompted = true
    return true
  }), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run({ id: 'call1', name: 'validatedTool', input: { path: 'a.txt' } }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.match(result.content, /Tool input validation failed for validatedTool/)
  assert.equal(prompted, false)
  assert.equal(executed, false)
  assert.equal(records.filter((record) => record.type === 'tool_use').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  assert.equal(records.some((record) => record.type === 'tool_approval'), false)
})

test('tool runner writes optional turnId to tool records', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'safeTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    undefined,
    'turn-1',
  )

  assert.equal(result.turnId, 'turn-1')
  assert.ok(records.every((record) => 'turnId' in record && record.turnId === 'turn-1'))
})

test('tool runner stores derived token count on tool results', async () => {
  const tool: Tool = {
    name: 'echo',
    description: 'echo',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'hello world' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  await runner.run({ id: 'call1', name: 'echo', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  const result = records.find((record) => record.type === 'tool_result')
  assert.equal(result?.type, 'tool_result')
  assert.equal(result._tokens, countTextTokens('echo\nhello world'))
})

test('tool runner applies maxResultSizeChars before persisting tool results', async () => {
  const tool: Tool = {
    name: 'limitedTool',
    description: 'limited',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    maxResultSizeChars: 5,
    execute: async () => ({ ok: true, content: '0123456789' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run({ id: 'call1', name: 'limitedTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.content, '01234\n\n[Tool result truncated: exceeded 5 chars; original 10 chars]')
  assert.equal(result._tokens, countTextTokens(`limitedTool\n${result.content}`))
  assert.equal(records.find((record) => record.type === 'tool_result'), result)

  const prepared = prepareRecordsForRequest(records, { contextWindow: 1_000_000, summaryOutputTokens: 0 })
  const preparedResult = prepared.find((record) => record.type === 'tool_result')
  assert.equal(preparedResult?.type, 'tool_result')
  assert.equal(preparedResult.content, result.content)
})

test('tool runner preserves unbounded tool results exactly', async () => {
  const tool: Tool = {
    name: 'unboundedTool',
    description: 'unbounded',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '0123456789' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })

  const result = await runner.run({ id: 'call1', name: 'unboundedTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.content, '0123456789')
})

test('tool runner persists structured display metadata without changing content', async () => {
  const tool: Tool = {
    name: 'summaryTool',
    description: 'summary',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({
      ok: true,
      content: 'line 1\nline 2',
      metadata: { display: { summary: 'Read 2 lines' } },
    }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  })

  const result = await runner.run(
    { id: 'call1', name: 'summaryTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.content, 'line 1\nline 2')
  assert.deepEqual(result.display, { summary: 'Read 2 lines' })
})

test('tool runner pairs tool_use with aborted tool_result when permission aborts', async () => {
  const controller = new AbortController()
  const tool: Tool = {
    name: 'confirmTool',
    description: 'confirm',
    inputSchema: z.object({}).strict(),
    riskLevel: 'confirm',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => {
    controller.abort('user-cancel')
    throw new DOMException('The operation was aborted.', 'AbortError')
  }), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'confirmTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    controller.signal,
  )

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'aborted')
  assert.equal(result.content, 'Interrupted by user')
  assert.equal(records.filter((record) => record.type === 'tool_use').length, 1)
  assert.equal(records.filter((record) => record.type === 'tool_result').length, 1)
  assert.equal(records.find((record) => record.type === 'tool_result')?.toolUseId, 'call1')
})

test('tool runner runs preToolUse hooks after permission and blocks on nonzero exit', async () => {
  let executed = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  }, {
    preToolUse: [{
      matcher: 'safeTool',
      command: `${JSON.stringify(process.execPath)} -e "console.error('blocked by hook'); process.exit(7)"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'precondition_failed')
  assert.match(result.content, /Pre-tool hook blocked safeTool/)
  assert.match(result.content, /blocked by hook/)
  assert.equal(executed, false)
})

test('tool runner skips preToolUse hooks when matcher does not match', async () => {
  let executed = false
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      executed = true
      return { ok: true, content: 'done' }
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
  }, {
    preToolUse: [{
      matcher: 'Bash',
      command: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, true)
  assert.equal(result.content, 'done')
  assert.equal(executed, true)
})

test('tool runner runs postToolUse hooks after emitting tool result', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  }, {
    postToolUse: [{
      matcher: 'safeTool',
      command: `${JSON.stringify(process.execPath)} -e "let input=''; process.stdin.on('data', c => input += c); process.stdin.on('end', () => { const data = JSON.parse(input); console.log(data.tool + ':' + data.result.content) })"`,
    }],
  })

  const result = await runner.run({ id: 'call1', name: 'safeTool', input: {} }, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() })

  assert.equal(result.ok, true)
  const resultIndex = records.findIndex((record) => record.type === 'tool_result')
  const hookIndex = records.findIndex((record) => record.type === 'message' && /postToolUse hook output for safeTool/.test(record.content))
  assert.ok(resultIndex >= 0)
  assert.ok(hookIndex > resultIndex)
  assert.match(records[hookIndex]?.type === 'message' ? records[hookIndex].content : '', /safeTool:done/)
})

test('tool runner merges per-run hooks with configured hooks', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async (record) => { records.push(record) },
  }, {
    postToolUse: [{
      matcher: 'safeTool',
      command: `${JSON.stringify(process.execPath)} -e "console.log('configured hook')"`,
    }],
  })

  await runner.run(
    { id: 'call1', name: 'safeTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
    undefined,
    'turn-1',
    {
      hooks: {
        postToolUse: [{
          matcher: 'safeTool',
          command: `${JSON.stringify(process.execPath)} -e "console.log('per-run hook')"`,
        }],
      },
    },
  )

  const hookMessage = records.find((record) => record.type === 'message' && record.content.includes('postToolUse hook output'))
  assert.ok(hookMessage)
  assert.match(hookMessage.type === 'message' ? hookMessage.content : '', /configured hook/)
  assert.match(hookMessage.type === 'message' ? hookMessage.content : '', /per-run hook/)
})

test('tool runner emits progress around execution', async () => {
  const tool: Tool = {
    name: 'safeTool',
    description: 'safe',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done' }),
  }
  const progress: ToolProgressEvent[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
    onProgress: (event) => { progress.push(event) },
  })

  await runner.run(
    { id: 'call1', name: 'safeTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.deepEqual(progress.map((event) => event.phase), ['started', 'finished'])
  assert.deepEqual(progress.map((event) => event.call.id), ['call1', 'call1'])
})

test('tool runner finishes progress when execution fails', async () => {
  const tool: Tool = {
    name: 'failTool',
    description: 'fail',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      throw new Error('boom')
    },
  }
  const progress: string[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), {
    onRecord: async () => {},
    onProgress: (event) => { progress.push(event.phase) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'failTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.ok, false)
  assert.deepEqual(progress, ['started', 'finished'])
})

test('tool runner rewrites the model parameter names before permissions, hooks and records see them', async () => {
  let seenInput: unknown
  const tool: Tool = {
    name: 'Edit',
    description: 'edit',
    inputSchema: z.object({
      filePath: z.string(),
      oldString: z.string(),
      newString: z.string(),
      replaceAll: z.boolean().optional(),
    }).strict(),
    riskLevel: 'confirm',
    execute: async (input) => {
      seenInput = input
      return { ok: true, content: 'edited' }
    },
  }
  const permissionInputs: unknown[] = []
  const records: SessionRecord[] = []
  const runner = new ToolRunner([tool], new PermissionGate(async (request) => {
    permissionInputs.push(request.input)
    return true
  }), {
    onRecord: async (record) => { records.push(record) },
  })

  const result = await runner.run(
    { id: 'call1', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b', replace_all: 'true' } },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.ok, true, result.content)
  assert.deepEqual(seenInput, { filePath: 'a.ts', oldString: 'a', newString: 'b', replaceAll: true })
  assert.deepEqual(permissionInputs[0], { filePath: 'a.ts', oldString: 'a', newString: 'b', replaceAll: true })
  const toolUse = records.find((record) => record.type === 'tool_use')
  assert.deepEqual((toolUse as { input?: unknown }).input, { filePath: 'a.ts', oldString: 'a', newString: 'b', replaceAll: true })
})

test('a validation failure lists every issue and the accepted parameter names', async () => {
  const tool: Tool = {
    name: 'pickyTool',
    description: 'picky',
    inputSchema: z.object({
      filePath: z.string(),
      count: z.number(),
    }).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'ran' }),
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), { onRecord: async () => {} })

  const result = await runner.run(
    { id: 'call1', name: 'pickyTool', input: { nope: 1 } },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'invalid_input')
  assert.match(result.content, /\$\.filePath is required/)
  assert.match(result.content, /\$\.count is required/)
  assert.match(result.content, /Accepted parameters: filePath, count\./)
})

test('a filesystem errno reaches the model with the tool name and what to do next', async () => {
  const tool: Tool = {
    name: 'explodingTool',
    description: 'explodes',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => {
      const error = new Error("ENOTDIR: not a directory, scandir '/tmp/a.yaml'") as Error & { code: string }
      error.code = 'ENOTDIR'
      throw error
    },
  }
  const runner = new ToolRunner([tool], new PermissionGate(async () => true), { onRecord: async () => {} })

  const result = await runner.run(
    { id: 'call1', name: 'explodingTool', input: {} },
    { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() },
  )

  assert.equal(result.ok, false)
  assert.equal(result.errorCode, 'execution_failed')
  assert.match(result.content, /^explodingTool failed:/)
  assert.match(result.content, /is a file, not a directory/)
})

test('a tool result carrying image refs persists them on the tool_result record', async () => {
  const image = makeImageAttachmentRef({ id: 'img-read-1', name: 'screenshot.png' })
  const withImages: Tool = {
    name: 'readImage',
    description: 'reads an image',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: '[Image 1: screenshot.png; …]', images: [image] }),
  }
  const withoutImages: Tool = {
    name: 'plainTool',
    description: 'plain',
    inputSchema: z.object({}).strict(),
    riskLevel: 'safe',
    execute: async () => ({ ok: true, content: 'done', images: [] }),
  }
  const dangerous: Tool = {
    name: 'dangerousTool',
    description: 'dangerous',
    inputSchema: z.object({}).strict(),
    riskLevel: 'dangerous',
    execute: async () => ({ ok: true, content: 'deleted', images: [image] }),
  }
  const runner = new ToolRunner([withImages, withoutImages], new PermissionGate(async () => true), { onRecord: async () => {} })
  const context = { cwd: process.cwd(), sessionId: 's1', readFiles: new Set<string>() }

  const carried = await runner.run({ id: 'call1', name: 'readImage', input: {} }, context)
  assert.deepEqual(carried.images, [image])

  // An empty array stays absent: "no images" is the default, not a value to store.
  const plain = await runner.run({ id: 'call2', name: 'plainTool', input: {} }, context)
  assert.equal('images' in plain, false)

  // ToolRunner-constructed failure paths (denial, abort, hook block) settle a
  // full record without ever inventing image refs of their own.
  const deniedRunner = new ToolRunner([dangerous], new PermissionGate(async () => false), { onRecord: async () => {} })
  const denied = await deniedRunner.run({ id: 'call3', name: 'dangerousTool', input: {} }, context)
  assert.equal(denied.ok, false)
  assert.equal('images' in denied, false)
})
