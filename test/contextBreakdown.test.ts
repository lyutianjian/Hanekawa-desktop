import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod/v3'
import { breakDownContext, fixedContextTokens, splitInstructionFiles } from '../src/harness/contextBreakdown.js'
import type { Tool } from '../src/harness/types.js'
import { contextPopoverView, shortenPath } from '../src/desktop/renderer/model/contextBreakdown.js'

function tool(name: string, description: string, isMcp = false): Tool {
  return { name, description, inputSchema: z.object({}), isMcp, execute: async () => '' } as unknown as Tool
}

const INSTRUCTIONS = [
  'Codebase and user instructions are shown below.',
  'Contents of /home/u/.myagent/AGENTS.md (user\'s private global instructions for all projects):\n\nbe brief',
  'Contents of /repo/AGENTS.md (project instructions, checked into the codebase):\n\n' + 'x'.repeat(300),
  'Contents of /data/memory/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n- [a](a.md)',
].join('\n\n')

test('the instruction files are split by their Contents-of headers', () => {
  const files = splitInstructionFiles(INSTRUCTIONS)
  assert.deepEqual(files.map((file) => file.path), ['/home/u/.myagent/AGENTS.md', '/repo/AGENTS.md', '/data/memory/MEMORY.md'])
  assert.match(files[1]!.text, /^Contents of \/repo\/AGENTS\.md/)
  assert.doesNotMatch(files[1]!.text, /MEMORY/)
  assert.deepEqual(splitInstructionFiles(''), [])
})

test('the categories sum to the used figure and the messages take the remainder', () => {
  const breakdown = breakDownContext({
    system: 'S'.repeat(3000) + '# Available skills\n' + 'k'.repeat(600),
    skillsSection: '# Available skills\n' + 'k'.repeat(600),
    loadedTools: [tool('Read', 'r'.repeat(300)), tool('mcp__a__x', 'm'.repeat(300), true)],
    deferredTools: [tool('mcp__a__y', 'd'.repeat(900), true)],
    instructions: INSTRUCTIONS,
  }, 50_000, false)

  const byKey = Object.fromEntries(breakdown.categories.map((row) => [row.key, row.tokens]))
  assert.equal(breakdown.categories.reduce((sum, row) => sum + row.tokens, 0), 50_000)
  assert.ok(byKey.skills! > 0 && byKey.system! > byKey.skills!)
  assert.ok(byKey.tools! > 0 && byKey.mcpTools! > 0)
  assert.ok(byKey.messages! > 40_000)
  assert.deepEqual(breakdown.deferred.map((row) => row.key), ['mcpTools'])
  assert.deepEqual(breakdown.mcpTools.map((row) => [row.name, row.deferred]), [['mcp__a__x', false], ['mcp__a__y', true]])
  assert.equal(breakdown.memoryFiles.length, 3)
})

test('the fixed parts do not move with the total', () => {
  const sources = {
    system: 'S'.repeat(30_000),
    loadedTools: [tool('Read', 'r'.repeat(3_000))],
    deferredTools: [],
  }
  const fixedRows = (used: number) => breakDownContext(sources, used, true).categories
    .filter((row) => row.key !== 'messages')
    .map((row) => row.tokens)
  assert.deepEqual(fixedRows(1_000), fixedRows(50_000))
  const low = breakDownContext(sources, 1_000, true)
  assert.equal(low.categories.find((row) => row.key === 'messages')!.tokens, 0)
  assert.equal(fixedContextTokens(sources), fixedRows(1_000).reduce((a, b) => a + b, 0))
})

test('the popover rows cover the model window: used parts, the compaction reserve and the free space', () => {
  const view = contextPopoverView({
    usedTokens: 30_000,
    estimated: true,
    categories: [
      { key: 'system', tokens: 4_000 },
      { key: 'skills', tokens: 0 },
      { key: 'messages', tokens: 26_000 },
    ],
    deferred: [{ key: 'mcpTools', tokens: 12_000 }],
    mcpTools: [],
    memoryFiles: [],
  }, 200_000, 180_000)

  assert.equal(view.percent, '17%')
  assert.equal(view.usage, '30k / 180k')
  assert.deepEqual(view.rows.map((row) => row.key), ['messages', 'system', 'buffer', 'free'])
  assert.deepEqual(view.rows.map((row) => row.percent), ['13.0%', '2.0%', '10.0%', '75.0%'])
  assert.equal(view.rows.reduce((sum, row) => sum + row.ratio, 0), 1)
  assert.deepEqual(view.deferred, [{ label: 'MCP 工具（延迟加载）', tokens: '12k' }])
  assert.ok(view.note)
})

test('long paths keep their root and their file name', () => {
  assert.equal(shortenPath('/repo/AGENTS.md'), '/repo/AGENTS.md')
  const short = shortenPath('/Users/someone/Documents/code/project/AGENTS.md')
  assert.ok(short.startsWith('/Users/'))
  assert.ok(short.endsWith('/AGENTS.md'))
  assert.ok(short.includes('…'))
})
