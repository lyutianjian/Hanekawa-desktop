import { readdir } from 'node:fs/promises'
import path from 'node:path'
import Fuse, { type FuseResult } from 'fuse.js'
import { IMAGE_MENTION_EXTENSIONS, isTextFileName } from '../../harness/atMentions.js'
import { assertInsideCwd } from '../../utils/paths.js'
import { isProtectedPath } from '../../utils/permissions/protectedPaths.js'
import { extractAtCompletionToken, type FileSuggestion } from './atToken.js'

/**
 * Finding the candidates — the half that needs a filesystem.
 *
 * The token parsing and the splice back into the composer live in
 * `atToken.js`, which has no Node dependency so the desktop renderer can import
 * it directly. They are re-exported here so every existing caller keeps its
 * import path.
 */
export {
  applyFileSuggestion,
  extractAtCompletionToken,
  type FileSuggestion,
  type FileSuggestionMetadata,
} from './atToken.js'

interface FileSearchItem {
  path: string
  basename: string
  kind: 'directory' | 'file'
}

const MAX_FILE_SUGGESTIONS = 15
const IGNORED_DIR_NAMES = new Set(['.git', '.hanekawa', 'node_modules', 'build', 'coverage'])
const IGNORED_FILE_NAMES = new Set(['.ds_store'])

export async function generateFileSuggestions(
  input: string,
  cursorPos: number,
  cwd: string = process.cwd(),
): Promise<FileSuggestion[]> {
  const token = extractAtCompletionToken(input, cursorPos)
  if (!token) return []
  const query = searchToken(token.token)
  if (query.includes('#')) return []

  const scope = splitSearchScope(query)
  const entries = await loadFileSearchItems(cwd, scope.dirPrefix)
  const matches = scope.leafQuery === ''
    ? entries.slice(0, MAX_FILE_SUGGESTIONS).map((item) => ({ item, score: 0 }))
    : searchFiles(entries, scope.leafQuery)

  const forceQuoted = token.token.startsWith('@"')
  return matches.slice(0, MAX_FILE_SUGGESTIONS).map(({ item }) => createFileSuggestion(item, forceQuoted))
}

function searchToken(token: string): string {
  if (token.startsWith('@"')) return token.slice(2)
  if (token.startsWith('@')) return token.slice(1)
  return token
}

function splitSearchScope(query: string): { dirPrefix: string; leafQuery: string } {
  const normalized = normalizePath(query)
  if (normalized.endsWith('/')) return { dirPrefix: normalized, leafQuery: '' }

  const slashIndex = normalized.lastIndexOf('/')
  if (slashIndex < 0) return { dirPrefix: '', leafQuery: normalized }
  return {
    dirPrefix: normalized.slice(0, slashIndex + 1),
    leafQuery: normalized.slice(slashIndex + 1),
  }
}

function searchFiles(files: FileSearchItem[], query: string): Array<{ item: FileSearchItem; score?: number }> {
  const fuse = new Fuse(files, {
    includeScore: true,
    threshold: 0.35,
    location: 0,
    distance: 40,
    keys: [
      { name: 'basename', weight: 1 },
    ],
  })
  return fuse.search(query, { limit: MAX_FILE_SUGGESTIONS })
    .sort((a: FuseResult<FileSearchItem>, b: FuseResult<FileSearchItem>) => (a.score ?? 0) - (b.score ?? 0))
    .map((result) => ({ item: result.item, score: result.score }))
}

function createFileSuggestion(item: FileSearchItem, forceQuoted: boolean): FileSuggestion {
  const needsQuote = forceQuoted || item.path.includes(' ')
  const replacementText = needsQuote
    ? item.kind === 'directory'
      ? `@"${item.path}`
      : `@"${item.path}"`
    : `@${item.path}`
  return {
    id: `file:${item.kind}:${item.path}`,
    displayText: item.path,
    description: item.kind === 'directory' ? 'directory' : 'file',
    metadata: {
      replacementText,
      path: item.path,
      kind: item.kind,
    },
  }
}

async function loadFileSearchItems(cwd: string, dirPrefix: string): Promise<FileSearchItem[]> {
  if (isProtectedPath(dirPrefix)) return []

  let absoluteDir: string
  try {
    absoluteDir = assertInsideCwd(cwd, dirPrefix || '.')
  } catch {
    return []
  }

  let entries
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true })
  } catch {
    return []
  }

  const directEntries = entries
    .flatMap((entry): FileSearchItem[] => {
      const displayPath = normalizePath(path.posix.join(dirPrefix, entry.name))
      if (entry.isDirectory()) {
        if (IGNORED_DIR_NAMES.has(entry.name) || isProtectedPath(displayPath)) return []
        return [{
          path: `${displayPath}/`,
          basename: entry.name,
          kind: 'directory',
        }]
      }

      if (!entry.isFile()) return []
      if (IGNORED_FILE_NAMES.has(entry.name.toLowerCase())) return []
      if (!isTextFileName(entry.name) && !IMAGE_MENTION_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) return []
      if (isProtectedPath(displayPath)) return []
      return [{
        path: displayPath,
        basename: entry.name,
        kind: 'file',
      }]
    })

  return directEntries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.path.localeCompare(b.path)
  })
}

function normalizePath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/')
}
