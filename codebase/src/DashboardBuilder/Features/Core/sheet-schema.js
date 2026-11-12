// Allowed values for a saved worksheet — the workbook validator checks every field against these.
// Keep CHART_TYPE_IDS in step with CHART_TYPES in Dashboard/dashboards.js.
export const CHART_TYPE_IDS = new Set(["bar", "stacked", "line", "area", "pie", "donut", "scatter", "combo",
  "square", "circle", "heatmap", "treemap", "histogram", "boxplot", "kpi", "text", "table",
  "waterfall", "funnel", "gauge", "bullet", "sankey", "multiples", "gantt"]);
export const CATEGORIES = new Set(["numeric", "text", "temporal", "boolean", "compound", "other"]);
export const FILTER_OPS = new Set(["=", "!=", ">", ">=", "<", "<=", "in", "notin", "between",
  "contains", "startsWith", "endsWith", "relative", "top"]);
export const NUMBER_FORMATS = new Set(["auto", "compact", "currency", "percent"]);
export const DATE_FORMATS = new Set(["auto", "date", "month", "year", "datetime"]);
export const LEGENDS = new Set(["auto", "hidden", "top", "bottom", "left", "right"]);
export const TOP_N = new Set([5, 10, 20, 50, 100]);
export const PERIOD_PRESETS = new Set(["last7", "last28", "last30", "last90", "thisMonth", "lastMonth",
  "thisQuarter", "lastQuarter", "thisYear", "lastYear", "custom"]);
export const PERIOD_COMPARES = new Set(["none", "previous", "lastYear", "custom"]);
// Conditional formatting (format.conditional: { [measureKey]: { mode, scale, mid, rules[] } }).
export const CF_MODES = new Set(["none", "scale", "bars"]);
export const CF_SCALES = new Set(["sequential", "diverging"]);
export const CF_OPS = new Set([">", ">=", "<", "<=", "=", "!="]);
export const CF_TONES = new Set(["good", "bad", "warn", "info"]);
export const CF_MAX_RULES = 5;
export const CF_MAX_MEASURES = 20;
// Per-pill date parts (Dashboard/date-parts.js; server RequestRules.DateParts).
export const DATE_PARTS = new Set(["auto", "exact", "year", "quarter", "month", "week", "day", "hour",
  "quarterOfYear", "monthOfYear", "dayOfWeek", "hourOfDay"]);
export const DATE_LABELS = new Set(["all", "thin"]); // a date pill's axis labels (Dashboard/date-labels.js)
// Quick table calculations on a measure pill (Dashboard/table-calc.js).
export const TABLE_CALCS = new Set(["none", "running", "pctTotal", "diff", "pctDiff", "compound", "rank", "pctRank", "moving"]);
export const CALC_ALONG = new Set(["auto", "columns", "rows", "custom"]);
export const REF_KINDS = new Set(["none", "average", "median", "min", "max", "constant"]);
export const TRENDS = new Set(["none", "linear", "log", "exp", "power", "poly2", "poly3", "poly4"]);
export const FORECASTS = new Set([0, 3, 6, 12]);
export const FIT_MODES = new Set(["standard", "width", "height", "entire"]); // Format → Fit
export const DATE_BUCKETS = new Set(["auto", "exact", "hour", "day", "week", "month", "quarter", "year"]);
export const LINE_STYLES = new Set(["straight", "step", "jump"]); // Format → Line style
export const HEATMAP_SHAPES = new Set(["square", "circle"]);
export const SECONDARY_TYPES = new Set(["line", "bar", "area"]); // Format → Right-axis marks (combo)
export const MARK_BORDERS = new Set(["none", "thin", "medium", "thick"]);
export const MARK_BORDER_COLOURS = new Set(["muted", "ink", "surface", "accent"]); // Format → Border colour (palette tokens)
export const MARKER_SHAPES = new Set(["circle", "square", "diamond", "triangle"]); // Format → Marker shape (line charts)
export const TABLE_ALIGNS = new Set(["auto", "left", "center", "right"]); // Format → Align (table values)
export const TABLE_DENSITIES = new Set(["standard", "compact", "roomy"]); // Format → Row height
export const FONTS = new Set(["default", "serif", "mono"]); // Format → Font (worksheet text family)
export const BACKGROUNDS = new Set(["none", "subtle", "muted"]); // Format → Background (surface token behind the worksheet)
export const TABLE_SHADES = new Set(["none", "banded", "header", "both"]); // Format → Shading
export const MAX_TARGET_MEASURE = 19; // shelf index of the bullet target measure
export const MAX_DECIMALS = 10;
