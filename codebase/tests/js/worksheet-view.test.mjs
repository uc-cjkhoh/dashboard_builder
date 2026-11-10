import { test } from "node:test";
import assert from "node:assert/strict";

// Two worksheet views side by side: own container, own latest-wins gate, shared result cache.
// A fake DOM and a fake fetch are all the view needs.
const fakeEl = (tag = "div") => ({ tag, className: "", children: [], hidden: false, textContent: "", onscroll: null, scrollTop: 0,
  classList: { toggle() {}, add() {}, remove() {} }, style: { setProperty() {} }, clientWidth: 600, clientHeight: 400,
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, addEventListener() {}, setAttribute() {},
  get firstChild() { return this.children[0]; } });
globalThis.document = { createElement: fakeEl, createElementNS: fakeEl, documentElement: {} };
const calls = [];
let gate = null;
globalThis.fetch = (url, opts) => {
  const body = JSON.parse(opts.body);
  calls.push(body);
  return new Promise((res, rej) => {
    const answer = () => res({ ok: true, status: 200, text: async () => JSON.stringify({ rowDimensions: ["region"], columnDimensions: [], measures: ["v0"], rows: [{ keys: [body.from.table], values: [1] }], truncated: false }) });
    opts.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
    if (gate) gate.then(answer); else answer();
  });
};

const { createWorksheetView } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-view.js");
const { createResultCache } = await import("../../src/DashboardBuilder/Features/Dashboard/query-runner.js");

const ent = (id, table) => ({ id, db: "shop", table, columns: [{ name: "id", type: "UInt32", category: "numeric" }, { name: "region", type: "String", category: "text" }] });
const planCtx = { calculations: [], entities: new Map([["e1", ent("e1", "orders")], ["e2", ent("e2", "people")]]), relationships: new Map([["r1", { id: "r1", from: { entityId: "e1", column: "id" }, to: { entityId: "e2", column: "id" }, cardinality: "1:1" }]]), // tables with no relationship are held out of views
  sharedFilters: [], parameters: [], metaOf: () => ({}), nameOf: (f) => f.column, columnType: () => "" };
const sheetOn = (table) => ({ columns: [{ db: "shop", table, column: "region", category: "text" }], rows: [{ db: "shop", table, column: "id", category: "numeric", agg: "sum" }],
  color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null, pages: null, format: {}, period: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null } });
const host = (id, table, results, drawn) => {
  const container = fakeEl();
  const view = createWorksheetView(container, () => ({
    dash: { id, sheet: sheetOn(table) }, noticeEl: fakeEl(), results, plan: planCtx, categoryOf: () => undefined, castOf: () => undefined,
  }), { draw: (_c, _sheet, result) => { drawn.push([id, result.rows[0].keys[0]]); return { extraNotice: null }; } });
  return { container, view };
};

test("two views run independently into their own containers", async () => {
  calls.length = 0;
  const results = createResultCache(), drawn = [];
  const a = host("ws#1", "orders", results, drawn), b = host("ws#2", "people", results, drawn);
  await Promise.all([a.view.run(), b.view.run()]);
  assert.deepEqual(drawn.map((d) => d.join(":")).sort(), ["ws#1:orders", "ws#2:people"]);
  assert.equal(calls.length, 2);
});
test("a view re-runs from the shared cache; refresh bypasses it", async () => {
  calls.length = 0;
  const results = createResultCache(), drawn = [];
  const a = host("ws#1", "orders", results, drawn);
  await a.view.run(); await a.view.run();
  assert.equal(calls.length, 1, "the second run is a cache hit");
  await a.view.refresh();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].fresh, true, "refresh asks the server to skip its cache");
});
test("cancelling one view never aborts or blanks another's query", async () => {
  calls.length = 0;
  let release; gate = new Promise((r) => { release = r; });
  const results = createResultCache(), drawn = [];
  const a = host("ws#1", "orders", results, drawn), b = host("ws#2", "people", results, drawn);
  const pa = a.view.run(), pb = b.view.run();
  a.view.cancel();
  release(); gate = null;
  await Promise.all([pa, pb]);
  assert.deepEqual(drawn, [["ws#2", "people"]], "only the cancelled view stayed undrawn");
});
test("destroy aborts the in-flight request, disposes the chart and clears onscroll; twice is safe", async () => {
  calls.length = 0;
  const signals = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => { signals.push(opts.signal); return realFetch(url, opts); };
  let release; gate = new Promise((r) => { release = r; });
  // a chart already live in the container, as after an earlier draw
  const inst = { disposed: false, setOption() {}, on() {}, dispatchAction() {}, resize() {}, dispose() { this.disposed = true; }, getWidth: () => 600, getHeight: () => 400, getDom: () => ({}) };
  globalThis.window = { echarts: { init: () => inst } };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const { renderChart, hasChartInstance } = await import("../../src/DashboardBuilder/Features/Dashboard/chart.js");
  const drawn = [];
  const a = host("ws#1", "orders", createResultCache(), drawn);
  renderChart(a.container, { type: "bar", categories: ["a"], series: [{ name: "v", data: [1] }], format: {} });
  a.container.onscroll = () => {};
  assert.ok(hasChartInstance(a.container));
  const p = a.view.run();            // pending on the gated fetch (run() disposes the old chart first)
  inst.disposed = false;
  renderChart(a.container, { type: "bar", categories: ["a"], series: [{ name: "v", data: [1] }], format: {} }); // a chart drawn while the request is pending
  assert.ok(hasChartInstance(a.container));
  a.container.onscroll = () => {};
  a.view.destroy(); a.view.destroy();
  release(); gate = null;
  await p;
  globalThis.fetch = realFetch;
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true, "the request was aborted");
  assert.equal(inst.disposed, true, "the chart was disposed");
  assert.equal(hasChartInstance(a.container), false);
  assert.equal(a.container.onscroll, null);
  assert.equal(drawn.length, 0, "nothing drawn after destroy");
});

// --- a view obeys the dashboard selection (options.cross) ---
const sel = (table, column, value, sourceWidgetId = "w#src") => ({ db: "shop", table, column, value, label: `${table}.${column} = ${value}`, sourceWidgetId });
const crossHost = (id, table, results, drawn, crossRef, noticeEl = fakeEl(), draws = []) => {
  const container = fakeEl();
  const view = createWorksheetView(container, () => ({ dash: { id, sheet: sheetOn(table) }, noticeEl, results, plan: planCtx, categoryOf: () => undefined, castOf: () => undefined }),
    { interactive: "select", cross: () => crossRef.current, draw: (_c, _s, result, _cmp, o) => { drawn.push([id, result.rows[0].keys[0]]); draws.push(o); return { extraNotice: null }; } });
  return { container, view, noticeEl };
};
const noticeText = (n) => n.children.map((c) => c.textContent ?? "").join("");

test("a target whose table holds the selected column sends the bound `=` filter; a source and an unreachable widget send none", async () => {
  calls.length = 0;
  const results = createResultCache(), drawn = [], draws = [];
  const cross = { current: { filter: sel("orders", "region", "EU") } };
  const target = crossHost("ws#1", "orders", results, drawn, cross, fakeEl(), draws);
  const away = crossHost("ws#2", "people", results, drawn, cross);
  await Promise.all([target.view.run(), away.view.run()]);
  const byTable = Object.fromEntries(calls.map((q) => [q.from.table, q]));
  assert.deepEqual(byTable.orders.filters, [{ db: "shop", table: "orders", column: "region", op: "=", value: "EU", values: null }]);
  assert.deepEqual(byTable.people.filters, [], "no filter where the table isn't in the query");
  assert.match(noticeText(away.noticeEl), /Not filtered: this sheet doesn't use orders/);
  assert.equal(noticeText(target.noticeEl), "");
});
test("the source is never filtered: it is handed the selection to highlight", async () => {
  calls.length = 0;
  const draws = [];
  const cross = { current: { selected: sel("orders", "region", "EU") } };
  const src = crossHost("ws#1", "orders", createResultCache(), [], cross, fakeEl(), draws);
  await src.view.run();
  assert.deepEqual(calls[0].filters, []);
  assert.equal(draws[0].selected.value, "EU");
  assert.equal(draws[0].interactive, "select");
  assert.deepEqual(Object.keys(draws[0].hooks), ["onSelect", "onUnselectable"], "a select-only view gets no drill / legend / editor hooks");
});
test("sync re-runs only when the selection changes what the view shows", async () => {
  calls.length = 0;
  const results = createResultCache(), drawn = [];
  const cross = { current: null };
  const target = crossHost("ws#1", "orders", results, drawn, cross);
  const away = crossHost("ws#2", "people", results, drawn, cross);
  await Promise.all([target.view.run(), away.view.run()]);
  assert.equal(calls.length, 2);
  cross.current = { filter: sel("orders", "region", "EU") };
  await Promise.all([target.view.sync(), away.view.sync()]);
  assert.equal(calls.length, 3, "only the reachable widget queried");
  assert.equal(drawn.length, 4, "the unreachable one redrew once, from its cache, to show its note");
  cross.current = { filter: sel("orders", "region", "US") };
  await Promise.all([target.view.sync(), away.view.sync()]);
  assert.equal(calls.length, 4, "the target queried the new value");
  assert.equal(drawn.length, 5, "the unreachable widget did not run again (same note)");
  await target.view.sync();
  assert.equal(calls.length, 4, "an unchanged selection is a no-op");
  cross.current = null;
  await Promise.all([target.view.sync(), away.view.sync()]);
  assert.equal(calls.length, 4, "clearing is a cache hit: the unfiltered result is still cached");
  assert.equal(noticeText(away.noticeEl), "", "the note goes with the selection");
});
test("two selections in quick succession: only the second one's result is drawn", async () => {
  calls.length = 0;
  const results = createResultCache(), drawn = [], cross = { current: null };
  const t = crossHost("ws#1", "orders", results, drawn, cross);
  await t.view.run(); drawn.length = 0;
  let release; gate = new Promise((r) => { release = r; });
  cross.current = { filter: sel("orders", "region", "EU") };
  const first = t.view.sync();
  cross.current = { filter: sel("orders", "region", "US") };
  const second = t.view.sync();
  release(); gate = null;
  await Promise.all([first, second]);
  assert.equal(drawn.length, 1);
  assert.equal(calls.at(-1).filters[0].value, "US");
});

test("a view reading a table with no relationship says so and sends nothing", async () => {
  const before = calls.length;
  const lonely = { ...planCtx, entities: new Map([...planCtx.entities, ["e3", ent("e3", "payments")]]) };
  const container = fakeEl();
  const view = createWorksheetView(container, () => ({ dash: { id: "w9", sheet: sheetOn("payments") }, noticeEl: fakeEl(), results: createResultCache(), plan: lonely,
    categoryOf: () => undefined, castOf: () => undefined }), { draw: () => ({ extraNotice: null }) });
  await view.run();
  assert.equal(calls.length, before, "no query sent");
  assert.ok(JSON.stringify(container.children).includes("payments isn't related to another table yet"));
});
