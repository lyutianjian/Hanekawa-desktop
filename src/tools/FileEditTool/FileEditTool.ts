import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../../harness/types.js'
import { resolveToolPath } from '../../utils/paths.js'
import { patchDetail } from '../editPatch.js'
import { getReadFileContent, rememberReadFile, requireFreshRead, resolveTextFileMeta } from '../fileState.js'
import { assertParentNotSymlink, assertFileNotSymlink } from '../pathSafety.js'
import { readTextFile, writeTextFile } from '../textFile.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { DESCRIPTION } from './prompt.js'

export const editFileTool: Tool = {
  name: 'Edit',
  description: DESCRIPTION,
  searchHint: 'modify change file content',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory.'),
    oldString: z.string().min(1).describe('Exact text to replace, including indentation. Use \\n for line breaks; never include Read\'s line-number prefixes.'),
    newString: z.string().describe('Replacement text. Empty string deletes the matched text.'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one match. Defaults to false.'),
  }).strict(),
  riskLevel: 'confirm',
  userFacingName: () => 'Edit',
  getToolUseSummary: filePathSummary,
  shouldDisplayResult: () => true,
  getActivityDescription(input) {
    const filePath = filePathSummary(input)
    return filePath ? `Editing ${filePath}` : 'Editing file'
  },
  async execute(input, context) {
    const { filePath, oldString, newString, replaceAll = false } = input as {
      filePath: string
      oldString: string
      newString: string
      replaceAll?: boolean
    }
    const absolute = resolveToolPath(context, filePath)
    if (absolute.toLowerCase().endsWith('.ipynb')) {
      return {
        ok: false,
        content: `Cannot edit .ipynb files with the Edit tool. Use the NotebookEdit tool to modify notebook cells.`,
        errorCode: 'invalid_input',
      }
    }
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }
    if (oldString.length === 0) {
      return { ok: false, content: 'Refusing to edit: oldString must not be empty.', errorCode: 'precondition_failed' }
    }
    // Symlink checks BEFORE reading content to prevent TOCTOU: an attacker
    // could swap the file with a symlink between read and write.
    const unsafeParent = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParent) {
      return unsafeParent
    }
    const unsafeFile = await assertFileNotSymlink(absolute, filePath)
    if (unsafeFile) {
      return unsafeFile
    }
    const original = getReadFileContent(absolute, context) ?? (await readTextFile(absolute)).content
    const matches = findStringMatches(original, oldString)
    if (matches.length === 0) {
      return noMatchFailure(original, oldString)
    }
    if (matches.length > 1 && !replaceAll) {
      return multipleMatchFailure(oldString, matches)
    }

    // When matched via quote normalization, preserve the file's quote style in newString
    let nextContent = original
    // Bottom-to-top so each earlier index stays valid after the splice.
    for (const match of [...matches].reverse()) {
      const actualOld = original.substring(match.index, match.index + oldString.length)
      const effectiveNewString = match.matchedViaNormalization
        ? preserveQuoteStyle(oldString, actualOld, newString)
        : newString
      nextContent = replaceLiteralMatch(nextContent, oldString, effectiveNewString, match.index)
    }

    const { encoding, lineEndings } = await resolveTextFileMeta(absolute, context)
    await trackFileEdit(context, absolute)
    await writeTextFile(absolute, nextContent, encoding, lineEndings)
    await rememberReadFile(absolute, nextContent, context, { encoding, lineEndings })
    const label = matches.length > 1
      ? `Edited ${filePath} (${matches.length} occurrences)`
      : `Edited ${filePath}`
    return {
      ok: true,
      content: label,
      metadata: {
        display: {
          summary: label,
          ...patchDetail(absolute, original, nextContent),
        },
      },
    }
  },
}

function filePathSummary(input: unknown): string | null {
  const filePath = typeof input === 'object' && input !== null
    ? (input as { filePath?: unknown }).filePath
    : undefined
  return typeof filePath === 'string' ? filePath : null
}

export function replaceLiteralMatch(content: string, oldString: string, newString: string, index: number): string {
  return content.slice(0, index) + newString + content.slice(index + oldString.length)
}

// --- Quote normalization for fuzzy matching ---

const LEFT_SINGLE = '‘'   // '
const RIGHT_SINGLE = '’'  // '
const LEFT_DOUBLE = '“'   // "
const RIGHT_DOUBLE = '”'  // "

export function normalizeQuotes(s: string): string {
  return s
    .replaceAll(LEFT_SINGLE, "'")
    .replaceAll(RIGHT_SINGLE, "'")
    .replaceAll(LEFT_DOUBLE, '"')
    .replaceAll(RIGHT_DOUBLE, '"')
}

/**
 * Try to find `searchString` in `fileContent`. Returns the actual substring
 * from the file if found (exact match first, then quote-normalized fallback),
 * or null if not found at all.
 */
export function findActualString(fileContent: string, searchString: string): string | null {
  if (fileContent.includes(searchString)) {
    return searchString
  }
  const normalizedSearch = normalizeQuotes(searchString)
  const normalizedFile = normalizeQuotes(fileContent)
  const idx = normalizedFile.indexOf(normalizedSearch)
  if (idx !== -1) {
    return fileContent.substring(idx, idx + searchString.length)
  }
  return null
}

function isOpeningContext(chars: string[], index: number): boolean {
  if (index === 0) return true
  const prev = chars[index - 1]
  return prev === ' ' || prev === '\t' || prev === '\n' || prev === '\r' ||
    prev === '(' || prev === '[' || prev === '{' || prev === '—' || prev === '–'
}

function applyCurlyDoubleQuotes(s: string): string {
  const chars = [...s]
  let open = true
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '"') {
      chars[i] = open ? LEFT_DOUBLE : RIGHT_DOUBLE
      open = !open
    }
  }
  return chars.join('')
}

function applyCurlySingleQuotes(s: string): string {
  const chars = [...s]
  let open = true
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === "'") {
      // Apostrophe between two letters → right single (contraction like don't)
      const prev = i > 0 ? chars[i - 1] : ''
      const next = i < chars.length - 1 ? chars[i + 1] : ''
      const isContraction = /\p{L}/u.test(prev) && /\p{L}/u.test(next)
      chars[i] = isContraction ? RIGHT_SINGLE : (isOpeningContext(chars, i) ? LEFT_SINGLE : RIGHT_SINGLE)
      if (!isContraction) open = !open
    }
  }
  return chars.join('')
}

/**
 * When oldString was matched via quote normalization, convert straight quotes
 * in newString back to the curly style found in the file.
 */
export function preserveQuoteStyle(oldString: string, actualOldString: string, newString: string): string {
  if (oldString === actualOldString) return newString
  const hasDouble = actualOldString.includes(LEFT_DOUBLE) || actualOldString.includes(RIGHT_DOUBLE)
  const hasSingle = actualOldString.includes(LEFT_SINGLE) || actualOldString.includes(RIGHT_SINGLE)
  if (!hasDouble && !hasSingle) return newString
  let result = newString
  if (hasDouble) result = applyCurlyDoubleQuotes(result)
  if (hasSingle) result = applyCurlySingleQuotes(result)
  return result
}

// --- Match context ---

export interface StringMatchContext {
  index: number
  line: number
  column: number
  context: string
  matchedViaNormalization?: boolean
}

export function findStringMatches(content: string, search: string): StringMatchContext[] {
  if (search.length === 0) {
    return []
  }

  // Try exact match first (fast path)
  const matches: StringMatchContext[] = []
  let index = content.indexOf(search)
  while (index !== -1) {
    matches.push(matchContext(content, index))
    index = content.indexOf(search, index + search.length)
  }
  if (matches.length > 0) {
    return matches
  }

  // Fallback: quote-normalized match
  // Normalize both sides so curly quotes in the file match straight quotes from the model
  const normalizedSearch = normalizeQuotes(search)
  const normalizedContent = normalizeQuotes(content)
  // If normalization didn't change either string, there are no curly quotes to bridge
  if (normalizedSearch === search && normalizedContent === content) {
    return []
  }
  const normalizedIndex = normalizedContent.indexOf(normalizedSearch)
  if (normalizedIndex === -1) {
    return []
  }
  // Collect all normalized match positions
  const normalizedPositions: number[] = [normalizedIndex]
  let nextPos = normalizedIndex + normalizedSearch.length
  while (true) {
    const found = normalizedContent.indexOf(normalizedSearch, nextPos)
    if (found === -1) break
    normalizedPositions.push(found)
    nextPos = found + normalizedSearch.length
  }
  return normalizedPositions.map(i => ({ ...matchContext(content, i), matchedViaNormalization: true }))
}

export function multipleMatchFailure(oldString: string, matches: StringMatchContext[], label = 'oldString'): ToolResult {
  if (matches.length === 0) {
    return noMatchFailure('', oldString, label)
  }
  return {
    ok: false,
    content: formatMatchFailure(label, matches),
    errorCode: 'precondition_failed',
    errorDetails: {
      oldStringLength: oldString.length,
      occurrences: matches.length,
      matches: matches.slice(0, 5),
      truncated: matches.length > 5,
    },
  }
}

/**
 * A zero-match failure needs different advice than an ambiguous one, and the
 * old shared message ("found 0") gave none. Whitespace is called out because it
 * is the overwhelmingly common cause once line endings are normalized.
 */
export function noMatchFailure(content: string, oldString: string, label = 'oldString'): ToolResult {
  const reason = diagnoseNearMiss(content, oldString)
  const advice = reason
    ? `${reason} Re-read the file and copy the text exactly as it appears.`
    : 'Read the file again and copy the exact text, including indentation. If the text appears more than once, include surrounding lines to make it unique.'
  return {
    ok: false,
    content: `String to replace not found in file (${label}).\n${advice}\n\n${label}:\n${oldString}`,
    errorCode: 'precondition_failed',
    errorDetails: {
      oldStringLength: oldString.length,
      occurrences: 0,
      nearMiss: reason ?? null,
    },
  }
}

/** Explains why an exact match failed when a laxer comparison would have hit. */
function diagnoseNearMiss(content: string, oldString: string): string | null {
  if (!content) return null
  const collapse = (value: string) => value.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/gm, '')
  if (collapse(content).includes(collapse(oldString))) {
    return 'The text is present but the whitespace differs (indentation or trailing spaces).'
  }
  if (content.replace(/\s+/g, '').includes(oldString.replace(/\s+/g, ''))) {
    return 'The text is present but the line breaks or spacing differ.'
  }
  if (/^\s*\d+\t/m.test(oldString)) {
    return "oldString still carries Read's line-number prefixes; those are not part of the file."
  }
  return null
}

function matchContext(content: string, index: number): StringMatchContext {
  const before = content.slice(0, index)
  const line = before.split('\n').length
  const lastLineBreak = before.lastIndexOf('\n')
  const column = index - lastLineBreak

  const lines = content.split('\n')
  const startLine = Math.max(1, line - 2)
  const endLine = Math.min(lines.length, line + 2)
  const width = String(endLine).length
  const snippet = lines
    .slice(startLine - 1, endLine)
    .map((text, offset) => {
      const currentLine = startLine + offset
      const marker = currentLine === line ? '>' : ' '
      return `${marker} ${String(currentLine).padStart(width, ' ')} | ${text}`
    })
    .join('\n')

  return { index, line, column, context: snippet }
}

function formatMatchFailure(label: string, matches: StringMatchContext[]): string {
  const header = [
    `Found ${matches.length} matches for ${label}, but replaceAll is false.`,
    'To change every occurrence set replaceAll: true; to change one, extend',
    `${label} with surrounding lines until it is unique.`,
  ].join(' ')

  const shown = matches.slice(0, 5)
  const sections = shown.map((match, offset) => [
    `Match ${offset + 1} at line ${match.line}, column ${match.column}:`,
    match.context,
  ].join('\n'))
  const truncated = matches.length > shown.length ? `\nShowing first ${shown.length} of ${matches.length} matches.` : ''
  return `${header}\n\n${sections.join('\n\n')}${truncated}`
}
