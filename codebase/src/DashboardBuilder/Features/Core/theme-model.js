// Workbook themes — pure, DOM-free (unit-tested in tests/js/theme-model.test.mjs). A theme is
// { accent: <preset id> | "#rrggbb", palette: <palette id> }, saved in the workbook. It overrides the
// accent and chart-category tokens of Core/core.css in light and dark; everything else (surfaces, ink,
// status colours) stays. Every accent here keeps white button text ≥ 4.5:1 on the accent, accent text
// ≥ 4.5:1 on the surface and the accent ≥ 3:1 against the surface, in both schemes.
import { contrastRatio } from "../Dashboard/contrast.js";

export const SURFACE = { light: "#ffffff", dark: "#1a1b1d" };
export const ON_ACCENT = "#ffffff";
export const ON_DARK = "#12130f"; // text on a light accent state (the Signal lime already uses it)
export const LIFT_HOVER = 0.14, LIFT_PRESSED = 0.28; // how far hover / pressed lift toward white

const mix = (a, b, t) => {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return "#" + x.map((c, i) => Math.round(c + (y[i] - c) * t).toString(16).padStart(2, "0")).join("");
};
// accent, ink (accent-coloured text), soft (tinted background), line (tinted border), on (text on the accent).
// Hover and pressed are *brighter* than the accent — lifted toward white (LIFT_HOVER, LIFT_PRESSED). The text on each state is the
// accent's own `on` while that still holds 4.5:1, else dark (ON_DARK): a lighter fill can outgrow white text.
const A = (accent, ink, soft, line, on = ON_ACCENT) => {
  // The lifted shade and the text on it: the accent's own `on` while it holds 4.5:1, else dark. In the mid-tones neither does, so
  // the lift goes on a little further (brighter still) until one does.
  const lifted = (from) => {
    for (let t = from; t <= 1.0001; t += 0.02) {
      const bg = mix(accent, "#ffffff", Math.min(1, t));
      const text = [on, ON_DARK].find((c) => contrastRatio(c, bg) >= 4.5);
      if (text) return { t, bg, text };
    }
    return { t: 1, bg: "#ffffff", text: ON_DARK };
  };
  const h = lifted(LIFT_HOVER), p = lifted(h.t + LIFT_PRESSED - LIFT_HOVER);
  return { accent, hover: h.bg, pressed: p.bg, ink, soft, line, on, onHover: h.text, onPressed: p.text };
};
export const ACCENTS = Object.freeze({
  // Signal: one sage-lime hue in both schemes — deep olive on paper, calm lime on charcoal. `on` is the text on the accent (dark on the lime), `signal` the lime that tints the wash.
  signal: { label: "Signal", light: { ...A("#566a17", "#566a17", "#f1f4e2", "#d3dbae"), signal: "#c3df5a" },
    dark: { ...A("#a9bd6a", "#a9bd6a", "#262a17", "#4a5427", "#12130f"), signal: "#c3df5a" } },
  ultramarine: { label: "Ultramarine", light: A("#3340d1", "#2b36b8", "#eff0fb", "#ccd0f2"),
    dark: A("#5460c4", "#98a1d8", "#1f2449", "#353d75") },
  monospace: { label: "Monospace", light: A("#6f4cde", "#6340cf", "#f3effd", "#d6c9f6"),
    dark: A("#7b5ae0", "#b3a0ee", "#252046", "#4b3a86") },
  crimson: { label: "Crimson", light: A("#b82035", "#a51d31", "#fcf0f2", "#f3c3ca"),
    dark: A("#d42a3c", "#eea0a7", "#3a1a20", "#6b2a33") },
  blue: { label: "Blue", light: A("#2260bf", "#1f57ae", "#eef3fc", "#c4d6f4"),
    dark: A("#4672c8", "#9cbced", "#172238", "#2a4470") },
  teal: { label: "Teal", light: A("#126863", "#11635e", "#e8f6f5", "#b5e0dd"),
    dark: A("#28807c", "#5fd4cc", "#12282a", "#1f4d4b") },
  violet: { label: "Violet", light: A("#6d3fd1", "#6236c4", "#f3effc", "#d8c9f6"),
    dark: A("#815cdb", "#c0aef1", "#241c38", "#45366e") },
  onedark: { label: "One Dark", light: A("#2260bf", "#1f57ae", "#eef3fc", "#c4d6f4"),
    dark: A("#456fc8", "#6aa8e0", "#262f45", "#3d5a94") },
  graphite: { label: "Graphite", light: A("#3d4451", "#3d4451", "#eff1f4", "#cdd2d9"),
    dark: A("#6d7582", "#c4cbd6", "#23262c", "#41464f") },
});

// Eight categorical chart colours per scheme, in a fixed order (never cycled within one chart).
export const PALETTES = Object.freeze({
  default: { label: "Default",
    light: ["#72872a", "#b8559c", "#d9a03a", "#7c63d6", "#2f9ea8", "#3f7fd0", "#4aa66a", "#6a6d72"],
    dark: ["#a9bd6a", "#d98ac2", "#deb062", "#9b86e6", "#5cc0c8", "#7aa3dc", "#6fc486", "#8e9094"] },
  okabe: { label: "Colour-blind safe",
    light: ["#0072b2", "#e69f00", "#009e73", "#cc79a7", "#56b4e9", "#d55e00", "#f0e442", "#000000"],
    dark: ["#56b4e9", "#e69f00", "#009e73", "#cc79a7", "#0072b2", "#d55e00", "#f0e442", "#bbbbbb"] },
  onedark: { label: "One Dark Pro",
    light: ["#2a78d6", "#146f14", "#e87ba4", "#c99424", "#1eac79", "#de6e41", "#4a3aa7", "#b8559c"],
    dark: ["#6aa8e0", "#98c379", "#c678dd", "#e5c07b", "#56b6c2", "#d19a66", "#abb2bf", "#d68fc0"] },
  muted: { label: "Muted",
    light: ["#4e79a7", "#dd8e40", "#59a14f", "#b07aa1", "#76b7b2", "#e1c254", "#9c755f", "#bab0ac"],
    dark: ["#6b93c0", "#e3a061", "#73b86a", "#c495b6", "#8ccbc6", "#e7ce77", "#b9927c", "#cfc7c3"] },
});

// Surface looks: the dark-mode backgrounds, text and status colours. "onedark" sets <html data-look="onedark"> (Core/theme.js,
// core.css); light mode is unchanged by it.
// `swatch` is its background, raised surface and accent, for the Appearance card's preview strip.
export const SURFACES = Object.freeze({
  default: { label: "Default", swatch: ["#1a1b1d", "#2e2f32", "#a9bd6a"] },
  onedark: { label: "One Dark Pro", swatch: ["#21252b", "#2c313a", "#456fc8"] },
});
/** The One Dark Pro look as one choice: its surface, accent and chart colours together. */
export const ONE_DARK_THEME = Object.freeze({ accent: "onedark", palette: "onedark", surface: "onedark" });
export const DEFAULT_THEME = Object.freeze({ accent: "signal", palette: "default" }); // no surface key = the default look (files stay as they were)
const HEX = /^#[0-9a-f]{6}$/i;

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
    return A(accent, ink, soft, mix(surface, accent, lineT));
  };
  return { light: scheme(h, SURFACE.light, "#000000", 0.08, 0.3), dark: scheme(darkAccent, SURFACE.dark, "#ffffff", 0.18, 0.4) };
}

/** The accent token set for a theme and scheme (custom colours derived; unknown → Signal). */
export function accentSet(theme, dark) {
  const key = dark ? "dark" : "light";
  const a = theme?.accent;
  if (a && ACCENTS[a]) return ACCENTS[a][key];
  if (HEX.test(a ?? "")) { const d = deriveAccent(a); if (!d.error) return d[key]; }
  return ACCENTS.signal[key];
}

/** The CSS custom properties a theme sets on :root for one scheme. */
export function themeVars(theme, dark) {
  const s = accentSet(theme, dark);
  const cats = (PALETTES[theme?.palette] ?? PALETTES.default)[dark ? "dark" : "light"];
  const vars = { "--on-accent": s.on, "--signal": s.signal ?? s.accent, "--accent": s.accent, "--accent-hover": s.hover, "--accent-pressed": s.pressed,
    "--on-accent-hover": s.onHover, "--on-accent-pressed": s.onPressed,
    "--accent-ink": s.ink, "--accent-soft": s.soft, "--accent-line": s.line };
  cats.forEach((c, i) => { vars[`--chart-cat-${i + 1}`] = c; });
  return vars;
}

/** Whether a theme is the default (nothing to set). */
export const isDefaultTheme = (t) => !t || (t.accent === DEFAULT_THEME.accent && t.palette === DEFAULT_THEME.palette && surfaceOf(t) === "default");

/** The surface look of a theme (older saved themes have none = default). */
export const surfaceOf = (t) => (SURFACES[t?.surface] ? t.surface : "default");

/** A saved theme, checked: known preset or a valid custom colour, known palette — else default + an issue. */
export function cleanTheme(raw, issues = []) {
  if (raw == null) return { ...DEFAULT_THEME };
  const okAccent = raw && (ACCENTS[raw.accent] || (HEX.test(raw.accent ?? "") && !deriveAccent(raw.accent).error));
  const okPalette = raw && PALETTES[raw.palette];
  const okSurface = raw && (raw.surface === undefined || SURFACES[raw.surface]); // absent in themes saved before the look existed
  if (!okAccent || !okPalette || !okSurface) issues.push("The theme couldn't be used — reset to the default.");
  return okAccent && okPalette && okSurface
    ? { accent: ACCENTS[raw.accent] ? raw.accent : raw.accent.toLowerCase(), palette: raw.palette, ...(surfaceOf(raw) === "default" ? {} : { surface: surfaceOf(raw) }) }
    : { ...DEFAULT_THEME };
}
