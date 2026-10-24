/**
 * Whether a blocking request's card is really on screen — the one rule the
 * keyboard and the card's own paint both read.
 *
 * A parked request holds the agent loop, so it used to own `y`/`a`/Escape from
 * anywhere, whether or not the user could see what those keys answered. A card
 * behind the settings screen, the projects page or the fullscreen viewer was
 * still allowed — or denied — by a key aimed at the layer in front, and a card
 * that arrived while one of those was up pulled the caret out of it.
 *
 * Two things make a docked card invisible while its pane still holds the
 * request:
 *
 * - the pane is not the active one. `app.ts` routes every key to the active
 *   pane, and a background pane never paints the shared composer dock.
 * - a window layer covers the whole canvas, composer included: the settings
 *   screen, the projects page, or the viewer drawn over everything.
 *
 * A popover is deliberately absent: it floats over part of the window, never
 * over the composer, and a focused popover answers its own Escape anyway.
 *
 * Pure and DOM-free like the rest of `model/`: the key map routes from it and
 * `app.ts`'s permission card asks it before moving focus.
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