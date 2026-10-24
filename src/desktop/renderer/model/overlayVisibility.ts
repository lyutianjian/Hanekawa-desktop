/**
 * Whether a blocking request's card is really on screen — the one rule the key
 * map, the card's paint and `paneSession.revealOverlay` share.
 *
 * A parked request holds the agent loop, so it must not answer keys or take the
 * caret while the settings screen, the projects page, the image viewer, or
 * another lane covers its card.
 */

export interface OverlayScene {
  /** The pane the request belongs to is the one on screen. */
  readonly paneActive: boolean
  /** The settings screen or the projects page, each replacing the canvas. */
  readonly screen: boolean
  /** The fullscreen image viewer, drawn over every other layer. */
  readonly viewer: boolean
}

export function overlayVisible(scene: OverlayScene): boolean {
  return scene.paneActive && !scene.screen && !scene.viewer
}