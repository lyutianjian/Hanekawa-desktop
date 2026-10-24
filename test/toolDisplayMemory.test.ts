import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import type { SessionRecord } from '../src/harness/types.js'
import { isMemoryCall, projectToolDisplays } from '../src/runtime/protocol/host.js'

const memoryDir = path.resolve('/scratch/data/memory')
const inMemory = path.join(memoryDir, 'user-role.md')

test('isMemoryCall: file tools on a file directly in the memory dir, searches rooted at it', () => {
  const cases: Array<[string, unknown, boolean]> = [
    ['Read', { filePath: inMemory }, true],
    ['Write', { filePath: inMemory, content: '' }, true],
    ['Edit', { filePath: path.join(memoryDir, 'MEMORY.md') }, true],
    ['MultiEdit', { filePath: inMemory }, true],
    ['Delete', { filePath: inMemory }, true],
    ['Grep', { pattern: 'x', path: memoryDir }, true],
    ['Glob', { pattern: '*.md', path: `${memoryDir}${path.sep}` }, true],
    ['Read', { filePath: path.join(memoryDir, 'sub', 'a.md') }, false],
    ['Read', { filePath: path.resolve('/scratch/project/a.md') }, false],
    ['Grep', { pattern: 'x', path: path.resolve('/scratch/project') }, false],
    ['Grep', { pattern: 'x' }, false],
    ['Bash', { command: `cat ${inMemory}` }, false],
    ['Read', null, false],
  ]
  for (const [tool, input, expected] of cases) {
    assert.equal(isMemoryCall(tool, input, memoryDir), expected, `${tool} ${JSON.stringify(input)}`)
  }
})

test('projectToolDisplays marks memory calls only when given the memory dir', () => {
  const records: SessionRecord[] = [
    { type: 'tool_use', id: 'a', tool: 'Read', input: { filePath: inMemory }, riskLevel: 'safe', createdAt: 'now' },
    { type: 'tool_use', id: 'b', tool: 'Read', input: { filePath: path.resolve('/scratch/project/a.md') }, riskLevel: 'safe', createdAt: 'now' },
  ]
  const marked = projectToolDisplays(records, memoryDir)!
  assert.equal(marked.a!.memory, true)
  assert.equal('memory' in marked.b!, false)
  assert.equal('memory' in projectToolDisplays(records)!.a!, false)
})
