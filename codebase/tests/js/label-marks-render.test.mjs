import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Format → Label marks through the whole drawing: which marks carry their label, read from the option the worksheet hands ECharts.
const fakeEl = () => ({ className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400, classList: { add() {}, remove() {}, toggle() {} },
  append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {}, textContent: "", getContext: () => ({ measureText: (t) => ({ width: String(t).length * 7 }), font: "" }) });
globalThis.document = { createElement: fakeEl, createElementNS: fakeEl, documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const insts = [];
globalThis.window = { echarts: { init: (host) => {
  const i = { host, handlers: [], lastSet: null, setOption(o) { this.lastSet = o; }, on(evt, fn) { this.handlers.push([evt, fn]); }, dispatchAction(a) { this.actions.push(a); }, actions: [], resize() {}, dispose() { this.disposed = true; }, getWidth: () => 600, getHeight: () => 400 };
  insts.push(i); return i; } } };

const { renderWorksheet } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-render.js");
beforeEach(() => { insts.length = 0; });

const plan = { metaOf: () => ({}), calculations: [], nameOf: (f) => f.column };
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text" });
const meas = (column) => ({ db: "shop", table: "orders", column, category: "numeric", agg: "sum" });
const sheet = (over = {}) => ({ columns: [dim("region")], rows: [meas("amount")], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });
const result = (rows = [["EU", 3], ["US", 5]]) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: rows.map(([k, v]) => ({ keys: [k], values: [v] })), truncated: false });

const lbl = (o, si, di, value) => o.series[si].label.formatter({ dataIndex: di, value });
const labels = (o, si, values) => values.map((v, di) => lbl(o, si, di, v));
const hints = (container) => container.children.filter((c) => c.className === "ws-hint").map((c) => c.textContent);
const REGIONS = [["EU", 3], ["US", 9], ["JP", 1], ["UK", 9]];
const on = { dataLabels: true };
const draw = (sh, res = result(REGIONS), options = {}) => { const c = fakeEl(); renderWorksheet(c, sh, res, null, { plan, ...options }); return { c, o: insts.at(-1).lastSet }; };

test("with no Label marks setting every mark is labelled, exactly as before", () => {
  const { o, c } = draw(sheet({ format: on }));
  assert.deepEqual(labels(o, 0, [3, 9, 1, 9]), ["3", "9", "1", "9"]);
  assert.deepEqual(hints(c), []);
  assert.equal(o.series[0].label.show, true);
  assert.equal(o.series[0].emphasis.focus, "series");
});

test("Min & max labels the lowest and the highest bar only; a tie takes the first", () => {
  const { o } = draw(sheet({ format: { ...on, labelMarks: "minmax" } }));
  assert.deepEqual(labels(o, 0, [3, 9, 1, 9]), ["", "9", "1", ""]);
});

test("Selected labels the selected mark (the worksheet's own click selection)", () => {
  const sel = { db: "shop", table: "orders", column: "region", value: "JP", label: "region = JP", action: null };
  const { o, c } = draw(sheet({ format: { ...on, labelMarks: "selected" }, selection: sel }));
  assert.deepEqual(labels(o, 0, [3, 9, 1, 9]), ["", "", "1", ""]);
  assert.deepEqual(hints(c), []);
});

test("Selected with nothing selected labels nothing and says why; a dashboard's selection is read the same way", () => {
  const { o, c } = draw(sheet({ format: { ...on, labelMarks: "selected" } }));
  assert.deepEqual(labels(o, 0, [3, 9, 1, 9]), ["", "", "", ""]);
  assert.match(hints(c)[0], /no mark is selected/);
  const { o: o2 } = draw(sheet({ format: { ...on, labelMarks: "selected" } }), result(REGIONS), { selected: { db: "shop", table: "orders", column: "region", value: "US" } });
  assert.deepEqual(labels(o2, 0, [3, 9, 1, 9]), ["", "9", "", ""]);
});

test("Highlighted shows a label only with the mark's emphasis, one mark at a time", () => {
  const { o } = draw(sheet({ format: { ...on, labelMarks: "highlighted" } }));
  assert.equal(o.series[0].label.show, false);
  assert.equal(o.series[0].emphasis.label.show, true);
  assert.equal(o.series[0].emphasis.focus, "self");
  assert.equal(lbl(o, 0, 1, 9), "9"); // what the emphasis label says
});

test("a mode this chart does not offer labels every mark and says so", () => {
  const { o, c } = draw(sheet({ format: { ...on, labelMarks: "ends" } }));
  assert.deepEqual(labels(o, 0, [3, 9, 1, 9]), ["3", "9", "1", "9"]);
  assert.match(hints(c)[0], /Line ends/);
  const r = draw(sheet({ format: { ...on, labelMarks: "recent" } }));
  assert.deepEqual(labels(r.o, 0, [3, 9, 1, 9]), ["3", "9", "1", "9"]);
  assert.match(hints(r.c)[0], /date/);
});

test("with no labels drawn the setting does nothing and says nothing", () => {
  const { o, c } = draw(sheet({ format: { labelMarks: "minmax" } }));
  assert.equal(o.series[0].label.show, false);
  assert.deepEqual(hints(c), []);
});

const dates = (...pairs) => result(pairs);
const DATED = [["2024-03-01", 5], ["2024-04-01", 2], ["2024-01-01", 8], ["2024-02-01", 4]];
const dateSheet = (over = {}) => sheet({ chartType: "line", columns: [{ ...dim("placed"), category: "temporal" }], format: { ...on, ...over } });

test("Line ends labels the first and last point; the rest stay unlabelled", () => {
  const { o } = draw(dateSheet({ labelMarks: "ends" }), dates(...DATED));
  assert.deepEqual(labels(o, 0, [5, 2, 8, 4]), ["5", "", "", "4"]);
});

test("Most recent labels the latest date wherever it sits in the drawn order (sorted by value, not date)", () => {
  const { o } = draw(dateSheet({ labelMarks: "recent" }), dates(...DATED));
  assert.deepEqual(labels(o, 0, [5, 2, 8, 4]), ["", "2", "", ""]); // 2024-04-01 is the second mark
});

test("Most recent on a date grouped to months: the latest month, named as the axis names it", () => {
  const s = dateSheet({ labelMarks: "recent" }); s.columns = [{ ...dim("placed"), category: "temporal", datePart: "month" }];
  const { o } = draw(s, dates(...DATED));
  assert.deepEqual(labels(o, 0, [5, 2, 8, 4]), ["", "2", "", ""]);
});

test("Most recent offers nothing for a month of year (no latest point in time) and falls back to every label with a hint", () => {
  const s = dateSheet({ labelMarks: "recent" }); s.columns = [{ ...dim("placed"), category: "temporal", datePart: "monthOfYear" }];
  const { o, c } = draw(s, dates(["3", 5], ["4", 2]));
  assert.deepEqual(labels(o, 0, [5, 2]), ["5", "2"]);
  assert.match(hints(c)[0], /date/);
});

test("a pie: unlabelled slices lose their leader line too; Min & max keeps the smallest and largest", () => {
  const { o } = draw(sheet({ chartType: "pie", format: { ...on, labelMarks: "minmax" } }));
  const data = o.series[0].data;
  assert.deepEqual(data.map((d) => d.label?.show ?? true), [false, true, true, false]); // EU 3 and UK 9 (a tie for the largest) are unlabelled
  assert.deepEqual(data.map((d) => d.labelLine?.show ?? true), [false, true, true, false]);
});

test("a pie set to Highlighted: slice labels appear with the slice's emphasis", () => {
  const { o } = draw(sheet({ chartType: "pie", format: { ...on, labelMarks: "highlighted" } }));
  assert.equal(o.series[0].label.show, false); assert.equal(o.series[0].labelLine.show, false);
  assert.equal(o.series[0].emphasis.label.show, true); assert.equal(o.series[0].emphasis.labelLine.show, true);
});

test("a point chart: Min & max over the Y values", () => {
  const s = sheet({ chartType: "scatter", columns: [meas("amount"), meas("qty")], rows: [], format: { ...on, labelMarks: "minmax" } });
  const res = { rowDimensions: ["region"], columnDimensions: [], measures: ["a", "q"], rows: [["EU", 1, 5], ["US", 2, 1], ["JP", 3, 9], ["UK", 4, 5]].map(([k, a, q]) => ({ keys: [k], values: [a, q] })), truncated: false };
  s.columns = [dim("region"), meas("amount")]; s.rows = [meas("qty")];
  const { o } = draw(s, res);
  assert.deepEqual([0, 1, 2, 3].map((di) => o.series[0].label.formatter({ dataIndex: di, name: ["EU", "US", "JP", "UK"][di] })), ["", "US", "JP", ""]);
});

test("a bar with Size draws its labels in a custom series: Min & max reaches them, Highlighted hides them until the bar is highlighted", () => {
  const s = sheet({ format: { ...on, labelMarks: "minmax" } }); s.marks = { ...s.marks, size: meas("qty") };
  const res = { rowDimensions: ["region"], columnDimensions: [], measures: ["a", "q"], rows: REGIONS.map(([k, v]) => ({ keys: [k], values: [v, 1] })), truncated: false };
  const { o } = draw(s, res);
  assert.equal(o.series[0].type, "custom");
  const api = { size: () => [100], coord: ([a, b]) => [a * 100 + 50, 300 - b * 10], style: () => ({}), styleEmphasis: () => ({}) };
  const text = (o2, di) => o2.series[0].renderItem({ dataIndex: di }, api).textContent.style.text;
  assert.deepEqual([0, 1, 2, 3].map((di) => text(o, di)), ["", "9", "1", ""]);
  const h = draw(sheet({ format: { ...on, labelMarks: "highlighted" }, marks: { ...s.marks } }), res).o;
  const item = h.series[0].renderItem({ dataIndex: 1 }, api).textContent;
  assert.equal(item.style.opacity, 0); assert.equal(item.emphasis.style.opacity, 1);
});

test("a Colour split: Min & max is taken per series (per colour member), on top of a Label field's text", () => {
  const s = sheet({ columns: [dim("region")], color: [dim("channel")], format: { labelMarks: "minmax" } });
  s.marks = { ...s.marks, label: dim("region") };
  const rows = [["EU", "web", 5], ["US", "web", 9], ["JP", "web", 1], ["EU", "shop", 2], ["US", "shop", 2], ["JP", "shop", 7]];
  const res = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["a"], rows: rows.map(([r, ch, v]) => ({ keys: [r, ch], values: [v] })), truncated: false };
  const { o } = draw(s, res);
  assert.deepEqual(o.series.map((x) => x.name), ["web", "shop"]);
  const text = (si) => [0, 1, 2].map((di) => o.series[si].label.formatter({ dataIndex: di }));
  assert.deepEqual(text(0), ["", "US", "JP"]); // web: max 9 (US), min 1 (JP)
  assert.deepEqual(text(1), ["EU", "", "JP"]); // shop: min 2 first at EU, max 7 at JP
});
