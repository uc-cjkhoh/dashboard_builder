// P41 workbook themes — pure, DOM-free (unit-tested in tests/js/theme-model.test.mjs). A theme is
// { accent: <preset id> | "#rrggbb", palette: <palette id> }, saved in the workbook. It overrides the
// accent and chart-category tokens of Core/core.css in light and dark; everything else (surfaces, ink,
// status colours) stays. Every accent here keeps white button text ≥ 4.5:1 on the accent, accent text
// ≥ 4.5:1 on the surface and the accent ≥ 3:1 against the surface, in both schemes.
import { contrastRatio } from "../Dashboard/contrast.js";

export const SURFACE = { light: "#ffffff", dark: "#1c181b" };
export const ON_ACCENT = "#ffffff";

// accent, hover, pressed, ink (accent-coloured text), soft (tinted background), line (tinted border)
const A = (accent, hover, pressed, ink, soft, line) => ({ accent, hover, pressed, ink, soft, line });
export const ACCENTS = Object.freeze({
  crimson: { label: "Crimson", light: A("#c4142c", "#a8102a", "#8c0d22", "#b01229", "#fdeff1", "#f3c3ca"),
    dark: A("#d42a3c", "#b81f30", "#9c1828", "#ff8f99", "#3a1a20", "#6b2a33") },
  blue: { label: "Blue", light: A("#1d5fc4", "#1a54ad", "#164894", "#1a56b3", "#edf3fd", "#c3d6f5"),
    dark: A("#2a66cc", "#245ab5", "#1f4e9c", "#8ab8ff", "#172238", "#2a4470") },
  teal: { label: "Teal", light: A("#0b6f6a", "#095f5b", "#074f4c", "#0a6a65", "#e8f6f5", "#b5e0dd"),
    dark: A("#28807c", "#23716d", "#1e615e", "#5fd4cc", "#12282a", "#1f4d4b") },
  violet: { label: "Violet", light: A("#6d3fd1", "#5f35b8", "#522d9f", "#6236c4", "#f3eefd", "#d8c9f6"),
    dark: A("#815cdb", "#7251c1", "#6246a6", "#b9a0ff", "#241c38", "#45366e") },
  graphite: { label: "Graphite", light: A("#3d4451", "#333944", "#292e37", "#3d4451", "#eff1f4", "#cdd2d9"),
    dark: A("#6d7582", "#606772", "#535963", "#c4cbd6", "#23262c", "#41464f") },
});

// Eight categorical chart colours per scheme, in a fixed order (never cycled within one chart).
export const PALETTES = Object.freeze({
  default: { label: "Default",
    light: ["#2a78d6", "#008300", "#e87ba4", "#eda100", "#1baf7a", "#eb6834", "#4a3aa7", "#e34948"],
    dark: ["#4d95ea", "#3ba55c", "#f08fb6", "#f5b83d", "#2ec48c", "#f2834f", "#9d8cf2", "#f26b6a"] },
  okabe: { label: "Colour-blind safe",
    light: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#000000"],
    dark: ["#56b4e9", "#e69f00", "#009e73", "#cc79a7", "#0072b2", "#d55e00", "#f0e442", "#bbbbbb"] },
  muted: { label: "Muted",
    light: ["#4e79a7", "#f28e2b", "#59a14f", "#b07aa1", "#76b7b2", "#edc948", "#9c755f", "#bab0ac"],
    dark: ["#6b93c0", "#f5a04f", "#73b86a", "#c495b6", "#8ccbc6", "#f1d36d", "#b9927c", "#cfc7c3"] },
});

export const DEFAULT_THEME = Object.freeze({ accent: "crimson", palette: "default" });
const HEX = /^#[0-9a-f]{6}$/i;

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, "0")).join("");
};
// Step `hex` toward `to` until `ok(colour)` holds (or give up at `to`).
function until(hex, to, ok) {
  for (let t = 0; t <= 1.0001; t += 0.02) {
    const c = mix(hex, to, Math.min(1, t));
    if (ok(c)) return c;
  }
  return to;
}

/**
 * A custom accent's token set for light and dark, or { error } with the reason. White button text must
 * stay ≥ 4.5:1 on it; in dark mode it is lifted (toward white) until it stands ≥ 3:1 off the surface, and
 * refused if no shade does both. Accent-coloured text is derived to reach 4.5:1 on the surface and on
 * the tinted (soft) background.
 */
export function deriveAccent(hex) {
  if (!HEX.test(hex ?? "")) return { error: "Enter a colour as #rrggbb." };
  const h = hex.toLowerCase();
  if (contrastRatio(ON_ACCENT, h) < 4.5) return { error: "That colour is too light for white button text — pick a darker one." };
  const darkAccent = until(h, "#ffffff", (c) => contrastRatio(c, SURFACE.dark) >= 3);
  if (contrastRatio(ON_ACCENT, darkAccent) < 4.5) return { error: "That colour is too dark to stand out in dark mode — pick a brighter one." };
  const scheme = (accent, surface, inkTo, softT, lineT) => {
    const soft = mix(surface, accent, softT);
    const ink = until(accent, inkTo, (c) => contrastRatio(c, surface) >= 4.5 && contrastRatio(c, soft) >= 4.5);
    return A(accent, mix(accent, "#000000", 0.12), mix(accent, "#000000", 0.24), ink, soft, mix(surface, accent, lineT));
  };
  return { light: scheme(h, SURFACE.light, "#000000", 0.08, 0.3), dark: scheme(darkAccent, SURFACE.dark, "#ffffff", 0.18, 0.4) };
}

/** The accent token set for a theme and scheme (custom colours derived; unknown → crimson). */
export function accentSet(theme, dark) {
  const key = dark ? "dark" : "light";
  const a = theme?.accent;
  if (a && ACCENTS[a]) return ACCENTS[a][key];
  if (HEX.test(a ?? "")) { const d = deriveAccent(a); if (!d.error) return d[key]; }
  return ACCENTS.crimson[key];
}

/** The CSS custom properties a theme sets on :root for one scheme. */
export function themeVars(theme, dark) {
  const s = accentSet(theme, dark);
  const cats = (PALETTES[theme?.palette] ?? PALETTES.default)[dark ? "dark" : "light"];
  const vars = { "--accent": s.accent, "--accent-hover": s.hover, "--accent-pressed": s.pressed,
    "--accent-ink": s.ink, "--accent-soft": s.soft, "--accent-line": s.line };
  cats.forEach((c, i) => { vars[`--chart-cat-${i + 1}`] = c; });
  return vars;
}

/** Whether a theme is the default (nothing to set). */
export const isDefaultTheme = (t) => !t || (t.accent === DEFAULT_THEME.accent && t.palette === DEFAULT_THEME.palette);

/** A saved theme, checked: known preset or a valid custom colour, known palette — else default + an issue. */
export function cleanTheme(raw, issues = []) {
  if (raw == null) return { ...DEFAULT_THEME };
  const okAccent = raw && (ACCENTS[raw.accent] || (HEX.test(raw.accent ?? "") && !deriveAccent(raw.accent).error));
  const okPalette = raw && PALETTES[raw.palette];
  if (!okAccent || !okPalette) issues.push("The theme couldn't be used — reset to the default.");
  return okAccent && okPalette ? { accent: ACCENTS[raw.accent] ? raw.accent : raw.accent.toLowerCase(), palette: raw.palette }
    : { ...DEFAULT_THEME };
}
