// Format → Line markers on a line, area or combo's lines — pure, DOM-free (tests/js/line-pattern-markers.test.mjs).
//   Automatic  today's rule: a dot on every point up to 60 points (or whenever a marker size is chosen); longer lines show none.
//   All        a dot on every point, however long the line (ECharts is told not to thin them).
//   None       no dots on the line, with two exceptions that keep data on screen: a LONE value (no neighbour to draw a line to) keeps its dot, and a
//              mark that carries a label keeps a clear anchor for it. Hovering a point still shows its dot and the tooltip (axis pointer).
// A marker that IS data is never removed: a Size field sizing the markers (a stepped line, an area) and a measure's own cue marker win over None.
// Stored as `format.lineMarkers` ("all" | "none"; absent = automatic, so older files draw as before). "Selected points" (Tableau) is not offered yet:
// the chart is handed the selected marks only while Label marks is Selected (render-cartesian.js `labelMarksSpec`), so it would need that selection passed
// through for Line markers on its own, on every cartesian render path.
import { LINE_MARKERS } from "../Core/sheet-schema.js";

export const LINE_MARKER_CHOICES = [["auto", "Automatic"], ["all", "All"], ["none", "None"]];

/** Why a line-markers choice is refused, or null when it is a known one. */
export const lineMarkersError = (v) => (LINE_MARKERS.has(v) ? null : "Line markers must be Automatic, All or None.");

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
 */
export function markerPlan({ mode, forced = false, labelled = false, data }) {
  if (forced || (mode !== "all" && mode !== "none")) return null;
  if (mode === "all") return { show: true, all: true, clear: null };
  const lone = new Set(isolatedPoints(data));
  const show = lone.size > 0 || labelled;
  return { show, all: show, clear: show ? (di) => !lone.has(di) : null };
}
