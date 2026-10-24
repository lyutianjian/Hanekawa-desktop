/** One grapheme's entrance, the stylesheet's `--motion-grapheme-in`. */
export const GRAPHEME_IN_MS = 90
/** How far apart two neighbouring graphemes start their entrances. */
export const GRAPHEME_STAGGER_MS = 30

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** User-perceived characters, so an emoji or a combining mark enters as one. */
export function graphemes(text: string): string[] {
  return Array.from(segmenter.segment(text), (part) => part.segment)
}

/** From the first grapheme's start to the last one's end. */
export function revealDurationMs(count: number): number {
  return Math.max(0, count - 1) * GRAPHEME_STAGGER_MS + GRAPHEME_IN_MS
}
