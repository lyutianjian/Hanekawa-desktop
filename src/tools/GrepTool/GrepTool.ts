import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import fg from 'fast-glob'
import picomatch from 'picomatch'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../../harness/types.js'
import { filterGitIgnoredPaths } from '../../utils/gitIgnore.js'
import { resolveToolPath } from '../../utils/paths.js'
import { streamRipgrepLines, type RipgrepStreamResult } from '../rgStream.js'
import { runtimeDataExclusions } from '../searchExclusions.js'
import {
  DEFAULT_HEAD_LIMIT,
  MAX_COLUMNS,
  OUTPUT_MODES,
  RG_TIMEOUT_MS,
  UNLIMITED_FETCH_CAP,
  VCS_EXCLUSIONS,
  type OutputMode,
} from './constants.js'
import { DESCRIPTION } from './prompt.js'

interface GrepInput {
  pattern: string
  path?: string
  glob?: string
  type?: string
  outputMode?: OutputMode
  caseInsensitive?: boolean
  multiline?: boolean
  contextLines?: number
  contextBefore?: number
  contextAfter?: number
  headLimit?: number
  offset?: number
}

/** Everything the search backends need, with defaults already resolved. */
interface SearchOptions {
  pattern: string
  target: string
  targetIsFile: boolean
  glob?: string
  type?: string
  outputMode: OutputMode
  caseInsensitive: boolean
  multiline: boolean
  before: number
  after: number
  cwd: string
  /** App-owned runtime data inside the search root, relative to it. */
  exclusions: string[]
}

function buildRipgrepArgs(options: SearchOptions): string[] {
  const args = ['--hidden']
  for (const dir of VCS_EXCLUSIONS) args.push('--glob', `!${dir}`)
  if (options.caseInsensitive) args.push('--ignore-case')
  if (options.multiline) args.push('-U', '--multiline-dotall')
  if (options.glob) args.push('--glob', options.glob)
  if (options.type) args.push('--type', options.type)
  // Ripgrep matches a glob against the path as it prints it, so an absolute
  // search root needs the `**/` form while a relative one needs the bare form.
  for (const excluded of options.exclusions) {
    args.push('--glob', `!${excluded}/**`, '--glob', `!**/${excluded}/**`)
  }

  if (options.outputMode === 'files_with_matches') {
    args.push('--files-with-matches')
  } else if (options.outputMode === 'count') {
    // `-H` because ripgrep drops the filename when given exactly one file.
    args.push('--count-matches', '-H')
  } else {
    args.push('--no-heading', '--line-number', '-H', '--max-columns', String(MAX_COLUMNS))
    if (options.before > 0) args.push('--before-context', String(options.before))
    if (options.after > 0) args.push('--after-context', String(options.after))
    if (options.before > 0 || options.after > 0) {
      // Context rows use `-` as their field separator, which no parser can tell
      // apart from a hyphen in the path. Forcing `:` keeps every row in the
      // same `path:line:text` shape as a match row.
      args.push('--field-context-separator', ':')
      // The `--` group separator carries no path, so it cannot be relativized
      // or counted; every row already names its own file and line.
      args.push('--context-separator', '')
    }
  }

  // A pattern starting with `-` would otherwise be read as a flag.
  args.push('-e', options.pattern, '--', options.target)
  return args
}

/**
 * Try ripgrep first (ReDoS-immune, fast). Resolves `null` — and only `null` —
 * when `rg` could not be run at all, which is the signal to fall back.
 *
 * Ripgrep exits 1 when it simply found nothing. Treating that as "rg missing"
 * sent every empty search through a full-tree fast-glob scan, which is both
 * slow and how raw `fs` errors reached the model.
 */
function tryRipgrep(options: SearchOptions, keepLimit: number, signal?: AbortSignal): Promise<RipgrepStreamResult | null> {
  const wholeLineIsPath = options.outputMode === 'files_with_matches'
  return streamRipgrepLines({
    cwd: options.cwd,
    args: buildRipgrepArgs(options),
    keepLimit,
    timeoutMs: RG_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    // Kept rows are rewritten relative to the working directory, the same form
    // the fallback prints; counting happens before this so totals stay exact.
    transform: (line) => toRelativeMatch(line, options.cwd, wholeLineIsPath),
  })
}

/** Ripgrep prints `path:line:text`; paths come back relative to `cwd`. */
function toRelativeMatch(line: string, cwd: string, wholeLineIsPath: boolean): string {
  if (wholeLineIsPath) return path.relative(cwd, path.resolve(cwd, line))
  const parts = splitRgLine(line)
  if (!parts) return line
  return path.relative(cwd, path.resolve(cwd, parts.filePath)) + parts.rest
}

/** Ripgrep's own words when a pattern contains `\n` but `-U` was not passed. */
function isLiteralNewlineRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('the literal "\\n" is not allowed')
}

/**
 * Ripgrep prints `path:line:text`. On Windows an absolute path starts with a
 * drive letter, so the first colon belongs to `C:` and splitting on it turns
 * every path into the single character "C".
 */
function splitRgLine(line: string): { filePath: string; rest: string } | null {
  const driveOffset = /^[A-Za-z]:[\\/]/.test(line) ? 2 : 0
  const colonIdx = line.indexOf(':', driveOffset)
  if (colonIdx === -1) return null
  return { filePath: line.substring(0, colonIdx), rest: line.substring(colonIdx) }
}

/** Line numbers (1-based) of every line the pattern touches in `raw`. */
function matchingLineNumbers(raw: string, lines: string[], regex: RegExp, multiline: boolean): number[] {
  if (!multiline) {
    const hits: number[] = []
    for (const [index, line] of lines.entries()) {
      regex.lastIndex = 0
      if (regex.test(line)) hits.push(index + 1)
    }
    return hits
  }

  // A cross-line pattern has to run against the whole file; the line number
  // comes from counting newlines before the match.
  const global = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`)
  const hits = new Set<number>()
  let match: RegExpExecArray | null
  while ((match = global.exec(raw)) !== null) {
    const start = countNewlines(raw, match.index) + 1
    const end = start + countNewlines(match[0], match[0].length)
    for (let line = start; line <= end; line++) hits.add(line)
    // A zero-length match would spin forever.
    if (match.index === global.lastIndex) global.lastIndex++
  }
  return [...hits].sort((a, b) => a - b)
}

function countNewlines(value: string, upTo: number): number {
  let count = 0
  for (let index = 0; index < upTo; index++) {
    if (value[index] === '\n') count++
  }
  return count
}

/**
 * Fallback: Node RegExp with a per-file scan to limit ReDoS impact.
 * Used only when `rg` is not installed. `type` has no equivalent here; the
 * caller notes that in the result rather than silently narrowing nothing.
 */
async function fallbackGrep(options: SearchOptions, limit: number): Promise<{ rows: string[]; total: number }> {
  const flags = (options.caseInsensitive ? 'i' : '') + (options.multiline ? 's' : '')
  let regex: RegExp
  try {
    regex = new RegExp(options.pattern, flags)
  } catch {
    return { rows: ['Error: Invalid regular expression pattern.'], total: 1 }
  }

  const files = options.targetIsFile ? [options.target] : await fallbackFiles(options)
  const rows: string[] = []

  for (const filePath of files) {
    if (rows.length >= limit) break
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      continue
    }
    // Skip binary files (check for null bytes in first 8KB)
    if (raw.slice(0, 8192).includes('\0')) continue

    const lines = raw.split('\n')
    const hits = matchingLineNumbers(raw, lines, regex, options.multiline)
    if (hits.length === 0) continue

    const relative = path.relative(options.cwd, filePath)
    if (options.outputMode === 'files_with_matches') {
      rows.push(relative)
      continue
    }
    if (options.outputMode === 'count') {
      rows.push(`${relative}:${hits.length}`)
      continue
    }

    for (const lineNumber of expandContext(hits, options.before, options.after, lines.length)) {
      if (rows.length >= limit) break
      rows.push(`${relative}:${lineNumber}:${lines[lineNumber - 1] ?? ''}`)
    }
  }

  return { rows, total: rows.length }
}

/**
 * `--glob` as ripgrep reads it: a pattern without `/` is matched against the
 * basename at any depth (so `*.ts` finds `src/a.ts`, not just top-level files),
 * and dots are matched like any other character.
 */
function globMatcher(glob: string | undefined): ((entry: string) => boolean) | undefined {
  if (!glob) return undefined
  const matches = picomatch(glob, { dot: true })
  if (glob.includes('/')) return (entry) => matches(entry)
  return (entry) => matches(path.posix.basename(entry))
}

/** Without ripgrep's traversal, at least these never come back. */
const FALLBACK_IGNORE = ['**/node_modules/**', ...VCS_EXCLUSIONS.map((dir) => `**/${dir}/**`)]

/**
 * Every file under the search root ripgrep would have considered. It walks with
 * dots so hidden sources stay searchable — the same reason the ripgrep call
 * passes `--hidden` — prunes the directories ripgrep never enters, then applies
 * the glob filter before anything is read.
 */
async function fallbackFiles(options: SearchOptions): Promise<string[]> {
  const entries = await fg('**/*', {
    cwd: options.target,
    onlyFiles: true,
    dot: true,
    followSymbolicLinks: false,
    ignore: [...FALLBACK_IGNORE, ...options.exclusions.flatMap((rel) => [rel, `${rel}/**`])],
  })
  const relative = entries.map((entry) => entry.replace(/\\/g, '/'))
  const matcher = globMatcher(options.glob)
  const matched = matcher ? relative.filter((entry) => matcher(entry)) : relative
  // `--glob` overrides ripgrep's ignore files outright, so only a search with
  // no glob asks git which of these the user had already ignored.
  const kept = options.glob ? matched : await filterGitIgnoredPaths(options.target, matched)
  return kept.map((entry) => path.join(options.target, entry))
}

/** Match lines widened by the context window, deduplicated, in order. */
function expandContext(hits: number[], before: number, after: number, totalLines: number): number[] {
  if (before === 0 && after === 0) return hits
  const wanted = new Set<number>()
  for (const hit of hits) {
    const start = Math.max(1, hit - before)
    const end = Math.min(totalLines, hit + after)
    for (let line = start; line <= end; line++) wanted.add(line)
  }
  return [...wanted].sort((a, b) => a - b)
}

export const grepTool: Tool = {
  name: 'Grep',
  description: DESCRIPTION,
  searchHint: 'search file contents with regex (ripgrep)',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Regular expression to search for (ripgrep syntax).'),
    path: z.string().min(1).optional().describe('File or directory to search in. Defaults to the working directory. A single file is searched directly.'),
    glob: z.string().min(1).optional().describe('Glob filtering which files are searched, e.g. "*.ts". Ignored when path is a file.'),
    type: z.string().min(1).optional().describe('Ripgrep file type filter, e.g. "js", "py", "rust". Ignored when path is a file.'),
    outputMode: z.enum(OUTPUT_MODES).optional().describe('Shape of the result: "content" (path:line:text, the default), "files_with_matches" (paths only), or "count" (path:count).'),
    caseInsensitive: z.boolean().optional().describe('Case-insensitive search. Defaults to false.'),
    multiline: z.boolean().optional().describe('Let the pattern span lines and let `.` match newlines. Required for a pattern containing \\n. Defaults to false.'),
    contextLines: z.number().int().min(0).max(100).optional().describe('Lines of context on both sides of each match. Only valid with outputMode "content".'),
    contextBefore: z.number().int().min(0).max(100).optional().describe('Lines of context before each match. Only valid with outputMode "content".'),
    contextAfter: z.number().int().min(0).max(100).optional().describe('Lines of context after each match. Only valid with outputMode "content".'),
    headLimit: z.number().int().min(0).max(10_000).optional().describe(`Maximum rows to return. Defaults to ${DEFAULT_HEAD_LIMIT}; 0 means unlimited.`),
    offset: z.number().int().min(0).optional().describe('Skip this many rows before applying headLimit. Defaults to 0.'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  maxResultSizeChars: 30_000,
  userFacingName: () => 'Search',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const { pattern, path: searchPath, glob, offset } = input as { pattern?: unknown; path?: unknown; glob?: unknown; offset?: unknown }
    if (typeof pattern !== 'string') return null
    const parts = [`pattern: "${truncateMiddle(pattern, 80)}"`]
    if (typeof searchPath === 'string' && searchPath.trim()) parts.push(`path: "${truncateMiddle(searchPath.trim(), 60)}"`)
    if (typeof glob === 'string' && glob.trim()) parts.push(`glob: "${truncateMiddle(glob.trim(), 60)}"`)
    if (typeof offset === 'number' && offset > 0) parts.push(`offset: ${offset}`)
    return parts.join(', ')
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Searching files'
    const pattern = (input as { pattern?: unknown }).pattern
    return typeof pattern === 'string' ? `Searching for "${truncateMiddle(pattern, 60)}"` : 'Searching files'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as GrepInput
    const target = resolveToolPath(context, options.path ?? '.')
    const outputMode = options.outputMode ?? 'content'
    const before = options.contextBefore ?? options.contextLines ?? 0
    const after = options.contextAfter ?? options.contextLines ?? 0
    const offset = options.offset ?? 0
    // headLimit: 0 means unlimited; undefined means use default
    const effectiveLimit = options.headLimit === 0 ? Infinity : (options.headLimit ?? DEFAULT_HEAD_LIMIT)
    // Fetch enough results to cover offset + limit
    const fetchLimit = effectiveLimit === Infinity ? UNLIMITED_FETCH_CAP : offset + effectiveLimit

    if ((before > 0 || after > 0) && outputMode !== 'content') {
      return {
        ok: false,
        content: `Context lines are only available with outputMode "content"; this call asked for "${outputMode}". Drop contextLines/contextBefore/contextAfter, or switch outputMode to "content".`,
        errorCode: 'invalid_input',
      }
    }

    // `path` may name a file. Resolving that here keeps ripgrep from being
    // handed a file as its working directory, and keeps fast-glob from calling
    // scandir on one — both of which surfaced as a bare ENOTDIR.
    let targetIsFile: boolean
    try {
      targetIsFile = (await stat(target)).isFile()
    } catch {
      return {
        ok: false,
        content: `Cannot search '${options.path ?? '.'}': the path does not exist. Relative paths resolve against ${context.cwd}. Use Glob to locate the file first.`,
        errorCode: 'not_found',
      }
    }

    const searchOptions: SearchOptions = {
      pattern: options.pattern,
      target,
      targetIsFile,
      // A file target is searched directly, so both filters would only exclude it.
      ...(targetIsFile ? {} : { glob: options.glob, type: options.type }),
      outputMode,
      caseInsensitive: options.caseInsensitive ?? false,
      multiline: options.multiline ?? false,
      before,
      after,
      cwd: context.cwd,
      // A browse of a home directory must not wade through the sessions and
      // spilled output Hanekawa keeps under `~/.myagent`, nor the coordination
      // worktrees; a search aimed inside those keeps them.
      exclusions: runtimeDataExclusions(target),
    }

    // Try ripgrep first (ReDoS-immune, faster). Only `offset + headLimit` rows
    // are held; the rest is counted as it streams.
    let rgResult: RipgrepStreamResult | null
    try {
      rgResult = await tryRipgrep(searchOptions, fetchLimit, context.abortSignal)
    } catch (error) {
      // A pattern containing `\n` is a cross-line search the caller forgot to
      // declare. Retrying with multiline answers the question instead of
      // handing back ripgrep's stderr.
      if (searchOptions.multiline || !isLiteralNewlineRejection(error)) throw error
      rgResult = await tryRipgrep({ ...searchOptions, multiline: true }, fetchLimit, context.abortSignal)
    }
    if (rgResult !== null) {
      return paginateResult(rgResult.kept, rgResult.total, effectiveLimit, offset, outputMode)
    }

    // Fallback to Node RegExp
    const fallback = await fallbackGrep(searchOptions, fetchLimit)
    const note = searchOptions.type
      ? `\n\n[ripgrep is not installed, so the type filter "${searchOptions.type}" was not applied. Use glob instead for an exact filter.]`
      : ''
    return paginateResult(fallback.rows, fallback.total, effectiveLimit, offset, outputMode, note)
  },
}

function paginateResult(rows: string[], total: number, limit: number, offset: number, outputMode: OutputMode, note = ''): ToolResult {
  const sliced = rows.slice(offset, offset + limit)
  const rowCount = sliced.length

  let content = sliced.join('\n') || 'No matches found.'
  // Append pagination notice if results were truncated
  if (offset > 0 || offset + sliced.length < total) {
    content += `\n\n[Showing results ${offset + 1}..${offset + sliced.length} of ${total} total matches]`
  }
  content += note

  return {
    ok: true,
    content,
    metadata: { display: { summary: summarize(sliced, rowCount, outputMode) } },
  }
}

function summarize(rows: string[], rowCount: number, outputMode: OutputMode): string {
  if (rowCount === 0) return 'No matches found'
  if (outputMode === 'files_with_matches') {
    return `Found ${rowCount} ${rowCount === 1 ? 'file' : 'files'}`
  }
  const fileCount = new Set(rows.map((row) => splitRgLine(row)?.filePath ?? row).filter(Boolean)).size
  if (outputMode === 'count') {
    return `Counted matches in ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
  }
  return `Found ${rowCount} ${rowCount === 1 ? 'match' : 'matches'} across ${fileCount} ${fileCount === 1 ? 'file' : 'files'}`
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
