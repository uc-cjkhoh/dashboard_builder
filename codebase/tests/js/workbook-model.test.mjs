// Workbook save/load format (roadmap item 5). Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeWorkbook, parseWorkbook, storageKey, WORKBOOK_FORMAT,
} from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";

function sampleState() {
  const entities = new Map([
    ["sales.orders#1", { id: "sales.orders#1", db: "sales", table: "orders", x: 10, y: 20,
      columns: [{ name: "id" }], joinKeys: new Set(["customer_id"]), el: { fake: "dom" } }],
    ["sales.customers#2", { id: "sales.customers#2", db: "sales", table: "customers", x: 300, y: 20,
      columns: [], joinKeys: new Set(["id"]), el: null }],
  ]);
  const relationships = new Map([
    ["rel#1", { id: "rel#1", from: { entityId: "sales.orders#1", column: "customer_id" },
      to: { entityId: "sales.customers#2", column: "id" }, cardinality: "N:1" }],
  ]);
  const sheet = { ...emptySheet(), chartType: "line",
    pages: { db: "sales", table: "orders", column: "region", category: "text", index: 2, members: ["a", "b", "c"] } };
  const dashboards = [{ id: "dash#1", name: "Revenue", sheet }];
  return { entities, relationships, dashboards, active: { kind: "dashboard", id: "dash#1" } };
}

test("a saved workbook round-trips tables, keys, links and dashboards", () => {
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(sampleState())));
  assert.equal(wb.entities.length, 2);
  assert.deepEqual(wb.entities[0], { id: "sales.orders#1", db: "sales", table: "orders", x: 10, y: 20, joinKeys: ["customer_id"] });
  assert.deepEqual(wb.relationships[0], {
    from: { entityId: "sales.orders#1", column: "customer_id" },
    to: { entityId: "sales.customers#2", column: "id" }, cardinality: "N:1", joinType: "inner" });
  assert.equal(wb.dashboards[0].name, "Revenue");
  assert.equal(wb.dashboards[0].sheet.chartType, "line");
  assert.equal(wb.active, 0);
});

test("the saved form carries no DOM nodes, fetched columns or loaded page members", () => {
  const json = JSON.stringify(serializeWorkbook(sampleState()));
  assert.doesNotMatch(json, /fake/);
  assert.doesNotMatch(json, /"columns":\[\{/);
  assert.equal(JSON.parse(json).dashboards[0].sheet.pages.members, undefined);
});

test("the saved form never carries a password", () => {
  const json = JSON.stringify(serializeWorkbook(sampleState()));
  assert.doesNotMatch(json, /password/i);
});

test("a file that isn't a workbook is rejected", () => {
  assert.throws(() => parseWorkbook('{"hello":1}'), /not a Dashboard Builder workbook/);
  assert.throws(() => parseWorkbook("not json"), /not a Dashboard Builder workbook/);
});

test("a workbook from a newer version is rejected", () => {
  assert.throws(() => parseWorkbook(JSON.stringify({ format: WORKBOOK_FORMAT, version: 99 })), /newer version/);
});

test("links to tables missing from the workbook are dropped", () => {
  const raw = serializeWorkbook(sampleState());
  raw.relationships.push({ from: { entityId: "ghost#9", column: "x" }, to: { entityId: "sales.orders#1", column: "id" }, cardinality: "1:1" });
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships.length, 1);
});

test("malformed tables and unknown cardinalities are dropped", () => {
  const raw = serializeWorkbook(sampleState());
  raw.entities.push({ id: "bad", db: 5, table: null });
  raw.relationships[0].cardinality = "many-many";
  const wb = parseWorkbook(JSON.stringify(raw));
  assert.equal(wb.entities.length, 2);
  assert.equal(wb.relationships.length, 0);
});

test("a sheet saved by an older build gains today's defaults", () => {
  const raw = serializeWorkbook(sampleState());
  raw.dashboards[0].sheet = { columns: [], rows: [], chartType: "bar" };
  const sheet = parseWorkbook(JSON.stringify(raw)).dashboards[0].sheet;
  assert.deepEqual(sheet.marks, emptySheet().marks);
  assert.deepEqual(sheet.format, emptySheet().format);
  assert.deepEqual(sheet.filters, []);
});

test("the model view is restored as active when no dashboard was open", () => {
  const state = { ...sampleState(), active: { kind: "model" } };
  assert.equal(parseWorkbook(JSON.stringify(serializeWorkbook(state))).active, null);
});

test("each server + user gets its own saved workbook", () => {
  const a = storageKey({ connected: true, host: "ch1", port: 8443, user: "analyst" });
  const b = storageKey({ connected: true, host: "ch2", port: 8443, user: "analyst" });
  assert.notEqual(a, b);
  assert.match(a, /ch1/);
});

test("there is no storage key while disconnected", () => {
  assert.equal(storageKey({ connected: false }), null);
});

test("join keys still waiting for their table's columns to load are kept", () => {
  const state = sampleState();
  const orders = state.entities.get("sales.orders#1");
  orders.joinKeys = new Set();
  orders.pendingKeys = ["customer_id"];
  const saved = serializeWorkbook(state);
  assert.deepEqual(saved.entities[0].joinKeys, ["customer_id"]);
});

const wbText = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, entities: [], relationships: [], dashboards: [], ...patch });
const sheetOf = (sheet) => parseWorkbook(wbText({ dashboards: [{ name: "S", sheet }] }));
const pill = (o = {}) => ({ db: "s", table: "orders", column: "amount", category: "numeric", ...o });

test("a missing or non-numeric version is refused with the right message", () => {
  assert.throws(() => parseWorkbook(wbText({ version: undefined })), /no valid version number/);
  assert.throws(() => parseWorkbook(wbText({ version: "1" })), /no valid version number/);
  assert.throws(() => parseWorkbook(wbText({ version: 2 })), /newer version/);
});
test("a clean workbook has no issues", () => assert.deepEqual(sheetOf({ chartType: "line" }).issues, []));
test("an unknown chart type is reset to Bar and reported", () => {
  const wb = sheetOf({ chartType: "radar" });
  assert.equal(wb.dashboards[0].sheet.chartType, "bar"); assert.match(wb.issues[0], /radar/);
});
test("out-of-range format values are reset and reported", () => {
  const wb = sheetOf({ format: { decimals: 99, topN: "abc", legend: "middle" } });
  const f = wb.dashboards[0].sheet.format;
  assert.equal(f.decimals, null); assert.equal(f.topN, null); assert.equal(f.legend, "auto");
  assert.equal(wb.issues.length, 3);
});
test("a null pill is dropped and reported; a wrong aggregation is reset", () => {
  const wb = sheetOf({ rows: [null, pill({ category: "text", agg: "sum" })] });
  assert.equal(wb.dashboards[0].sheet.rows.length, 1);
  assert.equal(wb.dashboards[0].sheet.rows[0].agg, "count");
  assert.equal(wb.issues.length, 2);
});
test("a drill without a depth is cleared and reported", () => {
  const wb = sheetOf({ drill: { levels: [pill(), pill({ column: "x" })], path: [] } });
  assert.equal(wb.dashboards[0].sheet.drill, null); assert.equal(wb.issues.length, 1);
});
test("a drill with more than 6 levels keeps the first 6 and reports it", () => {
  const levels = Array.from({ length: 8 }, (_, i) => pill({ column: `c${i}` }));
  const wb = sheetOf({ drill: { levels, depth: 0, path: [] } });
  assert.equal(wb.dashboards[0].sheet.drill.levels.length, 6);
  assert.ok(wb.issues.some((i) => /drill kept the first 6 levels\./.test(i)));
});
test("a filter without a category survives with no issue; a bad category is rejected", () => {
  const f = { db: "s", table: "orders", column: "amount", op: "=", value: "5" };
  const wb = sheetOf({ filters: [f, { ...f, category: "weird" }] });
  assert.equal(wb.dashboards[0].sheet.filters.length, 1);
  assert.equal(wb.dashboards[0].sheet.filters[0].category, undefined);
  assert.equal(wb.issues.length, 1);
  assert.deepEqual(sheetOf({ filters: [f] }).issues, []);
});
test("bloated files are capped with an issue", () => {
  const wb = parseWorkbook(wbText({ dashboards: Array.from({ length: 60 }, () => ({ name: "D", sheet: { rows: Array(25).fill(pill()) } })) }));
  assert.equal(wb.dashboards.length, 50); assert.equal(wb.dashboards[0].sheet.rows.length, 20);
  assert.ok(wb.issues.some((i) => /first 50 dashboards/.test(i)));
});
test("duplicate entity ids and duplicate tables are skipped and reported", () => {
  const e = { id: "a", db: "s", table: "t", x: 0, y: 0, joinKeys: [] };
  const wb = parseWorkbook(wbText({ entities: [e, { ...e }, { ...e, id: "b" }] }));
  assert.equal(wb.entities.length, 1); assert.equal(wb.issues.length, 2);
});

test("tables and relationships are capped with an issue", () => {
  const ents = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, db: "s", table: `t${i}`, x: 0, y: 0, joinKeys: [] }));
  const rels = Array.from({ length: 250 }, () => ({ from: { entityId: "e0", column: "a" }, to: { entityId: "e1", column: "b" }, cardinality: "1:1" }));
  const wb = parseWorkbook(wbText({ entities: ents, relationships: rels }));
  assert.equal(wb.entities.length, 100); assert.equal(wb.relationships.length, 200);
  assert.ok(wb.issues.includes("Only the first 100 tables were opened."));
  assert.ok(wb.issues.includes("Only the first 200 relationships were opened."));
});
test("every remaining reset is reported, never silent", () => {
  const e = { id: "a", db: "s", table: "t", x: -5, y: "no", joinKeys: ["k", 3] };
  const wb = parseWorkbook(wbText({
    entities: [e],
    dashboards: [5, { name: 7, sheet: {
      rows: [pill({ role: "bogus" })],
      format: { dataLabels: "yes", colorByDimension: 1, currencySymbol: 99, xTitle: 5 },
    } }],
  }));
  assert.equal(wb.entities[0].x, 0); assert.equal(wb.entities[0].y, 0);
  assert.deepEqual(wb.entities[0].joinKeys, ["k"]);
  assert.equal(wb.dashboards.length, 1); assert.equal(wb.dashboards[0].name, "Dashboard");
  const sh = wb.dashboards[0].sheet;
  assert.equal(sh.rows[0].role, undefined);
  assert.equal(sh.format.dataLabels, false); assert.equal(sh.format.colorByDimension, false);
  assert.equal(sh.format.currencySymbol, "$"); assert.equal(sh.format.xTitle, null);
  for (const re of [/position/, /join key/, /not a dashboard/i, /name/, /role/, /dataLabels/, /colorByDimension/, /currency/, /axis title/i])
    assert.ok(wb.issues.some((i) => re.test(i)), String(re));
});
test("a non-string filter value keeps the filter, resets the value and reports it", () => {
  const f = { db: "s", table: "orders", column: "amount", op: "=", value: 5 };
  const wb = sheetOf({ filters: [f] });
  assert.equal(wb.dashboards[0].sheet.filters.length, 1);
  assert.equal(wb.dashboards[0].sheet.filters[0].value, "");
  assert.equal(wb.issues.length, 1);
});
test("a dashboard with no name falls back with the required-field message", () => {
  const wb = parseWorkbook(wbText({ dashboards: [{ sheet: {} }] }));
  assert.equal(wb.dashboards[0].name, "Dashboard");
  assert.ok(wb.issues.some((i) => /Tab name is required/.test(i)));
});

test("non-list entities, relationships and dashboards are reported, not silently reset", () => {
  const wb = parseWorkbook(wbText({ entities: {}, relationships: "x", dashboards: 5 }));
  assert.ok(wb.issues.some((i) => /tables weren't a list/.test(i)));
  assert.ok(wb.issues.some((i) => /relationships weren't a list/.test(i)));
  assert.ok(wb.issues.some((i) => /dashboards weren't a list/.test(i)));
});
test("a non-object sheet or marks, and an invalid active index, are reported", () => {
  const wb = parseWorkbook(wbText({ dashboards: [{ name: "A", sheet: "oops" }, { name: "B", sheet: { marks: [] } }], active: 7 }));
  assert.ok(wb.issues.some((i) => /settings weren't an object/.test(i)));
  assert.ok(wb.issues.some((i) => /marks weren't an object/.test(i)));
  assert.ok(wb.issues.some((i) => /active dashboard was invalid/.test(i)));
  assert.equal(wb.active, null);
});
test("a valid or absent active index adds no issue", () => {
  assert.equal(parseWorkbook(wbText({ dashboards: [{ name: "A", sheet: {} }], active: 0 })).issues.length, 0);
  assert.equal(parseWorkbook(wbText({ dashboards: [{ name: "A", sheet: {} }] })).issues.length, 0);
});

test("a date range (P35) and scorecard target round-trip", () => {
  const period = { db: "sales", table: "orders", column: "created", category: "temporal", preset: "custom",
    from: "2026-09-01", to: "2026-09-30", compare: "lastYear", compareFrom: null, compareTo: null };
  const r = sheetOf({ chartType: "kpi", period, format: { target: 5000, downIsGood: true } });
  assert.deepEqual(r.issues, []);
  assert.deepEqual(r.dashboards[0].sheet.period, period);
  assert.equal(r.dashboards[0].sheet.format.target, 5000);
  assert.equal(r.dashboards[0].sheet.format.downIsGood, true);
});
test("a bad date range is cleared and reported", () => {
  const base = { db: "sales", table: "orders", column: "created", category: "temporal", preset: "last30", compare: "previous" };
  for (const bad of [{ ...base, preset: "forever" }, { ...base, compare: "tomorrow" }, { ...base, category: "text" },
    { ...base, from: "1st of May" }, { ...base, column: "" }]) {
    const r = sheetOf({ period: bad });
    assert.equal(r.dashboards[0].sheet.period, null);
    assert.ok(r.issues.some((i) => /date range cleared/.test(i)), JSON.stringify(r.issues));
  }
});
test("a non-numeric target is cleared and reported", () => {
  const r = sheetOf({ format: { target: "lots" } });
  assert.equal(r.dashboards[0].sheet.format.target, null);
  assert.match(r.issues.join(" "), /target/);
});

test("conditional formatting (P37) round-trips; bad parts are dropped and reported", () => {
  const good = { "s.orders.amount:sum": { mode: "scale", scale: "diverging", mid: 0, rules: [{ op: ">", value: 100, tone: "good" }] } };
  const ok = sheetOf({ chartType: "table", format: { conditional: good } });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.dashboards[0].sheet.format.conditional, good);
  const bad = sheetOf({ format: { conditional: {
    a: { mode: "rainbow", scale: "sequential", mid: null, rules: [] },
    b: { mode: "bars", scale: "sequential", mid: null, rules: [{ op: ">", value: "lots", tone: "good" }, { op: "<", value: 1, tone: "bad" }] },
  } } });
  assert.deepEqual(Object.keys(bad.dashboards[0].sheet.format.conditional), ["b"]);
  assert.equal(bad.dashboards[0].sheet.format.conditional.b.rules.length, 1);
  assert.equal(bad.issues.length, 2);
});

test("the workbook theme (P41) round-trips; a missing one is the default", () => {
  const st = sampleState();
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, theme: { accent: "violet", palette: "okabe" } })));
  assert.deepEqual(wb.theme, { accent: "violet", palette: "okabe" });
  assert.deepEqual(sheetOf({}).theme, { accent: "crimson", palette: "default" });
});

test("shared filters (P40) round-trip, are checked, and capped at 4", () => {
  const f = (column) => ({ db: "s", table: "orders", column, category: "text", op: "=", value: "x" });
  const st = sampleState();
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, sharedFilters: [f("region")] })));
  assert.deepEqual(wb.sharedFilters, [f("region")]);
  const many = parseWorkbook(wbText({ sharedFilters: [f("a"), f("b"), f("c"), f("d"), f("e"), { ...f("z"), op: "like" }] }));
  assert.equal(many.sharedFilters.length, 4);
  assert.ok(many.issues.some((i) => /first 4/.test(i)));
  assert.deepEqual(parseWorkbook(wbText({})).sharedFilters, []);
});
test("field choices (P40) are kept, include the shown field, and drop junk", () => {
  const shown = { db: "s", table: "orders", column: "region", category: "text" };
  const alt = { db: "s", table: "orders", column: "country", category: "text" };
  const r = sheetOf({ columns: [{ ...shown, choices: [alt, { db: "", column: "x" }] }] });
  assert.deepEqual(r.dashboards[0].sheet.columns[0].choices, [shown, alt]);
  assert.ok(r.issues.some((i) => /field choices/.test(i)));
  const lone = sheetOf({ columns: [{ ...shown, choices: [shown] }] });
  assert.equal(lone.dashboards[0].sheet.columns[0].choices, undefined);
});

test("bookmarks (P39) round-trip with their dashboard, selection and shared filters", () => {
  const st = sampleState();
  const sheet = { ...st.dashboards[0].sheet, chartType: "bar",
    selection: { db: "s", table: "orders", column: "region", value: "EU", label: "orders.region = EU", action: "keep" } };
  const sf = [{ db: "s", table: "orders", column: "region", category: "text", op: "=", value: "EU" }];
  const bm = { id: "bm#1", name: "EU view", dashId: "dash#1", dashName: "Revenue", sheet, sharedFilters: sf, savedAt: "2026-10-13T00:00:00Z" };
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, bookmarks: [bm, { ...bm, name: "Closed", dashId: "dash#gone" }] })));
  assert.equal(wb.bookmarks.length, 2);
  assert.equal(wb.bookmarks[0].dashboard, 0);
  assert.equal(wb.bookmarks[1].dashboard, null);
  assert.equal(wb.bookmarks[0].sheet.selection.action, "keep");
  assert.deepEqual(wb.bookmarks[0].sharedFilters, sf);
  assert.equal(wb.bookmarks[0].sheet.pages.members, undefined);
});
test("bad bookmarks are skipped and reported; a bad link action is removed", () => {
  const r = parseWorkbook(wbText({ bookmarks: [{ name: "", sheet: {} }, { name: "No view" }, { name: "Ok", sheet: { urlAction: { label: "x", template: "http://bad/{value}" } } }] }));
  assert.equal(r.bookmarks.length, 1);
  assert.equal(r.bookmarks[0].sheet.urlAction, null);
  assert.ok(r.issues.some((i) => /link action/.test(i)));
});

test("a date part (P26) is kept on a date pill and reset elsewhere", () => {
  const d = { db: "s", table: "orders", column: "created", category: "temporal" };
  assert.equal(sheetOf({ columns: [{ ...d, datePart: "month" }] }).dashboards[0].sheet.columns[0].datePart, "month");
  const bad = sheetOf({ columns: [{ ...d, datePart: "fortnight" }, { db: "s", table: "orders", column: "region", category: "text", datePart: "year" }] });
  assert.equal(bad.dashboards[0].sheet.columns[0].datePart, undefined);
  assert.equal(bad.dashboards[0].sheet.columns[1].datePart, undefined);
  assert.equal(bad.issues.filter((i) => /date part/.test(i)).length, 2);
});

test("a table calculation (P27) is kept when valid and removed when not", () => {
  const m = { db: "s", table: "orders", column: "amount", category: "numeric" };
  assert.deepEqual(sheetOf({ rows: [{ ...m, tableCalc: { type: "moving", along: "rows", window: 5 } }] }).dashboards[0].sheet.rows[0].tableCalc,
    { type: "moving", along: "rows", window: 5 });
  const bad = sheetOf({ rows: [{ ...m, tableCalc: { type: "median-ish" } }, { ...m, column: "qty", tableCalc: { type: "moving", window: 99 } }] });
  assert.equal(bad.dashboards[0].sheet.rows[0].tableCalc, undefined);
  assert.equal(bad.dashboards[0].sheet.rows[1].tableCalc, undefined);
  assert.equal(bad.issues.filter((i) => /table calculation/.test(i)).length, 2);
});

test("field settings (P28) round-trip; bad ones are dropped and counted", () => {
  const st = sampleState();
  const meta = new Map([["s.orders.amount", { alias: "Revenue", agg: "avg" }], ["s.orders.secret", { hidden: true }]]);
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, fieldMeta: meta })));
  assert.deepEqual(wb.fields, { "s.orders.amount": { alias: "Revenue", agg: "avg" }, "s.orders.secret": { hidden: true } });
  const bad = parseWorkbook(wbText({ fields: { "nodots": { alias: "x" }, "s.t.c": { alias: "", agg: "median", hidden: "yes" }, "s.t.ok": { alias: "Fine" } } }));
  assert.deepEqual(bad.fields, { "s.t.ok": { alias: "Fine" } });
  assert.ok(bad.issues.some((i) => /4 field setting/.test(i)));
});

test("title, caption, showTitle and fit (P23) are checked", () => {
  const ok = sheetOf({ title: "Sales", caption: "By region", showTitle: false, format: { fit: "entire" } }).dashboards[0].sheet;
  assert.deepEqual([ok.title, ok.caption, ok.showTitle, ok.format.fit], ["Sales", "By region", false, "entire"]);
  const bad = sheetOf({ title: 7, caption: "x".repeat(301), format: { fit: "stretch" } });
  const s = bad.dashboards[0].sheet;
  assert.deepEqual([s.title, s.caption, s.format.fit], [null, null, "standard"]);
  assert.equal(bad.issues.length, 3);
});

test("analytics settings (P21) are kept when valid and reset part by part", () => {
  const ok = sheetOf({ analytics: { ref: { kind: "constant", value: 5 }, band: { from: 9, to: 2 }, trend: "poly2", forecast: 6, totals: { grand: true } } }).dashboards[0].sheet.analytics;
  assert.deepEqual(ok, { ref: { kind: "constant", value: 5 }, band: { from: 2, to: 9 }, trend: "poly2", forecast: 6, totals: { grand: true, sub: false } });
  const bad = sheetOf({ analytics: { ref: { kind: "mode" }, trend: "cubic", forecast: 99 } });
  assert.deepEqual(bad.dashboards[0].sheet.analytics.trend, "none");
  assert.ok(bad.issues.some((i) => /analytics/.test(i)));
});

test("a relationship's join type (P31) round-trips; anything but left reads as inner", () => {
  const st = sampleState();
  [...st.relationships.values()][0].joinType = "left";
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(st)));
  assert.equal(wb.relationships[0].joinType, "left");
  const raw = JSON.parse(JSON.stringify(serializeWorkbook(st)));
  raw.relationships[0].joinType = "full outer";
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships[0].joinType, "inner");
});

test("parameters (P32) round-trip; references to a missing parameter are unlinked", () => {
  const st = sampleState();
  const params = [{ id: "prm1", name: "TopN", type: "number", value: 10, allowed: { kind: "any" } }];
  st.dashboards[0].sheet.format = { ...st.dashboards[0].sheet.format, topNParam: "prm1" };
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, parameters: params })));
  assert.deepEqual(wb.parameters, params);
  assert.equal(wb.dashboards[0].sheet.format.topNParam, "prm1");
  const orphan = parseWorkbook(wbText({ dashboards: [{ name: "S", sheet: { format: { topNParam: "prm7" },
    filters: [{ db: "s", table: "t", column: "c", category: "numeric", op: "=", value: "1", param: "prm8" }] } }] }));
  assert.equal(orphan.dashboards[0].sheet.format.topNParam, undefined);
  assert.equal(orphan.dashboards[0].sheet.filters[0].param, undefined);
  assert.equal(orphan.issues.filter((i) => /parameter is missing/.test(i)).length, 2);
});

test("calculations (Plan B) round-trip without a tree; old workbooks still open", () => {
  const st = sampleState();
  const calcs = [{ id: "calc1", name: "Margin", formula: "SUM([orders.a])", tree: { x: 1 } }];
  const saved = serializeWorkbook({ ...st, calculations: calcs });
  assert.deepEqual(saved.calculations, [{ id: "calc1", name: "Margin", formula: "SUM([orders.a])" }]);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.calculations, [{ id: "calc1", name: "Margin", formula: "SUM([orders.a])" }]);
  const old = parseWorkbook(wbText({}));
  assert.deepEqual(old.calculations, []);
  assert.equal(old.issues.filter((i) => /calculat/i.test(i)).length, 0);
});

test("a calc pill is valid without db/table/column; one pointing at a missing calculation is removed", () => {
  const ok = { calc: "calc1", db: "", table: "", column: "Margin", category: "numeric", role: "measure", agg: "sum" };
  const bare = { calc: "calc1", category: "numeric" };
  const gone = { calc: "calc9", db: "", table: "", column: "Old", category: "numeric" };
  const wb = parseWorkbook(wbText({ calculations: [{ id: "calc1", name: "Margin", formula: "1" }],
    dashboards: [{ name: "X", sheet: { rows: [ok, gone], columns: [bare], marks: { size: gone } } }] }));
  const s = wb.dashboards[0].sheet;
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].calc, "calc1");
  assert.equal(s.columns.length, 1);
  assert.equal(s.marks.size, null);
  assert.ok(wb.issues.includes('Sheet "X" rows: a calculated field that no longer exists was removed.'));
});

test("a countNonNull pill and field default round-trip and are not reset", () => {
  const wb = sheetOf({ rows: [pill({ category: "text", column: "status", agg: "countNonNull" })] });
  assert.equal(wb.dashboards[0].sheet.rows[0].agg, "countNonNull");
  assert.deepEqual(wb.issues, []);
  const f = parseWorkbook(wbText({ fields: { "s.orders.amount": { agg: "countNonNull" } } }));
  assert.deepEqual(f.fields, { "s.orders.amount": { agg: "countNonNull" } });
});
