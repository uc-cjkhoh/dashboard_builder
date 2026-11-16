// Format → Line markers on a line, area or combo's lines — pure, DOM-free (tests/js/line-pattern-markers.test.mjs, line-selected.test.mjs).
//   Automatic  today's rule: a dot on every point up to 60 points (or whenever a marker size is chosen); longer lines show none.
//   Selected   dots only at the click-selected marks (every series' point at a selected category); no selection = no markers, except a lone value.
//   All        a dot on every point, however long the line (ECharts is told not to thin them).
//   None       no dots on the line, with two exceptions that keep data on screen: a LONE value (no neighbour to draw a line to) keeps its dot, and a
//              mark that carries a label keeps a clear anchor for it. Hovering a point still shows its dot and the tooltip (axis pointer).
// Selected and None share one plan: a dot that stays visible (a lone value, a selected mark) and a clear one (hover only) for the other points, where a label needs an anchor.
// A marker that IS data is never removed: a Size field sizing the markers (a stepped line, an area) and a measure's own cue marker win over None and Selected.
// Stored as `format.lineMarkers` ("selected" | "all" | "none"; absent = automatic, so older files draw as before). The selected marks are the click selection
// on the primary dimension (the worksheet's own, or a dashboard widget's cross-filter selection): render-cartesian.js `lineMarkersSpec` hands their indices
// to the chart whenever Line markers is Selected, whatever Label marks is set to (`labelMarksSpec` stays Label marks' own).
import { LINE_MARKERS } from "../Core/sheet-schema.js";
import { DATE_BUCKET_CHOICES } from "./scale-model.js";

export const LINE_MARKER_CHOICES = [["auto", "Automatic"], ["selected", "Selected"], ["all", "All"], ["none", "None"]];

/** Why a line-markers choice is refused, or null when it is a known one. */
export const lineMarkersError = (v) => (LINE_MARKERS.has(v) ? null : "Line markers must be Automatic, Selected, All or None.");

/** The stored choice of a format ("auto" when unset or, defensively, unknown). */
export const lineMarkersOf = (format) => (LINE_MARKERS.has(format?.lineMarkers) ? format.lineMarkers : "auto");

const valueOf = (d) => (d !== null && typeof d === "object" && !Array.isArray(d) ? d.value : d);
const present = (d) => { const v = valueOf(d); return v !== null && v !== undefined && v !== ""; };

/** The indexes of values with no neighbour on either side (a gap or an end): they draw no line, so without a dot they would not show at all. */
export function isolatedPoints(data) {
  const out = [];
  (data ?? []).forEach((d, i) => { if (present(d) && !present(data[i - 1]) && !present(data[i + 1])) out.push(i); });
  return out;
}

/**
 * How one line series draws its dots, or null to leave it to chart.js' own rule (Automatic, or a marker that is data: `forced`).
 * -> { show, all, clear } — `show` ECharts' showSymbol, `all` showAllSymbol, `clear(di)` true for a dot that stays in the option (a label's
 * anchor, shown on hover) but is drawn transparent; null when no point needs one. `labelled` = the series draws labels (they sit on a dot).
 * `selected` = the indexes of the click-selected marks (Selected only): their dots stay visible, as does a lone value's; an index with no value
 * (a gap, out of range, not a whole number) draws nothing.
 */
export function markerPlan({ mode, forced = false, labelled = false, data, selected = [] }) {
  if (forced || (mode !== "all" && mode !== "none" && mode !== "selected")) return null;
  if (mode === "all") return { show: true, all: true, clear: null };
  const keep = new Set(isolatedPoints(data));
  if (mode === "selected") for (const i of selected ?? []) if (Number.isInteger(i) && i >= 0 && present((data ?? [])[i])) keep.add(i);
  const show = keep.size > 0 || labelled; // a line with no kept dot draws none (a click and a hover still reach a point: ECharts draws a hover symbol on demand, seen in the browser check)
  return { show, all: show, clear: show ? (di) => !keep.has(di) : null };
}

// ---- where a click can select a mark (Selected needs it) ----------------------------------------------------------------------------
// Selected draws dots at the marks a click selected, so it does nothing wherever a click cannot select: no dimension (or a calculated one, which has no column to
// filter on), a date part or an explicit Group dates grain (a mark is then a period, not a value), an active drill hierarchy (a click steps down), and — decided by
// the data — Group dates: Auto when the server grouped the dates, or on a dashboard widget a field with a data type cast. The same rules as the tooltip's
// command buttons (tooltip-behaviour-model.js `buttonGate`, render-handlers.js `selectHandler`).
const grainLabel = (g) => DATE_BUCKET_CHOICES.find(([v]) => v === g)?.[1] ?? g;
export const SELECT_REASON = {
  noDim: "Add a dimension: a mark needs a field value to select.",
  drill: "A drill hierarchy is active: a click steps down instead of selecting a mark.",
  part: "A date part groups the first field, so a mark has no value to select.",
  grouped: "the first field's dates are grouped into periods (Format → Group dates, or a date part), so a mark has no value to select. Choose Group dates → Exact to show them.",
  cast: "the first field has a data type cast, which a dashboard selection cannot filter on.",
};
/**
 * Why Selected could never select a mark on this worksheet (known from the sheet alone), or null. `i` = { hasDim, refusal (why the dimension cannot be selected on, or null),
 * drilling, firstKeyGrouped (a date part), firstKeyDated (a date the server may group), dateBucket }. Group dates: Auto is not a reason: it is a note (`selectNote`).
 */
export function selectGate(i) {
  if (!i.hasDim) return SELECT_REASON.noDim;
  if (i.refusal) return i.refusal;
  if (i.drilling) return SELECT_REASON.drill;
  if (i.firstKeyGrouped) return SELECT_REASON.part;
  if (i.firstKeyDated && i.dateBucket && i.dateBucket !== "auto" && i.dateBucket !== "exact") return `Group dates is ${grainLabel(i.dateBucket)}, so a mark is a period, not a value to select. Choose Group dates → Exact.`;
  return null;
}
/** A note (not a reason to disable) for a date first field the server may group on its own: Selected then shows no dot when it does (the chart says so). */
export const selectNote = (i) => (i.firstKeyDated && (i.dateBucket ?? "auto") === "auto" ? "On a date axis, Group dates → Auto may group the dates into periods, and Selected then has no mark to select (the chart says so). Choose Group dates → Exact to always have them." : null);
/**
 * Why a drawn chart's marks cannot be selected right now (the hint above the chart), or null. `x` = { select (a click selects here), hasDim, bucketedKey (0 = the first key is a date part
 * or grouped by the server), drilling (an active hierarchy in the editor), cast (a select-only view of a cast field) }. A read-only view (`select` false) says nothing: a
 * selection can still arrive from another widget.
 */
export function selectDrawnReason(x) {
  if (!x.select) return null;
  if (!x.hasDim) return SELECT_REASON.noDim;
  if (x.drilling) return SELECT_REASON.drill;
  if (x.bucketedKey === 0) return `Line markers are set to Selected, but ${SELECT_REASON.grouped}`;
  if (x.cast) return `Line markers are set to Selected, but ${SELECT_REASON.cast}`;
  return null;
}
