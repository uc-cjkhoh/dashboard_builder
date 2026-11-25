// The Size meter on every chart type: Auto changes nothing, a set position changes each type's own element (element-size-model.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sizeT, withElementSize, ELEMENT_SIZE_TYPES, sizeMeterStops, sizeMeterLabel, pieOuterPct, gaugeWidth, nodeWidth, barGapPct, slotShare } from "../../src/DashboardBuilder/Features/Dashboard/element-size-model.js";
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { MARKER_SIZE, MARKER_SIZE_AUTO } from "../../src/DashboardBuilder/Features/Dashboard/mark-style-model.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });

const cats = ["a", "b", "c"], series = [{ name: "v", data: [3, 5, 2] }];
const specs = {
  bar: { categories: cats, series }, stacked: { categories: cats, series }, line: { categories: cats, series }, area: { categories: cats, series },
  pie: { categories: cats, series }, donut: { categories: cats, series }, funnel: { categories: cats, series }, waterfall: { categories: cats, series },
  gauge: { value: 40, max: 100, name: "v" }, bullet: { categories: cats, values: [1, 2, 3], target: 3, name: "v" },
  scatter: { categories: cats, series: [{ name: "x", data: [1, 2, 3] }, { name: "y", data: [4, 5, 6] }] },
};
const opt = (type, format) => buildOption({ type, ...specs[type], format });

test("sizeT: null while Automatic or out of range, 0..1 across the meter", () => {
  assert.equal(sizeT({}), null); assert.equal(sizeT({ markerSize: null }), null); assert.equal(sizeT({ markerSize: 3 }), null); assert.equal(sizeT({ markerSize: 99 }), null);
  assert.equal(sizeT({ markerSize: MARKER_SIZE.min }), 0); assert.equal(sizeT({ markerSize: MARKER_SIZE.max }), 1);
});
test("Automatic returns the option untouched for every type", () => {
  const o = { series: [{ type: "pie", radius: "72%" }] };
  assert.equal(withElementSize(o, { type: "pie", format: {} }), o);
  assert.equal(withElementSize(o, { type: "pie", format: { markerSize: null } }), o);
});
test("a pie and a donut grow with the meter; the donut keeps its hole", () => {
  const small = opt("pie", { markerSize: 4 }).series[0].radius, large = opt("pie", { markerSize: 40 }).series[0].radius;
  assert.equal(small, `${pieOuterPct(0)}%`); assert.equal(large, `${pieOuterPct(1)}%`); assert.ok(pieOuterPct(1) <= 85 && pieOuterPct(0) >= 40);
  const d = opt("donut", { markerSize: 40 }).series[0].radius;
  assert.equal(d[1], `${pieOuterPct(1)}%`); assert.ok(parseInt(d[0]) < parseInt(d[1]));
});
test("bars: the cap is lifted and the gap shrinks as the meter rises; Automatic keeps the 40 px cap", () => {
  for (const t of ["bar", "stacked"]) {
    assert.equal(opt(t, {}).series[0].barMaxWidth, 40);
    const thin = opt(t, { markerSize: 4 }).series[0], thick = opt(t, { markerSize: 40 }).series[0];
    assert.ok(parseInt(thin.barCategoryGap) > parseInt(thick.barCategoryGap), t);
    assert.ok(thick.barMaxWidth > 40, t);
  }
  assert.ok(slotShare(0) < slotShare(1) && barGapPct(0) > barGapPct(1));
});
test("gauge arc and sankey nodes follow the meter", () => {
  const g = opt("gauge", { markerSize: 40 }).series[0];
  assert.equal(g.progress.width, gaugeWidth(1)); assert.equal(g.axisLine.lineStyle.width, gaugeWidth(1));
  assert.notEqual(opt("gauge", {}).series[0].progress.width, gaugeWidth(1));
  const o = withElementSize({ series: [{ type: "sankey", nodeWidth: 14 }] }, { type: "sankey", format: { markerSize: 4 } });
  assert.equal(o.series[0].nodeWidth, nodeWidth(0));
});
test("funnel width, boxplot box width, bullet bands and multiples markers", () => {
  const f = opt("funnel", { markerSize: 4 }).series[0], F = opt("funnel", { markerSize: 40 }).series[0];
  assert.ok(parseInt(f.left) > parseInt(F.left)); assert.equal(F.left, "0%");
  const b = withElementSize({ series: [{ type: "boxplot" }] }, { type: "boxplot", format: { markerSize: 40 } }).series[0].boxWidth;
  assert.ok(b[0] < b[1]);
  const bu = opt("bullet", { markerSize: 40 }).series;
  assert.ok(parseInt(bu.find((s) => s.silent).barWidth) > 60); assert.ok(parseInt(bu.find((s) => s.name === "v").barWidth) > 24);
  const m = withElementSize({ series: [{ type: "line", symbolSize: 5 }] }, { type: "multiples", format: { markerSize: 40 } });
  assert.ok(m.series[0].symbolSize > 5);
});
test("markers keep reading the setting in px (line, scatter)", () => {
  assert.equal(opt("line", { markerSize: 20 }).series[0].symbolSize, 20);
  assert.equal(opt("scatter", { markerSize: 20 }).series[0].symbolSize, 20);
});
test("types with nothing to size are left out, and the meter reads px for markers, a percentage elsewhere", () => {
  for (const t of ["treemap", "histogram", "table", "text"]) assert.ok(!ELEMENT_SIZE_TYPES.has(t), t);
  assert.equal(sizeMeterLabel("line"), "Marker size"); assert.equal(sizeMeterLabel("pie"), "Size");
  assert.equal(sizeMeterStops("line").at(1)[1], "4 px"); assert.equal(sizeMeterStops("pie").at(0)[1], "Auto");
  assert.equal(sizeMeterStops("pie").at(-1)[1], "100%"); assert.equal(sizeMeterStops("pie").at(0)[0], MARKER_SIZE_AUTO);
});
