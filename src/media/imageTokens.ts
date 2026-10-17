import type { ImageAttachmentRef } from './types.js'

/**
 * Pure image-token estimation (design §11.2): the cost of an image in a
 * request, computed from the *sent dimensions* the ref describes. No file
 * reads, no image libraries, no Base64 — callers hand over metadata only, so
 * `prompts/` budgets can use this without depending on `harness/`.
 *
 * Formulas are each vendor's *published approximation*, used only for the
 * provider they belong to; no vendor's pixel formula is claimed as a universal
 * exact cost. Models that are not known to either adapter get the conservative
 * strategy, which is deliberately an upper bound and labelled approximate.
 */
export type ImageTokenStrategy =
  /** Anthropic Messages' documented approximation: `(width x height) / 750`. */
  | 'anthropic'
  /**
   * OpenAI Chat Completions' documented high-detail tiling cost
   * (`85 + 170 per 512x512 tile`, after the 2048/768 rescale steps). The first
   * version sends no `detail`, and "auto" resolves to high detail for large
   * images — the costly branch — so that is what is estimated.
   */
  | 'openai'
  /**
   * Unknown or custom models: the larger of the two known formulas, so the
   * estimate never reads *below* a cost a real provider might charge. This is
   * an approximation, not a measurement — `imageTokenEstimateIsApproximate`
   * says so, and server-side usage remains the consumption authority.
   */
  | 'conservative'
  /** A model that will not receive image pixels at all (text-only projection). */
  | 'none'

/** What a counter assumes when it is not told which model is serving. */
export const DEFAULT_IMAGE_TOKEN_STRATEGY: ImageTokenStrategy = 'conservative'

export function estimateImageTokens(
  image: Pick<ImageAttachmentRef, 'width' | 'height'>,
  strategy: ImageTokenStrategy,
): number {
  switch (strategy) {
    case 'none':
      return 0
    case 'anthropic':
      return anthropicImageTokens(image.width, image.height)
    case 'openai':
      return openAiImageTokens(image.width, image.height)
    case 'conservative':
      return Math.max(
        anthropicImageTokens(image.width, image.height),
        openAiImageTokens(image.width, image.height),
      )
  }
}

/** Total image cost of a message's or result's refs, 0 when it carries none. */
export function countImageTokens(
  images: readonly ImageAttachmentRef[] | undefined,
  strategy: ImageTokenStrategy,
): number {
  if (!images || images.length === 0) return 0
  let total = 0
  for (const image of images) {
    total += estimateImageTokens(image, strategy)
  }
  return total
}

/**
 * The strategy for the model actually serving a request. A model that cannot
 * accept images sends none (they leave the request as text placeholders), so
 * its image-token cost is zero; known providers get their own formula;
 * everything else is estimated conservatively.
 */
export function resolveImageTokenStrategy(
  providerName: string | undefined,
  supportsImageInput: boolean | undefined,
): ImageTokenStrategy {
  if (supportsImageInput !== true) return 'none'
  if (providerName === 'anthropic') return 'anthropic'
  if (providerName === 'openai' || providerName === 'openai-responses') return 'openai'
  return 'conservative'
}

/** Whether estimates under this strategy should be labelled approximate. */
export function imageTokenEstimateIsApproximate(strategy: ImageTokenStrategy): boolean {
  return strategy === 'conservative'
}

/** How logs and diagnostics name a strategy. */
export function describeImageTokenStrategy(strategy: ImageTokenStrategy): string {
  return imageTokenEstimateIsApproximate(strategy)
    ? 'conservative (approximate)'
    : strategy
}

function anthropicImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0
  return Math.ceil((width * height) / 750)
}

function openAiImageTokens(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 0
  // Documented high-detail steps: fit within 2048x2048, then scale the shortest
  // side down to 768, then charge per 512x512 tile plus the base cost.
  let scaledWidth = width
  let scaledHeight = height
  const longest = Math.max(scaledWidth, scaledHeight)
  if (longest > 2048) {
    scaledWidth = Math.round((scaledWidth * 2048) / longest)
    scaledHeight = Math.round((scaledHeight * 2048) / longest)
  }
  const shortest = Math.min(scaledWidth, scaledHeight)
  if (shortest > 768) {
    scaledWidth = Math.round((scaledWidth * 768) / shortest)
    scaledHeight = Math.round((scaledHeight * 768) / shortest)
  }
  const tiles = Math.ceil(scaledWidth / 512) * Math.ceil(scaledHeight / 512)
  return 85 + 170 * tiles
}
