import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getBuiltinTools } from '../src/tools/index.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import { PermissionGate } from '../src/harness/permissions.js'
import type { SessionRecord, ToolContext } from '../src/harness/types.js'

test('complete toolcall workflow: grep -> read -> edit -> verify', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-integration-'))
  try {
    // Setup test files
    await writeFile(path.join(dir, 'test.ts'), 'function hello() {\n  return "world"\n}\n', 'utf8')
    await writeFile(path.join(dir, 'other.ts'), 'const x = 42\n', 'utf8')

    const tools = getBuiltinTools()
    const records: SessionRecord[] = []
    const context: ToolContext = { cwd: dir, sessionId: 'test-session', readFiles: new Set() }

    // Auto-approve all tools for this test
    const runner = new ToolRunner(tools, new PermissionGate(async () => true, undefined, { cwd: dir }), {
      onRecord: async (record) => { records.push(record) }
    })

    // Step 1: Use grep to find files containing "hello"
    const grepResult = await runner.run(
      { id: 'call1', name: 'Grep', input: { pattern: 'hello', glob: '**/*.ts' } },
      context
    )
    assert.equal(grepResult.ok, true)
    assert.match(grepResult.content, /test.ts/)
    console.log('✓ grep found matching file')

    // Step 2: Read the file
    const readResult = await runner.run(
      { id: 'call2', name: 'Read', input: { filePath: 'test.ts' } },
      context
    )
    assert.equal(readResult.ok, true)
    assert.match(readResult.content, /function hello/)
    console.log('✓ readFile loaded content')

    // Step 3: Edit the file
    const editResult = await runner.run(
      { id: 'call3', name: 'Edit', input: {
        filePath: 'test.ts',
        oldString: '"world"',
        newString: '"myagent"'
      } },
      context
    )
    assert.equal(editResult.ok, true)
    console.log('✓ editFile modified content')

    // Step 4: Verify the change
    const content = await readFile(path.join(dir, 'test.ts'), 'utf8')
    assert.match(content, /"myagent"/)
    assert.equal(content.includes('"world"'), false)
    console.log('✓ File content verified')

    // Check that all tool calls were recorded
    const toolUseRecords = records.filter(r => r.type === 'tool_use')
    const toolResultRecords = records.filter(r => r.type === 'tool_result')
    assert.equal(toolUseRecords.length, 3)
    assert.equal(toolResultRecords.length, 3)
    console.log('✓ All tool calls recorded')

  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('toolcall permission system works correctly', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-permissions-'))
  try {
    await writeFile(path.join(dir, 'test.txt'), 'content', 'utf8')

    const tools = getBuiltinTools()
    const context: ToolContext = { cwd: dir, sessionId: 'test-session', readFiles: new Set() }

    const approvals: Array<{ tool: string; approved: boolean }> = []
    const runner = new ToolRunner(tools, new PermissionGate(async (request) => {
      const approved = request.tool.riskLevel !== 'dangerous'
      approvals.push({ tool: request.tool.name, approved })
      return approved
    }, undefined, { cwd: dir }), {
      onRecord: async () => {}
    })

    // Safe tool: should execute without asking
    const readResult = await runner.run(
      { id: 'call1', name: 'Read', input: { filePath: 'test.txt' } },
      context
    )
    assert.equal(readResult.ok, true)
    assert.equal(approvals.length, 0) // No permission prompt for safe tools
    console.log('✓ Safe tool executed without prompt')

    // Confirm tool: should ask and approve
    const writeResult = await runner.run(
      { id: 'call2', name: 'Write', input: { filePath: 'new.txt', content: 'test' } },
      context
    )
    assert.equal(writeResult.ok, true)
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].approved, true)
    console.log('✓ Confirm tool prompted and approved')

    // Dangerous tool: should ask and deny
    const deleteResult = await runner.run(
      { id: 'call3', name: 'Delete', input: { filePath: 'test.txt' } },
      context
    )
    assert.equal(deleteResult.ok, false)
    assert.match(deleteResult.content, /denied/)
    assert.equal(approvals.length, 2)
    assert.equal(approvals[1].approved, false)
    console.log('✓ Dangerous tool prompted and denied')

  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('all builtin tools are callable', async () => {
  const tools = getBuiltinTools()

  console.log('\nBuiltin tools inventory:')
  tools.forEach(tool => {
    console.log(`  - ${tool.name} (${tool.riskLevel}): ${tool.description}`)
    assert.ok(tool.name)
    assert.ok(tool.description)
    assert.ok(['safe', 'confirm', 'dangerous'].includes(tool.riskLevel))
    assert.equal(typeof tool.execute, 'function')
  })

  const expectedTools = [
    'Grep',
    'Glob',
    'Bash',
    'KillShell',
    'Monitor',
    'Read',
    'Write',
    'Edit',
    'MultiEdit',
    'Delete',
    'EnterPlanMode',
    'ExitPlanMode',
    'AskUserQuestion',
    'SendMessage',
    'Config',
    'NotebookEdit',
    'WebFetch',
    'WebSearch',
    'TaskCreate',
    'TaskList',
    'TaskGet',
    'TaskUpdate',
  ]
  assert.deepEqual(tools.map((t) => t.name).sort(), [...expectedTools].sort())
  assert.equal(tools.length, expectedTools.length)
  console.log(`\n✓ All ${tools.length} tools are properly defined`)
})
