// Workbook save/load format (roadmap item 5). Run: node --test tests/js/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  serializeWorkbook, parseWorkbook, storageKey, WORKBOOK_FORMAT, restoreSheet,
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
  const tabs = [{ id: "ws#1", kind: "worksheet", name: "Revenue", sheet }];
  return { entities, relationships, tabs, active: { kind: "worksheet", id: "ws#1" } };
}

test("a saved workbook round-trips tables, keys, links and worksheets", () => {
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(sampleState())));
  assert.equal(wb.entities.length, 2);
  assert.deepEqual(wb.entities[0], { id: "sales.orders#1", db: "sales", table: "orders", x: 10, y: 20, joinKeys: ["customer_id"] });
  assert.deepEqual(wb.relationships[0], {
    from: { entityId: "sales.orders#1", column: "customer_id" },
    to: { entityId: "sales.customers#2", column: "id" }, cardinality: "N:1", joinType: "inner", joinFixed: false });
  assert.equal(wb.worksheets[0].name, "Revenue");
  assert.equal(wb.worksheets[0].sheet.chartType, "line");
  assert.deepEqual(wb.active, { kind: "worksheet", index: 0 });
});

test("the saved form carries no DOM nodes, fetched columns or loaded page members", () => {
  const json = JSON.stringify(serializeWorkbook(sampleState()));
  assert.doesNotMatch(json, /fake/);
  assert.doesNotMatch(json, /"columns":\[\{/);
  assert.equal(JSON.parse(json).worksheets[0].sheet.pages.members, undefined);
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
  raw.worksheets[0].sheet = { columns: [], rows: [], chartType: "bar" };
  const sheet = parseWorkbook(JSON.stringify(raw)).worksheets[0].sheet;
  assert.deepEqual(sheet.marks, emptySheet().marks);
  assert.deepEqual(sheet.format, emptySheet().format);
  assert.deepEqual(sheet.filters, []);
});

test("the model view is restored as active when no tab was open", () => {
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

// These cases feed v1 files (`dashboards` = worksheets) on purpose: every one also exercises migrateV1. v2 lives in workbook-v2.test.mjs.
const wbText = (patch) => JSON.stringify({ format: WORKBOOK_FORMAT, version: 1, entities: [], relationships: [], dashboards: [], ...patch });
const sheetOf = (sheet) => parseWorkbook(wbText({ dashboards: [{ name: "S", sheet }] }));
const pill = (o = {}) => ({ db: "s", table: "orders", column: "amount", category: "numeric", ...o });

test("a missing or non-numeric version is refused with the right message", () => {
  assert.throws(() => parseWorkbook(wbText({ version: undefined })), /no valid version number/);
  assert.throws(() => parseWorkbook(wbText({ version: "1" })), /no valid version number/);
  assert.throws(() => parseWorkbook(wbText({ version: 3 })), /newer version/);
});
test("a clean workbook has no issues", () => assert.deepEqual(sheetOf({ chartType: "line" }).issues, []));
test("an unknown chart type is reset to Bar and reported", () => {
  const wb = sheetOf({ chartType: "radar" });
  assert.equal(wb.worksheets[0].sheet.chartType, "bar"); assert.match(wb.issues[0], /radar/);
});
test("out-of-range format values are reset and reported", () => {
  const wb = sheetOf({ format: { decimals: 99, topN: "abc", legend: "middle" } });
  const f = wb.worksheets[0].sheet.format;
  assert.equal(f.decimals, null); assert.equal(f.topN, null); assert.equal(f.legend, "auto");
  assert.equal(wb.issues.length, 3);
});
test("a null pill is dropped and reported; a wrong aggregation is reset", () => {
  const wb = sheetOf({ rows: [null, pill({ category: "text", agg: "sum" })] });
  assert.equal(wb.worksheets[0].sheet.rows.length, 1);
  assert.equal(wb.worksheets[0].sheet.rows[0].agg, "count");
  assert.equal(wb.issues.length, 2);
});
test("a drill without a depth is cleared and reported", () => {
  const wb = sheetOf({ drill: { levels: [pill(), pill({ column: "x" })], path: [] } });
  assert.equal(wb.worksheets[0].sheet.drill, null); assert.equal(wb.issues.length, 1);
});
test("a drill with more than 6 levels keeps the first 6 and reports it", () => {
  const levels = Array.from({ length: 8 }, (_, i) => pill({ column: `c${i}` }));
  const wb = sheetOf({ drill: { levels, depth: 0, path: [] } });
  assert.equal(wb.worksheets[0].sheet.drill.levels.length, 6);
  assert.ok(wb.issues.some((i) => /drill kept the first 6 levels\./.test(i)));
});
test("a filter without a category survives with no issue; a bad category is rejected", () => {
  const f = { db: "s", table: "orders", column: "amount", op: "=", value: "5" };
  const wb = sheetOf({ filters: [f, { ...f, category: "weird" }] });
  assert.equal(wb.worksheets[0].sheet.filters.length, 1);
  assert.equal(wb.worksheets[0].sheet.filters[0].category, undefined);
  assert.equal(wb.issues.length, 1);
  assert.deepEqual(sheetOf({ filters: [f] }).issues, []);
});
test("bloated files are capped with an issue", () => {
  const wb = parseWorkbook(wbText({ dashboards: Array.from({ length: 60 }, () => ({ name: "D", sheet: { rows: Array(25).fill(pill()) } })) }));
  assert.equal(wb.worksheets.length, 50); assert.equal(wb.worksheets[0].sheet.rows.length, 20);
  assert.ok(wb.issues.some((i) => /first 50 tabs/.test(i)));
});
test("duplicate entity ids and duplicate tables are skipped and reported", () => {
  const e = { id: "a", db: "s", table: "t", x: 0, y: 0, joinKeys: [] };
  const wb = parseWorkbook(wbText({ entities: [e, { ...e }, { ...e, id: "b" }] }));
  assert.equal(wb.entities.length, 1); assert.equal(wb.issues.length, 2);
});

test("tables and relationships are capped with an issue", () => {
  const ents = Array.from({ length: 120 }, (_, i) => ({ id: `e${i}`, db: "s", table: `t${i}`, x: 0, y: 0, joinKeys: [] }));
  const rels = Array.from({ length: 250 }, (_, i) => ({ from: { entityId: "e0", column: `a${i}` }, to: { entityId: "e1", column: `b${i}` }, cardinality: "1:1" })); // distinct columns: a column is in only one relationship
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
      format: { dataLabels: "yes", dualAxis: 1, currencySymbol: 99, xTitle: 5 },
    } }],
  }));
  assert.equal(wb.entities[0].x, 0); assert.equal(wb.entities[0].y, 0);
  assert.deepEqual(wb.entities[0].joinKeys, ["k"]);
  assert.equal(wb.worksheets.length, 1); assert.equal(wb.worksheets[0].name, "Worksheet");
  const sh = wb.worksheets[0].sheet;
  assert.equal(sh.rows[0].role, undefined);
  assert.equal(sh.format.dataLabels, false); assert.equal(sh.format.dualAxis, false);
  assert.equal(sh.format.currencySymbol, "$"); assert.equal(sh.format.xTitle, null);
  for (const re of [/position/, /join key/, /not a worksheet/i, /name/, /role/, /dataLabels/, /dualAxis/, /currency/, /axis title/i])
    assert.ok(wb.issues.some((i) => re.test(i)), String(re));
});
test("a non-string filter value keeps the filter, resets the value and reports it", () => {
  const f = { db: "s", table: "orders", column: "amount", op: "=", value: 5 };
  const wb = sheetOf({ filters: [f] });
  assert.equal(wb.worksheets[0].sheet.filters.length, 1);
  assert.equal(wb.worksheets[0].sheet.filters[0].value, "");
  assert.equal(wb.issues.length, 1);
});
test("a worksheet with no name falls back with the required-field message", () => {
  const wb = parseWorkbook(wbText({ dashboards: [{ sheet: {} }] }));
  assert.equal(wb.worksheets[0].name, "Worksheet");
  assert.ok(wb.issues.some((i) => /Tab name is required/.test(i)));
});

test("non-list entities, relationships and dashboards are reported, not silently reset", () => {
  const wb = parseWorkbook(wbText({ entities: {}, relationships: "x", dashboards: 5 }));
  assert.ok(wb.issues.some((i) => /tables weren't a list/.test(i)));
  assert.ok(wb.issues.some((i) => /relationships weren't a list/.test(i)));
  assert.ok(wb.issues.some((i) => /worksheets weren't a list/.test(i)));
});
test("a non-object sheet or marks, and an invalid active index, are reported", () => {
  const wb = parseWorkbook(wbText({ dashboards: [{ name: "A", sheet: "oops" }, { name: "B", sheet: { marks: [] } }], active: 7 }));
  assert.ok(wb.issues.some((i) => /settings weren't an object/.test(i)));
  assert.ok(wb.issues.some((i) => /marks weren't an object/.test(i)));
  assert.ok(wb.issues.some((i) => /active tab was invalid/.test(i)));
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
  assert.deepEqual(r.worksheets[0].sheet.period, period);
  assert.equal(r.worksheets[0].sheet.format.target, 5000);
  assert.equal(r.worksheets[0].sheet.format.downIsGood, true);
});
test("a bad date range is cleared and reported", () => {
  const base = { db: "sales", table: "orders", column: "created", category: "temporal", preset: "last30", compare: "previous" };
  for (const bad of [{ ...base, preset: "forever" }, { ...base, compare: "tomorrow" }, { ...base, category: "text" },
    { ...base, from: "1st of May" }, { ...base, column: "" }]) {
    const r = sheetOf({ period: bad });
    assert.equal(r.worksheets[0].sheet.period, null);
    assert.ok(r.issues.some((i) => /date range cleared/.test(i)), JSON.stringify(r.issues));
  }
});
test("a non-numeric target is cleared and reported", () => {
  const r = sheetOf({ format: { target: "lots" } });
  assert.equal(r.worksheets[0].sheet.format.target, null);
  assert.match(r.issues.join(" "), /target/);
});

test("conditional formatting (P37) round-trips; bad parts are dropped and reported", () => {
  const good = { "s.orders.amount:sum": { mode: "scale", scale: "diverging", mid: 0, rules: [{ op: ">", value: 100, tone: "good" }] } };
  const ok = sheetOf({ chartType: "table", format: { conditional: good } });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.worksheets[0].sheet.format.conditional, good);
  const bad = sheetOf({ format: { conditional: {
    a: { mode: "rainbow", scale: "sequential", mid: null, rules: [] },
    b: { mode: "bars", scale: "sequential", mid: null, rules: [{ op: ">", value: "lots", tone: "good" }, { op: "<", value: 1, tone: "bad" }] },
  } } });
  assert.deepEqual(Object.keys(bad.worksheets[0].sheet.format.conditional), ["b"]);
  assert.equal(bad.worksheets[0].sheet.format.conditional.b.rules.length, 1);
  assert.equal(bad.issues.length, 2);
});

test("the workbook theme (P41) round-trips; a missing one is the default", () => {
  const st = sampleState();
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, theme: { accent: "violet" } })));
  assert.deepEqual(wb.theme, { accent: "violet" });
  assert.deepEqual(sheetOf({}).theme, { accent: "signal" });
});
test("a workbook saved with a chart palette (an older version) opens with its accent and look, no issue, and saves without the palette", () => {
  const st = sampleState();
  for (const palette of ["okabe", "onedark", "muted", "default"]) {
    const saved = JSON.parse(JSON.stringify(serializeWorkbook({ ...st, theme: { accent: "violet", surface: "onedark" } })));
    saved.theme.palette = palette; // what an older build wrote
    const wb = parseWorkbook(JSON.stringify(saved));
    assert.deepEqual(wb.theme, { accent: "violet", surface: "onedark" }, palette);
    assert.deepEqual(wb.issues.filter((i) => /theme/i.test(i)), [], palette);
    assert.equal("palette" in serializeWorkbook({ ...st, theme: wb.theme }).theme, false);
  }
});

test("imported colour palettes round-trip in order; none are written when there are none; a file without them opens clean", () => {
  const st = sampleState();
  const saved = serializeWorkbook({ ...st, palettes: [{ name: "Brand", colours: ["#112233", "#aabbcc"] }, { name: "Dusk", colours: ["#445566"] }] });
  assert.deepEqual(saved.palettes, [{ name: "Brand", colours: ["#112233", "#aabbcc"] }, { name: "Dusk", colours: ["#445566"] }]);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.palettes, saved.palettes);
  assert.deepEqual(wb.issues.filter((i) => /palette/i.test(i)), []);
  assert.equal("palettes" in serializeWorkbook({ ...st, palettes: [] }), false, "nothing written for none");
  assert.equal("palettes" in serializeWorkbook(st), false);
  const old = parseWorkbook(JSON.stringify(serializeWorkbook(st)));
  assert.deepEqual(old.palettes, []);
  assert.deepEqual(old.issues.filter((i) => /palette/i.test(i)), []);
});
test("a saved palette that is not usable is dropped on open with a reason; the others and the rest of the workbook open", () => {
  const st = sampleState();
  const saved = JSON.parse(JSON.stringify(serializeWorkbook({ ...st, palettes: [{ name: "Brand", colours: ["#112233"] }] })));
  saved.palettes.push({ name: "Broken", colours: ["#112233", "blue"] }, "junk");
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.palettes, [{ name: "Brand", colours: ["#112233"] }]);
  assert.equal(wb.issues.filter((i) => /palette/i.test(i)).length, 2);
  assert.ok(wb.worksheets.length >= 0);
  saved.palettes = "nope";
  assert.deepEqual(parseWorkbook(JSON.stringify(saved)).palettes, []);
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
  assert.deepEqual(r.worksheets[0].sheet.columns[0].choices, [shown, alt]);
  assert.ok(r.issues.some((i) => /field choices/.test(i)));
  const lone = sheetOf({ columns: [{ ...shown, choices: [shown] }] });
  assert.equal(lone.worksheets[0].sheet.columns[0].choices, undefined);
});

test("a date part (P26) is kept on a date pill and reset elsewhere", () => {
  const d = { db: "s", table: "orders", column: "created", category: "temporal" };
  assert.equal(sheetOf({ columns: [{ ...d, datePart: "month" }] }).worksheets[0].sheet.columns[0].datePart, "month");
  const bad = sheetOf({ columns: [{ ...d, datePart: "fortnight" }, { db: "s", table: "orders", column: "region", category: "text", datePart: "year" }] });
  assert.equal(bad.worksheets[0].sheet.columns[0].datePart, undefined);
  assert.equal(bad.worksheets[0].sheet.columns[1].datePart, undefined);
  assert.equal(bad.issues.filter((i) => /date part/.test(i)).length, 2);
});

test("a table calculation (P27) is kept when valid and removed when not", () => {
  const m = { db: "s", table: "orders", column: "amount", category: "numeric" };
  assert.deepEqual(sheetOf({ rows: [{ ...m, tableCalc: { type: "moving", along: "rows", window: 5 } }] }).worksheets[0].sheet.rows[0].tableCalc,
    { type: "moving", along: "rows", window: 5 });
  const bad = sheetOf({ rows: [{ ...m, tableCalc: { type: "median-ish" } }, { ...m, column: "qty", tableCalc: { type: "moving", window: 99 } }] });
  assert.equal(bad.worksheets[0].sheet.rows[0].tableCalc, undefined);
  assert.equal(bad.worksheets[0].sheet.rows[1].tableCalc, undefined);
  assert.equal(bad.issues.filter((i) => /table calculation/.test(i)).length, 2);
});

test("a filter on a measure is kept when valid and removed when not", () => {
  const m = { db: "s", table: "orders", column: "amount", category: "numeric", agg: "sum" };
  const ok = sheetOf({ rows: [{ ...m, having: { op: ">=", value: "1000", junk: 1 } }, { ...m, column: "q", having: { op: "between", values: ["1", "5"] } }] }).worksheets[0].sheet.rows;
  assert.deepEqual(ok[0].having, { op: ">=", value: "1000" });
  assert.deepEqual(ok[1].having, { op: "between", values: ["1", "5"] });
  const bad = sheetOf({ rows: [{ ...m, having: { op: ">", value: "abc" } }, { ...m, column: "q", having: { op: "like", value: "1" } }] });
  assert.equal(bad.worksheets[0].sheet.rows[0].having, undefined);
  assert.equal(bad.worksheets[0].sheet.rows[1].having, undefined);
  assert.equal(bad.issues.filter((i) => /measure filter/.test(i)).length, 2);
  const empty = sheetOf({ rows: [{ ...m, having: { op: ">=", value: "" } }] }); // chosen, not yet typed: dropped without a complaint
  assert.equal(empty.worksheets[0].sheet.rows[0].having, undefined);
  assert.equal(empty.issues.filter((i) => /measure filter/.test(i)).length, 0);
});

test("field settings (P28) round-trip; bad ones are dropped and counted", () => {
  const st = sampleState();
  const meta = new Map([["s.orders.amount", { alias: "Revenue", agg: "avg" }], ["s.orders.secret", { hidden: true }]]);
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, fieldMeta: meta })));
  assert.deepEqual(wb.fields, { "s.orders.amount": { alias: "Revenue", agg: "avg" }, "s.orders.secret": { hidden: true } });
  const bad = parseWorkbook(wbText({ fields: { "nodots": { alias: "x" }, "s.t.c": { alias: "", agg: "mode", hidden: "yes" }, "s.t.ok": { alias: "Fine" } } }));
  assert.deepEqual(bad.fields, { "s.t.ok": { alias: "Fine" } });
  assert.ok(bad.issues.some((i) => /4 field setting/.test(i)));
});

test("title, caption, showTitle and fit (P23) are checked", () => {
  const ok = sheetOf({ title: "Sales", caption: "By region", showTitle: false, format: { fit: "entire" } }).worksheets[0].sheet;
  assert.deepEqual([ok.title, ok.caption, ok.showTitle, ok.format.fit], ["Sales", "By region", false, "entire"]);
  const bad = sheetOf({ title: 7, caption: "x".repeat(301), format: { fit: "stretch" } });
  const s = bad.worksheets[0].sheet;
  assert.deepEqual([s.title, s.caption, s.format.fit], [null, null, "standard"]);
  assert.equal(bad.issues.length, 3);
});

test("a 3rd or 4th order polynomial trend is kept; a 5th order is reset", () => {
  for (const t of ["poly3", "poly4"]) assert.equal(sheetOf({ analytics: { trend: t } }).worksheets[0].sheet.analytics.trend, t);
  assert.equal(sheetOf({ analytics: { trend: "poly5" } }).worksheets[0].sheet.analytics.trend, "none");
});
test("analytics settings (P21) are kept when valid and reset part by part", () => {
  const ok = sheetOf({ analytics: { ref: { kind: "constant", value: 5 }, band: { from: 9, to: 2 }, trend: "poly2", forecast: 6, totals: { grand: true } } }).worksheets[0].sheet.analytics;
  assert.deepEqual(ok, { ref: { kind: "constant", value: 5 }, band: { from: 2, to: 9 }, trend: "poly2", forecast: 6, totals: { grand: true, sub: false } });
  const bad = sheetOf({ analytics: { ref: { kind: "mode" }, trend: "cubic", forecast: 99 } });
  assert.deepEqual(bad.worksheets[0].sheet.analytics.trend, "none");
  for (const t of ["exp", "power"]) assert.equal(sheetOf({ analytics: { trend: t } }).worksheets[0].sheet.analytics.trend, t);
  assert.ok(bad.issues.some((i) => /analytics/.test(i)));
});

test("reference line measure and distribution bands (T07) are kept when valid, reset when not", () => {
  const ok = sheetOf({ analytics: { ref: { kind: "average", measure: 2 }, band: { kind: "stddev", k: 2 } } }).worksheets[0].sheet.analytics;
  assert.deepEqual([ok.ref, ok.band], [{ kind: "average", measure: 2 }, { kind: "stddev", k: 2 }]);
  const pc = sheetOf({ analytics: { band: { kind: "percentile", lo: 25, hi: 75 } } }).worksheets[0].sheet.analytics;
  assert.deepEqual(pc.band, { kind: "percentile", lo: 25, hi: 75 });
  for (const band of [{ kind: "stddev", k: 3 }, { kind: "percentile", lo: 80, hi: 20 }, { kind: "percentile", lo: 0, hi: 95 }, { kind: "percentile", lo: 5, hi: 100 }, { kind: "x" }]) {
    const r = sheetOf({ analytics: { band } });
    assert.equal(r.worksheets[0].sheet.analytics.band, null);
    assert.ok(r.issues.some((i) => /analytics/.test(i)));
  }
  const m = sheetOf({ analytics: { ref: { kind: "median", measure: 99 } } });
  assert.deepEqual(m.worksheets[0].sheet.analytics.ref, { kind: "median" });
  assert.ok(m.issues.some((i) => /analytics/.test(i)));
});

test("the trend's measure (T07-01) is kept when a valid shown-measure index, rejected otherwise", () => {
  const ok = sheetOf({ analytics: { trend: "linear", trendMeasure: 2 } }).worksheets[0].sheet.analytics;
  assert.equal(ok.trendMeasure, 2);
  assert.equal("trendMeasure" in sheetOf({ analytics: { trend: "linear" } }).worksheets[0].sheet.analytics, false);
  assert.equal("trendMeasure" in sheetOf({ analytics: { trendMeasure: 0 } }).worksheets[0].sheet.analytics, false);
  for (const trendMeasure of [-1, 20, 1.5, "1", null]) {
    const r = sheetOf({ analytics: { trend: "log", trendMeasure } });
    assert.equal("trendMeasure" in r.worksheets[0].sheet.analytics, false);
    assert.equal(r.worksheets[0].sheet.analytics.trend, "log");
    assert.ok(r.issues.some((i) => /analytics/.test(i)), String(trendMeasure));
  }
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
  st.tabs[0].sheet.format = { ...st.tabs[0].sheet.format, topNParam: "prm1" };
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, parameters: params })));
  assert.deepEqual(wb.parameters, params);
  assert.equal(wb.worksheets[0].sheet.format.topNParam, "prm1");
  const orphan = parseWorkbook(wbText({ dashboards: [{ name: "S", sheet: { format: { topNParam: "prm7" },
    filters: [{ db: "s", table: "t", column: "c", category: "numeric", op: "=", value: "1", param: "prm8" }] } }] }));
  assert.equal(orphan.worksheets[0].sheet.format.topNParam, undefined);
  assert.equal(orphan.worksheets[0].sheet.filters[0].param, undefined);
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
  const s = wb.worksheets[0].sheet;
  assert.equal(s.rows.length, 1); assert.equal(s.rows[0].calc, "calc1");
  assert.equal(s.columns.length, 1);
  assert.equal(s.marks.size, null);
  assert.ok(wb.issues.includes('Sheet "X" rows: a calculated field that no longer exists was removed.'));
});

test("a countNonNull pill and field default round-trip and are not reset", () => {
  const wb = sheetOf({ rows: [pill({ category: "text", column: "status", agg: "countNonNull" })] });
  assert.equal(wb.worksheets[0].sheet.rows[0].agg, "countNonNull");
  assert.deepEqual(wb.issues, []);
  const f = parseWorkbook(wbText({ fields: { "s.orders.amount": { agg: "countNonNull" } } }));
  assert.deepEqual(f.fields, { "s.orders.amount": { agg: "countNonNull" } });
});

const cpill = (o = {}) => ({ calc: "calc1", db: "", table: "", column: "Margin", category: "numeric", role: "measure", agg: "sum", ...o });
const calcList = [{ id: "calc1", name: "Margin", formula: "1" }];
const topFilter = (topBy) => ({ db: "s", table: "orders", column: "region", category: "text", op: "top", value: "5", topBy });

test("a Top-N ranked by a calculation survives save and open", () => {
  const st = sampleState();
  st.tabs[0].sheet.filters = [topFilter({ db: "", table: "", column: "Margin", calc: "calc1", agg: "sum" })];
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook({ ...st, calculations: calcList })));
  assert.deepEqual(wb.worksheets[0].sheet.filters[0].topBy, { db: "", table: "", column: "Margin", calc: "calc1", agg: "sum" });
  assert.deepEqual(wb.issues, []);
});
test("a Top-N ranked by a missing calculation is dropped and reported", () => {
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { filters: [
    topFilter({ db: "", table: "", column: "Old", calc: "calc9", agg: "sum" }), topFilter({ db: "s", table: "orders", column: "amount", agg: "sum" })] } }] }));
  assert.equal(wb.worksheets[0].sheet.filters.length, 1);
  assert.equal(wb.worksheets[0].sheet.filters[0].topBy.column, "amount");
  assert.ok(wb.issues.some((i) => /Sheet "X" filters: .*calculat.* no longer exists/.test(i)));
});
test("a calc Top-N with a malformed id is dropped", () => {
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { filters: [topFilter({ db: "", table: "", column: "M", calc: "nope" })] } }] }));
  assert.equal(wb.worksheets[0].sheet.filters.length, 0);
});
test("a calc pill's agg outside the row-level list is reset to sum", () => {
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { rows: [cpill({ agg: "count" })] } }] }));
  assert.equal(wb.worksheets[0].sheet.rows[0].agg, "sum");
  assert.ok(wb.issues.some((i) => /can't use "count"/.test(i)));
  const ok = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { rows: [cpill({ agg: "countDistinct" })] } }] }));
  assert.equal(ok.worksheets[0].sheet.rows[0].agg, "countDistinct");
  assert.deepEqual(ok.issues, []);
});
test("a calc pill never keeps a date part", () => {
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { rows: [cpill({ category: "temporal", role: "dimension", agg: undefined, datePart: "month" })] } }] }));
  assert.equal("datePart" in wb.worksheets[0].sheet.rows[0], false);
});
test("calc pills are dropped from drill levels, period, pages and shared filters; a sheet filter keeps its calculation", () => {
  const dim = (o) => cpill({ category: "text", role: "dimension", agg: undefined, ...o });
  const wb = parseWorkbook(wbText({ calculations: calcList, sharedFilters: [{ ...dim(), op: "=", value: "a" }],
    dashboards: [{ name: "X", sheet: {
      filters: [{ ...dim(), op: "=", value: "a" }, { ...dim(), op: "top", value: "5", topBy: { db: "s", table: "o", column: "a", agg: "sum" } }],
      pages: { ...dim(), index: 0 },
      period: { ...cpill({ category: "temporal", role: "dimension", agg: undefined }), preset: "last30", compare: "none" },
      drill: { levels: [dim(), dim({ calc: "calc1" }), pill({ category: "text", column: "x" })], depth: 0, path: [] } }, }] }));
  const s = wb.worksheets[0].sheet;
  assert.equal(s.filters.length, 1); assert.equal(s.filters[0].calc, "calc1"); assert.equal(s.filters[0].op, "=");
  assert.equal(s.pages, null); assert.equal(s.period, null); assert.equal(s.drill, null);
  assert.equal(wb.sharedFilters.length, 0);
  assert.ok(wb.issues.some((i) => /calculated field/.test(i)));
});
test("a calculated filter whose calculation is gone is removed on open; an in-list keeps its values", () => {
  const f = (o) => ({ ...cpill({ category: "text", role: undefined, agg: undefined }), op: "in", value: "", values: ["a", "b"], ...o });
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { filters: [f({}), f({ calc: "calc9" })] } }] }));
  assert.equal(wb.worksheets[0].sheet.filters.length, 1);
  assert.deepEqual(wb.worksheets[0].sheet.filters[0].values, ["a", "b"]);
});
test("nextCalcId round-trips; absent or invalid falls back to undefined", () => {
  const st = sampleState();
  const saved = serializeWorkbook({ ...st, calculations: calcList, nextCalcId: 7 });
  assert.equal(saved.nextCalcId, 7);
  assert.equal(parseWorkbook(JSON.stringify(saved)).nextCalcId, 7);
  assert.equal(serializeWorkbook({ ...st, calculations: [{ id: "calc4", name: "Q", formula: "1" }] }).nextCalcId, 5);
  assert.equal(parseWorkbook(wbText({})).nextCalcId, undefined);
  assert.equal(parseWorkbook(wbText({ nextCalcId: -3 })).nextCalcId, undefined);
});
test("a not in filter round-trips with its values; a non-text member is rejected", () => {
  const f = { db: "s", table: "orders", column: "city", category: "text", op: "notin", value: "", values: ["NY", "LA"] };
  const ok = sheetOf({ filters: [f] });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.worksheets[0].sheet.filters[0].values, ["NY", "LA"]);
  const bad = sheetOf({ filters: [{ ...f, values: [1] }] });
  assert.equal(bad.worksheets[0].sheet.filters.length, 0);
  assert.equal(bad.issues.length, 1);
});

test("right and full join types (T02-12/13) round-trip; an old workbook without joinType still reads as inner", () => {
  for (const t of ["right", "full"]) {
    const st = sampleState();
    [...st.relationships.values()][0].joinType = t;
    assert.equal(parseWorkbook(JSON.stringify(serializeWorkbook(st))).relationships[0].joinType, t);
  }
  const raw = JSON.parse(JSON.stringify(serializeWorkbook(sampleState())));
  delete raw.relationships[0].joinType;
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships[0].joinType, "inner");
});

test("joinFixed round-trips; an old file without it reads as false, junk as false", () => {
  const st = sampleState();
  [...st.relationships.values()][0].joinFixed = true;
  assert.equal(parseWorkbook(JSON.stringify(serializeWorkbook(st))).relationships[0].joinFixed, true);
  const raw = JSON.parse(JSON.stringify(serializeWorkbook(sampleState())));
  delete raw.relationships[0].joinFixed;
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships[0].joinFixed, false);
  raw.relationships[0].joinFixed = "yes";
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships[0].joinFixed, false);
});

test("a table calculation's chosen dimensions (custom) are kept when valid and removed when not", () => {
  const m = { db: "s", table: "orders", column: "amount", category: "numeric" };
  const keep = sheetOf({ rows: [{ ...m, tableCalc: { type: "running", along: "custom", using: [0, 2] } }] }).worksheets[0].sheet.rows[0].tableCalc;
  assert.deepEqual(keep, { type: "running", along: "custom", using: [0, 2] });
  assert.deepEqual(sheetOf({ rows: [{ ...m, tableCalc: { type: "pctRank", along: "auto" } }] }).worksheets[0].sheet.rows[0].tableCalc, { type: "pctRank", along: "auto" });
  for (const using of [[-1], [1.5], ["a"], [0, 0], Array.from({ length: 17 }, (_, i) => i), "0"]) {
    const bad = sheetOf({ rows: [{ ...m, tableCalc: { type: "running", along: "custom", using } }] });
    assert.equal(bad.worksheets[0].sheet.rows[0].tableCalc, undefined, JSON.stringify(using));
  }
  // using only means something with custom
  assert.deepEqual(sheetOf({ rows: [{ ...m, tableCalc: { type: "running", along: "rows", using: [0] } }] }).worksheets[0].sheet.rows[0].tableCalc, { type: "running", along: "rows" });
});

test("date labels (show all / thin out) are kept on a date pill, back-compat when absent, reset elsewhere", () => {
  const d = { db: "s", table: "orders", column: "created", category: "temporal" };
  const col = (extra) => sheetOf({ columns: [{ ...d, ...extra }] }).worksheets[0].sheet.columns[0];
  assert.equal(col({ dateLabels: "all" }).dateLabels, "all");
  assert.equal(col({ dateLabels: "thin" }).dateLabels, "thin");
  assert.equal("dateLabels" in col({}), false); // an older workbook has none
  const bad = sheetOf({ columns: [{ ...d, dateLabels: "some" }, { db: "s", table: "orders", column: "region", category: "text", dateLabels: "all" }] });
  assert.equal(bad.worksheets[0].sheet.columns[0].dateLabels, undefined);
  assert.equal(bad.worksheets[0].sheet.columns[1].dateLabels, undefined);
  assert.equal(bad.issues.filter((i) => /date labels/.test(i)).length, 2);
});

test("a union entity is saved with its source and opened with it, keeping its name as the table", () => {
  const state = sampleState();
  const source = { kind: "union", db: "sales", name: "Union: orders + customers", tables: ["orders", "customers"], extra: "dropped" };
  state.entities.set("u#3", { id: "u#3", db: "sales", table: source.name, x: 5, y: 6, columns: [], joinKeys: new Set(), el: null, source });
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state)));
  assert.deepEqual(saved.entities[2].source, { kind: "union", db: "sales", name: source.name, tables: ["orders", "customers"] });
  assert.equal("source" in saved.entities[0], false);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.issues, []);
  assert.deepEqual(wb.entities[2], { id: "u#3", db: "sales", table: source.name, x: 5, y: 6, joinKeys: [], source: { kind: "union", db: "sales", name: source.name, tables: ["orders", "customers"] } });
});
test("an unpivot entity round-trips its columns and kept columns", () => {
  const state = sampleState();
  const source = { kind: "unpivot", db: "sales", name: "Unpivot: orders", table: "orders", columns: ["q1", "q2"], keep: ["region"] };
  state.entities.set("u#3", { id: "u#3", db: "sales", table: source.name, x: 0, y: 0, columns: [], joinKeys: new Set(), el: null, source });
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  assert.deepEqual(wb.entities[2].source, source);
});
test("a hand-edited source that breaks the rules is skipped and reported, not opened", () => {
  const state = sampleState();
  state.entities.set("u#3", { id: "u#3", db: "sales", table: "N", x: 0, y: 0, columns: [], joinKeys: new Set(), el: null, source: { kind: "union", db: "sales", name: "N", tables: ["orders"] } });
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  assert.equal(wb.entities.length, 2);
  assert.ok(wb.issues.some((i) => /union or unpivot definition/.test(i)));
});
test("a source entity with the same db.table as a real one is skipped with an issue", () => {
  const state = sampleState();
  const src = { kind: "union", db: "sales", name: "orders", tables: ["a", "b"] };
  state.entities.set("u#3", { id: "u#3", db: "sales", table: "orders", x: 0, y: 0, columns: [], joinKeys: new Set(), el: null, source: src });
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  assert.equal(wb.entities.length, 2);
  assert.ok(wb.entities.every((e) => !e.source));
  assert.ok(wb.issues.some((i) => /second copy of sales\.orders/.test(i)));
});
test("a relationship with a source entity at an end is dropped with an issue", () => {
  const state = sampleState();
  const src = { kind: "union", db: "sales", name: "U", tables: ["orders", "customers"] };
  state.entities.set("u#3", { id: "u#3", db: "sales", table: "U", x: 0, y: 0, columns: [], joinKeys: new Set(), el: null, source: src });
  state.relationships.set("rel#2", { id: "rel#2", from: { entityId: "sales.orders#1", column: "id" }, to: { entityId: "u#3", column: "id" }, cardinality: "N:1" });
  const wb = parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  assert.equal(wb.relationships.length, 1);
  assert.equal(wb.relationships[0].to.entityId, "sales.customers#2");
  assert.ok(wb.issues.some((i) => /relationship.*union or unpivot/i.test(i)));
});

test("a column in two relationships keeps only the first, and says so", () => {
  const raw = serializeWorkbook(sampleState());
  raw.relationships.push({ from: { entityId: "sales.orders#1", column: "customer_id" }, to: { entityId: "sales.customers#2", column: "region" }, cardinality: "N:1" });
  raw.relationships.push({ from: { entityId: "sales.orders#1", column: "region" }, to: { entityId: "sales.customers#2", column: "region" }, cardinality: "N:1" });
  const wb = parseWorkbook(JSON.stringify(raw));
  assert.equal(wb.relationships.length, 2); // customer_id↔id kept, the reuse of customer_id dropped, region↔region kept
  assert.ok(wb.issues.some((i) => /reused a column/.test(i)));
});

// --- compound keys
const compound = () => {
  const s = sampleState();
  s.relationships.get("rel#1").pairs = [{ from: "region", to: "area" }];
  return s;
};
test("extra key pairs round-trip; an ordinary relationship saves no `pairs`", () => {
  assert.equal("pairs" in serializeWorkbook(sampleState()).relationships[0], false);
  const saved = serializeWorkbook(compound());
  assert.deepEqual(saved.relationships[0].pairs, [{ from: "region", to: "area" }]);
  assert.deepEqual(saved.entities[0].joinKeys.sort(), ["customer_id", "region"]);
  assert.deepEqual(parseWorkbook(JSON.stringify(saved)).relationships[0].pairs, [{ from: "region", to: "area" }]);
});
test("a v2 workbook with no `pairs` still opens, and bad pairs are dropped with an issue", () => {
  const raw = serializeWorkbook(compound());
  const okWb = parseWorkbook(JSON.stringify(raw));
  assert.equal(parseWorkbook(JSON.stringify(serializeWorkbook(sampleState()))).relationships[0].pairs, undefined);
  assert.equal(okWb.relationships.length, 1);
  raw.relationships[0].pairs = [{ from: "region", to: "area" }, { from: "region", to: "z" }, { from: 1, to: "q" }, { from: "customer_id", to: "w" }, { from: "a", to: "b" }, { from: "c", to: "d" }, { from: "e", to: "f" }];
  const wb = parseWorkbook(JSON.stringify(raw));
  assert.deepEqual(wb.relationships[0].pairs, [{ from: "region", to: "area" }, { from: "a", to: "b" }, { from: "c", to: "d" }]);
  assert.ok(wb.issues.some((i) => /key pair/.test(i)));
});
test("a pair reusing a column of another relationship is dropped", () => {
  const raw = serializeWorkbook(compound());
  raw.relationships.push({ from: { entityId: "sales.orders#1", column: "x" }, to: { entityId: "sales.customers#2", column: "y" }, cardinality: "1:1", pairs: [{ from: "region", to: "q" }] });
  const wb = parseWorkbook(JSON.stringify(raw));
  assert.equal(wb.relationships[1].pairs, undefined);
});

test("a calculated filter with a relative-date operator is removed with a message", () => {
  const f = { ...cpill({ category: "temporal", role: undefined, agg: undefined }), op: "relative", value: "last30" };
  const wb = parseWorkbook(wbText({ calculations: calcList, dashboards: [{ name: "X", sheet: { filters: [f] } }] }));
  assert.equal(wb.worksheets[0].sheet.filters.length, 0);
  assert.ok(wb.issues.some((i) => /relative-date/.test(i)));
});

test("a saved file's old bookmarks are ignored without a report", () => {
  const wb = parseWorkbook(wbText({ dashboards: [{ name: "X", sheet: {} }], bookmarks: [{ name: "B", dashboard: 0, sheet: {}, sharedFilters: [] }, 5] }));
  assert.equal(wb.bookmarks, undefined);
  assert.deepEqual(wb.issues, []);
});

test("a saved parameter action or band parameter that points at a missing parameter is dropped on open (ids are reused)", () => {
  const raw = (params) => wbText({ parameters: params, dashboards: [{ name: "S", sheet: { paramAction: { param: "prm1" },
    analytics: { ref: { kind: "none" }, band: { from: 0, to: 9, fromParam: "prm1", toParam: "prm2" } } } }] });
  const p = (id, name) => ({ id, name, type: "number", value: 5, allowed: { kind: "any" } });
  const kept = parseWorkbook(raw([p("prm1", "A"), p("prm2", "B")])).worksheets[0].sheet;
  assert.deepEqual(kept.paramAction, { param: "prm1" });
  assert.equal(kept.analytics.band.fromParam, "prm1");
  assert.equal(kept.analytics.band.toParam, "prm2");
  const gone = parseWorkbook(raw([p("prm2", "B")]));
  assert.equal(gone.worksheets[0].sheet.paramAction, null);
  assert.equal(gone.worksheets[0].sheet.analytics.band.fromParam, undefined);
  assert.equal(gone.worksheets[0].sheet.analytics.band.toParam, "prm2");
  assert.ok(gone.issues.some((i) => /parameter action/.test(i)));
});
test("a moving-average window parameter and a forecast parameter survive a save/restore and are unlinked when missing", () => {
  const field = { db: "s", table: "t", column: "amount", category: "numeric", agg: "sum", tableCalc: { type: "moving", along: "auto", window: 4, windowParam: "prm1" } };
  const raw = (params) => wbText({ parameters: params, dashboards: [{ name: "S", sheet: { rows: [field], analytics: { forecast: 6, forecastParam: "prm1" } } }] });
  const p = { id: "prm1", name: "A", type: "number", value: 5, allowed: { kind: "any" } };
  const kept = parseWorkbook(raw([p]));
  assert.equal(kept.worksheets[0].sheet.rows[0].tableCalc.windowParam, "prm1");
  assert.equal(kept.worksheets[0].sheet.analytics.forecastParam, "prm1");
  assert.equal(kept.worksheets[0].sheet.analytics.forecast, 6);
  const gone = parseWorkbook(raw([]));
  assert.equal(gone.worksheets[0].sheet.rows[0].tableCalc.windowParam, undefined);
  assert.equal(gone.worksheets[0].sheet.rows[0].tableCalc.window, 4);
  assert.equal(gone.worksheets[0].sheet.analytics.forecastParam, undefined);
  assert.ok(gone.issues.some((i) => /window/.test(i)) && gone.issues.some((i) => /forecast/.test(i)));
  const bad = parseWorkbook(wbText({ parameters: [p], dashboards: [{ name: "S", sheet: { analytics: { forecast: 3, forecastParam: "x<" } } }] }));
  assert.equal(bad.worksheets[0].sheet.analytics.forecastParam, undefined);
});
test("a custom percentile band survives a save/restore", () => {
  const r = sheetOf({ analytics: { band: { kind: "percentile", lo: 5, hi: 95 } } });
  assert.deepEqual(r.worksheets[0].sheet.analytics.band, { kind: "percentile", lo: 5, hi: 95, custom: true });
  const c = sheetOf({ analytics: { band: { kind: "percentile", lo: 10, hi: 90, custom: true } } });
  assert.deepEqual(c.worksheets[0].sheet.analytics.band, { kind: "percentile", lo: 10, hi: 90, custom: true });
});
test("a custom percentile band with equal, NaN or string ends is reset on restore", () => {
  for (const [lo, hi] of [[50, 50], [NaN, 90], ["5", 95], [5, "95"], [5, null]]) {
    const r = sheetOf({ analytics: { band: { kind: "percentile", lo, hi, custom: true } } });
    assert.equal(r.worksheets[0].sheet.analytics.band, null, `${lo}-${hi}`);
    assert.ok(r.issues.some((i) => /analytics/.test(i)));
  }
});

test("a rank calculation keeps a valid order and tie rule and drops an invalid one", () => {
  const m = { db: "s", table: "orders", column: "amount", category: "numeric" };
  const ok = sheetOf({ rows: [{ ...m, tableCalc: { type: "rank", order: "asc", ties: "dense" } }] }).worksheets[0].sheet.rows[0].tableCalc;
  assert.deepEqual(ok, { type: "rank", along: "auto", order: "asc", ties: "dense" });
  const bad = sheetOf({ rows: [{ ...m, tableCalc: { type: "rank", ties: "nope" } }] });
  assert.equal(bad.worksheets[0].sheet.rows[0].tableCalc, undefined);
});

// --- aggregate before joining
test("aggregateFirst and a single-way filter direction round-trip; a plain relationship saves neither", () => {
  assert.equal("aggregateFirst" in serializeWorkbook(sampleState()).relationships[0], false);
  const s = sampleState();
  Object.assign(s.relationships.get("rel#1"), { aggregateFirst: true, filterDirection: "single" });
  const saved = serializeWorkbook(s);
  assert.equal(saved.relationships[0].aggregateFirst, true);
  assert.equal(saved.relationships[0].filterDirection, "single");
  const back = parseWorkbook(JSON.stringify(saved)).relationships[0];
  assert.equal(back.aggregateFirst, true);
  assert.equal(back.filterDirection, "single");
});
test("an old file, a non-boolean flag and an unknown direction all read as the plain join", () => {
  const raw = serializeWorkbook(sampleState());
  assert.equal(parseWorkbook(JSON.stringify(raw)).relationships[0].aggregateFirst, undefined);
  Object.assign(raw.relationships[0], { aggregateFirst: "yes", filterDirection: "up" });
  const r = parseWorkbook(JSON.stringify(raw)).relationships[0];
  assert.equal(r.aggregateFirst, undefined);
  assert.equal(r.filterDirection, undefined);
  Object.assign(raw.relationships[0], { aggregateFirst: true, filterDirection: "up" });
  const t = parseWorkbook(JSON.stringify(raw)).relationships[0];
  assert.equal(t.aggregateFirst, true);
  assert.equal(t.filterDirection, undefined); // both is the default, never stored
});

test("a conditional rule with no threshold yet survives import; a long currency symbol is kept up to 8 characters", () => {
  const key = "shop.orders.amount:sum";
  const wb = parseWorkbook(wbText({ entities: [], dashboards: [{ name: "S", sheet: {
    rows: [pill({})],
    format: { currencySymbol: "ABCD", conditional: { [key]: { mode: "none", scale: "sequential", mid: null, rules: [{ op: ">", value: null, tone: "good" }] } } },
  } }] }));
  const sh = wb.worksheets[0].sheet;
  assert.deepEqual(sh.format.conditional[key].rules, [{ op: ">", value: null, tone: "good" }]);
  assert.equal(sh.format.currencySymbol, "ABCD"); // the import keeps what it always accepted: a string up to 8 characters
  const long = parseWorkbook(wbText({ entities: [], dashboards: [{ name: "S", sheet: { rows: [pill({})], format: { currencySymbol: "123456789" } } }] }));
  assert.equal(long.worksheets[0].sheet.format.currencySymbol, "$");
  const ok = parseWorkbook(wbText({ entities: [], dashboards: [{ name: "S", sheet: { rows: [pill({})], format: { currencySymbol: "RM" } } }] }));
  assert.equal(ok.worksheets[0].sheet.format.currencySymbol, "RM");
});

test("custom SQL on a table card is saved and opened with it; the card stays an ordinary table (D105)", () => {
  const state = sampleState();
  const first = [...state.entities.values()][0];
  first.customSql = "SELECT a, b FROM sales.t";
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state)));
  assert.equal(saved.entities[0].customSql, "SELECT a, b FROM sales.t");
  assert.equal("customSql" in saved.entities[1], false);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.issues, []);
  assert.equal(wb.entities[0].customSql, "SELECT a, b FROM sales.t");
  assert.equal("source" in wb.entities[0], false);
});
test("a saved custom SQL that is not text of an allowed length is dropped with a note, not the card", () => {
  const state = sampleState();
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state)));
  saved.entities[0].customSql = 42;
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.equal(wb.entities.length, saved.entities.length);
  assert.equal("customSql" in wb.entities[0], false);
  assert.ok(wb.issues.some((i) => /custom SQL/.test(i)));
});

test("the MySQL text a custom SQL was written as is saved beside it and opened with it (D106); a bad one is dropped quietly", () => {
  const state = sampleState();
  const first = [...state.entities.values()][0];
  first.customSql = "SELECT a FROM sales.t LIMIT 3 OFFSET 2"; first.customSqlMysql = "SELECT a FROM sales.t LIMIT 2, 3";
  const saved = JSON.parse(JSON.stringify(serializeWorkbook(state)));
  assert.equal(saved.entities[0].customSqlMysql, "SELECT a FROM sales.t LIMIT 2, 3");
  assert.equal("customSqlMysql" in saved.entities[1], false);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(wb.issues, []);
  assert.equal(wb.entities[0].customSqlMysql, "SELECT a FROM sales.t LIMIT 2, 3");
  saved.entities[0].customSqlMysql = 7;
  const bad = parseWorkbook(JSON.stringify(saved));
  assert.deepEqual(bad.issues, []); assert.equal("customSqlMysql" in bad.entities[0], false); assert.equal(bad.entities[0].customSql, "SELECT a FROM sales.t LIMIT 3 OFFSET 2");
  // a MySQL text without a ClickHouse query is meaningless: it is not written
  delete first.customSql; assert.equal("customSqlMysql" in JSON.parse(JSON.stringify(serializeWorkbook(state))).entities[0], false);
});

// --- Data Source view (zoom + pan) is saved, so a reload keeps it instead of fitting ---
test("a saved view round-trips, rounded", () => {
  const state = { ...sampleState(), view: { zoom: 0.71234567, pan: { x: 12.6, y: -40.2 } } };
  const saved = serializeWorkbook(state);
  assert.deepEqual(saved.view, { zoom: 0.712, pan: { x: 13, y: -40 } });
  assert.deepEqual(parseWorkbook(JSON.stringify(saved)).view, { zoom: 0.712, pan: { x: 13, y: -40 } });
});

test("no view given: none saved, none read (the canvas fits on open)", () => {
  const saved = serializeWorkbook(sampleState());
  assert.equal("view" in saved, false);
  const wb = parseWorkbook(JSON.stringify(saved));
  assert.equal(wb.view, null);
  assert.deepEqual(wb.issues, []);
});

test("an invalid saved view is dropped with a note, never half-used", () => {
  for (const bad of [{ zoom: 9, pan: { x: 0, y: 0 } }, { zoom: 0.01, pan: { x: 0, y: 0 } }, { zoom: "1", pan: { x: 0, y: 0 } }, { zoom: 1, pan: { x: NaN, y: 0 } }, { zoom: 1, pan: { x: 1e9, y: 0 } }, { zoom: 1 }, 5, []]) {
    const wb = parseWorkbook(JSON.stringify({ ...serializeWorkbook(sampleState()), view: bad }));
    assert.equal(wb.view, null, JSON.stringify(bad));
    assert.ok(wb.issues.some((i) => /view/i.test(i)), JSON.stringify(bad));
  }
});

test("Aggregate Measures off is saved and restored; an older sheet stays aggregated and gains no key", () => {
  assert.equal(restoreSheet({ ...emptySheet(), disaggregate: true }).disaggregate, true);
  assert.equal("disaggregate" in restoreSheet({ ...emptySheet() }), false);
  assert.equal("disaggregate" in restoreSheet({ ...emptySheet(), disaggregate: "yes" }), false, "only true counts");
  assert.equal("disaggregate" in restoreSheet({ ...emptySheet(), disaggregate: false }), false);
});
