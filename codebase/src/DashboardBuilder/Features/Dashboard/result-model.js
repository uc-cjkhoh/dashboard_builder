import { roleOf } from "./show-me-rules.js";
import { marksOf, planDims, planMeasures, drillActiveDim } from "./sheet-plan.js";
import { isCalcPill, sameCalcPill } from "../Calc/calc-pill.js";
import { aggWord } from "../Calc/calc-plan.js";
import { tooltipCatalog } from "./tooltip-model.js";
import { checkFilter } from "./filter-rules.js";
import { tupleKey, uniqueTuples } from "./grid-model.js";

// Pure shaping of a query result for drawing (P24a): which result column is a series or a mark channel, the pivots
// behind the colour split, heatmap, treemap, Sankey and small multiples, display names, and the status / caption text.
// No DOM and no state, so a view can draw a worksheet on its own and every rule is unit-tested
// (tests/js/result-model.test.mjs). The render modules (render-*.js) turn these shapes into marks.

// P21: chart types that take reference lines / bands / a trend.
export const ANALYTICS_TYPES = new Set(["bar", "line", "area"]);
// Chart types whose marks map 1:1 to a category and so support click-to-filter (P15).
export const CLICK_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "pie", "donut", "scatter"]);
// P36 types drawn from the ordinary /api/query result.
export const P36_TYPES = new Set(["waterfall", "funnel", "gauge", "bullet", "sankey", "multiples"]);
// Small multiples draw at most this many panels.
export const MAX_PANELS = 24;

export const scatterSymbol = (type) => (type === "square" ? "rect" : "circle");
export const sameField = (a, b) => Boolean(a) && Boolean(b) && (isCalcPill(a) || isCalcPill(b) ? sameCalcPill(a, b) : a.db === b.db && a.table === b.table && a.column === b.column);
/** Ordering comparator for Path (P19): numeric when both look numeric, else a locale string compare. */
export function cmpValues(a, b) {
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a ?? "").localeCompare(String(b ?? ""));
}
/** A group-by key's label: "—" for null, else the (date-aware) category formatter. */
export const keyLabel = (fmtCat) => (k, i) => (k == null ? "—" : fmtCat(k, i));

/**
 * The sheet's primary dimension = the first group-by key (Rows-shelf dims first, then Columns-shelf), matching
 * buildPlan()'s key order; a click filters on this dimension's value. With a drill hierarchy active its current level
 * LEADS the group-by, so it is the primary dimension. A calculated dimension has no column to filter on (null).
 */
export function primaryDim(sheet) {
  const dd = drillActiveDim(sheet);
  if (dd) return dd;
  const first = [
    ...sheet.rows.filter((f) => roleOf(f) === "dimension"),
    ...sheet.columns.filter((f) => roleOf(f) === "dimension"),
  ][0] ?? null;
  return isCalcPill(first) ? null : first;
}

/**
 * Chart orientation, Tableau-style: a dimension on Rows (and none on Columns) -> horizontal bars; otherwise vertical.
 * Only the cartesian bar/stacked/line/area types honour it (combo keeps its dual y-axis vertical).
 */
export function chartOrientation(sheet) {
  const rowDims = sheet.rows.filter((f) => roleOf(f) === "dimension").length;
  const colDims = sheet.columns.filter((f) => roleOf(f) === "dimension").length;
  return rowDims > 0 && colDims === 0 ? "horizontal" : "vertical";
}

/** P28: rename a result's dimension and measure labels by the fields' display names (`metaOf(field).alias`). */
export function aliasNames(sheet, result, metaOf) {
  const { rowDims, colDims } = planDims(sheet);
  const mplan = planMeasures(sheet);
  const dimName = (f, fallback) => (f && metaOf(f).alias) || fallback;
  const measures = result.measures.map((m, mi) => {
    const e = mplan[mi];
    if (!e || e.agg === "count" || isCalcPill(e.field)) return m;
    const alias = metaOf(e.field).alias;
    return alias ? `${aggWord(e.agg)} ${alias}` : m;
  });
  return { ...result,
    rowDimensions: result.rowDimensions.map((n, i) => dimName(rowDims[i], n)),
    columnDimensions: result.columnDimensions.map((n, i) => dimName(colDims[i], n)),
    measures };
}

/** P19 Path: rows ordered by the Path field's value (a group-by key or a numeric measure); null when unset / not in the query. */
export function pathOrderedRows(sheet, result, mplan) {
  const pf = marksOf(sheet).path;
  if (!pf) return null;
  const { keyOrder } = planDims(sheet);
  const ki = keyOrder.findIndex((f) => sameField(f, pf));
  if (ki >= 0) return [...result.rows].sort((a, b) => cmpValues(a.keys[ki], b.keys[ki]));
  const mi = mplan.findIndex((e) => sameField(e.field, pf));
  if (mi >= 0) return [...result.rows].sort((a, b) => (Number(a.values[mi]) || 0) - (Number(b.values[mi]) || 0));
  return null;
}

/**
 * The status line under a chart: "12 marks · 3 rows × 4 columns · 2 measures · Selected: …". Rows and columns are
 * counted only for the Table / Text types. The caller owns the element.
 */
export function statusText(s, result) {
  const n = (x) => x.toLocaleString("en-US");
  const parts = [`${n(result.rows.length)} mark${result.rows.length === 1 ? "" : "s"}`];
  const tuples = (from, count) => new Set(result.rows.map((r) => JSON.stringify(r.keys.slice(from, from + count)))).size;
  const rd = result.rowDimensions.length, cd = result.columnDimensions.length;
  if (s.chartType === "table" || s.chartType === "text")
    parts.push(`${n(tuples(0, rd))} row${tuples(0, rd) === 1 ? "" : "s"} × ${n(tuples(rd, cd))} column${tuples(rd, cd) === 1 ? "" : "s"}`);
  parts.push(`${result.measures.length} measure${result.measures.length === 1 ? "" : "s"}`);
  if (s.selection) parts.push(`Selected: ${s.selection.label}`);
  return parts.join(" · ");
}

/** The automatic caption: "sum amount by customers.name, customers.country · 2 filters". `names` = { measureName(f), nameOf(f) }. */
export function captionText(s, names) {
  const ms = planMeasures(s).filter((e) => e.role === "shelf").map((e) => names.measureName({ ...e.field, agg: e.agg }));
  const ds = planDims(s).keyOrder.filter(Boolean).map(names.nameOf);
  const parts = [];
  if (ms.length || ds.length) parts.push(`${ms.length ? ms.join(", ") : "count"}${ds.length ? ` by ${ds.join(", ")}` : ""}`);
  const nf = s.filters.filter((f) => checkFilter(f).state === "ok").length;
  if (nf) parts.push(`${nf} filter${nf === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/**
 * Per-row display values for a marks field over the given rows: a group-by dimension reads its key (date-aware), a
 * measure reads its aggregated value. null when the field isn't in the query. `measureName(field)` is the display name.
 */
export function markFieldValues(sheet, rows, mplan, field, fmtVal, fmtCat, measureName) {
  const { keyOrder } = planDims(sheet);
  const ki = keyOrder.findIndex((f) => sameField(f, field));
  if (ki >= 0) return { name: `${field.table}.${field.column}`, values: rows.map((r) => (r.keys[ki] == null ? "—" : fmtCat(r.keys[ki], ki))) };
  const mi = mplan.findIndex((e) => sameField(e.field, field));
  if (mi >= 0) return { name: measureName(mplan[mi].field.agg ? mplan[mi].field : { ...mplan[mi].field, agg: mplan[mi].agg }), values: rows.map((r) => fmtVal(r.values[mi])) };
  return null;
}

/**
 * The P18 mark-channel spec fed to chart.js: { spec: { sizes?, sizeName?, colorValues?, colorName?, pointLabels?,
 * tooltipExtra?, tooltipText?, tooltipFields? }, note?, tooltipCat }. Only channels valid for the current type / mapping
 * are populated; anything unmet becomes a friendly `note` (a hint, never an error). `tooltipCat` is the field list the
 * Tooltip editor offers. `measureName(field)` is the display name of a measure field.
 */
export function marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered, scatterTypes, measureName) {
  const m = marksOf(sheet);
  const spec = {};
  const notes = [];
  const type = sheet.chartType;
  const rows = rowsOrdered ?? result.rows; // align channel arrays with the (possibly Path-ordered) rows
  const values = (f) => markFieldValues(sheet, rows, mplan, f, fmtVal, fmtCat, measureName);

  // Size -> the scatter family's bubbles (variable bar/line width is out of scope for v1).
  if (m.size) {
    if (scatterTypes.has(type) && sizeIdx >= 0) {
      spec.sizes = rows.map((r) => r.values[sizeIdx]);
      spec.sizeName = result.measures[sizeIdx];
    } else if (!scatterTypes.has(type)) {
      notes.push("Size shapes a Scatter (bubble) chart — switch to Scatter to use it.");
    }
  }
  // Continuous Colour -> a token-derived gradient on scatter points, with a visualMap legend.
  if (colorMeasureIdx >= 0) {
    if (scatterTypes.has(type)) {
      spec.colorValues = rows.map((r) => r.values[colorMeasureIdx]);
      spec.colorName = result.measures[colorMeasureIdx];
    } else {
      notes.push("Continuous colour applies to Scatter — drop a categorical field on Colour for other chart types.");
    }
  }
  // Label -> the field's value written on each mark. Numeric labels ride along as an aux measure; categorical labels
  // must be a group-by (on a shelf / Detail / Colour) to have one value per mark.
  if (m.label) {
    const resolved = values(m.label);
    if (resolved) spec.pointLabels = resolved.values;
    else notes.push("Label by a numeric field, or add the Label field to Columns/Rows/Detail so it groups.");
  }
  // Tooltip -> extra lines listing each chosen field's per-mark value.
  const tips = (m.tooltip ?? []).map(values).filter(Boolean);
  if (tips.length) spec.tooltipExtra = tips.map((t) => ({ name: t.name, values: t.values }));
  // T01-19 tooltip text: the template + every group-by / Tooltip field's per-mark values (measures come from the series).
  const dimVals = planDims(sheet).keyOrder.map(values).filter(Boolean);
  const tipFields = [...dimVals, ...tips].map((t) => ({ name: t.name, values: t.values }));
  // Chips offer only placeholders that resolve: group-by / Tooltip fields and the shelf (series) measures.
  const shelfNames = (result.measures ?? []).slice(0, mplan.filter((e) => e.role === "shelf").length);
  const tooltipCat = tooltipCatalog(tipFields, shelfNames, shelfNames.map((_, i) => (rows[0] ? fmtVal(rows[0].values[i]) : "")));
  if (sheet.tooltipText) { spec.tooltipText = sheet.tooltipText; spec.tooltipFields = tipFields; }
  // Angle: pie/donut already map their measure to slice angle; elsewhere a radial angle has no mark.
  if (m.angle && type !== "pie" && type !== "donut") notes.push("Angle drives a Pie/Donut slice — that mapping is already implicit there.");

  return { spec, note: notes.length ? notes.join(" ") : null, tooltipCat };
}

/**
 * P19 Shape (scatter family): group rows by the Shape dimension's value -> one scatter series per value.
 * Returns { groups: [{ name, points: [{ value: [x, y, size?], name }] }], byName: Map(name -> raw shape value) }.
 */
export function scatterShapeGroups(sheet, result, seriesIdx, sizeIdx, fmtCat) {
  const { keyOrder } = planDims(sheet);
  const si = keyOrder.findIndex((f) => sameField(f, marksOf(sheet).shape));
  const xIdx = seriesIdx[0], yIdx = seriesIdx[1];
  const groupsMap = new Map();
  for (const r of result.rows) {
    const sv = si >= 0 ? r.keys[si] : null;
    const gk = tupleKey([sv]);
    if (!groupsMap.has(gk)) groupsMap.set(gk, { name: sv == null ? "—" : fmtCat(sv, si), points: [], raw: sv });
    const pt = [Number(r.values[xIdx]) || 0, Number(r.values[yIdx]) || 0];
    if (sizeIdx >= 0) pt.push(Number(r.values[sizeIdx]) || 0);
    const label = r.keys.map((k, i) => (i === si ? null : (k == null ? "—" : fmtCat(k, i)))).filter((v) => v != null).join(" / ");
    groupsMap.get(gk).points.push({ value: pt, name: label });
  }
  const groups = [...groupsMap.values()];
  return { groups: groups.map(({ name, points }) => ({ name, points })), byName: new Map(groups.map((g) => [g.name, g.raw])) };
}

/**
 * P7 colour split: pivot the trailing group-by key into one series per colour value; the remaining keys form the
 * category axis. Missing (category x colour) cells are null so series stay aligned. One measure only.
 * Returns { categories, series: [{ name, data }], catTuples, colorVals }.
 */
export function colorSplitData(result, fmtCat) {
  const { rowDimensions, columnDimensions, rows } = result;
  const colorIdx = rowDimensions.length + columnDimensions.length - 1;
  const catOf = (keys) => keys.filter((_, i) => i !== colorIdx);
  const catTuples = uniqueTuples(rows.map((r) => catOf(r.keys)));
  const colorVals = [];
  const seen = new Set();
  for (const r of rows) {
    const cv = r.keys[colorIdx];
    const k = tupleKey([cv]);
    if (!seen.has(k)) { seen.add(k); colorVals.push(cv); }
  }
  const cell = new Map();
  for (const r of rows) cell.set(tupleKey(catOf(r.keys)) + "|" + tupleKey([r.keys[colorIdx]]), r.values[0]);
  const categories = catTuples.map((t) => (t.length ? t.map((k, i) => (k == null ? "—" : fmtCat(k, i))).join(" / ") : ""));
  const series = colorVals.map((cv) => ({
    name: cv == null ? "—" : fmtCat(cv, colorIdx),
    data: catTuples.map((t) => cell.get(tupleKey(t) + "|" + tupleKey([cv])) ?? null),
  }));
  return { categories, series, catTuples, colorVals };
}

/** P12 heatmap: two dimensions -> axes (dim 0 the Y axis, dim 1 the X axis), the first measure -> colour. */
export function heatmapData(result, fmtCat) {
  const rows = result.rows;
  const yVals = [], xVals = [], ySeen = new Set(), xSeen = new Set();
  for (const r of rows) {
    const y = tupleKey([r.keys[0]]); if (!ySeen.has(y)) { ySeen.add(y); yVals.push(r.keys[0]); }
    const x = tupleKey([r.keys[1]]); if (!xSeen.has(x)) { xSeen.add(x); xVals.push(r.keys[1]); }
  }
  const yCats = yVals.map((v) => (v == null ? "—" : fmtCat(v, 0)));
  const xCats = xVals.map((v) => (v == null ? "—" : fmtCat(v, 1)));
  const yIdx = new Map(yVals.map((v, i) => [tupleKey([v]), i]));
  const xIdx = new Map(xVals.map((v, i) => [tupleKey([v]), i]));
  const cells = rows.map((r) => [xIdx.get(tupleKey([r.keys[1]])), yIdx.get(tupleKey([r.keys[0]])), r.values[0]]);
  return { xCats, yCats, cells };
}

/** P12 treemap: one dimension -> flat leaves; two -> dimension 0 groups, dimension 1 nests under it (values summed). */
export function treemapTree(result, fmtCat) {
  const dimCount = result.rowDimensions.length + result.columnDimensions.length;
  const rows = result.rows;
  if (dimCount === 1) return rows.map((r) => ({ name: r.keys[0] == null ? "—" : fmtCat(r.keys[0], 0), value: r.values[0] }));
  const parents = new Map();
  for (const r of rows) {
    const pk = tupleKey([r.keys[0]]);
    if (!parents.has(pk)) parents.set(pk, { name: r.keys[0] == null ? "—" : fmtCat(r.keys[0], 0), value: 0, children: [] });
    const node = parents.get(pk);
    node.value += Number(r.values[0]) || 0;
    node.children.push({ name: r.keys[1] == null ? "—" : fmtCat(r.keys[1], 1), value: r.values[0] });
  }
  return [...parents.values()];
}

/** P36 Sankey: bipartite links, side-prefixed so a member on both sides stays two nodes; non-positive flows skipped. */
export function sankeyLinks(rows, label) {
  const links = [];
  for (const r of rows) {
    const v = Number(r.values[0]);
    if (Number.isFinite(v) && v > 0) links.push({ source: `s:${label(r.keys[0], 0)}`, target: `t:${label(r.keys[1], 1)}`, value: v });
  }
  return links;
}

/**
 * P36 small multiples: x categories = the second key in first-seen order; one panel per first-key member (result
 * order, capped at MAX_PANELS), each holding one array per measure. `series[si].data` is aligned with `rows`.
 * Returns { panels, xCats, distinct, notice } (notice = the panel-cap line, or null).
 */
export function multiplesData(rows, series, seriesNames, label) {
  const xCats = [], xIndex = new Map(), panels = new Map();
  for (const r of rows) {
    const x = label(r.keys[1], 1);
    if (!xIndex.has(x)) { xIndex.set(x, xCats.length); xCats.push(x); }
  }
  rows.forEach((r, ri) => {
    const name = label(r.keys[0], 0);
    if (!panels.has(name)) {
      if (panels.size >= MAX_PANELS) return;
      panels.set(name, { name, series: seriesNames.map(() => new Array(xCats.length).fill(null)) });
    }
    const p = panels.get(name), xi = xIndex.get(label(r.keys[1], 1));
    seriesNames.forEach((_, si) => { p.series[si][xi] = series[si].data[ri]; });
  });
  const distinct = new Set(rows.map((r) => label(r.keys[0], 0))).size;
  return { panels: [...panels.values()], xCats, distinct,
    notice: distinct > MAX_PANELS ? `Showing the first ${MAX_PANELS} of ${distinct} panels — filter or lower Top-N to see others.` : null };
}
