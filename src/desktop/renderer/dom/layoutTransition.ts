/**
 * Carries one node from where it was to where a layout change just put it.
 *
 * The home page centres the composer and the first message sends it back to the
 * bottom of the canvas: a layout jump no CSS transition can see, because both
 * ends are `auto`. So the caller measures the node's top before the change and
 * hands it here after; the node is then animated from the old spot to its new
 * one (FLIP). Reduced motion — or a node that did not move — just stays put.
 */
export function glideFrom(node: HTMLElement, fromTop: number, reduced: boolean): void {
  if (reduced) return
  const delta = fromTop - node.getBoundingClientRect().top
  if (Math.abs(delta) < 1) return
  node.animate(
    [{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }],
    { duration: 280, easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)' },
  )
}
