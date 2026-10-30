import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadKeybindingsConfig } from '../src/config/keybindings.js'

/**
 * Unit tests for loadKeybindingsConfig.
 *
 * Each test creates an isolated temp directory and writes (or omits) a
 * `.hanekawa/keybindings.json` file inside it, then asserts the loader's
 * behavior. This keeps tests hermetic and independent of the user's
 * actual config.
 */

const DEFAULT = 300

async function makeTempCwd(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'hanekawa-keybindings-'))
}

async function writeKeybindings(cwd: string, body: string): Promise<void> {
  const dir = path.join(cwd, '.hanekawa')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'keybindings.json'), body, 'utf8')
}

describe('loadKeybindingsConfig', () => {
  it('returns a valid integer doubleTapWindow when present', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 500 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, 500)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('accepts the lower bound (100)', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 100 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, 100)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('accepts the upper bound (1000)', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 1000 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, 1000)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default (300) when the keybindings file is missing', async () => {
    const cwd = await makeTempCwd()
    try {
      // No `.hanekawa/keybindings.json` is written.
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when the JSON is malformed', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, '{ this is not valid json')
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when doubleTapWindow is below the valid range', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 50 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when doubleTapWindow is above the valid range', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 5000 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when doubleTapWindow is a non-integer number', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: 250.5 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when doubleTapWindow is the wrong type (string)', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: '300' }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when doubleTapWindow is null', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ doubleTapWindow: null }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })

  it('returns the default when the doubleTapWindow field is absent', async () => {
    const cwd = await makeTempCwd()
    try {
      await writeKeybindings(cwd, JSON.stringify({ otherField: 42 }))
      const config = loadKeybindingsConfig(cwd)
      assert.equal(config.doubleTapWindow, DEFAULT)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
  })
})
