import { defaultFormat, parameters } from "../Core/store.js";
import { effectiveWindow } from "../Core/parameters-model.js";
import { makeValueFormatter, makeCategoryFormatter } from "../Core/format.js";
import { COLOR_SPLIT_TYPES, chartIssue, dimsFor, TEXT_VALUE_HINT, COLOR_SPLIT_HINT } from "./show-me-rules.js";
import { TEXT_VALUE_TYPES } from "./filter-rules.js";
import { marksOf, planDims, planMeasures, colorMode, isSizeDimension, SCATTER_TYPES } from "./sheet-plan.js";
import { sizeChannel, sizeRange } from "./mark-channel-model.js";
import { tupleKey } from "./grid-model.js";
import { sizeScaleOf, measureShares, sizeLegendText, textStepFor } from "./size-scale-model.js";
import { withOther, OTHER_TYPES } from "./scale-model.js";
import { pieSplit } from "./pie-split-model.js";
import { isGroupingPart, labelParts, partLabel } from "./date-parts.js";
import { mostRecentRaw, labelMarksOf } from "./label-marks-model.js";
import { applyTableCalcs, isCalc } from "./table-calc.js";
import { alignCompare } from "./period-model.js";
import { disposeChart, resolvedColourScale } from "./chart.js";
import { hint } from "./render-dom.js";
import { crosstabTable } from "./render-table.js";
import { kpiView } from "./render-kpi.js";
import { renderHeatmap, renderTreemap, renderP36 } from "./render-special.js";
import { renderColorSplit, renderScatterShapes, renderSeries } from "./render-cartesian.js";
import { P36_TYPES, sameField, aliasNames, pathOrderedRows } from "./result-model.js";
import { keyAliasMaps, withMemberLabels } from "./member-labels.js";

// Drawing a worksheet's result into a container: the one entry point every view uses, the editor's included.
// It prepares the result (Other mark, date-part labels, display names, table calculations), then dispatches to the family
// that draws it — table / text (render-table.js), KPI (render-kpi.js), colour split, scatter shapes and the series charts
// (render-cartesian.js), heatmap / treemap / (render-special.js). It touches only `container`, the arguments and the
// render options; nothing here reads the editor, so a view can draw a worksheet on its own.

/**
 * Render options (all optional) — the editor-only state of the old renderChart as explicit inputs:
 *   plan         the sheet-plan.js context (metaOf, calculations, ...): display names and measure labels; defaults to no aliases
 *   interactive  true (default) = the editor: select, drill, legend; "select" = marks select but nothing drills and the legend only
 *                highlights; false = a static widget: no mark selection, drill or legend handlers
 *   selected     the dashboard selection the source widget highlights ({ db, table, column, value }) — bar / stacked / pie / donut fade the rest
 *   hooks        { onSelect(dimField, raw), onDrill(raw), onLegend({ sheet, field, name, raw, bucketed }), legendFocus(),
 *                  onTooltipFields(sheet, list), onMemberColors(sheet, field, members), onMemberShapes(sheet, field, members), onCollapse(axis, key, validKeys), onCollapseAll(mode, rowKeys, colKeys), onColumn(key, { width? }) } — what the host does with them
 */

/**
 * Draw `result` for `sheet` into `container`. `cmp` = the comparison range's { result, range, name } or null.
 * result = { rowDimensions:[name…], columnDimensions:[name…], measures:[name…], rows:[{ keys:[rowVals…, colVals…], values:[…] }] }.
 * Returns { extraNotice } — a line the drawing wants in the notice (table calculations / analytics on partial rows,
 * the small-multiples panel cap) — or throws when the result can't be drawn (the view shows its own message).
 */
export function renderWorksheet(container, sheet, result, cmp, options = {}) {
  const rc = { container, plan: options.plan ?? { metaOf: () => ({}) }, interactive: options.interactive !== false && options.interactive !== "select",
    select: options.interactive !== false, selected: options.selected ?? null, hooks: options.hooks ?? {},
    bucketedKey: null, recentKey: null, pin: null, calcPercent: new Set(), extraNotice: null, emptyText: options.emptyText ?? "No data for these fields." };
  draw(container, rc, sheet, result, cmp);
  rc.hooks.onColourScale?.(sheet, resolvedColourScale(container)); // the editor's Format panel shows the controls of the scale Automatic resolved to
  return { extraNotice: rc.extraNotice };
}

/** Format → Label marks "Most recent": the latest date of the first group-by key, as the drawing will name it once date parts read as labels (null when not asked for, or no date). */
function recentKeyOf(sheet, result, parts) {
  if (labelMarksOf(sheet.format) !== "recent") return null;
  const raw = mostRecentRaw(result.rows.map((r) => (r.isOther ? null : r.keys[0])));
  return raw == null ? null : isGroupingPart(parts[0]) ? partLabel(parts[0], raw) : raw;
}

function draw(container, rc, sheet, result, cmp) {
  disposeChart(container); // a direct caller never leaks a previous instance or its ResizeObserver
  rc.pin = rc.hooks.takePin?.() ?? null; // the mark a click just selected, for the Responsive tooltip pin: used by this drawing only, never by a later one
  container.replaceChildren();
  rc.hooks.onTooltipFields?.(sheet, []);
  rc.hooks.onMemberColors?.(sheet, null, []);
  rc.hooks.onMemberShapes?.(sheet, null, []);
  // Date-grouped key: its labels are bucket starts, not values a filter could match — no click-to-filter.
  rc.bucketedKey = result.bucket ? result.bucket.key : null;
  // "Other": the server's aggregate of every group past the limit, drawn as one last mark.
  if (result.other && OTHER_TYPES.has(sheet.chartType)) result = { ...result, rows: withOther(result.rows, result.other) };
  // Date-part keys read as "Mar 2024" / "Q1" / "Mon"; like a date-grouped axis, they aren't click-filterable.
  const parts = planDims(sheet).keyOrder.map((f) => f?.datePart ?? null);
  rc.recentKey = recentKeyOf(sheet, result, parts); // before the keys read as labels
  result = labelParts(result, parts);
  if (cmp) cmp = { ...cmp, result: labelParts(cmp.result, parts) };
  if (isGroupingPart(parts[0])) rc.bucketedKey = 0;
  // Display names on axes, legends and headers (the query used the real columns).
  result = aliasNames(sheet, result, rc.plan.metaOf);
  // Quick table calculations replace their measure's values (over the rows on hand).
  const calcs = planMeasures(sheet).map((e) => (e.role === "shelf" ? (e.field.tableCalc?.windowParam ? { ...e.field.tableCalc, window: effectiveWindow(e.field.tableCalc, parameters) } : e.field.tableCalc ?? null) : null));
  const applied = applyTableCalcs(result, calcs, result.rowDimensions.length, result.columnDimensions.length);
  result = applied.result;
  rc.calcPercent = applied.percent;
  if (cmp) cmp = { ...cmp, result: applyTableCalcs(cmp.result, calcs, result.rowDimensions.length, result.columnDimensions.length).result };
  if (calcs.some(isCalc) && (result.truncated || result.partial))
    rc.extraNotice = "Table calculations use only the rows shown — more exist.";
  const { rowDimensions, columnDimensions, measures, rows } = result;
  if (!rows.length) { container.append(hint(rc.emptyText)); return; }
  // Formatters: measure values + date-like dimension labels, from the sheet's format config.
  let format = sheet.format ?? defaultFormat(); // let: a percent table calculation adds a "%" suffix
  const fmtVal = makeValueFormatter(format);
  // A member label replaces the text drawn for a member (key position i = planDims order); clicks, grouping and sorting keep the raw value.
  const fmtCat = withMemberLabels(makeCategoryFormatter(format), keyAliasMaps(planDims(sheet).keyOrder, rc.plan.metaOf));
  const type = sheet.chartType;
  // Min/Max of a text or date field comes back as text — only Table, Text and KPI can show that.
  if (!TEXT_VALUE_TYPES.has(type) && rows.some((r) => r.values.some((v) => typeof v === "string"))) {
    container.replaceChildren(hint(TEXT_VALUE_HINT));
    return;
  }
  // Table + Text mark both render as the crosstab text grid (values written into cells).
  if (type === "table" || type === "text") {
    const sized = tableSizing(sheet, result, fmtVal);
    if (sized.hint) container.append(hint(sized.hint));
    container.append(crosstabTable(sheet, sized.result, fmtVal, fmtCat, result.partial, rc.calcPercent, rc.interactive && rc.hooks.onCollapse ? { onToggle: rc.hooks.onCollapse, onToggleAll: rc.hooks.onCollapseAll } : null, rc.interactive && rc.hooks.onColumn ? { onSet: rc.hooks.onColumn } : null, sized.sizing));
    return;
  }

  // Marks: re-derive the measure roles so size / continuous-colour / aux columns don't turn into spurious series.
  // Shelf measures (only) become series; the rest feed the mark channels.
  const mplan = planMeasures(sheet);
  const seriesIdx = mplan.map((e, i) => (e.role === "shelf" ? i : -1)).filter((i) => i >= 0);
  const sizeIdx = mplan.findIndex((e) => e.role === "size");
  const colorMeasureIdx = mplan.findIndex((e) => e.role === "color");
  const shelfCount = seriesIdx.length;

  // Discrete Colour: a categorical Colour dimension pivots the trailing group-by key into one series per distinct
  // value (bar -> grouped, stacked -> stacked, line/area -> one per value).
  const colourKeys = planDims(sheet).colourDims.length; // the Colour fields that are group-by keys: the last keys of every row
  if (colourKeys > 0 && COLOR_SPLIT_TYPES.has(type)) {
    if (shelfCount !== 1) { container.append(hint(COLOR_SPLIT_HINT)); return; }
    renderColorSplit(container, rc, sheet, type, result, format, fmtCat, sizeIdx, colourKeys);
    return;
  }

  // An unsupported field mapping shows a hint, never an error.
  const issue = chartIssue(type, dimsFor(type, rowDimensions.length + columnDimensions.length, colourKeys), shelfCount); // a Gantt's, Pie's and Donut's Colour keys are not rows
  if (issue) { container.append(hint(issue)); return; }

  // Shape: on the scatter family, split points by a Shape dimension into one symbol per value.
  // A Colour dimension (a group-by on these types) splits the points the same way.
  if (SCATTER_TYPES.has(type) && (marksOf(sheet).shape || colourKeys > 0 || colorMode(sheet) === "discrete")) { renderScatterShapes(container, rc, sheet, result, seriesIdx, sizeIdx, colorMeasureIdx, format, fmtCat); return; }

  // Path: a line/area orders its vertices by the Path field's value (not the category order).
  const usePath = type === "line" || type === "area";
  const split = (type === "pie" || type === "donut") && colourKeys > 0 ? pieSplit(rows, colourKeys, fmtCat) : null; // a Colour field splits each slice into sub-slices, grouped by slice
  const rowsOrdered = split ? split.rows : usePath ? (pathOrderedRows(sheet, result, mplan) ?? rows) : rows;

  // Flatten both dimension axes onto the category axis; one series per SHELF measure.
  const dimCount = rowDimensions.length + columnDimensions.length;
  const categories = split ? split.categories : rowsOrdered.map((r) => r.keys.map((k, i) => (k == null ? "—" : fmtCat(k, i))).join(" / "));
  const series = seriesIdx.map((mi) => ({ name: measures[mi], data: rowsOrdered.map((r) => r.values[mi]) }));
  const seriesNames = seriesIdx.map((mi) => measures[mi]);
  // A chart whose measures are all percentage calculations reads its values with "%".
  if (seriesIdx.length && seriesIdx.every((mi) => rc.calcPercent.has(mi))) format = { ...format, suffix: "%" };
  // The comparison range's values, lined up with these rows — by position when the first key is the range's own date
  // field (day 1 with day 1), else by the same group keys.
  const byPosition = Boolean(sheet.period) && sameField(planDims(sheet).keyOrder[0] ?? {}, sheet.period);
  const aligned = cmp ? alignCompare(rowsOrdered, cmp.result.rows, byPosition) : null;

  // Heatmap / treemap reuse this multi-dimension result but pivot it differently.
  if (type === "heatmap") { renderHeatmap(container, result, format, fmtCat); return; }
  if (type === "treemap") {
    const f = marksOf(sheet).size;
    const c = f && isSizeDimension(f) ? sizeChannel(type, shelfCount, true) : null; // a treemap's area is a measure
    if (c && !c.ok) container.append(hint(c.note));
    renderTreemap(container, result, format, fmtCat, { sizeIdx, colourIdx: colorMeasureIdx }); return;
  }
  if (P36_TYPES.has(type)) { renderP36(container, rc, type, rowsOrdered, categories, series, seriesNames, format, fmtCat, sheet); return; }

  // KPI: explicit type, or a plain series chart with no dimensions (one value per measure).
  if (type === "kpi" || (dimCount === 0 && (type === "bar" || type === "stacked" || type === "line" || type === "area"))) {
    const prev = cmp && dimCount === 0 ? seriesIdx.map((mi) => cmp.result.rows[0]?.values[mi] ?? null) : null;
    container.append(kpiView(seriesNames, categories, series, dimCount, fmtVal, { prev, name: cmp?.name, format }));
    return;
  }
  renderSeries(container, rc, sheet, { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan, format, fmtVal, fmtCat, aligned, cmp, split });
}

/**
 * A Table / Text with a Size measure: the Size column leaves the result (it is not a cell value) and each cell of a row-by-column pair gets one of
 * three text steps (the type scale's body, lead and title sizes) by the measure's share, shaped by Format → Edit Sizes. -> { result, sizing?, hint? }
 * `sizing` = { stepAt(rowTuple, colTuple) -> 0..2, note } for the crosstab; a Size dimension is a hint (member steps have no text meaning).
 */
function tableSizing(sheet, result, fmtVal) {
  const f = marksOf(sheet).size;
  if (!f) return { result };
  if (isSizeDimension(f)) return { result, hint: sizeChannel(sheet.chartType, 1, true).note };
  const si = planMeasures(sheet).findIndex((e) => e.role === "size");
  if (si < 0 || si >= result.measures.length) return { result };
  const rd = result.rowDimensions.length, cd = result.columnDimensions.length;
  const scale = sizeScaleOf(sheet.format);
  const shares = measureShares(result.rows.map((r) => r.values[si]), { zero: scale.fromZero ?? false, scale });
  const steps = new Map(result.rows.map((r, i) => [tupleKey(r.keys.slice(0, rd)) + "|" + tupleKey(r.keys.slice(rd, rd + cd)), textStepFor(shares[i])]));
  const drop = (a) => a.filter((_, i) => i !== si);
  const range = sizeRange(result.rows.map((r) => r.values[si]));
  const note = range ? sizeLegendText(result.measures[si], { range, reversed: scale.reversed, fmtVal }).replace(/\)$/, "), three text sizes") : null;
  return { result: { ...result, measures: drop(result.measures), rows: result.rows.map((r) => ({ ...r, values: drop(r.values) })) },
    sizing: { stepAt: (rt, ct) => steps.get(tupleKey(rt) + "|" + tupleKey(ct)) ?? 0, note } };
}
