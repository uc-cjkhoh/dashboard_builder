import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// T02-29: member labels reach every display surface of a drawn worksheet and never the raw value behind a click.
const mk = () => {
  const e = { className: "", children: [], style: { setProperty() {} }, clientWidth: 600, clientHeight: 400, classList: { add() {}, remove() {}, toggle() {} },
    append(...c) { this.children.push(...c); }, replaceChildren(...c) { this.children = c; }, setAttribute() {}, addEventListener() {}, colSpan: 1, rowSpan: 1, _t: "",
    get textContent() { return this._t + this.children.map((c) => (typeof c === "string" ? c : c.textContent ?? "")).join(""); }, set textContent(v) { this._t = String(v); this.children = []; } };
  return e;
};
globalThis.document = { createElement: mk, createElementNS: mk, createTextNode: (t) => ({ textContent: String(t) }), documentElement: {} };
globalThis.getComputedStyle = () => ({ getPropertyValue: () => "", left: "0" });
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
const insts = [];
globalThis.window = { echarts: { init: (host) => {
  const i = { host, handlers: [], lastSet: null, setOption(o) { this.lastSet = o; }, on(evt, fn) { this.handlers.push([evt, fn]); }, dispatchAction() {}, resize() {}, dispose() {}, getWidth: () => 600, getHeight: () => 400 };
  insts.push(i); return i; } } };

const { renderWorksheet } = await import("../../src/DashboardBuilder/Features/Dashboard/worksheet-render.js");
beforeEach(() => { insts.length = 0; });

const bare = (o) => Object.assign(Object.create(null), o);
const REGION = { db: "shop", table: "orders", column: "region", category: "text" };
const CHAN = { db: "shop", table: "orders", column: "chan", category: "text" };
const meas = { db: "shop", table: "orders", column: "amount", category: "numeric", agg: "sum" };
const META = { "orders.region": { memberAliases: bare({ EU: "Europe <b>", constructor: "Ctor", ["__proto__"]: "Proto" }) }, "orders.chan": { memberAliases: bare({ EU: "Email-EU", web: "Website" }) } };
const plan = { metaOf: (f) => META[`${f.table}.${f.column}`] ?? {}, calculations: [], nameOf: (f) => f.column };
const sheet = (over = {}) => ({ columns: [REGION], rows: [meas], color: [], filters: [], chartType: "bar", sort: null, selection: null, drill: null,
  marks: { size: null, label: null, detail: [], tooltip: [], shape: null, path: null, angle: null }, pages: null, format: {}, period: null, ...over });
const result = (rows, over = {}) => ({ rowDimensions: ["region"], columnDimensions: [], measures: ["sum(amount)"], rows: rows.map(([keys, v]) => ({ keys, values: [v] })), truncated: false, ...over });
const RAW = [[["EU"], 3], [["US"], 5], [["constructor"], 1], [["__proto__"], 2]];

test("a bar's category axis shows the labels; unlabelled members keep their value; own keys only", () => {
  renderWorksheet(mk(), sheet(), result(RAW), null, { plan });
  assert.deepEqual(insts[0].lastSet.xAxis.data, ["Europe <b>", "US", "Ctor", "Proto"]);
});
test("the click still carries the RAW value and the field", () => {
  const picks = [];
  renderWorksheet(mk(), sheet(), result(RAW), null, { plan, hooks: { onSelect: (f, raw) => picks.push([f.column, raw]) } });
  const click = insts[0].handlers.find(([e]) => e === "click")[1];
  click({ dataIndex: 0 }); click({ dataIndex: 3 });
  assert.deepEqual(picks, [["region", "EU"], ["region", "__proto__"]]);
});
test("the tooltip head shows the label and escapes it (the label is data, never markup)", () => {
  renderWorksheet(mk(), sheet(), result(RAW), null, { plan });
  const html = insts[0].lastSet.tooltip.formatter([{ dataIndex: 0, axisValueLabel: "Europe <b>", seriesName: "sum(amount)", value: 3, color: "#000" }]);
  assert.ok(html.includes("Europe &lt;b&gt;"), html);
  assert.ok(!html.includes("Europe <b>"), "never raw markup");
});
test("a tooltip template reads the label of a group-by field and still escapes it", () => {
  renderWorksheet(mk(), sheet({ tooltipText: "Region <orders.region>: <sum(amount)>" }), result(RAW), null, { plan });
  const html = insts[0].lastSet.tooltip.formatter([{ dataIndex: 0, seriesName: "sum(amount)", value: 3 }]);
  assert.ok(html.includes("<b>Europe &lt;b&gt;</b>"), html);
});
test("pie: slice names and the legend map show labels while the legend click carries the raw member", async () => {
  const legend = [];
  renderWorksheet(mk(), sheet({ chartType: "pie" }), result(RAW), null, { plan, hooks: { onLegend: (a) => legend.push([a.name, a.raw]), legendFocus: () => null } });
  assert.deepEqual(insts[0].lastSet.series[0].data.map((d) => d.name), ["Europe <b>", "US", "Ctor", "Proto"]);
  insts[0].handlers.find(([e]) => e === "legendselectchanged")[1]({ name: "Europe <b>", selected: {} });
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(legend, [["Europe <b>", "EU"]]);
});
test("member colours stay keyed by the raw member, found through the label", () => {
  const sh = sheet({ chartType: "pie", memberColors: { "orders.region": { EU: "#112233" } } });
  renderWorksheet(mk(), sh, result(RAW), null, { plan });
  const eu = insts[0].lastSet.series[0].data.find((d) => d.name === "Europe <b>");
  assert.equal(eu.itemStyle?.color, "#112233");
});
test("colour split: each key position uses its own field's labels; series (legend) names are the Colour member's labels", () => {
  const sh = sheet({ color: [CHAN], columns: [REGION, CHAN] });
  const res = { rowDimensions: [], columnDimensions: ["region", "chan"], measures: ["sum(amount)"], truncated: false, rows: [
    { keys: ["EU", "EU"], values: [1] }, { keys: ["EU", "web"], values: [2] }, { keys: ["US", "web"], values: [3] }] };
  renderWorksheet(mk(), sh, res, null, { plan });
  const opt = insts[0].lastSet;
  assert.deepEqual(opt.xAxis.data, ["Europe <b>", "US"]);
  assert.deepEqual(opt.series.map((s) => s.name), ["Email-EU", "Website"]);
});
test("a crosstab's row and column headers show labels at their own positions", () => {
  const sh = sheet({ chartType: "table", columns: [CHAN], rows: [REGION, meas] });
  const res = { rowDimensions: ["region"], columnDimensions: ["chan"], measures: ["sum(amount)"], truncated: false, rows: [
    { keys: ["EU", "EU"], values: [1] }, { keys: ["EU", "web"], values: [2] }] };
  const host = mk();
  renderWorksheet(host, sh, res, null, { plan });
  const text = host.textContent;
  assert.ok(text.includes("Europe <b>"), text);
  assert.ok(text.includes("Email-EU") && text.includes("Website"), text);
});
test("no memberAliases anywhere: the drawing is exactly the old one", () => {
  renderWorksheet(mk(), sheet(), result(RAW), null, { plan: { metaOf: () => ({}), calculations: [], nameOf: (f) => f.column } });
  assert.deepEqual(insts[0].lastSet.xAxis.data, ["EU", "US", "constructor", "__proto__"]);
});

test("two members that a file labels alike open as one label only: the drawing has one mark per member, never a merge", async () => {
  const { cleanMemberAliases } = await import("../../src/DashboardBuilder/Features/Dashboard/member-labels.js");
  const issues = [];
  const aliases = cleanMemberAliases({ EU: "West", US: "West" }, "f", issues);
  assert.equal(issues.length, 1);
  const p = { ...plan, metaOf: () => ({ memberAliases: aliases }) };
  renderWorksheet(mk(), sheet(), result([[["EU"], 1], [["US"], 2]]), null, { plan: p });
  const cats = insts[0].lastSet.xAxis.data;
  assert.equal(new Set(cats).size, 2, `two different category texts: ${JSON.stringify(cats)}`);
  const names = new Set(["EU", "US"].map((k) => aliases[k] ?? k));
  assert.equal(names.size, 2, "the two members still show as two different texts");
});
