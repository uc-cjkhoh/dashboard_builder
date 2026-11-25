// The Size flyout's meter, for every chart type that draws an element with a size (pure, DOM-free; tests/js/element-size.test.mjs).
// One stored setting — `format.markerSize`, null = Automatic, else a whole number 4–40 (mark-style-model.js) — is a *position* on the meter. Each kind of element
// reads that position on its own scale: a marker takes it as px (as it always has), a bar as the share of its category slot, a pie as its radius, and so on.
// Automatic stores nothing and every builder keeps its own default, so a sheet that never touched the meter draws exactly as before.
import { MARKER_SIZE, MARKER_SIZE_AUTO, MARKER_SIZE_STOPS, markerSizeError } from "./mark-style-model.js";

/** Chart types the meter sizes. Not here: treemap (tiles fill their space), histogram (bins touch by design), table and text (font sizes are fixed by the design rules). */
export const ELEMENT_SIZE_TYPES = new Set([
  "scatter", "square", "circle", "line", "area", "combo", "heatmap", // markers (a heatmap only when its cells are circles)
  "bar", "stacked", "waterfall", "bullet", "gantt", "boxplot", // bars and boxes
  "pie", "donut", "funnel", "gauge", "sankey", "multiples",
]);

/** The meter position as 0 (smallest) … 1 (largest), or null while Automatic (unset or, defensively, out of range). */
export function sizeT(format) {
  const v = format?.markerSize;
  if (v == null || markerSizeError(v) !== null) return null;
  return (v - MARKER_SIZE.min) / (MARKER_SIZE.max - MARKER_SIZE.min);
}

const lerp = (a, b, t) => a + (b - a) * t;
const whole = (n) => Math.round(n);

/** Share of a category slot a bar / box fills (0.2 … 0.9). */
export const slotShare = (t) => lerp(0.2, 0.9, t);
/** `barCategoryGap` (% of the slot left empty) for the bars of a bar / stacked / combo chart. */
export const barGapPct = (t) => whole((1 - slotShare(t)) * 100);
/** A pie's / donut's outer radius in % of the plot (72 is the default; the cap leaves room for outside labels). */
export const pieOuterPct = (t) => whole(lerp(40, 85, t));
/** A donut's inner radius as a share of the outer one (the default ratios are 45/72 and 35/58). */
export const DONUT_HOLE = 0.62;
/** A gauge's arc thickness in px (16 is the default). */
export const gaugeWidth = (t) => whole(lerp(6, 36, t));
/** A sankey node's width in px (14 is the default). */
export const nodeWidth = (t) => whole(lerp(6, 34, t));
/** The width of a funnel in % of the plot (80 is the default). */
export const funnelWidthPct = (t) => whole(lerp(40, 100, t));
/** A boxplot's box width range in px, [narrowest, widest] (ECharts' default is [7, 50]). */
export const boxWidthRange = (t) => [whole(lerp(4, 24, t)), whole(lerp(16, 100, t))];
/** A multiples panel's marker size in px (5 is the default). */
export const multiplesMarker = (t) => whole(lerp(3, 12, t));

/**
 * The option with its elements sized by the meter; the option itself while Automatic or for a type with nothing to size here.
 * Markers (line, scatter, …), waterfall and gantt read the setting in their own builders (markerSizeOr, slotShare), so only the families
 * whose series carry no size of their own are adjusted here.
 */
export function withElementSize(option, spec) {
  const t = sizeT(spec?.format);
  if (t === null || !option || !Array.isArray(option.series)) return option;
  const type = spec.type;
  const map = (fn) => ({ ...option, series: option.series.map((s) => fn(s) ?? s) });
  switch (type) {
    case "bar": case "stacked": case "combo":
      return map((s) => (s?.type === "bar" && s.barMaxWidth === 40 ? { ...s, barCategoryGap: `${barGapPct(t)}%`, barMaxWidth: 240 } : null)); // the 40 px cap is lifted, or the meter would do nothing on a wide chart
    case "pie": case "donut": {
      const outer = pieOuterPct(t);
      return map((s) => (s?.type === "pie" ? { ...s, radius: type === "donut" ? [`${whole(outer * DONUT_HOLE)}%`, `${outer}%`] : `${outer}%` } : null));
    }
    case "gauge":
      return map((s) => (s?.type === "gauge" ? { ...s, progress: { ...s.progress, width: gaugeWidth(t) }, axisLine: { ...s.axisLine, lineStyle: { ...s.axisLine?.lineStyle, width: gaugeWidth(t) } } } : null));
    case "sankey":
      return map((s) => (s?.type === "sankey" ? { ...s, nodeWidth: nodeWidth(t) } : null));
    case "funnel": {
      const side = `${whole((100 - funnelWidthPct(t)) / 2)}%`;
      return map((s) => (s?.type === "funnel" ? { ...s, left: side, right: side } : null));
    }
    case "boxplot":
      return map((s) => (s?.type === "boxplot" ? { ...s, boxWidth: boxWidthRange(t) } : null));
    case "bullet": {
      const bands = whole(lerp(30, 90, t));
      return map((s) => (s?.type === "bar" && s.silent ? { ...s, barWidth: `${bands}%` } : s?.type === "bar" && s.barWidth === "24%" ? { ...s, barWidth: `${whole(bands * 0.4)}%` } : null));
    }
    case "multiples":
      return map((s) => (s?.type === "line" ? { ...s, symbolSize: multiplesMarker(t) } : null));
    default:
      return option;
  }
}

const PX_TYPES = new Set(["scatter", "square", "circle", "line", "area", "heatmap"]);
/** The meter's label for a chart type: "Marker size" where the elements are markers, else "Size". */
export const sizeMeterLabel = (chartType) => (PX_TYPES.has(chartType) ? "Marker size" : "Size");
/** The meter's stops for a chart type: [position, readout] — px for markers, else a percentage of the range; the leftmost is Automatic. */
export function sizeMeterStops(chartType) {
  if (PX_TYPES.has(chartType)) return MARKER_SIZE_STOPS;
  return MARKER_SIZE_STOPS.map(([v]) => [v, v === MARKER_SIZE_AUTO ? "Auto" : `${Math.round(((v - MARKER_SIZE.min) / (MARKER_SIZE.max - MARKER_SIZE.min)) * 100)}%`]);
}
