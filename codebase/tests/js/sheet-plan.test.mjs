import { test } from "node:test";
import assert from "node:assert/strict";
import { detailSplitCount, buildPlan, planDims, planMeasures, sortTargets, fieldId, measureName, periodFilters, isDateOnlyType, colorMode, pagesFilter, drillPathFilters, involvedTables, selectionFilter, keyOf, isDisaggregated, DISAGGREGATE_TYPES }
  from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";

// The plan reads only its explicit context: two contexts side by side never touch each other.
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

// --- the dashboard's cross-widget selection as a plan option ---
const rel = { from: { entityId: "e1", column: "id" }, to: { entityId: "e2", column: "id" }, joinType: "inner" };
const crossCtx = () => mkCtx({ relationships: new Map([["r1", rel]]) });
const country = { db: "shop", table: "customers", column: "country", value: "DE", label: "customers.country = DE", sourceWidgetId: "w#1" };
const crossFilter = { db: "shop", table: "customers", column: "country", op: "=", value: "DE", values: null };
const withCustomers = (over = {}) => sheet({ columns: [dim("customers", "country")], rows: [meas("orders", "id")], ...over });
const onlyOrders = (over = {}) => sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")], ...over });

test("involvedTables lists the query's tables in query order, the base first", () => {
  assert.deepEqual(involvedTables(withCustomers(), undefined, crossCtx()), [keyOf("shop", "customers"), keyOf("shop", "orders")]);
  assert.deepEqual(involvedTables(onlyOrders(), undefined, crossCtx()), [keyOf("shop", "orders")]);
});
test("selectionFilter is the one bound-value filter a selection becomes (= keep, != exclude)", () => {
  assert.deepEqual(selectionFilter(country, "="), crossFilter);
  assert.equal(selectionFilter({ ...country, value: 7 }, "!=").value, "7");
  assert.equal(selectionFilter({ ...country, value: 7 }, "!=").op, "!=");
});
test("buildPlan: a cross filter whose table is in the query is one bound `=` filter; otherwise the plan is unchanged", () => {
  const withIt = buildPlan(withCustomers(), undefined, crossCtx(), { crossFilter: country });
  assert.deepEqual(withIt.filters, [crossFilter]);
  assert.deepEqual(buildPlan(onlyOrders(), undefined, crossCtx(), { crossFilter: country }), buildPlan(onlyOrders(), undefined, crossCtx()), "never forces a join");
  assert.deepEqual(buildPlan(withCustomers(), undefined, crossCtx(), { crossFilter: null }), buildPlan(withCustomers(), undefined, crossCtx()));
});
test("buildPlan: the cross filter replaces the worksheet's own selection only when it applies", () => {
  const own = { db: "shop", table: "customers", column: "country", value: "FR", label: "x", action: "keep" };
  const applied = buildPlan(withCustomers({ selection: own }), undefined, crossCtx(), { crossFilter: country });
  assert.deepEqual(applied.filters, [crossFilter], "one selection filter, the dashboard's");
  const away = buildPlan(onlyOrders({ selection: { ...own, table: "orders", column: "region" } }), undefined, crossCtx(), { crossFilter: country });
  assert.equal(away.filters.length, 1, "the worksheet's own selection stays when the dashboard's can't apply");
  assert.equal(away.filters[0].value, "FR");
});
test("buildPlan: every filter slot in use plus a cross filter is exactly the server's 20", () => {
  const f = (i) => ({ db: "shop", table: "orders", column: "region", category: "text", op: "=", value: String(i) });
  const s = withCustomers({
    filters: Array.from({ length: 8 }, (_, i) => f(i)),
    drill: { levels: Array.from({ length: 6 }, (_, i) => ({ db: "shop", table: "orders", column: `c${i}`, category: "text" })), depth: 5, path: Array.from({ length: 5 }, (_, i) => ({ column: `c${i}`, value: `v${i}` })) },
    pages: { db: "shop", table: "orders", column: "region", members: ["a"], index: 0 },
    period: { db: "shop", table: "orders", column: "placed", preset: "last30" } });
  const ctx = crossCtx();
  ctx.sharedFilters = Array.from({ length: 4 }, (_, i) => ({ ...f(100 + i), column: "channel" }));
  const p = buildPlan(s, undefined, ctx, { crossFilter: country });
  assert.equal(p.filters.length, 20, JSON.stringify(p.filters.map((x) => x.column)));
});

// --- a union / unpivot as the data source -----------------------------------------------------------------------------
const UNION = { kind: "union", db: "shop", name: "Union: orders + returns", tables: ["orders", "returns"] };
const srcCtx = () => mkCtx({ entities: new Map([["e1", ent("e1", "orders")], ["u1", { ...ent("u1", UNION.name), source: UNION }]]) });
test("buildPlan: a sheet over a union names it as its source and reads only it, with no joins", () => {
  const s = sheet({ columns: [dim(UNION.name, "region")], rows: [meas(UNION.name, "id")] });
  const p = buildPlan(s, undefined, srcCtx());
  assert.deepEqual(p.from, { db: "shop", table: UNION.name });
  assert.deepEqual(p.source, { kind: "union", db: "shop", name: UNION.name, tables: ["orders", "returns"] });
  assert.deepEqual(p.joins, []);
  assert.equal(p.rowDimensions.length + p.columnDimensions.length, 1);
  assert.deepEqual(p.measures[0], { db: "shop", table: UNION.name, column: "id", agg: "sum" });
});
test("buildPlan: a catalog table's plan carries no source", () => {
  const p = buildPlan(sheet({ columns: [dim("orders", "region")] }), undefined, srcCtx());
  assert.equal("source" in p, false);
});
test("buildPlan: a union mixed with another table plans nothing, even with a relationship drawn", () => {
  const s = sheet({ columns: [dim(UNION.name, "region")], rows: [meas("orders", "id")] });
  assert.equal(buildPlan(s, undefined, srcCtx()), null);
  const rel = { from: { entityId: "e1", column: "id" }, to: { entityId: "u1", column: "id" }, joinType: "inner" };
  assert.equal(buildPlan(s, undefined, { ...srcCtx(), relationships: new Map([["r1", rel]]) }), null);
});
test("buildPlan: a filter on the union's own field stays in the plan and rides with the source", () => {
  const f = { db: "shop", table: UNION.name, column: "region", op: "=", value: "north", values: null, category: "text" };
  const p = buildPlan(sheet({ columns: [dim(UNION.name, "region")], filters: [f] }), undefined, srcCtx());
  assert.equal(p.filters.length, 1);
  assert.equal(p.source.name, UNION.name);
});

test("buildPlan: a compound relationship sends its extra pairs, swapped when crossed to to from", () => {
  const rel = { from: { entityId: "e1", column: "id" }, to: { entityId: "e2", column: "id" }, joinType: "inner", pairs: [{ from: "region", to: "placed" }] };
  const fwd = buildPlan(sheet({ columns: [dim("orders", "region")], rows: [meas("customers", "id")] }), undefined, mkCtx({ relationships: new Map([["r1", rel]]) }));
  assert.deepEqual(fwd.joins[0].pairs, [{ left: "region", right: "placed" }]);
  const back = buildPlan(sheet({ columns: [dim("customers", "region")], rows: [meas("orders", "id")] }), undefined, mkCtx({ relationships: new Map([["r1", rel]]) }));
  assert.deepEqual(back.joins[0].pairs, [{ left: "placed", right: "region" }]);
  const plain = buildPlan(sheet({ columns: [dim("orders", "region")], rows: [meas("customers", "id")] }), undefined, mkCtx({ relationships: new Map([["r1", { ...rel, pairs: undefined }]]) }));
  assert.equal("pairs" in plain.joins[0], false);
});

test("buildPlan: a calculated filter is wired as its tree, brings its tables in and is skipped when invalid", () => {
  const calcs = [{ id: "c1", name: "Net", formula: "[orders.id] * 2" }, { id: "c2", name: "Tot", formula: "SUM([orders.id])" }];
  const f = (id, o = {}) => ({ calc: id, db: "", table: "", column: calcs.find((c) => c.id === id).name, category: "numeric", op: ">", value: "5", ...o });
  const s = sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")], filters: [f("c1"), f("c1", { value: "" })] });
  const p = buildPlan(s, undefined, mkCtx({ calculations: calcs }));
  assert.equal(p.filters.length, 1);
  assert.equal(p.filters[0].calc.k, "bin"); assert.equal(p.filters[0].column, "Net"); assert.equal(p.filters[0].value, "5"); assert.equal(p.filters[0].table, "");
  // a calculated filter alone is enough to name the base table
  const alone = sheet({ rows: [meas("orders", "id")], filters: [f("c1")] });
  assert.deepEqual(buildPlan(alone, undefined, mkCtx({ calculations: calcs })).from, { db: "shop", table: "orders" });
});

test("buildPlan: a relationship that aggregates first marks its join, with a single-way filter direction only when asked", () => {
  const rel = { from: { entityId: "e1", column: "id" }, to: { entityId: "e2", column: "id" }, joinType: "inner" };
  const run = (extra) => buildPlan(sheet({ columns: [dim("orders", "region")], rows: [meas("customers", "id")] }), undefined, mkCtx({ relationships: new Map([["r1", { ...rel, ...extra }]]) })).joins[0];
  assert.equal("aggregate" in run({}), false);
  assert.equal(run({ aggregateFirst: true }).aggregate, true);
  assert.equal("filterDirection" in run({ aggregateFirst: true }), false);
  assert.equal(run({ aggregateFirst: true, filterDirection: "single" }).filterDirection, "single");
  assert.equal("aggregate" in run({ filterDirection: "single" }), false); // a direction means nothing unless aggregating
});

// --- custom SQL cards (D105) -------------------------------------------------------------------------------------------
const sqlCtx = (extra = {}) => mkCtx({ entities: new Map([["e1", { ...ent("e1", "orders"), customSql: "SELECT id, region FROM shop.o" }], ["e2", ent("e2", "customers")]]), ...extra });
test("buildPlan: a table whose card has custom SQL carries it as a sql source, and stays an ordinary table", () => {
  const p = buildPlan(sheet({ columns: [dim("orders", "region")], rows: [meas("orders", "id")] }), undefined, sqlCtx());
  assert.deepEqual(p.from, { db: "shop", table: "orders" });
  assert.deepEqual(p.sources, [{ kind: "sql", db: "shop", name: "orders", sql: "SELECT id, region FROM shop.o" }]);
  assert.equal("source" in p, false);
});
test("buildPlan: a plan that never reads the card carries no sources; a joined card is listed too", () => {
  assert.equal("sources" in buildPlan(sheet({ columns: [dim("customers", "region")] }), undefined, sqlCtx()), false);
  const rel = { from: { entityId: "e2", column: "id" }, to: { entityId: "e1", column: "id" }, cardinality: "1:N", joinType: "inner" };
  const p = buildPlan(sheet({ columns: [dim("customers", "region")], rows: [meas("orders", "id")] }), undefined, sqlCtx({ relationships: new Map([["r1", rel]]) }));
  assert.equal(p.joins.length, 1);
  assert.deepEqual(p.sources.map((s) => s.name), ["orders"]);
});

// ---- Aggregate Measures off (disaggregate) ----------------------------------------------------------------
const scatter = (over = {}) => sheet({ chartType: "scatter", columns: [meas("orders", "id")], rows: [meas("orders", "id", "avg")], ...over });
test("disaggregate: only the point charts draw one mark per row", () => {
  assert.deepEqual([...DISAGGREGATE_TYPES].sort(), ["circle", "scatter", "square"]);
  assert.equal(isDisaggregated(scatter({ disaggregate: true })), true);
  assert.equal(isDisaggregated(scatter()), false);
  assert.equal(isDisaggregated(scatter({ disaggregate: false })), false);
  assert.equal(isDisaggregated(sheet({ chartType: "bar", disaggregate: true })), false, "a bar chart ignores the setting");
});
test("disaggregate: the plan says so, keeps the 5,000 cap, and drops HAVING and Other", () => {
  const having = { op: ">", value: "5" };
  const p = buildPlan(scatter({ disaggregate: true, columns: [{ ...meas("orders", "id"), having }] }), undefined, mkCtx());
  assert.equal(p.disaggregate, true);
  assert.equal(p.limit, 5000);
  assert.equal(p.having, undefined);
  assert.equal(p.otherBucket, undefined);
  assert.equal(p.measures.length, 2);
});
test("disaggregate: off, or on a chart that can't draw it, the plan is the aggregated one", () => {
  assert.equal("disaggregate" in buildPlan(scatter(), undefined, mkCtx()), false);
  assert.equal("disaggregate" in buildPlan(scatter({ disaggregate: true, chartType: "bar" }), undefined, mkCtx()), false);
});
test("disaggregate: the sort menu and the caption name a measure by its field, not 'sum field'", () => {
  const ctx = mkCtx();
  const on = scatter({ disaggregate: true });
  assert.deepEqual(sortTargets(on, ctx).map((t) => t.label), ["id", "id"]);
  assert.deepEqual(sortTargets(scatter(), ctx).map((t) => t.label), ["sum id", "avg id"]);
});
test("disaggregate: a Top-N counts groups, so it does not cut the rows; aggregated, it still does", () => {
  const fmt = { topN: 20 };
  assert.equal(buildPlan(scatter({ disaggregate: true, format: fmt }), undefined, mkCtx()).limit, 5000);
  assert.equal(buildPlan(scatter({ format: fmt }), undefined, mkCtx()).limit, 20);
});

test("detailSplitCount: Detail members split a one-measure bar / line inside the unchanged categories", () => {
  const base = { columns: [dim("orders", "region")], rows: [meas("orders", "id")], marks: { ...sheet().marks, detail: [dim("orders", "channel")] } };
  assert.equal(detailSplitCount(sheet(base)), 1);
  assert.equal(detailSplitCount(sheet({ ...base, chartType: "stacked" })), 1);
  assert.equal(detailSplitCount(sheet({ ...base, chartType: "line" })), 1);
  assert.deepEqual(planDims(sheet(base)).keyOrder.map((f) => f.column), ["region", "channel"]); // the Detail key is the last key: the split reads it as its series key
});
test("detailSplitCount: 0 with no Detail, several measures, a Colour or Size dimension, or a chart type that cannot split", () => {
  const detail = [dim("orders", "channel")];
  const marks = { ...sheet().marks, detail };
  const base = { columns: [dim("orders", "region")], rows: [meas("orders", "id")], marks };
  assert.equal(detailSplitCount(sheet({ ...base, marks: sheet().marks })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, rows: [meas("orders", "id"), meas("orders", "qty")] })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, color: [dim("orders", "country")] })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, marks: { ...marks, size: dim("orders", "country") } })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, chartType: "scatter" })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, chartType: "pie" })), 0);
});
test("detailSplitCount: 0 when a channel the split does not draw is in use (Size measure, continuous Colour, Path, Tooltip, tooltip text, analytics, comparison)", () => {
  const marks = { ...sheet().marks, detail: [dim("orders", "channel")] };
  const base = { columns: [dim("orders", "region")], rows: [meas("orders", "id")], marks };
  assert.equal(detailSplitCount(sheet(base)), 1);
  assert.equal(detailSplitCount(sheet({ ...base, marks: { ...marks, size: meas("orders", "qty") } })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, color: [meas("orders", "qty")] })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, marks: { ...marks, path: dim("orders", "placed") } })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, marks: { ...marks, tooltip: [dim("orders", "country")] } })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, tooltipText: "x" })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, analytics: { ref: { kind: "average" } } })), 0);
  assert.equal(detailSplitCount(sheet({ ...base, period: { compare: "previous" } })), 0);
});
