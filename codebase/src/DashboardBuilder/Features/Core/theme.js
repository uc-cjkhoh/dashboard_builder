// Applies the workbook theme (Core/store.js currentTheme) to the :root tokens. The default theme
// sets nothing (Core/core.css is the source); any other theme sets the accent + chart-category custom
// properties for the painted colour scheme (Core/scheme.js), and re-applies when the scheme flips.
import { bus, currentTheme } from "./store.js";
import { themeVars, isDefaultTheme, surfaceOf, DEFAULT_THEME } from "./theme-model.js";
import { isDark } from "./scheme.js";

const NAMES = Object.keys(themeVars(DEFAULT_THEME, false));

export function initTheme() {
  const apply = () => {
    const root = document.documentElement.style;
    const t = currentTheme();
    const look = surfaceOf(t); // dark-mode surfaces: core.css keys them off data-look
    if (look === "default") document.documentElement.removeAttribute("data-look"); else document.documentElement.dataset.look = look;
    if (isDefaultTheme(t)) { for (const n of NAMES) root.removeProperty(n); return; }
    for (const [n, v] of Object.entries(themeVars(t, isDark()))) root.setProperty(n, v);
  };
  bus.addEventListener("theme:changed", apply);
  bus.addEventListener("scheme:changed", apply);
  apply();
}
