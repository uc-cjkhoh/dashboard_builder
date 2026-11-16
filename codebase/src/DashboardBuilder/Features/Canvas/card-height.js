// Entity card height: dragging the card's top or bottom edge sets how tall its column list is. Pure: unit-tested
// in tests/js/card-height.test.mjs; canvas.js wires the edge handles and measures the list.
export const LIST_MIN = 64;     // about two column rows: the list never shrinks to nothing
export const LIST_DEFAULT = 240; // the list's height until the user drags an edge (canvas.css .entity__cols max-height)
export const LIST_MAX = 4000;    // the most a saved workbook may ask for (workbook-model.js)
const STEP = 8;                  // the canvas grid: a top-edge drag keeps the card's top on it

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** The list height (and card top) for an edge drag of `dy` model px. `fit` is the list's full content height: the list
 *  never grows past it (no empty rows). The bottom edge moves the bottom; the top edge moves the top and keeps the
 *  bottom where it was. Heights step on the 8px grid. */
export function dragListHeight({ edge, startH, startY, dy, fit }) {
  let hi = Math.max(STEP, Math.min(LIST_MAX, Number.isFinite(fit) ? fit : LIST_MAX));
  if (edge === "top") hi = Math.max(Math.min(startH, hi), Math.min(hi, startH + startY)); // the top stops at the canvas origin (cards never sit at a negative y)
  const lo = Math.min(LIST_MIN, hi);
  const raw = edge === "top" ? startH - dy : startH + dy;
  const h = clamp(Math.round(raw / STEP) * STEP, lo, hi);
  if (edge !== "top") return { h, y: startY };
  return { h, y: Math.max(0, startY + (startH - h)) };
}

/** A saved list height: a whole number of px between LIST_MIN and LIST_MAX, else null (the card uses the default). */
export function cleanListHeight(v) {
  return Number.isInteger(v) && v >= LIST_MIN && v <= LIST_MAX ? v : null;
}
