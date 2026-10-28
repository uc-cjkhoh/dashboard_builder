import { renderChart as drawChart } from "./chart.js";
import { isCalcPill } from "../Calc/calc-pill.js";
import { SCATTER_TYPES, marksOf, measureName as planMeasureName } from "./sheet-plan.js";
import { REF_CHOICES, TREND_CHOICES, refValue, trendSeries } from "./analytics-model.js";
import { hint } from "./render-dom.js";
import { selectHandler, legendSpec, memberSpec } from "./render-handlers.js";
import { selectedIndicesOf } from "./dashboard-select.js";
import { joinNotices } from "./notices.js";
import { ANALYTICS_TYPES, scatterSymbol, primaryDim, chartOrientation, marksChannels, scatterShapeGroups, colorSplitData } from "./result-model.js";

// The series charts: bar / stacked / line / area / combo, pie / donut, the scatter family (with Shape), and the colour
// split. Each draws into `container` through chart.js and wires interaction only through the render context `rc`
// (render-handlers.js), so a non-interactive view draws the same marks without handlers.

/** P7 colour split: one series per colour value (the trailing group-by key); the primary dimension is the first non-colour key. */
export function renderColorSplit(container, rc, sheet, type, result, format, fmtCat) {
  const { categories, series, catTuples, colorVals } = colorSplitData(result, fmtCat);
  // P15: click a mark -> the primary (first non-colour) dimension value = catTuples[dataIndex][0].
  const rawKeys = catTuples.map((t) => t[0]);
  const onSelect = selectHandler(rc, sheet, primaryDim(sheet), type, rawKeys);
  const selectedIndices = selectedIndicesOf(rawKeys, rc.selected, primaryDim(sheet));
  const orientation = chartOrientation(sheet);
  // P29: each legend item is a Colour member — clicking it highlights that series and selects the member.
  const byName = new Map(series.map((sr, i) => [sr.name, colorVals[i]]));
  const legend = legendSpec(rc, sheet, sheet.color?.[0], byName);
  const cf = sheet.color?.[0];
  const memberColourSpec = cf && !isCalcPill(cf) ? memberSpec(rc, sheet, cf, series.map((sr, i) => ({ name: sr.name, raw: colorVals[i] }))) : {};
  drawChart(container, { type, categories, series, format, onSelect, selectedIndices, orientation, ...memberColourSpec, ...legend });
}

/** P19 Shape (scatter family): one scatter series per Shape member, each a distinct symbol (identity survives greyscale). */
export function renderScatterShapes(container, rc, sheet, result, seriesIdx, sizeIdx, format, fmtCat) {
  if (seriesIdx.length < 2) { container.append(hint("A shape scatter plots two measures (X and Y) — add a second measure.")); return; }
  const xIdx = seriesIdx[0], yIdx = seriesIdx[1];
  const { groups, byName } = scatterShapeGroups(sheet, result, seriesIdx, sizeIdx, fmtCat);
  drawChart(container, {
    ...legendSpec(rc, sheet, marksOf(sheet).shape, byName), // P29: legend items are Shape members
    type: "scatterShapes", groups, format,
    xName: format.xTitle || result.measures[xIdx] || "x",
    yName: format.yTitle || result.measures[yIdx] || "y",
    hasSize: sizeIdx >= 0, sizeName: sizeIdx >= 0 ? result.measures[sizeIdx] : null,
  });
}

/**
 * The general series chart. `a` = { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan,
 * format, fmtVal, fmtCat, aligned (the comparison range's rows lined up, or null), cmp }. P21 analytics, P18 mark channels,
 * the P35 comparison series and T01-20 member colours all feed one chart.js spec.
 */
export function renderSeries(container, rc, sheet, a) {
  const { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan, format, fmtVal, fmtCat, aligned, cmp } = a;
  const type = sheet.chartType;
  const measures = result.measures;
  // P18 mark channels: Size (bubble), continuous Colour (gradient), field-driven Label + custom Tooltip. All read
  // columns already in `result`; missing / unsupported mappings degrade to a note.
  const marks = marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered, SCATTER_TYPES, (f) => planMeasureName(f, rc.plan));
  rc.hooks.onTooltipFields?.(sheet, marks.tooltipCat);
  if (marks.note) container.append(hint(marks.note)); // a Marks hint sits above the chart, never blocks it
  // P15 click-to-filter: marks map 1:1 to result rows here, so a click's dataIndex -> rowsOrdered[i].keys[0] (the primary
  // dimension's raw value).
  const rawKeys = rowsOrdered.map((r) => (r.isOther ? null : r.keys[0]));
  const onSelect = selectHandler(rc, sheet, primaryDim(sheet), type, rawKeys);
  const selectedIndices = selectedIndicesOf(rawKeys, rc.selected, primaryDim(sheet));
  const otherIndex = rowsOrdered.findIndex((r) => r.isOther);
  // P29: on a pie / donut the legend lists the primary dimension's members; elsewhere it names measures (highlight only —
  // a measure isn't a member to keep or exclude).
  const legend = (type === "pie" || type === "donut")
    ? legendSpec(rc, sheet, primaryDim(sheet), new Map(rowsOrdered.map((r, i) => [categories[i], r.isOther ? undefined : r.keys[0]])))
    : legendSpec(rc, sheet, null, new Map());
  const compareSeries = aligned && (type === "bar" || type === "line" || type === "area")
    ? seriesIdx.map((mi) => ({ name: `${measures[mi]} (${cmp.name})`, data: aligned.map((r) => (r ? r.values[mi] : null)), compare: true }))
    : [];
  // P21 analytics on the first measure: reference line, band, trend (+ forecast categories appended).
  let catsOut = categories, seriesOut = [...series, ...compareSeries], analytics = null;
  const A = sheet.analytics;
  if (A && ANALYTICS_TYPES.has(type) && series.length) {
    const vals = series[0].data;
    const refKind = A.ref?.kind ?? "none";
    const rv = refKind === "none" ? null : refValue(refKind, vals, A.ref.value);
    const fc = type === "line" || type === "area" ? A.forecast ?? 0 : 0;
    const t = (A.trend && A.trend !== "none") || fc ? trendSeries(A.trend ?? "none", vals, fc) : null;
    const trendLabel = TREND_CHOICES.find(([v]) => v === (A.trend && A.trend !== "none" ? A.trend : "linear"))[1].toLowerCase();
    analytics = {
      ref: rv == null ? null : { name: refKind === "constant" ? "Reference" : REF_CHOICES.find(([v]) => v === refKind)[1], value: rv },
      band: A.band ? { from: A.band.from, to: A.band.to } : null,
      trend: t ? { name: `Trend (${trendLabel}${fc ? ` + ${fc} forecast` : ""}) R² ${t.r2.toFixed(2)}`, short: `Trend · R² ${t.r2.toFixed(2)}`, data: t.data } : null,
    };
    if (t && t.extra) {
      catsOut = [...categories, ...Array.from({ length: t.extra }, (_, i) => `Forecast +${i + 1}`)];
      seriesOut = seriesOut.map((sr) => ({ ...sr, data: [...sr.data, ...new Array(t.extra).fill(null)] }));
    }
    if ((t || rv != null) && (result.truncated || result.partial)) rc.extraNotice = joinNotices(rc.extraNotice, "Analytics use only the rows shown — more exist.");
  }
  // T01-20: members coloured by a field — pie / donut slices and a single-measure bar coloured by category.
  const byMember = (type === "pie" || type === "donut" || (type === "bar" && format.colorByDimension && series.length === 1 && !compareSeries.length)) && primaryDim(sheet) && !isCalcPill(primaryDim(sheet));
  const memberColourSpec = byMember
    ? memberSpec(rc, sheet, primaryDim(sheet), rowsOrdered.map((r, i) => ({ name: categories[i], raw: r.keys[0], other: r.isOther })).filter((m) => !m.other))
    : {};
  drawChart(container, { type, symbol: SCATTER_TYPES.has(type) ? scatterSymbol(type) : undefined, categories: catsOut, series: seriesOut, format, onSelect, selectedIndices, orientation: chartOrientation(sheet), otherIndex, analytics, ...memberColourSpec, ...legend, ...marks.spec });
}
