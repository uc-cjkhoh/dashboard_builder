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
