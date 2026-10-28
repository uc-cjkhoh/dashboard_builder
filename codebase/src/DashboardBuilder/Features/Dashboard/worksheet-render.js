import { defaultFormat } from "../Core/store.js";
import { makeValueFormatter, makeCategoryFormatter } from "../Core/format.js";
import { COLOR_SPLIT_TYPES, chartIssue, TEXT_VALUE_HINT, COLOR_SPLIT_HINT } from "./show-me-rules.js";
import { TEXT_VALUE_TYPES } from "./filter-rules.js";
import { marksOf, planDims, planMeasures, colorMode, SCATTER_TYPES } from "./sheet-plan.js";
import { withOther, OTHER_TYPES } from "./scale-model.js";
import { isGroupingPart, labelParts } from "./date-parts.js";
import { applyTableCalcs, isCalc } from "./table-calc.js";
import { alignCompare } from "./period-model.js";
import { disposeChart } from "./chart.js";
import { hint } from "./render-dom.js";
import { crosstabTable } from "./render-table.js";
import { kpiView } from "./render-kpi.js";
import { renderHeatmap, renderTreemap, renderP36 } from "./render-special.js";
import { renderColorSplit, renderScatterShapes, renderSeries } from "./render-cartesian.js";
import { P36_TYPES, sameField, aliasNames, pathOrderedRows } from "./result-model.js";
import { keyAliasMaps, withMemberLabels } from "./member-labels.js";

// Drawing a worksheet's result into a container (P24a): the one entry point every view uses, the editor's included.
// It prepares the result (Other mark, date-part labels, display names, table calculations), then dispatches to the family
// that draws it — table / text (render-table.js), KPI (render-kpi.js), colour split, scatter shapes and the series charts
// (render-cartesian.js), heatmap / treemap / P36 (render-special.js). It touches only `container`, the arguments and the
// render options; nothing here reads the editor, so a view can draw a worksheet on its own.

/**
 * Render options (all optional) — the editor-only state of the old renderChart as explicit inputs:
 *   plan         the sheet-plan.js context (metaOf, calculations, ...): display names and measure labels; defaults to no aliases
 *   interactive  true (default) = the editor: select, drill, legend; "select" = marks select but nothing drills and the legend only
 *                highlights; false = a static widget: no mark selection, drill or legend handlers
 *   selected     the dashboard selection the source widget highlights ({ db, table, column, value }) — bar / stacked / pie / donut fade the rest
 *   hooks        { onSelect(dimField, raw), onDrill(raw), onLegend({ sheet, field, name, raw, bucketed }), legendFocus(),
 *                  onTooltipFields(sheet, list), onMemberColors(sheet, field, members) } — what the host does with them
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
    bucketedKey: null, calcPercent: new Set(), extraNotice: null };
  draw(container, rc, sheet, result, cmp);
  return { extraNotice: rc.extraNotice };
}

function draw(container, rc, sheet, result, cmp) {
  disposeChart(container); // a direct caller never leaks a previous instance or its ResizeObserver
  container.replaceChildren();
  rc.hooks.onTooltipFields?.(sheet, []);
  rc.hooks.onMemberColors?.(sheet, null, []);
  // Date-grouped key: its labels are bucket starts, not values a filter could match — no click-to-filter.
  rc.bucketedKey = result.bucket ? result.bucket.key : null;
  // "Other": the server's aggregate of every group past the limit, drawn as one last mark.
  if (result.other && OTHER_TYPES.has(sheet.chartType)) result = { ...result, rows: withOther(result.rows, result.other) };
  // P26: date-part keys read as "Mar 2024" / "Q1" / "Mon"; like a date-grouped axis, they aren't click-filterable.
  const parts = planDims(sheet).keyOrder.map((f) => f?.datePart ?? null);
  result = labelParts(result, parts);
  if (cmp) cmp = { ...cmp, result: labelParts(cmp.result, parts) };
  if (isGroupingPart(parts[0])) rc.bucketedKey = 0;
  // P28: display names on axes, legends and headers (the query used the real columns).
  result = aliasNames(sheet, result, rc.plan.metaOf);
  // P27: quick table calculations replace their measure's values (over the rows on hand).
  const calcs = planMeasures(sheet).map((e) => (e.role === "shelf" ? e.field.tableCalc ?? null : null));
  const applied = applyTableCalcs(result, calcs, result.rowDimensions.length, result.columnDimensions.length);
  result = applied.result;
  rc.calcPercent = applied.percent;
  if (cmp) cmp = { ...cmp, result: applyTableCalcs(cmp.result, calcs, result.rowDimensions.length, result.columnDimensions.length).result };
  if (calcs.some(isCalc) && (result.truncated || result.partial))
    rc.extraNotice = "Table calculations use only the rows shown — more exist.";
  const { rowDimensions, columnDimensions, measures, rows } = result;
  if (!rows.length) { container.append(hint("No data for these fields.")); return; }
  // P10 formatters: measure values + date-like dimension labels, from the sheet's format config.
  let format = sheet.format ?? defaultFormat(); // let: a percent table calculation adds a "%" suffix
  const fmtVal = makeValueFormatter(format);
  // T02-29: a member label replaces the text drawn for a member (key position i = planDims order); clicks, grouping and sorting keep the raw value.
  const fmtCat = withMemberLabels(makeCategoryFormatter(format), keyAliasMaps(planDims(sheet).keyOrder, rc.plan.metaOf));
  const type = sheet.chartType;
  // Min/Max of a text or date field comes back as text — only Table, Text and KPI can show that.
  if (!TEXT_VALUE_TYPES.has(type) && rows.some((r) => r.values.some((v) => typeof v === "string"))) {
    container.replaceChildren(hint(TEXT_VALUE_HINT));
    return;
  }
  // Table + P19 Text mark both render as the crosstab text grid (values written into cells).
  if (type === "table" || type === "text") { container.append(crosstabTable(sheet, result, fmtVal, fmtCat, result.partial, rc.calcPercent)); return; }

  // P18 marks: re-derive the measure roles so size / continuous-colour / aux columns don't turn into spurious series.
  // Shelf measures (only) become series; the rest feed the mark channels.
  const mplan = planMeasures(sheet);
  const seriesIdx = mplan.map((e, i) => (e.role === "shelf" ? i : -1)).filter((i) => i >= 0);
  const sizeIdx = mplan.findIndex((e) => e.role === "size");
  const colorMeasureIdx = mplan.findIndex((e) => e.role === "color");
  const shelfCount = seriesIdx.length;

  // Discrete Colour (P7): a categorical Colour dimension pivots the trailing group-by key into one series per distinct
  // value (bar -> grouped, stacked -> stacked, line/area -> one per value).
  if (colorMode(sheet) === "discrete" && COLOR_SPLIT_TYPES.has(type)) {
    if (shelfCount !== 1) { container.append(hint(COLOR_SPLIT_HINT)); return; }
    renderColorSplit(container, rc, sheet, type, result, format, fmtCat);
    return;
  }

  // P11: an unsupported field mapping shows a hint, never an error.
  const issue = chartIssue(type, rowDimensions.length + columnDimensions.length, shelfCount);
  if (issue) { container.append(hint(issue)); return; }

  // P19 Shape: on the scatter family, split points by a Shape dimension into one symbol per value.
  if (SCATTER_TYPES.has(type) && marksOf(sheet).shape) { renderScatterShapes(container, rc, sheet, result, seriesIdx, sizeIdx, format, fmtCat); return; }

  // P19 Path: a line/area orders its vertices by the Path field's value (not the category order).
  const usePath = type === "line" || type === "area";
  const rowsOrdered = usePath ? (pathOrderedRows(sheet, result, mplan) ?? rows) : rows;

  // Flatten both dimension axes onto the category axis; one series per SHELF measure (P7 layout).
  const dimCount = rowDimensions.length + columnDimensions.length;
  const categories = rowsOrdered.map((r) => r.keys.map((k, i) => (k == null ? "—" : fmtCat(k, i))).join(" / "));
  const series = seriesIdx.map((mi) => ({ name: measures[mi], data: rowsOrdered.map((r) => r.values[mi]) }));
  const seriesNames = seriesIdx.map((mi) => measures[mi]);
  // P27: a chart whose measures are all percentage calculations reads its values with "%".
  if (seriesIdx.length && seriesIdx.every((mi) => rc.calcPercent.has(mi))) format = { ...format, suffix: "%" };
  // P35: the comparison range's values, lined up with these rows — by position when the first key is the range's own date
  // field (day 1 with day 1), else by the same group keys.
  const byPosition = Boolean(sheet.period) && sameField(planDims(sheet).keyOrder[0] ?? {}, sheet.period);
  const aligned = cmp ? alignCompare(rowsOrdered, cmp.result.rows, byPosition) : null;

  // P12 heatmap / treemap reuse this multi-dimension result but pivot it differently.
  if (type === "heatmap") { renderHeatmap(container, result, format, fmtCat); return; }
  if (type === "treemap") { renderTreemap(container, result, format, fmtCat); return; }
  if (P36_TYPES.has(type)) { renderP36(container, rc, type, rowsOrdered, categories, series, seriesNames, format, fmtCat); return; }

  // KPI: explicit type, or a plain series chart with no dimensions (one value per measure).
  if (type === "kpi" || (dimCount === 0 && (type === "bar" || type === "stacked" || type === "line" || type === "area"))) {
    const prev = cmp && dimCount === 0 ? seriesIdx.map((mi) => cmp.result.rows[0]?.values[mi] ?? null) : null;
    container.append(kpiView(seriesNames, categories, series, dimCount, fmtVal, { prev, name: cmp?.name, format }));
    return;
  }
  renderSeries(container, rc, sheet, { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan, format, fmtVal, fmtCat, aligned, cmp });
}
