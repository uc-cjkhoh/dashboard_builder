// The colour split with SEVERAL Colour keys (the last k group-by keys): series are the combinations ("web · gold"), the scatter groups likewise, and a
// pie / donut splits each slice by its Colour members (sub-slices grouped by slice). Pure result-model / pie-split-model functions.
import { test } from "node:test";
import assert from "node:assert/strict";
import { colorSplitData, scatterGroups } from "../../src/DashboardBuilder/Features/Dashboard/result-model.js";
import { pieSplit } from "../../src/DashboardBuilder/Features/Dashboard/pie-split-model.js";
import { memberRaw } from "../../src/DashboardBuilder/Features/Dashboard/colour-fields-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";

const fmt = (v) => String(v);
const dim = (column) => ({ db: "d", table: "t", column, category: "text", role: "dimension" });
const meas = (column) => ({ db: "d", table: "t", column, category: "numeric", role: "measure", agg: "sum" });
const row = (keys, ...values) => ({ keys, values });

test("colorSplitData with two Colour keys: categories from the rest, one series per combination in first-seen order, cells aligned, raws unambiguous", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel", "tier"], measures: ["v"], rows: [
    row(["EU", "web", "gold"], 1), row(["EU", "shop", "gold"], 2), row(["US", "web", "gold"], 3), row(["US", "web", "silver"], 4)] };
  const d = colorSplitData(result, fmt, 2);
  assert.deepEqual(d.categories, ["EU", "US"]);
  assert.deepEqual(d.series.map((s) => s.name), ["web · gold", "shop · gold", "web · silver"]);
  assert.deepEqual(d.series.map((s) => s.data), [[1, 3], [2, null], [null, 4]]);
  assert.deepEqual(d.cellRows, [[0, 2], [1, null], [null, 3]]);
  assert.deepEqual(d.memberRaws, [memberRaw(["web", "gold"]), memberRaw(["shop", "gold"]), memberRaw(["web", "silver"])]);
  assert.deepEqual(d.catTuples, [["EU"], ["US"]]);
});
test("colorSplitData with one key (the default) is exactly as before, with the member's raw as its raw", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["v"], rows: [row(["EU", "web"], 1), row(["EU", "shop"], 2)] };
  const d = colorSplitData(result, fmt);
  assert.deepEqual(d.series.map((s) => s.name), ["web", "shop"]); assert.deepEqual(d.colorVals, ["web", "shop"]); assert.deepEqual(d.memberRaws, ["web", "shop"]);
});
test("a missing member reads '—' inside a combination", () => {
  const result = { rowDimensions: ["region"], columnDimensions: ["channel", "tier"], measures: ["v"], rows: [row(["EU", null, "gold"], 1)] };
  assert.deepEqual(colorSplitData(result, fmt, 2).series.map((s) => s.name), ["— · gold"]);
});
test("scatterGroups with two Colour fields: one series per combination, a highlight-only legend (no single field to select by), member colours keyed by the combination", () => {
  const s = { ...emptySheet("S"), chartType: "scatter", columns: [meas("amount")], rows: [meas("qty")], color: [dim("channel"), dim("tier")] };
  const r = { rowDimensions: [], columnDimensions: ["channel", "tier"], measures: ["a", "b"], rows: [row(["web", "gold"], 1, 2), row(["shop", "gold"], 3, 4), row(["web", "gold"], 5, 6)] };
  const g = scatterGroups(s, r, [0, 1], -1, fmt);
  assert.deepEqual(g.groups.map((x) => [x.name, x.points.length]), [["web · gold", 2], ["shop · gold", 1]]);
  assert.equal(g.legend.field, null);
  assert.deepEqual(g.colourMembers.map((m) => [m.name, m.raw]), [["web · gold", memberRaw(["web", "gold"])], ["shop · gold", memberRaw(["shop", "gold"])]]);
});
test("pieSplit: sub-slices are grouped under their slice (slices in first-seen order), members keep one global order and index, names say both", () => {
  const rows = [row(["EU", "web"], 5), row(["US", "shop"], 3), row(["EU", "shop"], 2), row(["US", "web"], 4), row(["APAC", "app"], 1)];
  const p = pieSplit(rows, 1, fmt);
  assert.deepEqual(p.rows.map((r) => r.keys.join("/")), ["EU/web", "EU/shop", "US/shop", "US/web", "APAC/app"]);
  assert.deepEqual(p.members, [{ name: "web", raw: "web", index: 0 }, { name: "shop", raw: "shop", index: 1 }, { name: "app", raw: "app", index: 2 }]);
  assert.deepEqual(p.memberIndex, [0, 1, 1, 0, 2]);
  assert.deepEqual(p.slices, ["EU", "EU", "US", "US", "APAC"]);
  assert.deepEqual(p.categories, ["EU · web", "EU · shop", "US · shop", "US · web", "APAC · app"]);
});
test("pieSplit with two Colour keys and a two-key slice: the slice is the leading keys, the member the combination; the Other row stays last and unmembered", () => {
  const rows = [row(["EU", "x", "web", "gold"], 5), row(["EU", "x", "web", "silver"], 2), { keys: ["Other"], values: [9], isOther: true }];
  const p = pieSplit(rows, 2, fmt);
  assert.deepEqual(p.categories, ["EU / x · web · gold", "EU / x · web · silver", "Other"]);
  assert.deepEqual(p.members.map((m) => m.name), ["web · gold", "web · silver"]);
  assert.deepEqual(p.memberIndex, [0, 1, -1]); assert.equal(p.rows[2].isOther, true);
  assert.equal(p.members[0].raw, memberRaw(["web", "gold"]));
});
