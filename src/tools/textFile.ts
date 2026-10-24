import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

export type LineEndings = 'CRLF' | 'LF'

export interface TextFileRead {
  /** Always LF-normalized and without a leading BOM. This is what string matching runs against. */
  content: string
  encoding: BufferEncoding
  /** A byte-order mark was present and is restored on write. Independent of `encoding`. */
  bom: boolean
  lineEndings: LineEndings
}

export interface TextFileWriteMeta {
  encoding: BufferEncoding
  bom: boolean
  lineEndings: LineEndings
}

/**
 * Line endings are detected from the head of the file, before normalization
 * erases the distinction. 4096 characters is enough to classify a file without
 * scanning megabytes of it.
 */
const LINE_ENDING_SAMPLE_CHARS = 4096

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])

export function detectLineEndings(sample: string): LineEndings {
  let crlf = 0
  let lf = 0
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] !== '\n') continue
    if (i > 0 && sample[i - 1] === '\r') crlf++
    else lf++
  }
  return crlf > lf ? 'CRLF' : 'LF'
}

export function normalizeToLf(raw: string): string {
  return raw.replaceAll('\r\n', '\n')
}

export function applyLineEndings(content: string, endings: LineEndings): string {
  if (endings !== 'CRLF') return content
  // Normalize first: a newString that already carries \r\n (raw model output)
  // would otherwise become \r\r\n after the join.
  return normalizeToLf(content).split('\n').join('\r\n')
}

/**
 * Read a text file, returning LF-normalized, BOM-free content plus the metadata
 * needed to write it back unchanged. Every string-matching tool reads through
 * this, so a CRLF file and an LF file look identical to `oldString` matching —
 * the model emits `\n` and cannot be expected to emit `\r\n`.
 *
 * Uses a single file handle so a caller that also needs stat gets it without a
 * second open (see `fileState.readFileAndRemember`).
 */
export async function readTextFile(absolute: string): Promise<TextFileRead> {
  const fh = await fs.open(absolute, 'r')
  try {
    return await readTextFromHandle(fh)
  } finally {
    await fh.close()
  }
}

type FileHandleLike = {
  readFile(options: { encoding: BufferEncoding }): Promise<string>
  readFile(): Promise<Buffer>
}

export async function readTextFromHandle(fh: FileHandleLike): Promise<TextFileRead> {
  return decodeTextBuffer(await fh.readFile())
}

/** Decode an already-read buffer with the same rules as `readTextFile`. */
export function decodeTextBuffer(raw: Buffer): TextFileRead {
  const utf16 = raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xfe
  const utf8Bom = !utf16 && raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
  const encoding: BufferEncoding = utf16 ? 'utf16le' : 'utf8'
  // Only the leading mark is an encoding signal; a U+FEFF elsewhere in the
  // text is the file's own content and must survive.
  const decoded = (utf16 ? raw.subarray(2) : utf8Bom ? raw.subarray(3) : raw).toString(encoding)
  return {
    content: normalizeToLf(decoded),
    encoding,
    bom: utf16 || utf8Bom,
    lineEndings: detectLineEndings(decoded.slice(0, LINE_ENDING_SAMPLE_CHARS)),
  }
}

/**
 * Write LF content back in the file's original encoding, BOM and line-ending
 * style, atomically: a temp file in the same directory is renamed over the
 * target. A crash never leaves a half-written file, a signal cannot catch the
 * write midway, and the rename does not follow a symlink that appeared at the
 * target.
 */
export async function writeTextFile(
  absolute: string,
  content: string,
  meta: TextFileWriteMeta,
): Promise<void> {
  await writeAtomically(absolute, encodeText(applyLineEndings(content, meta.lineEndings), meta))
}

function encodeText(text: string, meta: TextFileWriteMeta): Buffer {
  if (meta.encoding === 'utf16le') {
    return Buffer.from(meta.bom ? `\uFEFF${text}` : text, 'utf16le')
  }
  const body = Buffer.from(text, 'utf8')
  return meta.bom ? Buffer.concat([UTF8_BOM, body]) : body
}

/**
 * Temp file plus rename. An overwrite keeps the file's exact mode (`chmod`
 * after creation, because the create mode is masked by umask); a new file keeps
 * the umask default. Any failure removes this call's temp file and leaves the
 * target untouched.
 */
async function writeAtomically(absolute: string, data: Buffer): Promise<void> {
  const mode = await existingMode(absolute)
  const tmpPath = `${absolute}.tmp.${randomUUID()}`
  let created = false
  try {
    const handle = await fs.open(tmpPath, 'wx', mode ?? 0o666)
    created = true
    try {
      await handle.writeFile(data)
      if (mode !== undefined) await handle.chmod(mode)
    } finally {
      await handle.close()
    }
    await fs.rename(tmpPath, absolute)
    created = false
  } finally {
    if (created) await fs.unlink(tmpPath).catch(() => {})
  }
}

async function existingMode(absolute: string): Promise<number | undefined> {
  try {
    const fileStat = await fs.stat(absolute)
    return fileStat.mode & 0o777
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
