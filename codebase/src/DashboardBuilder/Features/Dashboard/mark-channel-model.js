// Which chart types accept a measure on Colour and a measure on Size, and the pure size scales behind them — DOM-free
// (tests/js/mark-channels.test.mjs). The hints here are what the Marks card says when a mapping can't be drawn: a hint, never an error.
const POINTS = new Set(["scatter", "square", "circle"]);
/** The chart types that draw a measure on Colour (the Format colour-scale controls follow them). */
export const COLOUR_MEASURE_TYPES = new Set([...POINTS, "pie", "donut", "treemap", "bar", "line", "area"]);
const SIZE_LIST = "Scatter bubbles, Bar thickness, Line thickness, Area markers, Treemap area and Text / Table font size";
const SINGLE = "a single measure on Columns / Rows";
const NOTE = {
  colourMany: `A colour measure needs ${SINGLE} — with several, the marks of different measures would look alike.`,
  colourStacked: "A Stacked bar can't take a colour measure (the segments of one bar would share a colour) — use Bar, or drop a categorical field on Colour.",
  colourElsewhere: "A colour measure shades Scatter points, Bars, Lines, Areas, Pie / Donut slices and Treemap tiles — switch to one of those, or drop a categorical field on Colour.",
  sizeMany: `Size varies a bar's thickness for ${SINGLE} — use one measure, or switch chart type.`,
  sizeStacked: "Size doesn't apply to a Stacked bar — use Bar (one measure) or a point chart.",
  sizePie: "Size doesn't apply to a Pie / Donut — one pie has nothing to compare its size with, and the slice angle is the measure.",
  sizeDimension: "A field on Size by member steps Scatter bubbles, Bar thickness, Line thickness and Area markers — Treemap, Text and Table take a measure.",
  sizeElsewhere: `Size scales ${SIZE_LIST} — switch chart type to use it.`,
};

/** Can `type` draw a measure on Colour? `shelfCount` = measures on Columns / Rows. -> { ok, note } (note = the hint when not ok). */
export function colourChannel(type, shelfCount) {
  if (POINTS.has(type) || type === "pie" || type === "donut" || type === "treemap") return { ok: true, note: null };
  if (type === "bar" || type === "line" || type === "area") return shelfCount === 1 ? { ok: true, note: null } : { ok: false, note: NOTE.colourMany };
  return { ok: false, note: type === "stacked" ? NOTE.colourStacked : NOTE.colourElsewhere };
}

/**
 * Can `type` draw a Size field? A measure scales marks by value; a dimension (`dimension` true) gives each member a step. A bar's
 * thickness is per mark, so it needs one measure; line / area markers and thickness are shared by all lines. Text / Table take a
 * measure only (it sets the cell font size).
 */
export function sizeChannel(type, shelfCount, dimension = false) {
  if (type === "pie" || type === "donut") return { ok: false, note: NOTE.sizePie };
  if (type === "stacked") return { ok: false, note: NOTE.sizeStacked };
  if (type === "bar") return shelfCount === 1 ? { ok: true, note: null } : { ok: false, note: NOTE.sizeMany };
  if (POINTS.has(type) || type === "line" || type === "area") return { ok: true, note: null };
  if (type === "treemap" || type === "text" || type === "table") return dimension ? { ok: false, note: NOTE.sizeDimension } : { ok: true, note: null };
  return { ok: false, note: NOTE.sizeElsewhere };
}

const finite = (v) => v != null && v !== "" && Number.isFinite(Number(v));
/** The data's own span {min, max}, or null with no numbers. */
export function sizeRange(values) {
  const nums = (values ?? []).filter(finite).map(Number);
  return nums.length ? { min: Math.min(...nums), max: Math.max(...nums) } : null;
}
/** Each value as a 0..1 share of the span (smallest 0, largest 1; one value or all equal = 1); null stays null. */
export function sizeFractions(values) {
  const r = sizeRange(values);
  return (values ?? []).map((v) => (!finite(v) || !r ? null : r.max === r.min ? 1 : (Number(v) - r.min) / (r.max - r.min)));
}

const MIN_BAR = 6, BAR_SHARE = 0.8;
/** A bar's thickness in px: MIN_BAR at the smallest value up to BAR_SHARE of the category band at the largest; never under MIN_BAR. */
export function barThickness(fraction, band) {
  const max = Math.max(MIN_BAR, band * BAR_SHARE);
  return Math.round(MIN_BAR + (fraction ?? 0) * (max - MIN_BAR));
}
const MARKER = [6, 24];
/** A line / area marker's size in px for a 0..1 share (null = the smallest). */
export const markerSizeFor = (fraction) => Math.round(MARKER[0] + (fraction ?? 0) * (MARKER[1] - MARKER[0]));

/** Does the drawn chart take Size? A bar needs one measure (a thickness per bar); line / area size every series' markers by the row's Size value. */
export const drawsSize = (type, mainCount) => (type === "bar" ? mainCount === 1 : type === "line" || type === "area");
/** How a line draws Size: "width" (its own thickness, a straight line) or "marker" (the markers' size: a stepped line, an area); null elsewhere. */
export const lineSizeMode = (type, lineStyle) => (type === "line" ? ((lineStyle ?? "straight") === "straight" ? "width" : "marker") : type === "area" ? "marker" : null);
/** The hint when Size sits beside a Colour dimension on a Stacked chart (its segments of one bar can't take a thickness), else null. */
export const splitSizeNote = (hasSize, type) => (hasSize && type === "stacked" ? NOTE.sizeStacked : null);
/** The hint when a colour measure sits beside Shape or a Colour dimension on the scatter family (one Colour slot, so only Shape + a measure), else null. */
export const shapeColourNote = (colorMeasureIdx) => (colorMeasureIdx >= 0 ? "A colour measure isn't drawn while points are split by Shape or a Colour field — remove one of them." : null);
