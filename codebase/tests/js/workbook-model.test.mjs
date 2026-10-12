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
    to: { entityId: "sales.customers#2", column: "id" }, cardinality: "N:1" });
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
