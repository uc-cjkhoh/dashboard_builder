// Applies the workbook theme (Core/store.js currentTheme) to the :root tokens. The default theme
// sets nothing (Core/core.css is the source); any other theme sets the accent + chart-category custom
// properties for the painted colour scheme (Core/scheme.js), and re-applies when the scheme flips.
import { bus, currentTheme } from "./store.js";
import { themeVars, isDefaultTheme, DEFAULT_THEME } from "./theme-model.js";
import { isDark } from "./scheme.js";

const NAMES = Object.keys(themeVars(DEFAULT_THEME, false));

export function initTheme() {
  const apply = () => {
    const root = document.documentElement.style;
    const t = currentTheme();
    if (isDefaultTheme(t)) { for (const n of NAMES) root.removeProperty(n); return; }
    for (const [n, v] of Object.entries(themeVars(t, isDark()))) root.setProperty(n, v);
  };
  bus.addEventListener("theme:changed", apply);
  bus.addEventListener("scheme:changed", apply);
  apply();
}
