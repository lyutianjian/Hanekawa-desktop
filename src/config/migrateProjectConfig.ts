import { existsSync } from 'node:fs'
import path from 'node:path'
import { getConfigPath, getGlobalConfigPath } from '../utils/paths.js'

/**
 * Report legacy repository configuration without importing or archiving it.
 *
 * A file inside cwd has no trustworthy provenance, even if it contains API
 * keys or is not tracked by git. Import is a manual, reviewed operation: the
 * user backs up the global file and copies only the fields they trust.
 */
export async function migrateProjectConfig(
  cwd: string,
  options: { projectPath?: string; globalPath?: string } = {},
): Promise<string[]> {
  const projectPath = options.projectPath ?? getConfigPath(cwd)
  const globalPath = options.globalPath ?? getGlobalConfigPath()
  if (path.resolve(projectPath) === path.resolve(globalPath)) return []
  if (!existsSync(projectPath)) return []

  return [
    `已忽略旧项目配置 ${projectPath}：仓库配置不会自动导入全局，原文件已保留。如需导入，请先审阅模型、服务商地址和凭证，再备份 ${globalPath}，手动复制确认可信的字段后重新加载。`,
  ]
}
