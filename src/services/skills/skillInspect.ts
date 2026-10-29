import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseYamlFrontmatter } from '../../utils/frontmatter.js'

/**
 * How much a skill folder can do beyond being read as text.
 *
 * - `low`: markdown and plain reference files only. Nothing in it runs by itself.
 * - `medium`: it carries something executable (scripts, an inline `` !`cmd` ``
 *   snippet) or is unusually large. Anything it runs still goes through the
 *   normal permission gate, but the user should know it is there.
 * - `high`: it can act without being asked — frontmatter `hooks` run commands on
 *   events — or it holds symlinks, which can point outside the folder.
 *
 * The grade drives the import (confirmation, and whether it lands switched on)
 * and is shown on the skill's detail page, so a skill found in another tool's
 * folder gets the same label as one about to be imported.
 */
export type SkillRisk = 'low' | 'medium' | 'high'

export type SkillFindingCode = 'hooks' | 'scripts' | 'inline-shell' | 'symlink' | 'large'

export interface SkillFinding {
  code: SkillFindingCode
  risk: Exclude<SkillRisk, 'low'>
  /** One plain sentence, already in the UI's language. */
  message: string
}

export interface SkillInspection {
  risk: SkillRisk
  findings: SkillFinding[]
  fileCount: number
  totalBytes: number
  /** The frontmatter hook events, for the detail page. */
  hookEvents: string[]
}

/** Extensions that run when handed to an interpreter. Lower-case, dot included. */
const SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.js', '.mjs', '.cjs', '.ts', '.php',
  '.ps1', '.bat', '.cmd', '.command', '.exe', '.app',
])

/** Walk limits: a skill is a handful of files, so a folder past these is not one. */
export const SKILL_MAX_FILES = 500
export const SKILL_MAX_BYTES = 20 * 1024 * 1024

const RISK_ORDER: Record<SkillRisk, number> = { low: 0, medium: 1, high: 2 }

export class SkillInspectionError extends Error {}

/**
 * Reads a skill folder without following anything: `lstat` throughout, so a
 * symlink is reported, never walked into.
 *
 * Throws {@link SkillInspectionError} when `SKILL.md` is missing or its
 * frontmatter cannot be parsed, which is what an import should refuse on.
 */
export async function inspectSkillDir(dir: string): Promise<SkillInspection> {
  let raw: string
  try {
    raw = await readFile(path.join(dir, 'SKILL.md'), 'utf8')
  } catch {
    throw new SkillInspectionError(`${dir} 里没有 SKILL.md，这不是一个技能文件夹。`)
  }

  const findings = new Map<SkillFindingCode, SkillFinding>()
  const add = (finding: SkillFinding): void => {
    if (!findings.has(finding.code)) findings.set(finding.code, finding)
  }

  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/)
  let hookEvents: string[] = []
  if (match) {
    try {
      const frontmatter = parseYamlFrontmatter(match[1]!) as { hooks?: unknown }
      if (frontmatter.hooks && typeof frontmatter.hooks === 'object' && !Array.isArray(frontmatter.hooks)) {
        hookEvents = Object.entries(frontmatter.hooks as Record<string, unknown>)
          .filter(([, list]) => Array.isArray(list) && list.length > 0)
          .map(([event]) => event)
      }
    } catch (error) {
      throw new SkillInspectionError(`SKILL.md 的开头无法解析：${(error as Error).message}`)
    }
    if (/!`[^`\n]+`/.test(match[2]!)) {
      add({ code: 'inline-shell', risk: 'medium', message: '正文里有 !`命令` 片段，技能被调用时会尝试执行。' })
    }
  }
  if (hookEvents.length > 0) {
    add({
      code: 'hooks',
      risk: 'high',
      message: `声明了 hooks（${hookEvents.join('、')}），会在对应事件自动执行命令。`,
    })
  }

  let fileCount = 0
  let totalBytes = 0
  let truncated = false

  const walk = async (current: string, relative: string): Promise<void> => {
    let entries: string[]
    try {
      entries = await readdir(current)
    } catch {
      return
    }
    for (const entry of entries.sort()) {
      if (fileCount >= SKILL_MAX_FILES) {
        truncated = true
        return
      }
      const full = path.join(current, entry)
      const rel = relative === '' ? entry : `${relative}/${entry}`
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isSymbolicLink()) {
        add({ code: 'symlink', risk: 'high', message: `含符号链接（${rel}），它可能指向技能文件夹之外。` })
        continue
      }
      if (info.isDirectory()) {
        await walk(full, rel)
        continue
      }
      fileCount += 1
      totalBytes += info.size
      if (rel === 'SKILL.md') continue
      const executable = process.platform !== 'win32' && (info.mode & 0o111) !== 0
      if (SCRIPT_EXTENSIONS.has(path.extname(entry).toLowerCase()) || executable) {
        add({ code: 'scripts', risk: 'medium', message: `带可执行内容（${rel}）。` })
      }
    }
  }
  await walk(dir, '')

  if (truncated || totalBytes > SKILL_MAX_BYTES) {
    add({
      code: 'large',
      risk: 'medium',
      message: `文件很多或很大（超过 ${SKILL_MAX_FILES} 个文件或 ${SKILL_MAX_BYTES / 1024 / 1024} MB），不像一个普通技能。`,
    })
  }

  const list = [...findings.values()]
  const risk = list.reduce<SkillRisk>((worst, finding) => (RISK_ORDER[finding.risk] > RISK_ORDER[worst] ? finding.risk : worst), 'low')
  return { risk, findings: list, fileCount, totalBytes, hookEvents }
}
