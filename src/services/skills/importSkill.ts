import { cp, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { getSharedSkillsDir, getSkillsDir } from '../../utils/paths.js'
import { parseYamlFrontmatter } from '../../utils/frontmatter.js'
import {
  disableSkillForUser,
  disabledSkillNames,
  loadLocalSettings,
  loadMergedSettings,
  updateLocalSettings,
} from '../../config/settings.js'
import { inspectSkillDir, SkillInspectionError, type SkillInspection, type SkillRisk } from './skillInspect.js'

/** Where an import copies to: this project's folder, or the user's own. */
export type SkillImportTarget = 'project' | 'personal'

/** What an import asks the user before it copies anything. */
export interface SkillImportPrompt {
  name: string
  source: string
  target: SkillImportTarget
  risk: Exclude<SkillRisk, 'low'>
  inspection: SkillInspection
  /** True when the skill will land switched off whatever the answer is. */
  willBeDisabled: boolean
}

export interface ImportSkillOptions {
  /** Defaults to `project`: the copy lands in `<cwd>/.myagent/skills/`. `personal` uses `~/.agents/skills`. */
  target?: SkillImportTarget
  /**
   * Asked for a `medium` or `high` skill, after inspection and before the copy.
   * Resolving `false` cancels the import. Absent means nobody can be asked, and
   * such a skill is refused rather than imported unseen; a `low` skill never asks.
   */
  confirm?: (prompt: SkillImportPrompt) => Promise<boolean>
}

export interface ImportSkillResult {
  name: string
  /** Absent when the user declined the confirmation: nothing was written. */
  cancelled?: true
  risk: SkillRisk
  /** The skill was copied but left switched off, to be reviewed on its detail page. */
  disabled: boolean
}

/**
 * Copies a skill folder into a skills folder Hanekawa manages — this project's
 * `.myagent/skills/` by default, or `~/.agents/skills/` for a personal skill
 * that every project sees — graded by what the folder can do.
 *
 * A skill on disk *is* a directory with a `SKILL.md` in it, so importing one is
 * a recursive copy — the references, scripts and attachments a skill ships
 * beside its markdown come along by definition. `SkillsService` discovers it on
 * the next `reloadSkills()`; nothing here registers anything.
 *
 * The folder is inspected first ({@link inspectSkillDir}):
 * - `low` (text only) imports straight away, switched on;
 * - `medium` (scripts, inline shell) asks first, then imports switched on;
 * - `high` (hooks, symlinks) asks first and imports **switched off**, so what can
 *   run on its own does nothing until the user has read its detail page and
 *   turned it on.
 *
 * Refuses rather than overwrites. An import that silently replaced a skill of
 * the same name would destroy local edits with no way back, and "已经有一个叫 X
 * 的技能" is a message the user can act on.
 */
export async function importSkill(
  cwd: string,
  sourceDir: string,
  options: ImportSkillOptions = {},
): Promise<ImportSkillResult> {
  const target = options.target ?? 'project'
  const source = path.resolve(sourceDir)
  const manifest = path.join(source, 'SKILL.md')
  let raw: string
  try {
    raw = await readFile(manifest, 'utf8')
  } catch {
    throw new Error(`${source} 里没有 SKILL.md，这不是一个技能文件夹。`)
  }

  const name = skillName(raw) ?? path.basename(source)
  const skillsDir = target === 'personal' ? getSharedSkillsDir() : getSkillsDir(cwd)
  const dest = path.join(skillsDir, name)
  // The name comes out of a file the user did not necessarily write, so it is
  // not trusted to be a single path segment: `../` in it would write anywhere
  // under the project. Checked by containment rather than by pattern, which is
  // the same test `resolveProjectFile` applies to a wire path.
  const within = path.relative(skillsDir, dest)
  if (within === '' || within.startsWith('..') || path.isAbsolute(within)) {
    throw new Error(`技能名「${name}」不能作为文件夹名。`)
  }

  if (await exists(dest)) throw new Error(`已经有一个叫 ${name} 的技能。`)

  let inspection: SkillInspection
  try {
    inspection = await inspectSkillDir(source)
  } catch (error) {
    if (error instanceof SkillInspectionError) throw new Error(error.message)
    throw error
  }

  const disabled = inspection.risk === 'high'
  if (inspection.risk !== 'low') {
    if (!options.confirm) {
      throw new Error(`技能「${name}」${riskPhrase(inspection.risk)}，需要确认后才能导入，但当前窗口无法询问。`)
    }
    const accepted = await options.confirm({
      name,
      source,
      target,
      risk: inspection.risk,
      inspection,
      willBeDisabled: disabled,
    })
    if (!accepted) return { name, cancelled: true, risk: inspection.risk, disabled: false }
  }

  await cp(source, dest, { recursive: true })
  // After the copy and only if it succeeded: a half-failed import must not leave
  // a stale entry in `skills.disabled` that would switch off the next skill to
  // take this name. A personal skill is switched off for every project, since it
  // is the same folder all of them read.
  if (disabled) await (target === 'personal' ? disableSkillForUser(name) : switchOffLocally(cwd, name))
  return { name, risk: inspection.risk, disabled }
}

/**
 * Adds one name to the local `skills.disabled`, carrying the effective list over.
 *
 * `skills.disabled` is replaced by the settings merge, so writing only this name
 * into a local file that had no list would silently switch back on everything a
 * higher layer had disabled. Seeding from the merged list keeps every skill's
 * state as it was and changes only the imported one.
 */
async function switchOffLocally(cwd: string, name: string): Promise<void> {
  const disabled = disabledSkillNames(await loadMergedSettings(cwd))
  disabled.add(name)
  const local = await loadLocalSettings(cwd)
  await updateLocalSettings(cwd, { skills: { ...local.skills, disabled: [...disabled].sort() } })
}

function riskPhrase(risk: Exclude<SkillRisk, 'low'>): string {
  return risk === 'high' ? '可以自动执行命令' : '带有可执行内容'
}

/** The `name` in the frontmatter, if it has one. A malformed file falls back to the folder. */
function skillName(raw: string): string | undefined {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match?.[1]) return undefined
  try {
    const frontmatter = parseYamlFrontmatter(match[1]) as { name?: unknown }
    return typeof frontmatter.name === 'string' && frontmatter.name.trim() !== ''
      ? frontmatter.name.trim()
      : undefined
  } catch {
    return undefined
  }
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}
