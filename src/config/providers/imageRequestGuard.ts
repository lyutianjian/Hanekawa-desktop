import type { ImageAttachmentRef } from '../../media/types.js'
import {
  formatByteCount,
  resolveMaxImageBytes,
  resolveMaxRequestBodyBytes,
} from '../../media/imageRequestLimits.js'
import type { ModelProvider, ModelRequest } from '../../harness/types.js'
import { TurnImageBlockError } from '../../harness/turnImages.js'
import { resolveMaxMediaItems } from '../../harness/mediaStrip.js'

/**
 * The final pre-send check (design §11.1 step 5, §13): after a payload is
 * fully mapped, verify the request one more time — per-image bytes, image
 * count, and the whole serialized body — against the stricter of the local
 * policy and the provider's own limits. Runs inside the provider adapters,
 * the last layer anything passes through before the network, so a caller that
 * bypassed the UI, the submission gate, and the loop's projections still
 * cannot put an over-limit image request on the wire.
 *
 * Failures throw {@link TurnImageBlockError} with a distinguishable reason;
 * retry classification reads them as `unknown`, so an over-limit request is
 * rejected once, never retried.
 */

/** The three limits a final check enforces, resolved for one provider. */
export interface ImageRequestGuardLimits {
  maxImages: number
  maxImageBytes: number
  maxRequestBodyBytes: number
}

/**
 * Reads a provider's declared limits and tightens the local policy with them
 * (design §11.1: 已知限制与本地策略取较严格者). Nonsense values degrade to the
 * local cap rather than inverting the rule.
 */
export function resolveImageRequestGuardLimits(
  provider: Pick<ModelProvider, 'name' | 'createMessage' | 'maxImagesPerRequest' | 'maxImageBytes' | 'maxRequestBodyBytes'>,
): ImageRequestGuardLimits {
  return {
    maxImages: resolveMaxMediaItems(provider.maxImagesPerRequest?.()),
    maxImageBytes: resolveMaxImageBytes(provider.maxImageBytes?.()),
    maxRequestBodyBytes: resolveMaxRequestBodyBytes(provider.maxRequestBodyBytes?.()),
  }
}

/**
 * The image refs a request carries, in first-appearance order, unique by id.
 * Reads `messages` and `contextItems` — metadata only, never bytes.
 */
export function collectRequestImageRefs(request: ModelRequest): ImageAttachmentRef[] {
  const byId = new Map<string, ImageAttachmentRef>()
  const add = (images: readonly ImageAttachmentRef[] | undefined): void => {
    for (const ref of images ?? []) {
      if (!byId.has(ref.id)) byId.set(ref.id, ref)
    }
  }
  for (const message of request.messages) add(message.images)
  for (const item of request.contextItems ?? []) {
    if (item.kind === 'message') add(item.message.images)
    else if (item.kind === 'tool_result') add(item.images)
  }
  return [...byId.values()]
}

/**
 * The provider-side capability re-check (design §11.1, §13): whatever the UI
 * and the loop already decided, the adapter a request actually reaches refuses
 * image-bearing requests it is not enabled for, so a bypassed call path fails
 * loudly instead of putting image blocks on a model that cannot see them.
 * `capable` is the resolved capability — model switch AND adapter support.
 */
export function assertRequestImageCapability(request: ModelRequest, capable: boolean): void {
  if (capable) return
  const refs = collectRequestImageRefs(request)
  if (refs.length === 0) return
  throw new TurnImageBlockError(
    'model-not-capable',
    refs,
    formatProviderCapabilityBlockedMessage(request.model, refs),
  )
}

export function formatProviderCapabilityBlockedMessage(model: string, refs: readonly ImageAttachmentRef[]): string {
  const plural = refs.length === 1 ? '' : 's'
  return `Model ${model} is not enabled for image input, but the request carries ${refs.length} image${plural} `
    + `(${refs.map((ref) => ref.name).join(', ')}). The request was not sent. `
    + `Enable this model's image capability switch, or send the images to an image-capable model.`
}

/**
 * The three-layer final check. Order is most-specific first: one oversized
 * image, then the image count, then the whole serialized body — so the error
 * names the thing to fix, not just "too big".
 */
export function assertFinalImageRequestLimits(
  payload: unknown,
  request: ModelRequest,
  limits: ImageRequestGuardLimits,
): void {
  const refsById = new Map(collectRequestImageRefs(request).map((ref) => [ref.id, ref]))

  // Layer 1: per-image send bytes, measured on the loaded bytes themselves.
  for (const [id, loaded] of request.imageBytes ?? []) {
    if (loaded.bytes.byteLength <= limits.maxImageBytes) continue
    const ref = refsById.get(id)
    throw new TurnImageBlockError(
      'image-too-large',
      ref ? [ref] : [],
      `Image ${ref?.name ?? id} (attachment ${id}) sends ${formatByteCount(loaded.bytes.byteLength)} bytes, `
        + `over the ${formatByteCount(limits.maxImageBytes)}-byte per-image limit for this request. `
        + `The request was not sent. Crop the image or attach a smaller version, then resend.`,
    )
  }

  // Layer 2: how many image blocks the mapped payload actually carries.
  const imageBlockCount = countImageBlocks(payload)
  if (imageBlockCount > limits.maxImages) {
    throw new TurnImageBlockError(
      'too-many-images',
      [...refsById.values()],
      `This request carries ${imageBlockCount} image blocks, but at most ${limits.maxImages} are allowed `
        + `per request. The request was not sent. Remove images or clear older turns, then resend.`,
    )
  }

  // Layer 3: the whole serialized request body — checking only each image
  // never catches a request that is over the limit as a whole.
  const bodyBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (bodyBytes <= limits.maxRequestBodyBytes) return
  const imageBytes = [...(request.imageBytes ?? []).values()]
    .reduce((sum, loaded) => sum + 4 * Math.ceil(loaded.bytes.byteLength / 3), 0)
  const share = imageBytes > 0
    ? `about ${formatByteCount(imageBytes)} of those are image data`
    : `the request carries no images, so its text alone is over the limit`
  throw new TurnImageBlockError(
    'request-too-large',
    [...refsById.values()],
    `The serialized request body is ${formatByteCount(bodyBytes)} bytes, over the `
      + `${formatByteCount(limits.maxRequestBodyBytes)}-byte request limit; ${share}. `
      + `The request was not sent. Send fewer or smaller images, or clear older turns.`,
  )
}

/**
 * Counts image blocks in a mapped payload, provider-agnostic: Anthropic image
 * blocks (`source.type === 'base64'`) and OpenAI `image_url` data-URL parts.
 * Tool schemas live in the same tree; a schema cannot satisfy either shape's
 * companion fields, so it never counts.
 */
function countImageBlocks(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countImageBlocks(item), 0)
  }
  if (!isRecord(value)) return 0
  let count = 0
  if (value.type === 'image' && isRecord(value.source) && value.source.type === 'base64') count += 1
  if (
    value.type === 'image_url'
    && isRecord(value.image_url)
    && typeof value.image_url.url === 'string'
    && value.image_url.url.startsWith('data:')
  ) {
    count += 1
  }
  if (value.type === 'input_image' && typeof value.image_url === 'string' && value.image_url.startsWith('data:')) count += 1
  for (const child of Object.values(value)) count += countImageBlocks(child)
  return count
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Strips image bodies out of text that will reach a user-visible error
 * message: proxies echo request bodies back in HTTP errors, and a data URL or
 * long base64 run in that echo is image content the UI must never display
 * (design §13). Short runs stay — checksums and ids are not image data.
 */
export function redactImageBytesFromText(text: string): string {
  return text
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]{40,}/gi, '[redacted image data]')
    // No word boundaries here on purpose: `+`, `/`, `=` are non-word chars, so
    // a `\b` would let the tail of an echoed base64 run slip through.
    .replace(/[a-z0-9+/=]{400,}/gi, '[redacted image data]')
}
