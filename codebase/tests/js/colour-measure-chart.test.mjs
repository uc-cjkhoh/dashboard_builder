// A colour measure beside several measures, on Stacked and on Combo: every mark of every measure wears its row's colour, and each measure keeps a
// non-colour identity (a bar pattern, a line dash and marker, a stacked separator, legend icons) — built options only, no browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCartesian } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
globalThis.window ??= {};
// valueColours reads the live echarts colour helpers: a straight blend of two hex ends is all the test needs
window.echarts ??= { color: { parse: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), lerp: (t, ramp) => `rgb(${[0, 1, 2].map((k) => Math.round(parseInt(ramp[0].slice(1 + 2 * k, 3 + 2 * k), 16) * (1 - t) + parseInt(ramp[ramp.length - 1].slice(1 + 2 * k, 3 + 2 * k), 16) * t)).join(",")})` } };
const S = (name, data = [1, 2, 3]) => ({ name, data });
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format: {}, colorValues: [-1, 5, 9], colorName: "qty", ...extra });
const colourOf = (d) => d?.itemStyle?.color;
const FORMAT = {};

test("a colour measure with one measure is unchanged: no pattern, dash or legend of icons", () => {
  const o = cart("bar", [S("v")]);
  assert.equal(JSON.stringify(o).includes("decal"), false);
  const l = cart("line", [S("v")]);
  assert.equal(l.series[0].lineStyle.type, undefined); assert.equal(l.legend, undefined);
});
test("several bars: every bar of every measure wears its row's colour; the legend swatches are neutral and carry the pattern; the second measure is striped, the first plain", () => {
  const o = cart("bar", [S("amount"), S("discount", [3, 2, 1])]);
  const cols = (s) => s.data.map(colourOf);
  assert.deepEqual(cols(o.series[0]), cols(o.series[1]), "the same colour per row for both measures");
  assert.equal(new Set(cols(o.series[0])).size, 3, "three rows, three colours");
  assert.equal(o.series[0].itemStyle.decal, undefined); assert.equal(o.series[1].itemStyle.decal.rotation, Math.PI / 4);
  assert.equal(o.series[0].itemStyle.color, o.series[1].itemStyle.color, "the swatch colour is one neutral token, not a hue");
  assert.deepEqual(o.legend.data.map((d) => d.name), ["amount", "discount"]);
  assert.ok(o.visualMap, "one gradient legend for the colour measure");
  assert.match(o.tooltip.formatter([{ dataIndex: 1, seriesIndex: 0, seriesName: "amount", value: 2, axisValueLabel: "b" }, { dataIndex: 1, seriesIndex: 1, seriesName: "discount", value: 2, axisValueLabel: "b" }]), /qty:<\/b> 5/);
});
test("stacked: each segment wears its row's colour and is separated from its neighbour by a surface stroke; later measures are patterned", () => {
  const o = cart("stacked", [S("amount"), S("discount", [3, 2, 1])]);
  assert.deepEqual(o.series[0].data.map(colourOf), o.series[1].data.map(colourOf));
  for (const s of o.series) { assert.equal(s.stack, "total"); assert.equal(s.itemStyle.borderWidth, 1); assert.equal(s.itemStyle.borderColor, o.tooltip.backgroundColor); }
  assert.ok(o.series[1].itemStyle.decal);
  const bordered = cart("stacked", [S("amount"), S("discount")], { format: { markBorder: "thick" } });
  assert.equal(bordered.series[0].itemStyle.borderWidth, 3, "a chosen border wins");
  const one = cart("stacked", [S("amount")]);
  assert.equal(one.series[0].itemStyle.borderWidth, 0, "a single measure keeps today's look");
});
test("several lines: one dash and marker per measure, markers always shown, every marker and the gradient follow the colour measure", () => {
  const o = cart("line", [S("amount"), S("discount", [3, 2, 1]), S("qty", [5, 5, 5])]);
  assert.deepEqual(o.series.map((s) => s.lineStyle.type), ["solid", "dashed", "dotted"]);
  assert.equal(new Set(o.series.map((s) => s.symbol)).size, 3);
  assert.ok(o.series.every((s) => s.showSymbol === true));
  assert.deepEqual(o.series[0].data.map(colourOf), o.series[1].data.map(colourOf));
  assert.equal(JSON.stringify(o.series[0].lineStyle.color), JSON.stringify(o.series[1].lineStyle.color), "the same gradient along each line");
  assert.deepEqual(o.legend.data.map((d) => d.icon), o.series.map((s) => s.symbol), "the legend icon is the line's marker");
  const area = cart("area", [S("amount"), S("discount")]);
  assert.deepEqual(area.series.map((s) => s.lineStyle.type), ["solid", "dashed"]);
});
test("combo: the left-axis bars are plain, the right-axis lines take their own dash and marker, all coloured by the measure", () => {
  const o = cart("combo", [S("amount"), S("discount", [3, 2, 1]), S("qty", [5, 5, 5])]);
  assert.equal(o.series[0].type, "bar"); assert.equal(o.series[0].itemStyle.decal, undefined);
  assert.deepEqual(o.series.slice(1).map((s) => s.type), ["line", "line"]);
  assert.deepEqual(o.series.slice(1).map((s) => s.lineStyle.type), ["dashed", "dotted"]);
  assert.deepEqual(o.series[0].data.map(colourOf), o.series[1].data.map(colourOf));
  const rightBars = cart("combo", [S("amount"), S("discount", [3, 2, 1])], { format: { secondaryType: "bar" } });
  assert.ok(rightBars.series[1].itemStyle.decal, "right-axis bars are patterned, so they differ from the left ones");
});
test("without a colour measure nothing about the cues appears", () => {
  const o = cart("line", [S("amount"), S("discount")], { colorValues: undefined });
  assert.equal(JSON.stringify(o).includes("decal"), false);
  assert.ok(o.series.every((s) => s.lineStyle.type === undefined));
  assert.equal(o.visualMap, undefined);
});
