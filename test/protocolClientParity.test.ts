import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SessionClient } from '../src/runtime/protocol/client.js'

/**
 * The acceptance test for "a renderer needs nothing but a SessionClient".
 *
 * Stage 2b's rule is that the renderer never imports the harness. That only
 * holds if every capability the TUI gets by holding a live `RuntimeHost` has a
 * wire path, so the table below is the executable version of that gap list: it
 * fails the moment an App prop gains no counterpart on the client.
 */

const repoRoot = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

/** Every prop `tui.tsx` hands to `App`, mapped to its client-side replacement. */
const COVERAGE: Array<{ prop: string; via: 'client' | 'shell'; members: string[]; note?: string }> = [
  { prop: 'runtimeSlot', via: 'client', members: ['getRuntimeSnapshot', 'subscribe'] },
  {
    prop: 'sessionController',
    via: 'client',
    members: ['onEvent', 'getSnapshot', 'subscribe', 'submit', 'interrupt', 'reload'],
  },
  {
    prop: 'store',
    via: 'client',
    members: ['listSessions', 'createSession', 'retarget', 'truncateSession', 'summarizeRewind'],
    note: 'the two rewind writes are the store methods RestoreMode reaches for',
  },
  { prop: 'session', via: 'client', members: ['hello', 'getSession'] },
  {
    prop: 'commands',
    via: 'client',
    members: ['listCommands', 'runCommand'],
    note: 'the registry is per-project now; a renderer reads it over the wire instead of importing commands/',
  },
  { prop: 'availableModelKeys', via: 'client', members: ['listModels'] },
  { prop: 'providerConfig', via: 'client', members: ['listModels', 'resolveModel', 'setDefaultModel'] },
  { prop: 'createRuntime', via: 'client', members: ['setModel', 'retarget', 'createSession'] },
  { prop: 'createActiveModelRuntime', via: 'client', members: ['submit'] },
  { prop: 'permissionGate', via: 'client', members: ['getRuntimeSnapshot', 'setPermissionMode'] },
  { prop: 'promptProxy', via: 'client', members: ['setHandlers'] },
  { prop: 'exitPlanProxy', via: 'client', members: ['setHandlers'] },
  { prop: 'enterPlanProxy', via: 'client', members: ['setHandlers'] },
  { prop: 'askUserQuestionProxy', via: 'client', members: ['setHandlers'] },
  {
    prop: 'steerProxy',
    via: 'client',
    members: ['enqueueMessage'],
    note: 'the host attaches its own queue; a client steers by enqueueing mid-turn',
  },
  { prop: 'existingRecords', via: 'client', members: ['hello', 'reload'] },
  { prop: 'initialSystemMessages', via: 'client', members: ['hello'] },
  { prop: 'initialQueuedPrompt', via: 'client', members: ['hello'] },
  { prop: 'onBeforeExit', via: 'client', members: ['shutdown'] },
  { prop: 'reloadAgentDefinitions', via: 'client', members: ['reloadAgents'] },
  { prop: 'reloadSkills', via: 'client', members: ['reloadSkills'] },
  { prop: 'onEffortLevelChange', via: 'client', members: ['setEffort'] },
  {
    prop: 'onThinkingChange',
    via: 'client',
    members: ['runCommand'],
    note: 'the renderer reaches the same switch through /thinking and the settings screen',
  },
  {
    prop: 'backgroundTasks',
    via: 'client',
    members: ['getBackgroundTasks', 'listBackgroundTasks', 'peekTaskOutput', 'killTask'],
  },
  {
    prop: 'attachments',
    via: 'client',
    members: ['importAttachment', 'removeAttachment', 'getAttachmentPreview', 'openAttachment'],
    note: 'the TUI holds the in-process service for its composer drafts; a renderer drives the same store through the four attachment commands',
  },
  {
    prop: 'onPermissionModeChange',
    via: 'client',
    members: ['getRuntimeSnapshot'],
    note: 'pushed as a runtime-snapshot, now including PermissionGate-driven changes',
  },
]

/**
 * Capabilities that are not App props but carry the same acceptance criterion: a
 * renderer holding only a client has to be able to reach them.
 */
const NON_PROP_COVERAGE: Array<{ capability: string; members: string[] }> = [
  // `useCommands` is a hook rather than a prop, and its whole `CommandContext`
  // is built host-side now; the effects are how its seven renderer-side members
  // come back out.
  { capability: 'slash commands', members: ['runCommand', 'onCommandEffect'] },
  { capability: '/rewind write path', members: ['truncateSession', 'summarizeRewind', 'restoreCode'] },
  // Image attachments have no App prop yet (the composer wiring is S11), but
  // the acceptance criterion already applies: a renderer holding only a client
  // imports, previews, removes and opens them without touching `services/`.
  {
    capability: 'image attachments',
    members: ['importAttachment', 'removeAttachment', 'getAttachmentPreview', 'openAttachment', 'submit'],
  },
]

test('every App prop has a SessionClient counterpart', () => {
  const client = Object.create(SessionClient.prototype) as Record<string, unknown>
  const instanceFields = new Set(['getSnapshot', 'subscribe', 'getBackgroundTasks', 'getSession'])

  for (const entry of COVERAGE) {
    for (const member of entry.members) {
      const present = typeof client[member] === 'function' || instanceFields.has(member)
      assert.ok(present, `App prop "${entry.prop}" maps to SessionClient.${member}, which does not exist`)
    }
  }

  for (const entry of NON_PROP_COVERAGE) {
    for (const member of entry.members) {
      const present = typeof client[member] === 'function' || instanceFields.has(member)
      assert.ok(present, `"${entry.capability}" needs SessionClient.${member}, which does not exist`)
    }
  }
})

test('the client half never imports the harness at runtime', async () => {
  const source = await readFile(path.join(repoRoot, 'src/runtime/protocol/client.ts'), 'utf8')

  const imports = [...source.matchAll(/^import\s+(type\s+)?[\s\S]*?from\s+'([^']+)'/gm)]
  assert.ok(imports.length > 0, 'expected to parse some imports')

  for (const [statement, typeOnly, specifier] of imports) {
    if (
      !specifier!.includes('harness/')
      && !specifier!.includes('services/')
      && !specifier!.includes('sessions/')
      // A value import here would drag the whole slash-command registry, and
      // through `skills.ts` the filesystem, into a renderer bundle.
      && !specifier!.includes('commands/')
    ) {
      continue
    }
    const isTypeOnly = Boolean(typeOnly) || !/^import\s+(?!type)[^{]*\{[^}]*\b(?!type\b)\w/.test(statement!)
    assert.ok(
      isTypeOnly || statement!.includes('import type'),
      `client.ts must only type-import ${specifier}; a value import drags the harness into a renderer bundle`,
    )
  }

  assert.ok(!source.includes("from '../../tui/"), 'the client must not reach into the TUI')
  assert.ok(!/from '[^']*\bink\b/.test(source), 'the client must not import Ink')
  assert.ok(!/from 'react'/.test(source), 'the client must not import React')
  // Inbound validation is the host's job. Mirroring it here would put zod in a
  // renderer bundle to re-check messages the host already produced.
  assert.ok(!/from 'zod/.test(source), 'the client must not import zod')
  assert.ok(!source.includes('commandSchema'), 'the client must not import the command schema')
})
