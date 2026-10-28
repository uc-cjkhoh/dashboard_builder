import { test } from "node:test";
import assert from "node:assert/strict";
import { copyName, copySheet, canDuplicate } from "../../src/DashboardBuilder/Features/Tabs/duplicate-model.js";

test("copyName appends ' copy', then ' copy 2', ' copy 3' for taken names", () => {
  assert.equal(copyName("Sales", ["Sales"], 60), "Sales copy");
  assert.equal(copyName("Sales", ["Sales", "Sales copy"], 60), "Sales copy 2");
  assert.equal(copyName("Sales", ["Sales", "Sales copy", "Sales copy 2"], 60), "Sales copy 3");
});
test("copyName of a copy does not stack suffixes", () => {
  assert.equal(copyName("Sales copy", ["Sales", "Sales copy"], 60), "Sales copy 2");
  assert.equal(copyName("Sales copy 2", ["Sales", "Sales copy", "Sales copy 2"], 60), "Sales copy 3");
});
test("copyName stays within the tab-name limit by trimming the base", () => {
  const long = "x".repeat(60);
  const n = copyName(long, [long], 60);
  assert.ok(n.length <= 60);
  assert.ok(n.endsWith(" copy"));
  const n2 = copyName(long, [long, n], 60);
  assert.ok(n2.length <= 60 && n2.endsWith(" copy 2") && n2 !== n);
});
test("canDuplicate refuses at the dashboards limit", () => {
  assert.equal(canDuplicate(49, 50).ok, true);
  const r = canDuplicate(50, 50);
  assert.equal(r.ok, false);
  assert.match(r.error, /50/);
});
test("copySheet deep-copies and resets transient state", () => {
  const src = {
    columns: [{ db: "d", table: "t", column: "a", category: "text" }],
    rows: [{ calc: "calc1", db: "d", table: "t", column: "Profit", agg: "sum" }],
    filters: [{ column: "a", op: "=", value: "x" }],
    format: { numberFormat: "percent" }, chartType: "line",
    selection: { column: "a", value: "x", action: "keep" },
    drill: { levels: [{ column: "y" }, { column: "m" }], depth: 1, path: [{ column: "y", value: 2020 }] },
    pages: { column: "a", index: 2, members: ["a", "b", "c"], loadError: "x" },
  };
  const c = copySheet(src);
  assert.deepEqual(c.columns, src.columns);
  assert.notEqual(c.columns, src.columns);
  assert.notEqual(c.columns[0], src.columns[0]);
  assert.deepEqual(c.rows, src.rows);
  assert.deepEqual(c.filters, src.filters);
  assert.equal(c.format.numberFormat, "percent");
  assert.equal(c.chartType, "line");
  assert.equal(c.selection, null);
  assert.deepEqual(c.drill, { levels: src.drill.levels, depth: 0, path: [] });
  assert.equal(c.pages.index, 0);
  assert.equal("members" in c.pages, false);
  assert.equal("loadError" in c.pages, false);
  assert.equal(src.selection.value, "x");
  assert.equal(src.drill.depth, 1);
  assert.equal(src.pages.members.length, 3);
});
test("copySheet leaves null drill/pages alone", () => {
  const c = copySheet({ drill: null, pages: null, selection: null });
  assert.equal(c.drill, null); assert.equal(c.pages, null);
});
