import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { readJsonFile, writeJsonFile } from '../utils/json.js'
import { getHanekawaDir, getProjectDataDir } from '../utils/paths.js'
import { withFileLock } from './fileLock.js'

/**
 * Moves a project's runtime data out of `<cwd>/.hanekawa/` into its data dir.
 *
 * Runtime data used to live inside the project; it now lives under
 * `~/.hanekawa/projects/<key>/` (`getProjectDataDir`). A project opened for the
 * first time since then still has its sessions, attachments and plans in the
 * old place, and this is what brings them along.
 *
 * User data, so copy first and delete last: each file is copied, read back and
 * compared before any source file is removed, and a directory whose copy did
 * not fully verify is left exactly as it was. The copy is additive — a file
 * already at the destination is never overwritten — so a half-finished earlier
 * run, or sessions created since, are safe. `sessions/index.json` is the one
 * file both sides legitimately have; the two indexes are merged by id.
 *
 * Personal settings (`settings.local.json`, `agents.local/`) move too: they
 * belong to this user, not the project. Once everything moved, an emptied
 * `<cwd>/.hanekawa/` is removed. One that still holds shared configuration
 * (settings, skills, rules) stays.
 *
 * Reports rather than throws, like `migrateProjectConfig`: a failure is a
 * startup warning naming what stayed behind, never a project that won't open.
 */

/** What `<cwd>/.hanekawa/` used to hold that is not the project's to keep. Shared configuration is not among them. */
export const LEGACY_ENTRIES = [
  'sessions',
  'tool-results',
  'attachments',
  'plans',
  'session-memory',
  'diagnostics',
  // Personal, not project, configuration: nothing to commit, so not the project's.
  'settings.local.json',
  'agents.local',
] as const

export interface LegacyDataFinding {
  /** `failed` means data stayed behind in `<cwd>/.hanekawa/` and the user should hear about it. */
  kind: 'moved' | 'failed'
  message: string
}

export async function migrateLegacyProjectData(cwd: string): Promise<LegacyDataFinding[]> {
  const legacyDir = getHanekawaDir(cwd)
  const pending = LEGACY_ENTRIES.filter((entry) => existsSync(path.join(legacyDir, entry)))
  if (pending.length === 0) return []

  const dataDir = getProjectDataDir(cwd)
  try {
    await mkdir(dataDir, { recursive: true })
  } catch (error) {
    return [{ kind: 'failed', message: `无法创建 ${dataDir}，会话数据仍留在 ${legacyDir}：${describe(error)}` }]
  }

  // A TUI and the desktop app opening the same project at once must not both
  // copy (and then both delete) the same files.
  return withFileLock(path.join(dataDir, 'migration.lock'), async () => {
    const failures: string[] = []
    let moved = 0
    for (const entry of pending) {
      const source = path.join(legacyDir, entry)
      if (!existsSync(source)) continue
      try {
        const problems = (await stat(source)).isDirectory()
          ? await copyTree(source, path.join(dataDir, entry))
          : await copyOne(source, path.join(dataDir, entry))
        if (problems.length > 0) {
          failures.push(...problems)
          continue
        }
        await rm(source, { recursive: true, force: true })
        moved += 1
      } catch (error) {
        failures.push(`${entry}: ${describe(error)}`)
      }
    }
    if (failures.length === 0) await removeIfEmpty(legacyDir)

    const findings: LegacyDataFinding[] = []
    if (moved > 0) findings.push({ kind: 'moved', message: `Moved session data from ${legacyDir} to ${dataDir}.` })
    if (failures.length > 0) {
      findings.push({
        kind: 'failed',
        message: `部分会话数据没能迁移到 ${dataDir}，原数据保留在 ${legacyDir}，未做任何删除：\n${failures.map((f) => `- ${f}`).join('\n')}`,
      })
    }
    return findings
  })
}

/**
 * Copies `source` into `target` without overwriting, verifying every file.
 * Returns what could not be copied; an empty list means every source file now
 * has an identical (or deliberately merged) counterpart at the target.
 */
async function copyTree(source: string, target: string): Promise<string[]> {
  const problems: string[] = []
  await mkdir(target, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      problems.push(...await copyTree(from, to))
      continue
    }
    if (!entry.isFile()) continue
    // A lock belongs to whichever process held it, and that process wrote the
    // old location. Nothing to carry over.
    if (entry.name.endsWith('.lock')) continue
    if (entry.name === 'index.json' && path.basename(source) === 'sessions' && existsSync(to)) {
      try {
        await mergeSessionIndex(from, to)
      } catch (error) {
        problems.push(`${from}: ${describe(error)}`)
      }
      continue
    }
    problems.push(...await copyOne(from, to))
  }
  return problems
}

/** One file, never over an existing different one, verified after the copy. */
async function copyOne(from: string, to: string): Promise<string[]> {
  try {
    if (existsSync(to)) {
      return await sameContent(from, to) ? [] : [`${from} differs from the existing ${to}`]
    }
    await mkdir(path.dirname(to), { recursive: true })
    await copyFile(from, to)
    if (!await sameContent(from, to)) {
      await rm(to, { force: true })
      return [`${from} did not copy intact`]
    }
    return []
  } catch (error) {
    return [`${from}: ${describe(error)}`]
  }
}

interface IndexFile {
  sessions?: Array<{ id?: unknown }>
}

/** Both sides have an index: keep the target's rows, add the source's missing ones. */
async function mergeSessionIndex(from: string, to: string): Promise<void> {
  const legacy = await readJsonFile<IndexFile>(from, {})
  const current = await readJsonFile<IndexFile>(to, {})
  const rows = Array.isArray(current.sessions) ? [...current.sessions] : []
  const known = new Set(rows.map((row) => row?.id))
  for (const row of Array.isArray(legacy.sessions) ? legacy.sessions : []) {
    if (typeof row?.id !== 'string' || known.has(row.id)) continue
    rows.push(row)
    known.add(row.id)
  }
  await writeJsonFile(to, { ...current, sessions: rows })
}

async function sameContent(a: string, b: string): Promise<boolean> {
  const [sa, sb] = await Promise.all([stat(a), stat(b)])
  if (sa.size !== sb.size) return false
  const [ca, cb] = await Promise.all([readFile(a), readFile(b)])
  return ca.equals(cb)
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    if ((await readdir(dir)).length === 0) await rmdir(dir)
  } catch {
    // Gone already, or not ours to judge: leave it.
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
