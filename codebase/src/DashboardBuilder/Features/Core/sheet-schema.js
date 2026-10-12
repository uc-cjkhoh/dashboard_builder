// Allowed values for a saved worksheet — the workbook validator checks every field against these.
// Keep CHART_TYPE_IDS in step with CHART_TYPES in Dashboard/dashboards.js.
export const CHART_TYPE_IDS = new Set(["bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo",
  "square", "circle", "heatmap", "treemap", "histogram", "boxplot", "kpi", "text", "table"]);
export const CATEGORIES = new Set(["numeric", "text", "temporal", "boolean", "compound", "other"]);
export const FILTER_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "in", "between"]);
export const NUMBER_FORMATS = new Set(["auto", "compact", "currency", "percent"]);
export const DATE_FORMATS = new Set(["auto", "date", "month", "year", "datetime"]);
export const LEGENDS = new Set(["auto", "hidden", "top", "bottom", "left", "right"]);
export const TOP_N = new Set([5, 10, 20, 50, 100]);
export const MAX_DECIMALS = 10;
