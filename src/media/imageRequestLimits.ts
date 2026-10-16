/**
 * Pure request-size policy for image-bearing requests (design §11.1 step 3/5,
 * §8): the numbers and the min-resolution rule every layer shares — the loop's
 * pre-load byte budget, the submission gate, and the providers' final check.
 *
 * Like `types.ts`, this module is the shared vocabulary, so it stays pure: no
 * `harness/`, no `services/`, no `sharp`, no `node:fs` — only these constants
 * and pure functions over metadata. Anything that has to *read or decide
 * against live bytes* lives in the layer that owns the bytes.
 */
import type { ImageAttachmentRef } from './types.js'

/**
 * The per-image send cap the whole pipeline agrees on (design §8): the
 * processing ladder in `tools/imageFile.ts` compresses toward this number at
 * import time, and the request path's final check rejects any image whose
 * loaded send bytes exceed it. One policy number, enforced at both ends.
 */
export const MAX_IMAGE_SEND_BYTES = 3_750_000

/**
 * Local limit for a whole serialized request body (design §11.1). Under the
 * strictest gateway seen in use (DashScope rejects bodies over 16 MiB), so
 * the oldest images are replaced with placeholders before a provider refuses.
 */
export const MAX_REQUEST_BODY_BYTES = 15_000_000

/**
 * JSON structure around one encoded image block — `{"type":"image","source":
 * {"type":"base64","media_type":"image/png","data":""}}` and the OpenAI data
 * URL equivalent. Estimates add this per occurrence so a budget of many small
 * images is not quietly undershot.
 */
export const IMAGE_BLOCK_OVERHEAD_BYTES = 128

/** Effective per-image byte limit: the local cap, tightened by an adapter's own. */
export function resolveMaxImageBytes(adapterMax?: number): number {
  if (adapterMax === undefined || !Number.isFinite(adapterMax)) return MAX_IMAGE_SEND_BYTES
  return Math.max(0, Math.min(MAX_IMAGE_SEND_BYTES, Math.floor(adapterMax)))
}

/** Effective whole-body limit: the local cap, tightened by an adapter's own. */
export function resolveMaxRequestBodyBytes(adapterMax?: number): number {
  if (adapterMax === undefined || !Number.isFinite(adapterMax)) return MAX_REQUEST_BODY_BYTES
  return Math.max(0, Math.min(MAX_REQUEST_BODY_BYTES, Math.floor(adapterMax)))
}

/**
 * The serialized size one image occurrence contributes to a request body:
 * its send bytes base64-encoded (4 chars per 3 bytes), plus the block's JSON
 * structure. Works off the ref's metadata only — budget decisions never load
 * image bytes (design §11.1: estimate first, load what survived).
 */
export function estimateImageBlockBytes(ref: ImageAttachmentRef): number {
  return 4 * Math.ceil(ref.byteLength / 3) + IMAGE_BLOCK_OVERHEAD_BYTES
}

/** Byte counts in limit messages, formatted like the pipeline's own errors. */
export function formatByteCount(bytes: number): string {
  return bytes.toLocaleString('en-US')
}
