import { roleOf } from "./show-me-rules.js";
import { marksOf, planDims, planMeasures, drillActiveDim, colorMode } from "./sheet-plan.js";
import { isCalcPill, sameCalcPill } from "../Calc/calc-pill.js";
import { aggWord } from "../Calc/calc-plan.js";
import { tooltipCatalog } from "./tooltip-model.js";
import { checkFilter } from "./filter-rules.js";
import { tupleKey, uniqueTuples } from "./grid-model.js";
import { isCalc, calcName } from "./table-calc.js";
import { colourChannel, sizeChannel } from "./mark-channel-model.js";

// Pure shaping of a query result for drawing: which result column is a series or a mark channel, the pivots
// behind the colour split, heatmap, treemap, Sankey and small multiples, display names, and the status / caption text.
// No DOM and no state, so a view can draw a worksheet on its own and every rule is unit-tested
// (tests/js/result-model.test.mjs). The render modules (render-*.js) turn these shapes into marks.

// Chart types that take reference lines / bands / a trend.
export const ANALYTICS_TYPES = new Set(["bar", "line", "area"]);
// Chart types whose marks map 1:1 to a category and so support click-to-filter.
export const CLICK_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "pie", "donut", "scatter"]);
// Types drawn from the ordinary /api/query result.
export const P36_TYPES = new Set(["waterfall", "funnel", "gauge", "bullet", "sankey", "multiples", "gantt"]);
// Small multiples draw at most this many panels.
export const MAX_PANELS = 24;

export const scatterSymbol = (type) => (type === "square" ? "rect" : "circle");
export const sameField = (a, b) => Boolean(a) && Boolean(b) && (isCalcPill(a) || isCalcPill(b) ? sameCalcPill(a, b) : a.db === b.db && a.table === b.table && a.column === b.column);
/** Ordering comparator for Path: numeric when both look numeric, else a locale string compare. */
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

/** Rename a result's dimension and measure labels by the fields' display names (`metaOf(field).alias`). */
export function aliasNames(sheet, result, metaOf) {
  const { rowDims, colDims } = planDims(sheet);
  const mplan = planMeasures(sheet);
  const dimName = (f, fallback) => (f && metaOf(f).alias) || fallback;
  const measures = result.measures.map((m, mi) => {
    const e = mplan[mi];
    if (!e || e.agg === "count" || isCalcPill(e.field)) return m;
    const alias = metaOf(e.field).alias;
    return alias ? `${aggWord(e.agg, e.field.p)} ${alias}` : m;
  });
  return { ...result,
    rowDimensions: result.rowDimensions.map((n, i) => dimName(rowDims[i], n)),
    columnDimensions: result.columnDimensions.map((n, i) => dimName(colDims[i], n)),
    measures };
}

/** Path: rows ordered by the Path field's value (a group-by key or a numeric measure); null when unset / not in the query. */
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
    parts.push(`${n(tuples(0, rd))} × ${n(tuples(rd, cd))} table`);
  parts.push(`${result.measures.length} measure${result.measures.length === 1 ? "" : "s"}`);
  if (s.selection) parts.push(`Selected: ${s.selection.label}`);
  return parts.join(" · ");
}

// A histogram / box plot draws the spread of one numeric field: "distribution of orders.qty" (a box plot with groups: "orders.qty by customers.country").
function statCaption(s, names) {
  const all = [...(s.columns ?? []), ...(s.rows ?? [])];
  const num = all.find((f) => f.category === "numeric");
  const parts = [];
  if (num) {
    const groups = s.chartType === "boxplot" ? all.filter((f) => f !== num && f.category !== "numeric").map(names.nameOf) : [];
    parts.push(groups.length ? `${names.nameOf(num)} by ${groups.join(", ")}` : `distribution of ${names.nameOf(num)}`);
  }
  const nf = (s.filters ?? []).filter((f) => checkFilter(f).state === "ok").length;
  if (nf) parts.push(`${nf} filter${nf === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

/** The automatic caption: "sum amount by customers.name, customers.country · 2 filters". `names` = { measureName(f), nameOf(f) }. */
export function captionText(s, names) {
  if (s.chartType === "histogram" || s.chartType === "boxplot") return statCaption(s, names);
  const ms = planMeasures(s).filter((e) => e.role === "shelf").map((e) => names.measureName({ ...e.field, agg: e.agg }) + (isCalc(e.field.tableCalc) ? ` · ${calcName(e.field.tableCalc)}` : ""));
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
 * The mark-channel spec fed to chart.js: { spec: { sizes?, sizeName?, colorValues?, colorName?, pointLabels?,
 * tooltipExtra?, tooltipText?, tooltipFields? }, note?, tooltipCat }. `sizes` / `colorValues` are aligned with the rows
 * (null for the "Other" row). Only channels valid for the current type / mapping (mark-channel-model.js)
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

  // Size and a continuous Colour read one result column each; which types accept them is mark-channel-model.js.
  // The "Other" row (the cut-off members' total) is not a data point: it takes neither size nor colour.
  const shelfCount = mplan.filter((e) => e.role === "shelf").length;
  const column = (idx) => rows.map((r) => (r.isOther ? null : r.values[idx]));
  if (m.size) {
    const ch = sizeChannel(type, shelfCount);
    if (ch.ok && sizeIdx >= 0) { spec.sizes = column(sizeIdx); spec.sizeName = result.measures[sizeIdx]; }
    else if (!ch.ok) notes.push(ch.note);
  }
  if (colorMeasureIdx >= 0) {
    const ch = colourChannel(type, shelfCount);
    if (ch.ok) { spec.colorValues = column(colorMeasureIdx); spec.colorName = result.measures[colorMeasureIdx]; }
    else notes.push(ch.note);
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
  // Tooltip text: the template + every group-by / Tooltip field's per-mark values (measures come from the series).
  const dimVals = planDims(sheet).keyOrder.map(values).filter(Boolean);
  const tipFields = [...dimVals, ...tips].map((t) => ({ name: t.name, values: t.values }));
  // Chips offer only placeholders that resolve: group-by / Tooltip fields and the shelf (series) measures.
  const shelfNames = (result.measures ?? []).slice(0, mplan.filter((e) => e.role === "shelf").length);
  const tooltipCat = tooltipCatalog(tipFields, shelfNames, shelfNames.map((_, i) => (rows[0] ? fmtVal(rows[0].values[i]) : "")), shelfNames.map((_, i) => rows[0]?.values[i]));
  if (sheet.tooltipText) { spec.tooltipText = sheet.tooltipText; spec.tooltipFields = tipFields; if (sheet.tooltipStyle) spec.tooltipStyle = sheet.tooltipStyle; if (sheet.tooltipFormats) spec.tooltipFormats = sheet.tooltipFormats; }
  // Angle: pie/donut already map their measure to slice angle; elsewhere a radial angle has no mark.
  if (m.angle && type !== "pie" && type !== "donut") notes.push("Angle drives a Pie/Donut slice — that mapping is already implicit there.");

  return { spec, note: notes.length ? notes.join(" ") : null, tooltipCat };
}

/**
 * The scatter family's groups: one series per Colour member, per Shape member, or per (Colour, Shape) pair, each holding its
 * points. Returns { groups: [{ name, points: [{ value: [x, y, size?], name }], colour: { index, name, raw } | null,
 * shape: { index, name, raw } | null }], legend: { field, byName }, colourMembers: [{ name, raw }], byName }.
 * Colour and Shape on the SAME field are one grouping (one legend: its members); on different fields a series is named
 * "colour member · shape member" and its legend is highlight-only (`legend.field` null). `byName` = legend name -> raw member.
 */
export function scatterGroups(sheet, result, seriesIdx, sizeIdx, fmtCat) {
  const { keyOrder } = planDims(sheet);
  const cf = (sheet.color ?? [])[0];
  const colourField = cf && colorMode(sheet) === "discrete" ? cf : null;
  const shapeField = marksOf(sheet).shape ?? null;
  const ci = colourField ? keyOrder.findIndex((f) => sameField(f, colourField)) : -1;
  const si = shapeField ? keyOrder.findIndex((f) => sameField(f, shapeField)) : -1;
  const xIdx = seriesIdx[0], yIdx = seriesIdx[1];
  const label = (k, i) => (k == null ? "—" : fmtCat(k, i));
  const colourMembers = new Map(), shapeMembers = new Map(), groupsMap = new Map();
  const member = (map, idx, r) => {
    const key = tupleKey([r.keys[idx]]);
    if (!map.has(key)) map.set(key, { index: map.size, name: label(r.keys[idx], idx), raw: r.keys[idx] });
    return map.get(key);
  };
  for (const r of result.rows) {
    const colour = ci >= 0 ? member(colourMembers, ci, r) : null;
    const shape = si >= 0 ? member(shapeMembers, si, r) : null;
    const gk = (colour ? colour.index : "") + "|" + (shape ? shape.index : "");
    if (!groupsMap.has(gk)) {
      const name = colour && shape && ci !== si ? `${colour.name} · ${shape.name}` : (colour ?? shape)?.name ?? "—";
      groupsMap.set(gk, { name, points: [], colour, shape });
    }
    const pt = [Number(r.values[xIdx]) || 0, Number(r.values[yIdx]) || 0];
    if (sizeIdx >= 0) pt.push(Number(r.values[sizeIdx]) || 0);
    const pointName = r.keys.map((k, i) => (i === ci || i === si ? null : label(k, i))).filter((v) => v != null).join(" / ");
    groupsMap.get(gk).points.push({ value: pt, name: pointName });
  }
  const groups = [...groupsMap.values()];
  const pairs = ci >= 0 && si >= 0 && ci !== si; // two fields: a legend of pairs can't select one member
  const legendField = pairs ? null : (ci >= 0 ? colourField : shapeField);
  const byName = pairs ? new Map() : new Map(groups.map((g) => [g.name, (g.colour ?? g.shape).raw]));
  return { groups, legend: { field: legendField, byName }, colourMembers: [...colourMembers.values()].map(({ name, raw }) => ({ name, raw })), byName };
}

/** Shape (scatter family) alone: scatterGroups with no Colour — one series per Shape member. */
export function scatterShapeGroups(sheet, result, seriesIdx, sizeIdx, fmtCat) {
  const g = scatterGroups({ ...sheet, color: [] }, result, seriesIdx, sizeIdx, fmtCat);
  return { groups: g.groups.map(({ name, points }) => ({ name, points })), byName: g.byName };
}

/**
 * Colour split: pivot the trailing group-by key into one series per colour value; the remaining keys form the
 * category axis. Missing (category x colour) cells are null so series stay aligned. One measure only.
 * Returns { categories, series: [{ name, data }], catTuples, colorVals, cellRows } — cellRows[series][category] is the
 * index of the result row behind that cell (null when the cell is empty).
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
  const cell = new Map(), rowAt = new Map();
  rows.forEach((r, ri) => { const ck = tupleKey(catOf(r.keys)) + "|" + tupleKey([r.keys[colorIdx]]); cell.set(ck, r.values[0]); rowAt.set(ck, ri); });
  const categories = catTuples.map((t) => (t.length ? t.map((k, i) => (k == null ? "—" : fmtCat(k, i))).join(" / ") : ""));
  const series = colorVals.map((cv) => ({
    name: cv == null ? "—" : fmtCat(cv, colorIdx),
    data: catTuples.map((t) => cell.get(tupleKey(t) + "|" + tupleKey([cv])) ?? null),
  }));
  const cellRows = colorVals.map((cv) => catTuples.map((t) => rowAt.get(tupleKey(t) + "|" + tupleKey([cv])) ?? null));
  return { categories, series, catTuples, colorVals, cellRows };
}

/** A Label field's per-result-row texts laid out per series cell: labels[series][category] ("" for an empty cell). */
export function colorSplitLabels(split, rowTexts) {
  return split.cellRows.map((rowsOfSeries) => rowsOfSeries.map((ri) => (ri == null ? "" : String(rowTexts[ri] ?? ""))));
}

/** Heatmap: two dimensions -> axes (dim 0 the Y axis, dim 1 the X axis), the first measure -> colour. */
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

/**
 * Treemap: one dimension -> flat leaves; two -> dimension 0 groups, dimension 1 nests under it (values summed). With a Size measure
 * (`ch.sizeIdx`) a tile's area is that measure and the shelf measure rides along as `shelf`; a colour measure (`ch.colourIdx`)
 * rides along as `colour`. A parent has no colour of its own. Without either, the plain { name, value } tiles.
 */
export function treemapTree(result, fmtCat, ch = {}) {
  const dimCount = result.rowDimensions.length + result.columnDimensions.length;
  const { sizeIdx = -1, colourIdx = -1 } = ch;
  const rows = result.rows;
  const leaf = (name, r) => {
    const base = { name, value: sizeIdx >= 0 ? r.values[sizeIdx] : r.values[0] };
    if (sizeIdx >= 0) { base.shelf = r.values[0]; base.size = r.values[sizeIdx]; }
    if (colourIdx >= 0) { base.colour = r.values[colourIdx]; if (sizeIdx < 0) base.shelf = r.values[0]; }
    return base;
  };
  if (dimCount === 1) return rows.map((r) => leaf(r.keys[0] == null ? "—" : fmtCat(r.keys[0], 0), r));
  const parents = new Map();
  for (const r of rows) {
    const pk = tupleKey([r.keys[0]]);
    if (!parents.has(pk)) parents.set(pk, { name: r.keys[0] == null ? "—" : fmtCat(r.keys[0], 0), value: 0, children: [] });
    const node = parents.get(pk);
    node.value += Number(sizeIdx >= 0 ? r.values[sizeIdx] : r.values[0]) || 0;
    node.children.push(leaf(r.keys[1] == null ? "—" : fmtCat(r.keys[1], 1), r));
  }
  return [...parents.values()];
}

/** Sankey: bipartite links, side-prefixed so a member on both sides stays two nodes; non-positive flows skipped. */
export function sankeyLinks(rows, label) {
  const links = [];
  for (const r of rows) {
    const v = Number(r.values[0]);
    if (Number.isFinite(v) && v > 0) links.push({ source: `s:${label(r.keys[0], 0)}`, target: `t:${label(r.keys[1], 1)}`, value: v });
  }
  return links;
}

/**
 * Small multiples: x categories = the second key in first-seen order; one panel per first-key member (result
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
