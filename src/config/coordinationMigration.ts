/**
 * One-time promotion of the six retired project-level scheduling values into
 * the global config.
 *
 * The preferred source is the user's global settings plus every registered
 * project's personal layer, `~/.myagent/projects/<key>/settings.local.json`.
 * A repository's own `.myagent/settings.json` is deliberately not read: it is
 * checked-in data and must never become account configuration.
 *
 * Behaviour, per field:
 *  - the global value already exists (an explicit `inherit` counts) → kept; an
 *    old value that equals it is cleaned up, one that differs is reported and
 *    left alone so the conflict has not been silently resolved;
 *  - one distinct valid value across the trusted sources → written globally;
 *  - several distinct valid values → reported, nothing chosen;
 *  - an unusable value → reported, left where it is.
 *
 * The global file is written (and backed up) before any old field is removed,
 * so a failure half-way is a retry, not a lost setting. Running twice does
 * nothing the second time: global values are present and the cleaned fields are
 * gone.
 */

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readConfigurationFile, updateConfigurationFile } from './file.js'
import { getGlobalMyAgentDir } from '../utils/paths.js'
import { localSettingsPath } from './settings.js'
import { VALID_EFFORT_LEVELS, type EffortLevel } from './effort.js'
import type { ConfigService } from './service.js'

/** The group exactly as the retired feature wrote it. */
export interface LegacyCoordination {
  coordinatorModel?: unknown
  threadModel?: unknown
  coordinatorEffort?: unknown
  threadEffort?: unknown
  quietDays?: unknown
  autoResolveDays?: unknown
}

const MODEL_FIELDS = [
  { field: 'coordinatorModel', role: 'coordinator' },
  { field: 'threadModel', role: 'thread' },
] as const

const EFFORT_FIELDS = ['coordinatorEffort', 'threadEffort'] as const
const DAY_FIELDS = ['quietDays', 'autoResolveDays'] as const

const ALL_FIELDS = [
  ...MODEL_FIELDS.map((entry) => entry.field),
  ...EFFORT_FIELDS,
  ...DAY_FIELDS,
] as const

type Field = (typeof ALL_FIELDS)[number]

export interface CoordinationMigrationResult {
  /** Diagnostics for anything not migrated cleanly; shown at startup. */
  findings: string[]
  /** `field -> value` pairs this run wrote to the global config. */
  migrated: Partial<Record<Field, string | number>>
}

interface Source {
  path: string
  /** How the findings name it: a file path for the global layer, a project root otherwise. */
  label: string
  coordination: LegacyCoordination
}

const BACKUP_SUFFIX = '.pre-coordination-migration.bak'

export async function migrateCoordinationSettings(input: {
  config: ConfigService
  roots: readonly string[]
  home?: string
}): Promise<CoordinationMigrationResult> {
  const { config } = input
  const findings: string[] = []
  // Read off disk rather than from `config.get()`: the loaded config has every
  // routing key materialized to `'inherit'`, and an explicit `inherit` has to
  // be told apart from "never configured".
  const raw = await readConfigurationFile<{
    routing?: Record<string, unknown>
    agent?: { coordination?: Record<string, unknown> }
  }>(config.getSaveTarget()) ?? {}
  const explicit = {
    routing: raw.routing ?? {},
    coordination: raw.agent?.coordination ?? {},
  }
  const sources = await readSources(input.roots, input.home, findings)
  const migrated: Partial<Record<Field, string | number>> = {}
  /** The value each field ends up with globally; cleanup removes sources that agree. */
  const targets: Partial<Record<Field, string | number>> = {}
  /**
   * Fields whose global value is already settled and whose old values therefore
   * lose. They are cleaned even when they disagree — otherwise every launch
   * would report the same conflict the user already answered.
   */
  const superseded = new Set<Field>()

  for (const field of ALL_FIELDS) {
    const candidates: Array<{ value: string | number; label: string }> = []
    for (const source of sources) {
      const normalized = normalize(field, source.coordination[field])
      if (normalized.kind === 'invalid') {
        findings.push(`${source.label} 的 ${field} ${normalized.reason}，已跳过。`)
        continue
      }
      if (normalized.kind === 'absent') continue
      candidates.push({ value: normalized.value, label: source.label })
    }
    if (candidates.length === 0) continue

    const current = currentGlobal(config, explicit, field)
    if (current !== undefined) {
      const differing = candidates.filter((candidate) => String(candidate.value) !== String(current))
      if (differing.length > 0) {
        const listed = differing.map((candidate) => `${candidate.value}（${candidate.label}）`).join('、')
        findings.push(`${field} 已有全局值 ${current}；旧值 ${listed} 与它不同，按全局值处理并清理。`)
        superseded.add(field)
      }
      // A source that already agrees with the global value is redundant data.
      targets[field] = current
      continue
    }

    const distinct = [...new Map(candidates.map((candidate) => [String(candidate.value), candidate])).values()]
    if (distinct.length > 1) {
      const listed = distinct.map((candidate) => `${candidate.value}（${candidate.label}）`).join('、')
      findings.push(`${field} 在多个项目里取值不同：${listed}；没有自动选择，请在「线程调度」里选一个全局值。`)
      continue
    }

    writeGlobal(config, field, distinct[0]!.value)
    migrated[field] = distinct[0]!.value
    targets[field] = distinct[0]!.value
  }

  if (Object.keys(migrated).length > 0) {
    await backupFile(input.config.getSaveTarget())
    await input.config.save()
  }

  for (const source of sources) {
    await cleanSource(source, targets, superseded, findings)
  }

  // Report a promoted model that does not resolve *now*: the value is kept on
  // purpose, so the screen can show the broken reference.
  for (const { field, role } of MODEL_FIELDS) {
    const value = migrated[field]
    if (typeof value !== 'string' || value === 'inherit') continue
    if (!input.config.resolveModel(value)) {
      findings.push(`${field} 已迁入 routing.${role}，但目前没有名为 ${value} 的模型。`)
    }
  }

  return { findings, migrated }
}

async function readSources(
  roots: readonly string[],
  home: string | undefined,
  findings: string[],
): Promise<Source[]> {
  const globalPath = join(home ?? getGlobalMyAgentDir(), 'settings.json')
  const entries: Array<{ path: string; label: string }> = [{ path: globalPath, label: globalPath }]
  for (const root of roots) entries.push({ path: localSettingsPath(root), label: root })

  const sources: Source[] = []
  for (const entry of entries) {
    const parsed = await readSettings(entry.path, findings)
    if (!parsed) continue
    const coordination = parsed.coordination
    if (!coordination || typeof coordination !== 'object') continue
    sources.push({ ...entry, coordination: coordination as LegacyCoordination })
  }
  return sources
}

async function readSettings(
  path: string,
  findings: string[],
): Promise<{ coordination?: unknown } | undefined> {
  try {
    return await readConfigurationFile<{ coordination?: unknown }>(path)
  } catch (error) {
    findings.push(`${(error as Error).message} 已跳过迁移。`)
    return undefined
  }
}

type Normalized = { kind: 'absent' } | { kind: 'invalid'; reason: string } | { kind: 'value'; value: string | number }

function normalize(field: Field, value: unknown): Normalized {
  if (value === undefined) return { kind: 'absent' }
  if ((MODEL_FIELDS as readonly { field: Field }[]).some((entry) => entry.field === field)) {
    if (typeof value !== 'string' || value.trim() === '') return { kind: 'invalid', reason: '不是有效的模型 key' }
    return { kind: 'value', value: value.trim() }
  }
  if ((EFFORT_FIELDS as readonly Field[]).includes(field)) {
    if (!(VALID_EFFORT_LEVELS as readonly unknown[]).includes(value)) {
      return { kind: 'invalid', reason: `不是合法的思考强度（${String(value)}）` }
    }
    return { kind: 'value', value: value as EffortLevel }
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return { kind: 'invalid', reason: `不是不小于 0 的整数（${String(value)}）` }
  }
  return { kind: 'value', value }
}

function currentGlobal(
  config: ConfigService,
  explicit: { routing: Record<string, unknown>; coordination: Record<string, unknown> },
  field: Field,
): string | number | undefined {
  const model = (MODEL_FIELDS as readonly { field: Field; role: 'coordinator' | 'thread' }[]).find(
    (entry) => entry.field === field,
  )
  if (model) {
    // An explicit `inherit` counts as configured; a defaulted one does not.
    const written = explicit.routing[model.role]
    if (typeof written === 'string') return written
    const live = config.getRouting()[model.role]
    return live !== undefined && live !== 'inherit' ? live : undefined
  }
  const value = config.get().agent.coordination?.[field as 'quietDays'] ?? explicit.coordination[field]
  return typeof value === 'string' || typeof value === 'number' ? value : undefined
}

function writeGlobal(config: ConfigService, field: Field, value: string | number): void {
  const model = (MODEL_FIELDS as readonly { field: Field; role: 'coordinator' | 'thread' }[]).find(
    (entry) => entry.field === field,
  )
  if (model) {
    config.setCoordinationRouting(model.role, String(value), { allowUnknown: true })
    return
  }
  config.setCoordination({ [field]: value } as Parameters<ConfigService['setCoordination']>[0])
}

/**
 * Removes the fields a source agrees with, plus every field whose global value
 * is already settled, and nothing else.
 *
 * An unresolved conflict or an invalid value stays: deleting it here would be
 * the silent choice this migration refuses to make.
 */
async function cleanSource(
  source: Source,
  targets: Partial<Record<Field, string | number>>,
  superseded: ReadonlySet<Field>,
  findings: string[],
): Promise<void> {
  const removable = ALL_FIELDS.filter((field) => {
    const target = targets[field]
    if (target === undefined) return false
    const normalized = normalize(field, source.coordination[field])
    if (normalized.kind !== 'value') return false
    return superseded.has(field) || String(normalized.value) === String(target)
  })
  if (removable.length === 0) return

  try {
    await updateConfigurationFile<Record<string, unknown>>(source.path, async (before) => {
      const remaining: Record<string, unknown> = { ...(before.coordination as Record<string, unknown> | undefined) }
      for (const field of removable) {
        if (remaining[field] === source.coordination[field]) delete remaining[field]
      }
      const next: Record<string, unknown> = { ...before }
      if (Object.keys(remaining).length > 0) next.coordination = remaining
      else delete next.coordination
      await backupFile(source.path)
      return next
    })
  } catch (error) {
    findings.push(`${source.path} 清理旧字段失败（${(error as Error).message}），下次启动会重试。`)
  }
}

/** Keeps the first backup of a file: a retry must not overwrite the original bytes. */
async function backupFile(path: string): Promise<void> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    await writeFile(`${path}${BACKUP_SUFFIX}`, bytes, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
}