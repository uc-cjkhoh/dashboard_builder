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

export const ZOOM_STEP = 1.25; // one click of + / − (or the + / − key): a quarter more or less
export const PAN_STEP = 64;    // one arrow key, screen px (Shift: four times that)

/** The zoom one step in (dir > 0) or out (dir < 0) from `zoom`, rounded to a whole percent so the readout never drifts, held between the limits. */
export function stepZoom(zoom, dir) {
  const next = clampZoom(zoom) * (dir > 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
  return clampZoom(Math.round(next * 100) / 100);
}

/** The view that shows every box (model px: x, y, w, h) inside a view `w` x `h`, `margin` from its edges: as large as fits, never past 100 %, never below
 *  ZOOM_MIN; centred on the cards where they fit, and top-left at the margin where even ZOOM_MIN cannot show them all. No boxes: 100 % at the origin. */
export function fitView(boxes, w, h, margin = 16) {
  const list = (boxes ?? []).filter((b) => b && [b.x, b.y, b.w, b.h].every(Number.isFinite));
  if (!list.length || !(w > 0) || !(h > 0)) return { zoom: 1, pan: { x: 0, y: 0 } };
  const left = Math.min(...list.map((b) => b.x)), top = Math.min(...list.map((b) => b.y));
  const right = Math.max(...list.map((b) => b.x + b.w)), bottom = Math.max(...list.map((b) => b.y + b.h));
  const bw = Math.max(1, right - left), bh = Math.max(1, bottom - top);
  const zoom = clampZoom(Math.min(1, (w - 2 * margin) / bw, (h - 2 * margin) / bh));
  const place = (size, lo, span) => (span * zoom <= size - 2 * margin ? (size - span * zoom) / 2 : margin) - lo * zoom;
  return { zoom, pan: { x: place(w, left, bw), y: place(h, top, bh) } };
}

/** The pan after an arrow key (screen px; the ground follows the key's direction as if the view moved that way). Any other key: unchanged. */
export function panByKey(pan, key, big = false) {
  const d = (big ? 4 : 1) * PAN_STEP;
  const move = { ArrowLeft: [d, 0], ArrowRight: [-d, 0], ArrowUp: [0, d], ArrowDown: [0, -d] }[key];
  return move ? { x: pan.x + move[0], y: pan.y + move[1] } : pan;
}
