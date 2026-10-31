import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import { z } from 'zod/v3'
import {
  PermissionGate,
  checkWindowsPathSafety,
  createSessionRuleStore,
  isProtectedPath,
  permissionRulesFromSettings,
  permissionRuleToEntry,
  type PermissionRule,
} from '../src/harness/permissions.js'
import { localSettingsPath, persistPermissionRule } from '../src/config/settings.js'
import { bashTool } from '../src/tools/BashTool/BashTool.js'
import type { Tool } from '../src/harness/types.js'
import { getProjectPlansDir } from '../src/utils/paths.js'

const fsWriteTool: Tool = {
  name: 'fsWrite',
  description: 'Write a file',
  riskLevel: 'confirm',
  inputSchema: z.object({
    path: z.string().optional(),
    filePath: z.string().optional(),
  }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

const writeFileTool: Tool = {
  ...fsWriteTool,
  name: 'Write',
}

const editFileTool: Tool = {
  ...fsWriteTool,
  name: 'Edit',
}

const multiEditFileTool: Tool = {
  ...fsWriteTool,
  name: 'MultiEdit',
}

const deleteFileTool: Tool = {
  ...fsWriteTool,
  name: 'Delete',
  riskLevel: 'dangerous',
  isDestructive: true,
}

const readFileTool: Tool = {
  name: 'Read',
  description: 'Read a file',
  riskLevel: 'safe',
  isReadOnly: true,
  inputSchema: z.object({
    filePath: z.string(),
  }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

/**
 * A configured deny rule is the only thing that still denies without asking, so
 * it is what the denial-streak cases drive. Safety findings prompt instead.
 */
const DENIED_COMMAND = 'curl https://example.com'
const DENY_RULES: PermissionRule[] = [
  { toolName: 'Bash', contentPattern: 'curl:*', behavior: 'deny', source: 'config' },
]

const skillTool: Tool = {
  name: 'Skill',
  description: 'Load a skill',
  riskLevel: 'safe',
  inputSchema: z.object({}).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

test('PermissionGate keeps bulk session rules separate from config rules', () => {
  const configRules: PermissionRule[] = [
    { toolName: 'Bash', behavior: 'deny', source: 'config' },
  ]
  const sessionRules: PermissionRule[] = [
    { toolName: 'fsWrite', behavior: 'allow', source: 'session' },
  ]
  const gate = new PermissionGate(async () => true, configRules)

  gate.addSessionRules(sessionRules)

  assert.deepEqual(gate.getConfigRules(), configRules)
  assert.deepEqual(gate.getSessionRules(), sessionRules)
})

test('PermissionGate routes bulk rules by source field', () => {
  const configRule: PermissionRule = { toolName: 'Bash', behavior: 'deny', source: 'config' }
  const sessionRule: PermissionRule = { toolName: 'fsWrite', behavior: 'allow', source: 'session' }
  const gate = new PermissionGate(async () => true, [sessionRule])

  gate.addSessionRules([configRule])

  assert.deepEqual(gate.getConfigRules(), [configRule])
  assert.deepEqual(gate.getSessionRules(), [sessionRule])
})

test('PermissionGate dedupes inherited rules by source', () => {
  const configRule: PermissionRule = { toolName: 'Bash', behavior: 'deny', source: 'config' }
  const sessionRule: PermissionRule = {
    toolName: 'fsWrite',
    contentPattern: '*a.txt',
    behavior: 'allow',
    source: 'session',
  }
  const parentGate = new PermissionGate(async () => true, [configRule, configRule])
  parentGate.addSessionRules([sessionRule, sessionRule])
  const childGate = new PermissionGate(async () => true, parentGate.getConfigRules())

  childGate.addSessionRules([...parentGate.getSessionRules(), ...parentGate.getSessionRules()])

  assert.deepEqual(childGate.getConfigRules(), [configRule])
  assert.deepEqual(childGate.getSessionRules(), [sessionRule])
})

test('permissionRulesFromSettings converts allow deny and ask entries', () => {
  assert.deepEqual(permissionRulesFromSettings({
    allow: ['Read', 'Bash:*npm test*'],
    deny: ['Delete'],
    ask: ['Write:src/**'],
  }), [
    { toolName: 'Delete', behavior: 'deny', source: 'config' },
    { toolName: 'Write', contentPattern: 'src/**', behavior: 'ask', source: 'config' },
    { toolName: 'Read', behavior: 'allow', source: 'config' },
    { toolName: 'Bash', contentPattern: '*npm test*', behavior: 'allow', source: 'config' },
  ])
})

test('PermissionGate ask rules force safe tools to prompt', async () => {
  let prompted = false
  let source = ''
  const gate = new PermissionGate(
    async (request) => {
      prompted = true
      source = request.source
      return true
    },
    [{ toolName: 'Read', behavior: 'ask', source: 'config' }],
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
  assert.equal(source, 'ask rule')
})

test('PermissionGate deny rules win over ask and allow rules', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'fsWrite', behavior: 'allow', source: 'config' },
      { toolName: 'fsWrite', behavior: 'ask', source: 'config' },
      { toolName: 'fsWrite', behavior: 'deny', source: 'config' },
    ],
  )

  const approved = await gate.approve(fsWriteTool, { path: 'src/index.ts' })

  assert.equal(approved, false)
  assert.equal(prompted, false)
})

test('PermissionGate allows read-only bash inside protected paths without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  // Protected paths guard edits, not reads: reading .git/config is normal work.
  const approved = await gate.approve(bashTool, { command: 'cat .git/config' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate prompts for bash writes into protected paths', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'rm .git/config' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate allows read-only tools inside protected paths', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  assert.equal(await gate.approve(readFileTool, { filePath: '.git/config' }), true)
  assert.equal(await gate.approve(readFileTool, { filePath: '.hanekawa/settings.json' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate auto-allows the expanded read-only command set', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  for (const command of [
    'echo hi',
    'which node',
    'date',
    'sort README.md',
    'diff a.txt b.txt',
    'git blame README.md',
    'git stash list',
    'git worktree list',
  ]) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.equal(prompted, false)
})

test('PermissionGate keeps output-file variants of read commands off the fast path', async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => {
    prompts++
    return false
  })

  for (const command of ['sort -o out.txt f', 'tree -o out.html', 'uniq in.txt out.txt', 'git stash pop']) {
    assert.equal(await gate.approve(bashTool, { command }), false, command)
  }
  assert.equal(prompts, 4)
})

test('PermissionGate denial reason distinguishes policy from the user', async () => {
  const denyRule: PermissionRule = { toolName: 'Bash', contentPattern: 'curl:*', behavior: 'deny', source: 'config' }
  const gate = new PermissionGate(async () => false, [denyRule])

  const byRule = await gate.approveDetailed(bashTool, { command: DENIED_COMMAND })
  assert.equal(byRule.approved, false)
  assert.equal(byRule.source, 'deny rule')
  assert.match(byRule.denialReason ?? '', /deny rule: Bash\(curl:\*\)/)
  assert.doesNotMatch(byRule.denialReason ?? '', /User denied/)

  const byUser = await gate.approveDetailed(bashTool, { command: 'npm run build' })
  assert.equal(byUser.approved, false)
  assert.match(byUser.denialReason ?? '', /User denied permission for Bash/)
})

test('PermissionGate readonly mode names itself in the denial reason', async () => {
  const gate = new PermissionGate(async () => true, [], { mode: 'readonly' })

  const decision = await gate.approveDetailed(bashTool, { command: 'rm -rf tmp' })

  assert.equal(decision.approved, false)
  assert.equal(decision.source, 'readonly mode')
  assert.match(decision.denialReason ?? '', /Read-only permission mode/)
})

test('PermissionGate checks Windows path safety outside bypass mode', async () => {
  let reason = ''
  const gate = new PermissionGate(async (request) => {
    reason = request.reason
    return false
  })

  assert.equal(await gate.approve(readFileTool, { filePath: 'C:/x/notes.txt:hidden' }), false)
  assert.match(reason, /suspicious Windows form/)
})

test('checkWindowsPathSafety flags bypass shapes but not ordinary relative navigation', () => {
  for (const safe of [
    // `.` and `..` are navigation, not a trailing-dot bypass. Flagging them
    // made every parent-relative path a "suspicious path" prompt.
    '../out.ts',
    '..',
    '.',
    './a/../b.ts',
    'a/b/../c.ts',
    'src/x.ts',
    '.gitignore',
    'x...y.ts',
  ]) {
    assert.equal(checkWindowsPathSafety(safe).suspicious, false, safe)
  }

  for (const suspicious of [
    '.git./config',
    'settings.json.',
    '.claude ',
    'a/.../b',
    '.../file.txt',
    // A DOS device name reached as a suffix, not just as a whole component.
    'settings.json.PRN',
    '.git.CON',
    'NUL',
    'GIT~1/config',
    'file.txt:hidden',
    '//?/C:/x',
    '\\\\server\\share',
  ]) {
    assert.equal(checkWindowsPathSafety(suspicious).suspicious, true, suspicious)
  }
})

test('PermissionGate auto-allows simple read-only bash commands in default mode', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'pwd' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate auto-allows read-only bash variants without prompting in default mode', async () => {
  let prompts = 0
  const gate = new PermissionGate(async () => {
    prompts++
    return true
  })

  for (const command of [
    'git status',
    'git log --oneline',
    'git diff',
    'cat README.md',
    'rg TODO src',
    'ls -la',
    'wc -l file.txt',
  ]) {
    assert.equal(await gate.approve(bashTool, { command }), true)
  }
  assert.equal(prompts, 0)

  // Mutating / destructive / external commands still prompt.
  for (const command of ['git push', 'rm -rf dist', 'npm install', 'sed -i s/a/b/ f']) {
    assert.equal(await gate.approve(bashTool, { command }), true)
  }
  assert.equal(prompts, 4)
})

test('PermissionGate Bash prefix rule (CC syntax) matches subcommand args without prompting', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm install:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm install' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm install pkg' }), true)
  assert.equal(prompts, 0)
  // Different prefix still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash exact rule (CC syntax) matches only the exact command', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm run build', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 0)
  assert.equal(await gate.approve(bashTool, { command: 'npm run build --foo' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash wildcard rule matches within the prefix', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'git *', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'git push' }), true)
  assert.equal(prompts, 0)
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash prefix rule enforces word boundaries', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'ls:*', behavior: 'allow', source: 'config' }],
  )
  // `lsusb` rather than `lsof`: the latter is on the read-only allowlist and
  // would be auto-approved before rule matching ever runs, which would hide
  // the boundary this test is about.
  assert.equal(await gate.approve(bashTool, { command: 'lsusb' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash allow rule does not match compound commands', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'cd:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'cd /x && rm file' }), true)
  assert.equal(prompts, 1)
})

test('PermissionGate Bash deny rule matches compound subcommands', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'cd /x && rm file' }), false)
  assert.equal(prompts, 0)
})

test('PermissionGate Bash deny rule strips env var prefixes to prevent bypass', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'FOO=bar rm file' }), false)
  assert.equal(prompts, 0)
})

test('PermissionGate Bash allow rule strips safe wrappers before matching', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    [{ toolName: 'Bash', contentPattern: 'npm install:*', behavior: 'allow', source: 'config' }],
  )
  assert.equal(await gate.approve(bashTool, { command: 'timeout 10 npm install' }), true)
  assert.equal(prompts, 0)
})

test('PermissionGate legacy Bash:prefix:* syntax still works as prefix rule', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async () => { prompts++; return true },
    permissionRulesFromSettings({ allow: ['Bash:npm install:*'] }),
  )
  assert.equal(await gate.approve(bashTool, { command: 'npm install pkg' }), true)
  assert.equal(prompts, 0)
})

test('PermissionGate always allow creates a prefix Bash session rule', async () => {
  let prompts = 0
  let scopedRule: PermissionRule | undefined
  const gate = new PermissionGate(async (request) => {
    prompts++
    scopedRule = request.alwaysAllowRule
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.deepEqual(scopedRule, {
    toolName: 'Bash',
    contentPattern: 'mkdir test:*',
    behavior: 'allow',
    source: 'session',
  })
  assert.deepEqual(gate.getSessionRules(), [scopedRule])

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'mkdir test sub' }), true)
  assert.equal(prompts, 1)

  assert.equal(await gate.approve(bashTool, { command: 'mkdir other' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow creates file-path scoped file-tool rules', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(writeFileTool, { filePath: 'src/app.ts' }), true)
  assert.equal(await gate.approve(editFileTool, { filePath: 'src/edit.ts' }), true)
  assert.equal(await gate.approve(multiEditFileTool, { filePath: 'src/multi.ts' }), true)
  assert.equal(await gate.approve(deleteFileTool, { filePath: 'src/delete.ts' }), true)

  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Write', contentPattern: 'src/app.ts', behavior: 'allow', source: 'session' },
    { toolName: 'Edit', contentPattern: 'src/edit.ts', behavior: 'allow', source: 'session' },
    { toolName: 'MultiEdit', contentPattern: 'src/multi.ts', behavior: 'allow', source: 'session' },
    { toolName: 'Delete', contentPattern: 'src/delete.ts', behavior: 'allow', source: 'session' },
  ])
})

test('PermissionGate always allow reuses the git commit prefix for later invocations', async () => {
  let prompts = 0
  const gate = new PermissionGate(async (request) => {
    prompts++
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'git commit -m "first"' }), true)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' },
  ])
  assert.equal(await gate.approve(bashTool, { command: 'git commit -am "second"' }), true)
  assert.equal(prompts, 1)
  // Different prefix still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'git push' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow covers a compound whose segments share a prefix', async () => {
  let prompts = 0
  const gate = new PermissionGate(async (request) => {
    prompts++
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm run bundle' }), true)
  assert.equal(prompts, 1)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'npm run:*', behavior: 'allow', source: 'session' },
  ])

  // The rule now covers the compound it was created from, and each half alone.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm run bundle' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'npm run bundle' }), true)
  assert.equal(prompts, 1)

  // A segment the rule does not cover still stops the compound.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build && npm publish' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate always allow is not offered for bare shells and privilege wrappers', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'bash -c "npm test"' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
  // `sudo` is risky, so it is remembered as the exact command only.
  assert.equal(await gate.approve(bashTool, { command: 'sudo apt update' }), true)
  assert.deepEqual(gate.getSessionRules().map(permissionRuleToEntry), ['Bash(sudo apt update)'])
})

test('PermissionGate always allow is not offered when an operand absorbs shell operators', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'git commit a&touch x' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate always allow is not offered when compound segments have different prefixes', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })
  assert.equal(await gate.approve(bashTool, { command: 'mkdir a && mkdir b' }), true)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate session always allow overrides config ask rules', async () => {
  let prompts = 0
  const gate = new PermissionGate(
    async (request) => {
      prompts++
      request.onAlwaysAllow?.()
      return true
    },
    permissionRulesFromSettings({ ask: ['Bash(npm run build)'] }),
  )

  // Config ask rule prompts, and the prompt offers an always option.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'npm run:*', behavior: 'allow', source: 'session' },
  ])

  // The session allow rule now suppresses the config ask rule.
  assert.equal(await gate.approve(bashTool, { command: 'npm run build' }), true)
  assert.equal(prompts, 1)
  // A command the session rule does not cover still prompts.
  assert.equal(await gate.approve(bashTool, { command: 'npm test' }), true)
  assert.equal(prompts, 2)
})

test('PermissionGate includes matched rules in prompt requests', async () => {
  const askRule: PermissionRule = { toolName: 'Read', contentPattern: 'src/**', behavior: 'ask', source: 'config' }
  const seen: Array<PermissionRule | undefined> = []
  const gate = new PermissionGate(
    async (request) => {
      seen.push(request.matchedRule)
      return true
    },
    [askRule],
    {},
  )

  assert.equal(await gate.approve(readFileTool, { filePath: 'src/index.ts' }), true)
  assert.deepEqual(seen, [askRule])
})

test('PermissionGate omits always allow for mixed-prefix compounds and critical calls', async () => {
  const alwaysRules: Array<PermissionRule | undefined> = []
  const gate = new PermissionGate(
    async (request) => {
      alwaysRules.push(request.alwaysAllowRule)
      request.onAlwaysAllow?.()
      return true
    },
    [],
    {},
  )

  assert.equal(await gate.approve(bashTool, { command: 'npm test && npm run typecheck' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'rm -rf ~' }), true)

  assert.deepEqual(alwaysRules, [undefined, undefined])
  assert.deepEqual(gate.getSessionRules(), [])
})

// --- Protected path coverage (aligned with Claude Code safetyCheck) --------

test('isProtectedPath catches dangerous directories', () => {
  assert.equal(isProtectedPath('.git/config'), true)
  assert.equal(isProtectedPath('repo/.git/HEAD'), true)
  assert.equal(isProtectedPath('.vscode/settings.json'), true)
  assert.equal(isProtectedPath('.idea/workspace.xml'), true)
  assert.equal(isProtectedPath('.hanekawa/config.json'), true)
})

test('isProtectedPath catches shell config and agent config files', () => {
  assert.equal(isProtectedPath('.gitconfig'), true)
  assert.equal(isProtectedPath('/home/me/.gitconfig'), true)
  assert.equal(isProtectedPath('.bashrc'), true)
  assert.equal(isProtectedPath('.bash_profile'), true)
  assert.equal(isProtectedPath('.zshrc'), true)
  assert.equal(isProtectedPath('.zprofile'), true)
  assert.equal(isProtectedPath('.profile'), true)
  assert.equal(isProtectedPath('.ripgreprc'), true)
  assert.equal(isProtectedPath('.mcp.json'), true)
  assert.equal(isProtectedPath('.hanekawa.json'), true)
})

test('isProtectedPath does not protect secrets outside the CC list', () => {
  assert.equal(isProtectedPath('.env'), false)
  assert.equal(isProtectedPath('.ssh/id_rsa'), false)
  assert.equal(isProtectedPath('id_rsa'), false)
  assert.equal(isProtectedPath('cert.pem'), false)
  assert.equal(isProtectedPath('credentials.json'), false)
  assert.equal(isProtectedPath('.aws/credentials'), false)
  assert.equal(isProtectedPath('.npmrc'), false)
})

test('isProtectedPath does not over-match safe filenames', () => {
  assert.equal(isProtectedPath('readme.md'), false)
  assert.equal(isProtectedPath('src/index.ts'), false)
  assert.equal(isProtectedPath('package.json'), false)
  assert.equal(isProtectedPath('keymap.ts'), false)
})

test('PermissionGate prompts before fsWrite to .bashrc', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(fsWriteTool, { path: '/home/me/.bashrc' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts before a bash command writing into .git', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > .git/config' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate allows bash reading .gitconfig without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'cat .gitconfig' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

// --- New: denial streak tracking ------------------------------------------

test('PermissionGate sets denialStreak=0 for normal (non-escalated) prompts', async () => {
  let received = -1
  const gate = new PermissionGate(async (request) => {
    received = request.denialStreak
    return true
  })

  await gate.approve(bashTool, { command: 'mkdir x' })

  assert.equal(received, 0)
})

test('PermissionGate prompts for bash redirection instead of denying it', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  const approved = await gate.approve(bashTool, { command: 'echo data > out.txt' })

  assert.equal(approved, true)
  assert.equal(prompted, true)
})

test('PermissionGate treats discard redirections as read-only', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return true
  })

  for (const command of ['ls -la 2>/dev/null', 'git log --oneline 2>&1 | head -5', 'cat f > /dev/null']) {
    assert.equal(await gate.approve(bashTool, { command }), true, command)
  }
  assert.equal(prompted, false)
})

test('PermissionGate checks protected paths in each bash segment', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  // A write in any segment is enough; the read-only twin stays silent.
  assert.equal(await gate.approve(bashTool, { command: 'echo ok && rm ~/.gitconfig' }), false)
  assert.equal(prompted, true)

  prompted = false
  assert.equal(await gate.approve(bashTool, { command: 'echo ok && cat .gitconfig' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate prompts for bash commands with too many segments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })
  const command = Array.from({ length: 51 }, (_, index) => `echo ${index}`).join(' && ')

  const approved = await gate.approve(bashTool, { command })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for zsh dangerous builtins', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(bashTool, { command: 'zmodload zsh/system' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

test('PermissionGate prompts for standalone empty quoted arguments', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  assert.equal(await gate.approve(bashTool, { command: 'rm "" -rf tmp' }), false)
  assert.equal(await gate.approve(bashTool, { command: "rm '' -rf tmp" }), false)
  assert.equal(prompted, true)
})

test('PermissionGate catches protected filePath inputs', async () => {
  let prompted = false
  const gate = new PermissionGate(async () => {
    prompted = true
    return false
  })

  const approved = await gate.approve(fsWriteTool, { filePath: '.bashrc' })

  assert.equal(approved, false)
  assert.equal(prompted, true)
})

const webFetchTestTool: Tool = {
  name: 'WebFetch',
  description: 'Fetch a URL',
  riskLevel: 'confirm',
  isReadOnly: true,
  inputSchema: z.object({ url: z.string() }).strict(),
  execute: async () => ({ ok: true, content: '' }),
}

test('PermissionGate auto-approves preapproved WebFetch hosts and prompts for the rest', async () => {
  const prompted: string[] = []
  const gate = new PermissionGate(async (request) => {
    prompted.push((request.input as { url: string }).url)
    return true
  })

  for (const url of [
    'https://docs.python.org/3/library/os.html',
    'http://react.dev/learn',
    'https://github.com/anthropics/claude-code',
    'https://vercel.com/docs/functions',
  ]) {
    assert.equal(await gate.approve(webFetchTestTool, { url }), true, url)
  }
  assert.deepEqual(prompted, [])

  const mustPrompt = [
    'https://example.com/page',
    // The path prefix must land on a segment boundary.
    'https://github.com/anthropics-evil/repo',
    // A subdomain is not the preapproved host.
    'https://evil.docs.python.org/x',
  ]
  for (const url of mustPrompt) {
    await gate.approve(webFetchTestTool, { url })
  }
  assert.deepEqual(prompted, mustPrompt)
})

test('PermissionGate matches WebFetch domain rules against the URL host', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'WebFetch', contentPattern: 'domain:docs.python.org', behavior: 'deny', source: 'config' },
      { toolName: 'WebFetch', contentPattern: 'domain:*.internal.test', behavior: 'allow', source: 'config' },
    ],
  )

  // A deny rule outranks the preapproved list.
  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://docs.python.org/3/' }), false)

  prompted = false
  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://wiki.internal.test/page' }), true)
  assert.equal(prompted, false)

  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://other.test/page' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate offers a WebFetch always-allow rule scoped to the host', async () => {
  let offered: PermissionRule | undefined
  const gate = new PermissionGate(async (request) => {
    offered = request.alwaysAllowRule
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(webFetchTestTool, { url: 'https://example.com/a/b?c=d' }), true)
  assert.deepEqual(offered, {
    toolName: 'WebFetch',
    contentPattern: 'domain:example.com',
    behavior: 'allow',
    source: 'session',
  })
  assert.equal(permissionRuleToEntry(offered!), 'WebFetch(domain:example.com)')
})

const browserTestTool: Tool = {
  name: 'Browser',
  description: 'Drive a browser',
  riskLevel: 'confirm',
  inputSchema: z.object({ operation: z.string(), tabId: z.string().optional(), url: z.string().optional() }),
  execute: async () => ({ ok: true, content: '' }),
}

test('Browser domain rules scope the navigating operations and nothing else', async () => {
  let prompted = 0
  const gate = new PermissionGate(
    async () => {
      prompted += 1
      return true
    },
    [
      { toolName: 'Browser', contentPattern: 'domain:blocked.test', behavior: 'deny', source: 'config' },
      { toolName: 'Browser', contentPattern: 'domain:allowed.test', behavior: 'allow', source: 'config' },
    ],
  )

  assert.equal(
    await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', url: 'https://blocked.test/x' }),
    false,
  )
  // `browser.create_tab` with a url performs the same navigation, so it is
  // scoped the same way.
  assert.equal(
    await gate.approve(browserTestTool, { operation: 'browser.create_tab', url: 'https://blocked.test/x' }),
    false,
  )

  prompted = 0
  assert.equal(
    await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', url: 'https://allowed.test/x' }),
    true,
  )
  assert.equal(prompted, 0)

  // An operation that names no host is not covered by either domain rule: it
  // prompts, rather than inheriting the allow or the deny.
  assert.equal(await gate.approve(browserTestTool, { operation: 'page.text.snapshot', tabId: 't1' }), true)
  assert.equal(prompted, 1)
  // A batch is asked about by the host of its first navigating step.
  const batch = (url: string) => ({ operation: 'batch', tabId: 't1', steps: [{ operation: 'page.scroll' }, { operation: 'tab.navigate', url }] })
  assert.equal(await gate.approve(browserTestTool, batch('https://blocked.test/x')), false)
  assert.equal(await gate.approve(browserTestTool, batch('https://allowed.test/x')), true)
  assert.equal(prompted, 1)
})

test('a Browser always-allow rule is scoped to the host it navigated to', async () => {
  const offered: Array<PermissionRule | undefined> = []
  const gate = new PermissionGate(async (request) => {
    offered.push(request.alwaysAllowRule)
    return true
  })

  await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', url: 'https://example.com/a' })
  assert.deepEqual(offered[0], {
    toolName: 'Browser',
    contentPattern: 'domain:example.com',
    behavior: 'allow',
    source: 'session',
  })

  // No host in the call means no host rule to offer — "always allow" on a
  // snapshot must not quietly approve every future navigation.
  await gate.approve(browserTestTool, { operation: 'page.screenshot', tabId: 't1' })
  assert.equal(offered[1], undefined)
})

test('the WebFetch preapproved host list does not extend to Browser', async () => {
  let prompted = 0
  const gate = new PermissionGate(async () => {
    prompted += 1
    return true
  })
  await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', url: 'https://docs.python.org/3/' })
  assert.equal(prompted, 1)
})

test('a Read deny rule also governs the page a browser opens from disk', async () => {
  let prompted = 0
  const gate = new PermissionGate(
    async () => {
      prompted += 1
      return true
    },
    [{ toolName: 'Read', contentPattern: '/ws/secrets/**', behavior: 'deny', source: 'config' }],
  )

  // A page's scripts read whatever the server serves, so the same path stays
  // off limits however it is reached.
  assert.equal(
    await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', path: '/ws/secrets/page.html' }),
    false,
  )
  assert.equal(
    await gate.approve(browserTestTool, { operation: 'tab.navigate', tabId: 't1', path: '/ws/public/page.html' }),
    true,
  )
  assert.equal(prompted, 1)
})

test('PermissionGate Edit and Read rules govern their whole tool family', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return true
    },
    [
      { toolName: 'Edit', contentPattern: 'src/**', behavior: 'deny', source: 'config' },
      { toolName: 'Read', contentPattern: 'secrets/**', behavior: 'deny', source: 'config' },
    ],
    {},
  )

  // An `Edit(...)` rule reaches every write tool.
  for (const tool of [writeFileTool, editFileTool, multiEditFileTool, deleteFileTool]) {
    assert.equal(await gate.approve(tool, { path: 'src/index.ts' }), false, tool.name)
  }
  // A `Read(...)` rule reaches every read tool.
  assert.equal(await gate.approve(readFileTool, { filePath: 'secrets/key.pem' }), false)
  assert.equal(prompted, false)

  // A path the rules do not name is unaffected.
  assert.equal(await gate.approve(writeFileTool, { path: 'docs/readme.md' }), true)
  assert.equal(prompted, true)
})

test('PermissionGate restores the mode that was active before plan mode', () => {
  const gate = new PermissionGate(async () => false, undefined, { mode: 'auto' })

  gate.setMode('plan')
  assert.equal(gate.getPrePlanMode(), 'auto')
  assert.equal(gate.exitPlanMode(), 'auto')
  assert.equal(gate.getMode(), 'auto')
})

test('PermissionGate plan mode allows read tools without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readFileTool, { filePath: 'src/index.ts' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows tools marked read-only by metadata', async () => {
  let prompted = false
  const readOnlyTool: Tool = {
    name: 'mcp__server__search',
    description: 'Search remote state',
    riskLevel: 'confirm',
    isReadOnly: true,
    inputSchema: z.object({}).strict(),
    execute: async () => ({ ok: true, content: '' }),
  }
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(readOnlyTool, {})

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows session plan file writes despite protected plan dir', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plan-permission-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan', cwd },
  )
  gate.setPlanSlugProvider(() => 'draft-plan')
  const planPath = path.join(getProjectPlansDir(cwd), 'draft-plan.md')

  assert.equal(await gate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(editFileTool, { path: planPath }), true)
  assert.equal(await gate.approve(multiEditFileTool, { path: planPath }), true)
  assert.equal(prompted, false)
})

test('PermissionGate clearPlanSlugProvider only uninstalls the provider it was handed', async (t) => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-plan-permission-'))
  t.after(() => rm(cwd, { recursive: true, force: true }))
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan', cwd },
  )
  const provider = () => 'draft-plan'
  gate.setPlanSlugProvider(provider)
  const planPath = path.join(getProjectPlansDir(cwd), 'draft-plan.md')

  // A superseded runtime disposing after a newer one installed its own
  // provider must not uninstall the newer one.
  gate.clearPlanSlugProvider(() => 'draft-plan')
  assert.equal(await gate.approve(writeFileTool, { path: planPath }), true)
  assert.equal(prompted, false)

  gate.clearPlanSlugProvider(provider)
  assert.equal(await gate.approve(writeFileTool, { path: planPath }), false)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows exitPlanMode without prompting', async () => {
  let prompted = false
  const exitPlanModeTool: Tool = {
    name: 'ExitPlanMode',
    description: 'Exit plan mode',
    riskLevel: 'safe',
    inputSchema: z.object({ plan: z.string() }).strict(),
    execute: async () => ({ ok: true, content: '' }),
  }
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  const approved = await gate.approve(exitPlanModeTool, { plan: 'Do the thing.' })

  assert.equal(approved, true)
  assert.equal(prompted, false)
})

test('PermissionGate plan mode allows read-only bash subset', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'plan' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'git status' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git diff -- src/index.ts' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git log --oneline | head -10' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'pwd && rg TODO src' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'stat package.json' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'fd package' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'find src -name "*.ts"' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves non-protected actions without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [{ toolName: 'fsWrite', behavior: 'deny', contentPattern: 'other/**', source: 'config' }],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(fsWriteTool, { path: 'src/index.ts' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves read-only bash without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'ls' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'git status' }), true)
  assert.equal(prompted, false)
})

test('PermissionGate bypass mode approves destructive bash without prompting', async () => {
  let prompted = false
  const gate = new PermissionGate(
    async () => {
      prompted = true
      return false
    },
    [],
    { mode: 'bypass' },
  )

  assert.equal(await gate.approve(bashTool, { command: 'git reset --hard HEAD' }), true)
  assert.equal(await gate.approve(bashTool, { command: 'rm -rf tmp' }), true)
  assert.equal(await gate.approve(deleteFileTool, { path: 'tmp/junk.txt' }), true)
  assert.equal(prompted, false)
  assert.deepEqual(gate.getSessionRules(), [])
})

test('PermissionGate persists always-allow rules via the persistRule callback', async () => {
  const persisted: PermissionRule[] = []
  const gate = new PermissionGate(
    async (request) => {
      request.onAlwaysAllow?.()
      return true
    },
    undefined,
    { persistRule: async (rule) => { persisted.push(rule) } },
  )

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.deepEqual(gate.getSessionRules(), [
    { toolName: 'Bash', contentPattern: 'mkdir test:*', behavior: 'allow', source: 'session' },
  ])
  assert.deepEqual(persisted, [
    { toolName: 'Bash', contentPattern: 'mkdir test:*', behavior: 'allow', source: 'session' },
  ])
})

test('PermissionGate without persistRule keeps always allow session-only', async () => {
  const gate = new PermissionGate(async (request) => {
    request.onAlwaysAllow?.()
    return true
  })

  assert.equal(await gate.approve(bashTool, { command: 'mkdir test' }), true)
  assert.equal(gate.getSessionRules().length, 1)
})

test('persistPermissionRule writes deduped entries into settings.local.json', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-perm-'))
  try {
    const rule: PermissionRule = { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' }
    const rule2: PermissionRule = { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' }
    await persistPermissionRule(dir, rule)
    await persistPermissionRule(dir, rule2)
    const settingsPath = localSettingsPath(dir)
    const saved = JSON.parse(await readFile(settingsPath, 'utf-8'))
    assert.deepEqual(saved.permissions.allow, ['Bash(git commit:*)'])

    const reloaded = permissionRulesFromSettings(saved.permissions)
    assert.deepEqual(reloaded, [
      { toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'config' },
    ])
    assert.equal(permissionRuleToEntry(reloaded[0]!), 'Bash(git commit:*)')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('PermissionGate gates sharing a session rule store see each others rules live', async () => {
  const store = createSessionRuleStore()
  let parentPrompts = 0
  let childPrompts = 0
  const parent = new PermissionGate(async () => { parentPrompts++; return true }, [], { sessionRuleStore: store })
  const child = new PermissionGate(async () => { childPrompts++; return true }, [], { sessionRuleStore: store })

  // Parent's always-allow is immediately visible to the child (no snapshot).
  parent.addSessionRule({ toolName: 'Bash', contentPattern: 'git commit:*', behavior: 'allow', source: 'session' })
  assert.equal(await child.approve(bashTool, { command: 'git commit -m x' }), true)
  assert.equal(childPrompts, 0)

  // Child's always-allow propagates back to the parent.
  const childGateWithPrompt = new PermissionGate(async (request) => {
    childPrompts++
    request.onAlwaysAllow?.()
    return true
  }, [], { sessionRuleStore: store })
  assert.equal(await childGateWithPrompt.approve(bashTool, { command: 'mkdir x' }), true)
  assert.equal(childPrompts, 1)
  assert.equal(await parent.approve(bashTool, { command: 'mkdir x' }), true)
  assert.equal(parentPrompts, 0)
})

test('PermissionGate session rule store keeps config rules isolated', async () => {
  const store = createSessionRuleStore()
  const parent = new PermissionGate(async () => true, [], { sessionRuleStore: store })
  const child = new PermissionGate(async () => true, [
    { toolName: 'Bash', contentPattern: 'rm:*', behavior: 'deny', source: 'config' },
  ], { sessionRuleStore: store })

  assert.equal(child.getConfigRules().length, 1)
  assert.equal(parent.getConfigRules().length, 0)
  assert.equal(parent.getSessionRules().length, 0)
  // The child's config deny does not leak into the shared session rules.
  assert.equal(await parent.approve(bashTool, { command: 'rm file' }), true)
})

test('PermissionGate with lockMode ignores mode and plan-mode transitions', () => {
  const gate = new PermissionGate(async () => true, [], { mode: 'readonly', lockMode: true })
  assert.equal(gate.isModeLocked(), true)
  gate.setMode('bypass')
  assert.equal(gate.getMode(), 'readonly')
  gate.prepareContextForPlanMode()
  assert.equal(gate.getMode(), 'readonly')
  assert.equal(gate.exitPlanMode(), 'readonly')
  assert.equal(new PermissionGate(async () => true, [], { mode: 'default' }).isModeLocked(), false)
})
