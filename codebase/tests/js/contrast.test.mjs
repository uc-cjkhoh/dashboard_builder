import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { contrastRatio, pickInk } from "../../src/DashboardBuilder/Features/Dashboard/contrast.js";
const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/core.css", import.meta.url), "utf8");

test("contrastRatio: black on white is 21, identical colours are 1", () => {
  assert.equal(Math.round(contrastRatio("#000000", "#ffffff")), 21);
  assert.equal(contrastRatio("#336699", "#336699"), 1);
});
test("pickInk chooses the candidate with the higher contrast", () => {
  assert.equal(pickInk("#eda100", ["#0f172a", "#ffffff"]), "#0f172a");
  assert.equal(pickInk("#1e3a8a", ["#0f172a", "#ffffff"]), "#ffffff");
});
test("white on cat-4 is the known-bad case this helper fixes", () => {
  assert.ok(contrastRatio("#ffffff", "#eda100") < 2.5);
  assert.ok(contrastRatio(pickInk("#eda100", ["#0f172a", "#ffffff"]), "#eda100") >= 4.5);
});
test("every chart category colour gets a >=4.5:1 label ink (tokens ink/surface plus pure black/white)", () => {
  const light = { ink: "#141516", surface: "#ffffff" }, dark = { ink: "#ececea", surface: "#1a1b1d" };
  const blocks = css.split(':root[data-scheme="dark"]');
  for (const [block, pair] of [[blocks[0], light], [blocks[1], dark]]) {
    const cats = [...block.matchAll(/--chart-cat-\d:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    assert.equal(cats.length, 8);
    for (const c of cats) assert.ok(contrastRatio(pickInk(c, [pair.ink, pair.surface, "#000000", "#ffffff"]), c) >= 4.5, c);
  }
});

// Every token text-on-surface pair the UI uses meets WCAG AA (4.5:1) in both themes; the red accent
// as a UI boundary meets 3:1.
test("token text pairs meet AA in light and dark", () => {
  const blocks = css.split(':root[data-scheme="dark"]');
  const read = (block) => Object.fromEntries([...block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1], m[2]]));
  const light = read(blocks[0]); const dark = { ...light, ...read(blocks[1]) };
  const oneDark = { ...dark, ...read(blocks[2]) }; // the Theme → One Dark Pro look (core.css, [data-look="onedark"])
  const pairs = [["ink", "bg"], ["ink-2", "surface-3"], ["ink-3", "bg"], ["ink-3", "surface-3"], ["ink-3", "surface-2"],
    ["accent-ink", "accent-soft"], ["accent-ink", "surface"], ["accent-ink", "surface-3"],
    ["dim-ink", "dim-bg"], ["meas-ink", "meas-bg"], ["enc-ink", "enc-bg"], ["ok-ink", "ok-bg"], ["warn-ink", "warn-bg"],
    ["danger-ink", "danger-bg"], ["danger-ink", "surface"], ["surface", "enc-ink"], ["surface", "warn-ink"]];
  for (const [name, t] of [["light", light], ["dark", dark], ["one dark pro", oneDark]]) {
    for (const [fg, bg] of pairs) assert.ok(contrastRatio(t[fg], t[bg]) >= 4.5, `${name} ${fg} on ${bg}`);
    for (const bg of ["accent", "accent-hover", "accent-pressed"]) assert.ok(contrastRatio(t["on-accent"], t[bg]) >= 4.5, `${name} text on ${bg}`); // --on-accent: white, or dark on the Signal lime
    assert.ok(contrastRatio(t.accent, t.surface) >= 3, `${name} accent boundary`);
  }
});

// Controls on glass keep a ≥ 3:1 outline (WCAG 1.4.11) against the glass panel and against their own
// fill — composited over the plain base and over the strongest wash tint.
test("--ctl-edge holds 3:1 against glass in light and dark", () => {
  const mix = (fg, a, bg) => "#" + [0, 1, 2].map((i) => Math.round(parseInt(fg.slice(1 + 2 * i, 3 + 2 * i), 16) * a
    + parseInt(bg.slice(1 + 2 * i, 3 + 2 * i), 16) * (1 - a)).toString(16).padStart(2, "0")).join("");
  const blocks = css.split(':root[data-scheme="dark"]');
  const edge = (b) => b.match(/--ctl-edge:\s*(#[0-9a-f]{6})/i)[1];
  const cases = [
    [edge(blocks[0]), ["#efefec", "#e9ecd6"], (bg) => mix("#ffffff", .72, bg), (p) => mix("#ffffff", .80, p)],
    [edge(blocks[1]), ["#0b0b0c", "#171a0c"], (bg) => mix("#1a1b1d", .70, bg), (p) => mix("#2e2f32", .85, p)],
    [edge(blocks[2]), ["#181a1f", "#1f2230"], (bg) => mix("#21252b", .70, bg), (p) => mix("#2c313a", .85, p)], // One Dark Pro look
  ];
  for (const [e, bgs, panelOf, ctlOf] of cases) for (const bg of bgs) {
    const panel = panelOf(bg);
    assert.ok(contrastRatio(e, panel) >= 3, `${e} on panel ${panel}`);
    assert.ok(contrastRatio(e, ctlOf(panel)) >= 3, `${e} on control ${ctlOf(panel)}`);
  }
});

// D97: red means danger only — no ordinary category colour in the default or One Dark palettes sits in the red hue band, and the
// dark accent (single-measure bars, primary buttons) stays calm: HSL saturation <= 70 %.
import { PALETTES } from "../../src/DashboardBuilder/Features/Core/theme-model.js";
const hsl = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn, l = (mx + mn) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let h = d === 0 ? 0 : mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
};
test("D97: no default / One Dark category colour is red, and every one stays at S <= 70 %", () => {
  for (const name of ["default", "onedark"]) for (const mode of ["light", "dark"]) for (const hex of PALETTES[name][mode]) {
    const { h, s } = hsl(hex);
    assert.ok(!(s > 0.25 && (h >= 345 || h <= 12)), `${name} ${mode} ${hex} is red (hue ${h.toFixed(0)})`);
    assert.ok(s <= 0.705, `${name} ${mode} ${hex} S ${s.toFixed(2)}`);
  }
});
test("D97: the core.css category tokens carry no red either, and the dark accent is calm", () => {
  const blocks = css.split(':root[data-scheme="dark"]');
  for (const block of blocks.slice(0, 3)) {
    for (const m of block.matchAll(/--chart-cat-\d:\s*(#[0-9a-f]{6})/gi)) {
      const { h, s } = hsl(m[1]);
      assert.ok(!(s > 0.25 && (h >= 345 || h <= 12)), `${m[1]} is red`);
    }
  }
  const accent = blocks[1].match(/--accent:\s*(#[0-9a-f]{6})/i)[1];
  assert.ok(hsl(accent).s <= 0.5, `dark accent ${accent} S ${hsl(accent).s.toFixed(2)}`);
});
