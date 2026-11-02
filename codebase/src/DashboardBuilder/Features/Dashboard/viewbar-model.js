// Worksheet view-bar model — pure, DOM-free (unit-tested under tests/js/): the chart types the picker
// offers (with their icons), and what the Sort button summarises.

// Chart types. Validity per type is enforced in dashboards.js chartIssue().
export const CHART_TYPES = Object.freeze([
  ["bar", "Bar"], ["stacked", "Stacked bar"], ["line", "Line"], ["area", "Area"],
  ["pie", "Pie"], ["donut", "Donut"], ["scatter", "Scatter"], ["combo", "Combo (dual-axis)"],
  // Point-mark types (square/circle share the scatter path with a symbol override).
  ["square", "Square"], ["circle", "Circle"],
  // Statistical types.
  ["heatmap", "Heatmap"], ["treemap", "Treemap"], ["histogram", "Histogram"], ["boxplot", "Box plot"],
  // Types.
  ["waterfall", "Waterfall"], ["funnel", "Funnel"], ["gauge", "Gauge"], ["bullet", "Bullet"],
  ["sankey", "Sankey (flow)"], ["multiples", "Small multiples"],
  ["kpi", "KPI"], ["text", "Text"], ["table", "Table"],
]);

const ICONS = { table: "table" }; // every other type uses its own "chart-<type>" glyph
export const chartIcon = (type) => ICONS[type] ?? `chart-${type}`;
export const chartLabel = (type) => (CHART_TYPES.find(([v]) => v === type) ?? CHART_TYPES[0])[1];

/** The Sort button's state: the sorted field (default: the first target) and direction, or null when
 *  the view has nothing to sort. */
export function sortSummary(targets, sort) {
  if (!targets.length) return null;
  return { current: targets.find((t) => t.id === sort?.by) ?? targets[0], dir: sort?.dir === "desc" ? "desc" : "asc" };
}
