/**
 * The search family's result list (T15, design §6.2 检索): what a `Grep` or
 * `Glob` result's `content` parses into, so the view can group it by file and
 * make every path a jump into the editor.
 *
 * The two tools print plain text — `Grep` one `path:line:match` row per hit
 * (ripgrep's own format; the Node fallback adds a space after the second
 * colon), `Glob` one path per line — and that text is the only structured data
 * the records carry. Parsing it here, in `model/`, keeps the DOM half dumb and
 * the rules testable as pure functions, the same split `ansi.ts` made for the
 * shell family.
 *
 * **Strict on purpose.** A payload is a search result only when *every*
 * non-empty line is a row (or the tool's own pagination notice) — anything
 * else is an error string, a `No matches found.`, or a multiline `rg -U` match
 * with its `--` separators, and the answer is `undefined`: the step then falls
 * back to the plain body (§6.2 兜底), which shows the text without lying about
 * what it is. A family that half-parsed its input would group an error message
 * under a path nobody clicked.
 *
 * DOM-free like every `model/` module — the base tsconfig program has no DOM
 * lib and `test/` imports this directly.
 */

/** One matched line, at its own place in the file. */
export interface SearchMatch {
  /** 1-based, the number the tool printed — and the line a click jumps to. */
  readonly line: number
  /** The matched line's own text, exactly as the tool printed it. */
  readonly text: string
}

/**
 * One file's worth of hits, in first-seen order. A `Glob` file carries no
 * matches — the path itself is the result.
 */
export interface SearchFile {
  /** Relative to the session's cwd — the exact string the tool printed. */
  readonly path: string
  readonly matches: readonly SearchMatch[]
}

export interface SearchResults {
  /** The family member the list came from; the head's counts depend on it. */
  readonly tool: 'Grep' | 'Glob'
  readonly files: readonly SearchFile[]
  /**
   * Grep: hit rows across every file, the `N` of `N 处`. Glob: the file count,
   * because a file *is* a hit there.
   */
  readonly matchCount: number
  /**
   * The tool's own truncation notice (`[Showing results 1..250 of 812 total
   * matches]`), when it paginated its output. Shown as the list's footnote — a
   * truncated list that looks complete is a lie about coverage.
   */
  readonly truncatedNote?: string
}

/** The notice `paginateResult` appends after a blank line. */
const NOTICE = /^\[Showing results .*\]$/

/**
 * `path:line:match`, anchored on the **first** `:<digits>:` so a colon inside
 * the match text (`http://x:8080`) stays in the text: ripgrep prints
 * `src/a.ts:10:see http://x:8080 done`, and the first `:10:` is the only one
 * that can be the separator because the path cannot contain a line number's
 * colon-digits-colon shape by accident twice.
 */
const GREP_ROW = /^(.+?):(\d+):(.*)$/

/**
 * Parses a search tool's `content` into the grouped list, or `undefined` when
 * the payload is not a parseable search result (§6.2 兜底 then draws it).
 *
 * A *failed* step is the caller's to exclude before asking: a Grep error
 * string fails the row pattern on its own, but any short text is a plausible
 * Glob path, so the failure gate has to live one level up where the step's
 * status is known.
 */
export function parseSearchResults(
  toolName: string,
  content: string | undefined,
): SearchResults | undefined {
  if (content === undefined || content.length === 0) return undefined
  if (toolName === 'Grep') return parseGrep(content)
  if (toolName === 'Glob') return parseGlob(content)
  return undefined
}

function parseGrep(content: string): SearchResults | undefined {
  const groups = new Map<string, SearchMatch[]>()
  let truncatedNote: string | undefined
  let sawRow = false

  for (const raw of content.split('\n')) {
    const line = raw.trimEnd()
    if (line.length === 0) continue // the blank line before the notice
    if (NOTICE.test(line)) {
      truncatedNote = line
      continue
    }
    const match = GREP_ROW.exec(line)
    if (match === null) return undefined
    sawRow = true
    // The matched line's own text, exactly as the tool printed it — leading
    // indentation included. The Node fallback prints one separator space more
    // than ripgrep does (`: ${line}` vs `:${line}`); it cannot be told apart
    // per-row and one ragged space in a no-rg install is cheaper than eating a
    // real indent space on the ripgrep path.
    const hit: SearchMatch = { line: Number(match[2]!), text: match[3]! }
    const hits = groups.get(match[1]!)
    if (hits === undefined) groups.set(match[1]!, [hit])
    else hits.push(hit)
  }

  if (!sawRow) return undefined // `No matches found.` — nothing to group
  const files = [...groups.entries()].map(([path, matches]) => ({ path, matches }))
  return {
    tool: 'Grep',
    files,
    matchCount: files.reduce((count, file) => count + file.matches.length, 0),
    ...(truncatedNote === undefined ? {} : { truncatedNote }),
  }
}

function parseGlob(content: string): SearchResults | undefined {
  const trimmed = content.trim()
  if (trimmed === 'No files found.') return undefined
  const paths: string[] = []
  const notice = /\n\n(\[Showing \d+ of \d+ files; narrow the pattern or path\.\])\s*$/.exec(content)
  const body = notice ? content.slice(0, notice.index) : content
  for (const raw of body.split('\n')) {
    const line = raw.trim()
    if (line.length === 0) continue
    paths.push(line)
  }
  if (paths.length === 0) return undefined
  return { tool: 'Glob', files: paths.map((path) => ({ path, matches: [] })), matchCount: paths.length, ...(notice ? { truncatedNote: notice[1] } : {}) }
}

/**
 * The head's own note (§6.2): `8 处 / 3 文件` for a Grep, `14 个文件` for a
 * Glob — the counts are the parsed list's own, so the head and the body can
 * never disagree.
 */
export function searchStats(results: SearchResults): string {
  return results.tool === 'Grep'
    ? `${results.matchCount} 处 / ${results.files.length} 文件`
    : `${results.files.length} 个文件`
}
