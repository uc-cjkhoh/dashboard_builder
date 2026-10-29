import { test } from "node:test";
import assert from "node:assert/strict";
import { ACCENTS, PALETTES, SURFACE, ON_ACCENT, DEFAULT_THEME, deriveAccent, accentSet, themeVars, cleanTheme, isDefaultTheme }
  from "../../src/DashboardBuilder/Features/Core/theme-model.js";
import { contrastRatio as cr } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";

const checkSet = (s, scheme, name) => {
  assert.ok(cr(ON_ACCENT, s.accent) >= 4.5, `${name} ${scheme}: white on accent ${cr(ON_ACCENT, s.accent).toFixed(2)}`);
  assert.ok(cr(ON_ACCENT, s.hover) >= 4.5, `${name} ${scheme}: white on hover`);
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
test("the default theme is crimson + default palette; core.css values match", () => {
  assert.equal(accentSet(DEFAULT_THEME, false).accent, "#b82035");
  assert.equal(PALETTES.default.light[0], "#2a78d6");
  assert.ok(isDefaultTheme(DEFAULT_THEME));
  assert.ok(!isDefaultTheme({ accent: "blue", palette: "default" }));
});
test("theme variables cover the accent set and eight chart colours", () => {
  const v = themeVars({ accent: "teal", palette: "okabe" }, true);
  assert.equal(v["--accent"], ACCENTS.teal.dark.accent);
  assert.equal(v["--chart-cat-1"], PALETTES.okabe.dark[0]);
  assert.equal(Object.keys(v).filter((k) => k.startsWith("--chart-cat-")).length, 8);
});
test("every palette has eight distinct colours per scheme", () => {
  for (const [id, p] of Object.entries(PALETTES)) for (const scheme of ["light", "dark"]) {
    assert.equal(p[scheme].length, 8, id);
    assert.equal(new Set(p[scheme]).size, 8, id);
  }
});
test("saved themes are checked", () => {
  assert.deepEqual(cleanTheme(undefined), DEFAULT_THEME);
  assert.deepEqual(cleanTheme({ accent: "#1D5FC4", palette: "muted" }), { accent: "#1d5fc4", palette: "muted" });
  const issues = [];
  assert.deepEqual(cleanTheme({ accent: "#ffffff", palette: "default" }, issues), DEFAULT_THEME);
  assert.deepEqual(cleanTheme({ accent: "blue", palette: "neon" }, issues), DEFAULT_THEME);
  assert.equal(issues.length, 2);
});
