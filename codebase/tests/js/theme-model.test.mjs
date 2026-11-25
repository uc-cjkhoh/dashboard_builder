import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACCENTS, SURFACE, SURFACES, ON_ACCENT, CATEGORY_SLOTS, categoryColour, categoryColours, DEFAULT_THEME, deriveAccent, accentSet, themeVars, cleanTheme, isDefaultTheme, ONE_DARK_THEME, surfaceOf }
  from "../../src/DashboardBuilder/Features/Core/theme-model.js";
import { contrastRatio as cr } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";

const checkSet = (s, scheme, name) => {
  const on = s.on ?? ON_ACCENT; // the text on the accent: white, or dark on the Signal lime
  assert.ok(cr(on, s.accent) >= 4.5, `${name} ${scheme}: text on accent ${cr(on, s.accent).toFixed(2)}`);
  assert.ok(cr(s.onHover, s.hover) >= 4.5, `${name} ${scheme}: text on hover`);
  assert.ok(cr(s.onPressed, s.pressed) >= 4.5, `${name} ${scheme}: text on pressed`);
  // Brighter on hover, brighter again when pressed (relative luminance: white contrast falls as a colour brightens).
  assert.ok(cr("#ffffff", s.hover) < cr("#ffffff", s.accent) && cr("#ffffff", s.pressed) < cr("#ffffff", s.hover), `${name} ${scheme}: accent < hover < pressed in brightness`);
  assert.ok(cr(s.ink, SURFACE[scheme]) >= 4.5, `${name} ${scheme}: accent text on surface`);
  assert.ok(cr(s.ink, s.soft) >= 4.5, `${name} ${scheme}: accent text on soft`);
  assert.ok(cr(s.accent, SURFACE[scheme]) >= 3, `${name} ${scheme}: accent vs surface ${cr(s.accent, SURFACE[scheme]).toFixed(2)}`);
};

test("every preset accent passes contrast in light and dark", () => {
  for (const [id, a] of Object.entries(ACCENTS)) for (const scheme of ["light", "dark"]) checkSet(a[scheme], scheme, id);
});
test("a custom accent is derived to pass, or refused with the reason", () => {
  for (const hex of ["#1d5fc4", "#0f6b3a", "#8a2be2", "#b8580b", "#2f3542"]) {
    const d = deriveAccent(hex);
    assert.equal(d.error, undefined, hex);
    for (const scheme of ["light", "dark"]) checkSet(d[scheme], scheme, hex);
  }
  assert.match(deriveAccent("#ffd84d").error, /too light/);
  const nearBlack = deriveAccent("#050505"); // lifted in dark mode until it stands 3:1 off the surface
  assert.equal(nearBlack.error, undefined);
  checkSet(nearBlack.dark, "dark", "#050505");
  assert.match(deriveAccent("blue").error, /#rrggbb/);
});
test("the default theme is Signal; the chart colours are generated, not part of the theme", () => {
  assert.equal(accentSet(DEFAULT_THEME, false).accent, "#566a17");
  assert.deepEqual({ ...DEFAULT_THEME }, { accent: "signal" });
  assert.ok(isDefaultTheme(DEFAULT_THEME));
  assert.ok(!isDefaultTheme({ accent: "crimson" }));
});
test("theme variables cover the accent set and eight generated chart colours, the default theme included", () => {
  const v = themeVars({ accent: "teal" }, true);
  assert.equal(v["--accent"], ACCENTS.teal.dark.accent);
  assert.equal(Object.keys(v).filter((k) => k.startsWith("--chart-cat-")).length, CATEGORY_SLOTS);
  for (let i = 0; i < CATEGORY_SLOTS; i++) assert.equal(v[`--chart-cat-${i + 1}`], categoryColour(i, true));
  assert.equal(themeVars(DEFAULT_THEME, false)["--chart-cat-1"], categoryColour(0, false));
});
test("saved themes are checked", () => {
  assert.deepEqual(cleanTheme(undefined), DEFAULT_THEME);
  assert.deepEqual(cleanTheme({ accent: "#1D5FC4" }), { accent: "#1d5fc4" });
  const issues = [];
  assert.deepEqual(cleanTheme({ accent: "#ffffff" }, issues), DEFAULT_THEME);
  assert.deepEqual(cleanTheme({ accent: "blue", surface: "neon" }, issues), DEFAULT_THEME);
  assert.equal(issues.length, 2);
});
test("a palette saved by an older version is ignored: the accent and look it came with are kept, with no issue", () => {
  const issues = [];
  for (const palette of ["default", "okabe", "onedark", "muted", "neon", 7, null]) {
    assert.deepEqual(cleanTheme({ accent: "teal", palette }, issues), { accent: "teal" }, String(palette));
    assert.deepEqual(cleanTheme({ accent: "onedark", palette, surface: "onedark" }, issues), { accent: "onedark", surface: "onedark" });
  }
  assert.deepEqual(issues, []);
});
test("inherited object keys are not accents or looks (a hand-edited workbook cannot make the theme throw)", () => {
  for (const key of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    const issues = [];
    assert.deepEqual(cleanTheme({ accent: key }, issues), DEFAULT_THEME, key);
    assert.deepEqual(cleanTheme({ accent: "blue", surface: key }, issues), DEFAULT_THEME, key);
    assert.equal(issues.length, 2, key);
    assert.equal(accentSet({ accent: key }, false).accent, ACCENTS.signal.light.accent, key);
    assert.equal(surfaceOf({ surface: key }), "default", key);
  }
});

test("the One Dark Pro look: one choice sets surface and accent; older themes read as the default look", () => {
  assert.deepEqual({ ...ONE_DARK_THEME }, { accent: "onedark", surface: "onedark" });
  assert.deepEqual(cleanTheme(ONE_DARK_THEME), { ...ONE_DARK_THEME });
  assert.equal(isDefaultTheme(ONE_DARK_THEME), false);
  assert.equal(isDefaultTheme({ accent: "crimson", surface: "onedark" }), false);
  assert.equal(surfaceOf({ accent: "crimson" }), "default"); // saved before the look existed
  const issues = [];
  assert.deepEqual(cleanTheme({ accent: "crimson" }, issues), { accent: "crimson" });
  assert.deepEqual(issues, []);
  assert.deepEqual(cleanTheme({ accent: "crimson", surface: "nope" }, issues), { ...DEFAULT_THEME });
  assert.equal(issues.length, 1);
  assert.equal(themeVars(ONE_DARK_THEME, true)["--accent"], "#456fc8");
});

// ---- the generated categorical colours (any number of members, no list) ----
const hsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
};
const lab = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const [r, g, b] = c, f = (v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116);
  const x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047, y = 0.2126 * r + 0.7152 * g + 0.0722 * b, z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
};
const deltaE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const minDelta = (colours) => { let m = Infinity; for (let i = 0; i < colours.length; i++) for (let j = i + 1; j < colours.length; j++) m = Math.min(m, deltaE(colours[i], colours[j])); return m; };

test("categoryColour: a valid #rrggbb for any index, deterministic, and a negative / fractional / non-number index is clamped, never thrown on", () => {
  for (const dark of [false, true]) {
    for (const i of [0, 1, 7, 8, 99, 100, 1000, 5000, 123456]) assert.match(categoryColour(i, dark), /^#[0-9a-f]{6}$/);
    assert.equal(categoryColour(3, dark), categoryColour(3, dark));
    assert.equal(categoryColour(-4, dark), categoryColour(0, dark));
    assert.equal(categoryColour(2.9, dark), categoryColour(2, dark));
    assert.equal(categoryColour(NaN, dark), categoryColour(0, dark));
    assert.equal(categoryColour(undefined, dark), categoryColour(0, dark));
  }
  assert.deepEqual(categoryColours(3, false), [0, 1, 2].map((i) => categoryColour(i, false)));
  assert.deepEqual(categoryColours(0), []);
});
test("categoryColour: no member repeats a colour before the 100-member cap, and a member past it still has one", () => {
  for (const dark of [false, true]) {
    assert.equal(new Set(categoryColours(100, dark)).size, 100, dark ? "dark" : "light");
    assert.equal(new Set(categoryColours(500, dark)).size, 500, `${dark ? "dark" : "light"} 500`);
  }
});
test("categoryColour: never red (red means danger), and saturation stays at S <= 70 %", () => {
  for (const dark of [false, true]) for (const hex of categoryColours(1000, dark)) {
    const { h, s } = hsl(hex);
    assert.ok(!(s > 0.25 && (h >= 345 || h <= 12)), `${hex} is red (hue ${h.toFixed(0)})`);
    assert.ok(s <= 0.705, `${hex} S ${s.toFixed(2)}`);
  }
});
test("categoryColour: every colour is visible (>= 3:1) on the surface it is drawn on: white, and both dark looks", () => {
  for (const hex of categoryColours(1000, false)) assert.ok(cr(hex, SURFACE.light) >= 3, `${hex} on white ${cr(hex, SURFACE.light).toFixed(2)}`);
  for (const hex of categoryColours(1000, true)) for (const bg of [SURFACE.dark, SURFACES.onedark.swatch[0]]) assert.ok(cr(hex, bg) >= 3, `${hex} on ${bg} ${cr(hex, bg).toFixed(2)}`);
});
test("categoryColour: the first colours are told apart (CIE76 delta E: 8 members >= 18, 16 members >= 8)", () => {
  for (const dark of [false, true]) {
    assert.ok(minDelta(categoryColours(8, dark)) >= 18, `${dark ? "dark" : "light"} 8: ${minDelta(categoryColours(8, dark)).toFixed(1)}`);
    assert.ok(minDelta(categoryColours(16, dark)) >= 8, `${dark ? "dark" : "light"} 16: ${minDelta(categoryColours(16, dark)).toFixed(1)}`);
  }
});
test("slot-bound pairs stay apart: the waterfall's up / down and the crosstab's positive / negative bars (slots 1 and 5) differ by >= 90 degrees of hue, in both schemes", () => {
  const dist = (a, b) => { const d = Math.abs(hsl(a).h - hsl(b).h); return Math.min(d, 360 - d); };
  for (const dark of [false, true]) assert.ok(dist(categoryColour(0, dark), categoryColour(4, dark)) >= 90, `${dark ? "dark" : "light"}: ${categoryColour(0, dark)} / ${categoryColour(4, dark)}`);
  const read = (rel) => readFileSync(new URL(`../../src/DashboardBuilder/Features/${rel}`, import.meta.url), "utf8");
  assert.match(read("Dashboard/chart.js"), /down: c\.cat\[4\]/, "the waterfall's decrease is slot 5");
  assert.match(read("Dashboard/dashboard.css"), /\.xt-bar--neg \{[^}]*--chart-cat-5/, "the crosstab's negative bar is slot 5");
  assert.match(read("Dashboard/dashboard.css"), /\.xt-bar \{[^}]*--chart-cat-1/, "the crosstab's positive bar is slot 1");
});
