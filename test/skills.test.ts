import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { toolToAPISchema } from '../src/harness/toolApiSchema.js'
import { CommandRegistry } from '../src/commands/index.js'
import { buildSkillCommandPrompt, buildSkillPrompt, registerSkillCommands } from '../src/commands/skills.js'
import { SkillsService, withSkillDir } from '../src/services/skills/skillsService.js'
import { importSkill } from '../src/services/skills/importSkill.js'
import { removeSkill } from '../src/services/skills/removeSkill.js'
import { createSkillTool } from '../src/tools/SkillTool/SkillTool.js'
import { loadMergedSettings, loadUserSettings, localSettingsPath, updateLocalSettings } from '../src/config/settings.js'
import { getSharedSkillsDir } from '../src/utils/paths.js'
import { skillRoots } from '../src/services/skills/skillRoots.js'

test('personal discovery at the home workspace retains personal compatibility roots', () => {
  const roots = skillRoots(os.homedir(), 'personal')
  assert.deepEqual(roots.map((root) => root.label), ['~/.agents/skills', '~/.claude/skills', '~/.codex/skills', '~/.gemini/skills'])
})

test('SkillsService.list() returns empty array when directory does not exist', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const service = new SkillsService(dir)
    const skills = await service.list()
    assert.deepEqual(skills, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() returns skills from directory', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\n# Debug workflow\n\n1. Reproduce\n2. Fix',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'tdd'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development\n---\n\nWrite tests first.',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 2)
    assert.ok(skills.find(s => s.name === 'debugging'))
    assert.ok(skills.find(s => s.name === 'tdd'))

    const debugging = skills.find(s => s.name === 'debugging')!
    assert.equal(debugging.description, 'Use when diagnosing bugs')
    assert.match(debugging.content, /Debug workflow/)
    assert.equal(debugging.inclusion, 'manual')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses CRLF frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillDir = path.join(dir, '.myagent', 'skills', 'windows-skill')
    await mkdir(skillDir, { recursive: true })
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      '---\r\nname: windows-skill\r\ndescription: Uses Windows line endings\r\n---\r\n\r\n# Windows skill\r\n\r\nRun on Windows.',
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'windows-skill')
    assert.equal(skills[0].description, 'Uses Windows line endings')
    assert.equal(skills[0].content, '# Windows skill\r\n\r\nRun on Windows.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() repairs problematic top-level description scalars', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillDir = path.join(dir, '.myagent', 'skills', 'firecrawl-build')
    await mkdir(skillDir, { recursive: true })
    const description = 'Integrate application data: web search, "scrape", and `interact`.'
    await writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\nname: firecrawl-build\ndescription: ${description}\n---\n\n# Firecrawl build\n\nBuild with web data.`,
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'firecrawl-build')
    assert.equal(skills[0].description, description)
    assert.equal(skills[0].content, '# Firecrawl build\n\nBuild with web data.')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses conditional activation frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'react'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'react', 'SKILL.md'),
      [
        '---',
        'name: react',
        'description: React files',
        'inclusion: fileMatch',
        'paths:',
        '  - "src/**/*.tsx"',
        '  - "test/**/*.tsx"',
        '---',
        '',
        'React guidance',
      ].join('\n'),
      'utf8',
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].inclusion, 'fileMatch')
    assert.deepEqual(skills[0].paths, ['src/**/*.tsx', 'test/**/*.tsx'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() parses slash command execution frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'rich'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'rich', 'SKILL.md'),
      [
        '---',
        'name: rich',
        'description: Rich slash command',
        'allowedTools:',
        '  - Read',
        '  - Bash',
        'model: powerful',
        'effort: xhigh',
        'attachments:',
        '  - notes.txt',
        'hooks:',
        '  userPromptSubmit:',
        '    - command: "echo user"',
        '  preToolUse:',
        '    - matcher: Bash',
        '      command: "echo pre"',
        '      timeoutMs: 1000',
        '---',
        '',
        'Rich guidance',
      ].join('\n'),
      'utf8',
    )

    const skills = await new SkillsService(dir).list()
    const skill = skills[0]

    assert.equal(skill.name, 'rich')
    assert.deepEqual(skill.allowedTools, ['Read', 'Bash'])
    assert.equal(skill.model, 'powerful')
    assert.equal(skill.effort, 'xhigh')
    assert.deepEqual(skill.attachments, ['notes.txt'])
    assert.equal(skill.hooks?.userPromptSubmit?.[0]?.command, 'echo user')
    assert.equal(skill.hooks?.preToolUse?.[0]?.matcher, 'Bash')
    assert.equal(skill.hooks?.preToolUse?.[0]?.timeoutMs, 1000)
    assert.equal(skill.skillDir, path.join(skillsDir, 'rich'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.list() skips skills with invalid execution frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'bad-effort'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'bad-effort', 'SKILL.md'),
      '---\nname: bad-effort\ndescription: Bad\neffort: turbo\n---\n\nContent',
      'utf8',
    )

    const skills = await new SkillsService(dir).list()

    assert.deepEqual(skills, [])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.load() loads specific skill', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug content',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skill = await service.load('debugging')

    assert.equal(skill.name, 'debugging')
    assert.equal(skill.description, 'Use when diagnosing bugs')
    assert.equal(skill.content, 'Debug content')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService.load() throws when skill not found', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const service = new SkillsService(dir)
    await assert.rejects(
      () => service.load('nonexistent'),
      /Skill not found: nonexistent/
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * A project with two skills, one of which `settings.local.json` switches off.
 *
 * `HOME`/`USERPROFILE` are redirected because `loadMergedSettings` layers
 * `~/.myagent/settings.json` under the project's — without this the assertions
 * would depend on whose machine ran them.
 */
async function withDisabledSkill(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  const home = await mkdtemp(path.join(os.tmpdir(), 'myagent-home-'))
  const previous = { home: process.env.HOME, profile: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    for (const name of ['kept', 'gone']) {
      await mkdir(path.join(skillsDir, name), { recursive: true })
      await writeFile(
        path.join(skillsDir, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: The ${name} skill\n---\n\nBody.`,
        'utf8',
      )
    }
    await mkdir(path.dirname(localSettingsPath(dir)), { recursive: true })
    await writeFile(
      localSettingsPath(dir),
      JSON.stringify({ skills: { disabled: ['gone'] } }),
      'utf8',
    )
    await run(dir)
  } finally {
    process.env.HOME = previous.home
    process.env.USERPROFILE = previous.profile
    await rm(home, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
}

test('a disabled skill is invisible to list(), load() and the slash commands', async () => {
  await withDisabledSkill(async (dir) => {
    const service = new SkillsService(dir)

    assert.deepEqual((await service.list()).map((skill) => skill.name), ['kept'])
    // The filter is in the service so that "off" means off at every call site:
    // the prompt, the slash commands and the Skill tool all go through it.
    await assert.rejects(() => service.load('gone'), /Skill not found: gone/)

    const registry = new CommandRegistry()
    await registerSkillCommands(registry, dir)
    assert.equal(registry.has('kept'), true)
    assert.equal(registry.has('gone'), false)

    const tool = createSkillTool()
    const result = await tool.execute(
      { skill: 'gone' },
      { cwd: dir, sessionId: 's1', readFiles: new Set(), readFileState: new Map() } as never,
    ).catch((error: unknown) => error)
    assert.ok(result instanceof Error, 'the Skill tool cannot load it either')
  })
})

test('listAll() still reports the disabled skill, which is what the settings screen draws', async () => {
  await withDisabledSkill(async (dir) => {
    assert.deepEqual(
      (await new SkillsService(dir).listAll()).map((skill) => skill.name).sort(),
      ['gone', 'kept'],
    )
  })
})

test('SkillsService skips skills with missing SKILL.md', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'valid'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'valid', 'SKILL.md'),
      '---\nname: valid\ndescription: Valid skill\n---\n\nContent',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'invalid'), { recursive: true })
    // No SKILL.md in invalid directory

    const service = new SkillsService(dir)
    const skills = await service.list()

    assert.equal(skills.length, 1)
    assert.equal(skills[0].name, 'valid')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on invalid YAML frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'broken'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'broken', 'SKILL.md'),
      '---\nname: broken\ndescription: Broken\nmetadata:\n  values: [one, two\n---\n\nContent',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip broken skill
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on missing required fields', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'incomplete'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'incomplete', 'SKILL.md'),
      '---\nname: incomplete\n---\n\nContent',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip skill with missing description
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('SkillsService throws on missing frontmatter', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'nofrontmatter'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'nofrontmatter', 'SKILL.md'),
      'Just content without frontmatter',
      'utf8'
    )

    const service = new SkillsService(dir)
    const skills = await service.list()

    // Should skip skill without frontmatter
    assert.equal(skills.length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createSkillTool() generates Skill tool object', () => {
  const tool = createSkillTool()

  assert.equal(tool.name, 'Skill')
  assert.match(tool.description, /Load a skill's instructions/)
  assert.equal(tool.riskLevel, 'safe')
  assert.deepEqual(toolToAPISchema(tool), {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        minLength: 1,
        description: 'The name of a skill from the available-skills list. Do not guess names.',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
    additionalProperties: false
  })
})

test('createSkillTool() execute returns skill content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skills-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug workflow content',
      'utf8'
    )

    const tool = createSkillTool()
    const context = { cwd: dir, sessionId: 's1', readFiles: new Set<string>(), invokedSkills: new Map<string, { content: string; timestamp: number }>() }
    const result = await tool.execute({ skill: 'debugging' }, context)

    assert.equal(result.ok, true)
    const expected = withSkillDir(path.join(skillsDir, 'debugging'), 'Debug workflow content')
    assert.equal(result.content, expected)
    assert.equal(context.invokedSkills.get('debugging')?.content, expected)
    assert.equal(typeof context.invokedSkills.get('debugging')?.timestamp, 'number')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createSkillTool() rejects missing skill name', async () => {
  const tool = createSkillTool()

  await assert.rejects(
    () => tool.execute({}, { cwd: process.cwd(), sessionId: 's1', readFiles: new Set() }),
    /Skill input must include a non-empty skill name/,
  )
})

test('buildSkillPrompt replaces arguments placeholder', () => {
  assert.equal(
    buildSkillPrompt('Run this with $ARGUMENTS.', 'hello world'),
    'Run this with hello world.',
  )
})

test('buildSkillPrompt replaces multiple arguments placeholders', () => {
  assert.equal(
    buildSkillPrompt('$ARGUMENTS\nAgain: $ARGUMENTS', 'hello world'),
    'hello world\nAgain: hello world',
  )
})

test('buildSkillPrompt appends arguments when no placeholder exists', () => {
  assert.equal(
    buildSkillPrompt('Use this skill.', 'hello world'),
    'Use this skill.\n\nArguments: hello world',
  )
})

test('buildSkillPrompt does not append empty arguments', () => {
  assert.equal(buildSkillPrompt('Use this skill.', ''), 'Use this skill.')
})

test('buildSkillCommandPrompt appends text attachments in stable order', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-attachments-'))
  try {
    await writeFile(path.join(dir, 'a.txt'), 'alpha', 'utf8')
    await writeFile(path.join(dir, 'b.txt'), 'beta', 'utf8')

    const prompt = await buildSkillCommandPrompt({
      name: 'with-attachments',
      description: 'attachments',
      content: 'Use this skill.',
      skillDir: dir,
      attachments: ['a.txt', 'b.txt'],
    }, '')

    assert.match(prompt, /<skill-attachments>/)
    assert.ok(prompt.indexOf('path="a.txt"') < prompt.indexOf('path="b.txt"'))
    assert.match(prompt, /alpha/)
    assert.match(prompt, /beta/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildSkillCommandPrompt rejects attachment path escape', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-attachments-'))
  try {
    await assert.rejects(
      () => buildSkillCommandPrompt({
        name: 'escape',
        description: 'escape',
        content: 'Use this skill.',
        skillDir: dir,
        attachments: ['../outside.txt'],
      }, ''),
      /must stay inside the skill directory/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('buildSkillCommandPrompt expands inline shell before applying arguments', async () => {
  const commands: string[] = []
  const prompt = await buildSkillCommandPrompt({
    name: 'shell',
    description: 'shell',
    content: 'Shell: !`echo ready`\nArgs: $ARGUMENTS',
    skillDir: process.cwd(),
  }, 'hello !`do not run`', {
    runShellCommand: async (command) => {
      commands.push(command)
      return { ok: true, content: 'ready\n' }
    },
  })

  assert.deepEqual(commands, ['echo ready'])
  assert.equal(prompt, withSkillDir(process.cwd(), 'Shell: ready\nArgs: hello !`do not run`'))
})

test('buildSkillCommandPrompt rejects failed inline shell and does not continue', async () => {
  await assert.rejects(
    () => buildSkillCommandPrompt({
      name: 'shell-fail',
      description: 'shell',
      content: 'Shell: !`exit 1`',
      skillDir: process.cwd(),
    }, '', {
      runShellCommand: async () => ({ ok: false, content: 'boom', errorCode: 'command_failed' }),
    }),
    /Inline shell command failed/,
  )
})

test('registerSkillCommands registers disk skills as slash commands', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-runner'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-runner', 'SKILL.md'),
      '---\nname: slash-runner\ndescription: Run as slash command\n---\n\nPrompt: $ARGUMENTS',
      'utf8',
    )

    const registry = new CommandRegistry()
    const result = await registerSkillCommands(registry, dir)
    const command = registry.get('slash-runner')
    const submitted: Array<{ input: string; options?: unknown }> = []

    assert.deepEqual(result, { registered: 1, skipped: [] })
    assert.ok(command)
    assert.equal(command.description, 'Run as slash command')

    await command.run('hello world', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(submitted, [{
      input: withSkillDir(path.join(skillsDir, 'slash-runner'), 'Prompt: hello world'),
      options: {
        skillName: 'slash-runner',
        skillArgs: 'hello world',
        displayInput: '/slash-runner hello world',
      },
    }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command display input omits trailing space without args', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-display-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-display'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-display', 'SKILL.md'),
      '---\nname: slash-display\ndescription: Display command\n---\n\nPrompt body',
      'utf8',
    )

    const registry = new CommandRegistry()
    await registerSkillCommands(registry, dir)
    const command = registry.get('slash-display')
    const submitted: Array<{ input: string; options?: unknown }> = []

    assert.ok(command)
    await command.run('', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(submitted, [{
      input: withSkillDir(path.join(skillsDir, 'slash-display'), 'Prompt body'),
      options: {
        skillName: 'slash-display',
        skillArgs: '',
        displayInput: '/slash-display',
      },
    }])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command submits rich execution options', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-rich-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-rich'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-rich', 'SKILL.md'),
      [
        '---',
        'name: slash-rich',
        'description: Rich command',
        'allowedTools: [Read, Bash]',
        'model: powerful',
        'effort: high',
        'hooks:',
        '  stop:',
        '    - command: "echo stop"',
        '---',
        '',
        'Prompt: !`echo shell` $ARGUMENTS',
      ].join('\n'),
      'utf8',
    )

    const registry = new CommandRegistry()
    await registerSkillCommands(registry, dir)
    const command = registry.get('slash-rich')
    const submitted: Array<{ input: string; options?: unknown }> = []
    const shellCommands: string[] = []

    assert.ok(command)
    await command.run('hello world', {
      cwd: dir,
      sessionId: 's1',
      writeLine: () => {},
      clearMessages: () => {},
      runShellCommand: async (command) => {
        shellCommands.push(command)
        return { ok: true, content: 'shell-output' }
      },
      submitQuery: async (input, options) => {
        submitted.push({ input, options })
      },
    })

    assert.deepEqual(shellCommands, ['echo shell'])
    assert.equal(submitted[0]?.input, withSkillDir(path.join(skillsDir, 'slash-rich'), 'Prompt: shell-output hello world'))
    assert.deepEqual(submitted[0]?.options, {
      allowedTools: ['Read', 'Bash'],
      model: 'powerful',
      effort: 'high',
      hooks: { stop: [{ command: 'echo stop' }] },
      skillName: 'slash-rich',
      skillArgs: 'hello world',
      displayInput: '/slash-rich hello world',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registered skill command requires shell helper for inline shell', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-shell-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-shell'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-shell', 'SKILL.md'),
      '---\nname: slash-shell\ndescription: Shell command\n---\n\nPrompt: !`echo shell`',
      'utf8',
    )

    const registry = new CommandRegistry()
    await registerSkillCommands(registry, dir)
    const command = registry.get('slash-shell')

    assert.ok(command)
    await assert.rejects(
      () => command.run('', {
        cwd: dir,
        sessionId: 's1',
        writeLine: () => {},
        clearMessages: () => {},
        submitQuery: async () => {
          throw new Error('submitQuery should not run')
        },
      }),
      /shell execution is not available/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('registerSkillCommands skips commands whose names are already registered', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-conflict-'))
  try {
    // Registered explicitly rather than leaning on whatever the rest of the
    // suite left in a shared map: the registry is per-project now, so the
    // collision has to be set up inside the one under test.
    const registry = new CommandRegistry()
    registry.register({
      name: 'slash-conflict-target',
      description: 'Existing command',
      run: async () => {},
    })

    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-conflict-target'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-conflict-target', 'SKILL.md'),
      '---\nname: slash-conflict-target\ndescription: Skill command\n---\n\nSkill content',
      'utf8',
    )

    const result = await registerSkillCommands(registry, dir)

    assert.deepEqual(result, { registered: 0, skipped: ['slash-conflict-target'] })
    assert.equal(registry.get('slash-conflict-target')?.description, 'Existing command')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/**
 * `registerSkillCommands` is the reload path too (`ProjectRuntime.reloadSkills`
 * calls nothing else), so a second pass has to *replace* what the first one
 * registered. Before `clearSkills()` existed, the pass saw its own entry through
 * `has()`, logged "command name is already in use" and kept the stale copy.
 */
test('registerSkillCommands replaces its own previous entries on reload', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-reload-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    const skillFile = path.join(skillsDir, 'slash-reload', 'SKILL.md')
    await mkdir(path.join(skillsDir, 'slash-reload'), { recursive: true })
    await writeFile(
      skillFile,
      '---\nname: slash-reload\ndescription: First description\n---\n\nFirst prompt',
      'utf8',
    )

    // A built-in that must survive every reload, and shadow a same-named skill
    // on each pass rather than only on the first.
    const registry = new CommandRegistry()
    registry.register({ name: 'slash-builtin', description: 'Built-in', run: async () => {} })
    await mkdir(path.join(skillsDir, 'slash-builtin'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-builtin', 'SKILL.md'),
      '---\nname: slash-builtin\ndescription: Skill copy\n---\n\nSkill content',
      'utf8',
    )

    const first = await registerSkillCommands(registry, dir)
    assert.deepEqual(first, { registered: 1, skipped: ['slash-builtin'] })
    assert.equal(registry.get('slash-reload')?.description, 'First description')

    await writeFile(
      skillFile,
      '---\nname: slash-reload\ndescription: Second description\n---\n\nSecond prompt',
      'utf8',
    )

    const second = await registerSkillCommands(registry, dir)
    assert.deepEqual(second, { registered: 1, skipped: ['slash-builtin'] })
    assert.equal(registry.get('slash-reload')?.description, 'Second description')
    assert.equal(registry.get('slash-builtin')?.description, 'Built-in')

    // A deleted skill loses its command instead of outliving its file.
    await rm(path.join(skillsDir, 'slash-reload'), { recursive: true, force: true })
    const third = await registerSkillCommands(registry, dir)
    assert.deepEqual(third, { registered: 0, skipped: ['slash-builtin'] })
    assert.equal(registry.get('slash-reload'), undefined)
    assert.equal(registry.list().some((command) => command.name === 'slash-reload'), false)
    assert.ok(registry.get('slash-builtin'), 'built-ins are not skill-owned')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('skill slash command reports missing query submission support', async () => {  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-skill-command-submit-'))
  try {
    const skillsDir = path.join(dir, '.myagent', 'skills')
    await mkdir(path.join(skillsDir, 'slash-requires-submit'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'slash-requires-submit', 'SKILL.md'),
      '---\nname: slash-requires-submit\ndescription: Needs submit\n---\n\nSkill content',
      'utf8',
    )

    const registry = new CommandRegistry()
    await registerSkillCommands(registry, dir)
    const command = registry.get('slash-requires-submit')

    assert.ok(command)
    await assert.rejects(
      () => command.run('', {
        cwd: dir,
        sessionId: 's1',
        writeLine: () => {},
        clearMessages: () => {},
      }),
      /requires query submission support/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// --- importSkill --------------------------------------------------------------

/** A folder shaped like a skill, somewhere outside the project. */
async function sourceSkill(name: string, body = 'Do the thing.'): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'myagent-import-'))
  const source = path.join(dir, `${name}-folder`)
  await mkdir(source, { recursive: true })
  await writeFile(
    path.join(source, 'SKILL.md'),
    `---\nname: ${name}\ndescription: An imported skill\n---\n\n${body}`,
    'utf8',
  )
  return source
}

test('importSkill copies the folder in, and the service picks it up', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await sourceSkill('imported')
  try {
    // An attachment beside the markdown: a skill is a folder, so it comes too.
    await writeFile(path.join(source, 'reference.md'), 'more', 'utf8')

    const { name } = await importSkill(cwd, source)
    assert.equal(name, 'imported')

    const skills = await new SkillsService(cwd).listAll()
    assert.deepEqual(skills.map((skill) => skill.name), ['imported'])
    const copied = await readFile(path.join(cwd, '.myagent', 'skills', 'imported', 'reference.md'), 'utf8')
    assert.equal(copied, 'more')
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('importSkill refuses a folder that is not a skill', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await mkdtemp(path.join(os.tmpdir(), 'myagent-notaskill-'))
  try {
    await assert.rejects(() => importSkill(cwd, source), /SKILL\.md/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('importSkill refuses to overwrite a skill of the same name', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await sourceSkill('twice')
  try {
    await importSkill(cwd, source)
    await assert.rejects(() => importSkill(cwd, source), /已经有一个叫 twice 的技能/)
    // The first copy is intact: a refused import must not half-replace it.
    const raw = await readFile(path.join(cwd, '.myagent', 'skills', 'twice', 'SKILL.md'), 'utf8')
    assert.ok(raw.includes('Do the thing.'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('importSkill refuses a frontmatter name that escapes the skills directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await sourceSkill('../escaped')
  try {
    await assert.rejects(() => importSkill(cwd, source), /不能作为文件夹名/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
  }
})

test('importSkill can copy into the personal folder, which every project reads', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await sourceSkill('shared-import')
  try {
    const { name, disabled } = await importSkill(cwd, source, { target: 'personal' })
    assert.equal(name, 'shared-import')
    assert.equal(disabled, false)

    // The copy is the user's, not the project's: the repo gets no `.myagent/`.
    const imported = (await new SkillsService(cwd).listAll()).find((skill) => skill.name === 'shared-import')
    assert.ok(imported, 'the shared folder is read alongside the project one')
    assert.equal(imported.source, 'shared')
    assert.equal(imported.root?.label, '~/.agents/skills')
    await assert.rejects(
      () => readFile(path.join(cwd, '.myagent', 'skills', 'shared-import', 'SKILL.md'), 'utf8'),
      /ENOENT/,
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(path.join(getSharedSkillsDir(), 'shared-import'), { recursive: true, force: true })
  }
})

test('a high-risk personal import lands switched off for every project', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  const source = await sourceSkill('hooked-personal')
  try {
    await writeFile(
      path.join(source, 'SKILL.md'),
      '---\nname: hooked-personal\ndescription: Hooked\nhooks:\n  sessionStart:\n    - command: echo hi\n---\n\nBody.\n',
      'utf8',
    )
    const risks: string[] = []
    const { disabled } = await importSkill(cwd, source, {
      target: 'personal',
      confirm: async (prompt) => {
        risks.push(prompt.risk)
        return true
      },
    })
    assert.deepEqual(risks, ['high'])
    assert.equal(disabled, true)

    // The user layer is the one place a personal skill's state belongs: a local
    // entry would leave it switched on in every other project.
    const user = await loadUserSettings()
    assert.deepEqual(user.skills?.disabled, ['hooked-personal'])
    assert.deepEqual(await readLocalLayer(cwd), {})
    // Off in this project too, through the merge rather than a second write.
    assert.deepEqual((await loadMergedSettings(cwd)).skills?.disabled, ['hooked-personal'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(source, { recursive: true, force: true })
    await rm(path.join(getSharedSkillsDir(), 'hooked-personal'), { recursive: true, force: true })
  }
})

// --- removeSkill --------------------------------------------------------------

/** The project's local settings layer, or `{}` when this test wrote none. */
async function readLocalLayer(cwd: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(localSettingsPath(cwd), 'utf8')) as Record<string, unknown>
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
}

test('removeSkill deletes a managed folder and clears its local switch', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  try {
    const skillDir = path.join(cwd, '.myagent', 'skills', 'gone')
    await mkdir(skillDir, { recursive: true })
    await writeFile(path.join(skillDir, 'SKILL.md'), '---\nname: gone\ndescription: Gone\n---\n\nBody.\n', 'utf8')
    await updateLocalSettings(cwd, { skills: { disabled: ['gone'] } })

    await removeSkill(cwd, 'gone')

    await assert.rejects(() => readFile(path.join(skillDir, 'SKILL.md'), 'utf8'), /ENOENT/)
    assert.deepEqual((await readLocalLayer(cwd)).skills, { disabled: [] })
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test("removeSkill refuses another tool's folder and leaves it alone", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'myagent-project-'))
  try {
    const compatDir = path.join(cwd, '.claude', 'skills', 'theirs')
    await mkdir(compatDir, { recursive: true })
    await writeFile(path.join(compatDir, 'SKILL.md'), '---\nname: theirs\ndescription: Theirs\n---\n\nBody.\n', 'utf8')

    await assert.rejects(() => removeSkill(cwd, 'theirs'), /不会改动它/)
    // Still there: a refusal is not a partial delete.
    assert.ok((await readFile(path.join(compatDir, 'SKILL.md'), 'utf8')).includes('Body.'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
