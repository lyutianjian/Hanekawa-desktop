import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import fg from 'fast-glob'
import picomatch from 'picomatch'
import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { resolveToolPath } from '../../utils/paths.js'
import { RG_TIMEOUT_MS, VCS_EXCLUSIONS } from '../GrepTool/constants.js'
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
    const isMatch = picomatch(pattern, { dot: false })
    // Only the pattern's static prefix is walked, so `src/*.ts` stays cheap even from the home directory.
    const base = picomatch.scan(pattern).base
    const entries = base && !existsSync(path.resolve(cwd, base))
      ? []
      : ((await listWithRipgrep(cwd, base, namesDotSegment(pattern))) ?? await fg(pattern, { cwd, dot: false, ignore: FALLBACK_IGNORE }))
        .filter((entry) => isMatch(entry))
    const count = entries.length
    const shown = entries.slice(0, MAX_RESULTS).join('\n')
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
 * Every file under `base` that ripgrep would search, so `.gitignore`d trees
 * like node_modules stay out exactly as they do for Grep. Paths come back
 * relative to `cwd` (absolute when `base` is). `null` when rg is not installed.
 */
function listWithRipgrep(cwd: string, base: string, hidden: boolean): Promise<string[] | null> {
  const args = ['--files', ...(hidden ? ['--hidden'] : []), ...VCS_EXCLUSIONS.flatMap((dir) => ['--glob', `!${dir}`]), ...(base ? ['--', base] : [])]
  return new Promise((resolve, reject) => {
    execFile('rg', args, { cwd, timeout: RG_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const code = (err as { code?: unknown } | null)?.code
      if (code === 'ENOENT') return resolve(null)
      // exit 1 means no files at all.
      if (err && code !== 1) return reject(new Error(`ripgrep failed: ${String(stderr).trim() || err.message}`))
      resolve(stdout.split('\n').filter(Boolean).map((line) => line.replace(/\\/g, '/')))
    })
  })
}

function truncateMiddle(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  const keep = Math.max(1, Math.floor((maxLength - 3) / 2))
  return `${value.slice(0, keep)}...${value.slice(value.length - keep)}`
}
