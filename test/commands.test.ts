import test from 'node:test'
import assert from 'node:assert/strict'
import { clearCommand } from '../src/commands/clear.js'
import { compactCommand } from '../src/commands/compact.js'
import { costCommand } from '../src/commands/cost.js'
import { modelCommand } from '../src/commands/model.js'
import { repairCommand } from '../src/commands/repair.js'
import { agentsCommand } from '../src/commands/agents.js'
import { planCommand } from '../src/commands/plan.js'
import { providerCommand } from '../src/commands/provider.js'
import { tasksCommand } from '../src/commands/tasks.js'
import { resumeCommand } from '../src/commands/resume.js'
import { sessionCommand } from '../src/commands/session.js'
import { pasteImageCommand } from '../src/commands/pasteImage.js'
import { attachmentsCommand } from '../src/commands/attachments.js'
import { CommandRegistry, registerBuiltinCommands } from '../src/commands/index.js'
import type { CommandContext, CommandView } from '../src/commands/types.js'

function createContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    cwd: '/tmp/project',
    sessionId: 'session-1',
    writeLine: () => {},
    clearMessages: () => {},
    ...overrides,
  }
}

test('built-in command registry includes /plan and excludes /bypass', () => {
  const registry = new CommandRegistry()
  registerBuiltinCommands(registry)

  assert.equal(registry.get('plan')?.name, 'plan')
  assert.equal(registry.get('resume')?.name, 'resume')
  assert.equal(registry.get('bypass'), undefined)
})

test('/cost reports injected usage and real cost', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 100_000,
      inputTokens: 200_000,
      outputTokens: 50_000,
      cost: 0.31,
      currency: 'CNY',
    }),
  }))

  assert.match(output, /Cache read:\s+100,000/)
  assert.match(output, /Input tokens:\s+200,000/)
  assert.match(output, /Output tokens:\s+50,000/)
  assert.match(output, /Total cost:\s+CNY 0\.31/)
})

test('/cost reports cache summary when available', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 100,
      inputTokens: 100,
      outputTokens: 50,
    }),
    getSessionMetricsSummary: async () => ({
      totalCacheHitRate: 0.625,
      totalTurns: 8,
      firstBreakTurnCount: 3,
      cacheBreakCount: 2,
      averageCompactIntervalTurns: 4.5,
    }),
  }))

  assert.match(output, /Session cache:/)
  assert.match(output, /Cache hit rate:\s+62\.5%/)
  assert.match(output, /First break turn:\s+3/)
  assert.match(output, /Avg compact interval:\s+4\.5 turns/)
})

test('/cost reports unavailable cache summary fields as n\\/a', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
    }),
    getSessionMetricsSummary: async () => ({
      totalCacheHitRate: null,
      totalTurns: 0,
      firstBreakTurnCount: null,
      cacheBreakCount: 0,
      averageCompactIntervalTurns: null,
    }),
  }))

  assert.match(output, /Cache hit rate:\s+n\/a/)
  assert.match(output, /First break turn:\s+n\/a/)
  assert.match(output, /Avg compact interval:\s+n\/a/)
})

test('/cost does not report fake cost without pricing', async () => {
  let output = ''
  await costCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getUsage: () => ({
      cacheReadInputTokens: 0,
      inputTokens: 10,
      outputTokens: 20,
    }),
  }))

  assert.match(output, /Total cost:\s+unavailable \(missing pricing\)/)
  assert.doesNotMatch(output, /\$0\.0000/)
})

test('/model without args shows current model key and provider model id', async () => {
  let output = ''
  await modelCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    getModel: () => ({
      key: 'claude',
      providerName: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }),
  }))

  assert.match(output, /Name:\s+claude/)
  assert.match(output, /Provider:\s+anthropic/)
  assert.match(output, /Model ID:\s+claude-sonnet-4-20250514/)
})

test('/model without args opens model picker when available', async () => {
  let opened = false
  let output = ''
  await modelCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
    openModelPicker: () => {
      opened = true
    },
    getModel: () => ({
      key: 'claude',
      providerName: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    }),
  }))

  assert.equal(opened, true)
  assert.equal(output, '')
})

test('/model with args delegates model switching', async () => {
  let requestedModel = ''
  let output = ''
  let cleared = false
  await modelCommand.run('openai-compatible', createContext({
    writeLine: (message) => {
      output = message
    },
    clearCachedSections: () => {
      cleared = true
    },
    setModel: (model) => {
      requestedModel = model
      return {
        ok: true,
        model: {
          key: model,
          providerName: 'openai',
          model: 'deepseek-chat',
        },
      }
    },
  }))

  assert.equal(requestedModel, 'openai-compatible')
  assert.equal(cleared, true)
  // Nothing printed: the live model is already on screen in both shells, so the
  // switch leaves no row behind to outlive it.
  assert.equal(output, '')
})

test('/model prints the image-impact notice on its own', async () => {
  let output = ''
  await modelCommand.run('text-only', createContext({
    writeLine: (message) => {
      output = message
    },
    setModel: (model) => ({
      ok: true,
      model: { key: model, providerName: 'openai', model: 'text-only-model' },
      notice: 'text-only-model does not accept images: the 2 images in this conversation will be sent as file paths instead.',
    }),
  }))

  // Reported, never a second confirmation: the switch already happened, and the
  // notice is the only part of it nothing else on screen carries.
  assert.match(output, /^text-only-model does not accept images/)
  assert.match(output, /2 images in this conversation/)
  assert.doesNotMatch(output, /Model set to/)
})

test('/model reports available models when switch target is unknown', async () => {
  let output = ''
  let tone: string | undefined
  let cleared = false
  await modelCommand.run('missing', createContext({
    writeLine: (message, lineTone) => {
      output = message
      tone = lineTone
    },
    clearCachedSections: () => {
      cleared = true
    },
    setModel: () => ({
      ok: false,
      message: '未知模型：missing',
      availableModels: ['claude', 'openai-compatible'],
    }),
  }))

  assert.match(output, /未知模型：missing/)
  assert.match(output, /可用模型：claude、openai-compatible/)
  assert.equal(tone, 'error')
  assert.equal(cleared, false)
})

test('/clear clears messages before writing confirmation', async () => {
  const events: string[] = []
  await clearCommand.run('', createContext({
    clearMessages: async () => {
      events.push('clear')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.deepEqual(events, [
    'clear',
    'clear-cache',
    'Conversation cleared. Started a new session.',
  ])
})

test('/compact reset clears persistent failure circuit', async () => {
  const events: string[] = []
  await compactCommand.run('reset', createContext({
    resetCompactFailureCount: async () => {
      events.push('reset')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.deepEqual(events, [
    'reset',
    'clear-cache',
    'Auto-compact failure circuit reset.',
  ])
})

test('/model delegates its raw argument to the runtime resolver', async () => {
  let requestedModel = ''
  let output = ''
  await modelCommand.run('opus-like', createContext({
    writeLine: (message) => {
      output = message
    },
    setModel: (model) => {
      requestedModel = model
      return {
        ok: true,
        model: {
          key: 'opus-like',
          providerName: 'openai',
          model: 'configured-power-model',
        },
      }
    },
  }))

  assert.equal(requestedModel, 'opus-like')
  assert.equal(output, '')
})

test('/model inherit reports runtime rejection', async () => {
  let output = ''
  await modelCommand.run('inherit', createContext({
    writeLine: (message) => {
      output = message
    },
    setModel: () => ({
      ok: false,
      message: '/model inherit is not supported. inherit is only valid in routing/subagent settings.',
    }),
  }))

  assert.match(output, /inherit is not supported/)
})

test('/plan enters plan mode without opening a missing plan file', async () => {
  const events: string[] = []
  let entered = false
  let opened = false
  await planCommand.run('open', createContext({
    getPermissionMode: () => 'default',
    enterPlanMode: () => { entered = true },
    openPlanFile: async () => {
      opened = true
      return { message: 'opened' }
    },
    writeLine: (message) => { events.push(message) },
  }))

  assert.equal(entered, true)
  assert.equal(opened, false)
  assert.deepEqual(events, ['Enabled plan mode.'])
})

test('/plan with description enters plan mode and submits the description', async () => {
  const submitted: string[] = []
  const events: string[] = []
  await planCommand.run('Design Plan Please', createContext({
    getPermissionMode: () => 'default',
    enterPlanMode: () => {},
    submitQuery: async (input) => { submitted.push(input) },
    writeLine: (message) => { events.push(message) },
  }))

  assert.deepEqual(events, ['Enabled plan mode.'])
  assert.deepEqual(submitted, ['Design Plan Please'])
})

test('/plan in plan mode reports empty draft path', async () => {
  let output = ''
  await planCommand.run('', createContext({
    getPermissionMode: () => 'plan',
    readPlanFile: async () => ({ path: '/tmp/project/.myagent/plans/test.md', content: null }),
    writeLine: (message) => { output = message },
  }))

  assert.match(output, /No draft plan written yet/)
  assert.match(output, /test\.md/)
})

test('/plan open in plan mode opens only after content exists', async () => {
  const events: string[] = []
  let opened = false
  await planCommand.run('open', createContext({
    getPermissionMode: () => 'plan',
    readPlanFile: async () => ({ path: '/tmp/project/.myagent/plans/test.md', content: '# Plan\n' }),
    openPlanFile: async () => {
      opened = true
      return { message: 'Opened plan in editor: /tmp/project/.myagent/plans/test.md' }
    },
    writeLine: (message) => { events.push(message) },
  }))

  assert.equal(opened, true)
  assert.deepEqual(events, ['Opened plan in editor: /tmp/project/.myagent/plans/test.md'])
})

test('/repair runs session repair and invalidates caches', async () => {
  const events: string[] = []
  await repairCommand.run('', createContext({
    repairRecords: async () => ({
      repairedCount: 1,
      diagnostics: [{ message: 'Inserted synthetic tool_result for orphan tool_use record: call-1' }],
    }),
    invalidateRecordsCache: () => {
      events.push('invalidate-records')
    },
    clearCachedSections: () => {
      events.push('clear-cache')
    },
    writeLine: (message) => {
      events.push(message)
    },
  }))

  assert.equal(events[0], 'invalidate-records')
  assert.equal(events[1], 'clear-cache')
  assert.match(events[2] ?? '', /Session invariants repaired/)
  assert.match(events[2] ?? '', /Inserted synthetic tool_result/)
})

test('/agents reload delegates to agent definition reloader', async () => {
  const events: string[] = []
  await agentsCommand.run('reload', createContext({
    writeLine: (message) => {
      events.push(message)
    },
    reloadAgentDefinitions: async () => 2,
  }))

  assert.deepEqual(events, ['Reloaded 2 custom agent definitions.'])
})

test('/agents reports usage for unknown subcommands', async () => {
  let output = ''
  await agentsCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
  }))

  assert.match(output, /Usage: \/agents reload\|list\|show/)
})

test('/agents list renders compact task table', async () => {
  let output = ''
  await agentsCommand.run('list', createContext({
    writeLine: (message) => {
      output = message
    },
    listSubagentTasks: async () => [
      {
        id: 'task-1',
        type: 'subagent_task',
        agentId: 'abcdef123456',
        subagentType: 'plan',
        status: 'completed',
        description: 'Plan the change',
        task: 'Plan',
        summary: 'Ready',
        createdAt: new Date().toISOString(),
      },
    ],
  }))

  assert.match(output, /status\s+agent\s+age\s+summary\s+id/)
  assert.match(output, /completed\s+plan\s+\d+s\s+Ready\s+abcdef12/)
})

test('/agents show renders transcript and worktree details', async () => {
  let output = ''
  await agentsCommand.run('show abcdef12', createContext({
    writeLine: (message) => {
      output = message
    },
    getSubagentDetails: async () => ({
      task: {
        id: 'task-1',
        type: 'subagent_task',
        agentId: 'abcdef123456',
        subagentType: 'explore',
        status: 'completed',
        description: 'Explore codebase',
        task: 'Explore',
        transcriptPath: '/tmp/agent.jsonl',
        worktreePath: '/tmp/hanekawa-subagent-worktrees/repo/session/agent',
        worktreeChangeSummary: 'No changes.',
        usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
        criticalFiles: ['src/a.ts'],
        createdAt: new Date().toISOString(),
      },
      transcript: {
        id: 'transcript-1',
        type: 'subagent_transcript',
        agentId: 'abcdef123456',
        subagentType: 'explore',
        transcriptPath: '/tmp/agent.jsonl',
        usage: { inputTokens: 1, cacheReadInputTokens: 2, outputTokens: 3 },
        createdAt: new Date().toISOString(),
      },
      transcriptRecords: [],
    }),
  }))

  assert.match(output, /agent: explore #abcdef12/)
  assert.match(output, /status: completed/)
  assert.match(output, /transcript: \/tmp\/agent\.jsonl/)
  assert.match(output, /worktree:/)
})

test('/agents cleanup defaults to dry-run', async () => {
  let output = ''
  let applyValue: boolean | undefined
  await agentsCommand.run('cleanup', createContext({
    writeLine: (message) => {
      output = message
    },
    cleanupSubagentWorktrees: async ({ apply }) => {
      applyValue = apply
      return {
        dryRun: !apply,
        entries: [{
          agentId: 'abcdef123456',
          status: 'completed',
          worktreePath: '/tmp/hanekawa-subagent-worktrees/repo/session/agent',
          exists: true,
        }],
      }
    },
  }))

  assert.equal(applyValue, false)
  assert.match(output, /dry-run/)
  assert.match(output, /would remove/)
})

test('/agents cleanup --apply delegates removal', async () => {
  let output = ''
  let applyValue: boolean | undefined
  await agentsCommand.run('cleanup --apply', createContext({
    writeLine: (message) => {
      output = message
    },
    cleanupSubagentWorktrees: async ({ apply }) => {
      applyValue = apply
      return {
        dryRun: !apply,
        entries: [{
          agentId: 'abcdef123456',
          status: 'completed',
          worktreePath: '/tmp/hanekawa-subagent-worktrees/repo/session/agent',
          exists: true,
          removed: true,
        }],
      }
    },
  }))

  assert.equal(applyValue, true)
  assert.match(output, /cleanup/)
  assert.match(output, /removed/)
})

test('/provider opens provider panel when available', async () => {
  let opened = false
  await providerCommand.run('', createContext({
    openProviderPanel: () => {
      opened = true
    },
  }))

  assert.equal(opened, true)
})

test('/provider reports unavailable outside TUI panel host', async () => {
  let output = ''
  await providerCommand.run('', createContext({
    writeLine: (message) => {
      output = message
    },
  }))

  assert.match(output, /unavailable/)
})

test('/help opens a structured list view when hosted by the TUI', async () => {
  const registry = new CommandRegistry()
  registerBuiltinCommands(registry)
  let view: CommandView | undefined
  await registry.get('help')!.run('', createContext({
    openCommandView: (next) => { view = next },
    writeLine: () => assert.fail('structured help should not write into chat'),
  }))

  assert.equal(view?.kind, 'list')
  assert.equal(view?.title, 'Help')
  assert.ok(view?.kind === 'list' && view.items.some((item) => item.label === '/help'))
})

test('/session opens a structured information view when hosted by the TUI', async () => {
  let view: CommandView | undefined
  await sessionCommand.run('', createContext({
    openCommandView: (next) => { view = next },
    writeLine: () => assert.fail('structured session should not write into chat'),
  }))

  assert.equal(view?.kind, 'info')
  assert.ok(view?.kind === 'info' && view.sections[0]?.rows.some((row) => row.value === 'session-1'))
})

test('/cost opens a structured information view without losing cache metrics', async () => {
  let view: CommandView | undefined
  await costCommand.run('', createContext({
    openCommandView: (next) => { view = next },
    getUsage: () => ({ cacheReadInputTokens: 100, inputTokens: 200, outputTokens: 50 }),
    getSessionMetricsSummary: async () => ({
      totalCacheHitRate: 0.5,
      totalTurns: 2,
      firstBreakTurnCount: null,
      cacheBreakCount: 0,
      averageCompactIntervalTurns: null,
    }),
  }))

  assert.equal(view?.kind, 'info')
  assert.ok(view?.kind === 'info' && view.sections.some((section) => section.title === 'Prompt cache'))
})

test('/resume opens the in-session picker only without arguments', async () => {
  let opened = 0
  const output: string[] = []
  const context = createContext({
    openResumePicker: () => { opened += 1 },
    writeLine: (message) => { output.push(message) },
  })

  await resumeCommand.run('', context)
  await resumeCommand.run('abc123', context)

  assert.equal(opened, 1)
  assert.deepEqual(output, ['Usage: /resume'])
})

test('/tasks opens the background task panel', async () => {
  let opened = false
  await tasksCommand.run('', createContext({ openBackgroundTasks: () => { opened = true } }))
  assert.equal(opened, true)
})

test('registry includes the image attachment commands', () => {
  const registry = new CommandRegistry()
  registerBuiltinCommands(registry)

  assert.equal(registry.get('paste-image')?.name, 'paste-image')
  assert.equal(registry.get('attachments')?.name, 'attachments')
})

test('/paste-image runs the shell capture only when the shell provides it', async () => {
  const unavailable: string[] = []
  await pasteImageCommand.run('', createContext({
    writeLine: (message) => { unavailable.push(message) },
  }))
  assert.deepEqual(unavailable, ['Clipboard image paste is not available in this shell.'])

  let captured = 0
  await pasteImageCommand.run('', createContext({
    pasteImageFromClipboard: async () => { captured += 1 },
  }))
  assert.equal(captured, 1)
})

test('/attachments lists, removes by number, and clears the draft', async () => {
  const output: string[] = []
  const draft = ['[图片 1：screenshot.png，1920×1080]', '[图片 2：anim.gif，800×600，动画首帧]']
  let current = draft
  const context = createContext({
    writeLine: (message) => { output.push(message) },
    listDraftAttachments: () => current,
    removeDraftAttachment: (index: number) => {
      if (index !== 1) return { ok: false, message: `No image ${index}; the draft has ${current.length}.` }
      current = current.slice(1)
      return { ok: true }
    },
    clearDraftAttachments: () => { current = [] },
  })

  await attachmentsCommand.run('', context)
  await attachmentsCommand.run('list', context)
  await attachmentsCommand.run('remove 1', context)
  await attachmentsCommand.run('remove 5', context)
  await attachmentsCommand.run('clear', context)
  await attachmentsCommand.run('', context)
  await attachmentsCommand.run('explode', context)

  assert.deepEqual(output, [
    `Draft images (attached to your next message):\n${draft.join('\n')}`,
    `Draft images (attached to your next message):\n${draft.join('\n')}`,
    'Removed image 1.',
    'No image 5; the draft has 1.',
    'Draft images cleared.',
    'No draft images. Paste an image path, or use /paste-image.',
    'Usage: /attachments [list | remove <n> | clear]',
  ])
})

test('/attachments reports shells without a draft composer', async () => {
  const output: string[] = []
  await attachmentsCommand.run('list', createContext({
    writeLine: (message) => { output.push(message) },
  }))
  assert.deepEqual(output, ['Draft image attachments are not available in this shell.'])
})
