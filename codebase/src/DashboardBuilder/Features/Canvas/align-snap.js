// Magnetic alignment for a dragged entity card (pure; unit-tested in tests/js/align-snap.test.mjs).
// While a card is dragged, its top edge is pulled onto the position that makes one of its relationship links a straight
// horizontal line (its pinned key row level with the partner's), when that position is within SNAP_PX of where the pointer put it.
export const SNAP_PX = 12;

/** The card top to use for a pointer-placed top `y`: the nearest of `targets` (card tops that straighten a link) within `reach`, else `y` itself.
 *  Targets are finite numbers; anything else is ignored. */
export function snapTop(y, targets, reach = SNAP_PX) {
  let best = null;
  for (const t of targets) {
    if (!Number.isFinite(t)) continue;
    const d = Math.abs(t - y);
    if (d <= reach && (best === null || d < Math.abs(best - y))) best = t;
  }
  return best ?? y;
}
