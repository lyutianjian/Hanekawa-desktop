import { cpSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'

/** The old Electron `userData` directory, moved once on the first launch. */
const LEGACY_USER_DATA_DIR = 'myagent'

/**
 * What is worth carrying over: the window placement this app writes, the
 * renderer's theme/sidebar preferences (localStorage lives under `Local
 * Storage`), and Electron's own preferences. Caches and crash reports are not.
 */
const MIGRATED_ENTRIES = ['window-state.json', 'Preferences', 'Local Storage'] as const

export type UserDataMigrationOutcome = 'moved' | 'copied' | 'absent' | 'failed'

export function fixUserDataPaths(app: {
  getPath(name: 'appData'): string
  setPath(name: 'userData' | 'sessionData', value: string): void
}): void {
  const directory = path.join(app.getPath('appData'), 'hanekawa')
  mkdirSync(directory, { recursive: true })
  app.setPath('userData', directory)
  app.setPath('sessionData', directory)
}

export function legacyUserDataPath(appData: string): string {
  return path.join(appData, LEGACY_USER_DATA_DIR)
}

/**
 * Moves the old `userData` directory when the new one does not exist yet.
 * `requestSingleInstanceLock` has usually created the new directory first, so
 * the common path copies the few entries a person would notice losing.
 * An entry already present at the destination is never overwritten or merged.
 */
export function migrateLegacyUserData(legacyDir: string, currentDir: string): UserDataMigrationOutcome {
  if (!existsSync(legacyDir) || path.resolve(legacyDir) === path.resolve(currentDir)) return 'absent'

  if (!existsSync(currentDir)) {
    try {
      renameSync(legacyDir, currentDir)
      return 'moved'
    } catch {
      // Fall through to copying; the directory may be locked.
    }
  }

  try {
    mkdirSync(currentDir, { recursive: true })
    for (const entry of MIGRATED_ENTRIES) {
      const source = path.join(legacyDir, entry)
      const target = path.join(currentDir, entry)
      if (existsSync(source) && !existsSync(target)) cpSync(source, target, { recursive: true })
    }
    return 'copied'
  } catch {
    return 'failed'
  }
}
