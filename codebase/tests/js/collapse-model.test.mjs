import { test } from "node:test";
import assert from "node:assert/strict";
import { collapseKey, rollUp, expandNodes, leafValue, canToggle, toggleKey, collapsedOf, cleanCollapsed, MAX_COLLAPSED } from "../../src/DashboardBuilder/Features/Dashboard/collapse-model.js";

const names = ["region", "country", "city"];
const tuples = [["EU", "FR", "Paris"], ["EU", "FR", "Nice"], ["EU", "DE", "Berlin"], ["US", "US", "NYC"]];

test("nothing collapsed: one node per tuple, each its own member", () => {
  const n = rollUp(tuples, names, new Set());
  assert.equal(n.length, 4);
  assert.deepEqual(n[0], { tuple: tuples[0], members: [tuples[0]], level: null });
});

test("collapsing a level-0 header rolls its subtree into one node", () => {
  const n = rollUp(tuples, names, new Set([collapseKey(names, ["EU"], 0)]));
  assert.deepEqual(n.map((x) => x.tuple), [["EU"], ["US", "US", "NYC"]]);
  assert.equal(n[0].level, 0);
  assert.equal(n[0].members.length, 3);
});

test("collapsing a level-1 header keeps its siblings and the order", () => {
  const n = rollUp(tuples, names, new Set([collapseKey(names, ["EU", "FR"], 1)]));
  assert.deepEqual(n.map((x) => x.tuple), [["EU", "FR"], ["EU", "DE", "Berlin"], ["US", "US", "NYC"]]);
  assert.deepEqual(n.map((x) => x.level), [1, null, null]);
  assert.deepEqual(n[0].members, [tuples[0], tuples[1]]);
});

test("the outermost collapsed ancestor wins", () => {
  const n = rollUp(tuples, names, new Set([collapseKey(names, ["EU", "FR"], 1), collapseKey(names, ["EU"], 0)]));
  assert.deepEqual(n.map((x) => x.tuple), [["EU"], ["US", "US", "NYC"]]);
});

test("the last level has no next level, so it never collapses", () => {
  assert.equal(canToggle(0, 3), true);
  assert.equal(canToggle(1, 3), true);
  assert.equal(canToggle(2, 3), false);
  assert.equal(canToggle(0, 0), false);
  const n = rollUp(tuples, names, new Set([collapseKey(names, ["EU", "FR", "Paris"], 2)]));
  assert.equal(n.length, 4);
});

test("a key names its dimensions, so a re-ordered shelf does not apply it to other members", () => {
  const k = collapseKey(["region", "country"], ["EU"], 0);
  assert.notEqual(k, collapseKey(["country", "region"], ["EU"], 0));
  const n = rollUp(tuples, ["country", "region", "city"], new Set([k]));
  assert.equal(n.length, 4);
});

test("null and empty members are the same member", () => {
  assert.equal(collapseKey(names, [null], 0), collapseKey(names, [""], 0));
});

test("no dimensions: one node holding the empty tuple", () => {
  const n = rollUp([[]], [], new Set());
  assert.equal(n.length, 1);
});

test("expandNodes repeats a node per measure, or once", () => {
  const nodes = rollUp(tuples, names, new Set([collapseKey(names, ["EU"], 0)]));
  assert.equal(expandNodes(nodes, 0).length, 2);
  const e = expandNodes(nodes, 2);
  assert.equal(e.length, 4);
  assert.deepEqual([e[0].mi, e[1].mi], [0, 1]);
  assert.equal(e[1].level, 0);
  assert.equal(expandNodes([], 0).length, 1); // no tuples: one empty leaf
});

test("toggleKey adds then removes, without mutating", () => {
  const a = ["x"];
  const b = toggleKey(a, "y");
  assert.deepEqual(b, ["x", "y"]);
  assert.deepEqual(a, ["x"]);
  assert.deepEqual(toggleKey(b, "x"), ["y"]);
});

test("collapsedOf reads one axis of a sheet, tolerating no state", () => {
  assert.equal(collapsedOf({}, "rows").size, 0);
  assert.equal(collapsedOf({ collapsed: { rows: ["a"], cols: [] } }, "rows").has("a"), true);
  assert.equal(collapsedOf({ collapsed: { rows: ["a"], cols: [] } }, "cols").size, 0);
});

test("cleanCollapsed keeps strings, drops the rest and reports it", () => {
  const issues = [];
  assert.equal(cleanCollapsed(null, "S", issues), null);
  assert.equal(cleanCollapsed({ rows: [], cols: [] }, "S", issues), null);
  assert.deepEqual(cleanCollapsed({ rows: ["a", "a", 3], cols: ["b"] }, "S", issues), { rows: ["a"], cols: ["b"] });
  assert.equal(issues.length, 1);
  assert.equal(cleanCollapsed("x", "S", issues), null);
  assert.equal(issues.length, 2);
  const many = Array.from({ length: MAX_COLLAPSED + 5 }, (_, i) => "k" + i);
  assert.equal(cleanCollapsed({ rows: many, cols: [] }, "S", []).rows.length, MAX_COLLAPSED);
});

// leafValue: aggregates stay correct — additive combine, everything else is "—", never re-aggregated.
const cells = new Map([["EU,FR", 10], ["EU,DE", 5], ["US,US", 7]]);
const cell = (rt, ct, mi) => cells.get(rt.join(",")) ?? null;
const eu = { tuple: ["EU"], members: [["EU", "FR"], ["EU", "DE"]], level: 0 };
const one = (t) => ({ tuple: t, members: [t], level: null });
const none = one([]);
test("leafValue: an expanded pair reads its own cell whatever the aggregation", () => {
  assert.equal(leafValue(null, cell, one(["EU", "FR"]), none, 0), 10);
  assert.equal(leafValue("avg", cell, one(["EU", "FR"]), none, 0), 10);
});
test("leafValue: sum / count add, min / max pick", () => {
  assert.equal(leafValue("sum", cell, eu, none, 0), 15);
  assert.equal(leafValue("count", cell, eu, none, 0), 15);
  assert.equal(leafValue("min", cell, eu, none, 0), 5);
  assert.equal(leafValue("max", cell, eu, none, 0), 10);
});
test("leafValue: avg, median, distinct, percentile and table calculations show no value when collapsed", () => {
  for (const agg of ["avg", "median", "uniq", "count_distinct", "p90", null]) assert.equal(leafValue(agg, cell, eu, none, 0), null, String(agg));
});
test("leafValue: a collapsed column combines across both axes", () => {
  const c2 = (rt, ct) => ({ "EU,FR|a": 1, "EU,FR|b": 2, "EU,DE|a": 4, "EU,DE|b": 8 })[rt.join(",") + "|" + ct.join(",")];
  const top = { tuple: ["x"], members: [["a"], ["b"]], level: 0 };
  assert.equal(leafValue("sum", c2, eu, top, 0), 15);
  assert.equal(leafValue("sum", c2, one(["EU", "FR"]), top, 0), 3);
});

// Saved with the workbook, restored on load (T03-29).
import { serializeWorkbook, parseWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
const wbOf = (collapsed) => ({ entities: new Map(), relationships: new Map(), tabs: [{ id: "ws#1", kind: "worksheet", name: "S", sheet: { ...emptySheet(), collapsed } }], active: { kind: "worksheet", id: "ws#1" } });
test("collapsed headers round-trip through the workbook file", () => {
  const collapsed = { rows: [collapseKey(["a", "b"], ["x"], 0)], cols: [] };
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(wbOf(collapsed))));
  assert.deepEqual(wb.worksheets[0].sheet.collapsed, collapsed);
});
test("a new sheet starts fully expanded, and a bad saved value is dropped with an issue", () => {
  assert.equal(emptySheet().collapsed, undefined);
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(wbOf({ rows: [1, {}], cols: "x" }))));
  assert.equal(wb.worksheets[0].sheet.collapsed, undefined);
  assert.ok(wb.issues.some((i) => /collapsed/.test(i)), JSON.stringify(wb.issues));
});
