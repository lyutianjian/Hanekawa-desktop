import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { inferTurnInputTokens } from '../sessions/service.js'
import { promptTokens } from '../harness/usage.js'
import type { SessionMetric } from '../harness/metrics.js'
import { getSessionsDir } from '../utils/paths.js'
import { parseJsonLines } from '../utils/json.js'
import type { WireShellUsageStatsResult, WireUsageDay } from './shellProtocol.js'

const METRICS_SUFFIX = '.metrics.jsonl'
const READ_CONCURRENCY = 16

interface Turn {
  day: string
  hour: number
  tokens: number
  model: string
}

interface CachedFile {
  mtimeMs: number
  size: number
  turns: Turn[]
}

function dayKey(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function parseTurns(content: string): Turn[] {
  const turns: Turn[] = []
  for (const metric of parseJsonLines<SessionMetric>(content)) {
    if (metric.event !== 'turn') continue
    const at = new Date(metric.created_at)
    if (Number.isNaN(at.getTime())) continue
    const outputTokens = Math.max(0, metric.response_tokens ?? 0)
    const usage = {
      inputTokens: inferTurnInputTokens(metric),
      ...(typeof metric.cache_creation_tokens === 'number' ? { cacheCreationInputTokens: metric.cache_creation_tokens } : {}),
      cacheReadInputTokens: metric.cache_read_tokens ?? 0,
      outputTokens,
    }
    turns.push({ day: dayKey(at), hour: at.getHours(), tokens: promptTokens(usage) + outputTokens, model: metric.model })
  }
  return turns
}

/**
 * Scans every project's metrics sidecars asynchronously. Parsed files are
 * cached by path, mtime and size, so a rescan only re-reads sessions that
 * changed; files that disappeared fall out with the next scan.
 */
export class UsageScanner {
  private files = new Map<string, CachedFile>()

  async scan(roots: string[]): Promise<WireShellUsageStatsResult> {
    const paths = (
      await Promise.all(
        roots.map(async (root) => {
          const dir = getSessionsDir(root)
          const names = await readdir(dir).catch(() => [])
          return names.filter((name) => name.endsWith(METRICS_SUFFIX)).map((name) => path.join(dir, name))
        }),
      )
    ).flat()

    const next = new Map<string, CachedFile>()
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (cursor < paths.length) {
        const file = paths[cursor++]!
        const info = await stat(file).catch(() => undefined)
        if (!info) continue
        const cached = this.files.get(file)
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) {
          next.set(file, cached)
          continue
        }
        const content = await readFile(file, 'utf-8').catch(() => undefined)
        if (content !== undefined) next.set(file, { mtimeMs: info.mtimeMs, size: info.size, turns: parseTurns(content) })
      }
    }
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, paths.length) }, worker))
    this.files = next

    const days = new Map<string, WireUsageDay>()
    const dayOf = (day: string): WireUsageDay => {
      let entry = days.get(day)
      if (!entry) {
        entry = { day, sessions: 0, turns: 0, tokens: 0, hours: new Array<number>(24).fill(0), models: {} }
        days.set(day, entry)
      }
      return entry
    }
    for (const { turns } of next.values()) {
      if (turns.length === 0) continue
      dayOf(turns[0]!.day).sessions += 1
      for (const turn of turns) {
        const entry = dayOf(turn.day)
        entry.turns += 1
        entry.tokens += turn.tokens
        entry.hours[turn.hour]! += 1
        entry.models[turn.model] = (entry.models[turn.model] ?? 0) + turn.tokens
      }
    }
    return { days: [...days.values()].sort((left, right) => left.day.localeCompare(right.day)) }
  }
}
