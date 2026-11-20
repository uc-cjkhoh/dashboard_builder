// Light / dark scheme — pure, DOM-free (unit-tested in tests/js/scheme.test.mjs). The viewer picks
// Light or Dark; the choice is remembered in this browser, never in the workbook, and the OS setting is
// not read. Light is the default. Core/scheme-boot.js repeats the fallback in a classic script so the
// first paint is right.
export const STORAGE_KEY = "dashboardbuilder.scheme";

export const SCHEME_PREFS = Object.freeze([
  { id: "light", label: "Light", icon: "sun" },
  { id: "dark", label: "Dark", icon: "moon" },
]);

/** A stored value, or "light" when it is missing or unknown (a retired "system" included). */
export function normalizePref(v) { return SCHEME_PREFS.some((p) => p.id === v) ? v : "light"; }
