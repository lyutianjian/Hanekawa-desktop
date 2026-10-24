import { hostname } from 'node:os'
import { open, readFile, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { mkdir } from 'node:fs/promises'

/**
 * Advisory cross-process lock for the session files.
 *
 * `SessionStore`'s promise-chain mutexes are static fields, so they serialize
 * writers inside one process and do nothing at all between two. That was fine
 * while the CLI was the only writer; a desktop app open on the same project
 * makes it a real interleaving hazard, and `index.json` is the file two
 * processes corrupt first.
 *
 * Implemented with `O_EXCL` rather than `flock`, which is not portable and is a
 * no-op on some Windows filesystems. The cost is that a crashed holder leaves
 * the file behind, so a lock is stealable once it is both older than `staleMs`
 * and owned by a pid that is no longer alive.
 */

export interface FileLockOptions {
  /** A lock older than this whose owner is gone may be stolen. */
  staleMs?: number
  /** Give up after this long. Without `requireLock` the operation then runs anyway. */
  timeoutMs?: number
  /**
   * Fail instead of running the operation without the lock.
   *
   * The default keeps the lock advisory: a session write must not be wedged
   * forever behind a peer that crashed and left its lock file behind. A caller
   * whose operation replaces or derives from a whole file cannot accept that
   * degradation — running unlocked there silently drops whatever a peer wrote
   * in between — so it asks to fail.
   */
  requireLock?: boolean
}

/** Why a lock could not be taken. */
export type FileLockFailure = 'timeout' | 'unavailable'

export class FileLockError extends Error {
  constructor(readonly lockPath: string, readonly reason: FileLockFailure) {
    super(reason === 'timeout'
      ? `Timed out waiting for file lock: ${lockPath}`
      : `Cannot create file lock: ${lockPath}`)
    this.name = 'FileLockError'
  }
}

interface LockOwner {
  pid: number
  host: string
  acquiredAt: number
}

const DEFAULT_STALE_MS = 30_000
const DEFAULT_TIMEOUT_MS = 10_000
const POLL_MIN_MS = 5
const POLL_MAX_MS = 50

export async function withFileLock<T>(
  lockPath: string,
  operation: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const staleMs = options.staleMs ?? DEFAULT_STALE_MS
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const outcome = await acquire(lockPath, staleMs, timeoutMs)
  if (!outcome.ok && options.requireLock) throw new FileLockError(lockPath, outcome.reason)
  try {
    return await operation()
  } finally {
    if (outcome.ok) await release(lockPath)
  }
}

/**
 * Returns whether the lock is actually held, and why not when it is not.
 *
 * `timeout` means a live peer holds it; `unavailable` means a lock file could
 * not be created and owned (read-only directory, a file where one has to be,
 * an owner block that did not land). Callers that do not require the lock
 * proceed either way: blocking a session write forever because some other
 * process is wedged is worse than the interleaving we are guarding against.
 */
async function acquire(
  lockPath: string,
  staleMs: number,
  timeoutMs: number,
): Promise<{ ok: true } | { ok: false; reason: FileLockFailure }> {
  const deadline = Date.now() + timeoutMs
  let delay = POLL_MIN_MS

  try {
    await mkdir(dirname(lockPath), { recursive: true })
  } catch {
    // No directory to hold the lock file; waiting cannot fix that.
    return { ok: false, reason: 'unavailable' }
  }

  for (;;) {
    const created = await tryCreate(lockPath)
    if (created === 'acquired') return { ok: true }
    if (created === 'unavailable') return { ok: false, reason: 'unavailable' }
    if (await stealIfStale(lockPath, staleMs)) continue
    if (Date.now() >= deadline) return { ok: false, reason: 'timeout' }
    await sleep(delay)
    delay = Math.min(delay * 2, POLL_MAX_MS)
  }
}

async function tryCreate(lockPath: string): Promise<'acquired' | 'busy' | 'unavailable'> {
  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'busy'
    // A lock we cannot create at all will not appear by waiting.
    return 'unavailable'
  }

  const owner: LockOwner = { pid: process.pid, host: hostname(), acquiredAt: Date.now() }
  const content = JSON.stringify(owner)
  let created: { dev: number; ino: number } | undefined
  try {
    const stats = await handle.stat()
    created = { dev: stats.dev, ino: stats.ino }
    await handle.writeFile(content, 'utf8')
    // A short write would leave the owner block unreadable, and staleness then
    // sees no live pid and steals a lock this process is still holding.
    if ((await handle.stat()).size !== Buffer.byteLength(content)) {
      throw new Error(`File lock owner was not written in full: ${lockPath}`)
    }
    await handle.close()
    return 'acquired'
  } catch {
    // Owning the file is not holding the lock: the owner block is what makes
    // it ours. Close it, drop the file only while the path is still the one
    // created here, and report unavailable rather than claim a lock.
    await discardCreatedLock(lockPath, handle, created)
    return 'unavailable'
  }
}

async function discardCreatedLock(
  lockPath: string,
  handle: Awaited<ReturnType<typeof open>>,
  created: { dev: number; ino: number } | undefined,
): Promise<void> {
  try {
    if (!created) return
    const current = await stat(lockPath).catch(() => undefined)
    if (!current || current.dev !== created.dev || current.ino !== created.ino) return
    await unlink(lockPath).catch(() => {})
  } finally {
    await handle.close().catch(() => {})
  }
}

/** Removes a lock whose holder is demonstrably gone. */
async function stealIfStale(lockPath: string, staleMs: number): Promise<boolean> {
  try {
    const stats = await stat(lockPath)
    if (Date.now() - stats.mtimeMs < staleMs) return false

    const owner = await readOwner(lockPath)
    // Only steal from a dead pid on this machine. A lock held from another host
    // (a network share) can never be verified, so age alone has to do.
    if (owner && owner.host === hostname() && isAlive(owner.pid)) return false

    await unlink(lockPath)
    return true
  } catch {
    return false
  }
}

async function readOwner(lockPath: string): Promise<LockOwner | undefined> {
  try {
    const raw = await readFile(lockPath, 'utf8')
    const parsed = JSON.parse(raw) as LockOwner
    return typeof parsed?.pid === 'number' ? parsed : undefined
  } catch {
    return undefined
  }
}

function isAlive(pid: number): boolean {
  try {
    // Signal 0 checks for existence without delivering anything.
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function release(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath)
  } catch {
    // Already stolen or removed; nothing to do.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
