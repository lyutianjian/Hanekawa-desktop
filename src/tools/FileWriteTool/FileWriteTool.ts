import { mkdir, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/v3'
import type { Tool, ToolResult } from '../../harness/types.js'
import { resolveToolPath } from '../../utils/paths.js'
import { getReadFileContent, rememberReadFile, requireFreshRead, resolveTextFileMeta } from '../fileState.js'
import { patchDetail } from '../editPatch.js'
import { assertParentNotSymlink, assertFileNotSymlink } from '../pathSafety.js'
import { writeTextFile } from '../textFile.js'
import { trackFileEdit } from '../trackFileEdit.js'
import { DESCRIPTION } from './prompt.js'

export const writeFileTool: Tool = {
  name: 'Write',
  description: DESCRIPTION,
  searchHint: 'create write new file',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory. Parent directories are created as needed.'),
    content: z.string().describe('Full contents of the file. Use \\n for line breaks.'),
  }).strict(),
  riskLevel: 'confirm',
  userFacingName: () => 'Write',
  getToolUseSummary: filePathSummary,
  shouldDisplayResult: () => true,
  getActivityDescription(input) {
    const filePath = filePathSummary(input)
    return filePath ? `Writing ${filePath}` : 'Writing file'
  },
  async execute(input, context) {
    const { filePath, content } = input as { filePath: string; content: string }
    const absolute = resolveToolPath(context, filePath)
    const unsafeParentBeforeRead = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeRead) {
      return unsafeParentBeforeRead
    }
    const conflict = await detectCaseInsensitiveNameConflict(absolute, filePath)
    if (conflict) {
      return conflict
    }
    const exists = await fileExists(absolute)
    if (exists) {
      const stale = await requireFreshRead(absolute, filePath, context)
      if (stale) {
        return stale
      }
    }
    // The read-before-write rule means an overwrite already has the previous
    // text in hand; a new file diffs against nothing. Either way the patch
    // costs no extra filesystem read.
    const previousContent = exists ? getReadFileContent(absolute, context) : ''
    const unsafeParentBeforeMkdir = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeMkdir) {
      return unsafeParentBeforeMkdir
    }
    await mkdir(path.dirname(absolute), { recursive: true })
    const unsafeParentBeforeWrite = await assertParentNotSymlink(absolute, filePath)
    if (unsafeParentBeforeWrite) {
      return unsafeParentBeforeWrite
    }
    const unsafeFile = await assertFileNotSymlink(absolute, filePath)
    if (unsafeFile) {
      return unsafeFile
    }
    // An existing file keeps its on-disk encoding and line endings; a new one
    // is LF/UTF-8. Either way the remembered content stays LF so a later Edit
    // matches a model-supplied string.
    const { encoding, lineEndings } = exists
      ? await resolveTextFileMeta(absolute, context)
      : { encoding: 'utf8' as BufferEncoding, lineEndings: 'LF' as const }
    await trackFileEdit(context, absolute)
    // Atomic write: write to a temp file in the same directory, then rename.
    // This prevents symlink following because writeFile follows symlinks,
    // but rename does not. It also prevents data loss on crash.
    await writeTextFile(absolute, content, encoding, lineEndings, { atomic: true })
    await rememberReadFile(absolute, content, context, { encoding, lineEndings })
    return {
      ok: true,
      content: `Wrote ${filePath}`,
      metadata: {
        display: {
          summary: exists ? `Overwrote ${filePath}` : `Created ${filePath}`,
          ...(previousContent !== undefined ? patchDetail(absolute, previousContent, content) : {}),
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

async function detectCaseInsensitiveNameConflict(absolute: string, filePath: string): Promise<ToolResult | undefined> {
  const parent = path.dirname(absolute)
  const basename = path.basename(absolute)

  let entries: string[]
  try {
    entries = await readdir(parent)
  } catch {
    return undefined
  }

  const foldedBasename = basename.toLowerCase()
  const conflict = entries.find((entry) => entry.toLowerCase() === foldedBasename && entry !== basename)
  if (!conflict) {
    return undefined
  }

  return {
    ok: false,
    content: `Refusing to create ${filePath}: ${conflict} already exists in the same directory with different casing. Read or address that path before retrying.`,
    errorCode: 'precondition_failed',
    errorDetails: {
      requested: basename,
      existing: conflict,
    },
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const fileStat = await stat(filePath)
    return fileStat.isFile()
  } catch {
    return false
  }
}
