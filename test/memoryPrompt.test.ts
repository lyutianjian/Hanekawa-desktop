import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ContextBuilder } from '../src/harness/contextBuilder.js'
import {
  MEMORY_INDEX_MAX_BYTES,
  MEMORY_INDEX_MAX_LINES,
  buildMemoryIndexContext,
  buildMemoryPrompt,
  readMemoryIndex,
} from '../src/services/memory/memoryPrompt.js'
import { getUserInstructionsPath } from '../src/utils/paths.js'

async function memoryDir(t: test.TestContext, index?: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memory-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  if (index !== undefined) await writeFile(path.join(dir, 'MEMORY.md'), index, 'utf8')
  return dir
}

test('the index is labelled for the first message, and absent when it has no entries', async (t) => {
  assert.equal(readMemoryIndex(await memoryDir(t)), '')
  const empty = await memoryDir(t, '\n')
  assert.equal(readMemoryIndex(empty), '')
  assert.equal(buildMemoryIndexContext(empty), undefined)
  assert.ok(buildMemoryPrompt(empty, '').includes(empty))

  const dir = await memoryDir(t, '- [A](a.md) — one')
  assert.equal(buildMemoryIndexContext(dir), `Contents of ${path.join(dir, 'MEMORY.md')} (user's auto-memory, persists across conversations):\n\n- [A](a.md) — one`)
  assert.ok(!buildMemoryPrompt(dir, '').includes('- [A](a.md)'))
})

test('the section always locates the global instructions file, with auto memory only when on', async (t) => {
  const off = buildMemoryPrompt(undefined, ' \n')
  assert.ok(off.startsWith('# Memory\n\n## Global instructions'))
  assert.ok(off.includes(`\`${getUserInstructionsPath()}\` (currently empty)`))
  assert.ok(!off.includes('## Auto memory'))

  const on = buildMemoryPrompt(await memoryDir(t), 'USER')
  assert.ok(on.includes('its contents are loaded at the start of the conversation'))
  assert.ok(on.indexOf('## Global instructions') < on.indexOf('## Auto memory'))
})

test('an index within the caps is loaded whole', async (t) => {
  const index = '- [A](a.md) — one\n- [B](b.md) — two'
  assert.equal(readMemoryIndex(await memoryDir(t, index)), index)
})

test('too many lines are cut on a line boundary with a notice', async (t) => {
  const lines = Array.from({ length: MEMORY_INDEX_MAX_LINES + 5 }, (_, i) => `- [n${i}](n${i}.md) — hook`)
  const out = readMemoryIndex(await memoryDir(t, lines.join('\n')))
  assert.ok(out.startsWith(lines.slice(0, MEMORY_INDEX_MAX_LINES).join('\n') + '\n'))
  assert.ok(!out.includes(`n${MEMORY_INDEX_MAX_LINES}.md`))
  assert.match(out, /only the first 200 lines were loaded/)
})

test('the byte cap counts UTF-8 bytes, so multi-byte lines hit it before the line cap', async (t) => {
  const line = '- [记忆](m.md) — ' + '中'.repeat(55)
  const lines = Array.from({ length: 150 }, () => line)
  assert.ok(lines.join('\n').length < MEMORY_INDEX_MAX_BYTES)
  const out = readMemoryIndex(await memoryDir(t, lines.join('\n')))
  const body = out.split('\n\n> ')[0]!
  assert.ok(Buffer.byteLength(body, 'utf8') <= MEMORY_INDEX_MAX_BYTES)
  assert.ok(body.split('\n').every((l) => l === line))
  assert.match(out, /Shorten the entries/)
})

test('instruction files and the memory index open the conversation, outside the system prompt and the budget cut', async () => {
  const builder = new ContextBuilder(undefined, { contextWindow: 8000, summaryOutputTokens: 0 })
  const records = Array.from({ length: 40 }, (_, i) => ({
    type: 'message' as const,
    id: `m${i}`,
    role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
    content: `turn ${i} ${'x '.repeat(400)}`,
    createdAt: '2026-05-10T00:00:00.000Z',
  }))
  const built = await builder.build({ records, tools: [], projectContext: 'PROJECT RULES', memoryIndex: 'MEMORY INDEX' })
  assert.ok(!built.messages.some((message) => message.id === 'm0'), 'the budget cut dropped the oldest turns')
  // The instructions are counted into the budget: a long set leaves room for less history.
  const plain = await builder.build({ records, tools: [] })
  const heavy = await builder.build({ records, tools: [], projectContext: 'rule '.repeat(2000) })
  assert.ok(heavy.messages.length - 1 < plain.messages.length, `${heavy.messages.length - 1} kept with the instructions, ${plain.messages.length} without`)
  assert.equal(built.messages[0]?.content, '<system-reminder>\nPROJECT RULES\n\nMEMORY INDEX\n</system-reminder>')
  assert.ok(!built.system?.includes('PROJECT RULES'))
  assert.ok(!built.system?.includes('MEMORY INDEX'))
})

test('the memory section reaches the system prompt only when handed to the builder', async () => {
  const builder = new ContextBuilder(undefined, { contextWindow: 8000, summaryOutputTokens: 0 })
  const input = { records: [], tools: [] }
  const withMemory = await builder.build({ ...input, memoryPrompt: '# Auto memory\nbody' })
  const without = await builder.build(input)
  assert.ok(withMemory.system?.includes('# Auto memory'))
  assert.ok(!without.system?.includes('# Auto memory'))
})
