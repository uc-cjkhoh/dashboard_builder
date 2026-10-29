// Data notes for the status bar and print header: last-query time, calculation definitions (pure).
import { test } from "node:test";
import assert from "node:assert/strict";
import { updatedText, usedCalculations, calcDefinitionLines } from "../../src/DashboardBuilder/Features/Dashboard/data-notes.js";

const calcs = [
  { id: "c1", name: "Net", formula: "[orders.amount] * 2" },
  { id: "c2", name: "Margin", formula: "SUM([Net]) / SUM([orders.amount])" },
  { id: "c3", name: "Unused", formula: "1" },
];

test("updatedText: local HH:MM:SS, nothing without a time", () => {
  assert.equal(updatedText(new Date(2026, 9, 29, 9, 5, 7).getTime()), "Updated 09:05:07");
  assert.equal(updatedText(undefined), null);
  assert.equal(updatedText(0), null);
});

test("usedCalculations: pills on any shelf, top-N filters, and calculations they refer to; in calculation order", () => {
  const sheet = { rows: [{ calc: "c2" }], columns: [{ table: "t", column: "x" }], color: [], filters: [], marks: {} };
  assert.deepEqual(usedCalculations(sheet, calcs).map((c) => c.id), ["c1", "c2"]);
  const viaFilter = { rows: [], columns: [], filters: [{ op: "top", topBy: { calc: "c3" } }], marks: {} };
  assert.deepEqual(usedCalculations(viaFilter, calcs).map((c) => c.id), ["c3"]);
  assert.deepEqual(usedCalculations({ rows: [], columns: [], filters: [], marks: {} }, calcs), []);
});

test("usedCalculations: a cycle or unknown reference does not hang or throw", () => {
  const cyc = [{ id: "a", name: "A", formula: "[B]" }, { id: "b", name: "B", formula: "[A]" }];
  assert.deepEqual(usedCalculations({ rows: [{ calc: "a" }], columns: [], filters: [], marks: {} }, cyc).map((c) => c.id), ["a", "b"]);
  assert.deepEqual(usedCalculations({ rows: [{ calc: "gone" }], columns: [], filters: [], marks: {} }, calcs), []);
});

test("calcDefinitionLines: Name = formula, long formulas cut", () => {
  const sheet = { rows: [{ calc: "c1" }], columns: [], filters: [], marks: {} };
  assert.deepEqual(calcDefinitionLines(sheet, calcs), ["Net = [orders.amount] * 2"]);
  const long = [{ id: "L", name: "L", formula: "x".repeat(300) }];
  const [line] = calcDefinitionLines({ rows: [{ calc: "L" }], columns: [], filters: [], marks: {} }, long);
  assert.equal(line.length, "L = ".length + 200 + 1);
  assert.ok(line.endsWith("…"));
});
