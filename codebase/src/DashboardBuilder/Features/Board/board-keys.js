// Keyboard moves and resizes of a focused widget — pure (tests/js/board-keys.test.mjs). Arrows move by one cell; Shift + arrows
// resize by one cell from the bottom-right corner (Right / Down grow, Left / Up shrink). Each press is one committed step; the
// result is a status message in the user's words, a refusal included. Nothing is clamped: a step that doesn't fit is refused.
import { explainRefusal } from "./board-model.js";

const ARROWS = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The announcements for a committed move / resize (also used by the pointer path). */
export const movedMessage = (c) => `Moved to column ${c.x + 1}, row ${c.y + 1}`;
export const resizedMessage = (c) => `Resized to ${plural(c.w, "column")} by ${plural(c.h, "row")}`;

/** null when `key` isn't an arrow; else { ok: true, cand, message } or { ok: false, message }. `nameOf` names an overlapped widget. */
export function keyStep(widgets, widget, key, shift, nameOf) {
  const d = ARROWS[key];
  if (!d) return null;
  const verb = shift ? "resize" : "move";
  const cand = shift ? { ...widget, w: widget.w + d[0], h: widget.h + d[1] } : { ...widget, x: widget.x + d[0], y: widget.y + d[1] };
  const error = explainRefusal(widgets, cand, verb, nameOf);
  if (error) return { ok: false, message: error };
  return { ok: true, cand, message: shift ? resizedMessage(cand) : movedMessage(cand) };
}
