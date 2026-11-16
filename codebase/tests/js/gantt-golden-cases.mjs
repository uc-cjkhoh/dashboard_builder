// The Gantt option matrix behind gantt-size.test.mjs: `fixtures/gantt-size-golden.json` holds what these cases produced BEFORE a Size measure
// could set a Gantt bar's thickness, so a Gantt without Size is proven drawn exactly as before. A case is the built option (data only) plus what each
// custom series' renderItem returns for every bar and what the tooltip formatter says, on a fake api.
import { buildOption } from "../../src/DashboardBuilder/Features/Dashboard/chart.js";
import { ganttBars, ganttSplit } from "../../src/DashboardBuilder/Features/Dashboard/gantt-model.js";

globalThis.document ??= { documentElement: {} };
globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => "" });
globalThis.window ??= globalThis;
window.echarts ??= { color: { parse: (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)), lerp: (t, ramp) => ramp[0] } };

/** A fake zrender api: x counts ×10, a row slot is `slot` px tall and rows are centred in it. */
export const fakeApi = (datum, slot = 40) => ({ coord: ([x, y]) => [x * 10 + 5, y * slot + slot / 2], value: (i) => datum[i], size: () => [0, slot] });

const rows = (keys) => keys.map((k) => ({ keys: k }));
const fmt = (k) => (k == null ? "—" : String(k));
function ganttSpec({ cats, starts, second, keys = null, colour = false, endMode = false, name = "Length", format = {}, selectedIndices, extra = {} }) {
  const sp = ganttSplit(rows(keys ?? cats.map((c) => [c])), fmt, colour);
  const g = ganttBars(sp.categories, starts, second, { end: endMode, slots: sp.slots, colours: sp.colours, raws: sp.rawRows });
  return { type: "gantt", categories: g.rows, gantt: g, name, format, selectedIndices, ...extra };
}

/** name -> (extra spec fields) => spec. The test adds its own fields (Size) over each case's. */
export const SPECS = {
  plain: (x = {}) => ganttSpec({ cats: ["a", "b", "c"], starts: [0, 2, 5], second: [4, 6, 3], extra: x }),
  oneRow: (x = {}) => ganttSpec({ cats: ["a"], starts: [3], second: [4], extra: x }),
  dates: (x = {}) => ganttSpec({ cats: ["a", "b"], starts: ["2026-01-05", "2026-01-09"], second: [3, 2.5], extra: x }),
  endMode: (x = {}) => ganttSpec({ cats: ["a", "b"], starts: [1, 4], second: [5, 9], endMode: true, name: "Length", extra: x }),
  skipped: (x = {}) => ganttSpec({ cats: ["a", "b", "c"], starts: [0, null, 5], second: [4, 6, -3], extra: x }),
  split: (x = {}) => ganttSpec({ cats: ["T1", "T1", "T2"], keys: [["T1", "todo"], ["T1", "done"], ["T2", "todo"]], colour: true, starts: [0, 6, 2], second: [5, 3, 4], extra: x }),
  selected: (x = {}) => ganttSpec({ cats: ["a", "b", "c"], starts: [0, 2, 5], second: [4, 6, 3], selectedIndices: [1], extra: x }),
  styled: (x = {}) => ganttSpec({ cats: ["a", "b"], starts: [0, 2], second: [4, 6], format: { markBorder: "thin", markOpacity: 50, decimals: 1 }, extra: x }),
};

/** The case as plain data: the option, each series' bars as renderItem draws them, and the tooltip text per bar. */
export function snapshot(spec, slot = 40) {
  const o = buildOption(spec);
  const data = JSON.parse(JSON.stringify(o) ?? "null");
  const items = o.series.map((s, si) => s.data.map((d, di) => JSON.parse(JSON.stringify(s.renderItem({ dataIndex: di }, fakeApi(d, slot))) ?? "null")));
  const tips = o.series.map((s, si) => s.data.map((d, di) => o.tooltip.formatter({ seriesIndex: si, dataIndex: di })));
  return { option: data, items, tips };
}
