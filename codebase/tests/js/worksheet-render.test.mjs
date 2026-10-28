import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// worksheet-render.js draws a result with no editor (P24a): interactive:false leaves the marks without any selection,
// drill or legend handler; hooks are the only way the host learns anything; two renders never share state.
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400, classList: { add() {}, remove() {}, toggle() {} },
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {}, textContent: "" });
globalThis.document = { createElement: fakeEl, createElementNS: fakeEl, documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const insts = [];
globalThis.window = { echarts: { init: (host) => {
  const i = { host, handlers: [], lastSet: null, setOption(o) { this.lastSet = o; }, on(evt, fn) { this.handlers.push([evt, fn]); }, dispatchAction() {}, resize() {}, dispose() {}, getWidth: () => 600, getHeight: () => 400 };
  insts.push(i); return i; } } };

const { renderWorksheet } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-render.js");
beforeEach(() => { insts.length = 0; });

const plan = { metaOf: () => ({}), calculations: [], nameOf: (f) => f.column };
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column) => ({ db: "shop", table: "orders", column, category: "numeric", agg: "sum" });
const sheet = (over = {}) => ({ columns: [dim("region")], rows: [meas("amount")], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });
const result = (rows = [["EU", 3], ["US", 5]]) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: rows.map(([k, v]) => ({ keys: [k], values: [v] })), truncated: false });
const events = (i) => insts[i].handlers.map(([e]) => e);

test("an interactive render wires mark clicks and legend clicks to the hooks", () => {
  const picks = [];
  const hooks = { onSelect: (f, raw) => picks.push([f.column, raw]), onLegend() {}, legendFocus: () => null };
  renderWorksheet(fakeEl(), sheet(), result(), null, { plan, hooks });
  assert.ok(events(0).includes("click") && events(0).includes("legendselectchanged"));
  insts[0].handlers.find(([e]) => e === "click")[1]({ dataIndex: 1, componentType: "series" });
  assert.deepEqual(picks, [["region", "US"]]);
});
test("interactive:false draws the same marks with no click, legend or drill handler, even when hooks are passed", () => {
  const hooks = { onSelect() { throw new Error("selected"); }, onDrill() { throw new Error("drilled"); }, onLegend() { throw new Error("legend"); }, legendFocus: () => "EU" };
  const on = fakeEl(), off = fakeEl();
  renderWorksheet(on, sheet(), result(), null, { plan, hooks });
  renderWorksheet(off, sheet(), result(), null, { plan, hooks, interactive: false });
  assert.deepEqual(events(1), [], "no handlers registered");
  assert.deepEqual(insts[1].lastSet.series.map((s) => s.data), insts[0].lastSet.series.map((s) => s.data), "same data drawn");
  const pie = fakeEl();
  renderWorksheet(pie, sheet({ chartType: "pie" }), result(), null, { plan, hooks, interactive: false });
  assert.deepEqual(events(2), [], "a pie legend is not clickable either");
});
test("a drill hierarchy: an interactive click calls onDrill, not onSelect", () => {
  const log = [];
  const s = sheet({ drill: { levels: [dim("region"), dim("channel")], depth: 0, path: [] } });
  renderWorksheet(fakeEl(), s, result(), null, { plan, hooks: { onSelect: () => log.push("select"), onDrill: (raw) => log.push(["drill", raw]) } });
  insts[0].handlers.find(([e]) => e === "click")[1]({ dataIndex: 0, componentType: "series" });
  assert.deepEqual(log, [["drill", "EU"]]);
});
test("a date-grouped first key is not click-filterable", () => {
  renderWorksheet(fakeEl(), sheet(), { ...result(), bucket: { key: 0 } }, null, { plan, hooks: { onSelect() {} } });
  assert.ok(!events(0).includes("click"));
});
test("the editor panels learn the drawn chart through hooks and are reset at the start of each render", () => {
  const calls = [];
  const hooks = { onTooltipFields: (_s, list) => calls.push(["tips", list.length]), onMemberColors: (_s, field) => calls.push(["members", field?.column ?? null]) };
  renderWorksheet(fakeEl(), sheet({ chartType: "pie" }), result(), null, { plan, hooks });
  assert.deepEqual(calls.slice(0, 2), [["tips", 0], ["members", null]], "reset first");
  assert.ok(calls.some(([k, v]) => k === "members" && v === "region"), "a pie reports its coloured members");
  assert.ok(calls.some(([k, v]) => k === "tips" && v > 0), "and the fields the tooltip can use");
});
test("a render needs no hooks at all, and reports a line for the notice only when it has one", () => {
  const out = renderWorksheet(fakeEl(), sheet(), result(), null, { plan });
  assert.deepEqual(out, { extraNotice: null });
  const partial = renderWorksheet(fakeEl(), sheet({ rows: [{ ...meas("amount"), tableCalc: { type: "running", along: "rows" } }] }), { ...result(), truncated: true }, null, { plan });
  assert.match(partial.extraNotice ?? "", /Table calculations use only the rows shown/);
});
test("an empty result and a text value on a chart draw hints, not charts", () => {
  const c = fakeEl();
  renderWorksheet(c, sheet(), result([]), null, { plan });
  assert.equal(c.children[0].textContent, "No data for these fields.");
  assert.equal(insts.length, 0);
  const t = fakeEl();
  renderWorksheet(t, sheet(), result([["EU", "text"]]), null, { plan });
  assert.equal(insts.length, 0);
  assert.match(t.children[0].textContent, /Min\/Max|text|Table/i);
});
test("two renders side by side keep their own marks (a bar and a pie)", () => {
  const a = fakeEl(), b = fakeEl();
  renderWorksheet(a, sheet(), result(), null, { plan, interactive: false });
  renderWorksheet(b, sheet({ chartType: "pie" }), result([["X", 1], ["Y", 2]]), null, { plan, interactive: false });
  assert.equal(insts.length, 2);
  assert.ok(insts[0].lastSet.xAxis && !insts[0].lastSet.series.some((s) => s.type === "pie"));
  assert.ok(insts[1].lastSet.series.some((s) => s.type === "pie"));
});
