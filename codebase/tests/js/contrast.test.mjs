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
  const light = { ink: "#0f172a", surface: "#ffffff" }, dark = { ink: "#e2e8f0", surface: "#111a2b" };
  const blocks = css.split("@media (prefers-color-scheme: dark)");
  for (const [block, pair] of [[blocks[0], light], [blocks[1], dark]]) {
    const cats = [...block.matchAll(/--chart-cat-\d:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1]);
    assert.equal(cats.length, 8);
    for (const c of cats) assert.ok(contrastRatio(pickInk(c, [pair.ink, pair.surface, "#000000", "#ffffff"]), c) >= 4.5, c);
  }
});
