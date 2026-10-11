import {
  VIEWER_PAN_X_VARIABLE,
  VIEWER_PAN_Y_VARIABLE,
  VIEWER_ZOOM_VARIABLE,
  canZoomIn,
  canZoomOut,
  formatZoom,
  zoomIn,
  zoomOut,
  type ImageViewerState,
} from '../model/imageViewer.js'
import { button } from './controls.js'
import { el, replace } from './dom.js'
import { createModalPresence, type Presence } from './presence.js'

/**
 * The fullscreen image viewer (the lightbox).
 *
 * A window-level singleton, like `#rewind`, driven by whichever
 * pane is active. Unlike those two it is **fixed** rather than absolute inside
 * `#canvas`: an image opened at full size covers the sidebar as well, which is
 * what makes it a viewer rather than a large popover.
 *
 * It is not a blocking request. Nothing here is holding the agent loop, so all
 * three of the usual dismissals apply — ✕, Escape, and a press on the scrim —
 * and the backdrop *is* clickable.
 *
 * The picture's geometry goes through three custom properties rather than
 * inline `transform`: zoom is measured against the viewport and pan against the
 * pointer, so no token can hold them, but the rule that reads them still lives
 * in the stylesheet. `model/imageViewer.ts` owns the names.
 */

export interface ImageViewerView {
  /** Paints the open viewer. Called again for every state change. */
  show(state: ImageViewerState): void
  /** Shuts it. Idempotent — a pane that switches away calls this blind. */
  close(): void
  /**
   * The viewport the picture has to fit into, for `fitZoom`. Measured here
   * because only this side has the node; `undefined` before the first open.
   */
  stageSize(): { width: number; height: number } | undefined
}

export interface ImageViewerHandlers {
  onZoom(zoom: number): void
  onClose(): void
}

export function createImageViewerView(
  container: HTMLElement,
  handlers: ImageViewerHandlers,
): ImageViewerView {
  const stage = el('div', 'lightbox-stage')
  const image = el('img', 'lightbox-image')
  const caption = el('div', 'lightbox-caption')
  const zoomBar = el('div', 'lightbox-zoom')
  const status = el('div', 'lightbox-status')
  container.appendChild(stage)
  container.appendChild(caption)
  container.appendChild(zoomBar)

  let presence: Presence | undefined
  let current: ImageViewerState | undefined
  /**
   * The pan offset, in CSS pixels, and the only interaction state that is not
   * in the model: it is measured from the pointer and reset by every open and
   * every zoom, so nothing outside this file has an opinion about it.
   */
  let panX = 0
  let panY = 0
  /** Where focus came from, so closing puts it back. */
  let returnFocus: HTMLElement | undefined

  const zoomOutButton = button('lightbox-zoom-step', '', '缩小', () => {
    if (current) handlers.onZoom(zoomStep(current.zoom, -1))
  }, { icon: 'minus' })
  const zoomLabel = el('span', 'lightbox-zoom-label')
  const zoomInButton = button('lightbox-zoom-step', '', '放大', () => {
    if (current) handlers.onZoom(zoomStep(current.zoom, 1))
  }, { icon: 'plus' })
  const closeButton = button('lightbox-close', '', '关闭预览', () => close(), { icon: 'close' })
  replace(zoomBar, zoomOutButton, zoomLabel, zoomInButton)
  container.appendChild(closeButton)

  function zoomStep(zoom: number, direction: 1 | -1): number {
    // The ladder walk lives in the model; this only picks a direction.
    return direction === 1 ? zoomIn(zoom) : zoomOut(zoom)
  }

  function applyGeometry(state: ImageViewerState): void {
    image.style.setProperty(VIEWER_ZOOM_VARIABLE, String(state.zoom))
    image.style.setProperty(VIEWER_PAN_X_VARIABLE, `${panX}px`)
    image.style.setProperty(VIEWER_PAN_Y_VARIABLE, `${panY}px`)
  }

  function show(state: ImageViewerState): void {
    const switching = current?.imageId !== state.imageId
    if (switching) {
      panX = 0
      panY = 0
      if (document.activeElement instanceof HTMLElement && !container.contains(document.activeElement)) {
        returnFocus = document.activeElement
      }
    } else if (current !== undefined && current.zoom !== state.zoom) {
      // A zoom change re-centres: panning is how the user explores a magnified
      // picture, and keeping yesterday's offset across a zoom drops them
      // somewhere they did not choose.
      panX = 0
      panY = 0
    }
    current = state

    container.setAttribute('aria-label', `图片预览：${state.name}`)
    if (state.dataUrl !== undefined) {
      if (image.getAttribute('src') !== state.dataUrl) image.setAttribute('src', state.dataUrl)
      image.setAttribute('alt', state.name)
    } else {
      image.removeAttribute('src')
    }
    image.classList.toggle('pending', state.status === 'loading')
    applyGeometry(state)

    status.textContent = state.status === 'failed'
      ? (state.message ?? '')
      : state.status === 'loading' && state.dataUrl === undefined
        ? '加载中…'
        : ''
    replace(stage, image, status.textContent ? status : undefined)

    caption.textContent = `${state.name}　${state.dimensions}`
    zoomLabel.textContent = formatZoom(state.zoom)
    zoomOutButton.disabled = !canZoomOut(state.zoom)
    zoomInButton.disabled = !canZoomIn(state.zoom)

    if (presence === undefined) {
      presence = createModalPresence(container, stage, () => {
        // Fully closed: drop the bytes. A screen-sized data URL is the largest
        // string this renderer ever holds, and keeping it alive behind a hidden
        // layer is the one thing this view can do wrong on its own.
        image.removeAttribute('src')
        current = undefined
      })
    }
    const opening = presence.phase === 'closed' || presence.phase === 'closing'
    presence.set(true)
    // Last thing in the paint: `focus()` fires `focusout` synchronously, and a
    // handler answering that with a repaint would re-enter this paint.
    if (opening) closeButton.focus()
  }

  function close(): void {
    if (presence === undefined) return
    const hadFocus = container.contains(document.activeElement)
    presence.set(false)
    if (hadFocus) returnFocus?.focus()
    returnFocus = undefined
    handlers.onClose()
  }

  // The scrim itself, and only the scrim: a press on the picture, the caption or
  // the zoom capsule is not a dismissal.
  container.addEventListener('mousedown', (event) => {
    if (event.target !== container) return
    event.preventDefault()
    close()
  })
  container.addEventListener('keydown', (event) => {
    if ((event as KeyboardEvent).key !== 'Escape') return
    // Consumed here, so Escape over the viewer does not also reach the global
    // key map and interrupt the turn behind it.
    event.preventDefault()
    event.stopPropagation()
    close()
  })

  // The wheel zooms rather than scrolling: there is nothing to scroll, and a
  // trackpad over a magnified picture is the expected way to change the scale.
  stage.addEventListener('wheel', (event) => {
    if (current === undefined) return
    event.preventDefault()
    handlers.onZoom(zoomStep(current.zoom, (event as WheelEvent).deltaY < 0 ? 1 : -1))
  }, { passive: false })

  // Drag to pan. Pointer capture rather than window listeners: the drag belongs
  // to the picture, and a release outside the window still ends it.
  let dragging: { pointerId: number; x: number; y: number } | undefined
  image.addEventListener('pointerdown', (event) => {
    const pointer = event as PointerEvent
    if (pointer.button !== 0 || current === undefined) return
    dragging = { pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY }
    image.setPointerCapture?.(pointer.pointerId)
    image.classList.add('dragging')
  })
  image.addEventListener('pointermove', (event) => {
    const pointer = event as PointerEvent
    if (dragging === undefined || dragging.pointerId !== pointer.pointerId || current === undefined) return
    panX += pointer.clientX - dragging.x
    panY += pointer.clientY - dragging.y
    dragging = { pointerId: pointer.pointerId, x: pointer.clientX, y: pointer.clientY }
    applyGeometry(current)
  })
  const endDrag = (event: Event) => {
    const pointer = event as PointerEvent
    if (dragging === undefined || dragging.pointerId !== pointer.pointerId) return
    image.releasePointerCapture?.(pointer.pointerId)
    dragging = undefined
    image.classList.remove('dragging')
  }
  image.addEventListener('pointerup', endDrag)
  image.addEventListener('pointercancel', endDrag)

  return {
    show,
    close,
    stageSize() {
      const width = stage.clientWidth
      const height = stage.clientHeight
      if (width <= 0 || height <= 0) return undefined
      return { width, height }
    },
  }
}
