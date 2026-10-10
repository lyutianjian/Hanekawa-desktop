import { mkdir, readdir, rm, stat, writeFile, rename } from 'node:fs/promises'
import { appendFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { getSessionsDir } from '../utils/paths.js'
import { migrateLegacyProjectData, type LegacyDataFinding } from './legacyProjectData.js'
import { readJsonFile, writeJsonFile, parseJsonLines, parseJsonLinesWithDiagnostics } from '../utils/json.js'
import type { CoordinationRole, SessionRecord, TokenUsage } from '../harness/types.js'
import type { SessionMetricInput, SessionMetric } from '../harness/metrics.js'
import { OtlpMetricExporter } from '../harness/otlp.js'
import { checkSessionInvariants, ensureToolResultPairing } from './invariants.js'
import { withFileLock } from './fileLock.js'

/**
 * Atomic write: write to a temp file in the same directory, then rename.
 * Prevents data loss if the process crashes mid-write.
 */
async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmpPath = `${filePath}.tmp.${randomUUID()}`
  await writeFile(tmpPath, content, 'utf-8')
  await rename(tmpPath, filePath)
}

class MessageNotFoundError extends Error {
  constructor(readonly messageId: string) {
    super(messageId)
    this.name = 'MessageNotFoundError'
  }
}

/**
 * **Legacy.** A `messageId` → shadow-git commit pair, written by the checkpoint
 * implementation `/rewind` used before file history replaced it.
 *
 * Nothing writes these any more: a restore is addressed by `messageId` through
 * `services/fileHistory/`, whose snapshots live in their own append-only log
 * under `~/.myagent/file-history/`. The field and its reader stay so an index
 * written by an older build still parses (and so truncation keeps pruning it),
 * and the commits they name are gone — the shadow repos are deleted on startup.
 */
export interface CheckpointMapping {
  messageId: string
  commitHash: string
  createdAt: string
}

export interface SessionMeta {
  id: string
  shortId: string
  createdAt: string
  updatedAt: string
  title?: string
  messageCount: number
  compactFailureCount?: number
  checkpoints?: CheckpointMapping[]
  /** Set when the session belongs to a project's coordination (see `services/coordination/`). */
  coordination?: SessionCoordination
}

export interface SessionCoordination {
  role: CoordinationRole
  projectKey: string
  threadId?: string
  /** The thread's worktree path. Absent means the project's cwd. */
  workingDir?: string
}

interface SessionState {
  meta: SessionMeta
  records: SessionRecord[]
}

interface SessionIndex {
  sessions: SessionMeta[]
}

interface DraftSessionState {
  meta: SessionMeta
  records: SessionRecord[]
  metrics: SessionMetricInput[]
}

const EMPTY_SESSION_CLEANUP_GRACE_MS = 10 * 60 * 1000

/**
 * Rejects a session id that must not become a path component.
 *
 * The one rule, shared: `SessionStore`'s own file paths go through it, and so
 * does `removeFileHistory` (`services/fileHistory/fileHistoryService.ts`), whose
 * id arrives over the desktop shell's `delete-session` and lands in an `rm` with
 * `recursive: true`. Two validators with slightly different rules on the same
 * value is how one of them ends up being the lenient one.
 *
 * `''`, `'.'` and `'..'` are rejected as whole ids, not merely as substrings,
 * because the two callers use the id at *different shapes*: `sessionPath` makes
 * it `${id}.json`, where `'.'` is the harmless `..json`, while
 * `removeFileHistory` makes it a whole directory component, where `path.join`
 * collapses it and `rm -r` then lands on the directory holding every session's
 * snapshots. Calibrating this for the filename shape alone is exactly the bug
 * that reached a red test.
 */
export function assertSafeSessionId(id: string): void {
  if (id === '' || id === '.' || id === '..') {
    throw new Error(`Invalid session ID: ${JSON.stringify(id)}`)
  }
  // Path separators, traversal, drive letters and NUL — anything that could
  // escape the directory the caller means to write in.
  if (/[\\/:\x00]/.test(id) || id.includes('..')) {
    throw new Error(`Invalid session ID: ${JSON.stringify(id)}`)
  }
}

interface RunningCacheSummary {
  totalTurns: number
  totalInputTokens: number
  totalCacheCreationTokens: number
  totalCacheReadTokens: number
  totalOutputTokens: number
  firstBreakTurnCount: number | null
  cacheBreakCount: number
  causeDistribution: Record<string, number>
  compactCount: number
  firstCompactTurnIndex: number | null
  lastCompactTurnIndex: number | null
  compactIntervalTotal: number
}

export interface SessionMetricsSummary {
  totalCacheHitRate: number | null
  totalTurns: number
  firstBreakTurnCount: number | null
  cacheBreakCount: number
  causeDistribution: Record<string, number>
  averageCompactIntervalTurns: number | null
}

export interface SessionStoreOptions {
  otlpEndpoint?: string
}

export type SessionDiagnosticCode =
  | 'malformed_jsonl'
  | 'missing_session_file'
  | 'index_rebuilt'
  | 'legacy_session_migrated'
  | 'checkpoint_migrated'
  | 'tool_result_before_use'
  | 'checkpoint_missing_message'
  | 'legacy_missing_turn_id'
  | 'turn_mismatch'

export interface SessionDiagnostic {
  code: SessionDiagnosticCode
  severity: 'info' | 'warning'
  message: string
  sessionId?: string
  line?: number
  details?: unknown
}

export interface LoadRecordsResult {
  records: SessionRecord[]
  diagnostics: SessionDiagnostic[]
}

export interface RepairRecordsResult {
  repairedCount: number
  diagnostics: ReturnType<typeof ensureToolResultPairing>['diagnostics']
}

export class SessionStore {
  private static indexLocks = new Map<string, Promise<void>>()
  private static jsonlLocks = new Map<string, Promise<void>>()
  private readonly cacheSummaries = new Map<string, RunningCacheSummary>()
  private readonly drafts = new Map<string, DraftSessionState>()
  private readonly otlpExporter?: OtlpMetricExporter
  private sessionsDir: string
  private readonly cwd: string
  private migrationFindings: LegacyDataFinding[] = []

  constructor(cwd: string, options: SessionStoreOptions = {}) {
    this.cwd = cwd
    this.sessionsDir = getSessionsDir(cwd)
    this.otlpExporter = options.otlpEndpoint
      ? new OtlpMetricExporter({ endpoint: options.otlpEndpoint })
      : undefined
  }

  async init(): Promise<void> {
    // Before anything reads the index: a project last opened before runtime
    // data moved out of `<cwd>/.myagent/` still has its sessions there.
    this.migrationFindings.push(...await migrateLegacyProjectData(this.cwd))
    await mkdir(this.sessionsDir, { recursive: true })
    await this.cleanupStaleEmptySessions()
  }

  async create(title?: string): Promise<SessionMeta> {
    const meta = this.createMeta(title)
    const { id } = meta
    await writeFile(this.sessionJsonlPath(id), '', { flag: 'a' })
    await this.upsertIndex(meta)
    return meta
  }

  /** What `init()`'s legacy-data migration reported, handed over once for startup diagnostics. */
  takeMigrationFindings(): LegacyDataFinding[] {
    const findings = this.migrationFindings
    this.migrationFindings = []
    return findings
  }

  createDraft(title?: string): SessionMeta {
    const meta = this.createMeta(title)
    this.drafts.set(meta.id, { meta, records: [], metrics: [] })
    return meta
  }

  discardDraft(sessionIdOrPrefix: string): void {
    const draft = this.resolveDraft(sessionIdOrPrefix)
    if (draft) this.drafts.delete(draft.meta.id)
  }

  async list(): Promise<SessionMeta[]> {
    const index = await this.readIndex()
    return index.sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async resolve(idOrPrefix: string): Promise<SessionMeta | undefined> {
    const draft = this.resolveDraft(idOrPrefix)
    if (draft) return draft.meta
    const sessions = await this.list()
    const exact = sessions.find((session) => session.id === idOrPrefix || session.shortId === idOrPrefix)
    if (exact) return exact
    const partial = sessions.filter((session) => session.id.startsWith(idOrPrefix) || session.shortId.startsWith(idOrPrefix))
    if (partial.length === 1) return partial[0]
    return undefined
  }

  async load(sessionIdOrPrefix: string): Promise<SessionMeta | undefined> {
    const session = await this.resolve(sessionIdOrPrefix)
    return session
  }

  async loadRecords(sessionIdOrPrefix: string): Promise<SessionRecord[]> {
    return (await this.loadRecordsWithDiagnostics(sessionIdOrPrefix)).records
  }

  /**
   * The session's records, unless its file still has the size and mtime
   * `since` names. A cheap poll for a reader that keeps its last result.
   */
  async loadRecordsIfChanged(
    sessionId: string,
    since: string | undefined,
  ): Promise<{ token: string; records: SessionRecord[] } | { token: string; records?: undefined }> {
    const stats = await stat(this.sessionJsonlPath(sessionId)).catch(() => undefined)
    const token = stats === undefined ? '' : `${stats.size}:${stats.mtimeMs}`
    if (since === token) return { token }
    return { token, records: await this.loadRecords(sessionId) }
  }

  async loadRecordsWithDiagnostics(sessionIdOrPrefix: string): Promise<LoadRecordsResult> {
    const diagnostics: SessionDiagnostic[] = []
    const draft = this.resolveDraft(sessionIdOrPrefix)
    if (draft) return { records: [...draft.records], diagnostics }
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) {
      return {
        records: [],
        diagnostics: [{
          code: 'missing_session_file',
          severity: 'warning',
          message: `Session not found: ${sessionIdOrPrefix}`,
          sessionId: sessionIdOrPrefix,
        }],
      }
    }

    const jsonlPath = this.sessionJsonlPath(session.id)
    if (existsSync(jsonlPath)) {
      const content = readFileSync(jsonlPath, 'utf-8')
      const parsed = parseJsonLinesWithDiagnostics<SessionRecord>(content)
      diagnostics.push(...parsed.diagnostics.map((d) => ({
        code: 'malformed_jsonl' as const,
        severity: 'warning' as const,
        message: `Skipped malformed JSONL line ${d.line}: ${d.message}`,
        sessionId: session.id,
        line: d.line,
        details: { raw: d.raw },
      })))
      diagnostics.push(...checkSessionInvariants(parsed.records, session))
      return { records: parsed.records, diagnostics }
    }

    const state = await readJsonFile<SessionState>(this.sessionPath(session.id), { meta: session, records: [] })
    if (state.records.length > 0) {
      const lines = state.records.map(r => JSON.stringify(r)).join('\n') + '\n'
      appendFileSync(jsonlPath, lines, { mode: 0o600 })
      await this.upsertIndex({ ...this.deriveMetaFromRecords(session.id, state.records, state.meta), checkpoints: state.meta.checkpoints })
      await rm(this.sessionPath(session.id), { force: true })
      diagnostics.push({
        code: 'legacy_session_migrated',
        severity: 'info',
        message: `Migrated legacy session JSON to JSONL: ${session.id}`,
        sessionId: session.id,
      })
      if (state.meta.checkpoints && state.meta.checkpoints.length > 0) {
        diagnostics.push({
          code: 'checkpoint_migrated',
          severity: 'info',
          message: `Migrated ${state.meta.checkpoints.length} checkpoint mappings from legacy session JSON.`,
          sessionId: session.id,
        })
      }
      diagnostics.push(...checkSessionInvariants(state.records, state.meta))
      return { records: state.records, diagnostics }
    }

    if (state.meta.checkpoints && state.meta.checkpoints.length > 0) {
      await this.upsertIndex({ ...session, checkpoints: state.meta.checkpoints })
      diagnostics.push({
        code: 'checkpoint_migrated',
        severity: 'info',
        message: `Migrated ${state.meta.checkpoints.length} checkpoint mappings from legacy session JSON.`,
        sessionId: session.id,
      })
    }

    diagnostics.push(...checkSessionInvariants(state.records, { ...session, checkpoints: state.meta.checkpoints }))
    return { records: state.records, diagnostics }
  }

  async appendRecord(sessionIdOrPrefix: string, record: SessionRecord): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    await this.withJsonlLock(session.id, async () => {
      const draft = this.drafts.get(session.id)
      if (draft) {
        draft.records.push(record)
        draft.meta = this.deriveMetaAfterAppend(draft.meta, record, new Date().toISOString())
        if (record.type === 'message') await this.materializeDraft(draft)
        return
      }
      // Append to JSONL file (atomic append, no full read-modify-write)
      const jsonlPath = this.sessionJsonlPath(session.id)
      const line = JSON.stringify(record) + '\n'
      appendFileSync(jsonlPath, line, { mode: 0o600 })

      const now = new Date().toISOString()
      await this.withIndexLock(async () => {
        const index = await this.readIndexUnlocked()
        const current = index.sessions.find((item) => item.id === session.id) ?? session
        const meta = this.deriveMetaAfterAppend(current, record, now)
        this.replaceIndexSession(index, meta)
        await writeJsonFile(this.indexPath(), index)
      })
    })
  }

  async repairRecords(sessionIdOrPrefix: string): Promise<RepairRecordsResult> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    const loaded = await this.loadRecordsWithDiagnostics(session.id)
    const repaired = ensureToolResultPairing(loaded.records)
    if (repaired.diagnostics.length === 0) {
      return { repairedCount: 0, diagnostics: [] }
    }

    const jsonlPath = this.sessionJsonlPath(session.id)
    const nextContent = repaired.records.map((record) => JSON.stringify(record)).join('\n') + '\n'
    // Under the lock like every other full rewrite: tmp+rename is crash-safe
    // but not interleave-safe, so a concurrent append between the read above
    // and this rename would be dropped.
    await this.withJsonlLock(session.id, () => writeFileAtomic(jsonlPath, nextContent))

    const now = new Date().toISOString()
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      const currentMeta = index.sessions.find((item) => item.id === session.id) ?? session
      const meta: SessionMeta = {
        ...this.deriveMetaFromRecords(session.id, repaired.records, currentMeta),
        updatedAt: now,
        ...(currentMeta.checkpoints ? { checkpoints: currentMeta.checkpoints } : {}),
        ...(currentMeta.compactFailureCount ? { compactFailureCount: currentMeta.compactFailureCount } : {}),
      }
      this.replaceIndexSession(index, meta)
      await writeJsonFile(this.indexPath(), index)
    })

    return {
      repairedCount: repaired.diagnostics.length,
      diagnostics: repaired.diagnostics,
    }
  }

  async updateRecord(
    sessionIdOrPrefix: string,
    recordId: string,
    update: (record: SessionRecord) => SessionRecord,
  ): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    const draft = this.drafts.get(session.id)
    if (draft) {
      const index = draft.records.findIndex((record) => record.id === recordId)
      const current = draft.records[index]
      if (index >= 0 && current) draft.records[index] = update(current)
      return
    }

    // Lock the entire read-modify-write cycle to prevent concurrent overwrites.
    await this.withJsonlLock(session.id, async () => {
      const jsonlPath = this.sessionJsonlPath(session.id)
      const content = existsSync(jsonlPath) ? readFileSync(jsonlPath, 'utf-8') : ''
      const records = parseJsonLines<SessionRecord>(content)
      const index = records.findIndex((record) => record.id === recordId)
      if (index < 0) return

      const current = records[index]
      if (!current) return
      records[index] = update(current)
      const nextContent = records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
      await writeFileAtomic(jsonlPath, nextContent)

      const now = new Date().toISOString()
      await this.withIndexLock(async () => {
        const indexFile = await this.readIndexUnlocked()
        const currentMeta = indexFile.sessions.find((item) => item.id === session.id) ?? session
        const meta: SessionMeta = {
          ...this.deriveMetaFromRecords(session.id, records, currentMeta),
          updatedAt: now,
          ...(currentMeta.checkpoints ? { checkpoints: currentMeta.checkpoints } : {}),
          ...(currentMeta.compactFailureCount ? { compactFailureCount: currentMeta.compactFailureCount } : {}),
        }
        this.replaceIndexSession(indexFile, meta)
        await writeJsonFile(this.indexPath(), indexFile)
      })
    })
  }

  async replaceRecords(sessionIdOrPrefix: string, records: SessionRecord[]): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) throw new Error(`Unknown session: ${sessionIdOrPrefix}`)

    const draft = this.drafts.get(session.id)
    if (draft) {
      draft.records = [...records]
      const metaBase: Partial<SessionMeta> = { ...draft.meta }
      delete metaBase.title
      draft.meta = this.deriveMetaFromRecords(session.id, draft.records, metaBase)
      if (draft.records.some((record) => record.type === 'message')) {
        await this.withJsonlLock(session.id, () => this.materializeDraft(draft))
      }
      return
    }

    await this.withJsonlLock(session.id, async () => {
      const jsonlPath = this.sessionJsonlPath(session.id)
      const nextContent = records.map((record) => JSON.stringify(record)).join('\n') + (records.length > 0 ? '\n' : '')
      await writeFileAtomic(jsonlPath, nextContent)

      const retainedMessageIds = new Set(
        records
          .filter((record) => record.type === 'message')
          .map((record) => record.id),
      )
      const now = new Date().toISOString()
      await this.withIndexLock(async () => {
        const index = await this.readIndexUnlocked()
        const currentMeta = index.sessions.find((item) => item.id === session.id) ?? session
        const metaBase: Partial<SessionMeta> = { ...currentMeta }
        delete metaBase.title
        const meta: SessionMeta = {
          ...this.deriveMetaFromRecords(session.id, records, metaBase),
          updatedAt: now,
          checkpoints: currentMeta.checkpoints?.filter((mapping) => retainedMessageIds.has(mapping.messageId)),
          ...(currentMeta.compactFailureCount ? { compactFailureCount: currentMeta.compactFailureCount } : {}),
        }
        this.replaceIndexSession(index, meta)
        await writeJsonFile(this.indexPath(), index)
      })
    })
  }

  async appendMetric(sessionIdOrPrefix: string, metric: SessionMetricInput): Promise<void> {
    try {
      const draft = this.resolveDraft(sessionIdOrPrefix)
      if (draft) {
        draft.metrics.push(metric)
        return
      }
      const session = await this.resolve(sessionIdOrPrefix)
      const sessionId = session?.id ?? sessionIdOrPrefix
      const record: SessionMetric = {
        created_at: new Date().toISOString(),
        session_id: sessionId,
        ...metric,
      } as SessionMetric
      const metricsPath = this.sessionMetricsPath(sessionId)
      const cacheSummary = metric.event === 'turn' || metric.event === 'cache_break' || metric.event === 'compact'
        ? this.runningCacheSummary(sessionId, metricsPath)
        : undefined
      appendFileSync(metricsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      this.exportMetric(record)
      if (cacheSummary) {
        this.updateRunningCacheSummary(cacheSummary, record)
        const summary = this.buildSessionCacheSummaryRecord(sessionId, cacheSummary)
        if (summary) {
          appendFileSync(metricsPath, `${JSON.stringify(summary)}\n`, { mode: 0o600 })
          this.exportMetric(summary)
        }
      }
    } catch {
      // Metrics are best-effort and must never affect the agent loop.
    }
  }

  /**
   * The usage of the last request this session ever sent, read back from the
   * metrics sidecar.
   *
   * A resumed session has no in-memory usage — nothing has been sent yet in
   * this process — and the context readout would otherwise have to estimate the
   * occupancy from the records alone, which counts neither the system prompt
   * nor the tool schemas. The `turn` metric is written per provider response
   * (`AgentLoop.emitTurnMetric`) and carries the provider's own numbers, so the
   * last one is the real size of the last request. It is one response stale —
   * the tool results that followed it are not in it — and the next request
   * replaces it with a live number anyway.
   *
   * Null when the session has never completed a request, or when the sidecar is
   * missing or unreadable; metrics are best-effort and a readout must never
   * depend on them being there.
   */
  async loadLastRequestUsage(sessionIdOrPrefix: string): Promise<TokenUsage | null> {
    try {
      if (this.resolveDraft(sessionIdOrPrefix)) return null
      const session = await this.resolve(sessionIdOrPrefix)
      const sessionId = session?.id ?? sessionIdOrPrefix
      const metricsPath = this.sessionMetricsPath(sessionId)
      if (!existsSync(metricsPath)) return null

      let last: Extract<SessionMetric, { event: 'turn' }> | undefined
      for (const metric of parseJsonLines<SessionMetric>(readFileSync(metricsPath, 'utf-8'))) {
        if (metric.event === 'turn') last = metric
      }
      if (!last) return null
      return {
        inputTokens: inferTurnInputTokens(last),
        ...(typeof last.cache_creation_tokens === 'number'
          ? { cacheCreationInputTokens: Math.max(0, last.cache_creation_tokens) }
          : {}),
        cacheReadInputTokens: Math.max(0, last.cache_read_tokens),
        outputTokens: Math.max(0, last.response_tokens),
      }
    } catch {
      return null
    }
  }

  /**
   * Everything this session ever spent, summed from the same sidecar.
   *
   * The running total is otherwise an in-process figure: reopening a session
   * restarted it at zero, so the cache hit rate beside it was computed over
   * whatever had been sent since the window was opened — and the first request
   * after a resume is mostly cache *writes*, which made a warm session read as
   * a cold one. Summed from the `turn` metrics instead, so the number means the
   * session rather than the process.
   *
   * Null when the session never completed a request, which is the caller's cue
   * to keep counting from zero rather than to show a zeroed total.
   */
  async loadSessionTotals(sessionIdOrPrefix: string): Promise<TokenUsage | null> {
    try {
      if (this.resolveDraft(sessionIdOrPrefix)) return null
      const session = await this.resolve(sessionIdOrPrefix)
      const sessionId = session?.id ?? sessionIdOrPrefix
      const metricsPath = this.sessionMetricsPath(sessionId)
      if (!existsSync(metricsPath)) return null
      const summary = this.runningCacheSummary(sessionId, metricsPath)
      if (summary.totalTurns === 0) return null
      return {
        inputTokens: summary.totalInputTokens,
        // Same contract as one request's usage: a session whose turns never
        // carried a write count reports no write count either.
        ...(summary.totalCacheCreationTokens > 0
          ? { cacheCreationInputTokens: summary.totalCacheCreationTokens }
          : {}),
        cacheReadInputTokens: summary.totalCacheReadTokens,
        outputTokens: summary.totalOutputTokens,
      }
    } catch {
      return null
    }
  }

  async loadMetricsSummary(sessionIdOrPrefix: string): Promise<SessionMetricsSummary | null> {
    if (this.resolveDraft(sessionIdOrPrefix)) return null
    const session = await this.resolve(sessionIdOrPrefix)
    const sessionId = session?.id ?? sessionIdOrPrefix
    const cached = this.cacheSummaries.get(sessionId)
    if (cached) return toMetricsSummary(cached)

    const metricsPath = this.sessionMetricsPath(sessionId)
    if (!existsSync(metricsPath)) return null

    const restored = this.runningCacheSummary(sessionId, metricsPath)
    return toMetricsSummary(restored)
  }

  async setCompactFailureCount(sessionIdOrPrefix: string, count: number): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    const sessionId = session?.id ?? sessionIdOrPrefix
    const normalizedCount = Math.max(0, Math.floor(count))
    await this.updateIndexSession(sessionId, (current) => {
      const next: SessionMeta = {
        ...current,
        updatedAt: new Date().toISOString(),
      }
      if (normalizedCount > 0) {
        next.compactFailureCount = normalizedCount
      } else {
        delete next.compactFailureCount
      }
      return next
    }, session ?? this.defaultMeta(sessionId))
  }

  async setCoordination(sessionIdOrPrefix: string, value: SessionCoordination | undefined): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    const sessionId = session?.id ?? sessionIdOrPrefix
    await this.updateIndexSession(sessionId, (current) => {
      const next: SessionMeta = { ...current }
      if (value) next.coordination = { ...value }
      else delete next.coordination
      return next
    }, session ?? this.defaultMeta(sessionId))
  }

  /**
   * Removes a session's three files and its index entry.
   *
   * **Not** its file history — `~/.myagent/file-history/<id>` belongs to
   * `services/fileHistory/`, which sits above `sessions/` in the layering, so
   * "delete a session" is a composition the caller performs (see
   * `deleteSessionArtifacts`). Calling this one alone leaks the snapshots.
   */
  async delete(sessionIdOrPrefix: string): Promise<void> {
    const draft = this.resolveDraft(sessionIdOrPrefix)
    if (draft) {
      this.drafts.delete(draft.meta.id)
      return
    }
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    await rm(this.sessionPath(session.id), { force: true })
    await rm(this.sessionJsonlPath(session.id), { force: true })
    await rm(this.sessionMetricsPath(session.id), { force: true })
    this.cacheSummaries.delete(session.id)
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      index.sessions = index.sessions.filter((item) => item.id !== session.id)
      await writeJsonFile(this.indexPath(), index)
    })
  }

  async rename(sessionIdOrPrefix: string, title: string): Promise<void> {
    const session = await this.resolve(sessionIdOrPrefix)
    if (!session) return
    await this.updateIndexSession(session.id, (current) => ({
      ...current,
      title,
      updatedAt: new Date().toISOString(),
    }))
  }

  private async updateIndexSession(
    sessionId: string,
    update: (current: SessionMeta) => SessionMeta,
    fallback?: SessionMeta,
  ): Promise<void> {
    const draft = this.drafts.get(sessionId)
    if (draft) {
      draft.meta = update(draft.meta)
      return
    }
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      const current = index.sessions.find((item) => item.id === sessionId) ?? fallback ?? this.defaultMeta(sessionId)
      this.replaceIndexSession(index, update(current))
      await writeJsonFile(this.indexPath(), index)
    })
  }

  /**
   * Truncate the JSONL session file to include only records up to and including
   * the record with the given messageId. Returns success/error result.
   */
  async truncateToMessage(sessionId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    return this.truncateSessionToMessage(sessionId, messageId, true)
  }

  /**
   * Truncate the JSONL session file to include only records before the record
   * with the given messageId. Returns success/error result.
   */
  async truncateBeforeMessage(sessionId: string, messageId: string): Promise<{ success: boolean; error?: string }> {
    return this.truncateSessionToMessage(sessionId, messageId, false)
  }

  private async truncateSessionToMessage(
    sessionId: string,
    messageId: string,
    includeTarget: boolean,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const jsonlPath = this.sessionJsonlPath(sessionId)

      if (!existsSync(jsonlPath)) {
        return { success: false, error: `Session file not found: ${sessionId}` }
      }

      await this.withJsonlLock(sessionId, async () => {
        const content = readFileSync(jsonlPath, 'utf-8')
        const lines = content.split('\n')

        // Find the line containing the target message ID
        let targetLineIndex = -1
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i]
          if (!line.trim()) continue
          try {
            const record = JSON.parse(line) as SessionRecord
            if ('id' in record && record.id === messageId) {
              targetLineIndex = i
              break
            }
          } catch {
            // Skip malformed lines
          }
        }

        if (targetLineIndex === -1) {
          throw new MessageNotFoundError(messageId)
        }

        const retainedLines = lines.slice(0, includeTarget ? targetLineIndex + 1 : targetLineIndex)
        const truncatedContent = retainedLines.length > 0 ? `${retainedLines.join('\n')}\n` : ''

        await writeFileAtomic(jsonlPath, truncatedContent)

        // Update message count in the index
        const retainedRecords = parseJsonLines<SessionRecord>(truncatedContent)
        const retainedMessageIds = new Set(
          retainedRecords
            .filter((record) => record.type === 'message')
            .map((record) => record.id),
        )
        const session = await this.resolve(sessionId)
        if (session) {
          const updatedMeta: SessionMeta = {
            ...this.deriveMetaFromRecords(session.id, retainedRecords, session),
            updatedAt: new Date().toISOString(),
            checkpoints: session.checkpoints?.filter((mapping) => retainedMessageIds.has(mapping.messageId)),
            ...(session.compactFailureCount ? { compactFailureCount: session.compactFailureCount } : {}),
          }
          await this.upsertIndex(updatedMeta)
        }
      })

      return { success: true }
    } catch (error) {
      if (error instanceof MessageNotFoundError) {
        return { success: false, error: `Message not found: ${error.messageId}` }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { success: false, error: `Failed to truncate session: ${message}` }
    }
  }

  /**
   * Reads the legacy checkpoint mappings out of session metadata.
   *
   * See {@link CheckpointMapping}: `/rewind` no longer consults these, so this
   * is a compatibility reader for indexes older builds wrote — kept because the
   * field is still carried through truncation and re-index.
   */
  async getCheckpointMappings(sessionId: string): Promise<CheckpointMapping[]> {
    try {
      const draft = this.resolveDraft(sessionId)
      if (draft) return draft.meta.checkpoints ?? []
      const index = await this.readIndex()
      const session = index.sessions.find((item) => item.id === sessionId || item.shortId === sessionId)
      if (session?.checkpoints && session.checkpoints.length > 0) return session.checkpoints

      const state = await readJsonFile<SessionState>(this.sessionPath(sessionId), {
        meta: { ...(session ?? this.defaultMeta(sessionId)), checkpoints: [] },
        records: [],
      })
      const checkpoints = state.meta.checkpoints ?? []
      if (checkpoints.length > 0) {
        await this.upsertIndex({ ...(session ?? this.defaultMeta(sessionId)), checkpoints })
      }
      return checkpoints
    } catch {
      return []
    }
  }

  /**
   * Appends a legacy checkpoint mapping. **Deprecated**: no runtime path calls
   * it since file history replaced shadow-git, and new sessions never gain a
   * `checkpoints` array. It survives as the counterpart of the reader, so the
   * cases covering how truncation and re-index carry that field can still write
   * one.
   */
  async addCheckpointMapping(sessionId: string, messageId: string, commitHash: string): Promise<void> {
    const session = await this.resolve(sessionId)
    const base = session ?? this.defaultMeta(sessionId)

    const mapping: CheckpointMapping = {
      messageId,
      commitHash,
      createdAt: new Date().toISOString(),
    }

    await this.updateIndexSession(sessionId, (current) => ({
      ...current,
      checkpoints: [...(current.checkpoints ?? []), mapping],
      updatedAt: new Date().toISOString(),
    }), base)
  }

  private createMeta(title?: string): SessionMeta {
    const now = new Date().toISOString()
    const id = randomUUID()
    return {
      id,
      shortId: id.slice(0, 12),
      createdAt: now,
      updatedAt: now,
      title,
      messageCount: 0,
    }
  }

  private resolveDraft(idOrPrefix: string): DraftSessionState | undefined {
    const exact = this.drafts.get(idOrPrefix)
      ?? [...this.drafts.values()].find((draft) => draft.meta.shortId === idOrPrefix)
    if (exact) return exact
    const partial = [...this.drafts.values()].filter((draft) =>
      draft.meta.id.startsWith(idOrPrefix) || draft.meta.shortId.startsWith(idOrPrefix),
    )
    return partial.length === 1 ? partial[0] : undefined
  }

  private async materializeDraft(draft: DraftSessionState): Promise<void> {
    if (!this.drafts.has(draft.meta.id)) return
    const content = draft.records.map((record) => JSON.stringify(record)).join('\n')
      + (draft.records.length > 0 ? '\n' : '')
    await writeFileAtomic(this.sessionJsonlPath(draft.meta.id), content)
    await this.upsertIndex(draft.meta)
    const metrics = [...draft.metrics]
    this.drafts.delete(draft.meta.id)
    for (const metric of metrics) await this.appendMetric(draft.meta.id, metric)
  }

  private async cleanupStaleEmptySessions(now = Date.now()): Promise<void> {
    await this.withIndexLock(async () => {
      const index = await this.readIndexUnlocked()
      const retained: SessionMeta[] = []
      let changed = false

      for (const session of index.sessions) {
        if (session.messageCount > 0) {
          retained.push(session)
          continue
        }

        const paths = [
          this.sessionPath(session.id),
          this.sessionJsonlPath(session.id),
          this.sessionMetricsPath(session.id),
        ]
        const mtimes = await Promise.all(paths.map(async (filePath) => {
          try {
            return (await stat(filePath)).mtimeMs
          } catch {
            return 0
          }
        }))
        const indexedTime = Date.parse(session.updatedAt)
        const latestActivity = Math.max(Number.isFinite(indexedTime) ? indexedTime : now, ...mtimes)
        if (now - latestActivity < EMPTY_SESSION_CLEANUP_GRACE_MS) {
          retained.push(session)
          continue
        }

        let records: SessionRecord[] = []
        const jsonlPath = this.sessionJsonlPath(session.id)
        if (existsSync(jsonlPath)) {
          records = parseJsonLines<SessionRecord>(readFileSync(jsonlPath, 'utf-8'))
        } else {
          records = (await this.readLegacySession(session.id))?.records ?? []
        }
        if (records.some((record) => record.type === 'message')) {
          retained.push(this.deriveMetaFromRecords(session.id, records, session))
          changed = true
          continue
        }

        await Promise.all(paths.map((filePath) => rm(filePath, { force: true })))
        this.cacheSummaries.delete(session.id)
        changed = true
      }

      if (changed) await writeJsonFile(this.indexPath(), { sessions: retained })
    })
  }

  private async readIndex(): Promise<SessionIndex> {
    return this.withIndexLock(() => this.readIndexUnlocked())
  }

  private async readIndexUnlocked(): Promise<SessionIndex> {
    let index: SessionIndex
    try {
      index = await readJsonFile<SessionIndex>(this.indexPath(), { sessions: [] })
    } catch {
      index = { sessions: [] }
    }

    const recovered = await this.recoverIndex(index)
    if (recovered.changed) {
      await writeJsonFile(this.indexPath(), recovered.index)
    }
    return recovered.index
  }

  private async upsertIndex(meta: SessionMeta): Promise<void> {
    await this.updateIndexSession(meta.id, () => meta, meta)
  }

  private replaceIndexSession(index: SessionIndex, meta: SessionMeta): void {
    index.sessions = index.sessions.filter((item) => item.id !== meta.id)
    index.sessions.push(meta)
  }

  private async withIndexLock<T>(operation: () => Promise<T>): Promise<T> {
    const key = this.indexPath()
    const previous = SessionStore.indexLocks.get(key) ?? Promise.resolve()
    const ready = previous.catch(() => {})
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = ready.then(() => current)
    SessionStore.indexLocks.set(key, queued)

    await ready
    try {
      // The in-process chain above orders our own writers cheaply; the file
      // lock is what keeps a second process out. Nested this way the syscalls
      // only happen once per critical section, not once per queued caller.
      return await withFileLock(`${key}.lock`, operation)
    } finally {
      release()
      if (SessionStore.indexLocks.get(key) === queued) {
        SessionStore.indexLocks.delete(key)
      }
    }
  }

  private async withJsonlLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const key = this.sessionJsonlPath(sessionId)
    const previous = SessionStore.jsonlLocks.get(key) ?? Promise.resolve()
    const ready = previous.catch(() => {})
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    const queued = ready.then(() => current)
    SessionStore.jsonlLocks.set(key, queued)

    await ready
    try {
      return await withFileLock(`${key}.lock`, operation)
    } finally {
      release()
      if (SessionStore.jsonlLocks.get(key) === queued) {
        SessionStore.jsonlLocks.delete(key)
      }
    }
  }

  private async writeSession(state: SessionState): Promise<void> {
    await writeJsonFile(this.sessionPath(state.meta.id), state)
  }

  private async recoverIndex(index: SessionIndex): Promise<{ index: SessionIndex; changed: boolean }> {
    await mkdir(this.sessionsDir, { recursive: true })
    const validIndexedSessions = index.sessions.filter((session) => !session.id.endsWith('.metrics'))
    const sessionsById = new Map(validIndexedSessions.map((session) => [session.id, session]))
    let changed = validIndexedSessions.length !== index.sessions.length

    let entries: string[] = []
    try {
      entries = await readdir(this.sessionsDir)
    } catch {
      return { index, changed }
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl') || entry.endsWith('.metrics.jsonl')) continue
      const id = entry.slice(0, -'.jsonl'.length)
      if (sessionsById.has(id)) continue
      const filePath = this.sessionJsonlPath(id)
      let records: SessionRecord[]
      try {
        const content = readFileSync(filePath, 'utf-8')
        records = parseJsonLines<SessionRecord>(content)
      } catch {
        continue
      }
      const legacy = await this.readLegacySession(id)
      sessionsById.set(id, this.deriveMetaFromRecords(id, records, legacy?.meta))
      changed = true
    }

    for (const entry of entries) {
      if (!entry.endsWith('.json') || entry === 'index.json') continue
      const id = entry.slice(0, -'.json'.length)
      const legacy = await this.readLegacySession(id)
      if (!legacy) continue
      const current = sessionsById.get(id)
      const checkpoints = legacy.meta.checkpoints ?? current?.checkpoints
      if (!current) {
        sessionsById.set(id, this.deriveMetaFromRecords(id, legacy.records, legacy.meta))
        changed = true
        continue
      }
      if (checkpoints && checkpoints.length > 0 && (current.checkpoints?.length ?? 0) === 0) {
        sessionsById.set(id, { ...current, checkpoints })
        changed = true
      }
    }

    const recoveredIndex = { sessions: [...sessionsById.values()] }
    return { index: recoveredIndex, changed }
  }

  private deriveMetaFromRecords(sessionId: string, records: SessionRecord[], existing?: Partial<SessionMeta>): SessionMeta {
    const messages = records.filter((record) => record.type === 'message')
    const firstUserMessage = messages.find((record) => record.role === 'user')
    const lastRecord = records[records.length - 1]
    const now = new Date().toISOString()
    return {
      id: existing?.id ?? sessionId,
      shortId: existing?.shortId ?? sessionId.slice(0, 12),
      createdAt: existing?.createdAt || records[0]?.createdAt || now,
      updatedAt: lastRecord?.createdAt ?? existing?.updatedAt ?? now,
      title: existing?.title ?? (firstUserMessage ? deriveSessionTitle(firstUserMessage) : undefined),
      messageCount: messages.length,
      ...(existing?.checkpoints ? { checkpoints: existing.checkpoints } : {}),
      ...(existing?.compactFailureCount ? { compactFailureCount: existing.compactFailureCount } : {}),
      ...(existing?.coordination ? { coordination: existing.coordination } : {}),
    }
  }

  private deriveMetaAfterAppend(current: SessionMeta, record: SessionRecord, updatedAt: string): SessionMeta {
    const isMessage = record.type === 'message'
    const title = current.title ?? deriveSessionTitle(record)
    return {
      ...current,
      updatedAt,
      title,
      messageCount: current.messageCount + (isMessage ? 1 : 0),
    }
  }

  private defaultMeta(sessionId: string): SessionMeta {
    const now = new Date().toISOString()
    return {
      id: sessionId,
      shortId: sessionId.slice(0, 12),
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    }
  }

  private async readLegacySession(sessionId: string): Promise<SessionState | undefined> {
    try {
      const sessionPath = this.sessionPath(sessionId)
      await stat(sessionPath)
      return await readJsonFile<SessionState>(sessionPath, {
        meta: this.defaultMeta(sessionId),
        records: [],
      })
    } catch {
      return undefined
    }
  }

  private validateSessionId(id: string): void {
    assertSafeSessionId(id)
  }

  private sessionPath(id: string): string {
    this.validateSessionId(id)
    return path.join(this.sessionsDir, `${id}.json`)
  }

  private sessionJsonlPath(id: string): string {
    this.validateSessionId(id)
    return path.join(this.sessionsDir, `${id}.jsonl`)
  }

  private sessionMetricsPath(id: string): string {
    this.validateSessionId(id)
    return path.join(this.sessionsDir, `${id}.metrics.jsonl`)
  }

  private runningCacheSummary(sessionId: string, metricsPath: string): RunningCacheSummary {
    const current = this.cacheSummaries.get(sessionId)
    if (current) return current

    const restored = this.restoreRunningCacheSummary(metricsPath)
    this.cacheSummaries.set(sessionId, restored)
    return restored
  }

  private restoreRunningCacheSummary(metricsPath: string): RunningCacheSummary {
    const empty = (): RunningCacheSummary => ({
      totalTurns: 0,
      totalInputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalOutputTokens: 0,
      firstBreakTurnCount: null,
      cacheBreakCount: 0,
      causeDistribution: {},
      compactCount: 0,
      firstCompactTurnIndex: null,
      lastCompactTurnIndex: null,
      compactIntervalTotal: 0,
    })

    if (!existsSync(metricsPath)) return empty()
    const summary = empty()
    for (const metric of parseJsonLines<SessionMetric>(readFileSync(metricsPath, 'utf-8'))) {
      if (metric.event === 'session_cache_summary') continue
      this.updateRunningCacheSummary(summary, metric)
    }
    return summary
  }

  private updateRunningCacheSummary(summary: RunningCacheSummary, metric: SessionMetric): void {
    if (metric.event === 'turn') {
      summary.totalTurns += 1
      summary.totalCacheReadTokens += metric.cache_read_tokens
      summary.totalCacheCreationTokens += Math.max(0, metric.cache_creation_tokens ?? 0)
      summary.totalOutputTokens += Math.max(0, metric.response_tokens)
      summary.totalInputTokens += inferTurnInputTokens(metric)
      return
    }

    if (metric.event === 'compact') {
      if (summary.compactCount === 0) {
        summary.firstCompactTurnIndex = summary.totalTurns
      } else if (summary.lastCompactTurnIndex !== null) {
        summary.compactIntervalTotal += summary.totalTurns - summary.lastCompactTurnIndex
      }
      summary.lastCompactTurnIndex = summary.totalTurns
      summary.compactCount += 1
      return
    }

    if (metric.event !== 'cache_break') return
    if (summary.cacheBreakCount === 0) {
      summary.firstBreakTurnCount = summary.totalTurns
    }
    summary.cacheBreakCount += 1
    for (const reason of metric.reasons) {
      const cause = normalizeCacheBreakCause(reason)
      summary.causeDistribution[cause] = (summary.causeDistribution[cause] ?? 0) + 1
    }
  }

  private buildSessionCacheSummaryRecord(sessionId: string, summary: RunningCacheSummary): SessionMetric | null {
    if (summary.totalTurns === 0 && summary.cacheBreakCount === 0) return null

    const denominator = summary.totalInputTokens
      + summary.totalCacheCreationTokens
      + summary.totalCacheReadTokens
    return {
      event: 'session_cache_summary',
      created_at: new Date().toISOString(),
      session_id: sessionId,
      total_cache_hit_rate: denominator > 0 ? summary.totalCacheReadTokens / denominator : null,
      total_turns: summary.totalTurns,
      first_break_turn_count: summary.firstBreakTurnCount,
      cache_break_count: summary.cacheBreakCount,
      cause_distribution: { ...summary.causeDistribution },
    }
  }

  private indexPath(): string {
    return path.join(this.sessionsDir, 'index.json')
  }

  private exportMetric(metric: SessionMetric): void {
    this.otlpExporter?.exportMetric(metric).catch(() => {
      // OTLP export is best-effort and should not surface as an unhandled rejection.
    })
  }
}

function getMessageDisplayContent(record: (SessionRecord & { type: 'message' }) | undefined): string | undefined {
  return record?.displayContent ?? record?.content
}

/**
 * A session's name, derived from the message that opened it.
 *
 * Exported because the index is no longer the only place that answers this:
 * `SessionController` names a session the moment the record is appended, so the
 * canvas header and the sidebar stop reading 「未命名会话」 while the first turn
 * runs. Both must produce the *same* string — a title that differed by a
 * character between the pane and the index would look like a rename nobody
 * asked for — so the rule lives here once. Answers `undefined` for anything
 * that is not a user message, which is what "leave the title alone" means.
 *
 * A pure-image user message has no text to name the session with, so the first
 * attachment's file name stands in (「图片：文件名」); `content` stays untouched —
 * the fallback is display-only and never written back into the message.
 */
export function deriveSessionTitle(record: SessionRecord): string | undefined {
  if (record.type !== 'message' || record.role !== 'user') return undefined
  const text = getMessageDisplayContent(record)
  if (text !== undefined && (text.trim().length > 0 || (record.images?.length ?? 0) === 0)) {
    return text.slice(0, SESSION_TITLE_LENGTH)
  }
  const image = record.images?.find((candidate) => candidate.name.length > 0)
  return image ? `图片：${image.name}`.slice(0, SESSION_TITLE_LENGTH) : undefined
}

/** How much of the first message names the session. */
const SESSION_TITLE_LENGTH = 60

function inferTurnInputTokens(turn: Extract<SessionMetric, { event: 'turn' }>): number {
  if (typeof turn.input_tokens === 'number' && Number.isFinite(turn.input_tokens)) {
    return Math.max(0, turn.input_tokens)
  }
  if (turn.cache_hit_rate && turn.cache_hit_rate > 0) {
    // The rate's denominator is the whole prompt, so what is left after the
    // reads is input *and* writes; subtract the writes when they were recorded.
    const total = turn.cache_read_tokens / turn.cache_hit_rate
    return Math.max(0, total - turn.cache_read_tokens - (turn.cache_creation_tokens ?? 0))
  }
  return 0
}

function normalizeCacheBreakCause(reason: string): string {
  const parenIndex = reason.indexOf('(')
  return parenIndex >= 0 ? reason.slice(0, parenIndex) : reason
}

function toMetricsSummary(summary: RunningCacheSummary): SessionMetricsSummary | null {
  // Cache writes belong in the denominator: they were sent uncached and paid
  // for, so a rate that left them out would read 100% on a cold session.
  const denominator = summary.totalInputTokens
    + summary.totalCacheCreationTokens
    + summary.totalCacheReadTokens
  const compactInterval = averageCompactIntervalTurns(summary)
  if (summary.totalTurns === 0 && summary.cacheBreakCount === 0 && compactInterval === null) return null
  return {
    totalCacheHitRate: denominator > 0 ? summary.totalCacheReadTokens / denominator : null,
    totalTurns: summary.totalTurns,
    firstBreakTurnCount: summary.firstBreakTurnCount,
    cacheBreakCount: summary.cacheBreakCount,
    causeDistribution: { ...summary.causeDistribution },
    averageCompactIntervalTurns: compactInterval,
  }
}

function averageCompactIntervalTurns(summary: RunningCacheSummary): number | null {
  if (summary.compactCount === 0) return null
  if (summary.compactCount === 1) return summary.firstCompactTurnIndex
  return summary.compactIntervalTotal / (summary.compactCount - 1)
}

