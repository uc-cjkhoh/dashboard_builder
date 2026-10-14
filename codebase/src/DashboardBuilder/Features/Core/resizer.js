// Core/resizer.js — a keyboard-accessible drag handle ([role=separator]) that sets an element's width
// through a CSS variable. Used by the sidebar and the worksheet field pane so both resize the same way:
// drag, or ←/→ in 16px steps; the width is clamped to [min, max()] and re-clamped when the window
// shrinks. `clampWidth` is pure (unit-tested under tests/js/).

/** Clamp a width to [min, max] (rounded). A max below min — a very narrow window — yields min. */
export function clampWidth(px, min, max) {
  if (!Number.isFinite(px)) return min;
  return Math.round(Math.max(min, Math.min(Math.max(min, max), px)));
}

/**
 * Wire a resize handle.
 * @param handle   the [role=separator] element
 * @param opts.min        minimum width (px)
 * @param opts.max        () → maximum width (px), read on every change
 * @param opts.origin     () → x of the resized element's left edge (pointer x − origin = width)
 * @param opts.current    () → the element's current rendered width (0 while it isn't displayed)
 * @param opts.apply      (px) → sets the width (e.g. a CSS variable)
 * @param opts.active     () → false to skip the window-resize re-clamp (e.g. sidebar collapsed)
 * @param opts.storageKey optional localStorage key to remember the width in this browser
 */
export function wireResizer(handle, { min, max, origin, current, apply, active = () => true, storageKey = null }) {
  const set = (px) => {
    const w = clampWidth(px, min, max());
    apply(w);
    handle.setAttribute("aria-valuenow", String(w));
    handle.setAttribute("aria-valuemin", String(min));
    handle.setAttribute("aria-valuemax", String(Math.max(min, Math.round(max()))));
    return w;
  };
  const remember = (w) => {
    if (!storageKey) return;
    try { localStorage.setItem(storageKey, String(w)); } catch { /* not remembered — fine */ }
  };

  if (storageKey) {
    let saved = null;
    try { saved = Number(localStorage.getItem(storageKey)); } catch { /* storage blocked */ }
    if (saved) apply(clampWidth(saved, min, Number.POSITIVE_INFINITY)); // re-clamped once it is displayed
  }

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("is-resizing");
    let last = current();
    const move = (e) => { last = set(e.clientX - origin()); };
    const up = () => {
      document.body.classList.remove("is-resizing");
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      remember(last);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });

  handle.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowLeft" ? -16 : event.key === "ArrowRight" ? 16 : 0;
    if (!step) return;
    event.preventDefault();
    remember(set(current() + step));
  });

  // Keep within bounds if the window shrinks (skipped while the element isn't displayed or is inactive).
  window.addEventListener("resize", () => { const w = current(); if (w && active()) set(w); });
}
