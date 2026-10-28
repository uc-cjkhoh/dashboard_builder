// Light / dark scheme — pure, DOM-free (unit-tested in tests/js/scheme.test.mjs). The viewer picks
// System (follow the OS), Light or Dark; the choice is remembered in this browser, never in the
// workbook. Core/scheme-boot.js repeats resolveScheme in a classic script so the first paint is right.
export const STORAGE_KEY = "dashboardbuilder.scheme";

export const SCHEME_PREFS = Object.freeze([
  { id: "system", label: "System", icon: "monitor" },
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
]);

/** A stored value, or "system" when it is missing or unknown. */
export function normalizePref(v) { return SCHEME_PREFS.some((p) => p.id === v) ? v : "system"; }

/** The scheme to paint: an explicit choice wins; System follows the OS. */
export function resolveScheme(pref, osDark) {
  const p = normalizePref(pref);
  return p === "system" ? (osDark ? "dark" : "light") : p;
}
