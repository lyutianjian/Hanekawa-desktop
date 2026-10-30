import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    if (error instanceof SyntaxError) {
      // Corrupted JSON file — return fallback instead of crashing.
      console.error(`[hanekawa] Warning: corrupted JSON file ${filePath}: ${error.message}`)
      return fallback
    }
    throw error
  }
}

/**
 * Writes via a temp file in the same directory, then renames.
 *
 * `index.json` is rewritten in full on every session mutation, so a plain
 * `writeFile` left a window where a crash — or another process reading
 * mid-write — saw a truncated file. `readJsonFile` treats that as corruption
 * and silently falls back, which for the session index means losing the list.
 */
export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.tmp.${randomUUID()}`
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmpPath, filePath)
}

/**
 * Safely parses a value that might be a JSON string.
 * Returns the parsed value if it's a valid JSON string, otherwise returns the original value.
 */
export function safeJsonParse(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/**
 * Parses JSONL (JSON Lines) format with error tolerance.
 * Skips empty lines and corrupted entries.
 */
export function parseJsonLines<T>(content: string): T[] {
  return parseJsonLinesWithDiagnostics<T>(content).records
}

export interface JsonLineDiagnostic {
  line: number
  message: string
  raw: string
}

export function parseJsonLinesWithDiagnostics<T>(content: string): { records: T[]; diagnostics: JsonLineDiagnostic[] } {
  const records: T[] = []
  const diagnostics: JsonLineDiagnostic[] = []
  for (const [index, line] of content.split('\n').entries()) {
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line) as T)
    } catch (error) {
      diagnostics.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
        raw: line,
      })
    }
  }
  return { records, diagnostics }
}
