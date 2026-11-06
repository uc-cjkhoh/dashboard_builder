import { test } from "node:test";
import assert from "node:assert/strict";
import { DIV_PAIR_CHOICES, divergingColours } from "../../src/DashboardBuilder/Features/Dashboard/colour-scale-model.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

const tk = { surface: "#ffffff", divLow: "#d98a4a", divHigh: "#2b62b8", cat: ["#c0", "#g1", "#c2", "#a3", "#c4", "#c5", "#v6", "#c7"] };

test("pair choices: the default warm / cool pair first, then token-slot pairs", () => {
  assert.deepEqual(DIV_PAIR_CHOICES.map(([v]) => v), ["default", "amber-violet", "green-violet"]);
});

test("divergingColours: default pair reads the div tokens; a chosen pair reads categorical slots; reverse swaps", () => {
  assert.deepEqual(divergingColours(tk, false, "default"), ["#d98a4a", "#ffffff", "#2b62b8"]);
  assert.deepEqual(divergingColours(tk, false), ["#d98a4a", "#ffffff", "#2b62b8"]); // no pair = default
  assert.deepEqual(divergingColours(tk, false, "amber-violet"), ["#a3", "#ffffff", "#v6"]);
  assert.deepEqual(divergingColours(tk, true, "green-violet"), ["#v6", "#ffffff", "#g1"]);
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
