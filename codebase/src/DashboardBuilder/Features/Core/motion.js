// Core/motion.js — the few transitions CSS can't express: animating an element *into* `hidden`, and
// animating only the first appearance of something that is re-rendered on every change (a tool
// panel, a newly added pill). Fluent-style: entrances decelerate, exits accelerate and are quicker;
// only opacity + transform. Every helper is a no-op under prefers-reduced-motion. Durations mirror
// the core.css tokens (--dur-fast enter, --dur-exit exit, --dur view).
export const MOTION = Object.freeze({
  enter: 150, exit: 100, view: 200,
  easeOut: "cubic-bezier(.1, .9, .2, 1)", // = --ease-out
  easeIn: "cubic-bezier(.5, 0, .75, 0)",  // = --ease-in
});

export const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Fade + slide (and optionally scale) an element in. Returns the Animation, or null when skipped. */
export function enter(el, { y = -4, scale = 1, duration = MOTION.enter } = {}) {
  if (!el?.animate || reducedMotion()) return null;
  return el.animate(
    [{ opacity: 0, transform: `translateY(${y}px) scale(${scale})` }, { opacity: 1, transform: "none" }],
    { duration, easing: MOTION.easeOut },
  );
}

/** Fade an element out; resolves when done (or at once when skipped). The caller then hides/removes it. */
export async function exit(el, { y = -2, scale = 1, duration = MOTION.exit } = {}) {
  if (!el?.animate || reducedMotion()) return;
  const a = el.animate(
    [{ opacity: 1, transform: "none" }, { opacity: 0, transform: `translateY(${y}px) scale(${scale})` }],
    { duration, easing: MOTION.easeIn, fill: "forwards" },
  );
  try { await a.finished; } catch { /* cancelled */ }
  a.cancel(); // drop the fill so a later show starts from the element's own styles
}
