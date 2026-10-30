import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  forgetRecentProject,
  loadRecentProjects,
  peekNewestSessionAt,
  peekSessions,
  recordProjectOpen,
  resolveStartupRoot,
} from '../src/desktop/recentProjects.js'
import { getSessionsDir, normalizeCaseForComparison } from '../src/utils/paths.js'

/**
 * The "added projects" registry and the startup resolution over it — plain node
 * against a scratch home, because this is main-process state `main.ts` cannot
 * cover.
 *
 * `home` is passed explicitly rather than through the environment: every
 * function here takes it as a parameter, and the default only exists for the
 * production call sites.
 */

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-projects-home-'))
  try {
    await run(home)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
}

/** A scratch project directory with an optional seeded session index. */
async function withProject(
  home: string,
  name: string,
  sessions: ReadonlyArray<{ id: string; updatedAt: string; messageCount?: number; title?: string }>,
  run: (cwd: string) => Promise<void>,
): Promise<void> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), `hanekawa-project-${name}-`))
  await mkdir(getSessionsDir(cwd), { recursive: true })
  await writeFile(
    path.join(getSessionsDir(cwd), 'index.json'),
    JSON.stringify({ sessions }),
    'utf8',
  )
  await recordProjectOpen(cwd, home)
  try {
    await run(cwd)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

const at = (minutesAgo: number): string =>
  new Date(Date.UTC(2026, 7, 20, 12, 0, 0) - minutesAgo * 60_000).toISOString()

test('the registry is empty before anything is opened', async () => {
  await withHome(async (home) => {
    assert.deepEqual(await loadRecentProjects(home), [])
  })
})

test('recording appends, and re-opening keeps a project where it is', async () => {
  // The array is the sidebar's group order, so a re-open must not move a row:
  // clicking `+` on a closed project used to hoist it to the top of the sidebar.
  await withHome(async (home) => {
    const a = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-a-'))
    const b = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-b-'))
    try {
      await recordProjectOpen(a, home)
      await recordProjectOpen(b, home)
      assert.deepEqual(await loadRecentProjects(home), [a, b], 'first added, first listed')

      // Re-opening neither duplicates nor reorders.
      await recordProjectOpen(a, home)
      assert.deepEqual(await loadRecentProjects(home), [a, b])

      // Deduped by root key, case-folded on the platforms that fold.
      await recordProjectOpen(b.toUpperCase(), home)
      if (process.platform === 'win32') {
        assert.deepEqual(await loadRecentProjects(home), [a, b])
      }
    } finally {
      await rm(a, { recursive: true, force: true })
      await rm(b, { recursive: true, force: true })
    }
  })
})

test('the cap drops the oldest addition, never the project being opened', async () => {
  await withHome(async (home) => {
    const dirs: string[] = []
    try {
      // One past `MAX_PROJECTS` (20): the first addition falls off the front.
      for (let index = 0; index < 21; index += 1) {
        const dir = await mkdtemp(path.join(os.tmpdir(), `hanekawa-cap${index}-`))
        dirs.push(dir)
        await recordProjectOpen(dir, home)
      }
      assert.deepEqual(await loadRecentProjects(home), dirs.slice(1))
    } finally {
      for (const dir of dirs) await rm(dir, { recursive: true, force: true })
    }
  })
})

test('writing prunes directories that no longer exist', async () => {
  await withHome(async (home) => {
    const gone = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-gone-'))
    const stays = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-stays-'))
    await recordProjectOpen(gone, home)
    await rm(gone, { recursive: true, force: true })
    try {
      await recordProjectOpen(stays, home)
      // The vanished root was pruned by the write, not merely skipped.
      assert.deepEqual(await loadRecentProjects(home), [stays])
    } finally {
      await rm(stays, { recursive: true, force: true })
    }
  })
})

test('forgetting a project drops just that one, in place', async () => {
  await withHome(async (home) => {
    const a = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-fa-'))
    const b = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-fb-'))
    const c = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-fc-'))
    try {
      await recordProjectOpen(a, home)
      await recordProjectOpen(b, home)
      await recordProjectOpen(c, home)

      await forgetRecentProject(b, home)
      assert.deepEqual(await loadRecentProjects(home), [a, c], 'the rest keep their order')

      // Idempotent: forgetting what is not there is not an error, because the
      // sidebar can ask twice (two windows, a stale row).
      await forgetRecentProject(b, home)
      assert.deepEqual(await loadRecentProjects(home), [a, c])

      // Case-folded on the platforms that fold, exactly like `recordProjectOpen`
      // dedupes — the wire carries a normalized root key, not the literal path.
      // Which platforms those are is asked of the app's own rule rather than
      // restated here: macOS folds too, and a hard-coded `win32` made this
      // assertion claim the opposite of what the registry actually does there.
      const folds = normalizeCaseForComparison('A') === normalizeCaseForComparison('a')
      await forgetRecentProject(a.toUpperCase(), home)
      assert.deepEqual(await loadRecentProjects(home), folds ? [c] : [a, c])
    } finally {
      for (const dir of [a, b, c]) await rm(dir, { recursive: true, force: true })
    }
  })
})

test('forgetting one project does not prune the others off disk', async () => {
  // Unlike `recordProjectOpen`, which prunes as it writes. Removing one row must
  // not silently take unrelated ones with it — a project on a disconnected
  // network share is still a project the user added.
  await withHome(async (home) => {
    const gone = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-fgone-'))
    const target = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-ftarget-'))
    try {
      await recordProjectOpen(gone, home)
      await recordProjectOpen(target, home)
      await rm(gone, { recursive: true, force: true })

      await forgetRecentProject(target, home)
      assert.deepEqual(await loadRecentProjects(home), [gone])
    } finally {
      await rm(target, { recursive: true, force: true })
    }
  })
})

test('a corrupted registry reads as empty', async () => {
  await withHome(async (home) => {
    await mkdir(path.join(home, '.hanekawa'), { recursive: true })
    await writeFile(
      path.join(home, '.hanekawa', 'projects.json'),
      '{not json',
      'utf8',
    )
    assert.deepEqual(await loadRecentProjects(home), [])
  })
})

test('peekNewestSessionAt reads the index without a store', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'hanekawa-peek-'))
  try {
    assert.equal(await peekNewestSessionAt(cwd), undefined)
    await mkdir(getSessionsDir(cwd), { recursive: true })
    assert.equal(await peekNewestSessionAt(cwd), undefined)

    await writeFile(
      path.join(getSessionsDir(cwd), 'index.json'),
      JSON.stringify({
        sessions: [
          { id: 'old', updatedAt: at(30), messageCount: 2 },
          { id: 'new', updatedAt: at(5), messageCount: 1, title: 'Newest' },
          { id: 'broken', updatedAt: 'not-a-date', messageCount: 1 },
        ],
      }),
      'utf8',
    )
    assert.equal(await peekNewestSessionAt(cwd), Date.parse(at(5)))

    const rows = await peekSessions(cwd)
    assert.deepEqual(
      rows.map((row) => row.id),
      ['new', 'old', 'broken'],
    )
    assert.equal(rows[0]?.title, 'Newest')
    assert.equal(rows[2]?.messageCount, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('startup opens the project whose newest session is newest anywhere', async () => {
  await withHome(async (home) => {
    await withProject(home, 'older', [{ id: 'a1', updatedAt: at(30), messageCount: 1 }], async (older) => {
      await withProject(home, 'newer', [{ id: 'b1', updatedAt: at(5), messageCount: 1 }], async (newer) => {
        const resolution = await resolveStartupRoot(home)
        assert.equal(resolution.root, newer)
        assert.equal(resolution.global, false)
        // Registry order (newer was opened last) is irrelevant; the session
        // timestamps decide.
        await recordProjectOpen(older, home)
        assert.equal((await resolveStartupRoot(home)).root, newer)
      })
    })
  })
})

test('startup falls back to the most recently added project when no project has sessions', async () => {
  await withHome(async (home) => {
    await withProject(home, 'first', [], async () => {
      await withProject(home, 'second', [], async (second) => {
        const resolution = await resolveStartupRoot(home)
        assert.equal(resolution.root, second)
        assert.equal(resolution.global, false)
      })
    })
  })
})

test('startup resolves to the global workspace when the registry has nothing to offer', async () => {
  await withHome(async (home) => {
    const empty = await resolveStartupRoot(home)
    assert.equal(empty.root, home)
    assert.equal(empty.global, true)

    // The global workspace's own sessions make it win over a project whose
    // sessions are older.
    await mkdir(getSessionsDir(home), { recursive: true })
    await writeFile(
      path.join(getSessionsDir(home), 'index.json'),
      JSON.stringify({ sessions: [{ id: 'g1', updatedAt: at(1), messageCount: 1 }] }),
      'utf8',
    )
    await withProject(home, 'stale', [{ id: 's1', updatedAt: at(60), messageCount: 1 }], async () => {
      const resolution = await resolveStartupRoot(home)
      assert.equal(resolution.root, home)
      assert.equal(resolution.global, true)
    })
  })
})

test('startup skips roots that vanished from disk', async () => {
  await withHome(async (home) => {
    const gone = await mkdtempSync(path.join(os.tmpdir(), 'hanekawa-vanished-'))
    await mkdir(getSessionsDir(gone), { recursive: true })
    await writeFile(
      path.join(getSessionsDir(gone), 'index.json'),
      JSON.stringify({ sessions: [{ id: 'v1', updatedAt: at(1), messageCount: 1 }] }),
      'utf8',
    )
    await recordProjectOpen(gone, home)
    await rm(gone, { recursive: true, force: true })

    assert.equal((await resolveStartupRoot(home)).global, true)
  })
})
