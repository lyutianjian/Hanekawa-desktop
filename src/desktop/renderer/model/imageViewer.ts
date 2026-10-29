/**
 * The fullscreen image viewer's state (the lightbox).
 *
 * One image at a time, opened from any thumbnail in the window — a composer
 * tile or a sent message's image. The viewer is *not* a blocking request: it
 * carries no decision, so it never enters `hasOverlay` and the user closes it
 * whenever they like.
 *
 * Two tiers of pixels arrive here. The 256px thumbnail the strip already holds
 * opens the viewer immediately, so a click never lands on an empty scrim; the
 * screen-sized copy (`get-attachment-view`) replaces it when it settles. That
 * is why `dataUrl` is present while `status` is still `loading` — the field is
 * "what to paint", not "what finished".
 *
 * Pure state, no DOM: the view turns this into nodes, and the pane owns the
 * current value.
 */

/** The open viewer. Absent (`undefined`) is the closed viewer. */
export interface ImageViewerState {
  readonly imageId: string
  readonly name: string
  /** `W×H`, with ，动画首帧 appended when the import took the first frame. */
  readonly dimensions: string
  /**
   * The picture's own pixel size, and the box the view lays it out in.
   *
   * The two tiers of pixels arrive at different natural sizes — the 256px
   * thumbnail the strip already holds, then the screen-sized copy — so an
   * `<img>` at its natural size would change size under a fixed zoom when the
   * sharp copy landed. Laid out at this instead, the swap changes sharpness
   * only, and `zoom` stays "one picture pixel per CSS pixel" throughout.
   */
  readonly width: number
  readonly height: number
  /** Whether the screen-sized copy has arrived, is still coming, or failed. */
  readonly status: 'loading' | 'ready' | 'failed'
  /**
   * The bytes to paint: the thumbnail while loading, the screen-sized copy once
   * ready. Absent only when the viewer opened with no thumbnail in hand and the
   * load has not settled — the view draws its loading state then.
   */
  readonly dataUrl?: string
  /** The explained failure, when `status` is `failed`. */
  readonly message?: string
  /** The current zoom factor; `1` is one image pixel per CSS pixel. */
  readonly zoom: number
}

/**
 * The three custom properties the viewer writes per paint.
 *
 * Zoom is measured against the viewport and pan is measured against the
 * pointer, so no token can hold either — the same exception the context ring's
 * `CONTEXT_RATIO_VARIABLE` takes, and declared here for the same reason: the
 * *rule* that reads them, and its fallback, stay in the stylesheet.
 */
export const VIEWER_ZOOM_VARIABLE = '--viewer-zoom'
export const VIEWER_PAN_X_VARIABLE = '--viewer-pan-x'
export const VIEWER_PAN_Y_VARIABLE = '--viewer-pan-y'

/**
 * The zoom ladder. Fixed steps rather than a continuous factor: the control is
 * two buttons and a percentage, and a ladder is what makes the percentage
 * repeatable — the same two clicks always land on the same number.
 */
export const ZOOM_STEPS: readonly number[] = [
  0.1, 0.15, 0.22, 0.33, 0.5, 0.67, 1, 1.5, 2, 3, 4,
]

export const MIN_ZOOM = ZOOM_STEPS[0]!
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!

/**
 * The zoom an image opens at: fitted inside the viewport, never enlarged.
 *
 * A small image opens at 1 and the user zooms *in* from there; a large one
 * opens at whatever fraction shows all of it. Degenerate inputs (a viewport of
 * zero before the first layout, an image whose natural size is not known yet)
 * answer 1 rather than 0 or Infinity.
 */
export function fitZoom(
  natural: { width: number; height: number },
  viewport: { width: number; height: number },
): number {
  if (natural.width <= 0 || natural.height <= 0) return 1
  if (viewport.width <= 0 || viewport.height <= 0) return 1
  const fit = Math.min(viewport.width / natural.width, viewport.height / natural.height)
  if (!Number.isFinite(fit) || fit <= 0) return 1
  return clampZoom(Math.min(fit, 1))
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom))
}

/**
 * The next rung up. A zoom that sits *between* two rungs — the fit zoom almost
 * always does — steps to the first rung above it, so the first click after
 * opening is always a real change.
 */
export function zoomIn(zoom: number): number {
  const next = ZOOM_STEPS.find((step) => step > zoom + 1e-9)
  return next ?? MAX_ZOOM
}

/** The next rung down, by the same rule read backwards. */
export function zoomOut(zoom: number): number {
  for (let index = ZOOM_STEPS.length - 1; index >= 0; index -= 1) {
    const step = ZOOM_STEPS[index]!
    if (step < zoom - 1e-9) return step
  }
  return MIN_ZOOM
}

export function canZoomIn(zoom: number): boolean {
  return zoom < MAX_ZOOM - 1e-9
}

export function canZoomOut(zoom: number): boolean {
  return zoom > MIN_ZOOM + 1e-9
}

/** `22%`, the way the reference reads it: rounded, never `21.7%`. */
export function formatZoom(zoom: number): string {
  return `${Math.round(clampZoom(zoom) * 100)}%`
}

export interface OpenImageViewerInput {
  readonly imageId: string
  readonly name: string
  readonly dimensions: string
  /** The picture's own pixel size; the view lays the image out at it. */
  readonly width: number
  readonly height: number
  /** The thumbnail already in hand, when there is one. */
  readonly thumbUrl?: string
  /** The zoom to open at; `fitZoom`'s answer once the viewport is measured. */
  readonly zoom?: number
}

export function openImageViewer(input: OpenImageViewerInput): ImageViewerState {
  return {
    imageId: input.imageId,
    name: input.name,
    dimensions: input.dimensions,
    width: input.width,
    height: input.height,
    status: 'loading',
    ...(input.thumbUrl !== undefined ? { dataUrl: input.thumbUrl } : {}),
    zoom: clampZoom(input.zoom ?? 1),
  }
}

/**
 * The screen-sized copy arrived. `undefined` when the viewer has since closed
 * or moved to another image — a settle for yesterday's id must not repaint
 * today's picture.
 */
export function settleImageViewer(
  state: ImageViewerState | undefined,
  imageId: string,
  dataUrl: string,
): ImageViewerState | undefined {
  if (state === undefined || state.imageId !== imageId) return undefined
  return { ...state, status: 'ready', dataUrl }
}

/**
 * The load failed. The thumbnail already on screen stays — a blurry picture
 * with a note beside it beats replacing it with an error card — and the same
 * staleness guard applies.
 */
export function failImageViewer(
  state: ImageViewerState | undefined,
  imageId: string,
  message: string,
): ImageViewerState | undefined {
  if (state === undefined || state.imageId !== imageId) return undefined
  return { ...state, status: 'failed', message }
}

/** A zoom change, clamped and staleness-free (the caller already has the state). */
export function withZoom(state: ImageViewerState, zoom: number): ImageViewerState {
  return { ...state, zoom: clampZoom(zoom) }
}
