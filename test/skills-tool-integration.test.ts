import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'
import { getAllTools, getBuiltinTools } from '../src/tools/index.js'

test('getAllTools() includes builtin tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const tools = await getAllTools()
    const builtinTools = getBuiltinTools()

    // Should include all builtin tools
    for (const builtin of builtinTools) {
      const found = tools.find(t => t.name === builtin.name)
      assert.ok(found, `Missing builtin tool: ${builtin.name}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getAllTools() includes the generic Skill tool', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Use when diagnosing bugs\n---\n\nDebug content',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'tdd'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'tdd', 'SKILL.md'),
      '---\nname: tdd\ndescription: Test-driven development\n---\n\nTDD content',
      'utf8'
    )

    const tools = await getAllTools()

    const skillTool = tools.find(t => t.name === 'Skill')

    assert.ok(skillTool, 'Missing Skill tool')
    assert.equal(tools.some(t => t.name === 'skill_debugging'), false)
    assert.equal(tools.some(t => t.name === 'skill_tdd'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tools do not conflict with builtin tools', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Debug skill\n---\n\nContent',
      'utf8'
    )

    const tools = await getAllTools()
    const names = tools.map(t => t.name)

    // Check for duplicates
    const uniqueNames = new Set(names)
    assert.equal(names.length, uniqueNames.size, 'Tool names should be unique')

    const skillTools = tools.filter(t => t.name.startsWith('skill_'))
    assert.equal(skillTools.length, 0, 'Should not expose per-skill tools')

    const builtinTools = tools.filter(t => t.name !== 'Skill')
    assert.ok(builtinTools.length > 0, 'Should have builtin tools')
    assert.ok(tools.find(t => t.name === 'Skill'), 'Should have generic Skill tool')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tools have riskLevel safe', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'test'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'test', 'SKILL.md'),
      '---\nname: test\ndescription: Test skill\n---\n\nContent',
      'utf8'
    )

    const tools = await getAllTools()
    const skillTool = tools.find(t => t.name === 'Skill')

    assert.ok(skillTool)
    assert.equal(skillTool.riskLevel, 'safe')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tool execution returns skill content', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'debugging'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'debugging', 'SKILL.md'),
      '---\nname: debugging\ndescription: Debug skill\n---\n\n# Debug Workflow\n\n1. Reproduce\n2. Fix',
      'utf8'
    )

    const tools = await getAllTools()
    const skillTool = tools.find(t => t.name === 'Skill')

    assert.ok(skillTool)

    const result = await skillTool.execute({ skill: 'debugging' }, {
      cwd: dir,
      sessionId: 'test',
      readFiles: new Set<string>()
    })

    assert.equal(result.ok, true)
    assert.match(result.content, /Debug Workflow/)
    assert.match(result.content, /Reproduce/)
    assert.ok(result.content.startsWith(`Base directory for this skill: ${path.join(skillsDir, 'debugging')}\n`))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Multiple calls to same skill tool return consistent results', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'test'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'test', 'SKILL.md'),
      '---\nname: test\ndescription: Test\n---\n\nTest content',
      'utf8'
    )

    const tools = await getAllTools()
    const skillTool = tools.find(t => t.name === 'Skill')

    assert.ok(skillTool)

    const context = { cwd: dir, sessionId: 'test', readFiles: new Set<string>() }
    const result1 = await skillTool.execute({ skill: 'test' }, context)
    const result2 = await skillTool.execute({ skill: 'test' }, context)

    assert.deepEqual(result1, result2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('getAllTools() works when no skills directory exists', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const tools = await getAllTools()
    const builtinTools = getBuiltinTools()

    // getAllTools adds Skill, and may also add ToolSearch when tool search is enabled
    assert.ok(tools.length >= builtinTools.length + 1)
    assert.ok(tools.find(t => t.name === 'Skill'))
    // All builtin tools should be present
    for (const builtin of builtinTools) {
      assert.ok(tools.find(t => t.name === builtin.name), `Missing builtin tool: ${builtin.name}`)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Skill tool and builtin tools coexist in tool list', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-tools-'))
  try {
    const skillsDir = path.join(dir, '.hanekawa', 'skills')
    await mkdir(path.join(skillsDir, 'skill1'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'skill1', 'SKILL.md'),
      '---\nname: skill1\ndescription: Skill 1\n---\n\nContent 1',
      'utf8'
    )

    await mkdir(path.join(skillsDir, 'skill2'), { recursive: true })
    await writeFile(
      path.join(skillsDir, 'skill2', 'SKILL.md'),
      '---\nname: skill2\ndescription: Skill 2\n---\n\nContent 2',
      'utf8'
    )

    const tools = await getAllTools()
    const builtinTools = getBuiltinTools()

    // getAllTools adds Skill, and may also add ToolSearch when tool search is enabled
    assert.ok(tools.length >= builtinTools.length + 1)

    // Verify all builtin tools are present
    for (const builtin of builtinTools) {
      assert.ok(tools.find(t => t.name === builtin.name))
    }

    assert.ok(tools.find(t => t.name === 'Skill'))
    assert.equal(tools.some(t => t.name.startsWith('skill_')), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
