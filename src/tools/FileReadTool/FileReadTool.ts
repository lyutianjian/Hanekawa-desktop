import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod/v3'
import type { Tool, ToolContext, ToolResult } from '../../harness/types.js'
import { countTextTokens } from '../../prompts/budget.js'
import { resolveToolPath } from '../../utils/paths.js'
import { readFileAndRemember } from '../fileState.js'
import { configFileView } from '../configFileView.js'
import {
  formatImageCaption,
  IMAGE_FILE_EXTENSIONS,
  orientedDimensions,
  sniffImage,
} from '../imageFile.js'
import { DESCRIPTION } from './prompt.js'

// Block reads of device files that would hang or produce infinite output.
// On Windows these paths don't exist, so the check is a harmless no-op.
const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/zero', '/dev/random', '/dev/urandom', '/dev/full',
  '/dev/stdin', '/dev/tty', '/dev/console',
  '/dev/stdout', '/dev/stderr',
  '/dev/fd/0', '/dev/fd/1', '/dev/fd/2',
])

const DEFAULT_LINE_LIMIT = 2000
const MAX_LINE_CHARS = 2000
/** Below the request-prep spill threshold, so a read never comes back as a spill file the model must read again. */
const MAX_READ_TOKENS = 20_000

function isBlockedDevicePath(filePath: string): boolean {
  if (BLOCKED_DEVICE_PATHS.has(filePath)) return true
  // /proc/self/fd/* and /proc/<pid>/fd/* patterns
  if (filePath.includes('/proc/') && filePath.includes('/fd/')) return true
  return false
}

export const readFileTool: Tool = {
  name: 'Read',
  description: DESCRIPTION,
  searchHint: 'read file contents view',
  inputSchema: z.object({
    filePath: z.string().min(1).describe('Path to the file. Relative paths resolve against the working directory.'),
    offset: z.number().int().min(1).optional().describe('1-based line number to start reading from. Defaults to 1.'),
    limit: z.number().int().min(1).optional().describe('Maximum number of lines to return. Defaults to 2000.'),
  }).strict(),
  riskLevel: 'safe',
  isReadOnly: true,
  isConcurrencySafe: true,
  userFacingName: () => 'Read',
  getToolUseSummary(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? filePath : null
  },
  getActivityDescription(input) {
    const filePath = typeof input === 'object' && input !== null
      ? (input as { filePath?: unknown }).filePath
      : undefined
    return typeof filePath === 'string' ? `Reading ${filePath}` : 'Reading file'
  },
  shouldDisplayResult: () => true,
  async execute(input, context) {
    const { filePath, offset = 1, limit } = input as { filePath: string; offset?: number; limit?: number }
    const absolute = resolveToolPath(context, filePath)

    // Block dangerous device paths
    if (isBlockedDevicePath(absolute)) {
      return {
        ok: false,
        content: `Cannot read '${filePath}': this device file would block or produce infinite output.`,
        errorCode: 'invalid_input',
      }
    }

    // Images branch off before the text machinery (design §7.2): they never
    // enter readFileState, so a later Edit cannot treat binary pixels as read
    // text. Returns undefined when the file is not an image after all — the
    // extension only nominated it — and the text path below runs unchanged.
    const imageResult = await tryReadImage(absolute, filePath, offset, limit, context)
    if (imageResult !== undefined) return imageResult

    // The full file is always remembered, even for a windowed read: Edit
    // matches against the remembered content, so a partial view must not
    // narrow what a later edit can address.
    const raw = await readFileAndRemember(absolute, context)
    const content = configFileView(absolute, context.redactToolOutput?.(raw) ?? raw)
    const totalLines = countLines(content)

    const window = sliceLines(content, offset, limit)
    if (window.lines.length === 0 && totalLines > 0) {
      return {
        ok: false,
        content: `Cannot read '${filePath}' from line ${window.start}: the file has only ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}.`,
        errorCode: 'invalid_input',
      }
    }

    const body = numberLines(window.lines, window.start)
    const truncated = window.start > 1 || window.end < totalLines
    const notice = truncated
      ? `\n\n[Showing lines ${window.start}-${window.end} of ${totalLines}. Use offset/limit to read another range.]`
      : ''

    return {
      ok: true,
      content: body + notice,
      metadata: {
        display: {
          summary: truncated
            ? `Read lines ${window.start}-${window.end} of ${totalLines}`
            : `Read ${totalLines} ${totalLines === 1 ? 'line' : 'lines'}`,
        },
      },
    }
  },
}

/**
 * The image branch of Read (design §7.2). Returns a ToolResult when the file
 * is a raster image (supported or known-but-unsupported), and `undefined` when
 * it is not — a lying extension, an SVG (text semantics), or any non-image
 * bytes fall through to the unchanged text path. A missing file throws ENOENT
 * from the bytes read, exactly like the text path, so the ToolRunner settles
 * the same paired failure.
 *
 * Image content never reaches readFiles/readFileState: an image read is not a
 * "read before edit", and Edit must never match against binary pixels.
 */
async function tryReadImage(
  absolute: string,
  filePath: string,
  offset: number,
  limit: number | undefined,
  context: ToolContext,
): Promise<ToolResult | undefined> {
  if (!IMAGE_FILE_EXTENSIONS.has(path.extname(absolute).toLowerCase())) return undefined

  const bytes = await readFile(absolute)
  const sniffed = sniffImage(bytes)
  if (!sniffed || sniffed.format === 'svg') return undefined

  // Capability first: the most useful error for the model is the one that
  // changes its strategy. Never binary garbage, never Base64.
  if (context.getSupportsImageInput?.() !== true) {
    return {
      ok: false,
      content: `Cannot read '${filePath}' as an image: the current model does not accept image input, and image bytes are not returned as text. Switch to an image-capable model first.`,
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'model-not-capable' },
    }
  }

  const store = context.imageAttachments
  if (!store) {
    return {
      ok: false,
      content: `Cannot read '${filePath}' as an image: no attachment store is available in this context, and image bytes are not returned as text.`,
      errorCode: 'precondition_failed',
      errorDetails: { reason: 'attachment-store-unavailable' },
    }
  }

  if (offset > 1 || limit !== undefined) {
    return {
      ok: false,
      content: `Cannot read '${filePath}' with offset/limit: those parameters address text lines and do not apply to images.`,
      errorCode: 'invalid_input',
      errorDetails: { reason: 'line-range-not-applicable' },
    }
  }

  const imported = await store.importImage(context.sessionId, bytes, path.basename(absolute))
  if (!imported.ok) {
    return {
      ok: false,
      content: `Cannot read '${filePath}': ${imported.message}`,
      errorCode: imported.reason === 'store-write-failed' ? 'execution_failed' : 'invalid_input',
      errorDetails: { reason: imported.reason },
    }
  }

  const { ref, metadata, animated } = imported.value
  const oriented = orientedDimensions(metadata.exifOrientation, metadata.originalWidth, metadata.originalHeight)
  const caption = formatImageCaption(
    {
      name: ref.name,
      animated,
      orientedOriginalWidth: oriented.width,
      orientedOriginalHeight: oriented.height,
      width: ref.width,
      height: ref.height,
      scaleX: oriented.width / ref.width,
      scaleY: oriented.height / ref.height,
    },
    { index: 1, localPath: metadata.localPath },
  )

  return {
    ok: true,
    content: [
      `Read '${filePath}' as an image (${sniffed.format.toUpperCase()}).`,
      caption,
      'The image is attached to this tool result as pixels; no text was extracted from it.',
    ].join('\n'),
    images: [ref],
    metadata: {
      display: {
        summary: `Read image ${ref.name}`,
      },
    },
  }
}

function countLines(content: string): number {
  if (content.length === 0) return 0
  return content.endsWith('\n')
    ? content.slice(0, -1).split('\n').length
    : content.split('\n').length
}

function sliceLines(content: string, offset: number, limit = DEFAULT_LINE_LIMIT): { lines: string[]; start: number; end: number } {
  const all = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n')
  if (content.length === 0) return { lines: [], start: 1, end: 0 }
  const start = Math.max(1, offset)
  const lines: string[] = []
  let tokens = 0
  for (const raw of all.slice(start - 1, start - 1 + limit)) {
    const line = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)}... [line truncated]` : raw
    tokens += countTextTokens(line) + 3
    if (tokens > MAX_READ_TOKENS && lines.length > 0) break
    lines.push(line)
  }
  return { lines, start, end: start + lines.length - 1 }
}

const LINE_NUMBER_WIDTH = 6

function numberLines(lines: string[], start: number): string {
  return lines
    .map((line, index) => `${String(start + index).padStart(LINE_NUMBER_WIDTH, ' ')}\t${line}`)
    .join('\n')
}
