// Core/context-menu-model.js — pure rules for the right-click / keyboard context popup (Core/menu.js openContextMenu).
const GAP = 8; // --s2: the closest the popup sits to a viewport edge

/** Where a popup of this size goes so it stays inside the viewport (it is moved, never resized, unless larger than the viewport). */
export function placeMenu({ x, y, width, height, viewW, viewH, avoid = null }) {
  const clamp = (v, size, view) => Math.max(GAP, Math.min(v, view - size - GAP > GAP ? view - size - GAP : GAP));
  const at = { left: x + width + GAP > viewW ? clamp(x, width, viewW) : x, top: y + height + GAP > viewH ? clamp(y, height, viewH) : y };
  // Keep off a rectangle the user is working in (the open tool flyout): beside it when there is room, else as placed.
  if (avoid && at.left < avoid.right && at.left + width > avoid.left && at.top < avoid.bottom && at.top + height > avoid.top) {
    if (avoid.right + GAP + width + GAP <= viewW) at.left = avoid.right + GAP;
    else if (avoid.left - GAP - width >= GAP) at.left = avoid.left - GAP - width;
  }
  return at;
}

/** Does this keydown ask for the context popup? The ContextMenu key and Shift+F10 anywhere on the element; Enter only on the element itself (an inner button keeps its own Enter). */
export function opensContext(e) {
  if (e.key === "ContextMenu") return true;
  if (e.key === "F10") return Boolean(e.shiftKey);
  return e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && e.target === e.currentTarget;
}

/** The menu item to focus after `key`, from the focused index (-1 = none); wraps around. */
export function nextFocus(index, count, key) {
  if (!count) return -1;
  if (key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return index;
}
