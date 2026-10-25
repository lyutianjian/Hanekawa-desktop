import { existsSync } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import picomatch from 'picomatch'
import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { resolveToolPath } from '../../utils/paths.js'
import { RG_TIMEOUT_MS, VCS_EXCLUSIONS } from '../GrepTool/constants.js'
import { streamRipgrepLines } from '../rgStream.js'
import { runtimeDataExclusions } from '../searchExclusions.js'
import { DESCRIPTION } from './prompt.js'

const MAX_RESULTS = 200

interface GlobInput {
  pattern: string
  path?: string
}

export const globTool: Tool = {
  name: 'Glob',
  description: DESCRIPTION,
  searchHint: 'find files by name pattern glob',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('Glob pattern matched against paths relative to the search root, e.g. "**/*.ts".'),
    path: z.string().min(1).optional().describe('Directory to search in. Defaults to the working directory.'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  // A pattern like "**/*" in a large repo can return tens of thousands of
  // paths; without a cap that lands whole in the transcript.
  maxResultSizeChars: 30_000,
  userFacingName: () => 'Search',
  getToolUseSummary(input) {
    if (typeof input !== 'object' || input === null) return null
    const { pattern, path: searchPath } = input as { pattern?: unknown; path?: unknown }
    if (typeof pattern !== 'string') return null
    if (typeof searchPath === 'string' && searchPath.trim()) {
      return `pattern: "${truncateMiddle(pattern, 80)}", path: "${truncateMiddle(searchPath.trim(), 60)}"`
    }
    return `pattern: "${truncateMiddle(pattern, 100)}"`
  },
  getActivityDescription(input) {
    if (typeof input !== 'object' || input === null) return 'Searching files'
    const pattern = (input as { pattern?: unknown }).pattern
    return typeof pattern === 'string' ? `Searching ${truncateMiddle(pattern, 60)}` : 'Searching files'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const options = input as GlobInput
    const cwd = options.path ? resolveToolPath(context, options.path) : context.cwd
    const pattern = options.pattern.replace(/^(\.\/)+/, '')
    // Only the pattern's static prefix is walked, so `src/*.ts` stays cheap even from the home directory.
    const base = picomatch.scan(pattern).base
    const matches = base && !existsSync(path.resolve(cwd, base))
      ? { kept: [] as string[], total: 0 }
      : await collectMatches(cwd, pattern, base, context.abortSignal)
    const count = matches.total
    const shown = matches.kept.join('\n')
    const notice = count > MAX_RESULTS ? `\n\n[Showing ${MAX_RESULTS} of ${count} files; narrow the pattern or path.]` : ''
    return {
      ok: true,
      content: shown ? shown + notice : 'No files found.',
      metadata: {
        display: {
          summary: count === 0
            ? 'No files found'
            : `Found ${count} ${count === 1 ? 'file' : 'files'}`,
        },
      },
    }
  },
}

/** `.gitignore` is ripgrep's job; without it, at least these never come back. */
const FALLBACK_IGNORE = ['**/node_modules/**', ...VCS_EXCLUSIONS.map((dir) => `**/${dir}/**`)]

function namesDotSegment(pattern: string): boolean {
  return pattern.split('/').some((segment) => segment.startsWith('.') && segment !== '.' && segment !== '..')
}

/**
 * The first `MAX_RESULTS` matches plus how many there really are. Both backends
 * filter as they walk — a pattern is applied before anything is retained, so a
 * capped result never hides a file that matched inside the window — and neither
 * holds the whole listing, which in a home directory is tens of thousands of
 * paths.
 */
async function collectMatches(
  cwd: string,
  pattern: string,
  base: string,
  signal?: AbortSignal,
): Promise<{ kept: string[]; total: number }> {
  const isMatch = picomatch(pattern, { dot: false })
  const fromRipgrep = await listWithRipgrep(cwd, base, namesDotSegment(pattern), isMatch, signal)
  if (fromRipgrep) return fromRipgrep
  return listWithFastGlob(cwd, pattern, isMatch)
}

/**
 * Every file under `base` that ripgrep would search, so `.gitignore`d trees
 * like node_modules stay out exactly as they do for Grep, minus the runtime
 * data a broad walk from the home directory must not list. `null` when rg is
 * not installed.
 */
function listWithRipgrep(
  cwd: string,
  base: string,
  hidden: boolean,
  isMatch: (entry: string) => boolean,
  signal?: AbortSignal,
): Promise<{ kept: string[]; total: number } | null> {
  const args = [
    '--files',
    ...(hidden ? ['--hidden'] : []),
    ...VCS_EXCLUSIONS.flatMap((dir) => ['--glob', `!${dir}`]),
    ...runtimeDataExclusions(cwd).flatMap((rel) => ['--glob', `!${rel}/**`, '--glob', `!**/${rel}/**`]),
    ...(base ? ['--', base] : []),
  ]
  return streamRipgrepLines({
    cwd,
    args,
    keepLimit: MAX_RESULTS,
    timeoutMs: RG_TIMEOUT_MS,
    ...(signal ? { signal } : {}),
    accept: isMatch,
    transform: (line) => line.replace(/\\/g, '/'),
  })
}

/** The no-ripgrep path: fast-glob's stream, filtered and capped the same way. */
function listWithFastGlob(cwd: string, pattern: string, isMatch: (entry: string) => boolean): Promise<{ kept: string[]; total: number }> {
  return new Promise((resolve, reject) => {
    const kept: string[] = []
    let total = 0
    const stream = fg.stream(pattern, {
      cwd,
      dot: false,
      followSymbolicLinks: false,
      ignore: [...FALLBACK_IGNORE, ...runtimeDataExclusions(cwd).flatMap((rel) => [rel, `${rel}/**`])],
    })
    stream.on('data', (entry) => {
      const value = String(entry).replace(/\\/g, '/')
      if (!isMatch(value)) return
      total += 1
      if (kept.length < MAX_RESULTS) kept.push(value)
    })
    stream.on('error', reject)
    stream.on('end', () => resolve({ kept, total }))
  })
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
