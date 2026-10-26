import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import test, { type TestContext } from 'node:test'
import { z } from 'zod/v3'
import { ApiKeyRedactor, REDACTED_API_KEY } from '../src/config/apiKeys.js'
import { ConfigService } from '../src/config/service.js'
import { PermissionGate } from '../src/harness/permissions.js'
import { ToolRunner } from '../src/harness/toolRunner.js'
import type { SessionRecord, Tool, ToolContext } from '../src/harness/types.js'
import { BackgroundTaskRegistry } from '../src/services/backgroundTasks/registry.js'
import { readFileTool } from '../src/tools/FileReadTool/FileReadTool.js'
import { writeFileTool } from '../src/tools/FileWriteTool/FileWriteTool.js'
import { editFileTool } from '../src/tools/FileEditTool/FileEditTool.js'
import { multiEditTool } from '../src/tools/MultiEditTool/MultiEditTool.js'
import { grepTool } from '../src/tools/GrepTool/GrepTool.js'
import { globTool } from '../src/tools/GlobTool/GlobTool.js'
import { createBashTool } from '../src/tools/BashTool/BashTool.js'

const SECRET = 'sk-config-private-1234567890'
const LEGACY_SECRET = 'sk-legacy-private-0987654321'

async function setup(t: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'global-config-access-'))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = root
  process.env.USERPROFILE = root
  const cwd = path.join(root, 'workspace')
  const globalDir = path.join(root, '.myagent')
  await mkdir(cwd)
  await mkdir(globalDir)
  const file = path.join(globalDir, 'config.json')
  await writeFile(file, JSON.stringify({
    endpoints: { api: { provider: 'anthropic', apiKey: SECRET, baseUrl: 'https://api.example.test' } },
    models: { main: { endpoint: 'api', model: 'public-model', contextWindow: 200000 } },
    defaultModel: 'main',
  }, null, 2) + '\n')
  await writeFile(path.join(globalDir, 'settings.json'), JSON.stringify({
    models: { legacy: { provider: 'anthropic', model: 'legacy-model', apiKey: LEGACY_SECRET } },
  }))
  const config = new ConfigService(cwd)
  await config.load()
  const registry = new BackgroundTaskRegistry(undefined, config.redactToolOutput)
  const tools = [readFileTool, writeFileTool, editFileTool, multiEditTool, grepTool, globTool, createBashTool(registry)]
  const records: SessionRecord[] = []
  const context: ToolContext = { cwd, sessionId: 'test-session', readFiles: new Set(), readFileState: new Map() }
  const runner = new ToolRunner(tools, new PermissionGate(async () => true, [], { cwd, mode: 'bypass' }), {
    onRecord: async (record) => { records.push(record) },
  }, {}, config.redactToolOutput)
  let calls = 0
  const run = (name: string, input: unknown) => runner.run({ name, input, id: `call-${++calls}` }, context)
  t.after(async () => {
    await registry.stopAll()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    await rm(root, { recursive: true, force: true })
  })
  return { cwd, file, globalDir, config, registry, run, records, runner, tools, context }
}

test('API key redaction preserves public fields, escaped JSON and instance isolation', () => {
  const redactor = new ApiKeyRedactor()
  const escaped = 'sk-quote-"-slash-\\-private'
  redactor.rememberConfig({ endpoints: { api: { apiKey: escaped } }, models: { main: { apiKey: SECRET } } })
  const content = JSON.stringify({ apiKey: escaped, model: 'public-model', baseUrl: 'https://api.example.test' })
  assert.deepEqual(JSON.parse(redactor.redact(content)), {
    apiKey: REDACTED_API_KEY, model: 'public-model', baseUrl: 'https://api.example.test',
  })
  assert.equal(redactor.redact(`token=${escaped}; ${SECRET}`), `token=${REDACTED_API_KEY}; ${REDACTED_API_KEY}`)
  assert.equal(new ApiKeyRedactor().redact(SECRET), SECRET)
})

test('Read, Grep and Bash expose global configuration without keys, including legacy config', async (t) => {
  const h = await setup(t)
  for (const name of ['config.json', 'settings.json']) {
    const file = path.join(h.globalDir, name)
    for (const [tool, input] of [
      ['Read', { filePath: file }],
      ['Grep', { path: h.globalDir, pattern: 'apiKey', outputMode: 'content' }],
      ['Bash', { command: `cat '${file}'` }],
    ] as const) {
      const result = await h.run(tool, input)
      assert.equal(result.ok, true, result.content)
      assert.match(result.content, /\[REDACTED\]/)
      assert.doesNotMatch(JSON.stringify(result), /sk-config-private|sk-legacy-private/)
    }
  }
  const read = await h.run('Read', { filePath: h.file, offset: 2, limit: 10 })
  assert.match(read.content, /public-model|api\.example\.test/)
  assert.doesNotMatch(JSON.stringify(h.records), /sk-config-private|sk-legacy-private/)
  assert.equal(h.config.getModel('main')?.apiKey, SECRET, 'provider authentication keeps the real key')
})

test('Bash extracted keys and split background output are redacted before model notifications', async (t) => {
  const h = await setup(t)
  const readKey = 'const k=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).endpoints.api.apiKey;'
  const command = `node -e '${readKey}process.stdout.write(k.slice(0,12));setTimeout(()=>process.stdout.write(k.slice(12)),20)' '${h.file}'`
  const result = await h.run('Bash', { command })
  assert.equal(result.ok, true, result.content)
  assert.equal(result.content, REDACTED_API_KEY)
  await h.run('Bash', { command, run_in_background: true })
  for (let i = 0; i < 200 && !h.registry.hasParentNotifications(h.context.sessionId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const notes = h.registry.consumeParentNotifications(h.context.sessionId)
  assert.equal(notes.length, 1)
  assert.match(notes[0]!, /\[REDACTED\]/)
  assert.doesNotMatch(notes[0]!, /sk-config-private/)
  const task = h.registry.getSnapshot(h.context.sessionId)[0]!
  assert.equal(h.registry.peekOutput(h.context.sessionId, task.id), REDACTED_API_KEY)
  const spilled = await h.run('Read', { filePath: task.outputPath })
  assert.match(spilled.content, /\[REDACTED\]/)
  assert.doesNotMatch(spilled.content, /sk-config-private/)
})

test('Edit and MultiEdit match the redacted config view and preserve API keys', async (t) => {
  const h = await setup(t)
  await h.run('Read', { filePath: h.file })
  const edit = await h.run('Edit', {
    filePath: h.file,
    oldString: '"apiKey": "[REDACTED]",\n      "baseUrl": "https://api.example.test"',
    newString: '"apiKey": "[REDACTED]",\n      "baseUrl": "https://new.example.test"',
  })
  assert.equal(edit.ok, true, edit.content)
  const multi = await h.run('MultiEdit', {
    filePath: h.file,
    edits: [
      { oldString: '"model": "public-model"', newString: '"model": "updated-model"' },
      { oldString: '"contextWindow": 200000', newString: '"contextWindow": 100000' },
    ],
  })
  assert.equal(multi.ok, true, multi.content)
  const saved = JSON.parse(await readFile(h.file, 'utf8'))
  assert.equal(saved.endpoints.api.apiKey, SECRET)
  assert.equal(saved.endpoints.api.baseUrl, 'https://new.example.test')
  assert.equal(saved.models.main.model, 'updated-model')
  assert.equal(saved.models.main.contextWindow, 100000)
  assert.doesNotMatch(JSON.stringify(h.records), /sk-config-private/)
})

test('Write preserves placeholder or omitted keys and refuses unmatched placeholders without changing the file', async (t) => {
  const h = await setup(t)
  for (const apiKey of [REDACTED_API_KEY, undefined]) {
    await h.run('Read', { filePath: h.file })
    const result = await h.run('Write', {
      filePath: h.file,
      content: JSON.stringify({ endpoints: { api: { provider: 'anthropic', apiKey, baseUrl: 'https://updated.example.test' } } }, null, 2),
    })
    assert.equal(result.ok, true, result.content)
    assert.equal(JSON.parse(await readFile(h.file, 'utf8')).endpoints.api.apiKey, SECRET)
  }
  const before = await readFile(h.file, 'utf8')
  const failed = await h.run('Write', { filePath: h.file, content: '{"endpoints":{"new":{"apiKey":"[REDACTED]"}}}' })
  assert.equal(failed.ok, false)
  assert.match(failed.content, /No existing API key/)
  assert.equal(await readFile(h.file, 'utf8'), before)
})

test('global config aliases stay redacted and a config reload refreshes extracted-key masking', async (t) => {
  const h = await setup(t)
  await symlink(h.globalDir, path.join(h.cwd, 'settings-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const alias = await h.run('Read', { filePath: 'settings-link/config.json' })
  assert.match(alias.content, /\[REDACTED\]/)
  assert.doesNotMatch(alias.content, /sk-config-private/)
  const updated = 'sk-replacement-private-111111'
  const content = (await readFile(h.file, 'utf8')).replace(SECRET, updated)
  await writeFile(h.file, content)
  await h.config.load()
  assert.equal(h.config.redactToolOutput(`${SECRET} ${updated}`), '[REDACTED] [REDACTED]')
})

test('tool output redaction covers metadata, mapped API blocks and thrown errors before persistence or truncation', async (t) => {
  const h = await setup(t)
  const tool: Tool = {
    name: 'SecretOutput', description: 'fixture', inputSchema: z.object({}).strict(), riskLevel: 'safe',
    maxResultSizeChars: 20,
    execute: async () => ({
      ok: false, content: SECRET, errorCode: 'execution_failed', errorDetails: { nested: [SECRET] },
      metadata: { display: { summary: SECRET, detail: SECRET }, assistantMessageContent: SECRET },
    }),
    mapToolResultToToolResultBlockParam: (_result, id) => ({
      type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text: SECRET }],
    }),
  }
  h.tools.push(tool)
  const result = await h.run(tool.name, {})
  assert.equal(result.content, REDACTED_API_KEY, 'redaction happens before the 20-character result budget')
  assert.deepEqual(result.errorDetails, { nested: [REDACTED_API_KEY] })
  assert.deepEqual(result.display, { summary: REDACTED_API_KEY, detail: REDACTED_API_KEY })
  assert.deepEqual(result.apiResultBlock, {
    type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: REDACTED_API_KEY }],
  })
  assert.ok(h.records.some((record) => record.type === 'message' && record.content === REDACTED_API_KEY))
  assert.doesNotMatch(JSON.stringify(h.records), /sk-config-private/)

  tool.execute = async () => { throw new Error(SECRET) }
  tool.maxResultSizeChars = undefined
  const forkRecords: SessionRecord[] = []
  const fork = h.runner.fork({ onRecord: async (record) => { forkRecords.push(record) } })
  const failed = await fork.run({ id: 'fork-call', name: tool.name, input: {} }, h.context)
  assert.equal(failed.ok, false)
  assert.equal(failed.errorCode, 'execution_failed')
  assert.match(failed.content, /\[REDACTED\]/)
  assert.doesNotMatch(JSON.stringify(forkRecords), /sk-config-private/)
})

test('Read masks keys before line truncation and masks API-key fields absent from loaded config', async (t) => {
  const h = await setup(t)
  const file = path.join(h.cwd, 'output.txt')
  await writeFile(file, `${'x'.repeat(1990)}${SECRET}\n{"apiKey":"sk-not-loaded-private","model":"visible"}\n`)
  const result = await h.run('Read', { filePath: file })
  assert.equal(result.ok, true, result.content)
  assert.match(result.content, /\[REDACTED\]/)
  assert.match(result.content, /visible/)
  assert.doesNotMatch(result.content, /sk-config|sk-not-loaded/)
})
