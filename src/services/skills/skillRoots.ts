import path from 'node:path'
import { getSharedSkillsDir, getSkillsDir, userHome } from '../../utils/paths.js'

/**
 * Where skills are read from, in priority order: the first folder to define a
 * name wins, later ones are shadowed.
 *
 * - `project` / `shared` are the two folders Hanekawa *manages*: it imports into
 *   them and the settings page may delete from them.
 * - `compat-*` are other tools' folders, read so a skill written for them works
 *   here unchanged. They are read-only: Hanekawa never writes to or deletes from
 *   another tool's folder, so a skill found there can be switched off but not
 *   uninstalled.
 */
export type SkillRootKind = 'project' | 'shared' | 'compat-project' | 'compat-personal'

export interface SkillRoot {
  dir: string
  kind: SkillRootKind
  /** True for the two folders Hanekawa owns; the only ones a skill may be removed from. */
  managed: boolean
  /** The folder as a person would write it, for badges and hover text. */
  label: string
}

/** The five foreign folders, project-level first. Exported so the README and tests name the same list. */
export const COMPAT_SKILL_FOLDERS: ReadonlyArray<{ kind: 'compat-project' | 'compat-personal'; segments: readonly string[] }> = [
  { kind: 'compat-project', segments: ['.claude', 'skills'] },
  { kind: 'compat-project', segments: ['.agents', 'skills'] },
  { kind: 'compat-personal', segments: ['.claude', 'skills'] },
  { kind: 'compat-personal', segments: ['.codex', 'skills'] },
  { kind: 'compat-personal', segments: ['.gemini', 'skills'] },
]

export function skillRoots(cwd: string, scope?: 'personal'): SkillRoot[] {
  const roots: SkillRoot[] = [
    ...(scope === 'personal' ? [] : [{ dir: getSkillsDir(cwd), kind: 'project' as const, managed: true, label: '.myagent/skills' }]),
    { dir: getSharedSkillsDir(), kind: 'shared', managed: true, label: '~/.agents/skills' },
  ]
  const home = userHome()
  for (const folder of COMPAT_SKILL_FOLDERS) {
    if (scope === 'personal' && folder.kind === 'compat-project') continue
    const dir = path.join(folder.kind === 'compat-project' ? cwd : home, ...folder.segments)
    // The home directory can itself be a workspace: `<cwd>/.agents/skills` is then
    // the managed shared folder, and listing it twice would make every one of its
    // skills look foreign and un-removable.
    if (roots.some((root) => path.resolve(root.dir) === path.resolve(dir))) continue
    roots.push({
      dir,
      kind: folder.kind,
      managed: false,
      label: `${folder.kind === 'compat-personal' ? '~/' : ''}${folder.segments.join('/')}`,
    })
  }
  return roots
}

/** Whether a root's skills are the project's own (checked in, shared with the repo) or this user's. */
export function skillScopeOf(kind: SkillRootKind): 'project' | 'personal' {
  return kind === 'project' || kind === 'compat-project' ? 'project' : 'personal'
}
