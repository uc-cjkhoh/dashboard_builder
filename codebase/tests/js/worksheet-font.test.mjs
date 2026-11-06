// Worksheet font (T01-23) — pure model, store default, workbook round-trip, table class.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FONT_CHOICES, FONT_IDS, fontToken, fontClass } from "../../src/DashboardBuilder/Features/Dashboard/font-model.js";
import { defaultFormat, emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { restoreSheet, sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { readFileSync } from "node:fs";

test("a small fixed list; the default is the app font", () => {
  assert.deepEqual(FONT_CHOICES.map(([v]) => v), ["default", "serif", "mono"]);
  assert.equal(defaultFormat().font, "default");
});
test("default adds no token / class; unknown values are ignored", () => {
  assert.equal(fontToken("default"), null); assert.equal(fontClass("default"), null);
  assert.equal(fontToken(undefined), null); assert.equal(fontClass("comic"), null);
  assert.equal(fontToken("serif"), "--font-serif"); assert.equal(fontClass("mono"), "xt-f-mono");
  assert.ok(FONT_IDS.has("serif"));
});
test("the tokens exist in core.css", () => {
  const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Core/core.css", import.meta.url), "utf8");
  for (const [v] of FONT_CHOICES) if (v !== "default") assert.match(css, new RegExp(`${fontToken(v)}:`));
});
test("workbook round-trips a font; an unknown one resets with a note; old sheets gain the default", () => {
  const s = emptySheet(); s.format = { ...s.format, font: "serif" };
  assert.equal(restoreSheet(JSON.parse(JSON.stringify(s))).format.font, "serif");
  const old = JSON.parse(JSON.stringify(emptySheet())); delete old.format.font;
  assert.equal(restoreSheet(old).format.font, "default");
  const bad = JSON.parse(JSON.stringify(emptySheet())); bad.format.font = "comic";
  const issues = [];
  assert.equal(sanitizeSheet(bad, "Sheet 1", issues).format.font, "default");
  assert.match(issues[0], /Sheet 1 format: unknown font "comic"/);
});
