// Dimming for the dashboard's source widget (P24c) — pure: a render-only restyle of an ECharts option, so the selected mark
// stays at full strength and the rest fade. Only the types whose data points ECharts can style one by one (bar and stacked
// columns, pie and donut slices); the other types are marked by the dashboard chip and the widget's header alone.
export const DIM_OPACITY = 0.35;
export const DIM_TYPES = new Set(["bar", "stacked", "pie", "donut"]);
const MARKS = new Set(["bar", "pie"]); // series kinds that are marks (a trend / reference line over a bar chart is not)

const fade = (item) => {
  const obj = item !== null && typeof item === "object" && !Array.isArray(item);
  return obj ? { ...item, itemStyle: { ...item.itemStyle, opacity: DIM_OPACITY } } : { value: item, itemStyle: { opacity: DIM_OPACITY } };
};

/** `option` with every mark but the selected ones faded (`selected` = an index or an array of indices); the option itself when there is nothing to dim. */
export function applySelectionDim(option, type, selected) {
  const keep = new Set([].concat(selected ?? []).filter((i) => Number.isInteger(i) && i >= 0));
  if (!DIM_TYPES.has(type) || !keep.size) return option;
  return { ...option, series: (option.series ?? []).map((s) => (MARKS.has(s.type) && !s.compare && Array.isArray(s.data)
    ? { ...s, data: s.data.map((d, i) => (keep.has(i) ? d : fade(d))) } : s)) };
}
