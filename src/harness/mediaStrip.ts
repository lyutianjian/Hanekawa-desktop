import type { ImageAttachmentRef } from '../media/types.js'
import type { SessionRecord, Tool } from './types.js'
import {
  estimateImageBlockBytes,
  formatByteCount,
} from '../media/imageRequestLimits.js'
import { getCachedToolSchema } from './toolApiSchema.js'
import {
  appendPlaceholderBlocks,
  recordIsCurrentTurn,
  TurnImageBlockError,
} from './turnImages.js'

/** Local policy for images per request (design §8); a lower adapter limit wins. */
export const DEFAULT_MAX_MEDIA_ITEMS = 100

/**
 * The effective per-request image cap: the local default, tightened by an
 * adapter's own limit when it declares a lower one. Nonsense values degrade to
 * the local cap rather than inverting the rule.
 */
export function resolveMaxMediaItems(adapterMax?: number): number {
  if (adapterMax === undefined || !Number.isFinite(adapterMax)) return DEFAULT_MAX_MEDIA_ITEMS
  return Math.max(0, Math.min(DEFAULT_MAX_MEDIA_ITEMS, Math.floor(adapterMax)))
}

export interface MediaStripOptions {
  /** The run in flight; its records' images get omission protection. */
  currentTurnId?: string
  currentUserMessageId?: string
  /** Effective cap; defaults to {@link DEFAULT_MAX_MEDIA_ITEMS}. */
  maxMediaItems?: number
}

/** One omitted image occurrence, for notices and logs. */
export interface OmittedImage {
  refId: string
  name: string
  recordId: string
  /** Omitted as history of earlier turns, rather than as this turn's tool output. */
  historical: boolean
}

export interface MediaStripResult {
  /** The request-projected records; the input array is never mutated. */
  records: SessionRecord[]
  /** Image occurrences replaced by placeholders, oldest first. */
  omittedImages: OmittedImage[]
  /** Image occurrences the request still carries. */
  keptImageCount: number
  maxMediaItems: number
  /** Stable identity of (cap x kept set) for notice dedup and cache invalidation. */
  signature: string
}

/**
 * Enforces the per-request image-count cap (design §8, §11.1 step 3): history
 * of earlier turns, the current input, and tool images all count toward it.
 * Over the cap, the *oldest historical* images leave the request first as
 * reason-carrying placeholders; the current turn's own images are protected —
 * its tool-result images may only be omitted once every historical image
 * already has been, and the input's own images never are (an input that alone
 * exceeds the cap blocks instead, without silently dropping current images).
 *
 * A pure projection like the capability projection it runs after: JSONL and
 * cached files keep every image, so a wider cap on a later request restores
 * them.
 */
export function stripExcessMediaItems(
  records: SessionRecord[],
  options: MediaStripOptions = {},
): MediaStripResult {
  const cap = Math.max(0, Math.floor(options.maxMediaItems ?? DEFAULT_MAX_MEDIA_ITEMS))
  const occurrences = collectImageOccurrences(records, options)

  if (occurrences.length <= cap) {
    return {
      records,
      omittedImages: [],
      keptImageCount: occurrences.length,
      maxMediaItems: cap,
      signature: mediaStripSignature(cap, occurrences),
    }
  }

  // Oldest history first, then the current turn's oldest tool images. The
  // input's own images are absent from both lists, so an excess that survives
  // them means the input alone is over the cap.
  const historical = occurrences
    .filter((occurrence) => occurrence.zone === 'history')
    .sort((left, right) => left.order - right.order)
  const currentTool = occurrences
    .filter((occurrence) => occurrence.zone === 'turn-tool')
    .sort((left, right) => left.order - right.order)

  const excess = occurrences.length - cap
  const omitted = [...historical, ...currentTool].slice(0, excess)
  const inputImages = occurrences
    .filter((occurrence) => occurrence.zone === 'input')
    .map((occurrence) => occurrence.ref)
  if (omitted.length < excess && inputImages.length > 0) {
    throw new TurnImageBlockError(
      'too-many-images',
      inputImages,
      formatTooManyImagesBlockedMessage(inputImages.length, cap),
    )
  }

  const omittedKeys = new Set(omitted.map((occurrence) => occurrence.key))
  const placeholdersByRecordId = new Map<string, { blocks: string[]; dropRefIndexes: Set<number> }>()
  for (const occurrence of omitted) {
    const entry = placeholdersByRecordId.get(occurrence.record.id) ?? {
      blocks: [],
      dropRefIndexes: new Set<number>(),
    }
    entry.blocks.push(formatOmittedImagePlaceholder(occurrence.ref, cap, occurrence.zone === 'history'))
    entry.dropRefIndexes.add(occurrence.refIndex)
    placeholdersByRecordId.set(occurrence.record.id, entry)
  }

  const stripped = records.map((record) => {
    const entry = placeholdersByRecordId.get(record.id)
    if (!entry) return record
    const bearing = record as SessionRecord & { images: ImageAttachmentRef[]; content: string }
    const keptImages = bearing.images.filter((_, index) => !entry.dropRefIndexes.has(index))
    const { images: _images, ...rest } = bearing
    return {
      ...rest,
      ...(keptImages.length > 0 ? { images: keptImages } : {}),
      content: appendPlaceholderBlocks(bearing.content, entry.blocks),
    } as SessionRecord
  })

  return {
    records: stripped,
    omittedImages: omitted.map((occurrence) => ({
      refId: occurrence.ref.id,
      name: occurrence.ref.name,
      recordId: occurrence.record.id,
      historical: occurrence.zone === 'history',
    })),
    keptImageCount: occurrences.length - omitted.length,
    maxMediaItems: cap,
    signature: mediaStripSignature(cap, occurrences.filter((occurrence) => !omittedKeys.has(occurrence.key))),
  }
}

/** The notice a user sees once per distinct (cap, kept set) omission state. */
export function formatMediaStripNotice(omittedImageCount: number, maxImages: number): string {
  const plural = omittedImageCount === 1 ? '' : 's'
  return `This request exceeds the limit of ${maxImages} images, so ${omittedImageCount} of the oldest image${plural} `
    + `were replaced with file placeholders and will not be sent. The originals are kept; `
    + `send fewer images or clear older turns to stay within the limit.`
}

/** The blocked-input message when the input alone exceeds the request cap. */
export function formatTooManyImagesBlockedMessage(imageCount: number, maxImages: number): string {
  const plural = imageCount === 1 ? '' : 's'
  const overage = imageCount - maxImages
  return `This input carries ${imageCount} image${plural}, but this model accepts at most ${maxImages} per request. `
    + `Nothing was sent or recorded. Remove ${overage === 1 ? 'it' : `${overage} of them`} and resend.`
}

type ImageZone = 'input' | 'turn-tool' | 'history'

interface ImageOccurrence {
  record: SessionRecord & { images: ImageAttachmentRef[] }
  ref: ImageAttachmentRef
  refIndex: number
  zone: ImageZone
  /** Position in the records walk; smaller is older. */
  order: number
  key: string
}

function collectImageOccurrences(
  records: readonly SessionRecord[],
  options: MediaStripOptions,
): ImageOccurrence[] {
  const occurrences: ImageOccurrence[] = []
  records.forEach((record, recordIndex) => {
    if (record.type !== 'message' && record.type !== 'tool_result') return
    if (!record.images || record.images.length === 0) return
    const bearing = record as SessionRecord & { images: ImageAttachmentRef[] }
    const isCurrentTurn = options.currentTurnId !== undefined
      && recordIsCurrentTurn(record, options.currentTurnId, options.currentUserMessageId)
    const zone: ImageZone = !isCurrentTurn
      ? 'history'
      : record.type === 'message'
        ? 'input'
        : 'turn-tool'
    bearing.images.forEach((ref, refIndex) => {
      occurrences.push({
        record: bearing,
        ref,
        refIndex,
        zone,
        order: occurrences.length,
        key: `${record.id}:${refIndex}:${ref.id}`,
      })
    })
  })
  return occurrences
}

function mediaStripSignature(cap: number, occurrences: readonly ImageOccurrence[]): string {
  const kept = occurrences
    .map((occurrence) => `${occurrence.ref.id}:${occurrence.ref.width}x${occurrence.ref.height}`)
    .sort()
    .join(',')
  return `max:${cap}|kept:${kept}`
}

/**
 * The placeholder the model receives instead of pixels. It states why the
 * image is absent and that no visual content follows — never a description of
 * the image (the same honesty rule the capability projection follows).
 */
function formatOmittedImagePlaceholder(
  ref: ImageAttachmentRef,
  maxImages: number,
  historical: boolean,
): string {
  const qualifier = historical ? 'Historical image' : 'Image'
  return `[${qualifier} omitted to stay within the ${maxImages}-image request limit: `
    + `${ref.name} (attachment ${ref.id}). The pixels are not present in this request.]`
}

// --- Request-size budget (S19, design §11.1 step 3) --------------------------

export interface ImageByteStripOptions {
  /** The run in flight; its records' images get omission protection. */
  currentTurnId?: string
  currentUserMessageId?: string
  /**
   * Total bytes the request's image contribution may serialize into. The
   * caller derives it from the request-body limit minus the estimated text —
   * see {@link estimateRequestTextBytes}.
   */
  maxImageRequestBytes: number
}

export interface ImageByteStripResult {
  /** The request-projected records; the input array is never mutated. */
  records: SessionRecord[]
  /** Image occurrences replaced by placeholders, oldest first. */
  omittedImages: OmittedImage[]
  /** Estimated serialized bytes the kept occurrences contribute. */
  keptImageBytes: number
  maxImageRequestBytes: number
  /** Stable identity of (budget x kept set) for notice dedup and cache invalidation. */
  signature: string
}

/**
 * Enforces the request's image-byte budget (design §11.1 step 3: "超过数量或
 * 体积预算时，优先把最早的历史图换成带原因的占位符"): the same zone order and
 * protection the count cap applies — oldest history first, then this turn's
 * tool images, the input's own images never. An input whose images alone
 * exceed the budget blocks instead of being silently trimmed. Estimates work
 * off ref metadata only, so the decision runs before any byte is loaded; the
 * providers' final check re-verifies the real serialized body.
 */
export function stripExcessImageBytes(
  records: SessionRecord[],
  options: ImageByteStripOptions,
): ImageByteStripResult {
  const budget = Math.max(0, Math.floor(options.maxImageRequestBytes))
  const occurrences = collectImageOccurrences(records, options)

  const totalBytes = occurrences.reduce((sum, occurrence) => sum + estimateImageBlockBytes(occurrence.ref), 0)
  if (totalBytes <= budget) {
    return {
      records,
      omittedImages: [],
      keptImageBytes: totalBytes,
      maxImageRequestBytes: budget,
      signature: imageByteStripSignature(occurrences),
    }
  }

  // Same omission order as the count cap: oldest history, then this turn's
  // oldest tool images. The input's own occurrences are absent from both
  // lists, so a budget they alone exceed means the input alone is over.
  const historical = occurrences
    .filter((occurrence) => occurrence.zone === 'history')
    .sort((left, right) => left.order - right.order)
  const currentTool = occurrences
    .filter((occurrence) => occurrence.zone === 'turn-tool')
    .sort((left, right) => left.order - right.order)
  const inputImages = occurrences
    .filter((occurrence) => occurrence.zone === 'input')
    .map((occurrence) => occurrence.ref)

  const omitted: ImageOccurrence[] = []
  let runningBytes = totalBytes
  for (const occurrence of [...historical, ...currentTool]) {
    if (runningBytes <= budget) break
    omitted.push(occurrence)
    runningBytes -= estimateImageBlockBytes(occurrence.ref)
  }
  if (runningBytes > budget && inputImages.length > 0) {
    throw new TurnImageBlockError(
      'request-too-large',
      inputImages,
      formatImageBytesBlockedMessage(inputImages, runningBytes, budget),
    )
  }

  const omittedKeys = new Set(omitted.map((occurrence) => occurrence.key))
  const placeholdersByRecordId = new Map<string, { blocks: string[]; dropRefIndexes: Set<number> }>()
  for (const occurrence of omitted) {
    const entry = placeholdersByRecordId.get(occurrence.record.id) ?? {
      blocks: [],
      dropRefIndexes: new Set<number>(),
    }
    entry.blocks.push(formatOmittedImageBytesPlaceholder(
      occurrence.ref,
      budget,
      occurrence.zone === 'history',
    ))
    entry.dropRefIndexes.add(occurrence.refIndex)
    placeholdersByRecordId.set(occurrence.record.id, entry)
  }

  const stripped = records.map((record) => {
    const entry = placeholdersByRecordId.get(record.id)
    if (!entry) return record
    const bearing = record as SessionRecord & { images: ImageAttachmentRef[]; content: string }
    const keptImages = bearing.images.filter((_, index) => !entry.dropRefIndexes.has(index))
    const { images: _images, ...rest } = bearing
    return {
      ...rest,
      ...(keptImages.length > 0 ? { images: keptImages } : {}),
      content: appendPlaceholderBlocks(bearing.content, entry.blocks),
    } as SessionRecord
  })

  return {
    records: stripped,
    omittedImages: omitted.map((occurrence) => ({
      refId: occurrence.ref.id,
      name: occurrence.ref.name,
      recordId: occurrence.record.id,
      historical: occurrence.zone === 'history',
    })),
    keptImageBytes: runningBytes,
    maxImageRequestBytes: budget,
    signature: imageByteStripSignature(occurrences.filter((occurrence) => !omittedKeys.has(occurrence.key))),
  }
}

/**
 * Submission-level gate for the input's own images (design §11.1: an input
 * that alone exceeds the limit is rejected, not silently trimmed): compares
 * the input's estimated serialized bytes against the whole request-body
 * limit — deliberately without history or text, which only the request build
 * can know. Throws before anything is recorded.
 */
export function assertInputImagesWithinRequestBody(
  images: readonly ImageAttachmentRef[] | undefined,
  maxRequestBodyBytes: number,
): void {
  if (!images || images.length === 0) return
  const estimated = images.reduce((sum, ref) => sum + estimateImageBlockBytes(ref), 0)
  if (estimated <= maxRequestBodyBytes) return
  throw new TurnImageBlockError(
    'request-too-large',
    [...images],
    formatImageBytesBlockedMessage([...images], estimated, maxRequestBodyBytes),
  )
}

/** The notice a user sees once per distinct (budget, kept set) omission state. */
export function formatImageByteStripNotice(omittedImageCount: number, maxImageRequestBytes: number): string {
  const plural = omittedImageCount === 1 ? '' : 's'
  return `This request's images would exceed its ${formatByteCount(maxImageRequestBytes)}-byte size budget, `
    + `so ${omittedImageCount} of the oldest image${plural} were replaced with file placeholders and will not be sent. `
    + `The originals are kept; send fewer or smaller images to stay within the limit.`
}

/**
 * The blocked-input message when the input's images alone exceed the byte
 * budget. `estimatedBytes` is what those images would serialize into.
 */
export function formatImageBytesBlockedMessage(
  images: readonly ImageAttachmentRef[],
  estimatedBytes: number,
  maxImageRequestBytes: number,
): string {
  const plural = images.length === 1 ? '' : 's'
  return `This input's ${images.length} image${plural} would serialize to about ${formatByteCount(estimatedBytes)} bytes `
    + `on their own, over this request's ${formatByteCount(maxImageRequestBytes)}-byte size limit `
    + `(${images.map((ref) => ref.name).join(', ')}). Nothing was sent or recorded. `
    + `Send fewer images, or crop/downscale them, then resend.`
}

/**
 * Share of the request-body limit reserved for what the context builder adds
 * after this budget pass and the records do not hold: the instructions
 * reminder, the user context, active skills and transient attachments.
 */
export function requestContextReserveBytes(maxRequestBodyBytes: number): number {
  return Math.floor(maxRequestBodyBytes / 20)
}

/**
 * Estimates the non-image bytes a request will serialize into, from the
 * pieces the payload builds from: the system prompt, every record field the
 * context builder forwards (content, thinking blocks, reasoning, tool inputs,
 * pre-mapped result blocks) JSON-encoded plus structure, and the tool schemas.
 * The loop subtracts this and {@link requestContextReserveBytes} from the
 * request-body limit to get the images' budget (design §11.1 step 3:
 * "估计文字与图像预算"). An estimate, deliberately without loading anything —
 * the providers' final check measures the real serialized body.
 */
export function estimateRequestTextBytes(
  records: readonly SessionRecord[],
  options: { system?: string; tools?: readonly Tool[] } = {},
): number {
  let bytes = Buffer.byteLength(options.system ?? '', 'utf8')
  for (const record of records) {
    const parts: unknown[] = record.type === 'message'
      ? [record.content, record.reasoningContent, record.thinkingBlocks, record.reasoningDetails]
      : record.type === 'tool_use'
        ? [record.input]
        : record.type === 'tool_result'
          ? [record.content, record.apiResultBlock]
          : record.type === 'compact_boundary'
            ? [record.summary, record.restoredContext]
            : record.type === 'tool_use_summary'
              ? [record.summary]
              : record.type === 'coordination_update' || record.type === 'memory_update' || record.type === 'at_mention_context'
                ? [record.content]
                : []
    // Per-record JSON structure (ids, timestamps, wrapper objects).
    bytes += 256
    for (const part of parts) {
      if (part !== undefined) bytes += Buffer.byteLength(JSON.stringify(part), 'utf8')
    }
  }
  if (options.tools && options.tools.length > 0) {
    bytes += Buffer.byteLength(
      JSON.stringify(options.tools.map((tool) => getCachedToolSchema(tool))),
      'utf8',
    )
  }
  return bytes
}

function formatOmittedImageBytesPlaceholder(
  ref: ImageAttachmentRef,
  maxImageRequestBytes: number,
  historical: boolean,
): string {
  const qualifier = historical ? 'Historical image' : 'Image'
  return `[${qualifier} omitted to keep this request within its ${formatByteCount(maxImageRequestBytes)}-byte size limit: `
    + `${ref.name} (attachment ${ref.id}). The pixels are not present in this request.]`
}

/**
 * The kept set only: the budget is the body limit minus the text bytes, so it
 * moves with every step even when the images sent stay the same.
 */
function imageByteStripSignature(occurrences: readonly ImageOccurrence[]): string {
  const kept = occurrences
    .map((occurrence) => `${occurrence.ref.id}:${occurrence.ref.byteLength}`)
    .sort()
    .join(',')
  return `kept:${kept}`
}
