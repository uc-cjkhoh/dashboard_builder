import { renderChart as drawChart } from "./chart.js";
import { dateLabelsOf } from "./date-labels.js";
import { isCalcPill } from "../Calc/calc-pill.js";
import { SCATTER_TYPES, marksOf, planMeasures, colorMode, colourDimsOf, isSizeDimension, isShapeDimension, measureName as planMeasureName } from "./sheet-plan.js";
import { shapeBinsOf } from "./shape-model.js";
import { labelContext, labelMarksOf, effectiveLabelMode, LABEL_MARK_HINT } from "./label-marks-model.js";
import { memberColourField } from "./colour-fields-model.js";
import { makeValueFormatter } from "../Core/format.js";
import { REF_CHOICES, TREND_CHOICES, trendProblem, trendRefusal, pWords, refValue, refConstant, trendSeries, pickMeasure, dataValues, bandBounds, bandLabel } from "./analytics-model.js";
import { parameters } from "../Core/store.js";
import { effectiveForecast } from "../Core/parameters-model.js";
import { hint } from "./render-dom.js";
import { fitWords } from "./chart-polish.js";
import { selectHandler, legendSpec, memberSpec, memberShapeSpec } from "./render-handlers.js";
import { selectedIndicesOf } from "./dashboard-select.js";
import { joinNotices } from "./notices.js";
import { stackedScaleNotice } from "./stack-scale-model.js";
import { shapeColourNote, splitSizeNote, sizeChannel, lineSizeNote } from "./mark-channel-model.js";
import { ANALYTICS_TYPES, scatterSymbol, primaryDim, chartOrientation, marksChannels, scatterGroups, colorSplitData, colorSplitLabels, markFieldValues, sizeSteps, sizeGridOf } from "./result-model.js";

// The series charts: bar / stacked / line / area / combo, pie / donut, the scatter family (with Shape), and the colour
// split. Each draws into `container` through chart.js and wires interaction only through the render context `rc`
// (render-handlers.js), so a non-interactive view draws the same marks without handlers.

/**
 * Format → Label marks as the spec chart.js reads: { spec: { labelMarks: { mode, selected, recent } } | {}, note }. `rawKeys` = each mark's primary-dimension value;
 * Selected reads the dashboard's selection (a source widget) or else the worksheet's own click selection; Most recent the latest date the worksheet found
 * before its keys became labels (`rc.recentKey`). A stored mode this chart does not offer labels every mark and says so; a mode with nothing to show says why.
 */
export function labelMarksSpec(rc, sheet, format, rawKeys) {
  const ctx = labelContext(sheet);
  const stored = labelMarksOf(format);
  if (!ctx.drawn || stored === "all") return { spec: {}, note: null };
  const mode = effectiveLabelMode(stored, ctx);
  if (mode === "all") return { spec: {}, note: LABEL_MARK_HINT(stored) };
  const selected = mode === "selected" ? selectedIndicesOf(rawKeys, rc.selected ?? sheet.selection ?? null, primaryDim(sheet)) : [];
  const recent = mode === "recent" && rc.recentKey != null ? rawKeys.flatMap((k, i) => (k != null && String(k) === String(rc.recentKey) ? [i] : [])) : [];
  const note = mode === "selected" && !selected.length ? "Labels are set to Selected and no mark in view is selected — click a mark to show its label."
    : mode === "recent" && !recent.length ? "Labels are set to Most recent, but no date was found on the view." : null;
  return { spec: { labelMarks: { mode, selected, recent } }, note };
}

/** Colour split: one series per colour value (the trailing group-by key); the primary dimension is the first non-colour key. */
export function renderColorSplit(container, rc, sheet, type, result, format, fmtCat, sizeIdx = -1, colourKeys = 1) {
  const sizeNote = splitSizeNote(Boolean(marksOf(sheet).size), type); // a Stacked split can't draw Size: say so
  if (sizeNote) container.append(hint(sizeNote));
  const { categories, series, catTuples, memberRaws, cellRows } = colorSplitData(result, fmtCat, colourKeys);
  // Size beside the split: one value per (member series, category) cell — a measure's value, or a dimension's step.
  const sizeSpec = {};
  const sizeField = marksOf(sheet).size;
  if (sizeField && !sizeNote && sizeChannel(type, 1, isSizeDimension(sizeField)).ok) {
    const steps = isSizeDimension(sizeField) ? sizeSteps(sheet, result, result.rows, fmtCat) : null;
    if (steps) Object.assign(sizeSpec, { sizeGrid: sizeGridOf({ cellRows }, steps.ranks), sizeMembersGrid: sizeGridOf({ cellRows }, steps.members), sizeOrder: steps.order, sizeName: steps.name });
    else if (sizeIdx >= 0) Object.assign(sizeSpec, { sizeGrid: sizeGridOf({ cellRows }, result.rows.map((r) => (r.isOther ? null : r.values[sizeIdx]))), sizeName: result.measures[sizeIdx] });
  }
  const lineNote = sizeSpec.sizeGrid ? lineSizeNote(type, format.lineStyle, series.length * categories.length) : null;
  if (lineNote) container.append(hint(lineNote));
  // Click a mark -> the primary (first non-colour) dimension value = catTuples[dataIndex][0].
  const rawKeys = catTuples.map((t) => t[0]);
  const onSelect = selectHandler(rc, sheet, primaryDim(sheet), type, rawKeys);
  const selectedIndices = selectedIndicesOf(rawKeys, rc.selected, primaryDim(sheet));
  const orientation = chartOrientation(sheet);
  // Each legend item is a Colour member — clicking it highlights that series and selects the member.
  // With several Colour fields a member is a combination: the legend highlights it (no one field to select by) and its colour is keyed by the fields in order.
  const fields = colourDimsOf(sheet);
  const cf = memberColourField(fields);
  const byName = new Map(series.map((sr, i) => [sr.name, memberRaws[i]]));
  const legend = legendSpec(rc, sheet, fields.length === 1 ? fields[0] : null, fields.length === 1 ? byName : new Map());
  const memberColourSpec = cf ? memberSpec(rc, sheet, cf, series.map((sr, i) => ({ name: sr.name, raw: memberRaws[i] }))) : {};
  // Label: the Label field's value per (category, colour) cell — the split's series are not the result's rows, so map them.
  const labelField = marksOf(sheet).label;
  const texts = labelField ? markFieldValues(sheet, result.rows, planMeasures(sheet), labelField, makeValueFormatter(format), fmtCat, (f) => planMeasureName(f, rc.plan)) : null;
  const seriesLabels = texts ? colorSplitLabels({ cellRows }, texts.values) : undefined;
  const lm = labelMarksSpec(rc, sheet, format, rawKeys);
  if (lm.note) container.append(hint(lm.note));
  drawChart(container, { type, categories, series, format, onSelect, selectedIndices, orientation, seriesLabels, ...sizeSpec, ...memberColourSpec, ...legend, ...lm.spec });
}

/**
 * The scatter family with a Colour dimension and / or a Shape dimension: one scatter series per Colour member, Shape member or
 * pair. A Colour member wears its palette colour (or its Format → member colour) and a Shape member its own symbol (identity
 * survives greyscale); the legend names the members (one legend when both are the same field, pairs otherwise).
 */
export function renderScatterShapes(container, rc, sheet, result, seriesIdx, sizeIdx, colorMeasureIdx, format, fmtCat) {
  if (seriesIdx.length < 2) { container.append(hint("A point chart plots two measures (X and Y) — add a second measure.")); return; }
  const note = shapeColourNote(colorMeasureIdx); // only one Colour slot: reached with Shape + a measure on Colour
  if (note) container.append(hint(note));
  const xIdx = seriesIdx[0], yIdx = seriesIdx[1];
  const fmtVal = makeValueFormatter(format);
  const shapeIdx = planMeasures(sheet).findIndex((e) => e.role === "shape"); // a measure on Shape: its values are binned into symbols
  const { groups, legend, colourMembers, shapeMembers, sizeOrder, sizeName } = scatterGroups(sheet, result, seriesIdx, sizeIdx, fmtCat, { shapeIdx, bins: shapeBinsOf(format), fmtVal });
  const cf = memberColourField(colourDimsOf(sheet));
  const memberColourSpec = cf ? memberSpec(rc, sheet, cf, colourMembers) : {};
  // Labels: one per mark, the series being the members. Each point knows its result row, which is how the Label field's text and the Selected / Most recent
  // marks (named by the primary dimension's value on that row) reach it; a chart with no primary dimension has nothing a selection could name.
  const rawKeys = primaryDim(sheet) ? result.rows.map((r) => (r.isOther ? null : r.keys[0])) : result.rows.map(() => null);
  const lm = labelMarksSpec(rc, sheet, format, rawKeys);
  if (lm.note) container.append(hint(lm.note));
  const labelField = marksOf(sheet).label;
  const texts = labelField ? markFieldValues(sheet, result.rows, planMeasures(sheet), labelField, fmtVal, fmtCat, (f) => planMeasureName(f, rc.plan)) : null;
  const pick = selectHandler(rc, sheet, primaryDim(sheet), sheet.chartType, rawKeys); // a click on a mark selects its primary-dimension value, as on any other point chart
  const shapeField = marksOf(sheet).shape;
  const memberShapesSpec = isShapeDimension(shapeField) && !isCalcPill(shapeField) ? memberShapeSpec(rc, sheet, shapeField, shapeMembers) : {}; // a binned measure has no members to choose for
  drawChart(container, {
    ...legendSpec(rc, sheet, legend.field, legend.byName), // legend items are Colour / Shape members
    ...memberColourSpec, ...memberShapesSpec, ...lm.spec,
    ...(texts ? { rowLabels: texts.values } : {}), ...(pick ? { onSelect: (p) => pick({ dataIndex: p.data?.row }) } : {}),
    type: "scatterShapes", symbol: scatterSymbol(sheet.chartType), groups, format,
    xName: format.xTitle || result.measures[xIdx] || "x",
    yName: format.yTitle || result.measures[yIdx] || "y",
    hasSize: sizeIdx >= 0 || Boolean(sizeOrder), sizeName: sizeOrder ? sizeName : sizeIdx >= 0 ? result.measures[sizeIdx] : null, sizeOrder,
    shapeName: shapeIdx >= 0 ? result.measures[shapeIdx] : null,
  });
}

/**
 * The general series chart. `a` = { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan,
 * format, fmtVal, fmtCat, aligned (the comparison range's rows lined up, or null), cmp }. analytics, mark channels,
 * the comparison series and member colours all feed one chart.js spec.
 */
export function renderSeries(container, rc, sheet, a) {
  const { result, rowsOrdered, categories, series, seriesIdx, sizeIdx, colorMeasureIdx, mplan, format, fmtVal, fmtCat, aligned, cmp, split } = a;
  const type = sheet.chartType;
  const measures = result.measures;
  // Mark channels: Size (bubble), continuous Colour (gradient), field-driven Label + custom Tooltip. All read
  // columns already in `result`; missing / unsupported mappings degrade to a note.
  const marks = marksChannels(sheet, result, mplan, sizeIdx, colorMeasureIdx, fmtVal, fmtCat, rowsOrdered, SCATTER_TYPES, (f) => planMeasureName(f, rc.plan));
  const compareSeries = aligned && (type === "bar" || type === "line" || type === "area")
    ? seriesIdx.map((mi) => ({ name: `${measures[mi]} (${cmp.name})`, data: aligned.map((r) => (r ? r.values[mi] : null)), compare: true }))
    : [];
  if (compareSeries.length && type === "bar" && marks.spec.sizes) { // the comparison bars are plain bars beside each main bar: varying thickness would not line up
    delete marks.spec.sizes; delete marks.spec.sizeName;
    marks.note = [marks.note, "Size is not drawn beside a comparison period — remove the comparison to vary bar thickness."].filter(Boolean).join(" ");
  }
  rc.hooks.onTooltipFields?.(sheet, marks.tooltipCat);
  if (type === "stacked") rc.extraNotice = joinNotices(rc.extraNotice, stackedScaleNotice(series)); // a measure far smaller than the rest is a sliver: say so
  const lineNote = marks.spec.sizes ? lineSizeNote(type, format.lineStyle, series.length * categories.length) : null; // a stepped or very long line varies its markers: say so
  if (lineNote) marks.note = [marks.note, lineNote].filter(Boolean).join(" ");
  const rawKeys = rowsOrdered.map((r) => (r.isOther ? null : r.keys[0]));
  const lm = labelMarksSpec(rc, sheet, format, rawKeys);
  if (lm.note) marks.note = [marks.note, lm.note].filter(Boolean).join(" ");
  if (marks.note) container.append(hint(marks.note)); // a Marks hint sits above the chart, never blocks it
  // Click-to-filter: marks map 1:1 to result rows here, so a click's dataIndex -> rowsOrdered[i].keys[0] (the primary
  // dimension's raw value).
  const onSelect = selectHandler(rc, sheet, primaryDim(sheet), type, rawKeys);
  const selectedIndices = selectedIndicesOf(rawKeys, rc.selected, primaryDim(sheet));
  const otherIndex = rowsOrdered.findIndex((r) => r.isOther);
  // On a pie / donut the legend lists the primary dimension's members; elsewhere it names measures (highlight only —
  // a measure isn't a member to keep or exclude).
  // A pie / donut split by Colour lists the Colour members instead (one field: a legend click selects the member; several: it highlights).
  const splitFields = split ? colourDimsOf(sheet) : [];
  const splitField = splitFields.length === 1 ? splitFields[0] : null;
  const legend = split
    ? legendSpec(rc, sheet, splitField, splitField ? new Map(split.members.map((m) => [m.name, m.raw])) : new Map())
    : (type === "pie" || type === "donut")
      ? legendSpec(rc, sheet, primaryDim(sheet), new Map(rowsOrdered.map((r, i) => [categories[i], r.isOther ? undefined : r.keys[0]])))
      : legendSpec(rc, sheet, null, new Map());
  // Analytics: lines / bands on their chosen measure, the trend on its own: reference line, band, trend (+ forecast categories appended).
  let catsOut = categories, seriesOut = [...series, ...compareSeries], analytics = null;
  const A = sheet.analytics;
  if (A && ANALYTICS_TYPES.has(type) && series.length) {
    const ti = pickMeasure(A.trendMeasure, series.length), vals = series[ti].data; // the trend and forecast follow the chosen measure (default the first)
    const mi = pickMeasure(A.ref?.measure, series.length), mvals = dataValues(series[mi].data, rowsOrdered); // the "Other" remainder aggregates cut-off members: not a data point
    const mname = mi > 0 ? ` (${series[mi].name})` : ""; // named only when a measure other than the default was chosen
    const refKind = A.ref?.kind ?? "none";
    const rv = refKind === "none" ? null : refValue(refKind, mvals, refConstant(A.ref, parameters));
    const fc = type === "line" || type === "area" ? effectiveForecast(A, parameters) : 0;
    const refused = (A.trend && A.trend !== "none") || fc ? trendRefusal(result) : null; // a cut-off result is not fitted or extrapolated
    const t = !refused && ((A.trend && A.trend !== "none") || fc) ? trendSeries(A.trend ?? "none", vals, fc) : null;
    const trendLabel = TREND_CHOICES.find(([v]) => v === (A.trend && A.trend !== "none" ? A.trend : "linear"))[1].toLowerCase();
    const tp = refused ?? (A.trend && A.trend !== "none" && !t ? (trendProblem(A.trend, vals) ?? "The trend could not be fitted to these values.") + (fc ? " The forecast is not drawn." : "") : null);
    if (tp) rc.extraNotice = joinNotices(rc.extraNotice, tp);
    const bb = bandBounds(A.band, mvals, parameters);
    analytics = {
      measure: mi,
      ref: rv == null ? null : { name: (refKind === "constant" ? "Reference" : REF_CHOICES.find(([v]) => v === refKind)[1]) + (refKind === "constant" ? "" : mname), value: rv },
      band: bb ? { ...bb, name: bandLabel(A.band) + (A.band.kind ? ` (shown rows)${mname}` : "") } : null,
      trend: t ? { measure: ti, name: `Trend${ti > 0 ? ` of ${series[ti].name}` : ""} (${trendLabel}${fc ? ` + ${fc} forecast` : ""}): ${t.formula}, ${fitWords(t.r2)}${t.p == null ? "" : `, ${pWords(t.p)}`}, n = ${t.n}`, short: `Trend · ${fitWords(t.r2)}${t.p == null ? "" : ` · ${pWords(t.p)}`} · n = ${t.n}`, data: t.data } : null,
    };
    if (t && t.extra) {
      catsOut = [...categories, ...Array.from({ length: t.extra }, (_, i) => `Forecast +${i + 1}`)];
      seriesOut = seriesOut.map((sr) => ({ ...sr, data: [...sr.data, ...new Array(t.extra).fill(null)] }));
    }
    if (A.band && !bb) rc.extraNotice = joinNotices(rc.extraNotice, A.band.kind ? "The band needs more values than the rows shown (at least 2 for a standard deviation)." : "The band's ends are equal — type two different numbers.");
    if ((t || rv != null || bb) && (result.truncated || result.partial)) rc.extraNotice = joinNotices(rc.extraNotice, "Analytics use only the rows shown — more exist.");
  }
  // Members coloured by a field — pie / donut slices and a single-measure bar coloured by category.
  // A colour measure replaces them (the marks wear their value's colour).
  const byMember = !split && (type === "pie" || type === "donut" || (type === "bar" && format.colorByDimension && series.length === 1 && !compareSeries.length)) && !marks.spec.colorValues && primaryDim(sheet) && !isCalcPill(primaryDim(sheet));
  const splitColour = split ? memberColourField(splitFields) : null;
  const memberColourSpec = byMember
    ? memberSpec(rc, sheet, primaryDim(sheet), rowsOrdered.map((r, i) => ({ name: categories[i], raw: r.keys[0], other: r.isOther })).filter((m) => !m.other))
    : splitColour ? memberSpec(rc, sheet, splitColour, split.members.map(({ name, raw }) => ({ name, raw }))) : {};
  const splitSpec = split ? { split: { memberIndex: split.memberIndex, memberNames: split.memberIndex.map((i) => (i >= 0 ? split.members[i].name : null)) } } : {};
  drawChart(container, { type, symbol: SCATTER_TYPES.has(type) ? scatterSymbol(type) : undefined, categories: catsOut, series: seriesOut, format, onSelect, selectedIndices, orientation: chartOrientation(sheet), otherIndex, analytics, dateLabels: dateLabelsOf(sheet, primaryDim), ...memberColourSpec, ...legend, ...marks.spec, ...splitSpec, ...lm.spec });
}
