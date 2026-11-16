// Gantt bar size from Size (D123): a Size measure sets each bar's thickness. The pure model (shares, thickness), the channel rule, the built option
// (renderItem geometry on a fake api, legend, tooltip), the Colour split, Edit Sizes, and the proof that a Gantt without Size is drawn exactly as
// before (fixtures/gantt-size-golden.json, generated from unmodified main by gen-gantt-golden.mjs). Built options only: tests/live/gantt-ui.mjs draws them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ganttBars, ganttSplit, ganttSizing, ganttThickness } from "../../src/DashboardBuilder/Features/Dashboard/gantt-model.js";
import { sizeChannel } from "../../src/DashboardBuilder/Features/Dashboard/mark-channel-model.js";
import { SIZE_SCALE_TYPES } from "../../src/DashboardBuilder/Features/Dashboard/size-scale-model.js";
import { planDims, planMeasures } from "../../src/DashboardBuilder/Features/Dashboard/sheet-plan.js";
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { parseWorkbook, serializeWorkbook } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet } from "../../src/DashboardBuilder/Features/Core/store.js";
import { SPECS, snapshot, fakeApi } from "./gantt-golden-cases.mjs";

const golden = JSON.parse(readFileSync(new URL("../fixtures/gantt-size-golden.json", import.meta.url), "utf8"));
const fmt = (k) => (k == null ? "—" : String(k));
const dim = (column) => ({ db: "shop", table: "orders", column, category: "text", role: "dimension" });
const meas = (column, agg = "sum") => ({ db: "shop", table: "orders", column, category: "numeric", agg });
const ganttSheet = (size) => { const b = { ...emptySheet(), chartType: "gantt", rows: [dim("task")], columns: [meas("start"), meas("len")] }; return { ...b, marks: { ...b.marks, size } }; };

/** A Gantt spec with a Size measure: rows = [name, start, length, size] (or [[keys], start, length, size] with `colour`). */
function sized(rows, { colour = false, format = {}, name = "Length", sizeName = "qty", extra = {} } = {}) {
  const sp = ganttSplit(rows.map((r) => ({ keys: colour ? r[0] : [r[0]] })), fmt, colour);
  const g = ganttBars(sp.categories, rows.map((r) => r[1]), rows.map((r) => r[2]), { slots: sp.slots, colours: sp.colours, raws: sp.rawRows, sizes: rows.map((r) => r[3]) });
  return { type: "gantt", categories: g.rows, gantt: g, name, format, sizeName, ...extra };
}
const heights = (spec, slot = 40) => { const o = buildOption(spec); return o.series.flatMap((s) => s.data.map((d, di) => s.renderItem({ dataIndex: di }, fakeApi(d, slot)).children[0].shape.height)); };
const THREE = [["a", 0, 4, 10], ["b", 2, 6, 20], ["c", 5, 3, 30]];

test("model: a bar carries its row's Size only when sizes are given; skipped rows keep none", () => {
  const plain = ganttBars(["a", "b"], [0, 1], [2, 2]);
  assert.ok(plain.bars.every((b) => !("size" in b)), "no key without sizes");
  const g = ganttBars(["a", "b", "c"], [0, null, 5], [4, 6, 3], { sizes: [10, 99, null] });
  assert.deepEqual(g.bars.map((b) => [b.name, b.size]), [["a", 10], ["c", null]]);
});
test("model: shares come from the drawn bars' span (a skipped row's value is not in it); nothing without sizes", () => {
  assert.equal(ganttSizing(ganttBars(["a"], [0], [1]).bars, {}), null);
  const g = ganttBars(["a", "b", "c"], [0, null, 5], [4, 6, 3], { sizes: [10, 99, 30] });
  assert.deepEqual(ganttSizing(g.bars, {}).shares, [0, 1]);
  assert.deepEqual(ganttSizing(g.bars, {}).values, [10, 30]);
});
test("model: negative, all-equal, one-row and NULL Size", () => {
  const sh = (sizes, format = {}) => ganttSizing(ganttBars(sizes.map((_, i) => `r${i}`), sizes.map(() => 0), sizes.map(() => 1), { sizes }).bars, format).shares;
  assert.deepEqual(sh([-10, 0, 10]), [0, 0.5, 1]);
  assert.deepEqual(sh([5, 5, 5]), [1, 1, 1]);
  assert.deepEqual(sh([7]), [1]);
  assert.deepEqual(sh([10, null, 30]), [0, null, 1]);
  assert.deepEqual(sh([null, null]), [null, null]);
  assert.deepEqual(sh([10, 20, 30], { sizeScale: { reversed: true } }), [1, 0.5, 0]);
  assert.deepEqual(sh([10, 20, 30], { sizeScale: { vary: "zero" } }), [10 / 30, 20 / 30, 1]);
  assert.deepEqual(sh([10, 20, 30], { sizeScale: { start: 15, end: 25 } }), [0, 0.5, 1], "typed ends: beyond them saturates");
});
test("model: thickness is 6 px at the smallest up to 80% of the slot at the largest; never under 6", () => {
  assert.deepEqual([0, 0.5, 1, null].map((f) => ganttThickness(f, 40)), [6, 19, 32, 6]);
  assert.equal(ganttThickness(1, 5), 6);
  assert.equal(ganttThickness(1, 120), 96);
});

test("channel: a Size measure is drawn on a Gantt with its two measures; a dimension is a hint that says why", () => {
  assert.deepEqual(sizeChannel("gantt", 2, false), { ok: true, note: null });
  assert.equal(sizeChannel("gantt", 1, false).ok, false, "a Gantt with fewer than two measures draws nothing, so Edit Sizes is not offered");
  const d = sizeChannel("gantt", 2, true);
  assert.equal(d.ok, false);
  assert.match(d.note, /Gantt/); assert.match(d.note, /one bar per row/); assert.match(d.note, /measure/);
  assert.ok(SIZE_SCALE_TYPES.has("gantt"));
  assert.match(sizeChannel("combo", 1).note, /Gantt bar thickness/, "the list of what Size scales names it");
});
test("plan: a Size measure on a Gantt rides along after the two shelf measures; a Size dimension adds no group-by", () => {
  const base = ganttSheet(null);
  assert.deepEqual(planMeasures(ganttSheet(meas("qty"))).map((e) => e.role), ["shelf", "shelf", "size"]);
  assert.equal(planDims(ganttSheet(dim("team"))).keyOrder.length, planDims(base).keyOrder.length, "the one-bar-per-row layout is not split");
  assert.deepEqual(planMeasures(ganttSheet(dim("team"))).map((e) => e.role), ["shelf", "shelf"]);
});

test("a Gantt without Size is drawn exactly as before: the option, every bar's rectangle and the tooltip match the golden (from main)", () => {
  for (const name of Object.keys(SPECS)) {
    assert.deepEqual(snapshot(SPECS[name]()), golden[name], name);
    assert.deepEqual(snapshot(SPECS[name](), 120), golden[`${name}Tall`], `${name} in a tall slot`);
  }
});
test("a stored Edit Sizes with no Size field changes nothing (it only applies to a drawn Size)", () => {
  for (const name of Object.keys(SPECS).filter((n) => n !== "styled")) assert.deepEqual(snapshot(SPECS[name]({ format: { sizeScale: { smallest: 20, largest: 60, reversed: true } } })), golden[name], name);
});

test("thickness follows Size: 6, 19 and 32 px in a 40 px slot, centred on the row; row order and x extents are the golden's", () => {
  assert.deepEqual(heights(sized(THREE)), [6, 19, 32]);
  const o = buildOption(sized(THREE)), plain = buildOption(SPECS.plain());
  const rect = (s, di) => s.renderItem({ dataIndex: di }, fakeApi(s.data[di], 40)).children[0].shape;
  for (let i = 0; i < 3; i++) {
    const a = rect(o.series[0], i), b = rect(plain.series[0], i);
    assert.equal(a.x, b.x, "same start"); assert.equal(a.width, b.width, "same length");
    assert.equal(a.y + a.height / 2, b.y + b.height / 2, "centred on the same row line");
  }
  assert.deepEqual(o.series[0].data, plain.series[0].data, "series data (row slot, start, end) unchanged");
  assert.deepEqual(o.yAxis.data, plain.yAxis.data);
});
test("a bar never gets thinner than 6 px, in a tiny slot too; a NULL Size draws the thinnest visible bar, never hides the row", () => {
  assert.deepEqual(heights(sized([["a", 0, 4, 10], ["b", 2, 6, 30]]), 5), [6, 6]);
  const h = heights(sized([["a", 0, 4, 10], ["b", 2, 6, null], ["c", 5, 3, 30]]));
  assert.deepEqual(h, [6, 6, 32]);
  assert.equal(heights(sized([["a", 0, 4, null], ["b", 2, 6, null]])).every((x) => x === 6), true, "every Size NULL");
});
test("all-equal and one-row Size draw the largest bar; negative values span the range", () => {
  assert.deepEqual(heights(sized([["a", 0, 4, 5], ["b", 2, 6, 5]])), [32, 32]);
  assert.deepEqual(heights(sized([["a", 0, 4, 5]])), [32]);
  assert.deepEqual(heights(sized([["a", 0, 4, -10], ["b", 2, 6, 0], ["c", 5, 3, 10]])), [6, 19, 32]);
});
test("Edit Sizes: Reversed, Smallest / Largest, From zero and a typed start / end change the thickness; a value beyond a typed end is not hidden", () => {
  assert.deepEqual(heights(sized(THREE, { format: { sizeScale: { reversed: true } } })), [32, 19, 6]);
  assert.deepEqual(heights(sized(THREE, { format: { sizeScale: { smallest: 50 } } })), [19, 26, 32]);
  assert.deepEqual(heights(sized(THREE, { format: { sizeScale: { largest: 50 } } })), [6, 13, 19]);
  assert.deepEqual(heights(sized(THREE, { format: { sizeScale: { vary: "zero" } } })), [Math.round(6 + (10 / 30) * 26), Math.round(6 + (20 / 30) * 26), 32]);
  assert.deepEqual(heights(sized(THREE, { format: { sizeScale: { start: 15, end: 25 } } })), [6, 19, 32]);
  assert.ok(heights(sized(THREE, { format: { sizeScale: { end: 12 } } })).every((x) => x >= 6));
});
test("the Size legend and the tooltip name the measure; no Size, no extra line", () => {
  const o = buildOption(sized(THREE));
  assert.equal(o.graphic[0].style.text, "Size: qty (10 to 30)");
  assert.equal(o.graphic[0].top, 24, "below the Gantt's own legend, which sits at the top");
  assert.equal(o.grid.top, buildOption(SPECS.plain()).grid.top + 24);
  assert.match(o.tooltip.formatter({ seriesIndex: 0, dataIndex: 1 }), /<b>qty:<\/b> 20/);
  assert.match(buildOption(sized(THREE, { format: { sizeScale: { reversed: true } } })).graphic[0].style.text, /reversed/);
  const nullSize = buildOption(sized([["a", 0, 4, null], ["b", 2, 6, 30]]));
  assert.doesNotMatch(nullSize.tooltip.formatter({ seriesIndex: 0, dataIndex: 0 }), /qty/, "a missing Size has no line");
  assert.equal(buildOption(SPECS.plain()).graphic, undefined);
});
test("a Colour split: each (row, member) bar takes its own cell's thickness on one scale; the thinner bar draws above where bars overlap", () => {
  const rows = [[["T1", "todo"], 0, 5, 10], [["T1", "done"], 6, 3, 30], [["T2", "todo"], 2, 4, 20]];
  const o = buildOption(sized(rows, { colour: true }));
  assert.equal(o.series.length, 2);
  assert.deepEqual(heights(sized(rows, { colour: true })), [6, 19, 32], "series order: todo (T1, T2), then done");
  const g = (s, di) => s.renderItem({ dataIndex: di }, fakeApi(s.data[di], 40));
  const todoT1 = g(o.series[0], 0), done = g(o.series[1], 0);
  assert.ok(todoT1.z2 > done.z2, "the thinner bar has the higher z2");
  assert.equal(o.series[0].data[0][0], o.series[1].data[0][0], "both bars share the row slot");
});
test("selection fade, opacity and the length label are as before beside Size", () => {
  const o = buildOption(sized(THREE, { extra: { selectedIndices: [1] } }));
  const item = (di) => o.series[0].renderItem({ dataIndex: di }, fakeApi(o.series[0].data[di], 40));
  assert.equal(item(0).children[0].style.opacity, 0.35);
  assert.equal(item(1).children[0].style.opacity, 1);
  assert.equal(item(1).children[1].style.text, "6");
});

test("a saved Gantt keeps its Size and Edit Sizes through a workbook round trip, with no new stored key", () => {
  const sheet = { ...ganttSheet(meas("qty")), format: { ...emptySheet().format, sizeScale: { smallest: 20, reversed: true } } };
  const state = { entities: new Map(), relationships: [], tabs: [{ id: "ws#1", kind: "worksheet", name: "G", sheet }], active: { kind: "worksheet", id: "ws#1" } };
  const r = parseWorkbook(JSON.stringify(serializeWorkbook(state)));
  assert.deepEqual(r.issues.filter((i) => /size/i.test(i)), []);
  assert.deepEqual(r.worksheets[0].sheet.format.sizeScale, { smallest: 20, reversed: true });
  assert.equal(r.worksheets[0].sheet.marks.size.column, "qty");
});
