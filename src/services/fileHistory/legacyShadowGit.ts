import { rm } from 'node:fs/promises'
import path from 'node:path'
import { getHanekawaDir } from '../../utils/paths.js'

/**
 * Removes the shadow-git repos the previous checkpoint implementation left in
 * `<cwd>/.hanekawa/shadow-git/`.
 *
 * Those repos sat *inside* the worktree and stored a compressed copy of the
 * whole tree per session per turn, so a project that ran the old implementation
 * for a while is carrying tens of gigabytes that nothing will ever read again:
 * `/rewind` now addresses restores through `~/.hanekawa/file-history/`, and no
 * code path can open a shadow repo any more.
 *
 * Best-effort and silent. It runs on every project bootstrap rather than behind
 * a marker file because after the first successful removal the directory is
 * gone and the call is one `rm` on a missing path.
 */
export async function removeLegacyShadowGit(cwd: string): Promise<void> {
  try {
    await rm(path.join(getHanekawaDir(cwd), 'shadow-git'), { recursive: true, force: true })
  } catch {
    // A locked or unreadable leftover only costs disk space.
  }
}
