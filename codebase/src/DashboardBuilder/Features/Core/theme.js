// Applies the workbook theme (Core/store.js currentTheme) to the :root tokens. The chart-category custom properties
// (--chart-cat-1..8, generated: theme-model.js categoryColour) are always written for the painted colour scheme (Core/scheme.js),
// the default theme included; the accent ones are written for any other theme (the default's are Core/core.css's), and
// everything re-applies when the scheme flips.
import { bus, currentTheme } from "./store.js";
import { themeVars, isDefaultTheme, surfaceOf, DEFAULT_THEME } from "./theme-model.js";
import { isDark } from "./scheme.js";

const NAMES = Object.keys(themeVars(DEFAULT_THEME, false));
const CAT_PREFIX = "--chart-cat-";

export function initTheme() {
  const apply = () => {
    const root = document.documentElement.style;
    const t = currentTheme();
    const look = surfaceOf(t); // dark-mode surfaces: core.css keys them off data-look
    if (look === "default") document.documentElement.removeAttribute("data-look"); else document.documentElement.dataset.look = look;
    const vars = themeVars(t, isDark());
    for (const n of NAMES) { // the default theme leaves the accent to core.css; the chart categories are never left to it
      if (isDefaultTheme(t) && !n.startsWith(CAT_PREFIX)) root.removeProperty(n); else root.setProperty(n, vars[n]);
    }
  };
  bus.addEventListener("theme:changed", apply);
  bus.addEventListener("scheme:changed", apply);
  apply();
}
