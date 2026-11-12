// Data Source canvas zoom (pure; unit-tested in tests/js/canvas-zoom.test.mjs).
// Cards keep their model coordinates (entity.x / entity.y); the view shows them at `zoom` times that size,
// so every on-screen measure is a model measure x zoom, plus a pan offset (an open ground: the view is never limited to the cards' extent).
// Wheel zoom keeps the model point under the pointer fixed.
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 2;
const WHEEL_RATE = 0.0015; // zoom factor per wheel delta unit (pixel mode)

export const clampZoom = (z) => (Number.isFinite(z) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)) : 1);

/** The wheel delta in pixels, whatever the event's deltaMode (0 pixels, 1 lines, 2 pages). */
export function wheelPixels(deltaY, deltaMode) {
  if (!Number.isFinite(deltaY)) return 0;
  return deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
}

/** The next zoom for a wheel turn (up = zoom in), held between ZOOM_MIN and ZOOM_MAX. */
export function wheelZoom(zoom, deltaY, deltaMode = 0) {
  return clampZoom(zoom * Math.exp(-wheelPixels(deltaY, deltaMode) * WHEEL_RATE));
}

/** The pan (px offset of the model origin from the view's top-left) that keeps the model point under `cursor` (px from the view's top-left) still while zoom goes from `from` to `to`. */
export function panForZoom(pan, cursor, from, to) {
  const k = to / from;
  return { x: cursor.x - (cursor.x - pan.x) * k, y: cursor.y - (cursor.y - pan.y) * k };
}

/** The smallest pan change that brings `box` (screen px, view-relative: left, top, right, bottom) inside a view `w` x `h`, `margin` from the edges (a box bigger than the view lines up its top-left). */
export function panToReveal(pan, box, w, h, margin = 16) {
  const shift = (lo, hi, size) => (lo < margin ? margin - lo : hi > size - margin ? Math.max(size - margin - hi, margin - lo) : 0);
  return { x: pan.x + shift(box.left, box.right, w), y: pan.y + shift(box.top, box.bottom, h) };
}

/** A pointer movement of `px` screen pixels as a model distance. */
export const toModel = (px, zoom) => px / zoom;
