// Pure rules for the app's tooltip (Core/hover-tip.js): where it goes and how long it waits.

export const SHOW_DELAY = 400;  // ms the pointer rests on a control before its tooltip shows
export const GRACE = 300;       // ms after one tooltip hides in which the next control's shows at once (sweeping along a toolbar)

/** Delay before showing: none while one is up or just went away, else SHOW_DELAY. */
export function delayFor({ visible, sinceHiddenMs }) {
  return visible || sinceHiddenMs < GRACE ? 0 : SHOW_DELAY;
}

/**
 * Position of a tooltip of `width` x `height` for an anchor rectangle: centred under it, 8px away, flipped above when it would not fit
 * below and does fit above, and kept `margin` inside the viewport on every side.
 */
export function placeTip({ anchor, width, height, viewW, viewH, gap = 8, margin = 8 }) {
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - height;
  const fitsBelow = below + height <= viewH - margin;
  const side = !fitsBelow && above >= margin ? "above" : "below";
  const top = side === "above" ? above : Math.max(margin, Math.min(below, viewH - margin - height));
  const centred = (anchor.left + anchor.right) / 2 - width / 2;
  const left = Math.max(margin, Math.min(centred, viewW - margin - width));
  return { left: Math.round(left), top: Math.round(top), side };
}
