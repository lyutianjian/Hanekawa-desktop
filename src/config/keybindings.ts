import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface KeybindingsConfig {
  doubleTapWindow: number
}

const DEFAULT_DOUBLE_TAP_WINDOW = 300

/**
 * Validates that a value is a valid doubleTapWindow:
 * must be an integer in [100, 1000].
 */
function isValidDoubleTapWindow(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 1000
  )
}

/**
 * Loads keybindings configuration from `.hanekawa/keybindings.json`.
 * Returns default values if the file is missing, malformed, or contains invalid values.
 */
export function loadKeybindingsConfig(cwd: string): KeybindingsConfig {
  const filePath = path.join(cwd, '.hanekawa', 'keybindings.json')

  try {
    const raw = readFileSync(filePath, 'utf8')
    const parsed = JSON.parse(raw)

    const doubleTapWindow = isValidDoubleTapWindow(parsed?.doubleTapWindow)
      ? parsed.doubleTapWindow
      : DEFAULT_DOUBLE_TAP_WINDOW

    return { doubleTapWindow }
  } catch {
    // Missing file, malformed JSON, or any other error → use defaults
    return { doubleTapWindow: DEFAULT_DOUBLE_TAP_WINDOW }
  }
}
