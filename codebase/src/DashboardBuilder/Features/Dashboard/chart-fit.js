// How much room a chart's category axes need so every category stays visible and labelled. When the
// chart pane is smaller, the chart keeps this size and the pane scrolls (it never drops categories or
// skips their labels). Pure: unit-tested in tests/js/chart-fit.test.mjs.

import { shortDateLabels } from "./date-axis.js";

export const FIT = {
  slot: 28,        // px per category along a horizontal (bottom) axis
  rowSlot: 24,     // px per category along a vertical (left) axis
  barPx: 12,       // extra px per grouped bar in one category
  gutter: 96,      // value-axis labels, padding, legend slack
  labelMax: 160,   // a turned bottom label is truncated to this length (tooltips show the full name)
  sideMax: 200,    // a left-axis label is truncated to this width
  charPx: 7,       // rough glyph width of an axis label at --fs-body
  maxSlots: 1000,  // past this many categories the axis zooms (a slider window) instead of scrolling
  canvasMarks: 1500, // past this many marks the chart draws on canvas (SVG slows down with many nodes)
};

/** px one category needs: room for each grouped bar, never less than the base slot. */
export function slotFor(base, bars = 1) {
  return Math.max(base, bars > 1 ? bars * FIT.barPx + 8 : 0);
}

/**
 * The size a chart's category axes need. Returns { minWidth, minHeight, rotate, zoom, window }:
 * minWidth/minHeight 0 = no minimum (the chart fills the pane); `rotate` (0 or 90) for the bottom axis
 * labels: turned upright when they can't sit side by side at `width` (upright never overhangs the
 * pane's left edge, as a 45° label would). Past FIT.maxSlots categories an axis doesn't grow: `zoom`
 * ("x" bottom, "y" left, "xy") asks for a slider showing `window` (bottom) / `windowY` (left) categories.
 * @param spec the renderChart spec
 * @param width the pane's current inner width, px
 * @param height the pane's current inner height, px
 */
export function chartFit(spec, width = 0, height = 0) {
  const none = { minWidth: 0, minHeight: 0, rotate: 0, zoom: null, window: 0, windowY: 0 };
  const axes = categoryAxes(spec);
  if (!axes) return none;
  const out = { ...none };
  if (axes.bottom) {
    const { labels, bars } = axes.bottom;
    const slot = slotFor(FIT.slot, bars);
    if (labels.length > FIT.maxSlots) {
      out.zoom = "x";
      out.window = Math.max(1, Math.floor((width - FIT.gutter) / slot));
      out.rotate = labelWidth(labels) + 8 > slot ? 90 : 0;
    } else {
      out.minWidth = labels.length * slot + FIT.gutter;
      const per = (Math.max(width, out.minWidth) - FIT.gutter) / Math.max(labels.length, 1);
      out.rotate = labelWidth(labels) + 8 > per ? 90 : 0;
    }
  }
  if (axes.left) {
    const { labels, bars } = axes.left;
    const slot = slotFor(FIT.rowSlot, bars);
    if (labels.length > FIT.maxSlots) {
      out.zoom = out.zoom ? "xy" : "y";
      out.windowY = Math.max(1, Math.floor((height - FIT.gutter) / slot));
    }
    else out.minHeight = labels.length * slot + FIT.gutter;
  }
  return out;
}

/** Fit (Format → Fit): "standard" keeps a slot per category (the pane scrolls); "width" / "height" /
 * "entire" fit that direction (or both) to the pane instead — categories share the room and labels may
 * thin out. Returns the adjusted fit plus which axes were fitted. */
export function applyFitMode(fit, mode) {
  const w = mode === "width" || mode === "entire", h = mode === "height" || mode === "entire";
  const out = { ...fit, fittedX: w, fittedY: h };
  if (w) { out.minWidth = 0; if (out.zoom === "x") out.zoom = null; if (out.zoom === "xy") out.zoom = "y"; }
  if (h) { out.minHeight = 0; if (out.zoom === "y") out.zoom = null; if (out.zoom === "xy") out.zoom = "x"; }
  return out;
}

/** How many marks a spec draws (categories × series, cells, points) — picks the renderer. */
export function markCount(spec) {
  const t = spec?.type;
  if (t === "heatmap") return spec.cells?.length ?? 0;
  if (t === "scatterShapes") return (spec.groups ?? []).reduce((n, g) => n + (g.points?.length ?? 0), 0);
  if (t === "histogram") return spec.bins?.length ?? 0;
  if (t === "boxplot") return spec.boxes?.length ?? 0;
  if (t === "treemap") return spec.tree?.length ?? 0;
  if (t === "sankey") return spec.links?.length ?? 0;
  if (t === "gauge") return 1;
  if (t === "bullet") return (spec.categories?.length ?? 0) * 5;
  if (t === "multiples") return (spec.panels ?? []).reduce((n, p) => n + p.series.reduce((m, s) => m + s.length, 0), 0);
  return (spec?.categories?.length ?? 0) * Math.max(1, spec?.series?.length ?? 1);
}

// The category axes a spec draws, by physical side, or null for charts without one.
function categoryAxes(spec) {
  const t = spec?.type;
  if (t === "pie" || t === "donut" || t === "treemap" || t === "scatter" || t === "square"
    || t === "circle" || t === "scatterShapes" || t === "funnel" || t === "gauge" || t === "sankey" || t === "multiples") return null;
  if (t === "waterfall") return { bottom: { labels: [...(spec.categories ?? []), "Total"].map((l) => String(l ?? "—")), bars: 1 } };
  if (t === "bullet") return { left: { labels: (spec.categories ?? []).map((l) => String(l ?? "—")), bars: 2 } };
  if (t === "heatmap") return { bottom: { labels: spec.xCats ?? [], bars: 1 }, left: { labels: spec.yCats ?? [], bars: 1 } };
  if (t === "histogram") return { bottom: { labels: (spec.bins ?? []).map(() => "00.0K–00.0K"), bars: 1 } };
  if (t === "boxplot") return { bottom: { labels: (spec.boxes ?? []).map((b) => String(b.label ?? "—")), bars: 1 } };
  let labels = (spec.categories ?? []).map((l) => String(l ?? "—"));
  if (spec.dateLabels !== undefined) labels = shortDateLabels(labels).texts; // a date axis draws its shortened labels
  const grouped = t === "bar" || t === "combo" ? (t === "combo" ? 1 : (spec.series?.length ?? 1)) : 1;
  const horizontal = spec.orientation === "horizontal" && t !== "combo";
  return horizontal ? { left: { labels, bars: grouped } } : { bottom: { labels, bars: grouped } };
}

// Estimated px of the longest label, capped where it would be truncated anyway.
function labelWidth(labels) {
  let n = 0;
  for (const l of labels) n = Math.max(n, l.length);
  return Math.min(n * FIT.charPx, FIT.labelMax);
}
