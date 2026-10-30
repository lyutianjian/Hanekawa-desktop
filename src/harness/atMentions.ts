import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import fg from 'fast-glob'
import type { AtMentionContextRecord, AtMentionFileContext, ToolContext } from './types.js'
import { wrapInSystemReminder } from './systemReminder.js'
import { readFileAndRemember } from '../tools/fileState.js'
import { atMentionPatterns } from '../runtime/suggestions/atToken.js'
import { assertInsideCwd } from '../utils/paths.js'
import { isProtectedPath } from '../utils/permissions/protectedPaths.js'
import type { ImageAttachmentRef, ImageInputErrorReason } from '../media/types.js'
import { formatImageFailure } from '../media/imageErrors.js'
import { IMAGE_FILE_EXTENSIONS } from '../tools/imageFile.js'

export const CODE_TEXT_EXTENSIONS = new Set([
  '.py',
  '.pyi',
  '.c',
  '.cc',
  '.cpp',
  '.cxx',
  '.h',
  '.hh',
  '.hpp',
  '.hxx',
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.java',
  '.kt',
  '.kts',
  '.go',
  '.rs',
  '.cs',
  '.php',
  '.rb',
  '.swift',
  '.scala',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.ps1',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.vue',
  '.svelte',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.xml',
  '.ini',
  '.cfg',
  // Prose and plain-text documents: `@README` must complete like code does.
  '.md',
  '.markdown',
  '.mdx',
  '.txt',
  '.rst',
  '.adoc',
  '.org',
  '.tex',
  '.csv',
  '.tsv',
])

/**
 * Whether a name belongs to the text half of `@` mentions — what completion
 * offers and what an explicit mention attaches. Beyond the code extensions it
 * takes dotfiles (`.env`, `.env.local`) and extensionless documents
 * (`Makefile`); images take their own path.
 */
export function isTextFileName(name: string): boolean {
  if (name.startsWith('.')) return true
  const extension = path.extname(name).toLowerCase()
  return extension === '' || CODE_TEXT_EXTENSIONS.has(extension)
}

const MAX_AT_MENTION_FILES = 5
const MAX_ATTACHMENT_LINES = 2_000
const MAX_ATTACHMENT_BYTES = 80 * 1024
const IGNORED_DIR_NAMES = ['.git', '.hanekawa', 'node_modules', 'build', 'coverage']

/**
 * Raster extensions that make a mention an *image* candidate. Single-sourced
 * from the shared image module (Read nominates the same candidates); the
 * extension only nominates the file — the pipeline sniffs the bytes, so a PNG
 * named `.jpg` imports fine. Known-but-unsupported formats (BMP, HEIC, TIFF,
 * AVIF) are candidates too — they must fail loudly through the import pipeline
 * instead of being dropped as silently as non-code text used to be.
 */
export const IMAGE_MENTION_EXTENSIONS = IMAGE_FILE_EXTENSIONS

/** Per-input image quota: @-mentioned images plus explicit attachments. */
export const MAX_AT_MENTION_IMAGES = 10

export interface ParsedAtMention {
  raw: string
  filePath: string
  lineStart?: number
  lineEnd?: number
}

/** A raw mention plus where it sat in the text, so image order can follow it. */
interface PositionedMention extends ParsedAtMention {
  start: number
}

function collectRawMentions(input: string): PositionedMention[] {
  const results: PositionedMention[] = []
  const seen = new Set<string>()

  const add = (raw: string, start: number) => {
    const parsed = parseAtMentionedFileLines(raw)
    const key = `${parsed.filePath}#${parsed.lineStart ?? ''}-${parsed.lineEnd ?? ''}`
    if (seen.has(key)) return
    seen.add(key)
    results.push({ raw, start, ...parsed })
  }

  let match: RegExpExecArray | null
  // The patterns live in `runtime/suggestions/atToken.ts`, the pure half of `@`
  // handling: the desktop renderer draws a chip for every mention and cannot import
  // this file (it reaches for `node:fs`). Two readers, one definition.
  //
  // Still two passes in this order, and not `extractAtMentions`'s single ordered
  // one: the quoted form is reported first here, and the attachment cap makes that
  // order observable.
  const { quoted, regular } = atMentionPatterns()
  while ((match = quoted.exec(input)) !== null) {
    if (match[2]) add(`${match[2]}${match[3] ?? ''}`, (match.index ?? 0) + (match[1] ?? '').length)
  }

  while ((match = regular.exec(input)) !== null) {
    const raw = match[2]
    if (raw) add(raw, (match.index ?? 0) + (match[1] ?? '').length)
  }

  return results
}

/**
 * Every mention in the input, deduplicated per path-and-range — the
 * syntax-level view with no category or quota applied. Quotas live in
 * `classifyAtMentions`, which is the only place allowed to drop a mention
 * for being over a cap.
 */
export function extractAtMentionedFiles(input: string): ParsedAtMention[] {
  return collectRawMentions(input).map(({ raw, filePath, lineStart, lineEnd }) => ({
    raw,
    filePath,
    ...(lineStart !== undefined ? { lineStart } : {}),
    ...(lineEnd !== undefined ? { lineEnd } : {}),
  }))
}

/**
 * Mentions split by what they attach, each side under its own quota: code text
 * keeps `MAX_AT_MENTION_FILES`, images get the per-input image quota (applied
 * later, when the explicit-attachment count is known). Identifying every
 * mention *before* limiting is what keeps the code-text cap from silently
 * swallowing images that happened to sit past the fifth mention.
 */
export function classifyAtMentions(input: string): {
  codeFiles: ParsedAtMention[]
  images: ParsedAtMention[]
} {
  const codeFiles: ParsedAtMention[] = []
  const images: PositionedMention[] = []
  const seenImagePaths = new Set<string>()

  for (const mention of collectRawMentions(input)) {
    if (IMAGE_MENTION_EXTENSIONS.has(path.extname(mention.filePath).toLowerCase())) {
      // Images dedupe by path alone: a `#L` suffix names the same picture, not
      // a second copy. Order is the text's order, so the attachment list reads
      // the way the user wrote it.
      if (seenImagePaths.has(mention.filePath)) continue
      seenImagePaths.add(mention.filePath)
      images.push(mention)
    } else if (codeFiles.length < MAX_AT_MENTION_FILES) {
      codeFiles.push(mention)
    }
  }

  images.sort((left, right) => left.start - right.start)
  return { codeFiles, images }
}

export function parseAtMentionedFileLines(mention: string): {
  filePath: string
  lineStart?: number
  lineEnd?: number
} {
  const match = mention.match(/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/)
  if (!match) return { filePath: mention }

  const lineStart = match[2] ? Math.max(1, parseInt(match[2], 10)) : undefined
  const lineEnd = match[3] ? Math.max(lineStart ?? 1, parseInt(match[3], 10)) : lineStart
  return {
    filePath: match[1] ?? mention,
    ...(lineStart ? { lineStart } : {}),
    ...(lineEnd ? { lineEnd } : {}),
  }
}

export async function buildAtMentionContextRecord(input: {
  userInput: string
  userMessageId: string
  turnId: string
  toolContext: ToolContext
  createdAt?: string
}): Promise<AtMentionContextRecord | undefined> {
  const attachments: Array<{ file: AtMentionFileContext; content: string }> = []

  // Images never reach this record (design §5.1/§7.1): their refs belong to
  // the user message itself, so the same picture is not attached twice. The
  // code-text cap below therefore counts code mentions only.
  for (const mention of classifyAtMentions(input.userInput).codeFiles) {
    const remaining = MAX_AT_MENTION_FILES - attachments.length
    if (remaining <= 0) break

    const mentionAttachments = await readAtMentionedCodeFiles(mention, input.toolContext, remaining)
    attachments.push(...mentionAttachments)
  }

  if (attachments.length === 0) return undefined

  const innerContent = [
    'User attached files with @-mentions. Treat this as user-provided context for the current task.',
    ...attachments.map(({ file, content: fileContent }) => {
      const truncated = file.truncated ? ' truncated="true"' : ''
      return `<file path="${escapeAttribute(file.displayPath)}" lines="${file.lineStart}-${file.lineEnd}"${truncated}>\n${fileContent}\n</file>`
    }),
  ].join('\n\n')
  const content = wrapInSystemReminder(innerContent)

  return {
    id: `at-mention-${randomUUID()}`,
    type: 'at_mention_context',
    userMessageId: input.userMessageId,
    turnId: input.turnId,
    createdAt: input.createdAt ?? new Date().toISOString(),
    files: attachments.map((attachment) => attachment.file),
    content,
  }
}

async function readAtMentionedCodeFiles(
  mention: ParsedAtMention,
  toolContext: ToolContext,
  limit: number,
): Promise<Array<{ file: AtMentionFileContext; content: string }>> {
  const displayCandidate = mention.filePath
  if (isProtectedPath(displayCandidate)) return []

  let absolute: string
  try {
    absolute = assertInsideCwd(toolContext.cwd, displayCandidate)
  } catch {
    return []
  }

  const displayPath = normalizeDisplayPath(path.relative(toolContext.cwd, absolute))
  if (isProtectedPath(displayPath) || isProtectedPath(absolute)) return []

  let fileStat
  try {
    fileStat = await stat(absolute)
  } catch {
    return []
  }

  if (fileStat.isDirectory()) {
    return readAtMentionedCodeDirectory(absolute, displayPath, toolContext, limit)
  }

  if (!fileStat.isFile()) return []
  if (!isTextFileName(path.basename(absolute))) return []

  const attachment = await readAtMentionedCodeFileAtPath(absolute, displayPath, mention, toolContext)
  return attachment ? [attachment] : []
}

async function readAtMentionedCodeDirectory(
  absoluteDir: string,
  displayPath: string,
  toolContext: ToolContext,
  limit: number,
): Promise<Array<{ file: AtMentionFileContext; content: string }>> {
  const extensions = [...CODE_TEXT_EXTENSIONS].map((ext) => ext.slice(1))
  let matches: string[]
  try {
    matches = await fg(`**/*.{${extensions.join(',')}}`, {
      cwd: absoluteDir,
      onlyFiles: true,
      dot: false,
      ignore: IGNORED_DIR_NAMES.map((dir) => `${dir}/**`),
      unique: true,
    })
  } catch {
    return []
  }

  const candidates = matches
    .map((entry) => normalizeDisplayPath(path.posix.join(displayPath, normalizeDisplayPath(entry))))
    .filter((entry) => !isProtectedPath(entry))
    .sort((a, b) => a.localeCompare(b))

  const attachments: Array<{ file: AtMentionFileContext; content: string }> = []
  for (const candidate of candidates.slice(0, limit)) {
    let absolute: string
    try {
      absolute = assertInsideCwd(toolContext.cwd, candidate)
    } catch {
      continue
    }

    const attachment = await readAtMentionedCodeFileAtPath(
      absolute,
      candidate,
      { raw: candidate, filePath: candidate },
      toolContext,
    )
    if (attachment) attachments.push(attachment)
  }

  return attachments
}

async function readAtMentionedCodeFileAtPath(
  absolute: string,
  displayPath: string,
  mention: ParsedAtMention,
  toolContext: ToolContext,
): Promise<{ file: AtMentionFileContext; content: string } | undefined> {
  let raw: string
  try {
    raw = await readFileAndRemember(absolute, toolContext)
  } catch {
    return undefined
  }

  if (raw.slice(0, 8192).includes('\0')) {
    toolContext.readFiles.delete(absolute)
    toolContext.readFileState?.delete(absolute)
    return undefined
  }

  const totalLines = countLines(raw)
  const requestedStart = mention.lineStart ?? 1
  const requestedEnd = mention.lineEnd ?? totalLines
  const lineStart = clampLine(requestedStart, totalLines)
  const lineEnd = Math.max(lineStart, clampLine(requestedEnd, totalLines))
  const sliced = sliceLines(raw, lineStart, lineEnd)
  const truncated = truncateAttachmentContent(sliced)

  return {
    file: {
      path: absolute,
      displayPath,
      lineStart,
      lineEnd: lineStart + truncated.includedLines - 1,
      truncated: truncated.truncated || lineEnd > lineStart + truncated.includedLines - 1,
    },
    content: truncated.content,
  }
}

function sliceLines(content: string, lineStart: number, lineEnd: number): string {
  const lines = content.split(/\r?\n/)
  return lines.slice(lineStart - 1, lineEnd).join('\n')
}

function truncateAttachmentContent(content: string): { content: string; truncated: boolean; includedLines: number } {
  const lines = content.split(/\r?\n/)
  let truncated = false
  let selected = lines
  if (selected.length > MAX_ATTACHMENT_LINES) {
    selected = selected.slice(0, MAX_ATTACHMENT_LINES)
    truncated = true
  }

  let text = selected.join('\n')
  if (Buffer.byteLength(text, 'utf8') > MAX_ATTACHMENT_BYTES) {
    text = truncateUtf8(text, MAX_ATTACHMENT_BYTES)
    truncated = true
  }

  const includedLines = countLines(text)
  if (truncated) {
    text = `${text}\n\n[... @-mentioned file content truncated ...]`
  }
  return { content: text, truncated, includedLines }
}

function truncateUtf8(content: string, maxBytes: number): string {
  let used = 0
  let result = ''
  for (const char of content) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > maxBytes) break
    used += size
    result += char
  }
  return result
}

function countLines(content: string): number {
  if (content.length === 0) return 1
  return content.endsWith('\n')
    ? content.slice(0, -1).split(/\r?\n/).length
    : content.split(/\r?\n/).length
}

function clampLine(line: number, totalLines: number): number {
  return Math.min(Math.max(1, line), Math.max(1, totalLines))
}

function normalizeDisplayPath(filePath: string): string {
  return filePath.replaceAll(path.sep, '/')
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

// ---------------------------------------------------------------------------
// @-mentioned images (design §7.1)
// ---------------------------------------------------------------------------

/** Why an @-mentioned image could not be attached. Distinguishable by design
 * (§13): the caller reports the reason instead of degrading to plain text. */
export type AtMentionImageErrorReason =
  | ImageInputErrorReason
  | 'store-write-failed'
  /** The image lives outside the project; `@` must not widen model file access. */
  | 'outside-project'
  /** `#L` line ranges are meaningless on a picture. */
  | 'line-range-not-applicable'

export interface AtMentionImageError {
  /** The mention as written, without the leading `@` or quotes. */
  mention: string
  reason: AtMentionImageErrorReason
  message: string
}

/**
 * What the submission path needs to turn image mentions into attachments.
 * Structurally satisfied by `ImageAttachmentService`, so the runtime hands the
 * real store over and tests hand a fake — no second import path.
 */
export interface AtMentionImageImporter {
  importImage(
    ownerSessionId: string,
    bytes: Buffer,
    name: string,
  ): Promise<
    | { ok: true; value: { ref: ImageAttachmentRef } }
    | { ok: false; reason: ImageInputErrorReason | 'store-write-failed'; message: string }
  >
}

export interface AtMentionImageCollection {
  /** Imported refs, in the order the mentions appear in the text. */
  images: ImageAttachmentRef[]
  errors: AtMentionImageError[]
}

/**
 * Reads the input's @-mentioned images and imports each through the session's
 * attachment store, so the turn binds cached copies instead of re-reading the
 * source file later.
 *
 * Every explicit image reference fails loudly (missing file, undecodable
 * bytes, over quota, outside the project, `#L` suffix): the errors come back
 * structured and the caller must block the turn and keep the draft — never
 * quietly fall back to plain text. Silently skipped mentions are only those
 * the code-text path also skips (protected paths), plus directories, which
 * never contribute images (design §7.1: no recursion).
 */
export async function collectAtMentionImages(input: {
  userInput: string
  toolContext: ToolContext
  importer: AtMentionImageImporter
  /** Images the draft already carries; the per-input quota counts them. */
  existingImageCount?: number
  /** Quota override for tests; defaults to {@link MAX_AT_MENTION_IMAGES}. */
  maxImages?: number
}): Promise<AtMentionImageCollection> {
  const maxImages = input.maxImages ?? MAX_AT_MENTION_IMAGES
  const budget = maxImages - (input.existingImageCount ?? 0)
  const images: ImageAttachmentRef[] = []
  const errors: AtMentionImageError[] = []

  for (const mention of classifyAtMentions(input.userInput).images) {
    if (mention.lineStart !== undefined) {
      errors.push({
        mention: mention.raw,
        reason: 'line-range-not-applicable',
        message: 'line ranges (#L…) do not apply to images; send the image without the range.',
      })
      continue
    }

    const displayCandidate = mention.filePath
    if (isProtectedPath(displayCandidate)) continue

    let absolute: string
    try {
      absolute = assertInsideCwd(input.toolContext.cwd, displayCandidate)
    } catch {
      errors.push({
        mention: mention.raw,
        reason: 'outside-project',
        message:
          'this image is outside the project. @ only reaches project files — attach it explicitly (paste, drop, or the attachment picker) instead.',
      })
      continue
    }

    const displayPath = normalizeDisplayPath(path.relative(input.toolContext.cwd, absolute))
    if (isProtectedPath(displayPath) || isProtectedPath(absolute)) continue

    let fileStat
    try {
      fileStat = await stat(absolute)
    } catch {
      errors.push({
        mention: mention.raw,
        reason: 'file-missing',
        message: 'no such file in this project.',
      })
      continue
    }
    if (!fileStat.isFile()) continue

    if (images.length >= budget) {
      errors.push({
        mention: mention.raw,
        reason: 'too-many-images',
        message: `this input already has the maximum of ${maxImages} images (explicit attachments count too); remove some before sending.`,
      })
      continue
    }

    let bytes: Buffer
    try {
      bytes = await readFile(absolute)
    } catch {
      errors.push({
        mention: mention.raw,
        reason: 'file-missing',
        message: 'the file could not be read.',
      })
      continue
    }

    const imported = await input.importer.importImage(
      input.toolContext.sessionId,
      bytes,
      path.basename(absolute),
    )
    if (imported.ok) {
      images.push(imported.value.ref)
    } else {
      errors.push({ mention: mention.raw, reason: imported.reason, message: imported.message })
    }
  }

  return { images, errors }
}

/** The user-facing turn failure for failed image mentions: the message was
 * not sent, the draft is intact, and each reason says what to do. */
export function formatAtMentionImageErrors(errors: readonly AtMentionImageError[]): string {
  return [
    'The message was not sent because @-mentioned images could not be attached:',
    // Each line carries its reason's exit (S24); the two mention-only reasons
    // (outside-project, line-range-not-applicable) already say theirs and are
    // left as they are rather than labelled with a class they do not belong to.
    ...errors.map((error) => `- @${error.mention}: ${formatImageFailure(error.reason, error.message)}`),
    'Fix or remove these mentions, then send again.',
  ].join('\n')
}
