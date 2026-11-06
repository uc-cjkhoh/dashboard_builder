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
  const light = { ink: "#1c1719", surface: "#ffffff" }, dark = { ink: "#f3eeef", surface: "#1c181b" };
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
    for (const bg of ["accent", "accent-hover", "accent-pressed"]) assert.ok(contrastRatio("#ffffff", t[bg]) >= 4.5, `${name} white on ${bg}`);
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
    [edge(blocks[0]), ["#f6f3f3", "#f1e4e5"], (bg) => mix("#ffffff", .72, bg), (p) => mix("#ffffff", .80, p)],
    [edge(blocks[1]), ["#141113", "#2a1418"], (bg) => mix("#1c181b", .70, bg), (p) => mix("#2b2529", .85, p)],
    [edge(blocks[2]), ["#181a1f", "#1f2230"], (bg) => mix("#21252b", .70, bg), (p) => mix("#2c313a", .85, p)], // One Dark Pro look
  ];
  for (const [e, bgs, panelOf, ctlOf] of cases) for (const bg of bgs) {
    const panel = panelOf(bg);
    assert.ok(contrastRatio(e, panel) >= 3, `${e} on panel ${panel}`);
    assert.ok(contrastRatio(e, ctlOf(panel)) >= 3, `${e} on control ${ctlOf(panel)}`);
  }
});
