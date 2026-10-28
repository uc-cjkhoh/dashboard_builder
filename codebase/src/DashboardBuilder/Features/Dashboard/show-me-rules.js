// P22 Show Me rules — which chart types the sheet's fields can draw, which one to recommend, and how to
// lay Columns / Rows out for a picked type. Also the single home of the chart-type field rules that the
// chart hint uses. Pure, DOM-free (unit-tested under tests/js/show-me-rules.test.mjs).
import { TEXT_VALUE_TYPES } from "./filter-rules.js";

// A pill's role: an explicit role wins; otherwise numeric fields are measures, everything else dimensions.
export const roleOf = (f) => f.role ?? (f.category === "numeric" ? "measure" : "dimension");
// Discrete Colour pivots into one series per value on these types (P7) — they need exactly one measure.
export const COLOR_SPLIT_TYPES = new Set(["bar", "stacked", "line", "area"]);
// P12 statistical charts with their own single-table endpoint (they bypass buildPlan).
export const STAT_SINGLE_TABLE = new Set(["histogram", "boxplot"]);

export const TEXT_VALUE_HINT = "Min/Max of a text or date field shows as Table, Text or KPI — switch the chart type, or use Count.";
export const COLOR_SPLIT_HINT = "Colour splits a single measure across series — use exactly one measure, or remove the Colour field.";
export const statFieldHint = (type) => `${type === "histogram" ? "A histogram" : "A box plot"} needs a numeric field — add one to Columns or Rows.`;

// Field needs per type, checked in order; the first unmet need's text is the hint. Types not listed
// (bar, line, area, kpi, text, table, histogram, boxplot) accept any mapping — 0 dimensions → KPI tiles.
const ANY = Infinity;
const need = (kind, min, max, text) => Object.freeze({ kind, min, max, text });
const PIE = Object.freeze([
  need("measures", 1, 1, "Pie/Donut shows one measure — put exactly one measure on a shelf."),
  need("dims", 1, ANY, "Pie/Donut needs a dimension to slice by — add a dimension."),
]);
const POINTS = Object.freeze([need("measures", 2, ANY, "A point chart plots two measures (X and Y) — add a second measure.")]);
export const CHART_NEEDS = Object.freeze({
  pie: PIE, donut: PIE,
  scatter: POINTS, square: POINTS, circle: POINTS, // P19 point marks share the scatter mapping
  combo: Object.freeze([
    need("measures", 2, ANY, "Combo (dual-axis) needs two measures — add a second measure."),
    need("dims", 1, ANY, "Combo needs a dimension for the category axis — add a dimension.")]),
  stacked: Object.freeze([
    need("measures", 2, ANY, "Stacked bar stacks two or more measures — add another measure."),
    need("dims", 1, ANY, "Stacked bar needs a dimension for the category axis — add a dimension.")]),
  heatmap: Object.freeze([
    need("dims", 2, 2, "Heatmap needs exactly two dimensions (the axes) — put one on Columns and one on Rows."),
    need("measures", 1, ANY, "Heatmap colours by one measure — add a measure.")]),
  treemap: Object.freeze([
    need("dims", 1, 2, "Treemap nests by one or two dimensions — add one or two."),
    need("measures", 1, ANY, "Treemap sizes by one measure — add a measure.")]),
  waterfall: Object.freeze([
    need("measures", 1, 1, "Waterfall shows one measure as a run of changes — use exactly one measure."),
    need("dims", 1, ANY, "Waterfall needs a dimension for its steps (e.g. month or category) — add one.")]),
  funnel: Object.freeze([
    need("measures", 1, 1, "Funnel sizes its stages by one measure — use exactly one measure."),
    need("dims", 1, 1, "Funnel needs exactly one dimension for its stages.")]),
  gauge: Object.freeze([
    need("measures", 1, 1, "Gauge shows one measure — use exactly one measure."),
    need("dims", 0, 0, "Gauge shows a single value — remove the dimensions (or use Bullet to compare categories).")]),
  bullet: Object.freeze([
    need("measures", 1, 2, "Bullet compares one measure with a target — use one measure, plus an optional second measure as its target."),
    need("dims", 0, 1, "Bullet takes at most one dimension (one bar per member).")]),
  sankey: Object.freeze([
    need("dims", 2, 2, "Sankey draws flows between two dimensions — put one on Columns and one on Rows."),
    need("measures", 1, 1, "Sankey sizes each flow by one measure — use exactly one measure.")]),
  multiples: Object.freeze([
    need("dims", 2, 2, "Small multiples needs two dimensions: the first makes a panel per member, the second runs along each panel."),
    need("measures", 1, ANY, "Small multiples plots a measure — add one.")]),
});

/** The rule-table hint for a type and its field counts, or null when it can draw them. */
export function chartIssue(type, dimCount, measureCount) {
  if (!Object.hasOwn(CHART_NEEDS, type)) return null;
  const n = { dims: dimCount, measures: measureCount };
  for (const c of CHART_NEEDS[type]) if (n[c.kind] < c.min || n[c.kind] > c.max) return c.text;
  return null;
}

/** Why `type` can't draw the sheet described by `counts` (first rule that fails), or null. */
export function issueFor(type, counts) {
  if (counts.textValue && !TEXT_VALUE_TYPES.has(type)) return TEXT_VALUE_HINT;
  // A one-measure colour split renders before the rule table (renderColorSplit), so it skips CHART_NEEDS.
  if (counts.discreteColor && COLOR_SPLIT_TYPES.has(type)) return counts.measures !== 1 ? COLOR_SPLIT_HINT : null;
  if (STAT_SINGLE_TABLE.has(type) && !counts.numericField) return statFieldHint(type);
  return chartIssue(type, counts.dims, counts.measures);
}

// --- Recommendation: the type Show Me outlines. `shelfDims` (Columns / Rows + drill) steers it, never
// encodings — a colour-split bar keeps recommending Bar. First match wins.
export function bestType(c) {
  const d = c.shelfDims, m = c.measures;
  if (d === 0 && m === 0) return null;
  if (c.textValue) return "table";
  if (d >= 3) return "table";
  if (d === 0) return m === 2 ? "scatter" : "kpi";
  if (c.hasDate && m >= 1) return "line";
  if (d === 1 && m >= 1) return "bar";
  if (d === 2 && m === 1) return "heatmap";
  return "table";
}

/** Every type with why it can't draw the sheet (null = it can); the best type is flagged only if valid. */
export function showMeOptions(types, countsFor) {
  if (!types.length) return [];
  const options = types.map((id) => ({ id, issue: issueFor(id, countsFor(id)), recommended: false }));
  const best = bestType(countsFor(types[0])); // shelfDims / measures don't vary by type
  const hit = options.find((o) => o.id === best && o.issue === null);
  if (hit) hit.recommended = true;
  return options;
}

// --- Placement: where Columns / Rows pills go for a picked type. D = dimensions in group-by key order
// (Rows, then Columns), M = measures in series order (Columns, then Rows) — planDims / planMeasures order.
const HORIZONTAL_TYPES = new Set(["bar", "stacked"]);
const TIME_TYPES = new Set(["line", "area", "combo"]);
const XY_TYPES = new Set(["scatter", "square", "circle"]);
const TWO_DIM_TYPES = new Set(["heatmap", "sankey", "multiples"]);
const TEXT_TYPES = new Set(["table", "text"]);
const isDim = (f) => roleOf(f) === "dimension";

export function placeFor(type, columns, rows) {
  const dims = [...rows.filter(isDim), ...columns.filter(isDim)];
  const meas = [...columns.filter((f) => !isDim(f)), ...rows.filter((f) => !isDim(f))];
  if (TEXT_TYPES.has(type)) return { columns: meas, rows: dims };
  if (XY_TYPES.has(type)) return { columns: [...dims, ...meas.slice(0, 1)], rows: meas.slice(1) };
  if (TWO_DIM_TYPES.has(type)) return { columns: [...dims.slice(1), ...meas], rows: dims.slice(0, 1) };
  if (TIME_TYPES.has(type)) {
    const temporal = dims.filter((f) => f.category === "temporal");
    return { columns: [...temporal, ...dims.filter((f) => f.category !== "temporal")], rows: meas };
  }
  const horizontal = rows.some(isDim) && !columns.some(isDim); // chartOrientation's rule
  if (HORIZONTAL_TYPES.has(type) && horizontal) return { columns: meas, rows: dims };
  return { columns: dims, rows: meas };
}

/** True when two `{ columns, rows }` hold the same pill objects in the same order. */
export function samePlacement(a, b) {
  const same = (x, y) => x.length === y.length && x.every((f, i) => f === y[i]);
  return same(a.columns, b.columns) && same(a.rows, b.rows);
}
