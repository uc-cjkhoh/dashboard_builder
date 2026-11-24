// Format → Opacity: the model, the post-pass over a built option (multiplied, never replaced), the dim for a selection, the
// thickness overlay, Gantt, and the workbook round trip. Built options only — no browser (tests/live/marks-colour-ui.mjs draws them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildCartesian, buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { applyMarkOpacity, markOpacityOf, markOpacityError, cleanMarkOpacity, OPACITY_TYPES, OPACITY_CHOICES, OPACITY_STOPS } from "../../src/DashboardBuilder/Features/Dashboard/mark-opacity-model.js";
import { applySelectionDim } from "../../src/DashboardBuilder/Features/Dashboard/selection-dim.js";
import { sanitizeSheet } from "../../src/DashboardBuilder/Features/Workbook/workbook-model.js";
import { emptySheet, defaultFormat } from "../../src/DashboardBuilder/Features/Core/store.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
globalThis.window ??= {};
window.echarts ??= { color: { parse: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), lerp: (t, ramp) => ramp[0] } }; // the heatmap's cell colours read echarts' colour helpers
const S = (name, data = [1, 2, 3]) => ({ name, data });
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format: {}, ...extra });

test("model: absent or 100 is 1; a multiple of 10 from 0 to 100 is its fraction; anything else is refused", () => {
  assert.equal(markOpacityOf({}), 1); assert.equal(markOpacityOf(undefined), 1); assert.equal(markOpacityOf({ markOpacity: 100 }), 1);
  assert.equal(markOpacityOf({ markOpacity: 40 }), 0.4); assert.equal(markOpacityOf({ markOpacity: 0 }), 0);
  assert.equal(markOpacityOf({ markOpacity: 45 }), 1, "an invalid stored value draws as 100");
  for (const v of [45, -10, 110, 5.5, "50", NaN]) assert.ok(markOpacityError(v), String(v));
  assert.equal(markOpacityError(70), null);
  assert.deepEqual(cleanMarkOpacity(100), { ok: true, value: null }); assert.deepEqual(cleanMarkOpacity(30), { ok: true, value: 30 }); assert.equal(cleanMarkOpacity(33).ok, false);
  assert.deepEqual(OPACITY_CHOICES.map(([v]) => v), [100, 90, 80, 70, 60, 50, 40, 30, 20, 10, 0]);
  assert.deepEqual(OPACITY_STOPS.map(([v]) => v), [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100]); // the bar runs 0 to 100, one step of 10
  assert.deepEqual(OPACITY_STOPS[4], [40, "40 %"]);
  for (const [v] of OPACITY_STOPS) assert.equal(markOpacityError(v), null, String(v));
  assert.ok(OPACITY_TYPES.has("bar") && OPACITY_TYPES.has("line") && OPACITY_TYPES.has("pie") && OPACITY_TYPES.has("treemap") && !OPACITY_TYPES.has("gauge") && !OPACITY_TYPES.has("table"));
});
test("opacity 100 / absent leaves the built option deep-equal to today's, for every family", () => {
  const json = (o) => JSON.stringify(o); // the option's formatter functions differ by reference; everything that is data is compared
  const same = (spec) => assert.equal(json(applyMarkOpacity(buildOption({ ...spec, format: { markOpacity: 100 } }), markOpacityOf({ markOpacity: 100 }))), json(buildOption({ ...spec, format: {} })));
  same({ type: "bar", categories: ["a"], series: [S("v", [1])] });
  same({ type: "line", categories: ["a", "b"], series: [S("v", [1, 2])] });
  same({ type: "pie", categories: ["a", "b"], series: [S("v", [1, 2])] });
  same({ type: "treemap", tree: [{ name: "a", value: 3 }, { name: "b", value: 1 }] }); // the builders that read the setting themselves
  same({ type: "heatmap", xCats: ["a", "b"], yCats: ["x"], cells: [[0, 0, 1], [1, 0, 5]] });
  same({ type: "gantt", categories: ["t"], gantt: { bars: [{ i: 0, name: "t", start: 0, end: 5, duration: 5, group: 0 }], isDate: false, hasTime: false, groups: [] }, name: "Length" });
  const bar = cart("line", [S("v")], { sizes: [1, 2, 3], sizeName: "q" }); // a Size line draws its thickness overlay through its own builder
  assert.equal(JSON.stringify(applyMarkOpacity(bar, 1)), JSON.stringify(bar));
  const o = cart("bar", [S("v")]);
  assert.equal(applyMarkOpacity(o, 1), o, "no copy and no key when the setting is 100");
});
test("bars, a line's markers and stroke, an area's fill, and a pie multiply their own opacity by the setting", () => {
  const bar = applyMarkOpacity(cart("bar", [S("v")]), 0.4).series[0];
  assert.equal(bar.itemStyle.opacity, 0.4);
  assert.equal(bar.emphasis.itemStyle.opacity, 0.34, "the 0.85 hover fade scales too");
  const area = applyMarkOpacity(cart("area", [S("v")]), 0.5).series[0];
  assert.equal(area.areaStyle.opacity, 0.09, "the area fill's 0.18 is halved, not replaced");
  assert.equal(area.lineStyle.opacity, 0.5); assert.equal(area.itemStyle.opacity, 0.5);
  const pie = applyMarkOpacity(buildOption({ type: "pie", categories: ["a", "b"], series: [S("v", [1, 2])], format: {} }), 0.6).series[0];
  assert.equal(pie.itemStyle.opacity, 0.6);
  const sc = applyMarkOpacity(buildOption({ type: "scatter", categories: ["a"], series: [S("x", [1]), S("y", [2])], format: {} }), 0.5).series[0];
  assert.equal(sc.itemStyle.opacity, 0.4, "a scatter's 0.8 times 0.5");
});
test("a comparison series keeps its fade and multiplies it; a trend line, reference line and band are not touched", () => {
  const o = cart("line", [S("v"), { ...S("v (prev)"), compare: true }], { analytics: { measure: 0, ref: { name: "Avg", value: 2 }, band: { from: 1, to: 3, name: "Band" }, trend: { measure: 0, name: "Trend", short: "T", data: [1, 2, 3] } } });
  const a = applyMarkOpacity(o, 0.5);
  const cmp = a.series.find((s) => s.name === "v (prev)");
  assert.equal(cmp.lineStyle.opacity, 0.35, "0.7 x 0.5");
  const trend = a.series.find((s) => s.name === "Trend");
  assert.equal(trend.lineStyle.opacity, undefined); assert.equal(trend.itemStyle.opacity, undefined);
  assert.deepEqual(a.series[0].markLine, o.series[0].markLine); assert.deepEqual(a.series[0].markArea, o.series[0].markArea);
});
test("a dashboard selection dim multiplies: at 40 % a selected bar is 0.4 and a dimmed one 0.14 — the selection stays visible", () => {
  const o = applyMarkOpacity(applySelectionDim(cart("bar", [S("v")]), "bar", [1]), 0.4);
  const d = o.series[0].data;
  assert.equal(d[0].itemStyle.opacity, 0.14); assert.equal(d[2].itemStyle.opacity, 0.14);
  assert.equal(d[1], 2, "the selected value stays a plain number, drawn at the series' 0.4");
  assert.equal(o.series[0].itemStyle.opacity, 0.4);
  assert.ok(d[0].itemStyle.opacity < o.series[0].itemStyle.opacity);
});
test("a straight line drawn with a Size thickness: the overlay takes the opacity and the thin stroke hides, so they do not stack", () => {
  const o = cart("line", [S("v")], { sizes: [1, 2, 3], sizeName: "q", format: { markOpacity: 50 } });
  const overlay = o.series.find((s) => String(s.id).startsWith("size-width:"));
  const poly = overlay.renderItem({ dataIndex: 0 }, { coord: ([x, y]) => [x * 100, 300 - y * 10] });
  assert.equal(poly.style.opacity, 0.5, "the polygon itself is drawn at the setting");
  const a = applyMarkOpacity(o, 0.5);
  assert.equal(a.series.find((s) => s.type === "line").lineStyle.opacity, 0);
  assert.equal(a.series.find((s) => String(s.id).startsWith("size-width:")), overlay, "the overlay series is not re-styled");
  const none = cart("line", [S("v")], { sizes: [1, 2, 3], sizeName: "q", format: {} });
  const p0 = none.series.find((s) => String(s.id).startsWith("size-width:")).renderItem({ dataIndex: 0 }, { coord: ([x, y]) => [x * 100, 300 - y * 10] });
  assert.equal("opacity" in p0.style, false, "no opacity key without the setting");
});
test("custom series (variable bars) carry the opacity at series level so api.style() reads it", () => {
  const o = applyMarkOpacity(cart("bar", [S("v")], { sizes: [1, 2, 3], sizeName: "q" }), 0.5);
  assert.equal(o.series[0].type, "custom"); assert.equal(o.series[0].itemStyle.opacity, 0.5);
});
test("Gantt bars multiply their selection fade by the setting; labels do not fade for it", () => {
  const gantt = { bars: [{ i: 0, name: "t", start: 0, end: 5, duration: 5, group: 0 }], isDate: false, hasTime: false, groups: [] };
  const rend = (format) => buildOption({ type: "gantt", categories: ["t"], gantt, name: "Length", format }).series[0].renderItem({ dataIndex: 0 }, { coord: ([x, y]) => [x * 10, y * 10], value: (i) => [0, 0, 5][i], size: () => [0, 40] });
  const plain = rend({}).children, faded = rend({ markOpacity: 40 }).children;
  assert.equal(plain[0].style.opacity, 1); assert.equal(faded[0].style.opacity, 0.4);
  assert.equal(faded[1].style.opacity, 1, "the length label stays readable");
});
test("workbook: absent stays absent; a valid value round-trips; an invalid one is reset and reported, never clamped", () => {
  const base = emptySheet("S");
  assert.equal("markOpacity" in defaultFormat(), false);
  assert.equal("markOpacity" in sanitizeSheet(base, "S", []).format, false);
  assert.equal(sanitizeSheet({ ...base, format: { ...base.format, markOpacity: 40 } }, "S", []).format.markOpacity, 40);
  for (const bad of [45, 120, -10, "50", 0.5]) {
    const issues = [];
    const s = sanitizeSheet({ ...base, format: { ...base.format, markOpacity: bad } }, "S", issues);
    assert.equal("markOpacity" in s.format, false, `${bad} is dropped, not clamped`);
    assert.equal(issues.length, 1); assert.match(issues[0], /opacity/i);
  }
});

test("a waterfall's custom rectangles carry the opacity themselves (renderItem ignores the series style); none without the setting", () => {
  const spec = (format) => buildOption({ type: "waterfall", categories: ["a", "b"], series: [{ name: "v", data: [5, -2] }], format });
  const rect = (o) => o.series[0].renderItem({ dataIndex: 0 }, { coord: ([x, y]) => [x * 10, y * 10], value: (i) => [0, 0, 5][i], size: () => [100, 0] }).children[0];
  assert.equal(rect(spec({ markOpacity: 40 })).style.opacity, 0.4);
  assert.equal("opacity" in rect(spec({})).style, false);
});
test("a stale setting on a type without the control is not applied (renderChart gates on OPACITY_TYPES)", () => {
  assert.equal(OPACITY_TYPES.has("gauge"), false); assert.equal(OPACITY_TYPES.has("waterfall"), true);
});
