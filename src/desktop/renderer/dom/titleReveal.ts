import { GRAPHEME_STAGGER_MS, graphemes, revealDurationMs } from '../model/titleReveal.js'
import { el } from './dom.js'

/** Each revealing node's start, so a superseded reveal's cleanup leaves the newer text alone. */
const revealing = new WeakMap<HTMLElement, number>()

/**
 * Writes `text` into `node` as one span per grapheme, entering from `startedAt`
 * (page clock), and puts the plain text back once the last one is in. The node
 * must be in the document before `pinGraphemes` can stagger the spans.
 */
export function revealText(node: HTMLElement, text: string, startedAt: number): void {
  const parts = graphemes(text)
  revealing.set(node, startedAt)
  node.classList.add('revealing')
  node.replaceChildren(...parts.map((part, at) => {
    // An inline block collapses a lone space to nothing.
    const span = el('span', undefined, part === ' ' ? '\u00a0' : part)
    span.dataset.grapheme = String(at)
    return span
  }))
  setTimeout(() => {
    if (revealing.get(node) === startedAt) showText(node, text)
  }, startedAt + revealDurationMs(parts.length) - performance.now())
}

/** Plain text, ending any reveal under way. */
export function showText(node: HTMLElement, text: string): void {
  revealing.delete(node)
  node.classList.remove('revealing')
  node.textContent = text
}

/**
 * Starts each grapheme's entrance one stagger after the previous one, counted
 * from `startedAt`. Start times rather than delays: a node rebuilt mid-reveal
 * restarts its CSS animations, and a start time puts each one back where it was.
 */
export function pinGraphemes(root: Element, startedAt: number): void {
  for (const animation of root.getAnimations({ subtree: true })) {
    if (!(animation instanceof CSSAnimation) || animation.animationName !== 'grapheme-in') continue
    const target = (animation.effect as KeyframeEffect | null)?.target as HTMLElement | null | undefined
    const start = startedAt + Number(target?.dataset.grapheme ?? 0) * GRAPHEME_STAGGER_MS
    if (animation.startTime !== start) animation.startTime = start
  }
}
