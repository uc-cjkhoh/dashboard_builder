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


const lbl = (o, si, di, value, extra = {}) => o.series[si].label.formatter({ dataIndex: di, value, ...extra });
const REGIONS = [["EU", 3], ["US", 9], ["JP", 1], ["UK", 9]];
const on = { dataLabels: true };
const draw = (sh, res = result(REGIONS), options = {}) => { const c = fakeEl(); renderWorksheet(c, sh, res, null, { plan, ...options }); return { c, o: insts.at(-1).lastSet }; };
const labelOf = (o) => o.series[0].label;

test("with no Text, Font or Alignment set a bar's label is exactly as before and carries none of the new options", () => {
  const { o } = draw(sheet({ format: on }));
  assert.deepEqual([3, 9, 1, 9].map((v, di) => lbl(o, 0, di, v)), ["3", "9", "1", "9"]);
  for (const k of ["fontWeight", "align"]) assert.equal(k in labelOf(o), false);
});
test("Text: a template reads the group-by field, the measure and <Value> per bar; Min & max still decides which bars carry it", () => {
  const { o } = draw(sheet({ format: { ...on, labelText: "<orders.region>: <Value> of <sum(amount)>", labelMarks: "minmax" } }));
  assert.deepEqual([3, 9, 1, 9].map((v, di) => lbl(o, 0, di, v)), ["", "US: 9 of 9", "JP: 1 of 1", ""]);
});
test("Text: a template with no <Value> replaces the automatic text, and Data labels off with no Label field draws nothing", () => {
  const { o } = draw(sheet({ format: { ...on, labelText: "total <sum(amount)>" } }));
  assert.equal(lbl(o, 0, 0, 3), "total 3");
  const off = draw(sheet({ format: { labelText: "total <sum(amount)>" } })).o;
  assert.equal(off.series[0].label.show, false);
});
test("Text on top of a Label field: <Value> is that field's text", () => {
  const s = sheet({ format: { labelText: "[<Value>]" } }); s.marks = { ...s.marks, label: dim("region") };
  const { o } = draw(s);
  assert.deepEqual([0, 1, 2, 3].map((di) => lbl(o, 0, di, 0)), ["[EU]", "[US]", "[JP]", "[UK]"]);
});
test("Font and Alignment reach the label: a set size, bold, a theme family stack and the anchor", () => {
  const { o } = draw(sheet({ format: { ...on, labelFont: { size: 16, bold: true }, labelAlign: "left" } }));
  assert.equal(labelOf(o).fontSize, 16); assert.equal(labelOf(o).fontWeight, 600); assert.equal(labelOf(o).align, "right"); // Left is drawn with the text anchored by its right side
});
test("Font family: a Microsoft Typography font resolves through its own token, and a size from the common list reaches the label", () => {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === "--font-ms-calibri" ? "Calibri, Carlito, sans-serif" : "") });
  try {
    const l = labelOf(draw(sheet({ format: { ...on, labelFont: { family: "ms-calibri", size: 20 } } })).o);
    assert.equal(l.fontFamily, "Calibri, Carlito, sans-serif"); assert.equal(l.fontSize, 20);
  } finally { globalThis.getComputedStyle = prev; }
});
test("Font family: a non-default family resolves through the theme token, the default keeps the worksheet's own font", () => {
  const prev = globalThis.getComputedStyle;
  globalThis.getComputedStyle = () => ({ getPropertyValue: (n) => (n === "--font-serif" ? "Georgia, serif" : "") });
  try {
    assert.equal(labelOf(draw(sheet({ format: { ...on, labelFont: { family: "serif" } } })).o).fontFamily, "Georgia, serif");
    assert.equal("fontFamily" in labelOf(draw(sheet({ format: on })).o), false);
  } finally { globalThis.getComputedStyle = prev; }
});
test("a line takes Text, Font and Alignment as well, beside its Label position", () => {
  const { o } = draw(sheet({ chartType: "line", format: { ...on, labelText: "<Value>!", labelPosition: "below", labelAlign: "center", labelFont: { bold: true } } }));
  assert.equal(lbl(o, 0, 0, 3), "3!"); assert.equal(labelOf(o).position, "bottom"); assert.equal(labelOf(o).align, "center"); assert.equal(labelOf(o).fontWeight, 600);
});
test("a bar with Size draws its labels in a custom series: the template and the font reach them", () => {
  const s = sheet({ format: { ...on, labelText: "<orders.region>", labelFont: { size: 16, bold: true }, labelAlign: "right" } }); s.marks = { ...s.marks, size: meas("qty") };
  const res = { rowDimensions: ["region"], columnDimensions: [], measures: ["a", "q"], rows: REGIONS.map(([k, v]) => ({ keys: [k], values: [v, 1] })), truncated: false };
  const { o } = draw(s, res);
  assert.equal(o.series[0].type, "custom");
  const item = o.series[0].renderItem({ dataIndex: 1 }, { size: () => [100], coord: ([a, b]) => [a * 10, b * 10], style: () => ({}), styleEmphasis: () => ({}) });
  assert.equal(item.textContent.style.text, "US");
  assert.equal(item.textContent.style.font, "600 16px system-ui, sans-serif"); // no family chosen: the worksheet's own font
  assert.equal(item.textContent.style.align, "left"); // Right swaps with Left, as on every other chart; zrender reads `align`, not `textAlign`
  assert.equal("textAlign" in item.textContent.style, false);
});
test("a pie: the template sees the slice's measure and Percent, and the label takes the font", () => {
  const { o } = draw(sheet({ chartType: "pie", format: { ...on, labelText: "<sum(amount)> (<Percent>)", labelFont: { size: 14 } } }));
  const lab = o.series[0].label;
  assert.equal(lab.formatter({ dataIndex: 0, name: "EU", value: 3, percent: 12.5 }), "3 (12.5%)");
  assert.equal(lab.fontSize, 14);
});
test("a pie without Text keeps its 'name: value (share)' label", () => {
  const { o } = draw(sheet({ chartType: "pie", format: on }));
  assert.equal(o.series[0].label.formatter({ dataIndex: 0, name: "EU", value: 3, percent: 12.5 }), "EU: 3 (12.5%)");
});
test("a point chart: the template names both measures, <Value> keeps the automatic text", () => {
  const s = sheet({ chartType: "scatter", columns: [dim("region"), meas("amount")], rows: [meas("qty")], format: { ...on, labelText: "<Value> @ <a>,<q>" } });
  const res = { rowDimensions: ["region"], columnDimensions: [], measures: ["a", "q"], rows: [["EU", 1, 5], ["US", 2, 1]].map(([k, a, q]) => ({ keys: [k], values: [a, q] })), truncated: false };
  const { o } = draw(s, res);
  const x = o.series[0].label.formatter({ dataIndex: 1, name: "US", value: [2, 1] });
  assert.equal(x, "US @ 2,1");
});
test("a Colour split: fields are laid out per (series, category) cell and the one measure is named", () => {
  const s = sheet({ columns: [dim("region")], color: [dim("channel")], format: { labelText: "<orders.region>/<orders.channel>=<Value>", dataLabels: true } });
  const rows = [["EU", "web", 5], ["US", "web", 9], ["EU", "shop", 2], ["US", "shop", 4]];
  const res = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["a"], rows: rows.map(([r, ch, v]) => ({ keys: [r, ch], values: [v] })), truncated: false };
  const { o } = draw(s, res);
  assert.equal(lbl(o, 0, 1, 9), "US/web=9");
  assert.equal(lbl(o, 1, 0, 2), "EU/shop=2");
});
test("a shape-split point chart reads the template through each point's result row", () => {
  const s = sheet({ chartType: "scatter", columns: [dim("region"), meas("amount")], rows: [meas("qty")], format: { ...on, labelText: "<orders.region>:<a>" } });
  s.marks = { ...s.marks, shape: dim("channel") };
  const rows = [["EU", "web", 1, 5], ["US", "web", 2, 9], ["EU", "shop", 4, 2]];
  const res = { rowDimensions: ["region"], columnDimensions: ["channel"], measures: ["a", "q"], rows: rows.map(([r, ch, a, q]) => ({ keys: [r, ch], values: [a, q] })), truncated: false };
  const { o } = draw(s, res);
  assert.deepEqual(o.series.map((x) => x.name), ["web", "shop"]);
  const txt = (si, di, v) => o.series[si].label.formatter({ dataIndex: di, value: v });
  assert.equal(txt(0, 1, [2, 9]), "US:2");
  assert.equal(txt(1, 0, [4, 2]), "EU:4");
});
test("the label catalog reaches the host: the drawn fields (and an empty list while drawing)", () => {
  const seen = [];
  draw(sheet({ format: on }), result(REGIONS), { hooks: { onLabelFields: (_s, list) => seen.push(list.map((f) => f.name)) } });
  assert.deepEqual(seen[0], []);
  assert.ok(seen.at(-1).includes("orders.region") && seen.at(-1).includes("sum(amount)"));
});
