import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { appendFile, mkdtemp, mkdir, readdir, readFile, writeFile, rm, stat, chmod } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  FileHistoryService,
  fileHistoryDir,
  removeFileHistory,
} from '../src/services/fileHistory/fileHistoryService.js'

/**
 * Backups land under the *global* `.hanekawa`, which resolves through
 * `homedir()` on every call — so a fake home keeps the suite off the real one.
 */
let home = ''
let cwd = ''
const originalHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }

async function makeService(sessionId: string): Promise<FileHistoryService> {
  const service = new FileHistoryService(cwd, sessionId)
  await service.init()
  return service
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

describe('FileHistoryService', () => {
  before(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'fh-home-'))
    process.env.HOME = home
    process.env.USERPROFILE = home
  })

  after(async () => {
    process.env.HOME = originalHome.HOME
    process.env.USERPROFILE = originalHome.USERPROFILE
    await rm(home, { recursive: true, force: true })
  })

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(os.tmpdir(), 'fh-cwd-'))
  })

  it('restores a tracked file to its pre-edit contents', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'original\n', 'utf8')

    const service = await makeService('s1')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await writeFile(file, 'edited\n', 'utf8')

    assert.equal(await service.hasAnyChanges('m1'), true)
    const result = await service.rewindTo('m1')
    assert.equal(result.success, true)
    assert.equal(await readFile(file, 'utf8'), 'original\n')
  })

  it('deletes files that did not exist at the target snapshot', async () => {
    const file = path.join(cwd, 'nested', 'new.txt')

    const service = await makeService('s2')
    await service.makeSnapshot('m1')
    await mkdir(path.dirname(file), { recursive: true })
    await service.trackEdit(file)
    await writeFile(file, 'created by agent\n', 'utf8')

    await service.rewindTo('m1')
    assert.equal(await exists(file), false)
  })

  it('recreates a file the agent deleted after the snapshot', async () => {
    const file = path.join(cwd, 'gone.txt')
    await writeFile(file, 'keep me\n', 'utf8')

    const service = await makeService('s3')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await rm(file)

    // A later turn records the deletion; rewinding to m1 must undo it.
    await service.makeSnapshot('m2')
    await service.rewindTo('m1')
    assert.equal(await readFile(file, 'utf8'), 'keep me\n')
  })

  it('reuses the previous backup when the file has not changed', async () => {
    const file = path.join(cwd, 'stable.txt')
    await writeFile(file, 'same\n', 'utf8')

    const service = await makeService('s4')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await service.makeSnapshot('m2')
    await service.makeSnapshot('m3')

    const versions = service
      .listSnapshots()
      .map((snapshot) => snapshot.trackedFileBackups['stable.txt']?.version)
    assert.deepEqual(versions, [1, 1, 1])
  })

  it('keys tracked files by their path relative to cwd', async () => {
    const file = path.join(cwd, 'sub', 'rel.txt')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, 'x\n', 'utf8')

    const service = await makeService('s5')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)

    const keys = Object.keys(service.listSnapshots()[0]?.trackedFileBackups ?? {})
    assert.deepEqual(keys, [path.join('sub', 'rel.txt')])
  })

  it('stores backups under the global file-history directory', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'v1\n', 'utf8')

    const service = await makeService('s6')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)

    const backupName = service.listSnapshots()[0]?.trackedFileBackups['a.txt']?.backupFileName
    assert.ok(backupName)
    assert.equal(await readFile(path.join(fileHistoryDir('s6'), backupName), 'utf8'), 'v1\n')
  })

  it('reports line counts for what a rewind would change', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'one\ntwo\n', 'utf8')

    const service = await makeService('s7')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await writeFile(file, 'one\n', 'utf8')

    const stats = await service.getDiffStats('m1')
    assert.equal(stats.hasChanges, true)
    assert.equal(stats.fileCount, 1)
    assert.equal(stats.firstFile, 'a.txt')
    assert.equal(stats.additions, 1)
  })

  it('scopes a turn diff to the two snapshots that bound it', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'one\n', 'utf8')

    const service = await makeService('s7b')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await writeFile(file, 'one\ntwo\n', 'utf8')
    await service.makeSnapshot('m2')
    await writeFile(file, 'one\ntwo\nthree\n', 'utf8')

    const firstTurn = await service.getTurnDiffStats('m1')
    assert.equal(firstTurn.additions, 1)
    assert.equal(firstTurn.deletions, 0)

    // The newest snapshot has no successor, so its turn runs up to the worktree.
    const latestTurn = await service.getTurnDiffStats('m2')
    assert.equal(latestTurn.additions, 1)

    // A restore, by contrast, undoes both turns.
    const restore = await service.getDiffStats('m1')
    assert.equal(restore.deletions, 2)
  })

  it('reports no code changes for a snapshot nothing has moved since', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'one\n', 'utf8')

    const service = await makeService('s7c')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await service.makeSnapshot('m2')

    const checkpoints = await service.getCheckpointsWithDiffs()
    assert.deepEqual(
      checkpoints.map((entry) => entry.restoreDiff.hasChanges),
      [false, false],
    )
    assert.equal(checkpoints.at(-1)?.isCurrent, true)
  })

  it('does not overwrite the v1 backup when a file is tracked twice', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'original\n', 'utf8')

    const service = await makeService('s8')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await writeFile(file, 'edited once\n', 'utf8')
    await service.trackEdit(file)

    await service.rewindTo('m1')
    assert.equal(await readFile(file, 'utf8'), 'original\n')
  })

  it('keeps the v1 backup when two edits track the same file concurrently', async () => {
    const file = path.join(cwd, 'a.txt')
    await writeFile(file, 'original\n', 'utf8')

    const service = await makeService('s8b')
    await service.makeSnapshot('m1')
    // Parallel tool calls: the later tracks start before the first one's backup
    // is committed, so only the in-flight guard keeps them off the same `@v1`.
    await Promise.all([service.trackEdit(file), service.trackEdit(file), service.trackEdit(file)])
    await writeFile(file, 'edited once\n', 'utf8')

    const backups = (await readdir(fileHistoryDir('s8b'))).filter((name) => name.includes('@v'))
    assert.equal(backups.length, 1)

    await service.rewindTo('m1')
    assert.equal(await readFile(file, 'utf8'), 'original\n')
  })

  it('preserves file permissions on restore', { skip: process.platform === 'win32' }, async () => {
    const file = path.join(cwd, 'script.sh')
    await writeFile(file, 'echo hi\n', 'utf8')
    await chmod(file, 0o755)

    const service = await makeService('s9')
    await service.makeSnapshot('m1')
    await service.trackEdit(file)
    await writeFile(file, 'echo bye\n', 'utf8')
    await chmod(file, 0o644)

    await service.rewindTo('m1')
    const stats = await stat(file)
    assert.equal(stats.mode & 0o777, 0o755)
  })

  it('reports no changes for an unknown message id', async () => {
    const service = await makeService('s10')
    await service.makeSnapshot('m1')
    assert.equal(await service.hasAnyChanges('missing'), false)
    const result = await service.rewindTo('missing')
    assert.equal(result.success, false)
  })

  describe('persistence', () => {
    it('rebuilds snapshots and mid-turn backups after a restart', async () => {
      const file = path.join(cwd, 'a.txt')
      await writeFile(file, 'original\n', 'utf8')

      const first = await makeService('p1')
      await first.makeSnapshot('m1')
      await first.trackEdit(file)
      await writeFile(file, 'edited\n', 'utf8')
      await first.makeSnapshot('m2')
      await first.flush()
      first.dispose()

      // A fresh service sees only what reached snapshots.jsonl.
      const reopened = await makeService('p1')
      assert.deepEqual(
        reopened.listSnapshots().map((snapshot) => snapshot.messageId),
        ['m1', 'm2'],
      )
      await reopened.rewindTo('m1')
      assert.equal(await readFile(file, 'utf8'), 'original\n')
    })

    it('restores a pre-resume turn from a later process', async () => {
      const kept = path.join(cwd, 'kept.txt')
      const created = path.join(cwd, 'created.txt')
      await writeFile(kept, 'original\n', 'utf8')

      const before = await makeService('r1')
      await before.makeSnapshot('m1')
      await before.trackEdit(kept)
      await writeFile(kept, 'edited\n', 'utf8')
      await before.trackEdit(created)
      await writeFile(created, 'agent made this\n', 'utf8')
      await before.makeSnapshot('m2')
      await before.flush()
      before.dispose()

      // `/resume` keeps the session id, so the resumed service reopens the same
      // history directory; the turn it starts must not shadow the older ones.
      const resumed = await makeService('r1')
      await resumed.makeSnapshot('m3')
      await resumed.trackEdit(kept)
      await writeFile(kept, 'edited again\n', 'utf8')

      assert.equal(await resumed.hasAnyChanges('m1'), true)
      assert.equal((await resumed.rewindTo('m1')).success, true)
      assert.equal(await readFile(kept, 'utf8'), 'original\n')
      assert.equal(await exists(created), false)
    })

    it('starts empty when the session has no log yet', async () => {
      const service = await makeService('p2')
      assert.deepEqual(service.listSnapshots(), [])
    })

    it('skips a truncated trailing line', async () => {
      const service = await makeService('p3')
      await service.makeSnapshot('m1')
      await service.flush()
      await appendFile(path.join(fileHistoryDir('p3'), 'snapshots.jsonl'), '{"kind":"snap', 'utf8')

      const reopened = await makeService('p3')
      assert.equal(reopened.listSnapshots().length, 1)
    })

    it('removes a session’s history directory', async () => {
      const file = path.join(cwd, 'a.txt')
      await writeFile(file, 'x\n', 'utf8')

      const service = await makeService('p4')
      await service.makeSnapshot('m1')
      await service.trackEdit(file)
      await service.flush()
      assert.equal(await exists(fileHistoryDir('p4')), true)

      await removeFileHistory('p4')
      assert.equal(await exists(fileHistoryDir('p4')), false)
    })

    it('rejects a session id that would escape the history directory', async () => {
      for (const bad of ['', '.', '..', 'a/b', '../evil']) {
        await assert.rejects(() => removeFileHistory(bad), /Invalid session ID/)
      }
    })
  })

  describe('snapshot cap', () => {
    /** The backup file a given version of `filePath` is stored under. */
    function backupName(filePath: string, version: number): string {
      return `${createHash('sha256').update(filePath).digest('hex').slice(0, 16)}@v${version}`
    }

    it('evicts old snapshots and deletes only the backups they alone held', async () => {
      const churned = path.join(cwd, 'churned.txt')
      const stable = path.join(cwd, 'stable.txt')
      await writeFile(churned, 'v0\n', 'utf8')
      await writeFile(stable, 'stable\n', 'utf8')

      const service = new FileHistoryService(cwd, 'gc1', { maxSnapshots: 2 })
      await service.init()

      await service.makeSnapshot('m1')
      await service.trackEdit(churned)
      await service.trackEdit(stable)
      await writeFile(churned, 'v1\n', 'utf8')

      await service.makeSnapshot('m2')
      await writeFile(churned, 'v2\n', 'utf8')

      // m3 pushes m1 out; churned@v1 was only ever m1's, stable@v1 is reused
      // by every later snapshot because the file never changed.
      await service.makeSnapshot('m3')
      await service.flush()

      const dir = fileHistoryDir('gc1')
      assert.equal(service.listSnapshots().map((s) => s.messageId).join(','), 'm2,m3')
      assert.equal(await exists(path.join(dir, backupName(churned, 1))), false)
      assert.equal(await exists(path.join(dir, backupName(churned, 2))), true)
      assert.equal(await exists(path.join(dir, backupName(stable, 1))), true)

      // The surviving backups still restore.
      await service.rewindTo('m2')
      assert.equal(await readFile(churned, 'utf8'), 'v1\n')
    })
  })
})
