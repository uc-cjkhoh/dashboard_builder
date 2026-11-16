// Format → Line markers on a line, area or combo's lines — pure, DOM-free (tests/js/line-pattern-markers.test.mjs, line-selected.test.mjs).
//   Automatic  today's rule: a dot on every point up to 60 points (or whenever a marker size is chosen); longer lines show none.
//   Selected   dots only at the click-selected marks (every series' point at a selected category); no selection = no visible markers, except a lone value.
//              Every other point keeps a clear dot to click on, so a mark can be selected and hover still shows it.
//   All        a dot on every point, however long the line (ECharts is told not to thin them).
//   None       no dots on the line, with two exceptions that keep data on screen: a LONE value (no neighbour to draw a line to) keeps its dot, and a
//              mark that carries a label keeps a clear anchor for it. Hovering a point still shows its dot and the tooltip (axis pointer).
// Selected and None share one plan: a dot that stays visible (a lone value, a selected mark) and a clear one (hover / click only) for the other points.
// A marker that IS data is never removed: a Size field sizing the markers (a stepped line, an area) and a measure's own cue marker win over None and Selected.
// Stored as `format.lineMarkers` ("selected" | "all" | "none"; absent = automatic, so older files draw as before). The selected marks are the click selection
// on the primary dimension (the worksheet's own, or a dashboard widget's cross-filter selection): render-cartesian.js `lineMarkersSpec` hands their indices
// to the chart whenever Line markers is Selected, whatever Label marks is set to (`labelMarksSpec` stays Label marks' own).
import { LINE_MARKERS } from "../Core/sheet-schema.js";

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
  // Selected keeps a clear (transparent, hit-testable) dot on EVERY point, not only the kept ones: a click on a point is how a mark gets selected, and a line
  // with no symbols at all (nothing selected yet) would have nothing to click. None keeps a clear dot only where a label or a lone value needs one.
  const show = keep.size > 0 || labelled || (mode === "selected" && (data ?? []).some(present));
  return { show, all: show, clear: show ? (di) => !keep.has(di) : null };
}
