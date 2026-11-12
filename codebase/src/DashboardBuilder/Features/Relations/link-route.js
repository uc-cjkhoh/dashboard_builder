// Relations/link-route.js — the elbow route of a relationship link between two cards (pure).
// A link leaves a card's side straight out, turns at right angles and enters the other card straight in,
// so cardinality ends always sit square to the card edge. Unit-tested in tests/js/link-route.test.mjs.
export const STUB = 24;   // the straight run out of / into a card before any turn, px
export const CORNER = 8;  // corner radius, px (--r)
export const LANE = 8;    // the shift between links that share a gutter, px
export const FACING_GAP = 32; // the least gutter between two cards for their links to turn inside it, px

/** Which side of each card the link uses: +1 right edge, -1 left edge. `a` and `b` are { left, right }.
 *  Cards with a gutter of at least FACING_GAP face each other; cards that sit closer or overlap both use the right edge. */
export function linkSides(a, b) {
  if (a.right + FACING_GAP <= b.left) return [1, -1];
  if (b.right + FACING_GAP <= a.left) return [-1, 1];
  return [1, 1];
}

/** The corner points of the route from p1 (leaving on side s1) to p2 (entering from side s2), and the label's spot.
 *  Facing cards: the turn (and so the badge) sits in the middle of the gutter, equally far from both cards. Loops: STUB past the farther edge. `lane` (-1, 0, 1) shifts it
 *  8px, so links that share a gutter run side by side instead of on one line. */
export function linkRoute(p1, s1, p2, s2, lane = 0) {
  let x;
  if (s1 === -s2) {
    const left = Math.min(p1.x, p2.x), gap = Math.abs(p2.x - p1.x), inset = Math.min(15, gap / 2); // 15px: the depth of a crow's foot
    x = left + Math.max(inset, Math.min(gap - inset, gap / 2 + lane * LANE));
  } else { // both on one side: loop out past the farther card edge
    x = s1 > 0 ? Math.max(p1.x, p2.x) + STUB + lane * LANE : Math.min(p1.x, p2.x) - STUB - lane * LANE;
  }
  return { points: [p1, { x, y: p1.y }, { x, y: p2.y }, p2], label: { x, y: (p1.y + p2.y) / 2 } };
}

/** An SVG path through `points` with each interior corner rounded to `r` (less where a run is short). */
export function roundedPath(points, r = CORNER) {
  const d = [`M${points[0].x},${points[0].y}`];
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], a = points[i - 1], b = points[i + 1];
    const la = Math.hypot(p.x - a.x, p.y - a.y), lb = Math.hypot(b.x - p.x, b.y - p.y);
    const k = Math.min(r, la / 2, lb / 2);
    if (k <= 0) { d.push(`L${p.x},${p.y}`); continue; }
    const from = { x: p.x + ((a.x - p.x) / la) * k, y: p.y + ((a.y - p.y) / la) * k };
    const to = { x: p.x + ((b.x - p.x) / lb) * k, y: p.y + ((b.y - p.y) / lb) * k };
    d.push(`L${from.x},${from.y}`, `Q${p.x},${p.y} ${to.x},${to.y}`);
  }
  const last = points[points.length - 1];
  d.push(`L${last.x},${last.y}`);
  return d.join(" ");
}

const hits = (b, r) => b.x - b.w / 2 < r.right && b.x + b.w / 2 > r.left && b.y - b.h / 2 < r.bottom && b.y + b.h / 2 > r.top;

/** Where a link's badge (w × h) goes. It stays on the link's vertical run at `spot.x`: first the midpoint, then the nearest spot along the run
 *  that covers neither a card (`cards`: { left, right, top, bottom }) nor an earlier badge (`placed`: { x, y, w, h }). If the whole run is blocked
 *  it returns `under: true` — the badge then goes in the layer beneath the cards, at the midpoint, stepping clear of earlier badges. */
export function placeBadge(spot, y1, y2, w, h, cards, placed) {
  const lo = Math.min(y1, y2), hi = Math.max(y1, y2), step = 8;
  const free = (y) => { const b = { x: spot.x, y, w, h }; return !cards.some((c) => hits(b, c)) && !placed.some((p) => hits(b, { left: p.x - p.w / 2, right: p.x + p.w / 2, top: p.y - p.h / 2, bottom: p.y + p.h / 2 })); };
  for (let d = 0; d <= (hi - lo) / 2; d += step) for (const y of d ? [spot.y - d, spot.y + d] : [spot.y]) if (y >= lo && y <= hi && free(y)) return { x: spot.x, y, under: false };
  let y = spot.y;
  while (placed.some((p) => hits({ x: spot.x, y, w, h }, { left: p.x - p.w / 2, right: p.x + p.w / 2, top: p.y - p.h / 2, bottom: p.y + p.h / 2 }))) y += h + 2;
  return { x: spot.x, y, under: true };
}
