import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { userHome } from '../utils/paths.js'
import path from 'node:path'

export const PROMPT_HISTORY_LIMIT = 1000
let appendOperation: Promise<void> = Promise.resolve()

export interface PromptHistoryEntry {
  text: string
  cwd: string
  ts: string
}

export function getPromptHistoryPath(home = userHome()): string {
  return path.join(home, '.hanekawa', 'history.jsonl')
}

export async function loadPromptHistory(
  cwd = process.cwd(),
  options: { home?: string; limit?: number } = {},
): Promise<PromptHistoryEntry[]> {
  let content: string
  try {
    content = await readFile(getPromptHistoryPath(options.home), 'utf8')
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return []
    throw error
  }

  const entries = content
    .split(/\r?\n/)
    .map(parsePromptHistoryEntry)
    .filter((entry): entry is PromptHistoryEntry => entry !== null)
    .slice(-(options.limit ?? PROMPT_HISTORY_LIMIT))

  const normalizedCwd = normalizeCwd(cwd)
  const other: PromptHistoryEntry[] = []
  const current: PromptHistoryEntry[] = []
  for (const entry of entries) {
    (normalizeCwd(entry.cwd) === normalizedCwd ? current : other).push(entry)
  }
  return [...other, ...current]
}

export async function appendPromptHistory(
  text: string,
  cwd = process.cwd(),
  options: { home?: string; now?: Date } = {},
): Promise<PromptHistoryEntry | null> {
  if (text.length === 0) return null
  const entry: PromptHistoryEntry = {
    text,
    cwd: path.resolve(cwd),
    ts: (options.now ?? new Date()).toISOString(),
  }
  const operation = appendOperation.then(async () => {
    const historyPath = getPromptHistoryPath(options.home)
    await mkdir(path.dirname(historyPath), { recursive: true })
    await appendFile(historyPath, `${JSON.stringify(entry)}\n`, 'utf8')
    return entry
  })
  appendOperation = operation.then(() => undefined, () => undefined)
  return operation
}

export function promptHistoryTexts(entries: readonly PromptHistoryEntry[]): string[] {
  return entries.map((entry) => entry.text)
}

function parsePromptHistoryEntry(line: string): PromptHistoryEntry | null {
  if (!line.trim()) return null
  try {
    const value: unknown = JSON.parse(line)
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<PromptHistoryEntry>
    if (
      typeof candidate.text !== 'string'
      || candidate.text.length === 0
      || typeof candidate.cwd !== 'string'
      || candidate.cwd.length === 0
      || typeof candidate.ts !== 'string'
      || !Number.isFinite(Date.parse(candidate.ts))
    ) return null
    return { text: candidate.text, cwd: candidate.cwd, ts: candidate.ts }
  } catch {
    return null
  }
}

function normalizeCwd(cwd: string): string {
  const resolved = path.resolve(cwd)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}
