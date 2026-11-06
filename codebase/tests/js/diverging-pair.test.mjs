import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DIV_PAIR_CHOICES, DIV_HUE_FALLBACK, divergingColours } from "../../src/DashboardBuilder/Features/Dashboard/colour-scale-model.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

const tk = { surface: "#ffffff", divLow: "#d98a4a", divHigh: "#2b62b8", cat: ["#c0", "#c1", "#c2", "#c3", "#c4", "#c5", "#c6", "#c7"], hues: { amber: "#a1", violet: "#v1", green: "#g1" } };

test("pair choices: the default warm / cool pair first, then token-slot pairs", () => {
  assert.deepEqual(DIV_PAIR_CHOICES.map(([v]) => v), ["default", "amber-violet", "green-violet"]);
});

test("divergingColours: default pair reads the div tokens; a chosen pair reads categorical slots; reverse swaps", () => {
  assert.deepEqual(divergingColours(tk, false, "default"), ["#d98a4a", "#ffffff", "#2b62b8"]);
  assert.deepEqual(divergingColours(tk, false), ["#d98a4a", "#ffffff", "#2b62b8"]); // no pair = default
  assert.deepEqual(divergingColours(tk, false, "amber-violet"), ["#a1", "#ffffff", "#v1"]);
  assert.deepEqual(divergingColours(tk, true, "green-violet"), ["#v1", "#ffffff", "#g1"]);
  assert.deepEqual(divergingColours(tk, false, "nope"), ["#d98a4a", "#ffffff", "#2b62b8"]); // unknown = default
});

test("sheet: colorPair defaults, round-trips, and a bad value resets with an issue", () => {
  assert.equal(defaultFormat().colorPair, "default");
  const s = emptySheet("S");
  assert.equal(sanitizeSheet(s, "S", []).format.colorPair, "default");
  assert.equal(sanitizeSheet({ ...s, format: { ...s.format, colorPair: "green-violet" } }, "S", []).format.colorPair, "green-violet");
  const issues = [];
  const bad = sanitizeSheet({ ...s, format: { ...s.format, colorPair: "#ff0000" } }, "S", issues);
  assert.equal(bad.format.colorPair, "default"); assert.equal(issues.length, 1);
});

const hsl = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  const h = d === 0 ? 0 : mx === r ? ((g - b) / d + 6) % 6 * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return { h, s: d === 0 ? 0 : d / (1 - Math.abs(mx + mn - 1)) }; };
const redish = (hex) => { const { h, s } = hsl(hex); return s > 0.3 && (h < 20 || h >= 340); };
const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

test("no pair end is red-ish, and a pair never reads the categorical tokens (fallbacks and every theme in core.css)", () => {
  const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/core.css", import.meta.url), "utf8");
  const sets = [DIV_HUE_FALLBACK];
  for (const blk of css.match(/--chart-div-amber:[^;]+;\s*--chart-div-violet:[^;]+;\s*--chart-div-green:[^;]+;/g) ?? []) sets.push(Object.fromEntries([...blk.matchAll(/--chart-div-(\w+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1], m[2]])));
  assert.equal(sets.length, 4, "light, dark and One Dark Pro define all three hues");
  for (const hues of sets) for (const pair of ["amber-violet", "green-violet"]) {
    const t = { surface: "#ffffff", divLow: "#d98a4a", divHigh: "#2b62b8", cat: ["#ff0000", "#ff0000", "#ff0000", "#ff0000", "#ff0000", "#ff0000", "#ff0000", "#ff0000"], hues };
    const [lo, , hi] = divergingColours(t, false, pair);
    assert.ok(!redish(lo) && !redish(hi) && lo !== "#ff0000" && hi !== "#ff0000", `${pair} ends ${lo} ${hi}`);
  }
});

test("each hue is visible against its theme's surface (>= 2.5:1) in light and dark", () => {
  const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/core.css", import.meta.url), "utf8");
  const blocks = [...css.matchAll(/--chart-div-amber:\s*(#[0-9a-f]{6});\s*--chart-div-violet:\s*(#[0-9a-f]{6});\s*--chart-div-green:\s*(#[0-9a-f]{6});/gi)];
  const surfaces = ["#ffffff", "#1a1b1d", "#21252b"]; // the --surface of light, dark, One Dark Pro
  blocks.slice(0, 3).forEach((m, i) => { for (const hex of m.slice(1)) assert.ok(contrast(hex, surfaces[i]) >= 2.5, `${hex} on ${surfaces[i]}: ${contrast(hex, surfaces[i]).toFixed(2)}`); });
});
