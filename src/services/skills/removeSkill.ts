import { lstat, realpath, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { loadLocalSettings, loadUserSettings, setSkillEnabledLocally, setSkillEnabledForUser } from '../../config/settings.js'
import { SkillsService } from './skillsService.js'

export interface RemoveSkillResult {
  name: string
  /** The folder that was deleted. */
  dir: string
}

/**
 * Uninstalls a skill by deleting its folder.
 *
 * Only from the two folders Hanekawa manages (`<project>/.myagent/skills` and
 * `~/.agents/skills`). A skill found in another tool's folder is that tool's
 * file: it can be switched off here but never deleted, so this refuses it
 * rather than reaching into a directory Hanekawa does not own.
 *
 * The folder is addressed through the service's own listing, never through a
 * path from the caller, and is checked again by realpath containment: a skill
 * folder that is a symlink out of the managed root is unlinked (the link, not its
 * target), and nothing outside the root is ever recursed into.
 *
 * Also forgets the skill's `skills.disabled` entry — but only when no other
 * skill of that name is left, so removing a project copy does not re-enable a
 * shadowed copy the user had switched off.
 */
export async function removeSkill(cwd: string, name: string, scope?: 'personal'): Promise<RemoveSkillResult> {
  const service = new SkillsService(cwd)
  const skill = (await service.listAll(scope)).find((candidate) => candidate.name === name)
  if (!skill?.skillDir || !skill.root) throw new Error(`没有找到技能 ${name}，可能已经被删除。`)
  if (!skill.root.managed) {
    throw new Error(`技能 ${name} 来自 ${skill.root.label}，那是其他工具的文件夹，Hanekawa 不会改动它。可以关掉它，但不能在这里卸载。`)
  }

  const dir = path.resolve(skill.skillDir)
  const root = path.resolve(skill.root.dir)
  const within = path.relative(root, dir)
  if (within === '' || within.startsWith('..') || path.isAbsolute(within) || within.includes(path.sep)) {
    throw new Error(`技能 ${name} 的文件夹不在 ${skill.root.label} 的直接下一层，拒绝删除。`)
  }

  const info = await lstat(dir)
  if (info.isSymbolicLink()) {
    // The link is the skill as far as this root is concerned; its target is not ours.
    await unlink(dir)
  } else {
    const [realDir, realRoot] = await Promise.all([realpath(dir), realpath(root)])
    const realWithin = path.relative(realRoot, realDir)
    if (realWithin === '' || realWithin.startsWith('..') || path.isAbsolute(realWithin)) {
      throw new Error(`技能 ${name} 的真实位置在 ${skill.root.label} 之外，拒绝删除。`)
    }
    await rm(realDir, { recursive: true, force: false })
  }

  const remaining = await service.listAll(scope)
  if (!remaining.some((candidate) => candidate.name === name)) {
    // Only when this layer names it: `skills.disabled` is replaced by the merge,
    // so writing an empty list into a local file that had none would also
    // switch back on whatever a higher layer had disabled.
    const settings = scope === 'personal' ? await loadUserSettings() : await loadLocalSettings(cwd)
    if (settings.skills?.disabled?.includes(name)) {
      if (scope === 'personal') await setSkillEnabledForUser(name, true)
      else await setSkillEnabledLocally(cwd, name, true)
    }
  }
  return { name, dir }
}
