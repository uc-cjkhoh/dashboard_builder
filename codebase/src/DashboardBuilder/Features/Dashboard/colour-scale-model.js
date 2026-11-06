// Continuous colour scale: ramp choice and value range — pure, DOM-free (tests/js/colour-scale-model.test.mjs).
// `format.colorRamp` picks the hue of the single-hue ramp drawn for scatter and heatmap colour; `format.colorMin` /
// `format.colorMax` pin the ends of the scale (null = the data's own end).
import { rampStops } from "./colour-model.js";

/** [value, label] — the hue slots Format offers; each reads a design token at draw time. */
export const RAMP_CHOICES = Object.freeze([["brand", "Brand"], ["blue", "Blue"], ["green", "Green"], ["amber", "Amber"], ["violet", "Violet"]]);
const SLOT = { blue: 0, green: 1, amber: 3, violet: 6 }; // index into the eight categorical tokens

const HEX = /^#[0-9a-f]{6}$/i;
const toRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** `a` blended `t` (0–1) toward `b`, as #rrggbb; `b` itself when either input is not a #rrggbb. */
export function mixHex(a, b, t) {
  if (!HEX.test(a) || !HEX.test(b)) return b;
  const [x, y] = [toRgb(a), toRgb(b)];
  return "#" + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, "0")).join("");
}

/** The ramp's [low, high] colours. `tk` = { accent, accentSoft, surface, cat[] } (resolved tokens). */
export function rampColours(name, tk, reverse) {
  const slot = SLOT[name];
  const high = slot === undefined ? tk.accent : tk.cat[slot] ?? tk.accent;
  const low = slot === undefined ? tk.accentSoft : mixHex(tk.surface, high, 0.2);
  return rampStops(low, high, reverse);
}

/** Why a colour range is refused, or null (each end optional; min must be less than max). */
export function colourRangeError(min, max) {
  for (const v of [min, max]) if (v != null && !Number.isFinite(v)) return "The colour range must be numbers.";
  return min != null && max != null && !(min < max) ? "The colour range minimum must be less than the maximum." : null;
}

/** The scale's ends: the data span, overridden by a set min / max; never empty or inverted. */
export function rangeOf(values, min, max) {
  const nums = (values ?? []).filter((v) => Number.isFinite(v));
  let lo = min ?? (nums.length ? Math.min(...nums) : 0);
  let hi = max ?? (nums.length ? Math.max(...nums) : 1);
  if (hi <= lo) hi = lo + 1;
  return { min: lo, max: hi };
}

/** [value, label] — `format.colorScale`: one hue low → high, or two hues meeting at a centre value. */
export const SCALE_CHOICES = Object.freeze([["sequential", "Low → high"], ["diverging", "Diverging"]]);

/** Token fallbacks for the diverging pair (the light theme's values; core.css `--chart-div-low` / `--chart-div-high` win). */
export const DIV_FALLBACK = Object.freeze({ low: "#d98a4a", high: "#2b62b8" });

/** [value, label] — `format.colorPair`: which two hues the diverging scale meets between (tokens only, never a typed hex). */
export const DIV_PAIR_CHOICES = Object.freeze([["default", "Orange / Blue"], ["amber-violet", "Amber / Violet"], ["green-violet", "Green / Violet"]]);
const PAIR_HUES = { "amber-violet": ["amber", "violet"], "green-violet": ["green", "violet"] }; // [low, high]: core.css --chart-div-<hue>
/** Token fallbacks for the chosen pairs (the light theme's values; core.css `--chart-div-amber` / `-violet` / `-green` win). */
export const DIV_HUE_FALLBACK = Object.freeze({ amber: "#b8803a", violet: "#6b52c9", green: "#3f8f5a" });

/**
 * The diverging ramp's [low, centre, high]: the surface between two hues. `pair` (a DIV_PAIR_CHOICES value) picks them from
 * the dedicated `--chart-div-<hue>` tokens (read as tk.hues, independent of the active palette); the default is the warm / cool div tokens. `tk` = { surface, divLow, divHigh, hues? }.
 */
export function divergingColours(tk, reverse, pair) {
  const hues = PAIR_HUES[pair];
  const [low, high] = hues ? hues.map((h) => tk.hues?.[h] ?? DIV_HUE_FALLBACK[h]) : [tk.divLow ?? DIV_FALLBACK.low, tk.divHigh ?? DIV_FALLBACK.high];
  return reverse ? [high, tk.surface, low] : [low, tk.surface, high];
}

/** Why a colour centre is refused, or null (blank is fine; a finite number no larger than 1e15 in size). */
export function colourCentreError(v) {
  if (v == null) return null;
  return Number.isFinite(v) && Math.abs(v) <= 1e15 ? null : "The colour centre must be a number no larger than 1e15.";
}

/**
 * The diverging scale's ends and centre for data span lo..hi. The centre is the one set, else 0 when the span
 * straddles it, else the middle. The ends are made symmetric about it so the middle colour sits on the centre.
 */
export function divergingRange(lo, hi, centre) {
  const c = centre != null && Number.isFinite(centre) ? centre : lo < 0 && hi > 0 ? 0 : (lo + hi) / 2;
  const half = Math.max(c - lo, hi - c, 0) || 1;
  return { min: c - half, max: c + half, centre: c };
}

/** [value, label] — `format.colorSteps`: 0 = a smooth gradient, else that many discrete colour steps. */
export const STEP_CHOICES = Object.freeze([[0, "Continuous"], ...[3, 4, 5, 6, 7, 8, 9].map((n) => [n, `${n} steps`])]);

/** Why a step count is refused, or null (blank / 0 = continuous; otherwise a whole number 3 to 9). */
export function colourStepsError(n) {
  if (n == null || n === 0) return null;
  return Number.isInteger(n) && n >= 3 && n <= 9 ? null : "Colour steps must be a whole number from 3 to 9.";
}

/** `n` colours sampled evenly along the ramp (2 or 3 stops); the first and last equal the ramp's ends. */
export function stepColours(ramp, n) {
  const segs = ramp.length - 1;
  return Array.from({ length: n }, (_, i) => {
    const at = (i / (n - 1)) * segs;
    const k = Math.min(Math.floor(at), segs - 1);
    return at - k === 0 ? ramp[k] : mixHex(ramp[k], ramp[k + 1], at - k);
  });
}

/** The n + 1 boundaries splitting min..max into `n` equal steps. */
export const stepBounds = (min, max, n) => Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n);

/**
 * ECharts piecewise pieces for `n` steps over min..max. The outer steps are open-ended, so a value beyond the range
 * (a pinned end) takes the end step's colour; a value on a boundary belongs to the step above it. Each label names its boundaries in words ("20 to 40").
 */
export function stepPieces(min, max, n, ramp, fmt) {
  if (!(max > min)) max = min + 1; // flat data (or one value) still gets n distinct, ordered steps
  const b = stepBounds(min, max, n), cols = stepColours(ramp, n);
  return cols.map((color, i) => {
    const piece = { color, label: `${fmt(b[i])} to ${fmt(b[i + 1])}` };
    if (i > 0) piece.gte = b[i];
    if (i < n - 1) piece.lt = b[i + 1];
    return piece;
  });
}
