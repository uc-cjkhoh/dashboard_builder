// The line charts' option matrix behind line-pattern-markers.test.mjs: `fixtures/line-marks-golden.json` holds what these cases produced BEFORE
// Format → Line pattern / Line markers existed, so a sheet with neither set (or both at their defaults) is proven unchanged.
import { buildCartesian } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { applyMarkOpacity } from "../../src/DashboardBuilder/Features/Dashboard/mark-opacity-model.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
globalThis.window ??= globalThis;
window.echarts ??= { color: { parse: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), lerp: (t, ramp) => `rgb(${[0, 1, 2].map((k) => Math.round(parseInt(ramp[0].slice(1 + 2 * k, 3 + 2 * k), 16) * (1 - t) + parseInt(ramp[ramp.length - 1].slice(1 + 2 * k, 3 + 2 * k), 16) * t)).join(",")})` } };
const S = (name, data = [1, 3, 2], extra = {}) => ({ name, data, ...extra });
const many = (n) => Array.from({ length: n }, (_, i) => (i * 7) % 11);
const cats = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, format: {}, ...extra });
const long = (type, format = {}, extra = {}) => buildCartesian({ type, categories: cats(80), series: [S("v", many(80))], format, ...extra });

/** name -> (format) => option. `format` is merged over each case's own, so a test can add the new keys. */
export const CASES = {
  line: (f) => cart("line", [S("v")], { format: { ...f } }),
  lineMany: (f) => cart("line", [S("a"), S("b", [2, 2, 5])], { format: { ...f } }),
  area: (f) => cart("area", [S("v")], { format: { ...f } }),
  stepLine: (f) => cart("line", [S("v")], { format: { lineStyle: "step", ...f } }),
  comboLine: (f) => cart("combo", [S("bars"), S("l1", [2, 2, 5]), S("l2", [3, 1, 4])], { format: { ...f } }),
  comboBar: (f) => cart("combo", [S("bars"), S("b2", [2, 2, 5])], { format: { secondaryType: "bar", ...f } }),
  comboArea: (f) => cart("combo", [S("bars"), S("a1", [2, 2, 5])], { format: { secondaryType: "area", ...f } }),
  longLine: (f) => long("line", f),
  longLineDots: (f) => long("line", { markerSize: 10, ...f }),
  longLabelled: (f) => long("line", { dataLabels: true, labelMarks: "minmax", ...f }, { labelMarks: { mode: "minmax" } }),
  shortLabelled: (f) => cart("line", [S("v")], { format: { dataLabels: true, ...f } }),
  compare: (f) => cart("line", [S("v"), S("v (prior)", [2, 2, 2], { compare: true })], { format: { ...f } }),
  cued: (f) => cart("line", [S("a"), S("b", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "qty", format: { ...f } }),
  cuedCombo: (f) => cart("combo", [S("bars"), S("l1", [2, 2, 5])], { colorValues: [-1, 5, 9], colorName: "qty", format: { ...f } }),
  byValue: (f) => cart("line", [S("v")], { colorValues: [-1, 5, 9], colorName: "qty", format: { ...f } }),
  sizeThick: (f) => cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { ...f } }),
  sizeThickMany: (f) => cart("line", [S("a"), S("b", [2, 2, 5])], { sizes: [10, 20, 30], sizeName: "qty", format: { ...f } }),
  sizeStep: (f) => cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { lineStyle: "step", ...f } }),
  sizeArea: (f) => cart("area", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { ...f } }),
  shape: (f) => cart("line", [S("v")], { format: { markerShape: "diamond", markBorder: "thin", ...f } }),
  opacity: (f) => applyMarkOpacity(cart("line", [S("v"), S("w", [2, 2, 5])], { format: { markOpacity: 50, ...f } }), 0.5),
  opacityThick: (f) => applyMarkOpacity(cart("line", [S("v")], { sizes: [10, 20, 30], sizeName: "qty", format: { markOpacity: 50, ...f } }), 0.5),
  gaps: (f) => cart("line", [S("v", [1, null, 3])], { format: { ...f } }),
  analytics: (f) => cart("line", [S("v")], { format: { ...f }, analytics: { ref: { name: "Average", value: 2 }, trend: { name: "Trend", short: "T", data: [1, 2, 3] } } }),
};
export const snapshot = (name, format = {}) => JSON.parse(JSON.stringify(CASES[name](format)) ?? "null");
