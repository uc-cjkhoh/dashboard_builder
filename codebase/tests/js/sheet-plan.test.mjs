import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, planDims, planMeasures, sortTargets, fieldId, measureName, periodFilters, isDateOnlyType, colorMode, pagesFilter, drillPathFilters }
  from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";

// The plan reads only its explicit context (P24a): two contexts side by side never touch each other.
const ent = (id, table) => ({ id, db: "shop", table, columns: [{ name: "id", type: "UInt32", category: "numeric" }, { name: "region", type: "String", category: "text" }, { name: "placed", type: "Date", category: "temporal" }] });
const mkCtx = (over = {}) => ({
  calculations: [], entities: new Map([["e1", ent("e1", "orders")], ["e2", ent("e2", "customers")]]), relationships: new Map(),
  sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "", ...over });
const dim = (table, column) => ({ db: "shop", table, column, category: "text", role: "dimension" });
const meas = (table, column, agg = "sum") => ({ db: "shop", table, column, category: "numeric", agg });
const sheet = (over = {}) => ({ columns: [], rows: [], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });

test("planDims / planMeasures keep the canonical order: shelf measures first, discrete colour last", () => {
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")], color: [dim("orders", "channel")] });
  const d = planDims(s);
  assert.deepEqual(d.keyOrder.map((f) => f.column), ["region", "channel"]);
  assert.deepEqual(planMeasures(s).map((e) => e.role), ["shelf"]);
  assert.equal(colorMode(s), "discrete");
});
test("buildPlan: one table, bound filters, sort alias, no joins", () => {
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")], sort: { by: fieldId(meas("orders", "id"), "measure"), dir: "desc" } });
  const p = buildPlan(s, undefined, mkCtx());
  assert.deepEqual(p.from, { db: "shop", table: "orders" });
  assert.deepEqual(p.joins, []);
  assert.equal(p.sort.column, "v0");
  assert.equal(p.sort.desc, true);
  assert.equal(p.measures.length, 1);
});
test("buildPlan: tables with no relationship plan nothing; a relationship in the context joins them", () => {
  const s = sheet({ columns: [dim("customers", "region")], rows: [meas("orders", "id")] });
  assert.equal(buildPlan(s, undefined, mkCtx()), null);
  const rel = { from: { entityId: "e1", column: "id" }, to: { entityId: "e2", column: "id" }, joinType: "inner" };
  const p = buildPlan(s, undefined, mkCtx({ relationships: new Map([["r1", rel]]) }));
  assert.equal(p.joins.length, 1);
  assert.deepEqual(p.from, { db: "shop", table: "customers" }); // the first dimension's table is the base
  assert.deepEqual(p.joins[0].right, { db: "shop", table: "orders", column: "id" });
});
test("buildPlan reads the context's shared filters and parameters, not module state", () => {
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")] });
  const shared = [{ db: "shop", table: "orders", column: "region", category: "text", op: "=", value: "EU", values: null }];
  assert.equal(buildPlan(s, undefined, mkCtx()).filters.length, 0);
  const withShared = buildPlan(s, undefined, mkCtx({ sharedFilters: shared }));
  assert.equal(withShared.filters.length, 1);
  assert.equal(withShared.filters[0].value, "EU");
});
test("buildPlan: a field's cast comes from the context's metaOf", () => {
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")] });
  const p = buildPlan(s, undefined, mkCtx({ metaOf: (f) => (f.column === "region" ? { cast: "number" } : {}) }));
  assert.ok(JSON.stringify(p).includes('"cast"'), "the cast rides on the column ref");
});
test("sortTargets and measureName use the context's names", () => {
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")] });
  const ctx = mkCtx({ nameOf: (f) => `N:${f.column}`, metaOf: (f) => (f.column === "id" ? { alias: "Orders" } : {}) });
  assert.deepEqual(sortTargets(s, ctx).map((t) => [t.alias, t.label]), [["k0", "N:region"], ["v0", measureName(meas("orders", "id"), ctx)]]);
  assert.match(measureName(meas("orders", "id"), ctx), /Orders/);
});
test("date-only columns come from the context's column types", () => {
  assert.equal(isDateOnlyType("Nullable(Date32)"), true);
  assert.equal(isDateOnlyType("DateTime"), false);
  const p = { db: "shop", table: "orders", column: "placed", category: "temporal", preset: "last7", compare: "none" };
  const day = periodFilters(sheet({ period: p }), { from: "2026-01-01", to: "2026-01-31" }, mkCtx({ columnType: () => "Date" }));
  const time = periodFilters(sheet({ period: p }), { from: "2026-01-01", to: "2026-01-31" }, mkCtx({ columnType: () => "DateTime" }));
  assert.equal(day.length, 1);
  assert.notDeepEqual(day, time);
});
test("drill path and pages filters are bound equalities", () => {
  const lv = (column) => ({ db: "shop", table: "orders", column, category: "text" });
  const s = sheet({ drill: { levels: [lv("a"), lv("b")], depth: 1, path: [{ column: "a", value: 3 }] }, pages: { db: "shop", table: "orders", column: "region", members: ["EU", "US"], index: 1 } });
  assert.deepEqual(drillPathFilters(s), [{ db: "shop", table: "orders", column: "a", op: "=", value: "3", values: null }]);
  assert.equal(pagesFilter(s).value, "US");
});
