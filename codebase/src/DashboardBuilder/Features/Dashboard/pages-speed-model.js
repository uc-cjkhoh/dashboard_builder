// Pages playback speed (Pages flyout → Speed) — pure, DOM-free (tests/js/pages-speed.test.mjs). `sheet.pages.speed` is one of the names below
// (absent = Medium, the 1.5 s step Play has always used, so older files are untouched). A bad stored value is refused, never clamped.
export const PAGE_SPEEDS = Object.freeze([["slow", "Slow"], ["medium", "Medium"], ["fast", "Fast"]]);
const MS = Object.freeze({ slow: 3000, medium: 1500, fast: 800 });
export const DEFAULT_PAGE_SPEED = "medium";

/** Why a stored speed is refused, or null. */
export const pageSpeedError = (v) => (typeof v === "string" && Object.hasOwn(MS, v) ? null : "Speed must be Slow, Medium or Fast.");
/** The speed a Pages state plays at (Medium when unset or unknown). */
export const pageSpeedOf = (pages) => (pageSpeedError(pages?.speed) === null ? pages.speed : DEFAULT_PAGE_SPEED);
/** Milliseconds between steps while Play runs. */
export const pageIntervalMs = (pages) => MS[pageSpeedOf(pages)];
/** `pages.speed` as a sheet stores it: -> { ok, value } (value null = nothing to store: Medium); for the control's change. */
export function cleanPageSpeed(v) {
  const err = pageSpeedError(v);
  return err ? { ok: false, error: err, value: null } : { ok: true, value: v === DEFAULT_PAGE_SPEED ? null : v };
}
