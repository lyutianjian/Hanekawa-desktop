import sharp from 'sharp'
import type { Metadata } from 'sharp'
import type { ImageMimeType, ImageInputErrorReason } from '../media/types.js'
import { MAX_IMAGE_SEND_BYTES } from '../media/imageRequestLimits.js'

/**
 * Image decoding, normalization, and the send-version compression ladder
 * (design doc §2.2, §8). One pipeline serves every collector — Desktop
 * paste/drop, TUI clipboard/path capture, `@` mentions, and the `Read` tool —
 * so both frontends send byte-identical send versions for the same input.
 *
 * Layering: this module owns "is this an image, what format, what size, can it
 * decode, what bytes go on the wire". It must not depend on `services/`; the
 * attachment store (S05) and the tool paths (S09/S10) call in with bytes they
 * are allowed to read. Extensions only ever nominate candidates — the format of
 * record is the content sniff plus a successful decode, so a PNG named `.jpg`
 * is a PNG and a text file named `.png` is not an image at all.
 */

/** Local policy thresholds (design doc §8): Hanekawa's own limits, not a
 *  statement about any provider's API ceilings. Decimal bytes. */
export const IMAGE_PROCESS_DEFAULTS = {
  /** Max size of one raw input image. */
  maxInputBytes: 20_000_000,
  /** Max pixels of one decoded frame. Animation counts per frame: only the
   *  first frame is ever decoded. */
  maxDecodedPixels: 40_000_000,
  /** Send versions are scaled down to this long edge; small images are never
   *  enlarged. */
  sendLongEdge: 2_000,
  /** Max size of one send-version file (Base64 of this is ≈ 5,000,000 chars).
   *  Same policy number the request path's final check enforces — see
   *  `media/imageRequestLimits.ts`. */
  maxSendBytes: MAX_IMAGE_SEND_BYTES,
  /** PNG rungs win only under this size; past it JPEG is several times
   *  smaller (a desktop-sized page screenshot about 6x), and every image's
   *  bytes stay in each later request of the session. */
  maxPngSendBytes: 200_000,
} as const

export interface ImageProcessLimits {
  maxInputBytes: number
  maxDecodedPixels: number
  sendLongEdge: number
  maxSendBytes: number
  maxPngSendBytes: number
}

/** Formats the content sniffer can name. `supported` marks the first version's
 *  decode set; the rest are recognized only so their rejection can say what
 *  the file is instead of "not an image". */
export type SniffedImageFormat =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'bmp'
  | 'tiff'
  | 'heic'
  | 'avif'
  | 'svg'

export interface SniffedImage {
  format: SniffedImageFormat
  supported: boolean
}

/**
 * Raster extensions that nominate a file as an image *candidate* (Read tool,
 * `@` mentions). The extension only nominates — the content sniff plus a
 * successful decode decide whether the image branch actually runs, so a PNG
 * named `.jpg` is a PNG and a text file named `.png` stays a text read.
 * Known-but-unsupported formats (BMP, HEIC, TIFF, AVIF) are candidates too:
 * they must fail loudly through the pipeline ("convert it to PNG or JPEG
 * first") instead of coming back as binary garbage. SVG is deliberately
 * absent — it keeps its text semantics wherever it appears.
 */
export const IMAGE_FILE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.heic',
  '.heif',
  '.tif',
  '.tiff',
  '.avif',
])

const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
const AVIF_BRANDS = new Set(['avif', 'avis'])
const SVG_HEAD = /^[\s\uFEFF]*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<svg[>\s]/i

/**
 * Classify bytes by content: magic numbers for the binary formats, a head scan
 * for SVG. Returns `null` when the bytes are not an image at all — callers use
 * that to keep text semantics. SVG is reported explicitly (with
 * `supported: false`) rather than as null: it is an image format that keeps
 * its text semantics instead of entering the image branch, and callers that
 * care can say so.
 */
export function sniffImage(bytes: Buffer): SniffedImage | null {
  const ascii = (start: number, end: number): string =>
    bytes.toString('latin1', start, end)
  if (bytes.length >= 8 && bytes[0]! === 0x89 && ascii(1, 4) === 'PNG') {
    return { format: 'png', supported: true }
  }
  if (bytes.length >= 3 && bytes[0]! === 0xff && bytes[1]! === 0xd8 && bytes[2]! === 0xff) {
    return { format: 'jpeg', supported: true }
  }
  if (bytes.length >= 6 && ascii(0, 4) === 'GIF8') {
    return { format: 'gif', supported: true }
  }
  if (bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return { format: 'webp', supported: true }
  }
  if (bytes.length >= 2 && bytes[0]! === 0x42 && bytes[1]! === 0x4d) {
    return { format: 'bmp', supported: false }
  }
  if (
    bytes.length >= 4 &&
    ((bytes[0]! === 0x49 && bytes[1]! === 0x49 && bytes[2]! === 0x2a && bytes[3]! === 0x00) ||
      (bytes[0]! === 0x4d && bytes[1]! === 0x4d && bytes[2]! === 0x00 && bytes[3]! === 0x2a))
  ) {
    return { format: 'tiff', supported: false }
  }
  if (bytes.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12)
    if (HEIC_BRANDS.has(brand)) return { format: 'heic', supported: false }
    if (AVIF_BRANDS.has(brand)) return { format: 'avif', supported: false }
  }
  if (SVG_HEAD.test(bytes.subarray(0, 1024).toString('utf8'))) {
    return { format: 'svg', supported: false }
  }
  return null
}

/** The failure shapes `processImageBytes` can produce, all named by the shared
 *  reasons in `src/media/types.ts` so UI copy never has to guess. */
export type ImageProcessErrorReason = Extract<
  ImageInputErrorReason,
  'unsupported-format' | 'decode-failed' | 'image-too-large'
>

export type ImageProcessResult =
  | { ok: true; image: ProcessedImage }
  | { ok: false; reason: ImageProcessErrorReason; message: string }

/**
 * The normalized send version plus every fact later layers persist or show:
 * S05 writes the original facts into `ImageAttachmentMetadata`, and the
 * context caption (below) tells the model how supplied pixels map back to the
 * oriented original.
 */
export interface ProcessedImage {
  /** Send-version bytes in {@link mimeType} encoding. */
  bytes: Buffer
  mimeType: ImageMimeType
  /** Send-version dimensions. */
  width: number
  height: number
  /** File name the image arrived under (may lie about the format). */
  name: string
  /** Sniffed format of the original bytes. */
  originalFormat: SniffedImageFormat
  originalMimeType: string
  /** Original dimensions as stored, before EXIF orientation is applied. */
  originalWidth: number
  originalHeight: number
  /** Original dimensions after EXIF orientation — the coordinate space the
   *  scale factors below refer to. */
  orientedOriginalWidth: number
  orientedOriginalHeight: number
  /** EXIF orientation tag (1–8) as stored; the send version has it applied. */
  exifOrientation?: number
  /** True when the source was animated (GIF/WebP with pages > 1) and the send
   *  version is its first frame. */
  animated: boolean
  /** Multiply supplied-image coordinates by these to get oriented-original
   *  coordinates. x and y are independent because rounding can make them
   *  differ; restoring *stored* coordinates additionally needs the orientation
   *  transform, not just these ratios. */
  scaleX: number
  scaleY: number
}

export interface ProcessImageOptions extends Partial<ImageProcessLimits> {
  /** File name the image arrived under; used in error messages and captions. */
  name: string
}

/**
 * Turn raw image bytes into a normalized send version.
 *
 * Normalization applies EXIF orientation, converts to 8-bit sRGB, strips
 * metadata, takes the first frame of animations, and scales down to the long
 * edge without ever enlarging. Encoding then walks a finite ladder —
 * lossless PNG, palette PNG, then JPEG at descending quality and size — and
 * the first step under the byte budget wins (PNG rungs under the tighter
 * `maxPngSendBytes`). Reaching the bottom rung still
 * over budget rejects the image (with a "crop it" hint) rather than degrading
 * it forever. Transparent input that falls through to JPEG is flattened onto
 * an explicit white background, never an accidental black one.
 */
export async function processImageBytes(
  bytes: Buffer,
  options: ProcessImageOptions,
): Promise<ImageProcessResult> {
  const { name, ...limitOverrides } = options
  const limits: ImageProcessLimits = { ...IMAGE_PROCESS_DEFAULTS, ...limitOverrides }

  if (bytes.byteLength > limits.maxInputBytes) {
    return {
      ok: false,
      reason: 'image-too-large',
      message: `${name} is ${bytes.byteLength.toLocaleString('en-US')} bytes; the per-image input limit is ${limits.maxInputBytes.toLocaleString('en-US')} bytes.`,
    }
  }

  const sniffed = sniffImage(bytes)
  if (!sniffed) {
    return {
      ok: false,
      reason: 'decode-failed',
      message: `${name} is not a recognizable image (no PNG/JPEG/WebP/GIF signature).`,
    }
  }
  if (!sniffed.supported) {
    if (sniffed.format === 'svg') {
      return {
        ok: false,
        reason: 'unsupported-format',
        message: `${name} is an SVG; SVG keeps its text semantics and is not sent as an image attachment.`,
      }
    }
    return {
      ok: false,
      reason: 'unsupported-format',
      message: `${name} is a ${sniffed.format.toUpperCase()} image, which is not supported; convert it to PNG or JPEG first.`,
    }
  }

  let meta: Metadata
  try {
    meta = await sharp(bytes).metadata()
  } catch {
    return { ok: false, reason: 'decode-failed', message: `${name} could not be decoded.` }
  }
  const storedWidth = meta.width ?? 0
  const storedHeight = meta.height ?? 0
  if (storedWidth < 1 || storedHeight < 1) {
    return { ok: false, reason: 'decode-failed', message: `${name} has no decodable dimensions.` }
  }
  if (storedWidth * storedHeight > limits.maxDecodedPixels) {
    return {
      ok: false,
      reason: 'image-too-large',
      message: `${name} decodes to ${storedWidth}x${storedHeight} (${(storedWidth * storedHeight).toLocaleString('en-US')} pixels); the per-image decode limit is ${limits.maxDecodedPixels.toLocaleString('en-US')} pixels.`,
    }
  }

  const orientation =
    typeof meta.orientation === 'number' && meta.orientation >= 1 && meta.orientation <= 8
      ? meta.orientation
      : undefined
  const swaps = orientation !== undefined && orientation >= 5
  const orientedWidth = swaps ? storedHeight : storedWidth
  const orientedHeight = swaps ? storedWidth : storedHeight
  const animated = (meta.pages ?? 1) > 1

  let chosen: LadderOutcome | null
  try {
    chosen = await runCompressionLadder(bytes, limits)
  } catch (error) {
    return {
      ok: false,
      reason: 'decode-failed',
      message: `${name} could not be decoded: ${errorMessage(error)}`,
    }
  }
  if (!chosen) {
    return {
      ok: false,
      reason: 'image-too-large',
      message: `${name} still exceeds the ${limits.maxSendBytes.toLocaleString('en-US')}-byte send limit at the lowest readable quality; crop the image before attaching it.`,
    }
  }

  return {
    ok: true,
    image: {
      bytes: chosen.bytes,
      mimeType: chosen.mimeType,
      width: chosen.width,
      height: chosen.height,
      name,
      originalFormat: sniffed.format,
      originalMimeType: `image/${sniffed.format === 'jpeg' ? 'jpeg' : sniffed.format}`,
      originalWidth: storedWidth,
      originalHeight: storedHeight,
      orientedOriginalWidth: orientedWidth,
      orientedOriginalHeight: orientedHeight,
      exifOrientation: orientation,
      animated,
      scaleX: orientedWidth / chosen.width,
      scaleY: orientedHeight / chosen.height,
    },
  }
}

/**
 * The facts the context caption needs. {@link ProcessedImage} satisfies this,
 * and the `Read` tool builds one from a stored attachment's metadata — two
 * sources, one caption shape.
 */
export interface ImageCaptionFacts {
  name: string
  animated: boolean
  orientedOriginalWidth: number
  orientedOriginalHeight: number
  /** Supplied (send-version) dimensions. */
  width: number
  height: number
  scaleX: number
  scaleY: number
}

/**
 * The caption the context builder places beside an image (design doc §8). All
 * numbers come from the actual send version; the ratios are formatted
 * independently because rounding can make x and y differ.
 *
 * `[Image 1: screenshot.png; cached original: <path>; oriented original
 * 3840x2160; supplied image 1920x1080; scale to oriented original: x=2.00,
 * y=2.00.]`
 */
export function formatImageCaption(
  image: ImageCaptionFacts,
  options: { index: number; localPath?: string },
): string {
  const segments = [
    `Image ${options.index}: ${image.name}${image.animated ? ' (first frame of an animated image)' : ''}`,
  ]
  if (options.localPath !== undefined) segments.push(`cached original: ${options.localPath}`)
  segments.push(`oriented original ${image.orientedOriginalWidth}x${image.orientedOriginalHeight}`)
  segments.push(`supplied image ${image.width}x${image.height}`)
  segments.push(`scale to oriented original: x=${image.scaleX.toFixed(2)}, y=${image.scaleY.toFixed(2)}`)
  return `[${segments.join('; ')}.]`
}

// ---------------------------------------------------------------------------
// Orientation coordinate mapping
// ---------------------------------------------------------------------------

/**
 * Each EXIF orientation tag as a sequence of coordinate ops that turn *stored*
 * pixels upright: flip across an axis, or transpose (swap x/y). Self-inverse
 * primitives, so the inverse transform is the reversed sequence — that is the
 * "orientation transform" §8 requires in metadata, which plain scale factors
 * cannot express.
 */
type OrientationOp = 'flipX' | 'flipY' | 'swap'

const ORIENTATION_OPS: Readonly<Record<number, readonly OrientationOp[]>> = {
  1: [],
  2: ['flipX'],
  3: ['flipX', 'flipY'],
  4: ['flipY'],
  5: ['swap'],
  6: ['swap', 'flipX'],
  7: ['swap', 'flipX', 'flipY'],
  8: ['swap', 'flipY'],
}

export interface MappedPoint {
  x: number
  y: number
  /** Dimensions of the image the mapped point lives in. */
  width: number
  height: number
}

function applyOrientationOps(
  ops: readonly OrientationOp[],
  x: number,
  y: number,
  width: number,
  height: number,
): MappedPoint {
  let px = x
  let py = y
  let w = width
  let h = height
  for (const op of ops) {
    if (op === 'flipX') px = w - 1 - px
    else if (op === 'flipY') py = h - 1 - py
    else {
      const swap = px
      px = py
      py = swap
      const swapDim = w
      w = h
      h = swapDim
    }
  }
  return { x: px, y: py, width: w, height: h }
}

/** Map a point in the stored (on-disk) image to the upright, oriented image. */
export function orientedPointFromStored(
  orientation: number | undefined,
  point: { x: number; y: number },
  storedWidth: number,
  storedHeight: number,
): MappedPoint {
  const ops = orientation === undefined ? [] : (ORIENTATION_OPS[orientation] ?? [])
  return applyOrientationOps(ops, point.x, point.y, storedWidth, storedHeight)
}

/** Map a point in the upright image back to the stored file's coordinates.
 *  Undoing the ops in reverse order is exact because every primitive is its
 *  own inverse. */
export function storedPointFromOriented(
  orientation: number | undefined,
  point: { x: number; y: number },
  orientedWidth: number,
  orientedHeight: number,
): MappedPoint {
  const ops = orientation === undefined ? [] : (ORIENTATION_OPS[orientation] ?? [])
  return applyOrientationOps([...ops].reverse(), point.x, point.y, orientedWidth, orientedHeight)
}

/** Dimensions of the upright image for a stored one (axes swap for tags 5–8). */
export function orientedDimensions(
  orientation: number | undefined,
  width: number,
  height: number,
): { width: number; height: number } {
  return orientation !== undefined && orientation >= 5
    ? { width: height, height: width }
    : { width, height }
}

// ---------------------------------------------------------------------------
// Compression ladder
// ---------------------------------------------------------------------------

interface LadderStep {
  kind: 'png' | 'png-palette' | 'jpeg'
  /** JPEG quality; PNG steps ignore this. */
  quality?: number
  /** Step's own long edge, capped by the caller's `sendLongEdge`. Steps that
   *  omit it use the caller's edge. */
  longEdge?: number
}

/**
 * Finite and floor-bounded: PNG keeps screenshots' text and transparency
 * pixel-perfect; palette PNG is the "optimized PNG" rung; only then JPEG, at
 * descending quality and finally descending size. The last step is the
 * lowest readable policy — past it the ladder reports failure instead of
 * degrading further (design doc §8 step 5).
 */
const LADDER: readonly LadderStep[] = [
  { kind: 'png' },
  { kind: 'png-palette' },
  { kind: 'jpeg', quality: 85 },
  { kind: 'jpeg', quality: 70 },
  { kind: 'jpeg', quality: 55 },
  { kind: 'jpeg', quality: 55, longEdge: 1_500 },
  { kind: 'jpeg', quality: 55, longEdge: 1_000 },
]

interface LadderOutcome {
  bytes: Buffer
  mimeType: ImageMimeType
  width: number
  height: number
}

/** White, chosen explicitly: a transparent image flattened for JPEG must never
 *  land on an accidental black background. */
const JPEG_BACKGROUND = { r: 255, g: 255, b: 255 }

/**
 * Walk the ladder and return the first encoding under `maxSendBytes`.
 *
 * The original is decoded once, into a full-size normalized PNG (EXIF applied,
 * sRGB, metadata stripped, scaled to the long edge). Later rungs re-encode
 * that lossless intermediate instead of re-decoding the source, so a
 * worst-case walk costs one full decode plus cheap re-encodes. The
 * intermediate is itself rung 1's output; PNG→PNG re-encoding cannot shift
 * pixels.
 */
async function runCompressionLadder(
  bytes: Buffer,
  limits: ImageProcessLimits,
): Promise<LadderOutcome | null> {
  if (limits.sendLongEdge < 1) {
    throw new Error('sendLongEdge must be at least 1')
  }
  const first = await sharp(bytes)
    .rotate()
    .toColourspace('srgb')
    .resize({
      width: limits.sendLongEdge,
      height: limits.sendLongEdge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .png({ compressionLevel: 9 })
    .toBuffer({ resolveWithObject: true })
  const normalizedBytes = first.data
  const maxPngBytes = Math.min(limits.maxPngSendBytes, limits.maxSendBytes)
  if (first.data.byteLength <= maxPngBytes) {
    return {
      bytes: first.data,
      mimeType: 'image/png',
      width: first.info.width,
      height: first.info.height,
    }
  }

  for (const step of LADDER) {
    if (step.kind === 'png') continue // rung 1, already attempted above
    const edge = step.longEdge === undefined ? limits.sendLongEdge : Math.min(step.longEdge, limits.sendLongEdge)
    let pipeline = sharp(normalizedBytes)
    if (edge < limits.sendLongEdge) {
      pipeline = pipeline.resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    }
    if (step.kind === 'png-palette') {
      pipeline = pipeline.png({ compressionLevel: 9, palette: true })
    } else {
      pipeline = pipeline.flatten({ background: JPEG_BACKGROUND }).jpeg({ quality: step.quality })
    }
    const { data, info } = await pipeline.toBuffer({ resolveWithObject: true })
    if (data.byteLength <= (step.kind === 'jpeg' ? limits.maxSendBytes : maxPngBytes)) {
      return {
        bytes: data,
        mimeType: step.kind === 'jpeg' ? 'image/jpeg' : 'image/png',
        width: info.width,
        height: info.height,
      }
    }
  }
  return null
}

/**
 * Bitmap formats the import pipeline rejects but sharp can decode: the types
 * system clipboards hand out, which the capture side re-encodes as PNG before
 * the pipeline ever sees them (design doc §6.2). BMP is deliberately absent —
 * the prebuilt libvips has no BMP loader, so a BMP clipboard image must be
 * converted by the platform capture tool itself (the Windows PowerShell
 * capture does exactly that) or reported as unsupported.
 */
const CONVERTIBLE_TO_PNG_FORMATS = new Set<SniffedImageFormat>(['tiff', 'avif', 'heic'])

export type ImageConvertErrorReason = Extract<
  ImageProcessErrorReason,
  'unsupported-format' | 'decode-failed'
>

export type ImageConvertResult =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: ImageConvertErrorReason; message: string }

/**
 * Re-encode a decodable-but-rejected bitmap (TIFF, AVIF, HEIC) as PNG.
 *
 * EXIF orientation is applied and colour normalized the same way the pipeline's
 * first ladder rung would, so the converted bytes are indistinguishable from a
 * PNG that arrived as one; sizing and compression stay the pipeline's job —
 * this is a format bridge, not a second processing path.
 */
export async function convertImageBytesToPng(bytes: Buffer, name: string): Promise<ImageConvertResult> {
  const sniffed = sniffImage(bytes)
  if (sniffed === null || !CONVERTIBLE_TO_PNG_FORMATS.has(sniffed.format)) {
    return {
      ok: false,
      reason: 'unsupported-format',
      message: `${name} is ${sniffed === null ? 'not a recognizable image' : `a ${sniffed.format.toUpperCase()} image`}, which cannot be converted to PNG here; copy it as PNG or JPEG instead.`,
    }
  }
  try {
    const png = await sharp(bytes)
      .rotate()
      .toColourspace('srgb')
      .png({ compressionLevel: 9 })
      .toBuffer()
    return { ok: true, bytes: png }
  } catch (error) {
    return {
      ok: false,
      reason: 'decode-failed',
      message: `${name} could not be decoded into PNG: ${errorMessage(error)}`,
    }
  }
}

/**
 * Thumbnails are the only image bytes that ever become a data URL (S05's
 * preview), so they carry their own small byte cap.
 */
export const MAX_THUMBNAIL_BYTES = 200_000

/**
 * Render the attachment store's `thumbnail.png`: a small PNG of the send
 * version, shrunk further until it fits the cap. Never enlarges.
 */
export async function renderThumbnailBytes(bytes: Buffer): Promise<Buffer> {
  let last = bytes
  for (const edge of [256, 128, 64]) {
    const out = await sharp(bytes)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    last = out
    if (out.byteLength <= MAX_THUMBNAIL_BYTES) break
  }
  return last
}

/**
 * The second — and last — tier of bytes that may become a data URL: the
 * fullscreen viewer's copy. A 256px thumbnail is enough for a 64px tile and
 * nothing more, so the desktop's lightbox asks for this instead; the cap is
 * larger than the thumbnail's by the same ratio the sizes are, and it is still
 * a cap, because the renderer receives Base64 over the wire either way.
 */
export const MAX_VIEW_BYTES = 3_000_000

/**
 * Render the fullscreen viewer's PNG: the send version fitted into a screen-
 * sized box, shrunk further until it fits the cap. Never enlarges — a 400px
 * original opens at 400px and the viewer's zoom is what magnifies it.
 *
 * Not cached on disk, unlike `thumbnail.png`: one of these is worth a dozen
 * thumbnails on disk, and it is only ever wanted while a viewer is open.
 */
export async function renderViewBytes(bytes: Buffer): Promise<Buffer> {
  let last = bytes
  for (const edge of [2048, 1440, 1024]) {
    const out = await sharp(bytes)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer()
    last = out
    if (out.byteLength <= MAX_VIEW_BYTES) break
  }
  return last
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
