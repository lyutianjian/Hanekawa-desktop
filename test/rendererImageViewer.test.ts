import test from 'node:test'
import assert from 'node:assert/strict'

import {
  MAX_ZOOM,
  MIN_ZOOM,
  ZOOM_STEPS,
  canZoomIn,
  canZoomOut,
  clampZoom,
  failImageViewer,
  fitZoom,
  formatZoom,
  openImageViewer,
  settleImageViewer,
  withZoom,
  zoomIn,
  zoomOut,
} from '../src/desktop/renderer/model/imageViewer.js'

/**
 * The fullscreen viewer's state, tested where it lives: `model/imageViewer.ts`
 * is pure, so the ladder, the fit and the staleness guards need no DOM. The
 * view's half — the three dismissals, the drag, the custom properties — is
 * `dom/imageViewerView.ts`'s, against the DOM stub.
 */

test('the fit zoom shows the whole picture and never enlarges', () => {
  // Wider than the stage in both axes: the tighter ratio wins.
  assert.equal(fitZoom({ width: 2000, height: 1000 }, { width: 1000, height: 800 }), 0.5)
  assert.equal(fitZoom({ width: 1000, height: 2000 }, { width: 1000, height: 800 }), clampZoom(0.4))
  // Smaller than the stage: 1, not 4. A thumbnail-sized original opens at its
  // own size and the user zooms in from there.
  assert.equal(fitZoom({ width: 200, height: 200 }, { width: 800, height: 800 }), 1)
  // Degenerate inputs answer 1 rather than 0 or Infinity: the stage has no size
  // before the first layout, and a missing natural size is not a reason to
  // paint nothing.
  assert.equal(fitZoom({ width: 0, height: 0 }, { width: 800, height: 800 }), 1)
  assert.equal(fitZoom({ width: 800, height: 800 }, { width: 0, height: 0 }), 1)
})

test('the ladder steps from anywhere, including between two rungs', () => {
  assert.equal(zoomIn(1), 1.5)
  assert.equal(zoomOut(1), 0.67)
  // The fit zoom almost never lands on a rung, so the first click after opening
  // has to be a real change in both directions.
  assert.equal(zoomIn(0.4), 0.5)
  assert.equal(zoomOut(0.4), 0.33)
  // The ends hold rather than wrapping.
  assert.equal(zoomIn(MAX_ZOOM), MAX_ZOOM)
  assert.equal(zoomOut(MIN_ZOOM), MIN_ZOOM)
  assert.equal(canZoomIn(MAX_ZOOM), false)
  assert.equal(canZoomOut(MIN_ZOOM), false)
  assert.equal(canZoomIn(1), true)
  assert.equal(canZoomOut(1), true)
  // Walking the whole ladder up and back is a round trip, which is the point of
  // fixed steps: the same two clicks always land on the same number.
  let zoom = MIN_ZOOM
  for (let step = 1; step < ZOOM_STEPS.length; step += 1) zoom = zoomIn(zoom)
  assert.equal(zoom, MAX_ZOOM)
  for (let step = 1; step < ZOOM_STEPS.length; step += 1) zoom = zoomOut(zoom)
  assert.equal(zoom, MIN_ZOOM)
})

test('the percentage is rounded, and the factor is clamped', () => {
  assert.equal(formatZoom(0.22), '22%')
  assert.equal(formatZoom(0.217), '22%')
  assert.equal(formatZoom(1), '100%')
  assert.equal(clampZoom(99), MAX_ZOOM)
  assert.equal(clampZoom(0), MIN_ZOOM)
  assert.equal(clampZoom(Number.NaN), 1)
  assert.equal(withZoom(openImageViewer(input()), 99).zoom, MAX_ZOOM)
})

function input() {
  return { imageId: 'img-1', name: 'shot.png', dimensions: '1920×1080', width: 1920, height: 1080, zoom: 0.5 }
}

test('the viewer opens on the thumbnail and settles onto the screen-sized copy', () => {
  // The thumbnail is painted while the real load is still out: `dataUrl` is
  // "what to draw", not "what finished".
  const opened = openImageViewer({ ...input(), thumbUrl: 'data:image/png;base64,AA' })
  assert.equal(opened.status, 'loading')
  assert.equal(opened.dataUrl, 'data:image/png;base64,AA')
  assert.equal(opened.zoom, 0.5)

  const settled = settleImageViewer(opened, 'img-1', 'data:image/png;base64,BB')
  assert.equal(settled?.status, 'ready')
  assert.equal(settled?.dataUrl, 'data:image/png;base64,BB')
  assert.equal(settled?.zoom, 0.5, 'a settle does not move the zoom the user chose')

  // No thumbnail in hand: nothing to draw until the load lands.
  assert.equal(openImageViewer(input()).dataUrl, undefined)
})

test('a settle or a failure for another image, or for no viewer, is dropped', () => {
  const opened = openImageViewer({ ...input(), thumbUrl: 'thumb' })
  assert.equal(settleImageViewer(opened, 'img-2', 'other'), undefined)
  assert.equal(failImageViewer(opened, 'img-2', 'boom'), undefined)
  assert.equal(settleImageViewer(undefined, 'img-1', 'x'), undefined)
  assert.equal(failImageViewer(undefined, 'img-1', 'boom'), undefined)
})

test('a failure keeps the thumbnail already on screen', () => {
  const opened = openImageViewer({ ...input(), thumbUrl: 'thumb' })
  const failed = failImageViewer(opened, 'img-1', '图片文件已丢失')
  assert.equal(failed?.status, 'failed')
  assert.equal(failed?.message, '图片文件已丢失')
  // A blurry picture with a note beside it beats replacing it with an error
  // card the user did not ask for.
  assert.equal(failed?.dataUrl, 'thumb')
})
