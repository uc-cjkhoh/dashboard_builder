// Core/motion.js — the few transitions CSS can't express: animating an element *into* `hidden`, and
// animating only the first appearance of something that is re-rendered on every change (a tool
// panel, a newly added pill). Fluent-style: entrances decelerate, exits accelerate and are quicker;
// only opacity + transform. Every helper is a no-op under prefers-reduced-motion. Durations mirror
// the core.css tokens (--dur-fast enter, --dur-exit exit, --dur view).
export const MOTION = Object.freeze({
  enter: 150, exit: 100, view: 200,
  morph: 300, // a modal growing out of its trigger (JS-only, so no CSS token); it folds back in `view` (200)
  easeOut: "cubic-bezier(.1, .9, .2, 1)", // = --ease-out
  easeIn: "cubic-bezier(.5, 0, .75, 0)",  // = --ease-in
  easeMorph: "cubic-bezier(.2, 0, 0, 1)",       // a morph covers distance: it must still be travelling at 15% of its time, where --ease-out has already arrived
  easeMorphOut: "cubic-bezier(.3, 0, .8, .15)", // the fold back: leaves slowly, arrives fast
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

// ---- Morph: a modal dialog grows out of the control that opened it, and folds back into it -------------------------------------
// The dialog is revealed through a clip window (not scaled, so its text is never stretched): the window starts as the trigger's
// size, centred in the dialog, while the dialog itself starts centred on the trigger; both ease to rest together, and the content
// fades in behind the growing window. clip-path is paint-only (no layout), the one animated property here beyond opacity/transform.
const REST_CLIP = "inset(-64px round 8px)"; // wide enough that the dialog's own shadow (--elev-28) is not cut off; paints as no clip

/** The first / last frame of a morph between a trigger's box and the dialog's box ({ left, top, width, height } each). Pure. */
export function morphFrame(trigger, dialog, radius = 8) {
  const dx = trigger.left + trigger.width / 2 - (dialog.left + dialog.width / 2);
  const dy = trigger.top + trigger.height / 2 - (dialog.top + dialog.height / 2);
  const ix = Math.max(0, (dialog.width - trigger.width) / 2), iy = Math.max(0, (dialog.height - trigger.height) / 2);
  return { transform: `translate(${dx}px, ${dy}px)`, clipPath: `inset(${iy}px ${ix}px ${iy}px ${ix}px round ${radius}px)` };
}
const REST = { transform: "translate(0px, 0px)", clipPath: REST_CLIP };
const usable = (r) => r && r.width > 0 && r.height > 0 && Number.isFinite(r.left) && Number.isFinite(r.top);

/** Grow a just-opened modal out of `trigger` (a DOMRect). Returns the Animation, or null when skipped (reduced motion, no usable box). */
export function morphIn(dlg, trigger) {
  if (!dlg?.animate || reducedMotion() || !usable(trigger)) return null;
  dlg.style.animation = "none"; // the dialog's own entrance keyframes would fight this one
  dlg.style.willChange = "transform, clip-path"; // its own layer for the length of the morph, so the content is painted once, not every frame
  const a = dlg.animate([morphFrame(trigger, dlg.getBoundingClientRect()), REST], { duration: MOTION.morph, easing: MOTION.easeMorph });
  for (const c of dlg.children) c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: MOTION.morph * .6, delay: MOTION.morph * .25, easing: MOTION.easeOut, fill: "backwards" });
  a?.finished?.then(() => { dlg.style.willChange = ""; }, () => { dlg.style.willChange = ""; });
  return a;
}

/** Fold a modal back into `trigger` (a DOMRect); resolves when done (at once when skipped). The caller then closes and removes it. */
export async function morphOut(dlg, trigger) {
  if (!dlg?.animate || reducedMotion() || !usable(trigger)) return;
  dlg.style.animation = "none";
  dlg.style.willChange = "transform, clip-path";
  const a = dlg.animate([REST, morphFrame(trigger, dlg.getBoundingClientRect())], { duration: MOTION.view, easing: MOTION.easeMorphOut, fill: "forwards" });
  for (const c of dlg.children) c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.view * .5, easing: MOTION.easeIn, fill: "forwards" });
  try { dlg.animate([{ opacity: 1 }, { opacity: 0 }], { duration: MOTION.view, easing: MOTION.easeIn, fill: "forwards", pseudoElement: "::backdrop" }); } catch { /* no ::backdrop animation: the scrim just goes with the dialog */ }
  try { await a.finished; } catch { /* cancelled */ }
}
