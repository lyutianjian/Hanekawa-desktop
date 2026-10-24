import { z } from 'zod/v3'
import type { Tool } from '../../harness/types.js'
import { resolveToolPath } from '../../utils/paths.js'
import { getReadFileContent, rememberReadFile, requireFreshRead, resolveTextFileMeta } from '../fileState.js'
import { assertTargetUnchanged, resolveSafeTarget } from '../pathSafety.js'
import { findStringMatches, multipleMatchFailure, noMatchFailure, replaceLiteralMatch, preserveQuoteStyle } from '../FileEditTool/FileEditTool.js'
import { patchDetail } from '../editPatch.js'
import { readTextFile, writeTextFile } from '../textFile.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { DESCRIPTION } from './prompt.js'

interface MultiEditItem {
  oldString: string
  newString: string
  replaceAll?: boolean
}

export const multiEditTool: Tool = {
  name: 'MultiEdit',
  description: DESCRIPTION,
  searchHint: 'multiple edits batch changes',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory.'),
    edits: z.array(z.object({
      oldString: z.string().min(1).describe('Exact text to replace. Use \\n for line breaks; never include Read\'s line-number prefixes.'),
      newString: z.string().describe('Replacement text. Empty string deletes the matched text.'),
      replaceAll: z.boolean().optional().describe('Replace every occurrence of this edit\'s oldString instead of requiring exactly one match.'),
    }).strict()).min(1).describe('Edits applied to the original content. Ranges must not overlap.'),
  }).strict(),
  riskLevel: 'confirm',
  userFacingName: () => 'MultiEdit',
  shouldDisplayResult: () => true,
  getToolUseSummary(input) {
    const parsed = typeof input === 'object' && input !== null
      ? input as { filePath?: unknown; edits?: unknown }
      : undefined
    const filePath = typeof parsed?.filePath === 'string' ? parsed.filePath : undefined
    const editCount = Array.isArray(parsed?.edits) ? parsed.edits.length : undefined
    if (!filePath) return null
    return editCount === undefined ? filePath : `${filePath}, ${editCount} edits`
  },
  getActivityDescription(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? `Editing ${filePath}` : 'Editing file'
  },
  async execute(input, context) {
    const { filePath, edits } = input as { filePath: string; edits: MultiEditItem[] }
    const absolute = resolveToolPath(context, filePath)
    if (absolute.toLowerCase().endsWith('.ipynb')) {
      return {
        ok: false,
        content: `Cannot edit .ipynb files with the MultiEdit tool. Use the NotebookEdit tool to modify notebook cells.`,
        errorCode: 'invalid_input',
      }
    }
    const stale = await requireFreshRead(absolute, filePath, context)
    if (stale) {
      return stale
    }
    // Resolve the real target before reading content to prevent TOCTOU: an
    // attacker could swap the file with a symlink between read and write.
    const safe = await resolveSafeTarget(absolute, filePath, { approvedTarget: context.approvedWriteTarget })
    if ('error' in safe) {
      return safe.error
    }
    const { target } = safe

    const originalContent = getReadFileContent(absolute, context) ?? (await readTextFile(absolute)).content
    // Validate all edits against the original content and find match positions
    const resolved: Array<{ oldString: string; newString: string; index: number; start: number; end: number }> = []
    for (const [index, edit] of edits.entries()) {
      const label = `edits[${index}].oldString`
      if (edit.oldString.length === 0) {
        return { ok: false, content: `Refusing to edit: ${label} must not be empty.`, errorCode: 'precondition_failed' }
      }

      const matches = findStringMatches(originalContent, edit.oldString)
      if (matches.length === 0) {
        return noMatchFailure(originalContent, edit.oldString, label)
      }
      if (matches.length > 1 && !edit.replaceAll) {
        return multipleMatchFailure(edit.oldString, matches, label)
      }
      for (const match of matches) {
        // When matched via quote normalization, preserve the file's quote style in newString
        const actualOld = originalContent.substring(match.index, match.index + edit.oldString.length)
        const effectiveNewString = match.matchedViaNormalization
          ? preserveQuoteStyle(edit.oldString, actualOld, edit.newString)
          : edit.newString
        resolved.push({ oldString: edit.oldString, newString: effectiveNewString, index, start: match.index, end: match.index + edit.oldString.length })
      }
    }

    // Check for overlapping edit ranges
    for (let i = 0; i < resolved.length; i++) {
      for (let j = i + 1; j < resolved.length; j++) {
        const a = resolved[i]!
        const b = resolved[j]!
        if (a.start < b.end && b.start < a.end) {
          return {
            ok: false,
            content: `Overlapping edits: edits[${a.index}] (${a.start}..${a.end}) overlaps with edits[${b.index}] (${b.start}..${b.end}). Each character can only be edited once.`,
            errorCode: 'precondition_failed',
          }
        }
      }
    }

    // Apply edits from bottom to top so earlier positions remain valid
    resolved.sort((a, b) => b.start - a.start)
    let nextContent = originalContent
    for (const edit of resolved) {
      nextContent = replaceLiteralMatch(nextContent, edit.oldString, edit.newString, edit.start)
    }

    const meta = await resolveTextFileMeta(absolute, context)
    await trackFileEdit(context, absolute)
    const changed = await assertTargetUnchanged(target, filePath)
    if (changed) {
      return changed
    }
    await writeTextFile(target.canonical, nextContent, meta)
    await rememberReadFile(absolute, nextContent, context, meta)
    return {
      ok: true,
      content: `Applied ${edits.length} edits to ${filePath}`,
      metadata: {
        display: {
          summary: `Applied ${edits.length} edit${edits.length === 1 ? '' : 's'} to ${filePath}`,
          ...patchDetail(absolute, originalContent, nextContent),
        },
      },
    }
  },
}
