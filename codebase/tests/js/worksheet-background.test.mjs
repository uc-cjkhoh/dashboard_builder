// Worksheet background shading (T01-23) — pure model, workbook round-trip, CSS tokens.
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CHOICES, backgroundClass } from "../../src/DashboardBuilder/Features/Dashboard/background-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { restoreSheet, sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { readFileSync } from "node:fs";

test("choices list None first; the default adds no class; unknown values are ignored", () => {
  assert.deepEqual(BACKGROUND_CHOICES.map(([v]) => v), ["none", "subtle", "muted"]);
  assert.equal(backgroundClass("none"), null); assert.equal(backgroundClass(undefined), null); assert.equal(backgroundClass("pink"), null);
  assert.equal(backgroundClass("subtle"), "ws-bg-subtle"); assert.equal(backgroundClass("muted"), "ws-bg-muted");
});
test("each class is a token surface in dashboard.css, never a hex", () => {
  const css = readFileSync(new URL("../../src/DashboardBuilder/Features/Dashboard/dashboard.css", import.meta.url), "utf8");
  assert.match(css, /\.ws-bg-subtle[^{]*\{[^}]*var\(--surface-2\)/);
  assert.match(css, /\.ws-bg-muted[^{]*\{[^}]*var\(--surface-3\)/);
});
test("workbook round-trips the choice; an unknown one resets with a note; old sheets read None", () => {
  const s = emptySheet(); s.format = { ...s.format, background: "muted" };
  assert.equal(restoreSheet(JSON.parse(JSON.stringify(s))).format.background, "muted");
  const old = JSON.parse(JSON.stringify(emptySheet())); delete old.format.background;
  assert.equal(restoreSheet(old).format.background, undefined); // absent stays absent: reads None
  const bad = JSON.parse(JSON.stringify(emptySheet())); bad.format.background = "pink";
  const issues = [];
  assert.equal(sanitizeSheet(bad, "Sheet 1", issues).format.background, "none");
  assert.match(issues[0], /Sheet 1 format: unknown background "pink"/);
});
