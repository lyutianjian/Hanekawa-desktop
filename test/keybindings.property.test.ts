import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import fc from 'fast-check'
import { loadKeybindingsConfig } from '../src/config/keybindings.js'

/**
 * Property 9: Double-tap window configuration validation.
 *
 * For any value V written to `.hanekawa/keybindings.json` as `doubleTapWindow`:
 *   - if V is an integer in [100, 1000] inclusive, the effective window equals V
 *   - otherwise (float, non-number, out of range, null, missing, malformed),
 *     the effective window equals 300 (the default)
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.6
 */
describe('Property 9: doubleTapWindow configuration validation', () => {
  const DEFAULT_WINDOW = 300
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), 'hanekawa-keybindings-prop-'))
    await mkdir(path.join(tmpDir, '.hanekawa'), { recursive: true })
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  /**
   * Writes the given JSON-serializable value as the `doubleTapWindow` field
   * of `.hanekawa/keybindings.json` in the temp dir.
   *
   * Uses a manual JSON document so values like `null` are preserved exactly
   * (JSON.stringify of `{doubleTapWindow: undefined}` would drop the key).
   */
  async function writeKeybindings(rawValueJson: string): Promise<void> {
    const content = `{"doubleTapWindow": ${rawValueJson}}`
    await writeFile(path.join(tmpDir, '.hanekawa', 'keybindings.json'), content, 'utf8')
  }

  it('accepts any integer in [100, 1000] inclusive (Validates: Requirements 7.2, 7.3)', () => {
    return fc.assert(
      fc.asyncProperty(fc.integer({ min: 100, max: 1000 }), async (n) => {
        await writeKeybindings(JSON.stringify(n))
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          n,
          `Expected window ${n} for valid integer input, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('rejects integers outside [100, 1000] and falls back to 300 (Validates: Requirements 7.3, 7.4)', () => {
    const outOfRange = fc.oneof(
      fc.integer({ min: -1_000_000, max: 99 }),
      fc.integer({ min: 1001, max: 1_000_000 }),
    )
    return fc.assert(
      fc.asyncProperty(outOfRange, async (n) => {
        await writeKeybindings(JSON.stringify(n))
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for out-of-range integer ${n}, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('rejects non-integer floats and falls back to 300 (Validates: Requirements 7.3, 7.4)', () => {
    // Generate a finite float that is NOT an integer.
    const nonIntegerFloat = fc
      .double({ min: -10_000, max: 10_000, noNaN: true, noDefaultInfinity: true })
      .filter((v) => Number.isFinite(v) && !Number.isInteger(v))
    return fc.assert(
      fc.asyncProperty(nonIntegerFloat, async (n) => {
        await writeKeybindings(JSON.stringify(n))
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for non-integer float ${n}, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('rejects strings and falls back to 300 (Validates: Requirements 7.4)', () => {
    return fc.assert(
      fc.asyncProperty(fc.string(), async (s) => {
        // Always serialize as a JSON string so we test the "string" type case
        // (not a string that happens to parse as a number).
        await writeKeybindings(JSON.stringify(s))
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for string input ${JSON.stringify(s)}, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('rejects null and falls back to 300 (Validates: Requirements 7.4)', () => {
    return fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        await writeKeybindings('null')
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for null input, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('rejects arbitrary invalid JSON values (booleans, arrays, objects) and falls back to 300 (Validates: Requirements 7.4)', () => {
    // Mix of invalid JSON-shaped values that are neither integers in [100, 1000] nor missing.
    const invalidValue = fc.oneof(
      fc.boolean().map((b) => JSON.stringify(b)),
      fc.constant('null'),
      fc.array(fc.integer()).map((a) => JSON.stringify(a)),
      fc.dictionary(fc.string(), fc.integer()).map((o) => JSON.stringify(o)),
    )
    return fc.assert(
      fc.asyncProperty(invalidValue, async (rawJson) => {
        await writeKeybindings(rawJson)
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for invalid JSON value ${rawJson}, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })

  it('falls back to 300 when keybindings.json is missing (Validates: Requirements 7.6)', async () => {
    // No keybindings.json written in beforeEach; the .hanekawa directory is empty.
    const config = loadKeybindingsConfig(tmpDir)
    assert.equal(config.doubleTapWindow, DEFAULT_WINDOW)
  })

  it('falls back to 300 for malformed JSON content (Validates: Requirements 7.6)', () => {
    // Random non-JSON text snippets that should not parse as JSON.
    const malformed = fc
      .string({ minLength: 1 })
      .filter((s) => {
        try {
          JSON.parse(s)
          return false // valid JSON - skip
        } catch {
          return true
        }
      })
    return fc.assert(
      fc.asyncProperty(malformed, async (s) => {
        await writeFile(path.join(tmpDir, '.hanekawa', 'keybindings.json'), s, 'utf8')
        const config = loadKeybindingsConfig(tmpDir)
        assert.equal(
          config.doubleTapWindow,
          DEFAULT_WINDOW,
          `Expected default ${DEFAULT_WINDOW} for malformed JSON, got ${config.doubleTapWindow}`,
        )
      }),
      { numRuns: 100 },
    )
  })
})
