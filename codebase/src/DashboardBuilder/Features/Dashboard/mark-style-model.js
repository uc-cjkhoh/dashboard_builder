// Marker size and mark borders (T01-22, T03-34) — pure, DOM-free (tests/js/charts2.test.mjs).
import { MARK_BORDERS, MARKER_SHAPES } from "../Core/sheet-schema.js";

export const MARK_BORDER_CHOICES = [["none", "None"], ["thin", "Thin"], ["thick", "Thick"]];
const WIDTHS = { none: 0, thin: 1, thick: 3 }; // px
/** The marker-size range Format accepts (whole px). */
export const MARKER_SIZE = Object.freeze({ min: 4, max: 40 });

/** ECharts itemStyle border for a setting; `colour` is the theme's border ink (a token, resolved by the caller). */
export const markBorder = (setting, colour) => ({ borderColor: colour, borderWidth: MARK_BORDERS.has(setting) ? WIDTHS[setting] : 0 });

/** Why a marker size is refused, or null when it is a whole number in range. */
export const markerSizeError = (v) => (Number.isInteger(v) && v >= MARKER_SIZE.min && v <= MARKER_SIZE.max ? null
  : `Marker size must be a whole number from ${MARKER_SIZE.min} to ${MARKER_SIZE.max} px.`);

/** The chosen marker size, or `fallback` when unset or (defensively) out of range. */
export const markerSizeOr = (v, fallback) => (v != null && markerSizeError(v) === null ? v : fallback);

/** The chosen border where there is one, else the chart's own default edge (pie, treemap and funnel keep a surface-coloured gap). */
export const edgeOr = (setting, colour, fallback) => (MARK_BORDERS.has(setting) && setting !== "none" ? markBorder(setting, colour) : fallback);

export const MARKER_SHAPE_CHOICES = [["circle", "Circle"], ["square", "Square"], ["diamond", "Diamond"], ["triangle", "Triangle"]];
const SYMBOLS = { circle: "circle", square: "rect", diamond: "diamond", triangle: "triangle" }; // ECharts symbol names

/** ECharts' symbol for a marker shape (circle when unset or unknown). */
export const markerSymbol = (shape) => (MARKER_SHAPES.has(shape) ? SYMBOLS[shape] : "circle");
