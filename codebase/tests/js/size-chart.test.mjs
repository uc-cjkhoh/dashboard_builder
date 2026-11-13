// What chart.js draws for a Size field: bar thickness (one series and beside a Colour split), a line's own thickness, area markers, bubble
// size, Edit Sizes (range / From zero / Reversed) and the Size legend — built options only, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCartesian, buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
const S = (name, data = [1, 2, 3]) => ({ name, data });
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format: {}, ...extra });
const legendText = (o) => o.graphic?.[0]?.style?.text ?? null;
// A bar custom series' rectangle for item `di`, drawn against a fake axis API (band = 100 px, one category = 100 px apart).
const rect = (s, di, band = 100) => s.renderItem({ dataIndex: di }, { size: () => [band], coord: ([a, b]) => [a * 100 + 50, 300 - b * 10], style: () => ({}), styleEmphasis: () => ({}) });

test("a one-series Size bar chart is unchanged: thickness from 6 px at the smallest value to 80% of the band at the largest", () => {
  const o = cart("bar", [S("v")], { sizes: [10, 20, 30], sizeName: "qty" });
  const s = o.series[0];
  assert.equal(s.type, "custom");
  assert.deepEqual([0, 1, 2].map((i) => rect(s, i).shape.width), [6, 43, 80]);
  assert.equal(legendText(o), "Size: qty (10 to 30)");
});
test("Edit Sizes on bars: Reversed gives the largest value the thinnest bar; Smallest / Largest bound the thickness; From zero starts at 0", () => {
  const w = (format) => [0, 1, 2].map((i) => rect(cart("bar", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format }).series[0], i).shape.width);
  assert.deepEqual(w({ sizeScale: { reversed: true } }), [80, 43, 6]);
  assert.deepEqual(w({ sizeScale: { smallest: 50 } }), [43, 62, 80]);
  assert.deepEqual(w({ sizeScale: { fromZero: true } }), [Math.round(6 + (10 / 30) * 74), Math.round(6 + (20 / 30) * 74), 80]);
  assert.match(legendText(cart("bar", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { sizeScale: { reversed: true } } })), /reversed/);
});
test("a Size dimension on a bar: each member a step, named in the legend and the tooltip", () => {
  const o = cart("bar", [S("v")], { sizes: [1, 0, 2], sizeMembers: ["gold", "bronze", "silver"], sizeOrder: ["bronze", "gold", "silver"], sizeName: "tier" });
  assert.deepEqual([0, 1, 2].map((i) => rect(o.series[0], i).shape.width), [43, 6, 80]);
  assert.equal(legendText(o), "Size: tier (bronze to silver, 3 steps)");
  const tip = o.tooltip.formatter([{ dataIndex: 0, seriesIndex: 0, seriesName: "v", value: [0, 1, 1], axisValueLabel: "a" }]);
  assert.match(tip, /tier:<\/b> gold/);
});
test("Size beside a Colour split: grouped bars, one custom series per member, each bar's thickness from its own cell, side by side", () => {
  const o = cart("bar", [S("web", [1, 2, 3]), S("shop", [4, null, 6])], { sizeGrid: [[10, 20, 30], [10, null, 30]], sizeName: "qty" });
  assert.deepEqual(o.series.map((s) => s.type), ["custom", "custom"]);
  const a = rect(o.series[0], 0), b = rect(o.series[1], 0);
  assert.equal(a.shape.width, 6); assert.equal(b.shape.width, 6);
  assert.ok(a.shape.x + a.shape.width <= b.shape.x, "side by side, not overlapping");
  assert.equal(rect(o.series[1], 1), null, "an empty cell draws nothing");
  const widest = rect(o.series[0], 2).shape.width;
  assert.equal(widest, Math.round(6 + 1 * (Math.max(6, 50 * 0.8) - 6)), "thickness is bounded by the member's own slot of the band");
});
test("a stacked chart draws no Size", () => {
  const o = cart("stacked", [S("a"), S("b")], { sizes: [1, 2, 3], sizeName: "qty" });
  assert.ok(o.series.every((s) => s.type === "bar"));
  assert.equal(legendText(o), null);
});
test("a straight line's own thickness varies with Size: a silent segment series under the line, outside the legend and the tooltip", () => {
  const o = cart("line", [S("v", [1, 3, 2])], { sizes: [10, 20, 30], sizeName: "qty" });
  const line = o.series.find((s) => s.type === "line"), seg = o.series.find((s) => s.type === "custom");
  assert.ok(line && seg);
  assert.equal(seg.name, "v"); assert.ok(seg.silent); assert.ok(String(seg.id).startsWith("size-width:"));
  assert.equal(line.showSymbol, true);
  assert.equal(line.data.every((d) => d === undefined || typeof d === "number" || d.symbolSize === undefined), true, "markers keep their size");
  const api = { coord: ([a, b]) => [a * 100, 300 - b * 10] };
  const poly = (di) => seg.renderItem({ dataIndex: di }, api);
  assert.equal(poly(0).type, "polygon");
  assert.equal(poly(2), null, "the last point starts no segment");
  const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const ends = (g) => [d(g.shape.points[0], g.shape.points[3]), d(g.shape.points[1], g.shape.points[2])].map((x) => Math.round(x * 100) / 100);
  assert.deepEqual(ends(poly(0)), [2, 7], "tapers from one point's thickness (2 px) to the next (7 px)");
  assert.deepEqual(ends(poly(1)), [7, 12]);
  const two = cart("line", [S("a", [1, 3, 2]), S("b", [2, 2, 2])], { sizes: [10, 20, 30], sizeName: "qty" });
  assert.deepEqual(two.legend.data, ["a", "b"], "the legend lists the measures once");
  const tip = o.tooltip.formatter([{ dataIndex: 1, seriesIndex: 0, seriesId: "x", seriesName: "v", value: 3, axisValueLabel: "b" }, { dataIndex: 1, seriesIndex: 1, seriesId: seg.id, seriesName: "v", value: [1, 3], axisValueLabel: "b" }]);
  assert.equal((tip.match(/<b>v:<\/b>/g) ?? []).length, 1, "the segment series is not listed twice");
});
test("a stepped line and an area keep marker size; the line's own width is untouched", () => {
  for (const [type, format] of [["line", { lineStyle: "step" }], ["area", {}]]) {
    const o = cart(type, [S("v", [1, 3, 2])], { sizes: [10, 20, 30], sizeName: "qty", format });
    assert.equal(o.series.filter((s) => s.type === "custom").length, 0, type);
    assert.deepEqual(o.series[0].data.map((d) => d.symbolSize), [6, 15, 24], type);
  }
});
test("a line with Size and no setting draws the same shares through Edit Sizes: Reversed flips the thickest segment", () => {
  const th = (format) => { const o = cart("line", [S("v", [1, 3, 2])], { sizes: [10, 20, 30], sizeName: "qty", format }); const seg = o.series.find((s) => s.type === "custom");
    const g = seg.renderItem({ dataIndex: 1 }, { coord: ([a, b]) => [a * 100, 300 - b * 10] }); return Math.round(Math.hypot(g.shape.points[0][0] - g.shape.points[3][0], g.shape.points[0][1] - g.shape.points[3][1])); };
  assert.equal(th({}), 7); assert.equal(th({ sizeScale: { reversed: true } }), 7, "the middle point is the midpoint either way");
});
test("Size beside a Colour split on a line: markers per cell, or thickness per cell", () => {
  const o = cart("area", [S("web", [1, 2, 3]), S("shop", [4, 5, 6])], { sizeGrid: [[10, 20, 30], [30, 20, 10]], sizeName: "qty" });
  assert.deepEqual(o.series[0].data.map((d) => d.symbolSize), [6, 15, 24]);
  assert.deepEqual(o.series[1].data.map((d) => d.symbolSize), [24, 15, 6]);
  const l = cart("line", [S("web", [1, 2, 3]), S("shop", [4, 5, 6])], { sizeGrid: [[10, 20, 30], [30, 20, 10]], sizeName: "qty" });
  assert.equal(l.series.filter((s) => s.type === "custom").length, 2);
});
test("scatter bubbles: no setting keeps today's zero-based 8-36 px; From zero off starts at the data's smallest; Reversed flips; a dimension steps", () => {
  const sc = (extra) => buildOption({ type: "scatter", categories: ["a", "b", "c"], series: [S("x"), S("y")], format: {}, sizes: [10, 20, 40], sizeName: "qty", ...extra });
  const px = (o, i) => o.series[0].symbolSize(o.series[0].data[i].value);
  assert.deepEqual([0, 1, 2].map((i) => px(sc(), i)), [8 + (10 / 40) * 28, 8 + (20 / 40) * 28, 36]);
  assert.deepEqual([0, 1, 2].map((i) => px(sc({ format: { sizeScale: { fromZero: false } } }), i)), [8, 8 + (10 / 30) * 28, 36]);
  assert.deepEqual([0, 1, 2].map((i) => px(sc({ format: { sizeScale: { reversed: true } } }), i)).map(Math.round), [Math.round(8 + (1 - 10 / 40) * 28), Math.round(8 + (1 - 20 / 40) * 28), 8]);
  const d = sc({ sizes: [0, 1, 2], sizeMembers: ["a", "b", "c"], sizeOrder: ["a", "b", "c"], sizeName: "tier" });
  assert.deepEqual([0, 1, 2].map((i) => px(d, i)), [8, 22, 36]);
  assert.match(d.tooltip.formatter({ dataIndex: 1, name: "b", value: d.series[0].data[1].value, data: d.series[0].data[1] }), /tier:<\/b> b/);
  assert.equal(legendText(d), "Size: tier (a to c, 3 steps)");
});
test("scatter with a Colour or Shape split: points carry their member's step and name", () => {
  const o = buildOption({ type: "scatterShapes", symbol: "circle", xName: "x", yName: "y", hasSize: true, sizeName: "tier", sizeOrder: ["a", "b"], format: {},
    groups: [{ name: "g", points: [{ value: [1, 2, 0], name: "p", sizeMember: "a" }, { value: [3, 4, 1], name: "q", sizeMember: "b" }] }] });
  const s = o.series[0];
  assert.deepEqual(s.data.map((d) => s.symbolSize(d.value)), [8, 36]);
  assert.match(o.tooltip.formatter({ seriesName: "g", data: s.data[1], value: s.data[1].value }), /tier:<\/b> b/);
  assert.equal(legendText(o), "Size: tier (a to b, 2 steps)");
});
