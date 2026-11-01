import { constants } from 'node:fs'
import { copyFile, readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { promptTokens } from '../harness/usage.js'
import { metricTokenUsage, type SessionMetric } from '../harness/metrics.js'
import { getGlobalHanekawaDir, getSessionsDir } from '../utils/paths.js'
import { parseJsonLines, readJsonFile, writeJsonFile } from '../utils/json.js'
import type { WireShellUsageStatsResult, WireUsageDay } from './shellProtocol.js'

const METRICS_SUFFIX = '.metrics.jsonl'
const READ_CONCURRENCY = 16

const HISTORY_VERSION = 2

type FileDay = Omit<WireUsageDay, 'sessions'>

interface CachedFile {
  mtimeMs: number
  size: number
  path?: string
  parsedVersion?: number
  /** Day of the session's first turn; absent when it has none. */
  firstDay?: string
  days: FileDay[]
}

interface History {
  version: number
  files: Record<string, CachedFile>
}

function dayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseFile(content: string, mtimeMs: number, size: number): CachedFile {
  const days = new Map<string, FileDay>()
  let firstDay: string | undefined
  for (const metric of parseJsonLines<SessionMetric>(content)) {
    const usage = metricTokenUsage(metric)
    if (!usage && metric.event !== 'turn') continue
    const at = new Date(metric.created_at)
    if (Number.isNaN(at.getTime())) continue
    const day = dayKey(at)
    const tokens = usage ? promptTokens(usage) + usage.outputTokens : 0
    if (metric.event === 'turn') firstDay ??= day
    let entry = days.get(day)
    if (!entry) {
      entry = { day, turns: 0, tokens: 0, hours: new Array<number>(24).fill(0), models: {} }
      days.set(day, entry)
    }
    if (metric.event === 'turn') {
      entry.turns += 1
      entry.hours[at.getHours()]! += 1
    }
    entry.tokens += tokens
    if ('model' in metric && tokens > 0) entry.models[metric.model] = (entry.models[metric.model] ?? 0) + tokens
  }
  return { mtimeMs, size, ...(firstDay ? { firstDay } : {}), days: [...days.values()] }
}

/**
 * Scans every project's metrics sidecars asynchronously. Parsed files are
 * cached by session id, mtime and size, so a rescan only re-reads sessions that
 * changed. The cache is persisted and a file that disappeared keeps its last
 * figures: deleting a session or removing a project never lowers the history.
 */
export class UsageScanner {
  private files = new Map<string, CachedFile>()
  private loaded: Promise<void> | undefined
  private migrated = false

  constructor(private readonly historyPath = path.join(getGlobalHanekawaDir(), 'usage-history.json')) {}

  private load(): Promise<void> {
    this.loaded ??= readJsonFile<History | null>(this.historyPath, null)
      .catch(() => null)
      .then(async (history) => {
        if (history?.version === HISTORY_VERSION) this.files = new Map(Object.entries(history.files))
        else if (history?.version === 1) {
          await copyFile(this.historyPath, `${this.historyPath}.v1.bak`, constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'EEXIST') throw error
          })
          for (const [file, cached] of Object.entries(history.files)) {
            const id = path.basename(file, METRICS_SUFFIX)
            const existing = this.files.get(id)
            // Renamed copies describe the same session. Prefer the latest
            // snapshot; a surviving metrics file is always re-read below.
            if (!existing || cached.size > existing.size || (cached.size === existing.size && cached.mtimeMs > existing.mtimeMs)) {
              this.files.set(id, { ...cached, path: file, parsedVersion: undefined })
            }
          }
          this.migrated = true
        }
      })
    return this.loaded
  }

  async scan(roots: string[]): Promise<WireShellUsageStatsResult> {
    await this.load()
    const paths = (
      await Promise.all(
        roots.map(async (root) => {
          const dir = getSessionsDir(root)
          const names = await readdir(dir).catch(() => [])
          return names.filter((name) => name.endsWith(METRICS_SUFFIX)).map((name) => path.join(dir, name))
        }),
      )
    ).flat()

    let changed = this.migrated
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const file = paths[cursor++]!
        const info = await stat(file).catch(() => undefined)
        if (!info) continue
        const id = path.basename(file, METRICS_SUFFIX)
        const cached = this.files.get(id)
        if (cached?.parsedVersion === HISTORY_VERSION && cached.path === file && cached.mtimeMs === info.mtimeMs && cached.size === info.size) continue
        const content = await readFile(file, 'utf-8').catch(() => undefined)
        if (content === undefined) continue
        this.files.set(id, { ...parseFile(content, info.mtimeMs, info.size), path: file, parsedVersion: HISTORY_VERSION })
        changed = true
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
    if (changed) {
      const history: History = { version: HISTORY_VERSION, files: Object.fromEntries(this.files) }
      await writeJsonFile(this.historyPath, history).catch(() => undefined)
      this.migrated = false
    }

    const days = new Map<string, WireUsageDay>()
    const dayOf = (day: string): WireUsageDay => {
      let entry = days.get(day)
      if (!entry) {
        entry = { day, sessions: 0, turns: 0, tokens: 0, hours: new Array<number>(24).fill(0), models: {} }
        days.set(day, entry)
      }
      return entry
    }
    for (const file of this.files.values()) {
      if (file.firstDay) dayOf(file.firstDay).sessions += 1
      for (const fileDay of file.days) {
        const entry = dayOf(fileDay.day)
        entry.turns += fileDay.turns
        entry.tokens += fileDay.tokens
        fileDay.hours.forEach((count, hour) => { entry.hours[hour]! += count })
        for (const [model, tokens] of Object.entries(fileDay.models)) entry.models[model] = (entry.models[model] ?? 0) + tokens
      }
    }
    return { days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)) }
  }
}
