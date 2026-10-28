// The board's pointer state machine — pure and DOM-free (tests/js/board-drag.test.mjs). board-interact.js feeds it pointer points
// (relative to the grid, so scrolling the canvas mid-drag is already accounted for) and draws the ghost it describes.
//
//   idle ──start(mode, widget, point)──▶ pressed ──move past DRAG_THRESHOLD──▶ dragging ──end──▶ commit | revert | none
//                                           └─────────── end / cancel (no movement) ──▶ none        cancel ──▶ idle
//
// A press that never travels DRAG_THRESHOLD px is a click, not a drag. While dragging, each move yields the target cells
// (`cand`), their pixel rectangle (`rect`) and whether the drop would be accepted (`error` null) — one verdict for the ghost
// and for the drop. A refused drop is a `revert` with the reason; the widget is never put anywhere else.
import { cellAt, cellRect, isStacked, snapMove, snapResize } from "./board-layout.js";
import { explainRefusal, placeAt } from "./board-model.js";

export const DRAG_THRESHOLD = 4; // px of pointer travel before a press becomes a drag

const same = (a, b) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/** The ghost for a candidate among `widgets`: { cand, rect, error } (error null = the drop would be accepted). */
export function ghostFor(widgets, cand, verb, ctx) {
  return { cand, rect: cellRect(cand, ctx.panelWidth, ctx.metrics), error: explainRefusal(widgets, cand, verb, ctx.nameOf) };
}

/** A worksheet / text widget being dragged in from the side panel, pointer at `point`. Stacked (narrow) canvases have no cells. */
export function dropPlan(widgets, kind, point, ctx) {
  if (isStacked(ctx.panelWidth)) return { cand: null, rect: null, error: "Can't place: the canvas is too narrow to drop on — use Add." };
  const spot = placeAt(widgets, kind, cellAt(point, ctx.panelWidth, ctx.metrics), ctx.nameOf);
  if (!spot.ok) return { cand: spot.cand ?? null, rect: spot.cand ? cellRect(spot.cand, ctx.panelWidth, ctx.metrics) : null, error: spot.error };
  return { cand: spot.cand, rect: cellRect(spot.cand, ctx.panelWidth, ctx.metrics), error: null };
}

export function createDrag() {
  let s = null; // { mode, widget, origin, dragging }
  return {
    get active() { return Boolean(s?.dragging); },
    get pressed() { return s !== null; },
    get mode() { return s?.mode ?? null; },
    /** Begin on a pointer press: `mode` "move" (header) or "resize" (corner); `point` is grid-relative. A stacked canvas has no drag. */
    start(mode, widget, point, panelWidth) {
      if (s || isStacked(panelWidth)) return false;
      s = { mode, widget: { ...widget }, origin: point, dragging: false };
      return true;
    },
    /** A pointer move → the ghost, or null while still within the click threshold (or idle). */
    move(point, ctx) {
      if (!s) return null;
      const dx = point.x - s.origin.x, dy = point.y - s.origin.y;
      if (!s.dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return null;
        s.dragging = true;
      }
      const cand = (s.mode === "move" ? snapMove : snapResize)(s.widget, dx, dy, ctx.panelWidth, ctx.metrics);
      return ghostFor(ctx.widgets, cand, s.mode, ctx);
    },
    /** Pointer released: { type: "none" } (a click, or dropped where it started), { type: "commit", cand } or { type: "revert", cand, error }. */
    end(point, ctx) {
      const cur = s;
      s = null;
      if (!cur?.dragging) return { type: "none" };
      const cand = (cur.mode === "move" ? snapMove : snapResize)(cur.widget, point.x - cur.origin.x, point.y - cur.origin.y, ctx.panelWidth, ctx.metrics);
      if (same(cand, cur.widget)) return { type: "none" };
      const error = explainRefusal(ctx.widgets, cand, cur.mode, ctx.nameOf);
      return error ? { type: "revert", cand, error, mode: cur.mode } : { type: "commit", cand, mode: cur.mode };
    },
    /** pointercancel, lost capture, blur, Esc: forget the gesture; nothing changes. */
    cancel() { const was = s?.dragging ?? false; s = null; return was; },
  };
}
