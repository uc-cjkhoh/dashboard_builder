// The cases behind line-selected.test.mjs and its golden (gen-line-selected-golden.mjs): Line markers choices that existed before "Selected points",
// Label marks Selected cases (the only time the chart is handed its selected marks), and what tuneForSize does to a line for each choice.
import { buildCartesian } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import "./line-golden-cases.mjs"; // the DOM / echarts stand-ins

const S = (name, data = [1, 3, 2]) => ({ name, data });
const many = (n) => Array.from({ length: n }, (_, i) => (i * 7) % 11);
const cats = (n) => Array.from({ length: n }, (_, i) => `c${i}`);
const cart = (type, series, extra = {}) => buildCartesian({ type, categories: ["a", "b", "c"], series, ...extra });

/** [key, format] — the Line markers choices that exist on main (an explicit Automatic is tested equal to an absent key). */
export const MATRIX = [["absent", {}], ["all", { lineMarkers: "all" }], ["none", { lineMarkers: "none" }]];

/** Label marks Selected: `format` carries the choice, `labelMarks` is what render-cartesian hands the chart. */
export const LABEL_SELECTED_CASES = {
  short: (f) => cart("line", [S("v")], { format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [1], recent: [] } }),
  shortNone: (f) => cart("line", [S("v")], { format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [], recent: [] } }),
  many: (f) => cart("line", [S("a"), S("b", [2, 2, 5])], { format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [2], recent: [] } }),
  long: (f) => buildCartesian({ type: "line", categories: cats(80), series: [S("v", many(80))], format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [5, 40], recent: [] } }),
  area: (f) => cart("area", [S("v")], { format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [0], recent: [] } }),
  combo: (f) => cart("combo", [S("b"), S("l1", [2, 2, 5])], { format: { dataLabels: true, labelMarks: "selected", ...f }, labelMarks: { mode: "selected", selected: [1], recent: [] } }),
};

/** What a big (canvas) line's series carry after tuneForSize: sampling on or off. */
export function sampled(build, tune, format) {
  const spec = { type: "line", categories: cats(80), series: [S("v", many(80))], format };
  const option = build(spec);
  tune(option, spec);
  return option.series.map((s) => ({ type: s.type, sampling: s.sampling ?? null }));
}
