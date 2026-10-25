import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { withFileLock } from '../sessions/fileLock.js'
import { writeTextFile } from '../tools/textFile.js'
import { resolveExistingPrefix } from '../utils/paths.js'

export class ConfigurationFileError extends Error {
  constructor(readonly filePath: string, reason: string) {
    super(`配置文件 ${filePath} ${reason}。已停止读取或保存，不会自动重建；请先备份原文件，再修正后重新加载。`)
    this.name = 'ConfigurationFileError'
  }
}

export async function readConfigurationFile<T extends object>(filePath: string): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return undefined
    throw new ConfigurationFileError(filePath, `无法读取（${code ?? 'IO'}）`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    // V8's message can quote source text, including credentials; only keep its location.
    const location = error instanceof Error
      ? error.message.match(/position \d+(?: \(line \d+ column \d+\))?/)?.[0]
      : undefined
    throw new ConfigurationFileError(filePath, `不是合法 JSON${location ? `（${location}）` : ''}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigurationFileError(filePath, '顶层必须是 JSON 对象')
  }
  return parsed as T
}

export async function updateConfigurationFile<T extends object>(
  filePath: string,
  mutate: (current: T) => T | undefined | Promise<T | undefined>,
): Promise<void> {
  const target = resolveExistingPrefix(resolve(filePath))
  await withFileLock(`${target}.lock`, async () => {
    const current = await readConfigurationFile<T>(target) ?? {} as T
    const next = await mutate(current)
    if (next === undefined) return
    await writeTextFile(target, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: 'utf8', bom: false, lineEndings: 'LF',
    })
  }, { requireLock: true })
}
