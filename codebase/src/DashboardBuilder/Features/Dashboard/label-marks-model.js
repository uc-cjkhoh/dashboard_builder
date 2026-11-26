// Label options (Label flyout → Marks to Label) — pure, DOM-free (tests/js/label-marks.test.mjs). Which marks carry their label: every mark (the way labels
// have always drawn), the lowest and highest of each series, the selected mark, a mark while it is highlighted, the marks at the latest date, or the
// first and last point of a line. `format.labelMarks` stores one of the names (absent = All, so older files are untouched); the drawing turns it into a
// mask over each series' marks with `labelMask`. A mode that does not apply to the chart in hand draws every label, never none.
import { marksOf, SCATTER_TYPES } from "./sheet-plan.js";
import { primaryDim } from "./result-model.js";
import { DATE_PARTS } from "../Core/sheet-schema.js";

/** [value, label] — the choices Label flyout → Marks to Label can offer (each chart offers the ones that mean something there). */
export const LABEL_MARK_CHOICES = Object.freeze([["all", "All"], ["minmax", "Min & max"], ["selected", "Selected"], ["highlighted", "Highlighted"], ["recent", "Most recent"], ["ends", "Line ends"]]);
const MODES = new Set(LABEL_MARK_CHOICES.map((c) => c[0]));
/** The order the Marks to Label tiles read in, two to a row (Tableau's card): All, Selected / Min & max, Highlighted / Line ends, Most recent. */
export const LABEL_TILE_ORDER = Object.freeze(["all", "selected", "minmax", "highlighted", "ends", "recent"]);
/** Chart types whose marks carry labels from Show mark labels or a Label field (the point charts too when split by Shape or Colour: one series per member). */
export const LABEL_TYPES = new Set(["bar", "stacked", "line", "area", "combo", "pie", "donut", ...SCATTER_TYPES]);
const LINES = new Set(["line", "area"]);
// Label position: a label sits on a point over the plot background on a line, an area and the point charts (ink on the surface, so no palette contrast to guard);
// a bar, stacked segment, combo bar or pie slice keeps its own place (the "inside" positions would put ink on a palette colour).
const POSITIONED = new Set(["line", "area", ...SCATTER_TYPES]);
/** [value, label] — Label flyout → Position. */
export const LABEL_POSITION_CHOICES = Object.freeze([["auto", "Automatic"], ["above", "Above"], ["below", "Below"], ["left", "Left"], ["right", "Right"]]);
const POSITIONS = { above: "top", below: "bottom", left: "left", right: "right" };
/** Why a stored position is refused, or null. */
export const labelPositionError = (v) => (v === "auto" || (typeof v === "string" && Object.hasOwn(POSITIONS, v)) ? null : "Label position must be Automatic, Above, Below, Left or Right.");
/** The position a format asks for ("auto" when absent or, defensively, invalid). */
export const labelPositionOf = (format) => (labelPositionError(format?.labelPosition) === null ? format.labelPosition : "auto");
/** `format.labelPosition` as a sheet stores it -> { ok, value } (null = automatic, nothing to store). */
export function cleanLabelPosition(v) {
  if (v == null || v === "auto") return { ok: true, value: null };
  const error = labelPositionError(v);
  return error ? { ok: false, error } : { ok: true, value: v };
}
/** The positions `ctx` ({ type, drawn }) offers: all five on a line, area or point chart that draws labels, none elsewhere. */
export const labelPositionsFor = ({ type, drawn }) => (drawn && POSITIONED.has(type) ? LABEL_POSITION_CHOICES.map((c) => c[0]) : []);
/** The ECharts label position of a choice, or null for Automatic (the chart's own place). */
export const labelPositionSymbol = (v) => (typeof v === "string" && Object.hasOwn(POSITIONS, v) ? POSITIONS[v] : null);

/** Why a stored mode is refused, or null. */
export const labelMarksError = (v) => (typeof v === "string" && MODES.has(v) ? null : "Label marks must be All, Min & max, Selected, Highlighted, Most recent or Line ends.");
/** The mode a format asks for ("all" when absent or, defensively, invalid). */
export const labelMarksOf = (format) => (labelMarksError(format?.labelMarks) === null ? format.labelMarks : "all");
/** `format.labelMarks` as a sheet stores it -> { ok, value } (null = All, nothing to store); for the Format control's change. */
export function cleanLabelMarks(v) {
  if (v == null || v === "all") return { ok: true, value: null };
  const error = labelMarksError(v);
  return error ? { ok: false, error } : { ok: true, value: v };
}

/**
 * What a sheet's chart draws labels for: { type, temporal (the first group-by is a point in time — a date, or a date grouped to a day, month, year …, not a part
 * such as month of year), drawn (Show mark labels or a Label field is on, and the chart draws them) }.
 */
export function labelContext(sheet) {
  const type = sheet.chartType;
  const labelsOn = Boolean(sheet.format?.dataLabels || marksOf(sheet).label);
  const first = primaryDim(sheet);
  const temporal = Boolean(first) && first.category === "temporal" && !(first.datePart && DISCRETE_PARTS.has(first.datePart));
  return { type, temporal, drawn: labelsOn && LABEL_TYPES.has(type) };
}
const DISCRETE_PARTS = new Set([...DATE_PARTS].filter((p) => /OfYear$|OfWeek$|OfDay$/.test(p)));

/** The modes `ctx` ({ type, temporal, drawn }) offers, All first; none when no label is drawn. */
export function labelModesFor({ type, temporal, drawn }) {
  if (!drawn || !LABEL_TYPES.has(type)) return [];
  return LABEL_MARK_CHOICES.map((c) => c[0]).filter((m) => (m === "ends" ? LINES.has(type) : m === "recent" ? temporal : true));
}
/** The mode the drawing uses for a stored `mode`: the stored one when this chart offers it, else All. */
export function effectiveLabelMode(mode, ctx) {
  return mode && mode !== "all" && labelModesFor({ ...ctx, drawn: true }).includes(mode) ? mode : "all";
}
/** The hint when a stored mode does not apply to the chart (every mark is labelled instead), else null. */
export function LABEL_MARK_HINT(mode) {
  if (mode === "ends") return `Line ends labels apply to Line and Area charts — every mark is labelled.`;
  if (mode === "recent") return "Most recent labels need a date on the view — every mark is labelled.";
  return null;
}

const num = (v) => (v == null || v === "" ? NaN : Number(v));
const real = (v) => Number.isFinite(num(v));
/**
 * The mask a mode makes over the marks: { hover, at(seriesIndex, markIndex) -> whether that mark carries its label }, or null for All (nothing to mask).
 * `series` = the values of each series by mark; `skip` = marks that are not data points (the Other group); `selected` / `recent` = the mark indices of the selection
 * and of the latest date — or, when the series are not aligned on one axis (a point chart split into a series per member), the keys `keyOf(series, mark)` gives
 * (the result row behind each mark; default the mark's index). Min & max is per series either way. Highlighted has `hover` true: the chart shows a label
 * only while its mark is highlighted (`at` is true for every mark then). A missing value is never a candidate; a tie for the lowest or highest takes the first mark.
 */
export function labelMask(mode, { series = [], skip = [], selected = [], recent = [], keyOf = (_si, di) => di } = {}) {
  if (!mode || mode === "all" || !MODES.has(mode)) return null;
  if (mode === "highlighted") return { hover: true, at: () => true };
  if (mode === "selected" || mode === "recent") {
    const keep = new Set(mode === "selected" ? selected : recent);
    return { hover: false, at: (si, di) => keep.has(keyOf(si, di)) };
  }
  const skipped = new Set(skip);
  const picks = series.map((values, si) => {
    const idx = values.map((v, i) => i).filter((i) => !skipped.has(i) && real(values[i]));
    if (!idx.length) return new Set();
    if (mode === "ends") return new Set([idx[0], idx[idx.length - 1]]);
    let lo = idx[0], hi = idx[0];
    for (const i of idx) { if (num(values[i]) < num(values[lo])) lo = i; if (num(values[i]) > num(values[hi])) hi = i; }
    return new Set([lo, hi]);
  });
  return { hover: false, at: (si, di) => picks[si]?.has(di) ?? false };
}

const ISO = /^\d{4}-\d{2}-\d{2}/;
/** The latest of ISO dates / date-times (strings, as the server returns them), as written; null when none is one. */
export function mostRecentRaw(raws) {
  let best = null;
  for (const r of raws) if (typeof r === "string" && ISO.test(r) && (best === null || r > best)) best = r;
  return best;
}


// Allow labels to overlap other marks (Label flyout) — `format.labelOverlap`. Absent or true = every label draws, the way labels have always drawn (so older
// files are untouched); false = a label that would sit on another is hidden, like Tableau's default. Stored only when false.
export const labelOverlapError = (v) => (typeof v === "boolean" ? null : "Allow labels to overlap must be on or off.");
export const labelOverlapOf = (format) => format?.labelOverlap !== false;
/** `format.labelOverlap` as a sheet stores it: -> { ok, value } (value null = nothing to store: on). */
export function cleanLabelOverlap(v) {
  const err = labelOverlapError(v);
  return err ? { ok: false, error: err, value: null } : { ok: true, value: v ? null : false };
}
/** The chart option with overlapping labels hidden (every series that shows a label gets ECharts' `labelLayout.hideOverlap`); the option itself when overlap is allowed. */
export function withLabelOverlap(option, format) {
  if (!option || labelOverlapOf(format) || !Array.isArray(option.series)) return option;
  const shows = (s) => s?.label?.show === true || s?.data?.some?.((d) => d?.label?.show === true);
  return { ...option, series: option.series.map((s) => (shows(s) ? { ...s, labelLayout: { ...s.labelLayout, hideOverlap: true } } : s)) };
}
