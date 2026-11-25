// Marker size and mark borders — pure, DOM-free (tests/js/charts2.test.mjs).
import { MARK_BORDER_COLOURS, MARKER_SHAPES } from "../Core/sheet-schema.js";

// `format.markBorder` is "none" or a width in px: 0.5 to 3 in steps of 0.5. Older files stored the keys thin / medium / thick (1, 2, 3 px);
// they still read, and import turns them into the number.
export const BORDER_STEP = 0.5;
export const BORDER_MAX = 3;
const LEGACY = Object.freeze({ none: 0, thin: 1, medium: 2, thick: 3 }); // px
export const MARK_BORDER_CHOICES = [["none", "None"], ["thin", "Thin"], ["medium", "Medium"], ["thick", "Thick"]]; // the legacy keys
/** [px, readout] ascending, 0 to 3 px in steps of 0.5 — the stops of the Border thickness bar. */
export const MARK_BORDER_STOPS = Object.freeze(Array.from({ length: BORDER_MAX / BORDER_STEP + 1 }, (_, i) => { const px = i * BORDER_STEP; return [px, px ? `${px} px` : "None"]; }));
const isWidth = (v) => typeof v === "number" && v > 0 && v <= BORDER_MAX && Number.isInteger(v / BORDER_STEP);
/** Why a stored border is refused, or null ("none", a legacy key, or 0.5 to 3 px in steps of 0.5). */
export const markBorderError = (v) => (v === "none" || isWidth(v) || (typeof v === "string" && Object.hasOwn(LEGACY, v)) ? null
  : `Border thickness must be none or 0.5 to ${BORDER_MAX} px in steps of ${BORDER_STEP}.`);
/** The width in px a setting draws: a legacy key maps to its px, a number is itself, anything else (unset, invalid) is 0. */
export const borderWidthOf = (v) => (typeof v === "string" && Object.hasOwn(LEGACY, v) ? LEGACY[v] : isWidth(v) ? v : 0);
/** `format.markBorder` as a sheet stores it: "none" for no border, else the px number (a legacy key becomes its number). Throws nothing: check markBorderError first. */
export const storedBorder = (v) => (borderWidthOf(v) > 0 ? borderWidthOf(v) : "none");
export const MARK_BORDER_COLOUR_CHOICES = [["muted", "Muted"], ["ink", "Ink"], ["surface", "Surface"], ["accent", "Accent"]];

/** The token colour a border colour name picks from the resolved chart tokens `c` (muted when unset or unknown). */
export const borderInk = (name, c) => (MARK_BORDER_COLOURS.has(name) ? ({ muted: c.muted, ink: c.ink, surface: c.surface, accent: c.brand })[name] : c.muted);
/** The marker-size range Format accepts (whole px). */
export const MARKER_SIZE = Object.freeze({ min: 4, max: 40 });
/** The Marker size meter's stops: the leftmost, one below the smallest size, is Automatic (nothing stored). */
export const MARKER_SIZE_AUTO = MARKER_SIZE.min - 1;
export const MARKER_SIZE_STOPS = Object.freeze(Array.from({ length: MARKER_SIZE.max - MARKER_SIZE_AUTO + 1 }, (_, i) => { const px = MARKER_SIZE_AUTO + i; return [px, px === MARKER_SIZE_AUTO ? "Auto" : `${px} px`]; }));

/** ECharts itemStyle border for a setting; `colour` is the theme's border ink (a token, resolved by the caller). */
export const markBorder = (setting, colour) => ({ borderColor: colour, borderWidth: borderWidthOf(setting) });

/** Why a marker size is refused, or null when it is a whole number in range. */
export const markerSizeError = (v) => (Number.isInteger(v) && v >= MARKER_SIZE.min && v <= MARKER_SIZE.max ? null
  : `Marker size must be a whole number from ${MARKER_SIZE.min} to ${MARKER_SIZE.max} px.`);

/** The chosen marker size, or `fallback` when unset or (defensively) out of range. */
export const markerSizeOr = (v, fallback) => (v != null && markerSizeError(v) === null ? v : fallback);

/** The chosen border where there is one, else the chart's own default edge (pie, treemap and funnel keep a surface-coloured gap). */
export const edgeOr = (setting, colour, fallback) => (borderWidthOf(setting) > 0 ? markBorder(setting, colour) : fallback);

export const MARKER_SHAPE_CHOICES = [["circle", "Circle"], ["square", "Square"], ["diamond", "Diamond"], ["triangle", "Triangle"]];
const SYMBOLS = { circle: "circle", square: "rect", diamond: "diamond", triangle: "triangle" }; // ECharts symbol names

/** ECharts' symbol for a marker shape (circle when unset or unknown). */
export const markerSymbol = (shape) => (MARKER_SHAPES.has(shape) ? SYMBOLS[shape] : "circle");

/** Chart types whose marks take Border thickness (Color flyout) (gauge has no marks; lines and areas have only markers on line types). */
export const BORDER_TYPES = new Set(["bar", "stacked", "combo", "scatter", "square", "circle", "heatmap", "pie", "donut", "treemap", "funnel",
  "histogram", "boxplot", "waterfall", "bullet", "gantt", "sankey"]);

/** A zrender stroke (custom-series shapes) for a setting; empty for none, so the shape keeps its look. */
export const strokeOf = (setting, colour) => (borderWidthOf(setting) > 0 ? { stroke: colour, lineWidth: borderWidthOf(setting) } : {});
