// The option matrix behind tooltip-behaviour.test.mjs: `fixtures/tooltip-golden.json` holds what `buildOption` produced for each chart type that has a hover
// tooltip BEFORE Show tooltips / command buttons existed (the tooltip config as JSON plus what its formatter returns for sample hover params), so a sheet with
// neither setting is proven byte-identical.
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { ganttBars } from "../../src/DashboardBuilder/Features/Dashboard/gantt-model.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
globalThis.window ??= globalThis;
window.echarts ??= { color: { parse: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), lerp: (t, ramp) => `rgb(${[0, 1, 2].map((k) => Math.round(parseInt(ramp[0].slice(1 + 2 * k, 3 + 2 * k), 16))).join(",")})` } };

const S = (name, data = [1, 3, 2], extra = {}) => ({ name, data, ...extra });
const cats = ["a", "b", "c"];
const pts = (n) => Array.from({ length: n }, (_, i) => ({ value: [i, i], name: `p${i}`, row: i }));

/** name -> spec for buildOption (every chart type with a hover tooltip). */
export const SPECS = {
  bar: (f) => ({ type: "bar", categories: cats, series: [S("v")], format: { ...f } }),
  barMany: (f) => ({ type: "bar", categories: cats, series: [S("v"), S("w", [2, 2, 5])], format: { ...f } }),
  barText: (f) => ({ type: "bar", categories: cats, series: [S("v")], format: { ...f }, tooltipText: "Sales <v>", tooltipFields: [], tooltipStyle: null, tooltipFormats: null }),
  stacked: (f) => ({ type: "stacked", categories: cats, series: [S("v"), S("w", [2, 2, 5])], format: { ...f } }),
  line: (f) => ({ type: "line", categories: cats, series: [S("v")], format: { ...f } }),
  area: (f) => ({ type: "area", categories: cats, series: [S("v")], format: { ...f } }),
  combo: (f) => ({ type: "combo", categories: cats, series: [S("bars"), S("l1", [2, 2, 5])], format: { ...f } }),
  pie: (f) => ({ type: "pie", categories: cats, series: [S("v")], format: { ...f } }),
  pieText: (f) => ({ type: "pie", categories: cats, series: [S("v")], format: { ...f }, tooltipText: "Share <v>", tooltipFields: [], tooltipStyle: null, tooltipFormats: null }),
  donut: (f) => ({ type: "donut", categories: cats, series: [S("v")], format: { ...f } }),
  scatter: (f) => ({ type: "scatter", categories: cats, series: [S("x"), S("y", [2, 2, 5])], format: { ...f }, symbol: "circle" }),
  scatterShapes: (f) => ({ type: "scatterShapes", groups: [{ name: "EU", points: pts(2), shape: { index: 0, name: "EU", raw: "EU" } }], symbol: "circle", xName: "x", yName: "y", hasSize: false, format: { legend: "top", ...f } }),
  heatmap: (f) => ({ type: "heatmap", xCats: ["a", "b"], yCats: ["x"], cells: [[0, 0, 1], [1, 0, 5]], format: { ...f } }),
  treemap: (f) => ({ type: "treemap", tree: [{ name: "a", value: 3 }, { name: "b", value: 1 }], format: { ...f } }),
  histogram: (f) => ({ type: "histogram", bins: [{ lo: 0, hi: 5, count: 3 }, { lo: 5, hi: 10, count: 7 }], format: { ...f } }),
  boxplot: (f) => ({ type: "boxplot", boxes: [{ label: "a", min: 1, q1: 2, median: 3, q3: 4, max: 5, n: 9 }], outliers: [], format: { ...f } }),
  waterfall: (f) => ({ type: "waterfall", categories: cats, series: [S("v")], format: { ...f } }),
  funnel: (f) => ({ type: "funnel", categories: cats, series: [S("v", [9, 5, 2])], format: { ...f } }),
  gauge: (f) => ({ type: "gauge", value: 4, name: "m", target: 10, format: { ...f } }),
  bullet: (f) => ({ type: "bullet", categories: cats, values: [1, 3, 2], target: 3, name: "m", format: { ...f } }),
  gantt: (f) => ({ type: "gantt", categories: ["a", "b"], gantt: ganttBars(["a", "b"], [10, 25], [5, 10]), name: "Length", format: { ...f } }),
  sankey: (f) => ({ type: "sankey", links: [{ source: "0:a", target: "1:b", value: 3 }], format: { ...f } }),
  multiples: (f) => ({ type: "multiples", panels: [{ name: "p", series: [[1, 2, 3]] }], xCats: cats, seriesNames: ["v"], format: { ...f } }),
};

const PARAMS = { name: "a", value: 3, percent: 30, dataIndex: 1, seriesName: "v", seriesIndex: 0, axisValueLabel: "b", color: "#123456", dataType: "node",
  data: { name: "a", value: [1, 2], source: "0:a", target: "1:b", row: 1 }, treePathInfo: [{ name: "a" }], componentType: "series" };

/** What the tooltip config draws for sample hover params; JSON, so it compares with `deepEqual` and survives a fixture file. */
export function tooltipSnapshot(option) {
  const t = option.tooltip ?? null;
  let tip;
  try { tip = t && typeof t.formatter === "function" ? t.formatter(t.trigger === "axis" ? [PARAMS] : PARAMS) : null; } catch (e) { tip = `ERR ${e.message}`; }
  return { tooltip: JSON.parse(JSON.stringify(t ?? null)), tip: tip ?? null, series: JSON.parse(JSON.stringify((option.series ?? []).map((s) => s.tooltip ?? null))) };
}
export const snapshot = (name, format = {}, build = buildOption) => tooltipSnapshot(build(SPECS[name](format)));
